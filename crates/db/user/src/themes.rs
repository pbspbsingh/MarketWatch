use super::Store;
use anyhow::Context;
use chrono::{NaiveDateTime, Utc};
use market_types::TickerSymbol;
use sqlx::{QueryBuilder, Sqlite};
use themes::AssignmentSource;
use themes::Theme;
use themes::ThemeAiJob;
use themes::ThemeAiJobStatus;
use themes::ThemeAiJobSummary;
use themes::ThemeAssignment;
use themes::ThemeSuggestion;
use themes::ThemeSuggestionError;
use themes::TickerThemeState;

struct StoredTheme {
    id: i64,
    name: String,
    etf_symbol: String,
    description: Option<String>,
    stock_count: i64,
}

struct StoredThemeEtf {
    name: String,
    etf_symbol: String,
}

struct StoredThemeTicker {
    symbol: String,
    theme_id: Option<i64>,
    theme_name: Option<String>,
    source: Option<String>,
    reasoning: Option<String>,
    model: Option<String>,
    assigned_at: Option<NaiveDateTime>,
    automatic_processed: bool,
}

struct StoredThemeAiJob {
    id: i64,
    status: String,
    symbols: String,
    model: String,
    prompt: String,
    response: Option<String>,
    suggestions: Option<String>,
    validation_errors: Option<String>,
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

pub struct TickerThemeEtf {
    pub name: String,
    pub etf_symbol: TickerSymbol,
}

pub struct TickerThemeMembership {
    pub theme_id: i64,
    pub theme_name: String,
    pub symbol: TickerSymbol,
}

impl Store {
    pub async fn delete_ticker_references(&self, symbol: &TickerSymbol) -> anyhow::Result<bool> {
        let symbol = symbol.as_str();
        let mut tx = self.pool.begin().await?;
        let result = async {
            let mut deleted = sqlx::query!("DELETE FROM theme_stocks WHERE symbol = ?", symbol)
                .execute(&mut *tx).await?.rows_affected();
            deleted += sqlx::query!("DELETE FROM theme_ai_processed_symbols WHERE symbol = ?", symbol)
                .execute(&mut *tx).await?.rows_affected();
            deleted += sqlx::query!("DELETE FROM theme_ai_jobs WHERE EXISTS (SELECT 1 FROM json_each(symbols) WHERE value = ?)", symbol)
                .execute(&mut *tx).await?.rows_affected();
            deleted += sqlx::query!("DELETE FROM theme_audits WHERE symbol = ?", symbol)
                .execute(&mut *tx).await?.rows_affected();
            deleted += sqlx::query!("DELETE FROM watchlist_tickers WHERE symbol = ?", symbol)
                .execute(&mut *tx).await?.rows_affected();
            Ok::<_, anyhow::Error>(deleted > 0)
        }.await;
        match result {
            Ok(deleted) => {
                tx.commit().await?;
                self.membership_changes.send_replace(());
                Ok(deleted)
            }
            Err(error) => {
                tx.rollback()
                    .await
                    .context("failed to roll back ticker reference deletion")?;
                Err(error)
            }
        }
    }

    pub async fn assigned_theme_symbols(&self) -> anyhow::Result<Vec<TickerSymbol>> {
        sqlx::query_scalar!("SELECT DISTINCT symbol FROM theme_stocks ORDER BY symbol")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(|symbol| TickerSymbol::try_from(symbol).map_err(anyhow::Error::new))
            .collect()
    }

    pub async fn theme_names_for_ticker(
        &self,
        symbol: &TickerSymbol,
    ) -> anyhow::Result<Vec<String>> {
        let symbol = symbol.as_str();
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

    pub async fn theme_etfs_for_ticker(
        &self,
        symbol: &TickerSymbol,
    ) -> anyhow::Result<Vec<TickerThemeEtf>> {
        let symbol = symbol.as_str();
        let rows = sqlx::query_as!(
            StoredThemeEtf,
            r#"SELECT themes.name, themes.etf_symbol
               FROM theme_stocks
               JOIN themes ON themes.id = theme_stocks.theme_id
               WHERE theme_stocks.symbol = ?
               ORDER BY themes.name COLLATE NOCASE"#,
            symbol,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load ticker theme ETFs")?;
        rows.into_iter()
            .map(|row| {
                Ok(TickerThemeEtf {
                    name: row.name,
                    etf_symbol: TickerSymbol::try_from(row.etf_symbol)?,
                })
            })
            .collect()
    }

    pub async fn themes_with_assignments(&self) -> anyhow::Result<Vec<Theme>> {
        let themes = sqlx::query_as!(
            StoredTheme,
            r#"SELECT themes.id, themes.name, themes.etf_symbol, themes.description,
                      COUNT(theme_stocks.symbol) AS "stock_count!: i64"
               FROM themes
               JOIN theme_stocks ON theme_stocks.theme_id = themes.id
               GROUP BY themes.id
               ORDER BY themes.name COLLATE NOCASE"#,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load assigned themes")?;
        themes.into_iter().map(stored_theme).collect()
    }

    pub async fn theme_symbols(
        &self,
        known_symbols: &[TickerSymbol],
        theme_ids: &[i64],
        include_unassigned: bool,
    ) -> anyhow::Result<Vec<TickerSymbol>> {
        let known = serde_json::to_string(known_symbols)?;
        let ids = serde_json::to_string(theme_ids)?;
        sqlx::query_scalar!(
            r#"WITH known_symbols(symbol) AS (
                   SELECT CAST(value AS TEXT) FROM json_each(?1)
                   UNION SELECT symbol FROM theme_stocks
               )
               SELECT DISTINCT known_symbols.symbol AS "symbol!: String"
               FROM known_symbols
               LEFT JOIN theme_stocks ON theme_stocks.symbol = known_symbols.symbol
               WHERE (json_array_length(?2) = 0 AND NOT ?3)
                   OR theme_stocks.theme_id IN (SELECT value FROM json_each(?2))
                   OR (?3 AND theme_stocks.symbol IS NULL)
               ORDER BY known_symbols.symbol"#,
            known,
            ids,
            include_unassigned,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load tickers for themes")?
        .into_iter()
        .map(|symbol| TickerSymbol::try_from(symbol).map_err(anyhow::Error::new))
        .collect()
    }

    pub async fn themes_for_symbols(
        &self,
        symbols: &[TickerSymbol],
    ) -> anyhow::Result<Vec<TickerThemeMembership>> {
        if symbols.is_empty() {
            return Ok(Vec::new());
        }

        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT themes.id, themes.name, theme_stocks.symbol
             FROM theme_stocks
             JOIN themes ON themes.id = theme_stocks.theme_id
             WHERE theme_stocks.symbol IN (",
        );
        {
            let mut separated = query.separated(", ");
            for symbol in symbols {
                separated.push_bind(symbol.as_str());
            }
        }
        query.push(") ORDER BY themes.name COLLATE NOCASE, theme_stocks.symbol");
        let rows = query
            .build_query_as::<(i64, String, String)>()
            .fetch_all(&self.pool)
            .await
            .context("failed to load themes for symbols")?;
        rows.into_iter()
            .map(|(theme_id, theme_name, symbol)| {
                Ok(TickerThemeMembership {
                    theme_id,
                    theme_name,
                    symbol: TickerSymbol::try_from(symbol)?,
                })
            })
            .collect()
    }

    pub async fn themes(&self) -> anyhow::Result<Vec<Theme>> {
        let themes = sqlx::query_as!(
            StoredTheme,
            r#"SELECT themes.id, themes.name, themes.etf_symbol, themes.description,
                      COUNT(theme_stocks.symbol) AS "stock_count!: i64"
               FROM themes
               LEFT JOIN theme_stocks ON theme_stocks.theme_id = themes.id
               GROUP BY themes.id
               ORDER BY themes.name COLLATE NOCASE"#,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load themes")?;
        themes.into_iter().map(stored_theme).collect()
    }

    pub async fn create_theme(
        &self,
        name: &str,
        etf_symbol: &TickerSymbol,
        description: Option<&str>,
    ) -> anyhow::Result<i64> {
        let etf_symbol = etf_symbol.as_str();
        let id = sqlx::query!(
            "INSERT INTO themes (name, etf_symbol, description) VALUES (?, ?, ?)",
            name,
            etf_symbol,
            description,
        )
        .execute(&self.pool)
        .await
        .context("failed to create theme")
        .map(|result| result.last_insert_rowid())?;
        self.membership_changes.send_replace(());
        Ok(id)
    }

    pub async fn update_theme(
        &self,
        id: i64,
        name: &str,
        etf_symbol: &TickerSymbol,
        description: Option<&str>,
    ) -> anyhow::Result<bool> {
        let etf_symbol = etf_symbol.as_str();
        let updated = sqlx::query!(
            "UPDATE themes SET name = ?, etf_symbol = ?, description = ? WHERE id = ?",
            name,
            etf_symbol,
            description,
            id,
        )
        .execute(&self.pool)
        .await
        .context("failed to update theme")
        .map(|result| result.rows_affected() > 0)?;
        if updated {
            self.membership_changes.send_replace(());
        }
        Ok(updated)
    }

    pub async fn delete_theme(&self, id: i64) -> anyhow::Result<bool> {
        let deleted = sqlx::query!("DELETE FROM themes WHERE id = ?", id)
            .execute(&self.pool)
            .await
            .context("failed to delete theme")
            .map(|result| result.rows_affected() > 0)?;
        if deleted {
            self.membership_changes.send_replace(());
        }
        Ok(deleted)
    }

    pub async fn theme_ticker_states(
        &self,
        known_symbols: &[TickerSymbol],
        symbol: Option<&TickerSymbol>,
    ) -> anyhow::Result<Vec<TickerThemeState>> {
        let known = serde_json::to_string(known_symbols)?;
        let symbol = symbol.map(TickerSymbol::as_str);
        let rows = sqlx::query_as!(
            StoredThemeTicker,
            r#"WITH known_symbols(symbol) AS (
                   SELECT CAST(value AS TEXT) FROM json_each(?1)
                   UNION SELECT symbol FROM theme_stocks
               )
               SELECT known_symbols.symbol AS "symbol!: String",
                      themes.id AS "theme_id?: i64", themes.name AS theme_name,
                      theme_stocks.source, theme_stocks.reasoning, theme_stocks.model,
                      theme_stocks.assigned_at AS "assigned_at?: NaiveDateTime",
                      EXISTS (
                          SELECT 1 FROM theme_ai_processed_symbols
                          WHERE theme_ai_processed_symbols.symbol = known_symbols.symbol
                      ) AS "automatic_processed!: bool"
               FROM known_symbols
               LEFT JOIN theme_stocks ON theme_stocks.symbol = known_symbols.symbol
               LEFT JOIN themes ON themes.id = theme_stocks.theme_id
               WHERE (?2 IS NULL OR known_symbols.symbol = ?2)
               ORDER BY known_symbols.symbol, themes.name COLLATE NOCASE"#,
            known,
            symbol,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load theme ticker state")?;
        theme_tickers_from_rows(rows)
    }

    pub async fn replace_theme_assignments(
        &self,
        symbol: &TickerSymbol,
        theme_ids: &[i64],
        source: AssignmentSource,
        reasoning: Option<&str>,
        model: Option<&str>,
    ) -> anyhow::Result<()> {
        let symbol = symbol.as_str();
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin assignment")?;
        sqlx::query!("DELETE FROM theme_audits WHERE symbol = ?", symbol)
            .execute(&mut *transaction)
            .await
            .context("failed to invalidate theme audit")?;
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
            .context("failed to commit assignment")?;
        self.membership_changes.send_replace(());
        Ok(())
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
        assignments: &[(TickerSymbol, Vec<i64>, Option<String>)],
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
            let symbol = symbol.as_str();
            sqlx::query!("DELETE FROM theme_audits WHERE symbol = ?", symbol)
                .execute(&mut *transaction)
                .await
                .context("failed to invalidate bulk theme audit")?;
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
            .context("failed to commit bulk assignment")?;
        self.membership_changes.send_replace(());
        Ok(())
    }

    pub async fn create_theme_ai_jobs(
        &self,
        model: &str,
        batches: &[(Vec<TickerSymbol>, String)],
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

    pub async fn finish_theme_ai_job(
        &self,
        id: i64,
        response: &str,
        suggestions: &[ThemeSuggestion],
        validation_errors: &[ThemeSuggestionError],
    ) -> anyhow::Result<()> {
        let status = if validation_errors.is_empty() {
            "completed"
        } else if suggestions.is_empty() {
            "failed"
        } else {
            "partially_failed"
        };
        let suggestions_json =
            serde_json::to_string(suggestions).context("failed to serialize batch suggestions")?;
        let validation_errors_json = serde_json::to_string(validation_errors)
            .context("failed to serialize suggestion validation errors")?;
        let now = Utc::now().naive_utc();
        sqlx::query!(
            r#"UPDATE theme_ai_jobs
               SET status = ?, response = ?, suggestions = ?, validation_errors = ?,
                   error = NULL, updated_at = ?
               WHERE id = ?"#,
            status,
            response,
            suggestions_json,
            validation_errors_json,
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

    pub async fn retry_theme_ai_job(&self, id: i64) -> anyhow::Result<bool> {
        let now = Utc::now().naive_utc();
        sqlx::query!(
            r#"UPDATE theme_ai_jobs
               SET status = 'pending', response = NULL, suggestions = NULL,
                   validation_errors = NULL, error = NULL, updated_at = ?
               WHERE id = ? AND status = 'failed'"#,
            now,
            id,
        )
        .execute(&self.pool)
        .await
        .context("failed to retry theme AI job")
        .map(|result| result.rows_affected() == 1)
    }

    pub async fn apply_theme_ai_job(
        &self,
        id: i64,
        assignments: &[(TickerSymbol, Vec<i64>, Option<String>)],
        model: &str,
    ) -> anyhow::Result<()> {
        let now = Utc::now().naive_utc();
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin theme AI job application")?;
        let application = async {
            let result = sqlx::query!(
                r#"UPDATE theme_ai_jobs
                   SET status = 'applied', updated_at = ?
                   WHERE id = ? AND status IN ('completed', 'partially_failed')"#,
                now,
                id,
            )
            .execute(&mut *transaction)
            .await
            .context("failed to mark theme AI job applied")?;
            anyhow::ensure!(
                result.rows_affected() == 1,
                "theme AI job is not applicable"
            );

            for (symbol, theme_ids, reasoning) in assignments {
                let symbol = symbol.as_str();
                sqlx::query!("DELETE FROM theme_audits WHERE symbol = ?", symbol)
                    .execute(&mut *transaction)
                    .await
                    .context("failed to invalidate automatically assigned theme audit")?;
                sqlx::query!("DELETE FROM theme_stocks WHERE symbol = ?", symbol)
                    .execute(&mut *transaction)
                    .await
                    .context("failed to clear accepted theme assignments")?;
                for theme_id in theme_ids {
                    sqlx::query!(
                        r#"INSERT INTO theme_stocks (
                               theme_id, symbol, source, reasoning, model, assigned_at
                           ) VALUES (?, ?, 'automatic_ai', ?, ?, ?)"#,
                        theme_id,
                        symbol,
                        reasoning,
                        model,
                        now,
                    )
                    .execute(&mut *transaction)
                    .await
                    .context("failed to insert accepted theme assignment")?;
                }
                let outcome = if theme_ids.is_empty() {
                    "no_theme"
                } else {
                    "assigned"
                };
                sqlx::query!(
                    r#"INSERT INTO theme_ai_processed_symbols (
                           symbol, job_id, outcome, processed_at
                       ) VALUES (?, ?, ?, ?)
                       ON CONFLICT(symbol) DO UPDATE SET
                           job_id = excluded.job_id,
                           outcome = excluded.outcome,
                           processed_at = excluded.processed_at"#,
                    symbol,
                    id,
                    outcome,
                    now,
                )
                .execute(&mut *transaction)
                .await
                .context("failed to mark accepted automatically processed ticker")?;
            }
            Ok::<(), anyhow::Error>(())
        }
        .await;
        if let Err(error) = application {
            transaction
                .rollback()
                .await
                .context("failed to roll back theme AI job application")?;
            return Err(error);
        }

        transaction
            .commit()
            .await
            .context("failed to commit theme AI job application")?;
        self.membership_changes.send_replace(());
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

    pub async fn delete_applied_theme_ai_jobs(&self) -> anyhow::Result<u64> {
        sqlx::query!("DELETE FROM theme_ai_jobs WHERE status = 'applied'")
            .execute(&self.pool)
            .await
            .context("failed to delete applied theme AI jobs")
            .map(|result| result.rows_affected())
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
                      prompt, response, suggestions AS "suggestions: String",
                      validation_errors AS "validation_errors: String", error,
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
        reasoning: None,
        response: job.response,
        suggestions: job
            .suggestions
            .map(|value| serde_json::from_str(&value).context("invalid stored job suggestions"))
            .transpose()?,
        validation_errors: job
            .validation_errors
            .map(|value| serde_json::from_str(&value).context("invalid stored validation errors"))
            .transpose()?
            .unwrap_or_default(),
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
        "partially_failed" => Ok(ThemeAiJobStatus::PartiallyFailed),
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

fn theme_tickers_from_rows(rows: Vec<StoredThemeTicker>) -> anyhow::Result<Vec<TickerThemeState>> {
    let mut tickers = Vec::<TickerThemeState>::new();
    for row in rows {
        let symbol = TickerSymbol::try_from(row.symbol.clone())?;
        if tickers.last().is_none_or(|ticker| ticker.symbol != symbol) {
            tickers.push(TickerThemeState {
                symbol,
                assignments: Vec::new(),
                automatic_processed: row.automatic_processed,
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

fn stored_theme(theme: StoredTheme) -> anyhow::Result<Theme> {
    Ok(Theme {
        id: theme.id,
        name: theme.name,
        etf_symbol: TickerSymbol::try_from(theme.etf_symbol)?,
        description: theme.description,
        stock_count: theme.stock_count,
    })
}
