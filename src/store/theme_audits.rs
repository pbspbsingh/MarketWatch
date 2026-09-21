use super::Store;
use crate::models::{ThemeAudit, ThemeAuditStatus, ThemeAuditTheme, TickerSymbol};
use anyhow::Context;
use chrono::{NaiveDateTime, Utc};
use sqlx::FromRow;

#[derive(Clone, Debug)]
pub(crate) struct NewThemeAudit {
    pub symbol: TickerSymbol,
    pub current_themes: Vec<ThemeAuditTheme>,
    pub suggested_themes: Vec<ThemeAuditTheme>,
    pub status: ThemeAuditStatus,
    pub confidence: f64,
    pub reasoning: String,
    pub model: String,
    pub input_fingerprint: String,
}

pub(crate) struct PendingThemeAudit {
    pub current_themes: Vec<ThemeAuditTheme>,
    pub suggested_themes: Vec<ThemeAuditTheme>,
    pub input_fingerprint: String,
}

#[derive(FromRow)]
struct StoredThemeAudit {
    symbol: String,
    current_themes: String,
    suggested_themes: String,
    status: String,
    confidence: f64,
    reasoning: String,
    model: String,
    audited_at: NaiveDateTime,
    processed_at: Option<NaiveDateTime>,
}

#[derive(FromRow)]
struct StoredAcceptableAudit {
    current_themes: String,
    suggested_themes: String,
    model: String,
    reasoning: String,
}

impl Store {
    pub(crate) async fn theme_audit_eligible_symbols(
        &self,
        include_manual: bool,
    ) -> anyhow::Result<Vec<TickerSymbol>> {
        sqlx::query_scalar!(
            r#"SELECT theme_ai_processed_symbols.symbol
               FROM theme_ai_processed_symbols
               WHERE NOT EXISTS (
                   SELECT 1
                   FROM theme_stocks
                   WHERE theme_stocks.symbol = theme_ai_processed_symbols.symbol
                     AND theme_stocks.source IN ('manual', 'manual_ai')
               )
               UNION
               SELECT theme_stocks.symbol
               FROM theme_stocks
               WHERE ? AND theme_stocks.source IN ('manual', 'manual_ai')
               ORDER BY symbol"#,
            include_manual,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load theme audit eligible symbols")?
        .into_iter()
        .map(|symbol| TickerSymbol::try_from(symbol).context("invalid eligible theme audit symbol"))
        .collect()
    }

    pub(crate) async fn theme_audits(&self) -> anyhow::Result<Vec<ThemeAudit>> {
        sqlx::query_as!(
            StoredThemeAudit,
            r#"SELECT symbol,
                      current_themes AS "current_themes: String",
                      suggested_themes AS "suggested_themes: String",
                      status,
                      confidence,
                      reasoning,
                      model,
                      audited_at AS "audited_at: NaiveDateTime",
                      processed_at AS "processed_at: NaiveDateTime"
               FROM theme_audits
               WHERE status != 'matched'
               ORDER BY
                   CASE status
                       WHEN 'pending' THEN 0
                       WHEN 'accepted' THEN 1
                       ELSE 2
                   END,
                   confidence DESC,
                   symbol"#,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load theme audits")?
        .into_iter()
        .map(parse_theme_audit)
        .collect()
    }

    pub(crate) async fn theme_audit_symbols(&self) -> anyhow::Result<Vec<TickerSymbol>> {
        sqlx::query_scalar!("SELECT symbol FROM theme_audits ORDER BY symbol")
            .fetch_all(&self.pool)
            .await
            .context("failed to load audited theme symbols")?
            .into_iter()
            .map(|symbol| {
                TickerSymbol::try_from(symbol).context("invalid stored theme audit symbol")
            })
            .collect()
    }

    pub(crate) async fn clear_theme_audits(&self) -> anyhow::Result<()> {
        sqlx::query!("DELETE FROM theme_audits")
            .execute(&self.pool)
            .await
            .context("failed to clear theme audits")?;
        Ok(())
    }

    pub(crate) async fn insert_theme_audits(&self, audits: &[NewThemeAudit]) -> anyhow::Result<()> {
        if audits.is_empty() {
            return Ok(());
        }
        let now = Utc::now().naive_utc();
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin theme audit insertion")?;
        for audit in audits {
            let symbol = audit.symbol.as_str();
            let current_themes = serde_json::to_string(&audit.current_themes)
                .context("failed to serialize current audit themes")?;
            let suggested_themes = serde_json::to_string(&audit.suggested_themes)
                .context("failed to serialize suggested audit themes")?;
            let status = audit.status.as_str();
            sqlx::query!(
                r#"INSERT INTO theme_audits (
                       symbol, current_themes, suggested_themes, status, confidence,
                       reasoning, model, input_fingerprint, audited_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
                symbol,
                current_themes,
                suggested_themes,
                status,
                audit.confidence,
                audit.reasoning,
                audit.model,
                audit.input_fingerprint,
                now,
            )
            .execute(&mut *transaction)
            .await
            .context("failed to insert theme audit")?;
        }
        transaction
            .commit()
            .await
            .context("failed to commit theme audit insertion")
    }

    pub(crate) async fn pending_theme_audit(
        &self,
        symbol: &TickerSymbol,
    ) -> anyhow::Result<Option<PendingThemeAudit>> {
        let audit = sqlx::query!(
            r#"SELECT current_themes AS "current_themes: String",
                      suggested_themes AS "suggested_themes: String",
                      input_fingerprint
               FROM theme_audits
               WHERE symbol = ? AND status = 'pending'"#,
            symbol.as_str(),
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load pending theme audit")?;
        audit
            .map(|audit| {
                Ok(PendingThemeAudit {
                    current_themes: serde_json::from_str(&audit.current_themes)
                        .context("invalid stored current audit themes")?,
                    suggested_themes: serde_json::from_str(&audit.suggested_themes)
                        .context("invalid stored suggested audit themes")?,
                    input_fingerprint: audit.input_fingerprint,
                })
            })
            .transpose()
    }

    pub(crate) async fn accept_theme_audit(
        &self,
        symbol: &TickerSymbol,
        expected_current_theme_ids: &[i64],
        allow_stale: bool,
    ) -> anyhow::Result<bool> {
        let symbol = symbol.as_str();
        let now = Utc::now().naive_utc();
        let mut transaction = self
            .pool
            .begin()
            .await
            .context("failed to begin theme audit acceptance")?;
        let audit = sqlx::query_as!(
            StoredAcceptableAudit,
            r#"SELECT current_themes AS "current_themes: String",
                      suggested_themes AS "suggested_themes: String",
                      model,
                      reasoning
               FROM theme_audits
               WHERE symbol = ? AND status = 'pending'"#,
            symbol,
        )
        .fetch_optional(&mut *transaction)
        .await
        .context("failed to load pending theme audit")?;
        let Some(audit) = audit else {
            transaction.rollback().await.ok();
            return Ok(false);
        };
        let current_themes: Vec<ThemeAuditTheme> = serde_json::from_str(&audit.current_themes)
            .context("invalid stored current audit themes")?;
        let suggested_themes: Vec<ThemeAuditTheme> = serde_json::from_str(&audit.suggested_themes)
            .context("invalid stored suggested audit themes")?;
        let mut stored_current_ids = current_themes
            .iter()
            .map(|theme| theme.id)
            .collect::<Vec<_>>();
        stored_current_ids.sort_unstable();
        let mut expected_current_ids = expected_current_theme_ids.to_vec();
        expected_current_ids.sort_unstable();
        if !allow_stale {
            anyhow::ensure!(
                stored_current_ids == expected_current_ids,
                "theme audit is stale"
            );
        }
        let mut actual_current_ids = sqlx::query_scalar!(
            "SELECT theme_id FROM theme_stocks WHERE symbol = ? ORDER BY theme_id",
            symbol,
        )
        .fetch_all(&mut *transaction)
        .await
        .context("failed to verify current theme assignments")?;
        actual_current_ids.sort_unstable();
        anyhow::ensure!(
            actual_current_ids == expected_current_ids,
            "theme audit is stale"
        );

        sqlx::query!("DELETE FROM theme_stocks WHERE symbol = ?", symbol)
            .execute(&mut *transaction)
            .await
            .context("failed to clear audited theme assignments")?;
        for theme in suggested_themes {
            sqlx::query!(
                r#"INSERT INTO theme_stocks (
                       theme_id, symbol, source, reasoning, model, assigned_at
                   ) VALUES (?, ?, 'manual_ai', ?, ?, ?)"#,
                theme.id,
                symbol,
                audit.reasoning,
                audit.model,
                now,
            )
            .execute(&mut *transaction)
            .await
            .context("failed to insert accepted audit assignment")?;
        }
        let updated = sqlx::query!(
            r#"UPDATE theme_audits
               SET status = 'accepted', processed_at = ?
               WHERE symbol = ? AND status = 'pending'"#,
            now,
            symbol,
        )
        .execute(&mut *transaction)
        .await
        .context("failed to mark theme audit accepted")?;
        anyhow::ensure!(
            updated.rows_affected() == 1,
            "theme audit is no longer pending"
        );
        transaction
            .commit()
            .await
            .context("failed to commit theme audit acceptance")?;
        Ok(true)
    }

    pub(crate) async fn ignore_theme_audit(&self, symbol: &TickerSymbol) -> anyhow::Result<bool> {
        let now = Utc::now().naive_utc();
        sqlx::query!(
            r#"UPDATE theme_audits
               SET status = 'ignored', processed_at = ?
               WHERE symbol = ? AND status = 'pending'"#,
            now,
            symbol.as_str(),
        )
        .execute(&self.pool)
        .await
        .context("failed to ignore theme audit")
        .map(|result| result.rows_affected() == 1)
    }
}

fn parse_theme_audit(audit: StoredThemeAudit) -> anyhow::Result<ThemeAudit> {
    Ok(ThemeAudit {
        symbol: TickerSymbol::try_from(audit.symbol)
            .context("invalid stored theme audit symbol")?,
        current_themes: serde_json::from_str(&audit.current_themes)
            .context("invalid stored current audit themes")?,
        suggested_themes: serde_json::from_str(&audit.suggested_themes)
            .context("invalid stored suggested audit themes")?,
        status: match audit.status.as_str() {
            "matched" => ThemeAuditStatus::Matched,
            "pending" => ThemeAuditStatus::Pending,
            "accepted" => ThemeAuditStatus::Accepted,
            "ignored" => ThemeAuditStatus::Ignored,
            _ => anyhow::bail!("invalid stored theme audit status {}", audit.status),
        },
        confidence: audit.confidence,
        reasoning: audit.reasoning,
        model: audit.model,
        audited_at: audit.audited_at.and_utc(),
        processed_at: audit.processed_at.map(|value| value.and_utc()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn insert_ticker(store: &Store, symbol: &str) {
        sqlx::query!(
            "INSERT INTO tickers (symbol, exchange) VALUES (?, 'NASDAQ')",
            symbol,
        )
        .execute(&store.pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn eligible_symbols_optionally_include_manual_assignments() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        for symbol in ["AUTO", "MANUAL", "MANAI", "UNPROCESSED"] {
            insert_ticker(&store, symbol).await;
        }
        let now = Utc::now().naive_utc();
        sqlx::query!(
            "INSERT INTO theme_ai_processed_symbols (symbol, outcome, processed_at) VALUES ('AUTO', 'assigned', ?), ('MANUAL', 'assigned', ?)",
            now,
            now,
        )
        .execute(&store.pool)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO theme_stocks (theme_id, symbol, source, assigned_at) VALUES (1, 'AUTO', 'automatic_ai', ?), (1, 'MANUAL', 'manual', ?), (1, 'MANAI', 'manual_ai', ?)",
            now,
            now,
            now,
        )
        .execute(&store.pool)
        .await
        .unwrap();

        let automatic = store.theme_audit_eligible_symbols(false).await.unwrap();
        assert_eq!(automatic, [TickerSymbol::parse("AUTO").unwrap()]);
        let including_manual = store.theme_audit_eligible_symbols(true).await.unwrap();
        assert_eq!(
            including_manual,
            [
                TickerSymbol::parse("AUTO").unwrap(),
                TickerSymbol::parse("MANAI").unwrap(),
                TickerSymbol::parse("MANUAL").unwrap(),
            ]
        );
    }

    #[tokio::test]
    async fn accepting_audit_replaces_assignments_and_marks_result() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        insert_ticker(&store, "TEST").await;
        let now = Utc::now().naive_utc();
        sqlx::query!(
            "INSERT INTO theme_stocks (theme_id, symbol, source, assigned_at) VALUES (1, 'TEST', 'automatic_ai', ?)",
            now,
        )
        .execute(&store.pool)
        .await
        .unwrap();
        store
            .insert_theme_audits(&[NewThemeAudit {
                symbol: TickerSymbol::parse("TEST").unwrap(),
                current_themes: vec![ThemeAuditTheme {
                    id: 1,
                    name: "Semiconductors".to_owned(),
                }],
                suggested_themes: vec![ThemeAuditTheme {
                    id: 2,
                    name: "Software".to_owned(),
                }],
                status: ThemeAuditStatus::Pending,
                confidence: 0.9,
                reasoning: "Core software business".to_owned(),
                model: "test-model".to_owned(),
                input_fingerprint: "fingerprint".to_owned(),
            }])
            .await
            .unwrap();

        assert!(
            store
                .accept_theme_audit(&TickerSymbol::parse("TEST").unwrap(), &[1], false)
                .await
                .unwrap()
        );
        let assignment =
            sqlx::query!("SELECT theme_id, source, model FROM theme_stocks WHERE symbol = 'TEST'",)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(assignment.theme_id, 2);
        assert_eq!(assignment.source, "manual_ai");
        assert_eq!(assignment.model.as_deref(), Some("test-model"));
        let status = sqlx::query_scalar!("SELECT status FROM theme_audits WHERE symbol = 'TEST'",)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(status, "accepted");
    }

    #[tokio::test]
    async fn confirmed_stale_audit_replaces_changed_assignments() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        insert_ticker(&store, "TEST").await;
        let now = Utc::now().naive_utc();
        sqlx::query!(
            "INSERT INTO theme_stocks (theme_id, symbol, source, assigned_at) VALUES (1, 'TEST', 'automatic_ai', ?)",
            now,
        )
        .execute(&store.pool)
        .await
        .unwrap();
        store
            .insert_theme_audits(&[NewThemeAudit {
                symbol: TickerSymbol::parse("TEST").unwrap(),
                current_themes: vec![ThemeAuditTheme {
                    id: 1,
                    name: "Semiconductors".to_owned(),
                }],
                suggested_themes: vec![ThemeAuditTheme {
                    id: 3,
                    name: "Cybersecurity".to_owned(),
                }],
                status: ThemeAuditStatus::Pending,
                confidence: 0.9,
                reasoning: "Security business".to_owned(),
                model: "test-model".to_owned(),
                input_fingerprint: "fingerprint".to_owned(),
            }])
            .await
            .unwrap();
        sqlx::query!("DELETE FROM theme_stocks WHERE symbol = 'TEST'")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query!(
            "INSERT INTO theme_stocks (theme_id, symbol, source, assigned_at) VALUES (2, 'TEST', 'manual', ?)",
            now,
        )
        .execute(&store.pool)
        .await
        .unwrap();

        assert!(
            store
                .accept_theme_audit(&TickerSymbol::parse("TEST").unwrap(), &[2], false)
                .await
                .is_err()
        );
        assert!(
            store
                .accept_theme_audit(&TickerSymbol::parse("TEST").unwrap(), &[2], true)
                .await
                .unwrap()
        );
        let assignment =
            sqlx::query!("SELECT theme_id, source FROM theme_stocks WHERE symbol = 'TEST'",)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(assignment.theme_id, 3);
        assert_eq!(assignment.source, "manual_ai");
    }
}
