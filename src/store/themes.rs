use super::Store;
use crate::models::{
    AssignmentSource, Theme, ThemeAiJob, ThemeAiJobStatus, ThemeAiJobSummary, ThemeAssignment,
    ThemeSuggestion, ThemeTicker,
};
use anyhow::Context;
use chrono::{NaiveDateTime, Utc};
use sqlx::{QueryBuilder, Sqlite};

struct StoredThemeTicker {
    symbol: String,
    name: Option<String>,
    description: Option<String>,
    theme_id: Option<i64>,
    theme_name: Option<String>,
    source: Option<String>,
    reasoning: Option<String>,
    model: Option<String>,
    assigned_at: Option<NaiveDateTime>,
}

struct StoredThemeAiJob {
    id: i64,
    status: String,
    symbols: String,
    model: String,
    prompt: String,
    response: Option<String>,
    suggestions: Option<String>,
    error: Option<String>,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

struct StoredThemeAiJobSummary {
    id: i64,
    status: String,
    symbol_count: i64,
    model: String,
    updated_at: NaiveDateTime,
}

impl Store {
    pub async fn theme_names_for_ticker(&self, symbol: &str) -> anyhow::Result<Vec<String>> {
        sqlx::query_scalar!(
            r#"SELECT themes.name
               FROM theme_stocks
               JOIN themes ON themes.id = theme_stocks.theme_id
               WHERE theme_stocks.symbol = ?
               ORDER BY themes.name COLLATE NOCASE"#,
            symbol,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load ticker theme names")
    }

    pub async fn themes_with_assignments(&self) -> anyhow::Result<Vec<Theme>> {
        sqlx::query_as!(
            Theme,
            r#"SELECT themes.id, themes.name, themes.etf_symbol, themes.description,
                      COUNT(theme_stocks.symbol) AS "stock_count!: i64"
               FROM themes
               JOIN theme_stocks ON theme_stocks.theme_id = themes.id
               GROUP BY themes.id
               ORDER BY themes.name COLLATE NOCASE"#,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load assigned themes")
    }

    pub async fn tickers_for_themes(
        &self,
        theme_ids: &[i64],
        include_unassigned: bool,
    ) -> anyhow::Result<Vec<String>> {
        if theme_ids.is_empty() && !include_unassigned {
            return self.known_tickers().await;
        }

        let mut query = QueryBuilder::<Sqlite>::new(
            "WITH known_symbols AS (
                 SELECT symbol FROM tickers
                 UNION
                 SELECT symbol FROM industry_membership_tickers
                 UNION
                 SELECT symbol FROM theme_stocks
             )
             SELECT DISTINCT known_symbols.symbol
             FROM known_symbols
             LEFT JOIN theme_stocks ON theme_stocks.symbol = known_symbols.symbol
             WHERE ",
        );
        if theme_ids.is_empty() {
            query.push("theme_stocks.symbol IS NULL");
        } else {
            query.push("theme_stocks.theme_id IN (");
            {
                let mut separated = query.separated(", ");
                for theme_id in theme_ids {
                    separated.push_bind(theme_id);
                }
            }
            query.push(")");
            if include_unassigned {
                query.push(" OR theme_stocks.symbol IS NULL");
            }
        }
        query.push(" ORDER BY known_symbols.symbol");
        query
            .build_query_scalar::<String>()
            .fetch_all(&self.pool)
            .await
            .context("failed to load tickers for themes")
    }

    pub async fn themes(&self) -> anyhow::Result<Vec<Theme>> {
        sqlx::query_as!(
            Theme,
            r#"SELECT themes.id, themes.name, themes.etf_symbol, themes.description,
                      COUNT(theme_stocks.symbol) AS "stock_count!: i64"
               FROM themes
               LEFT JOIN theme_stocks ON theme_stocks.theme_id = themes.id
               GROUP BY themes.id
               ORDER BY themes.name COLLATE NOCASE"#,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load themes")
    }

    pub async fn create_theme(
        &self,
        name: &str,
        etf_symbol: &str,
        description: Option<&str>,
    ) -> anyhow::Result<i64> {
        sqlx::query!(
            "INSERT INTO themes (name, etf_symbol, description) VALUES (?, ?, ?)",
            name,
            etf_symbol,
            description,
        )
        .execute(&self.pool)
        .await
        .context("failed to create theme")
        .map(|result| result.last_insert_rowid())
    }

    pub async fn update_theme(
        &self,
        id: i64,
        name: &str,
        etf_symbol: &str,
        description: Option<&str>,
    ) -> anyhow::Result<bool> {
        sqlx::query!(
            "UPDATE themes SET name = ?, etf_symbol = ?, description = ? WHERE id = ?",
            name,
            etf_symbol,
            description,
            id,
        )
        .execute(&self.pool)
        .await
        .context("failed to update theme")
        .map(|result| result.rows_affected() > 0)
    }

    pub async fn delete_theme(&self, id: i64) -> anyhow::Result<bool> {
        sqlx::query!("DELETE FROM themes WHERE id = ?", id)
            .execute(&self.pool)
            .await
            .context("failed to delete theme")
            .map(|result| result.rows_affected() > 0)
    }

    pub async fn theme_tickers(&self) -> anyhow::Result<Vec<ThemeTicker>> {
        let rows = sqlx::query_as!(
            StoredThemeTicker,
            r#"WITH known_symbols AS (
                   SELECT symbol FROM tickers
                   UNION
                   SELECT symbol FROM industry_membership_tickers
                   UNION
                   SELECT symbol FROM theme_stocks
               )
               SELECT known_symbols.symbol, tickers.name, tickers.description,
                      themes.id AS theme_id, themes.name AS theme_name,
                      theme_stocks.source, theme_stocks.reasoning, theme_stocks.model,
                      theme_stocks.assigned_at AS "assigned_at?: NaiveDateTime"
               FROM known_symbols
               LEFT JOIN tickers ON tickers.symbol = known_symbols.symbol
               LEFT JOIN theme_stocks ON theme_stocks.symbol = known_symbols.symbol
               LEFT JOIN themes ON themes.id = theme_stocks.theme_id
               ORDER BY known_symbols.symbol, themes.name COLLATE NOCASE"#,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load theme tickers")?;

        let mut tickers = Vec::<ThemeTicker>::new();
        for row in rows {
            if tickers
                .last()
                .is_none_or(|ticker| ticker.symbol != row.symbol)
            {
                tickers.push(ThemeTicker {
                    symbol: row.symbol.clone(),
                    name: row.name,
                    description: row.description,
                    assignments: Vec::new(),
                });
            }
            let Some(theme_id) = row.theme_id else {
                continue;
            };
            tickers
                .last_mut()
                .expect("ticker inserted")
                .assignments
                .push(ThemeAssignment {
                    theme_id,
                    theme_name: row.theme_name.context("assigned theme has no name")?,
                    source: parse_source(row.source.as_deref())?,
                    reasoning: row.reasoning,
                    model: row.model,
                    assigned_at: row
                        .assigned_at
                        .context("assigned theme has no timestamp")?
                        .and_utc(),
                });
        }
        Ok(tickers)
    }

    pub async fn replace_theme_assignments(
        &self,
        symbol: &str,
        theme_ids: &[i64],
        source: AssignmentSource,
        reasoning: Option<&str>,
        model: Option<&str>,
    ) -> anyhow::Result<()> {
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin assignment")?;
        sqlx::query!("DELETE FROM theme_stocks WHERE symbol = ?", symbol)
            .execute(&mut *transaction)
            .await
            .context("failed to clear theme assignments")?;
        let assigned_at = Utc::now().naive_utc();
        let source = source.as_str();
        for theme_id in theme_ids {
            sqlx::query!(
                "INSERT INTO theme_stocks (
                    theme_id, symbol, source, reasoning, model, assigned_at
                 ) VALUES (?, ?, ?, ?, ?, ?)",
                theme_id,
                symbol,
                source,
                reasoning,
                model,
                assigned_at,
            )
            .execute(&mut *transaction)
            .await
            .context("failed to insert theme assignment")?;
        }
        transaction
            .commit()
            .await
            .context("failed to commit assignment")
    }

    pub async fn theme_ids_by_names(&self, names: &[String]) -> anyhow::Result<Vec<i64>> {
        if names.is_empty() {
            return Ok(Vec::new());
        }
        let mut query = QueryBuilder::<Sqlite>::new("SELECT id FROM themes WHERE name IN (");
        let mut separated = query.separated(", ");
        for name in names {
            separated.push_bind(name);
        }
        query.push(")");
        query
            .build_query_scalar()
            .fetch_all(&self.pool)
            .await
            .context("failed to resolve theme names")
    }

    pub async fn replace_theme_assignment_batch(
        &self,
        assignments: &[(String, Vec<i64>, Option<String>)],
        source: AssignmentSource,
        model: Option<&str>,
    ) -> anyhow::Result<()> {
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin bulk assignment")?;
        let assigned_at = Utc::now().naive_utc();
        let source = source.as_str();
        for (symbol, theme_ids, reasoning) in assignments {
            sqlx::query!("DELETE FROM theme_stocks WHERE symbol = ?", symbol)
                .execute(&mut *transaction)
                .await
                .context("failed to clear bulk theme assignments")?;
            for theme_id in theme_ids {
                sqlx::query!(
                    "INSERT INTO theme_stocks (
                        theme_id, symbol, source, reasoning, model, assigned_at
                     ) VALUES (?, ?, ?, ?, ?, ?)",
                    theme_id,
                    symbol,
                    source,
                    reasoning,
                    model,
                    assigned_at,
                )
                .execute(&mut *transaction)
                .await
                .context("failed to insert bulk theme assignment")?;
            }
        }
        transaction
            .commit()
            .await
            .context("failed to commit bulk assignment")
    }

    pub async fn create_theme_ai_jobs(
        &self,
        model: &str,
        batches: &[(Vec<String>, String)],
    ) -> anyhow::Result<Vec<i64>> {
        let now = Utc::now().naive_utc();
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin theme AI jobs")?;
        let mut ids = Vec::with_capacity(batches.len());
        for (symbols, prompt) in batches {
            let symbols =
                serde_json::to_string(symbols).context("failed to serialize job symbols")?;
            let result = sqlx::query!(
                r#"INSERT INTO theme_ai_jobs (
                       status, symbols, model, prompt, created_at, updated_at
                   ) VALUES ('pending', ?, ?, ?, ?, ?)"#,
                symbols,
                model,
                prompt,
                now,
                now,
            )
            .execute(&mut *transaction)
            .await
            .context("failed to create theme AI job")?;
            ids.push(result.last_insert_rowid());
        }
        transaction
            .commit()
            .await
            .context("failed to commit theme AI jobs")?;
        Ok(ids)
    }

    pub async fn fail_interrupted_theme_ai_jobs(&self) -> anyhow::Result<()> {
        let now = Utc::now().naive_utc();
        sqlx::query!(
            r#"UPDATE theme_ai_jobs
               SET status = 'failed', error = 'Server restarted before job completed', updated_at = ?
               WHERE status IN ('pending', 'running')"#,
            now,
        )
        .execute(&self.pool)
        .await
        .context("failed to mark interrupted theme AI jobs")?;
        Ok(())
    }

    pub async fn set_theme_ai_job_running(&self, id: i64) -> anyhow::Result<()> {
        let now = Utc::now().naive_utc();
        sqlx::query!(
            "UPDATE theme_ai_jobs SET status = 'running', updated_at = ? WHERE id = ?",
            now,
            id,
        )
        .execute(&self.pool)
        .await
        .context("failed to mark theme AI job running")?;
        Ok(())
    }

    pub async fn complete_theme_ai_job(
        &self,
        id: i64,
        response: &str,
        suggestions: &[ThemeSuggestion],
    ) -> anyhow::Result<()> {
        let suggestions =
            serde_json::to_string(suggestions).context("failed to serialize batch suggestions")?;
        let now = Utc::now().naive_utc();
        sqlx::query!(
            r#"UPDATE theme_ai_jobs
               SET status = 'completed', response = ?, suggestions = ?, error = NULL, updated_at = ?
               WHERE id = ?"#,
            response,
            suggestions,
            now,
            id,
        )
        .execute(&self.pool)
        .await
        .context("failed to complete theme AI job")?;
        Ok(())
    }

    pub async fn fail_theme_ai_job(&self, id: i64, error: &str) -> anyhow::Result<()> {
        let now = Utc::now().naive_utc();
        sqlx::query!(
            "UPDATE theme_ai_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
            error,
            now,
            id,
        )
        .execute(&self.pool)
        .await
        .context("failed to fail theme AI job")?;
        Ok(())
    }

    pub async fn mark_theme_ai_job_applied(&self, id: i64) -> anyhow::Result<()> {
        let now = Utc::now().naive_utc();
        sqlx::query!(
            r#"UPDATE theme_ai_jobs
               SET status = 'applied', updated_at = ?
               WHERE id = ? AND status = 'completed'"#,
            now,
            id,
        )
        .execute(&self.pool)
        .await
        .context("failed to mark theme AI job applied")?;
        Ok(())
    }

    pub async fn delete_theme_ai_job(&self, id: i64) -> anyhow::Result<bool> {
        sqlx::query!(
            "DELETE FROM theme_ai_jobs WHERE id = ? AND status NOT IN ('pending', 'running')",
            id,
        )
        .execute(&self.pool)
        .await
        .context("failed to delete theme AI job")
        .map(|result| result.rows_affected() > 0)
    }

    pub async fn theme_ai_jobs(&self) -> anyhow::Result<Vec<ThemeAiJobSummary>> {
        let jobs = sqlx::query_as!(
            StoredThemeAiJobSummary,
            r#"SELECT id, status,
                      json_array_length(symbols) AS "symbol_count!: i64",
                      model,
                      updated_at AS "updated_at: NaiveDateTime"
               FROM theme_ai_jobs
               ORDER BY updated_at DESC"#,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load theme AI jobs")?;
        jobs.into_iter().map(parse_theme_ai_job_summary).collect()
    }

    pub async fn theme_ai_job(&self, id: i64) -> anyhow::Result<Option<ThemeAiJob>> {
        sqlx::query_as!(
            StoredThemeAiJob,
            r#"SELECT id, status, symbols AS "symbols: String", model,
                      prompt, response, suggestions AS "suggestions: String", error,
                      created_at AS "created_at: NaiveDateTime",
                      updated_at AS "updated_at: NaiveDateTime"
               FROM theme_ai_jobs
               WHERE id = ?"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load theme AI job")?
        .map(parse_theme_ai_job)
        .transpose()
    }
}

fn parse_theme_ai_job_summary(job: StoredThemeAiJobSummary) -> anyhow::Result<ThemeAiJobSummary> {
    Ok(ThemeAiJobSummary {
        id: job.id,
        status: parse_job_status(&job.status)?,
        symbol_count: job.symbol_count,
        model: job.model,
        updated_at: job.updated_at.and_utc(),
    })
}

fn parse_theme_ai_job(job: StoredThemeAiJob) -> anyhow::Result<ThemeAiJob> {
    Ok(ThemeAiJob {
        id: job.id,
        status: parse_job_status(&job.status)?,
        symbols: serde_json::from_str(&job.symbols).context("invalid stored job symbols")?,
        model: job.model,
        prompt: job.prompt,
        response: job.response,
        suggestions: job
            .suggestions
            .map(|value| serde_json::from_str(&value).context("invalid stored job suggestions"))
            .transpose()?,
        error: job.error,
        created_at: job.created_at.and_utc(),
        updated_at: job.updated_at.and_utc(),
    })
}

fn parse_job_status(status: &str) -> anyhow::Result<ThemeAiJobStatus> {
    match status {
        "pending" => Ok(ThemeAiJobStatus::Pending),
        "running" => Ok(ThemeAiJobStatus::Running),
        "completed" => Ok(ThemeAiJobStatus::Completed),
        "failed" => Ok(ThemeAiJobStatus::Failed),
        "applied" => Ok(ThemeAiJobStatus::Applied),
        _ => anyhow::bail!("invalid stored theme AI job status"),
    }
}

fn parse_source(source: Option<&str>) -> anyhow::Result<AssignmentSource> {
    match source {
        Some("manual") => Ok(AssignmentSource::Manual),
        Some("manual_ai") => Ok(AssignmentSource::ManualAi),
        Some("automatic_ai") => Ok(AssignmentSource::AutomaticAi),
        _ => anyhow::bail!("invalid stored assignment source"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CompanyProfile, Exchange};

    #[tokio::test]
    async fn deleting_theme_removes_assignment_but_preserves_ticker() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        store
            .upsert_company_profile(&CompanyProfile {
                symbol: "TEST".to_owned(),
                name: Some("Test Company".to_owned()),
                exchange: Exchange::Nasdaq,
                description: None,
                fetched_at: Utc::now(),
            })
            .await
            .unwrap();
        let theme_id = store
            .create_theme("Test Theme", "TESTETF", None)
            .await
            .unwrap();
        store
            .replace_theme_assignments("TEST", &[theme_id], AssignmentSource::Manual, None, None)
            .await
            .unwrap();

        assert!(store.delete_theme(theme_id).await.unwrap());
        assert!(store.company_profile("TEST").await.unwrap().is_some());
        assert!(
            store
                .theme_tickers()
                .await
                .unwrap()
                .into_iter()
                .find(|ticker| ticker.symbol == "TEST")
                .unwrap()
                .assignments
                .is_empty()
        );
    }

    #[tokio::test]
    async fn filters_theme_tickers_and_includes_unassigned() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        for symbol in ["AAPL", "MSFT", "NVDA"] {
            store
                .upsert_company_profile(&CompanyProfile {
                    symbol: symbol.to_owned(),
                    name: None,
                    exchange: Exchange::Nasdaq,
                    description: None,
                    fetched_at: Utc::now(),
                })
                .await
                .unwrap();
        }
        let theme_id = store.create_theme("AI", "AIQ", None).await.unwrap();
        store
            .replace_theme_assignments("NVDA", &[theme_id], AssignmentSource::Manual, None, None)
            .await
            .unwrap();

        assert_eq!(
            store.tickers_for_themes(&[theme_id], false).await.unwrap(),
            ["NVDA"]
        );
        assert_eq!(
            store.tickers_for_themes(&[], true).await.unwrap(),
            ["AAPL", "MSFT"]
        );
        assert_eq!(
            store.tickers_for_themes(&[theme_id], true).await.unwrap(),
            ["AAPL", "MSFT", "NVDA"]
        );
        assert_eq!(store.theme_names_for_ticker("NVDA").await.unwrap(), ["AI"]);
        assert_eq!(
            store
                .themes_with_assignments()
                .await
                .unwrap()
                .into_iter()
                .map(|theme| theme.name)
                .collect::<Vec<_>>(),
            ["AI"]
        );
    }
}
