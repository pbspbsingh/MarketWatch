use super::{DailyNoteImage, DailyNoteListRow, DailyNoteUpdate, Store};
use crate::models::DailyNote;
use anyhow::Context;
use chrono::{NaiveDate, NaiveDateTime};

impl Store {
    pub async fn daily_notes(&self, query: Option<&str>) -> anyhow::Result<Vec<DailyNoteListRow>> {
        let query = query.map(str::trim).filter(|query| !query.is_empty());
        let Some(query) = query else {
            return sqlx::query_as!(
                DailyNoteListRow,
                r#"SELECT note_date AS "note_date: NaiveDate", title, '' AS markdown
                   FROM daily_notes
                   ORDER BY note_date DESC"#,
            )
            .fetch_all(&self.pool)
            .await
            .context("failed to list daily notes");
        };

        let pattern = contains_pattern(query);
        if query.chars().count() < 3 {
            return sqlx::query_as!(
                DailyNoteListRow,
                r#"SELECT note_date AS "note_date: NaiveDate", title, markdown
                   FROM daily_notes
                   WHERE note_date LIKE ? ESCAPE '\'
                      OR title LIKE ? ESCAPE '\'
                      OR markdown LIKE ? ESCAPE '\'
                   ORDER BY note_date DESC"#,
                pattern,
                pattern,
                pattern,
            )
            .fetch_all(&self.pool)
            .await
            .context("failed to search daily notes");
        }

        let fts_query = format!("\"{}\"", query.replace('"', "\"\""));
        sqlx::query_as!(
            DailyNoteListRow,
            r#"SELECT note_date AS "note_date: NaiveDate", title, markdown
               FROM daily_notes
               WHERE note_date LIKE ? ESCAPE '\'
                  OR rowid IN (
                      SELECT rowid FROM daily_notes_fts WHERE daily_notes_fts MATCH ?
                  )
               ORDER BY note_date DESC"#,
            pattern,
            fts_query,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to search daily notes")
    }

    pub async fn daily_note(&self, note_date: NaiveDate) -> anyhow::Result<Option<DailyNote>> {
        sqlx::query_as!(
            DailyNote,
            r#"SELECT note_date AS "note_date: NaiveDate",
                      title,
                      markdown,
                      revision,
                      created_at AS "created_at: NaiveDateTime",
                      updated_at AS "updated_at: NaiveDateTime"
               FROM daily_notes
               WHERE note_date = ?"#,
            note_date,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load daily note")
    }

    pub async fn create_daily_note(&self, note_date: NaiveDate) -> anyhow::Result<DailyNote> {
        let title = note_date.to_string();
        sqlx::query!(
            "INSERT INTO daily_notes (note_date, title) VALUES (?, ?)",
            note_date,
            title,
        )
        .execute(&self.pool)
        .await
        .context("failed to create daily note")?;
        self.daily_note(note_date)
            .await?
            .context("created daily note was not found")
    }

    pub async fn update_daily_note(
        &self,
        note_date: NaiveDate,
        title: &str,
        markdown: &str,
        expected_revision: i64,
        image_ids: &[i64],
    ) -> anyhow::Result<DailyNoteUpdate> {
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin note update")?;
        let result = sqlx::query!(
            r#"UPDATE daily_notes
               SET title = ?,
                   markdown = ?,
                   revision = revision + 1,
                   updated_at = CURRENT_TIMESTAMP
               WHERE note_date = ? AND revision = ?"#,
            title,
            markdown,
            note_date,
            expected_revision,
        )
        .execute(&mut *transaction)
        .await
        .context("failed to update daily note")?;

        if result.rows_affected() == 1 {
            sqlx::query!(
                r#"UPDATE daily_note_images
                   SET detached_at = CURRENT_TIMESTAMP
                   WHERE note_date = ? AND detached_at IS NULL"#,
                note_date,
            )
            .execute(&mut *transaction)
            .await
            .context("failed to detach removed images")?;
            for image_id in image_ids {
                sqlx::query!(
                    r#"UPDATE daily_note_images
                       SET detached_at = NULL
                       WHERE id = ? AND note_date = ?"#,
                    image_id,
                    note_date,
                )
                .execute(&mut *transaction)
                .await
                .context("failed to attach image")?;
            }
            transaction
                .commit()
                .await
                .context("failed to commit note update")?;
            return self
                .daily_note(note_date)
                .await?
                .map(DailyNoteUpdate::Updated)
                .context("updated daily note was not found");
        }

        transaction
            .rollback()
            .await
            .context("failed to roll back note update")?;

        Ok(match self.daily_note(note_date).await? {
            Some(note) => DailyNoteUpdate::Conflict {
                current_revision: note.revision,
            },
            None => DailyNoteUpdate::NotFound,
        })
    }

    pub async fn delete_daily_note(&self, note_date: NaiveDate) -> anyhow::Result<bool> {
        sqlx::query!("DELETE FROM daily_notes WHERE note_date = ?", note_date)
            .execute(&self.pool)
            .await
            .context("failed to delete daily note")
            .map(|result| result.rows_affected() == 1)
    }

    pub async fn create_daily_note_image(
        &self,
        note_date: NaiveDate,
        bytes: &[u8],
        width: i64,
        height: i64,
    ) -> anyhow::Result<i64> {
        sqlx::query!(
            r#"INSERT INTO daily_note_images
                   (note_date, width, height, image_blob, detached_at)
               VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)"#,
            note_date,
            width,
            height,
            bytes,
        )
        .execute(&self.pool)
        .await
        .context("failed to store daily note image")
        .map(|result| result.last_insert_rowid())
    }

    pub async fn daily_note_image(&self, image_id: i64) -> anyhow::Result<Option<DailyNoteImage>> {
        sqlx::query_as!(
            DailyNoteImage,
            r#"SELECT image_blob AS "bytes!: Vec<u8>", width, height
               FROM daily_note_images
               WHERE id = ?"#,
            image_id,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load daily note image")
    }

    pub async fn cleanup_daily_note_images(&self) -> anyhow::Result<u64> {
        sqlx::query!(
            r#"DELETE FROM daily_note_images
               WHERE detached_at IS NOT NULL
                 AND detached_at <= datetime('now', '-1 hour')"#,
        )
        .execute(&self.pool)
        .await
        .context("failed to delete detached daily note images")
        .map(|result| result.rows_affected())
    }

    pub async fn update_daily_note_image(
        &self,
        image_id: i64,
        rendered: &[u8],
    ) -> anyhow::Result<bool> {
        sqlx::query!(
            r#"UPDATE daily_note_images
               SET image_blob = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?"#,
            rendered,
            image_id,
        )
        .execute(&self.pool)
        .await
        .context("failed to save rendered image")
        .map(|result| result.rows_affected() == 1)
    }
}

fn contains_pattern(value: &str) -> String {
    let mut pattern = String::with_capacity(value.len() + 2);
    pattern.push('%');
    for character in value.chars() {
        if matches!(character, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(value: &str) -> NaiveDate {
        NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
    }

    #[tokio::test]
    async fn manages_notes_with_revision_checks() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let note_date = date("2026-07-03");
        let created = store.create_daily_note(note_date).await.unwrap();
        assert_eq!(created.title, "2026-07-03");
        assert_eq!(created.revision, 1);
        assert!(store.create_daily_note(note_date).await.is_err());

        let updated = store
            .update_daily_note(note_date, "Breakout", "# Breakout\n\nChart notes", 1, &[])
            .await
            .unwrap();
        assert!(matches!(updated, DailyNoteUpdate::Updated(ref note) if note.revision == 2));

        assert_eq!(
            store
                .update_daily_note(note_date, "Stale", "stale", 1, &[])
                .await
                .unwrap(),
            DailyNoteUpdate::Conflict {
                current_revision: 2
            }
        );
        assert_eq!(
            store
                .update_daily_note(date("2026-07-04"), "Missing", "", 1, &[])
                .await
                .unwrap(),
            DailyNoteUpdate::NotFound
        );
        assert!(store.delete_daily_note(note_date).await.unwrap());
        assert!(store.daily_note(note_date).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn lists_and_searches_notes_by_date_title_and_body() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        for value in ["2026-07-01", "2026-07-03", "2026-07-02"] {
            store.create_daily_note(date(value)).await.unwrap();
        }
        store
            .update_daily_note(
                date("2026-07-01"),
                "Breakout",
                "# Breakout\n\nConsolidation complete",
                1,
                &[],
            )
            .await
            .unwrap();

        let notes = store.daily_notes(None).await.unwrap();
        assert_eq!(notes[0].note_date, date("2026-07-03"));
        assert_eq!(notes[2].note_date, date("2026-07-01"));
        assert_eq!(store.daily_notes(Some("eak")).await.unwrap().len(), 1);
        assert_eq!(
            store.daily_notes(Some("solidation")).await.unwrap().len(),
            1
        );
        assert_eq!(store.daily_notes(Some("07-02")).await.unwrap().len(), 1);
        assert_eq!(store.daily_notes(Some("Br")).await.unwrap().len(), 1);
        assert!(store.daily_notes(Some("%")).await.unwrap().is_empty());
        assert!(store.daily_notes(Some("_")).await.unwrap().is_empty());

        store
            .update_daily_note(
                date("2026-07-01"),
                "Reversal",
                "# Reversal\n\nFailed move",
                2,
                &[],
            )
            .await
            .unwrap();
        assert!(store.daily_notes(Some("eak")).await.unwrap().is_empty());
        assert_eq!(store.daily_notes(Some("versal")).await.unwrap().len(), 1);
        store.delete_daily_note(date("2026-07-01")).await.unwrap();
        assert!(store.daily_notes(Some("versal")).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn attaches_detaches_restores_and_cleans_up_images() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let note_date = date("2026-07-03");
        store.create_daily_note(note_date).await.unwrap();
        let image_id = store
            .create_daily_note_image(note_date, b"webp", 1, 1)
            .await
            .unwrap();

        store
            .update_daily_note(note_date, "note", "image", 1, &[image_id])
            .await
            .unwrap();
        let attached = sqlx::query_scalar!(
            "SELECT detached_at IS NULL FROM daily_note_images WHERE id = ?",
            image_id,
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(attached, 1);

        store
            .update_daily_note(note_date, "note", "removed", 2, &[])
            .await
            .unwrap();
        store
            .update_daily_note(note_date, "note", "restored", 3, &[image_id])
            .await
            .unwrap();
        assert!(store.daily_note_image(image_id).await.unwrap().is_some());

        store
            .update_daily_note(note_date, "note", "removed", 4, &[])
            .await
            .unwrap();
        sqlx::query!("UPDATE daily_note_images SET detached_at = datetime('now', '-2 hours')",)
            .execute(&store.pool)
            .await
            .unwrap();
        assert_eq!(store.cleanup_daily_note_images().await.unwrap(), 1);
        assert!(store.daily_note_image(image_id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn cleanup_preserves_a_concurrent_upload() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let active_date = date("2026-07-03");
        store.create_daily_note(active_date).await.unwrap();
        store
            .create_daily_note_image(active_date, b"old", 1, 1)
            .await
            .unwrap();
        sqlx::query!("UPDATE daily_note_images SET detached_at = datetime('now', '-2 hours')")
            .execute(&store.pool)
            .await
            .unwrap();

        let (uploaded, cleaned) = tokio::join!(
            store.create_daily_note_image(active_date, b"new", 1, 1),
            store.cleanup_daily_note_images(),
        );
        let new_reference = match uploaded {
            Ok(reference) => reference,
            Err(error) => {
                assert!(format!("{error:#}").contains("locked"));
                store
                    .create_daily_note_image(active_date, b"new", 1, 1)
                    .await
                    .unwrap()
            }
        };
        let cleaned = match cleaned {
            Ok(counts) => counts,
            Err(error) => {
                assert!(format!("{error:#}").contains("locked"));
                store.cleanup_daily_note_images().await.unwrap()
            }
        };
        assert_eq!(cleaned, 1);
        assert!(
            store
                .daily_note_image(new_reference)
                .await
                .unwrap()
                .is_some()
        );
    }
}
