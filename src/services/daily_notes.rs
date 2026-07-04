use crate::models::DailyNote;
use crate::store::{DailyNoteImage, DailyNoteUpdate, Store};
use chrono::NaiveDate;
use comrak::nodes::NodeValue;
use comrak::{Arena, Options, parse_document};
use image::ImageDecoder;
use serde::Serialize;
use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;

mod markdown;

pub use markdown::RenderedMarkdown;

const MAX_SEARCH_LENGTH: usize = 200;
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 1920;
const MAX_IMAGE_PIXELS: u64 = 1920 * 1920;
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DailyNoteSummary {
    pub note_date: NaiveDate,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet_html: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DailyNoteImageUpload {
    pub id: i64,
    pub width: u32,
    pub height: u32,
    pub url: String,
    pub markdown: String,
}

#[derive(Debug, Error)]
pub enum DailyNotesError {
    #[error("{0}")]
    Validation(String),
    #[error("daily note for {0} was not found")]
    NotFound(NaiveDate),
    #[error("daily note image {0} was not found")]
    ImageNotFound(i64),
    #[error("daily note for {date} has changed (current revision: {current_revision})")]
    Conflict {
        date: NaiveDate,
        current_revision: i64,
    },
    #[error("daily note persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),
    #[error("daily note rendering failed: {0}")]
    Rendering(#[source] anyhow::Error),
}

pub struct DailyNotesService {
    store: Store,
}

impl DailyNotesService {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub async fn list(
        &self,
        query: Option<&str>,
    ) -> Result<Vec<DailyNoteSummary>, DailyNotesError> {
        if query.is_some_and(|query| query.chars().count() > MAX_SEARCH_LENGTH) {
            return Err(DailyNotesError::Validation(format!(
                "search must be at most {MAX_SEARCH_LENGTH} characters"
            )));
        }
        let rows = self
            .store
            .daily_notes(query)
            .await
            .map_err(DailyNotesError::Persistence)?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let query = query.map(str::trim).filter(|query| !query.is_empty());
                DailyNoteSummary {
                    note_date: row.note_date,
                    title_html: query
                        .and_then(|query| markdown::highlight_plain(&row.title, query)),
                    date_html: query.and_then(|query| {
                        markdown::highlight_plain(&row.note_date.to_string(), query)
                    }),
                    snippet_html: query
                        .and_then(|query| markdown::highlight_excerpt(&row.markdown, query)),
                    title: row.title,
                }
            })
            .collect())
    }

    pub async fn get(&self, date: NaiveDate) -> Result<DailyNote, DailyNotesError> {
        self.store
            .daily_note(date)
            .await
            .map_err(DailyNotesError::Persistence)?
            .ok_or(DailyNotesError::NotFound(date))
    }

    pub async fn create(&self, date: NaiveDate) -> Result<DailyNote, DailyNotesError> {
        if let Some(note) = self
            .store
            .daily_note(date)
            .await
            .map_err(DailyNotesError::Persistence)?
        {
            return Err(DailyNotesError::Conflict {
                date,
                current_revision: note.revision,
            });
        }
        match self.store.create_daily_note(date).await {
            Ok(note) => Ok(note),
            Err(error) if is_unique_violation(&error) => {
                let current = self
                    .store
                    .daily_note(date)
                    .await
                    .map_err(DailyNotesError::Persistence)?;
                match current {
                    Some(note) => Err(DailyNotesError::Conflict {
                        date,
                        current_revision: note.revision,
                    }),
                    None => Err(DailyNotesError::Persistence(error)),
                }
            }
            Err(error) => Err(DailyNotesError::Persistence(error)),
        }
    }

    pub async fn update(
        &self,
        date: NaiveDate,
        markdown: &str,
        expected_revision: i64,
    ) -> Result<DailyNote, DailyNotesError> {
        if expected_revision < 1 {
            return Err(DailyNotesError::Validation(
                "revision must be positive".to_owned(),
            ));
        }
        let title = extract_title(markdown).unwrap_or_else(|| date.to_string());
        let image_reference_ids = owned_image_reference_ids(markdown);
        match self
            .store
            .update_daily_note(
                date,
                &title,
                markdown,
                expected_revision,
                &image_reference_ids,
            )
            .await
            .map_err(DailyNotesError::Persistence)?
        {
            DailyNoteUpdate::Updated(note) => Ok(note),
            DailyNoteUpdate::NotFound => Err(DailyNotesError::NotFound(date)),
            DailyNoteUpdate::Conflict { current_revision } => Err(DailyNotesError::Conflict {
                date,
                current_revision,
            }),
        }
    }

    pub async fn delete(&self, date: NaiveDate) -> Result<(), DailyNotesError> {
        if self
            .store
            .delete_daily_note(date)
            .await
            .map_err(DailyNotesError::Persistence)?
        {
            Ok(())
        } else {
            Err(DailyNotesError::NotFound(date))
        }
    }

    pub fn render(
        &self,
        markdown: &str,
        query: Option<&str>,
    ) -> Result<RenderedMarkdown, DailyNotesError> {
        if query.is_some_and(|query| query.chars().count() > MAX_SEARCH_LENGTH) {
            return Err(DailyNotesError::Validation(format!(
                "search must be at most {MAX_SEARCH_LENGTH} characters"
            )));
        }
        markdown::render(markdown, query).map_err(DailyNotesError::Rendering)
    }

    pub async fn upload_image(
        &self,
        date: NaiveDate,
        bytes: &[u8],
    ) -> Result<DailyNoteImageUpload, DailyNotesError> {
        self.get(date).await?;
        let (width, height) = validate_webp(bytes)?;
        let id = self
            .store
            .create_daily_note_image(date, bytes, i64::from(width), i64::from(height))
            .await
            .map_err(DailyNotesError::Persistence)?;
        let url = format!("/api/daily-notes/image-refs/{id}");
        Ok(DailyNoteImageUpload {
            id,
            width,
            height,
            markdown: format!("![Chart screenshot]({url})"),
            url,
        })
    }

    pub async fn image(&self, id: i64) -> Result<DailyNoteImage, DailyNotesError> {
        self.store
            .daily_note_image(id)
            .await
            .map_err(DailyNotesError::Persistence)?
            .ok_or(DailyNotesError::ImageNotFound(id))
    }

    pub async fn save_rendered_image(
        &self,
        id: i64,
        rendered: &[u8],
    ) -> Result<(), DailyNotesError> {
        let current = self.image(id).await?;
        let (width, height) = validate_webp(rendered)?;
        let (current_width, current_height) = validate_webp(&current.bytes)?;
        if width != current_width || height != current_height {
            return Err(DailyNotesError::Validation(
                "rendered image dimensions must match the source".to_owned(),
            ));
        }
        if !self
            .store
            .update_daily_note_rendered_image(id, rendered)
            .await
            .map_err(DailyNotesError::Persistence)?
        {
            return Err(DailyNotesError::ImageNotFound(id));
        }
        Ok(())
    }

    pub fn spawn_cleanup_task(self: &Arc<Self>) {
        let service = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            loop {
                match service.store.cleanup_daily_note_images().await {
                    Ok((references, images)) if references > 0 || images > 0 => {
                        tracing::info!(references, images, "cleaned up daily note images");
                    }
                    Ok(_) => {}
                    Err(error) => tracing::error!(%error, "daily note image cleanup failed"),
                }
                tokio::time::sleep(Duration::from_secs(60 * 60)).await;
            }
        });
    }
}

fn validate_webp(bytes: &[u8]) -> Result<(u32, u32), DailyNotesError> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(DailyNotesError::Validation(
            "image must be a non-empty WebP no larger than 5 MiB".to_owned(),
        ));
    }
    let decoder = image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))
        .map_err(|_| DailyNotesError::Validation("image must be valid WebP".to_owned()))?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        return Err(DailyNotesError::Validation(
            "image dimensions must not exceed 1920×1920".to_owned(),
        ));
    }
    drop(decoder);
    image::load_from_memory_with_format(bytes, image::ImageFormat::WebP)
        .map_err(|_| DailyNotesError::Validation("image must be valid WebP".to_owned()))?;
    Ok((width, height))
}

fn owned_image_reference_ids(markdown: &str) -> Vec<i64> {
    const PREFIX: &str = "/api/daily-notes/image-refs/";
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &Options::default());
    let mut ids = root
        .descendants()
        .filter_map(|node| match &node.data.borrow().value {
            NodeValue::Image(link) => link.url.strip_prefix(PREFIX)?.parse::<i64>().ok(),
            _ => None,
        })
        .filter(|id| *id > 0)
        .collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn is_unique_violation(error: &anyhow::Error) -> bool {
    error
        .chain()
        .filter_map(|cause| cause.downcast_ref::<sqlx::Error>())
        .any(|error| {
            matches!(error, sqlx::Error::Database(database) if database.is_unique_violation())
        })
}

fn extract_title(markdown: &str) -> Option<String> {
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &Options::default());
    let heading = root.descendants().find(|node| {
        matches!(node.data.borrow().value, NodeValue::Heading(ref heading) if heading.level == 1)
    })?;
    let title = heading
        .descendants()
        .skip(1)
        .filter_map(|node| match &node.data.borrow().value {
            NodeValue::Text(text) => Some(text.to_string()),
            NodeValue::Code(code) => Some(code.literal.to_string()),
            _ => None,
        })
        .collect::<String>();
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(value: &str) -> NaiveDate {
        NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn extracts_first_h1_title() {
        assert_eq!(
            extract_title("## Ignore\n\n# **Daily** `Plan`\n\n# Later"),
            Some("Daily Plan".to_owned())
        );
        assert_eq!(
            extract_title("Setext title\n============\n"),
            Some("Setext title".to_owned())
        );
        assert_eq!(extract_title("No heading"), None);
    }

    #[test]
    fn extracts_only_owned_image_reference_urls() {
        let markdown = concat!(
            "![one](/api/daily-notes/image-refs/12)\n",
            "![duplicate](/api/daily-notes/image-refs/12)\n",
            "![two](/api/daily-notes/image-refs/7)\n",
            "[not an image](/api/daily-notes/image-refs/9)\n",
            "![external](https://example.com/api/daily-notes/image-refs/8)\n",
        );
        assert_eq!(owned_image_reference_ids(markdown), vec![7, 12]);
    }

    #[tokio::test]
    async fn manages_validated_note_lifecycle() {
        let service = DailyNotesService::new(Store::connect("sqlite::memory:").await.unwrap());
        let note_date = date("2026-07-03");
        let created = service.create(note_date).await.unwrap();
        assert_eq!(created.title, "2026-07-03");
        assert!(matches!(
            service.create(note_date).await,
            Err(DailyNotesError::Conflict { .. })
        ));

        let updated = service
            .update(note_date, "# Breakout\n\nNotes", created.revision)
            .await
            .unwrap();
        assert_eq!(updated.title, "Breakout");
        assert!(matches!(
            service.create(note_date).await,
            Err(DailyNotesError::Conflict {
                current_revision: 2,
                ..
            })
        ));
        assert!(matches!(
            service.update(note_date, "stale", 1).await,
            Err(DailyNotesError::Conflict {
                current_revision: 2,
                ..
            })
        ));
        let search = service.list(Some("eak")).await.unwrap();
        assert_eq!(search.len(), 1);
        assert_eq!(
            search[0].title_html.as_deref(),
            Some("Br<mark>eak</mark>out")
        );
        assert!(
            search[0]
                .snippet_html
                .as_deref()
                .is_some_and(|snippet| snippet.contains("<mark>eak</mark>"))
        );
        service.delete(note_date).await.unwrap();
        assert!(matches!(
            service.get(note_date).await,
            Err(DailyNotesError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn validates_revision_and_search_length() {
        let service = DailyNotesService::new(Store::connect("sqlite::memory:").await.unwrap());
        let note_date = date("2026-07-03");
        service.create(note_date).await.unwrap();
        assert!(matches!(
            service.update(note_date, "", 0).await,
            Err(DailyNotesError::Validation(_))
        ));
        assert!(matches!(
            service.list(Some(&"x".repeat(MAX_SEARCH_LENGTH + 1))).await,
            Err(DailyNotesError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn validates_and_round_trips_webp_images() {
        use image::ImageEncoder;

        let service = DailyNotesService::new(Store::connect("sqlite::memory:").await.unwrap());
        let note_date = date("2026-07-03");
        service.create(note_date).await.unwrap();
        let mut webp = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut webp)
            .write_image(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();

        let uploaded = service.upload_image(note_date, &webp).await.unwrap();
        assert_eq!(uploaded.width, 1);
        assert_eq!(uploaded.height, 1);
        assert_eq!(service.image(uploaded.id).await.unwrap().bytes, webp);
        assert!(matches!(
            service.upload_image(note_date, b"not webp").await,
            Err(DailyNotesError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn validates_and_isolates_rendered_images() {
        use image::ImageEncoder;

        fn webp(pixel: [u8; 4]) -> Vec<u8> {
            let mut bytes = Vec::new();
            image::codecs::webp::WebPEncoder::new_lossless(&mut bytes)
                .write_image(&pixel, 1, 1, image::ExtendedColorType::Rgba8)
                .unwrap();
            bytes
        }

        let service = DailyNotesService::new(Store::connect("sqlite::memory:").await.unwrap());
        let note_date = date("2026-07-03");
        service.create(note_date).await.unwrap();
        let source = webp([255, 0, 0, 255]);
        let rendered = webp([0, 0, 255, 255]);
        let first = service.upload_image(note_date, &source).await.unwrap();
        let second = service.upload_image(note_date, &source).await.unwrap();
        service
            .save_rendered_image(first.id, &rendered)
            .await
            .unwrap();
        assert_eq!(service.image(first.id).await.unwrap().bytes, rendered);
        assert_eq!(service.image(second.id).await.unwrap().bytes, source);

        assert!(matches!(
            service.save_rendered_image(first.id, b"not webp").await,
            Err(DailyNotesError::Validation(_))
        ));
        assert!(matches!(
            service.save_rendered_image(999, &rendered).await,
            Err(DailyNotesError::ImageNotFound(999))
        ));
    }
}
