use crate::models::DailyNote;
use crate::store::{DailyNoteImage, DailyNoteUpdate, Store};
use chrono::NaiveDate;
use comrak::nodes::NodeValue;
use comrak::{Arena, Options, parse_document};
use serde::Serialize;
use thiserror::Error;

mod markdown;

pub use markdown::RenderedMarkdown;

const MAX_SEARCH_LENGTH: usize = 200;
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_INPUT_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_IMAGE_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 1920;
const INITIAL_IMAGE_WEBP_QUALITY: f32 = 90.0;
const LOSSLESS_WEBP_EFFORT: f32 = 75.0;
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
    pub markdown: String,
}

pub struct DailyNoteImageCrop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
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
        let image_ids = owned_image_ids(markdown);
        match self
            .store
            .update_daily_note(date, &title, markdown, expected_revision, &image_ids)
            .await
            .map_err(DailyNotesError::Persistence)?
        {
            DailyNoteUpdate::Updated(note) => Ok(note),
            DailyNoteUpdate::NotFound => Err(DailyNotesError::NotFound(date)),
            DailyNoteUpdate::ImageNotFound(id) => Err(DailyNotesError::ImageNotFound(id)),
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
        let decoded = fit_image(decode_uploaded_image(bytes)?);
        let (width, height) = (decoded.width(), decoded.height());
        let webp = encode_initial_webp(decoded)?;
        let id = self
            .store
            .create_daily_note_image(date, &webp, i64::from(width), i64::from(height))
            .await
            .map_err(DailyNotesError::Persistence)?;
        let url = format!("/api/daily-notes/images/{id}");
        Ok(DailyNoteImageUpload {
            id,
            markdown: format!("![Chart screenshot]({url})"),
        })
    }

    pub async fn image(&self, id: i64) -> Result<DailyNoteImage, DailyNotesError> {
        self.store
            .daily_note_image(id)
            .await
            .map_err(DailyNotesError::Persistence)?
            .ok_or(DailyNotesError::ImageNotFound(id))
    }

    pub async fn update_image(&self, id: i64, image: &[u8]) -> Result<(), DailyNotesError> {
        let decoded = fit_image(decode_png(image)?);
        let (width, height) = (decoded.width(), decoded.height());
        let webp = encode_lossless_webp(decoded)?;
        if !self
            .store
            .update_daily_note_image(id, &webp, i64::from(width), i64::from(height))
            .await
            .map_err(DailyNotesError::Persistence)?
        {
            return Err(DailyNotesError::ImageNotFound(id));
        }
        Ok(())
    }

    pub async fn crop_image(
        &self,
        id: i64,
        crop: DailyNoteImageCrop,
    ) -> Result<(), DailyNotesError> {
        let current = self.image(id).await?;
        let image = decode_uploaded_image(&current.bytes)?;
        let right = crop.x.checked_add(crop.width);
        let bottom = crop.y.checked_add(crop.height);
        if crop.width == 0
            || crop.height == 0
            || right.is_none_or(|right| right > image.width())
            || bottom.is_none_or(|bottom| bottom > image.height())
        {
            return Err(DailyNotesError::Validation(
                "crop must be within the image bounds".to_owned(),
            ));
        }
        let cropped = image.crop_imm(crop.x, crop.y, crop.width, crop.height);
        let webp = encode_lossless_webp(cropped)?;
        if !self
            .store
            .update_daily_note_image(id, &webp, i64::from(crop.width), i64::from(crop.height))
            .await
            .map_err(DailyNotesError::Persistence)?
        {
            return Err(DailyNotesError::ImageNotFound(id));
        }
        Ok(())
    }
}

fn decode_uploaded_image(bytes: &[u8]) -> Result<image::DynamicImage, DailyNotesError> {
    let format = image::guess_format(bytes)
        .map_err(|_| DailyNotesError::Validation("unsupported image format".to_owned()))?;
    match format {
        image::ImageFormat::Jpeg => decode_image(bytes, format, "JPEG", MAX_INPUT_IMAGE_BYTES),
        image::ImageFormat::Png => decode_image(bytes, format, "PNG", MAX_INPUT_IMAGE_BYTES),
        image::ImageFormat::WebP => decode_image(bytes, format, "WebP", MAX_INPUT_IMAGE_BYTES),
        _ => Err(DailyNotesError::Validation(
            "image must be JPEG, PNG, or WebP".to_owned(),
        )),
    }
}

fn decode_png(bytes: &[u8]) -> Result<image::DynamicImage, DailyNotesError> {
    decode_image(bytes, image::ImageFormat::Png, "PNG", MAX_INPUT_IMAGE_BYTES)
}

fn decode_image(
    bytes: &[u8],
    format: image::ImageFormat,
    format_name: &str,
    maximum_bytes: usize,
) -> Result<image::DynamicImage, DailyNotesError> {
    if bytes.is_empty() || bytes.len() > maximum_bytes {
        return Err(DailyNotesError::Validation(format!(
            "image must be a non-empty {format_name} within the size limit"
        )));
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_IMAGE_DECODE_BYTES);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| DailyNotesError::Validation(format!("image must be valid {format_name}")))
}

fn fit_image(image: image::DynamicImage) -> image::DynamicImage {
    if image.width() <= MAX_IMAGE_DIMENSION && image.height() <= MAX_IMAGE_DIMENSION {
        image
    } else {
        image.resize(
            MAX_IMAGE_DIMENSION,
            MAX_IMAGE_DIMENSION,
            image::imageops::FilterType::Lanczos3,
        )
    }
}

fn encode_lossless_webp(image: image::DynamicImage) -> Result<Vec<u8>, DailyNotesError> {
    encode_webp(image, true, LOSSLESS_WEBP_EFFORT)
}

fn encode_initial_webp(image: image::DynamicImage) -> Result<Vec<u8>, DailyNotesError> {
    encode_webp(image, false, INITIAL_IMAGE_WEBP_QUALITY)
}

fn encode_webp(
    image: image::DynamicImage,
    lossless: bool,
    quality: f32,
) -> Result<Vec<u8>, DailyNotesError> {
    let (width, height) = (image.width(), image.height());
    let rgba = image.into_rgba8();
    let webp = webp::Encoder::from_rgba(&rgba, width, height)
        .encode_simple(lossless, quality)
        .map_err(|error| {
            DailyNotesError::Validation(format!("failed to encode image as WebP: {error:?}"))
        })?
        .to_vec();
    if webp.len() > MAX_IMAGE_BYTES {
        return Err(DailyNotesError::Validation(
            "image exceeds 5 MiB after WebP encoding".to_owned(),
        ));
    }
    Ok(webp)
}

fn owned_image_ids(markdown: &str) -> Vec<i64> {
    const PREFIX: &str = "/api/daily-notes/images/";
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

    #[test]
    fn oversized_images_are_resized_proportionally() {
        let resized = fit_image(image::DynamicImage::new_rgba8(3840, 1080));
        assert_eq!((resized.width(), resized.height()), (1920, 540));
    }

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
    fn extracts_only_owned_image_urls() {
        let markdown = concat!(
            "![one](/api/daily-notes/images/12)\n",
            "![duplicate](/api/daily-notes/images/12)\n",
            "![two](/api/daily-notes/images/7)\n",
            "[not an image](/api/daily-notes/images/9)\n",
            "![external](https://example.com/api/daily-notes/images/8)\n",
        );
        assert_eq!(owned_image_ids(markdown), vec![7, 12]);
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
    async fn validates_and_stores_uploaded_images_as_webp() {
        use image::ImageEncoder;

        let service = DailyNotesService::new(Store::connect("sqlite::memory:").await.unwrap());
        let note_date = date("2026-07-03");
        service.create(note_date).await.unwrap();
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();

        let uploaded = service.upload_image(note_date, &png).await.unwrap();
        let stored = service.image(uploaded.id).await.unwrap().bytes;
        assert_eq!(
            image::guess_format(&stored).unwrap(),
            image::ImageFormat::WebP
        );
        assert!(matches!(
            service.upload_image(note_date, b"not an image").await,
            Err(DailyNotesError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn validates_and_isolates_image_updates() {
        use image::ImageEncoder;

        fn webp(pixel: [u8; 4]) -> Vec<u8> {
            let mut bytes = Vec::new();
            image::codecs::webp::WebPEncoder::new_lossless(&mut bytes)
                .write_image(&pixel, 1, 1, image::ExtendedColorType::Rgba8)
                .unwrap();
            bytes
        }

        fn png(pixel: [u8; 4]) -> Vec<u8> {
            let mut bytes = Vec::new();
            let pixels = [pixel, pixel].concat();
            image::codecs::png::PngEncoder::new(&mut bytes)
                .write_image(&pixels, 2, 1, image::ExtendedColorType::Rgba8)
                .unwrap();
            bytes
        }

        let service = DailyNotesService::new(Store::connect("sqlite::memory:").await.unwrap());
        let note_date = date("2026-07-03");
        service.create(note_date).await.unwrap();
        let source = webp([255, 0, 0, 255]);
        let rendered = png([0, 0, 255, 255]);
        let first = service.upload_image(note_date, &source).await.unwrap();
        let second = service.upload_image(note_date, &source).await.unwrap();
        let second_before = service.image(second.id).await.unwrap().bytes;
        service.update_image(first.id, &rendered).await.unwrap();
        let stored = service.image(first.id).await.unwrap();
        let stored = stored.bytes;
        assert_eq!(
            image::guess_format(&stored).unwrap(),
            image::ImageFormat::WebP
        );
        assert_eq!(
            *image::load_from_memory(&stored)
                .unwrap()
                .into_rgba8()
                .get_pixel(0, 0),
            image::Rgba([0, 0, 255, 255]),
        );
        assert_eq!(service.image(second.id).await.unwrap().bytes, second_before);
        assert!(matches!(
            service.update_image(second.id, &source).await,
            Err(DailyNotesError::Validation(_))
        ));

        assert!(matches!(
            service.update_image(first.id, b"not png").await,
            Err(DailyNotesError::Validation(_))
        ));
        assert!(matches!(
            service.update_image(999, &rendered).await,
            Err(DailyNotesError::ImageNotFound(999))
        ));
    }

    #[tokio::test]
    async fn crops_images_and_validates_bounds() {
        use image::ImageEncoder;

        let service = DailyNotesService::new(Store::connect("sqlite::memory:").await.unwrap());
        let note_date = date("2026-07-03");
        service.create(note_date).await.unwrap();
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&[255; 4 * 4 * 2], 4, 2, image::ExtendedColorType::Rgba8)
            .unwrap();
        let uploaded = service.upload_image(note_date, &png).await.unwrap();

        service
            .crop_image(
                uploaded.id,
                DailyNoteImageCrop {
                    x: 1,
                    y: 0,
                    width: 2,
                    height: 2,
                },
            )
            .await
            .unwrap();
        let stored = service.image(uploaded.id).await.unwrap();
        let cropped = image::load_from_memory(&stored.bytes).unwrap();
        assert_eq!((cropped.width(), cropped.height()), (2, 2));
        assert!(matches!(
            service
                .crop_image(
                    uploaded.id,
                    DailyNoteImageCrop {
                        x: 1,
                        y: 0,
                        width: 2,
                        height: 2,
                    },
                )
                .await,
            Err(DailyNotesError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn copies_cross_note_images_and_rewrites_markdown() {
        use image::ImageEncoder;

        let service = DailyNotesService::new(Store::connect("sqlite::memory:").await.unwrap());
        let source_date = date("2026-07-02");
        let target_date = date("2026-07-03");
        service.create(source_date).await.unwrap();
        let target = service.create(target_date).await.unwrap();
        let mut webp = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut webp)
            .write_image(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        let source = service.upload_image(source_date, &webp).await.unwrap();
        let stored_source = service.image(source.id).await.unwrap().bytes;

        let saved = service
            .update(target_date, &source.markdown, target.revision)
            .await
            .unwrap();
        assert_ne!(saved.markdown, source.markdown);
        let copied_id = owned_image_ids(&saved.markdown)[0];
        assert_ne!(copied_id, source.id);
        assert_eq!(service.image(copied_id).await.unwrap().bytes, stored_source);
        assert_eq!(service.image(source.id).await.unwrap().bytes, stored_source);
    }
}
