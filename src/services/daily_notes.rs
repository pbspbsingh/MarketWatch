use crate::models::{DailyNote, DailyNoteSummary};
use crate::store::{DailyNoteUpdate, Store};
use chrono::NaiveDate;
use comrak::nodes::NodeValue;
use comrak::{Arena, Options, parse_document};
use thiserror::Error;

const MAX_SEARCH_LENGTH: usize = 200;

#[derive(Debug, Error)]
pub enum DailyNotesError {
    #[error("{0}")]
    Validation(String),
    #[error("daily note for {0} was not found")]
    NotFound(NaiveDate),
    #[error("daily note for {date} has changed (current revision: {current_revision})")]
    Conflict {
        date: NaiveDate,
        current_revision: i64,
    },
    #[error("daily note persistence failed: {0}")]
    Persistence(#[source] anyhow::Error),
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
        self.store
            .daily_notes(query)
            .await
            .map_err(DailyNotesError::Persistence)
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
        match self
            .store
            .update_daily_note(date, &title, markdown, expected_revision)
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
        assert_eq!(service.list(Some("eak")).await.unwrap().len(), 1);
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
}
