use anyhow::Context;
use sqlx::SqlitePool;
use std::collections::HashSet;

#[derive(Clone)]
pub(crate) struct TradeAnalyzerRepository {
    pool: SqlitePool,
}

#[derive(Clone)]
pub(crate) struct AnalyzerAccountRow {
    pub id: i64,
    pub broker: String,
    pub label: String,
    pub timezone: String,
}

#[derive(Clone)]
pub(crate) struct AnalyzerExecutionRow {
    pub id: i64,
    pub event_key: String,
    pub origin: String,
    pub executed_at_utc: String,
    pub executed_at_local: String,
    pub market_date: String,
    pub symbol: String,
    pub side: String,
    pub position_effect: String,
    pub quantity_micros: i64,
    pub price_micros: i64,
    pub fee_micros: i64,
    pub source_sequence: i64,
}

pub(crate) struct NewAnalyzerExecution {
    pub event_key: String,
    pub origin: String,
    pub executed_at_utc: String,
    pub executed_at_local: String,
    pub market_date: String,
    pub symbol: String,
    pub side: String,
    pub position_effect: String,
    pub quantity_micros: i64,
    pub price_micros: i64,
    pub fee_micros: i64,
    pub source_sequence: i64,
    pub raw_json: String,
}

pub(crate) struct AnalyzerExecutionEdit {
    pub id: Option<i64>,
    pub event_key: String,
    pub executed_at_utc: String,
    pub executed_at_local: String,
    pub market_date: String,
    pub symbol: String,
    pub side: String,
    pub position_effect: String,
    pub quantity_micros: i64,
    pub price_micros: i64,
    pub fee_micros: i64,
    pub source_sequence: i64,
}

pub(crate) struct AnalyzerTradeExecutionReplacement<'a> {
    pub trade_id: i64,
    pub expected_revision: i64,
    pub account_id: i64,
    pub existing_ids: &'a HashSet<i64>,
    pub executions: &'a [AnalyzerExecutionEdit],
    pub initial_stop: Option<i64>,
    pub active_stop: Option<i64>,
}

pub(crate) struct NewAnalyzerImport<'a> {
    pub account_id: i64,
    pub broker: &'a str,
    pub hash: &'a str,
    pub filename: &'a str,
    pub range_start: &'a str,
    pub range_end: &'a str,
    pub executions: &'a [NewAnalyzerExecution],
    pub stops: &'a [NewAnalyzerStop],
}

#[derive(Clone)]
pub(crate) struct NewAnalyzerStop {
    pub event_key: String,
    pub trade_opened_at_utc: String,
    pub placed_at_utc: String,
    pub placed_at_local: String,
    pub market_date: String,
    pub symbol: String,
    pub quantity_micros: i64,
    pub price_micros: i64,
    pub kind: String,
}

#[derive(Clone)]
pub(crate) struct AnalyzerStopRow {
    pub id: i64,
    pub trade_opened_at_utc: String,
    pub placed_at_utc: String,
    pub market_date: String,
    pub symbol: String,
    pub price_micros: i64,
    pub kind: String,
}

pub(crate) struct NewAnalyzerTrade {
    pub lifecycle_key: String,
    pub account_id: i64,
    pub symbol: String,
    pub direction: String,
    pub position_status: String,
    pub history_quality: String,
    pub opened_at: Option<String>,
    pub opened_at_local: Option<String>,
    pub opening_month: String,
    pub closed_at: Option<String>,
    pub quantity_micros: i64,
    pub remaining_quantity_micros: i64,
    pub average_entry_micros: Option<i64>,
    pub average_exit_micros: Option<i64>,
    pub initial_stop_micros: Option<i64>,
    pub active_stop_micros: Option<i64>,
    pub realized_pnl_micros: Option<i64>,
    pub fees_micros: i64,
    pub execution_ids_json: String,
}

#[derive(Clone)]
pub(crate) struct AnalyzerTradeRow {
    pub id: i64,
    pub lifecycle_key: String,
    pub account_id: i64,
    pub symbol: String,
    pub direction: String,
    pub position_status: String,
    pub history_quality: String,
    pub opened_at: Option<String>,
    pub opened_at_local: Option<String>,
    pub opening_month: String,
    pub closed_at: Option<String>,
    pub quantity_micros: i64,
    pub remaining_quantity_micros: i64,
    pub average_entry_micros: Option<i64>,
    pub average_exit_micros: Option<i64>,
    pub initial_stop_micros: Option<i64>,
    pub active_stop_micros: Option<i64>,
    pub realized_pnl_micros: Option<i64>,
    pub execution_ids_json: String,
    pub revision: i64,
}

pub(crate) struct AnalyzerTradeOverride {
    pub trade_id: i64,
    pub expected_revision: i64,
    pub quantity: Option<i64>,
    pub price: Option<i64>,
    pub initial_stop: Option<i64>,
    pub active_stop: Option<i64>,
}

#[derive(Clone)]
pub(crate) struct AnalyzerJournalEntryRow {
    pub trade_id: i64,
    pub comment: String,
    pub strategy: String,
    pub edges: String,
    pub lessons: String,
    pub mistakes: String,
    pub rating: Option<i64>,
}

#[derive(Clone)]
pub(crate) struct AnalyzerTagRow {
    pub id: i64,
    pub name: String,
}

#[derive(Clone)]
pub(crate) struct AnalyzerTradeTagRow {
    pub trade_id: i64,
    pub id: i64,
    pub name: String,
}

impl TradeAnalyzerRepository {
    pub(super) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn revision(&self) -> anyhow::Result<i64> {
        sqlx::query_scalar!("SELECT data_revision FROM trade_analyzer_state WHERE singleton = 1")
            .fetch_one(&self.pool)
            .await
            .context("failed to load trade analyzer revision")
    }

    pub async fn accounts(&self) -> anyhow::Result<Vec<AnalyzerAccountRow>> {
        sqlx::query_as!(
            AnalyzerAccountRow,
            "SELECT id, broker, label, timezone FROM trade_accounts ORDER BY id"
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load trade accounts")
    }

    pub async fn account(&self, id: i64) -> anyhow::Result<Option<AnalyzerAccountRow>> {
        sqlx::query_as!(
            AnalyzerAccountRow,
            "SELECT id, broker, label, timezone FROM trade_accounts WHERE id = ?",
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to load trade account")
    }

    pub async fn ensure_account(
        &self,
        broker: &str,
        key: &str,
        label: &str,
        timezone: &str,
    ) -> anyhow::Result<i64> {
        sqlx::query!(
            "INSERT INTO trade_accounts (broker, external_key, label, timezone) VALUES (?, ?, ?, ?) ON CONFLICT (broker, external_key) DO UPDATE SET label = excluded.label, timezone = excluded.timezone",
            broker,
            key,
            label,
            timezone,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query_scalar!(
            "SELECT id FROM trade_accounts WHERE broker = ? AND external_key = ?",
            broker,
            key,
        )
        .fetch_one(&self.pool)
        .await
        .context("failed to resolve trade account")
    }

    pub async fn account_id(&self, broker: &str, key: &str) -> anyhow::Result<Option<i64>> {
        sqlx::query_scalar!(
            "SELECT id FROM trade_accounts WHERE broker = ? AND external_key = ?",
            broker,
            key,
        )
        .fetch_optional(&self.pool)
        .await
        .context("failed to resolve trade account")
    }

    pub async fn pending_rebuild_accounts(&self) -> anyhow::Result<Vec<i64>> {
        Ok(
            sqlx::query_scalar!(
                "SELECT id FROM trade_accounts WHERE needs_rebuild = 1 ORDER BY id",
            )
            .fetch_all(&self.pool)
            .await?,
        )
    }

    pub async fn event_keys(
        &self,
        account_id: Option<i64>,
        keys: &[String],
    ) -> anyhow::Result<HashSet<String>> {
        if keys.is_empty() {
            return Ok(HashSet::new());
        }
        let Some(account_id) = account_id else {
            return Ok(HashSet::new());
        };
        let requested = keys.iter().map(String::as_str).collect::<HashSet<_>>();
        Ok(sqlx::query_scalar!(
            "SELECT event_key FROM trade_executions WHERE account_id = ?",
            account_id,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .filter(|key| requested.contains(key.as_str()))
        .collect())
    }

    pub async fn stop_event_keys(
        &self,
        account_id: Option<i64>,
        keys: &[String],
    ) -> anyhow::Result<HashSet<String>> {
        if keys.is_empty() {
            return Ok(HashSet::new());
        }
        let Some(account_id) = account_id else {
            return Ok(HashSet::new());
        };
        let requested = keys.iter().map(String::as_str).collect::<HashSet<_>>();
        Ok(sqlx::query_scalar!(
            "SELECT event_key FROM trade_risk_stops WHERE account_id = ?",
            account_id,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .filter(|key| requested.contains(key.as_str()))
        .collect())
    }

    pub async fn executions(&self, account_id: i64) -> anyhow::Result<Vec<AnalyzerExecutionRow>> {
        sqlx::query_as!(
            AnalyzerExecutionRow,
            r#"SELECT id, event_key, origin,
                      executed_at_utc AS "executed_at_utc!: String",
                      executed_at_local, market_date AS "market_date!: String",
                      symbol, side, position_effect, quantity_micros, price_micros,
                      fee_micros, source_sequence
               FROM trade_executions
               WHERE account_id = ?
               ORDER BY executed_at_utc, source_sequence, id"#,
            account_id,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load trade executions")
    }

    pub async fn apply_import(&self, import: NewAnalyzerImport<'_>) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query!(
            "INSERT OR IGNORE INTO trade_imports (account_id, broker_adapter, file_hash, file_name, range_start, range_end) VALUES (?, ?, ?, ?, ?, ?)",
            import.account_id,
            import.broker,
            import.hash,
            import.filename,
            import.range_start,
            import.range_end,
        )
        .execute(&mut *tx)
        .await?;
        let import_id = sqlx::query_scalar!(
            "SELECT id FROM trade_imports WHERE file_hash = ?",
            import.hash,
        )
        .fetch_one(&mut *tx)
        .await?;
        for e in import.executions {
            sqlx::query!(
                "INSERT OR IGNORE INTO trade_executions (account_id, import_id, event_key, origin, executed_at_utc, executed_at_local, market_date, symbol, side, position_effect, quantity_micros, price_micros, fee_micros, source_sequence, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                import.account_id,
                import_id,
                e.event_key,
                e.origin,
                e.executed_at_utc,
                e.executed_at_local,
                e.market_date,
                e.symbol,
                e.side,
                e.position_effect,
                e.quantity_micros,
                e.price_micros,
                e.fee_micros,
                e.source_sequence,
                e.raw_json,
            )
            .execute(&mut *tx)
            .await?;
        }
        for stop in import.stops {
            sqlx::query!(
                "INSERT OR IGNORE INTO trade_risk_stops (account_id, import_id, event_key, trade_opened_at_utc, placed_at_utc, placed_at_local, market_date, symbol, quantity_micros, price_micros, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                import.account_id,
                import_id,
                stop.event_key,
                stop.trade_opened_at_utc,
                stop.placed_at_utc,
                stop.placed_at_local,
                stop.market_date,
                stop.symbol,
                stop.quantity_micros,
                stop.price_micros,
                stop.kind,
            )
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query!(
            "UPDATE trade_analyzer_state SET data_revision = data_revision + 1 WHERE singleton = 1",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query!(
            "UPDATE trade_accounts SET needs_rebuild = 1 WHERE id = ?",
            import.account_id,
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn stops(&self, account_id: i64) -> anyhow::Result<Vec<AnalyzerStopRow>> {
        sqlx::query_as!(
            AnalyzerStopRow,
            r#"SELECT id, trade_opened_at_utc AS "trade_opened_at_utc!: String",
                      placed_at_utc AS "placed_at_utc!: String",
                      market_date AS "market_date!: String", symbol,
                      price_micros, kind
               FROM trade_risk_stops
               WHERE account_id = ?
               ORDER BY placed_at_utc, id"#,
            account_id,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load trade stops")
    }

    pub async fn latest_mark(&self, symbol: &str) -> anyhow::Result<Option<(String, f64)>> {
        let row = sqlx::query!(
            r#"SELECT market_date AS "market_date!: String", close
               FROM daily_candles
               WHERE symbol = ?
               ORDER BY market_date DESC
               LIMIT 1"#,
            symbol,
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| (row.market_date, row.close)))
    }

    pub async fn insert_manual_execution(
        &self,
        account_id: i64,
        e: &NewAnalyzerExecution,
        stops: &[NewAnalyzerStop],
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query!(
            "INSERT INTO trade_executions (account_id, event_key, origin, executed_at_utc, executed_at_local, market_date, symbol, side, position_effect, quantity_micros, price_micros, fee_micros, source_sequence, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            account_id,
            e.event_key,
            e.origin,
            e.executed_at_utc,
            e.executed_at_local,
            e.market_date,
            e.symbol,
            e.side,
            e.position_effect,
            e.quantity_micros,
            e.price_micros,
            e.fee_micros,
            e.source_sequence,
            e.raw_json,
        )
        .execute(&mut *tx)
        .await?;
        for stop in stops {
            sqlx::query!(
                "INSERT INTO trade_risk_stops (account_id, event_key, trade_opened_at_utc, placed_at_utc, placed_at_local, market_date, symbol, quantity_micros, price_micros, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                account_id,
                stop.event_key,
                stop.trade_opened_at_utc,
                stop.placed_at_utc,
                stop.placed_at_local,
                stop.market_date,
                stop.symbol,
                stop.quantity_micros,
                stop.price_micros,
                stop.kind,
            )
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query!(
            "UPDATE trade_analyzer_state SET data_revision = data_revision + 1 WHERE singleton = 1",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query!(
            "UPDATE trade_accounts SET needs_rebuild = 1 WHERE id = ?",
            account_id,
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn replace_trades(
        &self,
        account_id: i64,
        trades: &[NewAnalyzerTrade],
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        let mut keys = Vec::new();
        for t in trades {
            keys.push(t.lifecycle_key.clone());
            sqlx::query!(
                r#"INSERT INTO analyzer_trades (
                       lifecycle_key, account_id, symbol, direction, position_status,
                       history_quality, opened_at, opened_at_local, opening_month,
                       closed_at, quantity_micros, remaining_quantity_micros,
                       average_entry_micros, average_exit_micros, initial_stop_micros,
                       active_stop_micros, realized_pnl_micros, fees_micros, execution_ids_json
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (lifecycle_key) DO UPDATE SET
                       symbol = excluded.symbol,
                       direction = excluded.direction,
                       position_status = excluded.position_status,
                       history_quality = excluded.history_quality,
                       opened_at = excluded.opened_at,
                       opened_at_local = excluded.opened_at_local,
                       opening_month = excluded.opening_month,
                       closed_at = excluded.closed_at,
                       quantity_micros = excluded.quantity_micros,
                       remaining_quantity_micros = excluded.remaining_quantity_micros,
                       average_entry_micros = excluded.average_entry_micros,
                       average_exit_micros = excluded.average_exit_micros,
                       initial_stop_micros = excluded.initial_stop_micros,
                       active_stop_micros = excluded.active_stop_micros,
                       realized_pnl_micros = excluded.realized_pnl_micros,
                       fees_micros = excluded.fees_micros,
                       execution_ids_json = excluded.execution_ids_json,
                       revision = analyzer_trades.revision + 1,
                       updated_at = CURRENT_TIMESTAMP"#,
                t.lifecycle_key,
                t.account_id,
                t.symbol,
                t.direction,
                t.position_status,
                t.history_quality,
                t.opened_at,
                t.opened_at_local,
                t.opening_month,
                t.closed_at,
                t.quantity_micros,
                t.remaining_quantity_micros,
                t.average_entry_micros,
                t.average_exit_micros,
                t.initial_stop_micros,
                t.active_stop_micros,
                t.realized_pnl_micros,
                t.fees_micros,
                t.execution_ids_json,
            )
            .execute(&mut *tx)
            .await?;
            sqlx::query!(
                r#"UPDATE analyzer_trades SET
                       remaining_quantity_micros = MAX(COALESCE((SELECT quantity_micros FROM trade_overrides WHERE trade_id = analyzer_trades.id), quantity_micros) - (quantity_micros - remaining_quantity_micros), 0),
                       position_status = CASE WHEN COALESCE((SELECT quantity_micros FROM trade_overrides WHERE trade_id = analyzer_trades.id), quantity_micros) <= quantity_micros - remaining_quantity_micros THEN 'closed' ELSE 'open' END,
                       closed_at = CASE WHEN COALESCE((SELECT quantity_micros FROM trade_overrides WHERE trade_id = analyzer_trades.id), quantity_micros) <= quantity_micros - remaining_quantity_micros THEN closed_at ELSE NULL END,
                       realized_pnl_micros = CASE
                           WHEN average_exit_micros IS NULL THEN -fees_micros
                           ELSE ((average_exit_micros - COALESCE((SELECT average_entry_micros FROM trade_overrides WHERE trade_id = analyzer_trades.id), average_entry_micros)) * (quantity_micros - remaining_quantity_micros) * CASE direction WHEN 'long' THEN 1 ELSE -1 END) / 1000000 - fees_micros
                       END,
                       quantity_micros = COALESCE((SELECT quantity_micros FROM trade_overrides WHERE trade_id = analyzer_trades.id), quantity_micros),
                       average_entry_micros = COALESCE((SELECT average_entry_micros FROM trade_overrides WHERE trade_id = analyzer_trades.id), average_entry_micros),
                       initial_stop_micros = CASE
                           WHEN (SELECT initial_stop_micros FROM trade_overrides WHERE trade_id = analyzer_trades.id) = 0 THEN NULL
                           ELSE COALESCE((SELECT initial_stop_micros FROM trade_overrides WHERE trade_id = analyzer_trades.id), initial_stop_micros)
                       END,
                       active_stop_micros = CASE
                           WHEN COALESCE((SELECT quantity_micros FROM trade_overrides WHERE trade_id = analyzer_trades.id), quantity_micros) <= quantity_micros - remaining_quantity_micros THEN NULL
                           WHEN (SELECT active_stop_micros FROM trade_overrides WHERE trade_id = analyzer_trades.id) = 0 THEN NULL
                           ELSE COALESCE((SELECT active_stop_micros FROM trade_overrides WHERE trade_id = analyzer_trades.id), active_stop_micros)
                       END
                   WHERE lifecycle_key = ?"#,
                t.lifecycle_key,
            )
            .execute(&mut *tx)
            .await?;
        }
        let existing = sqlx::query!(
            "SELECT id, lifecycle_key FROM analyzer_trades WHERE account_id = ?",
            account_id,
        )
        .fetch_all(&mut *tx)
        .await?;
        for row in existing {
            if !keys.contains(&row.lifecycle_key) {
                sqlx::query!("DELETE FROM analyzer_trades WHERE id = ?", row.id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        sqlx::query!(
            "UPDATE trade_accounts SET needs_rebuild = 0 WHERE id = ?",
            account_id,
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn trades(&self) -> anyhow::Result<Vec<AnalyzerTradeRow>> {
        sqlx::query_as!(
            AnalyzerTradeRow,
            r#"SELECT id, lifecycle_key, account_id, symbol, direction,
                      position_status, history_quality,
                      opened_at AS "opened_at?: String", opened_at_local,
                      opening_month, closed_at AS "closed_at?: String",
                      quantity_micros, remaining_quantity_micros,
                      average_entry_micros, average_exit_micros,
                      initial_stop_micros, active_stop_micros, realized_pnl_micros,
                      execution_ids_json, revision
               FROM analyzer_trades
               ORDER BY opening_month DESC, opened_at DESC, id DESC"#,
        )
        .fetch_all(&self.pool)
        .await
        .context("failed to load analyzer trades")
    }

    pub async fn journals(&self) -> anyhow::Result<Vec<AnalyzerJournalEntryRow>> {
        Ok(sqlx::query_as!(
            AnalyzerJournalEntryRow,
            "SELECT trade_id, comment, strategy, edges, lessons, mistakes, rating FROM trade_journals",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn tags(&self) -> anyhow::Result<Vec<AnalyzerTagRow>> {
        Ok(sqlx::query_as!(
            AnalyzerTagRow,
            "SELECT id, name FROM trade_tags ORDER BY name COLLATE NOCASE",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn trade_tags_all(&self) -> anyhow::Result<Vec<AnalyzerTradeTagRow>> {
        Ok(sqlx::query_as!(
            AnalyzerTradeTagRow,
            "SELECT a.trade_id, t.id, t.name FROM trade_tags t JOIN trade_tag_assignments a ON a.tag_id = t.id ORDER BY t.name COLLATE NOCASE",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn save_journal(
        &self,
        trade_id: i64,
        expected_revision: i64,
        comment: &str,
        tag_ids: &[i64],
        tag_names: &[String],
    ) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        let changed = sqlx::query!(
            "UPDATE analyzer_trades SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND revision = ?",
            trade_id,
            expected_revision,
        )
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if changed == 0 {
            tx.rollback().await?;
            return Ok(false);
        }
        sqlx::query!(
            "INSERT INTO trade_journals (trade_id, comment) VALUES (?, ?) ON CONFLICT(trade_id) DO UPDATE SET comment = excluded.comment",
            trade_id,
            comment,
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query!(
            "DELETE FROM trade_tag_assignments WHERE trade_id = ?",
            trade_id,
        )
        .execute(&mut *tx)
        .await?;
        let mut all_tag_ids = tag_ids.to_vec();
        for name in tag_names {
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            sqlx::query!("INSERT OR IGNORE INTO trade_tags (name) VALUES (?)", name)
                .execute(&mut *tx)
                .await?;
            let id = sqlx::query_scalar!(
                "SELECT id FROM trade_tags WHERE name = ? COLLATE NOCASE",
                name,
            )
            .fetch_one(&mut *tx)
            .await?;
            all_tag_ids.push(id);
        }
        all_tag_ids.sort_unstable();
        all_tag_ids.dedup();
        for tag_id in all_tag_ids {
            sqlx::query!(
                "INSERT INTO trade_tag_assignments (trade_id, tag_id) VALUES (?, ?)",
                trade_id,
                tag_id,
            )
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(true)
    }

    pub async fn set_trade_override(
        &self,
        trade: AnalyzerTradeOverride,
        close: Option<&NewAnalyzerExecution>,
    ) -> anyhow::Result<bool> {
        let mut tx = self.pool.begin().await?;
        let changed = sqlx::query!(
            r#"UPDATE analyzer_trades SET
                   quantity_micros = COALESCE(?, quantity_micros),
                   average_entry_micros = COALESCE(?, average_entry_micros),
                   initial_stop_micros = CASE WHEN ? = 0 THEN NULL ELSE COALESCE(?, initial_stop_micros) END,
                   active_stop_micros = CASE WHEN ? = 0 THEN NULL ELSE COALESCE(?, active_stop_micros) END,
                   revision = revision + 1,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND revision = ?"#,
            trade.quantity,
            trade.price,
            trade.initial_stop,
            trade.initial_stop,
            trade.active_stop,
            trade.active_stop,
            trade.trade_id,
            trade.expected_revision,
        )
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if changed == 0 {
            tx.rollback().await?;
            return Ok(false);
        }
        sqlx::query!(
            r#"INSERT INTO trade_overrides (
                   trade_id, quantity_micros, average_entry_micros,
                   initial_stop_micros, active_stop_micros
               ) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(trade_id) DO UPDATE SET
                   quantity_micros = COALESCE(excluded.quantity_micros, trade_overrides.quantity_micros),
                   average_entry_micros = COALESCE(excluded.average_entry_micros, trade_overrides.average_entry_micros),
                   initial_stop_micros = COALESCE(excluded.initial_stop_micros, trade_overrides.initial_stop_micros),
                   active_stop_micros = COALESCE(excluded.active_stop_micros, trade_overrides.active_stop_micros),
                   updated_at = CURRENT_TIMESTAMP"#,
            trade.trade_id,
            trade.quantity,
            trade.price,
            trade.initial_stop,
            trade.active_stop,
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query!(
            "UPDATE trade_analyzer_state SET data_revision = data_revision + 1 WHERE singleton = 1",
        )
        .execute(&mut *tx)
        .await?;
        let account_id = sqlx::query_scalar!(
            "SELECT account_id FROM analyzer_trades WHERE id = ?",
            trade.trade_id,
        )
        .fetch_one(&mut *tx)
        .await?;
        if let Some(close) = close {
            sqlx::query!(
                "INSERT INTO trade_executions (account_id, event_key, origin, executed_at_utc, executed_at_local, market_date, symbol, side, position_effect, quantity_micros, price_micros, fee_micros, source_sequence, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                account_id,
                close.event_key,
                close.origin,
                close.executed_at_utc,
                close.executed_at_local,
                close.market_date,
                close.symbol,
                close.side,
                close.position_effect,
                close.quantity_micros,
                close.price_micros,
                close.fee_micros,
                close.source_sequence,
                close.raw_json,
            )
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query!(
            "UPDATE trade_accounts SET needs_rebuild = 1 WHERE id = ?",
            account_id,
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn replace_trade_executions(
        &self,
        replacement: AnalyzerTradeExecutionReplacement<'_>,
    ) -> anyhow::Result<bool> {
        let AnalyzerTradeExecutionReplacement {
            trade_id,
            expected_revision,
            account_id,
            existing_ids,
            executions,
            initial_stop,
            active_stop,
        } = replacement;
        let mut tx = self.pool.begin().await?;
        let matches = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM analyzer_trades WHERE id = ? AND account_id = ? AND revision = ?",
            trade_id,
            account_id,
            expected_revision,
        )
        .fetch_one(&mut *tx)
        .await?;
        if matches == 0 {
            tx.rollback().await?;
            return Ok(false);
        }

        let retained_ids = executions
            .iter()
            .filter_map(|execution| execution.id)
            .collect::<HashSet<_>>();
        for id in existing_ids.difference(&retained_ids) {
            sqlx::query!(
                "DELETE FROM trade_executions WHERE id = ? AND account_id = ? AND origin = 'manual'",
                id,
                account_id,
            )
            .execute(&mut *tx)
            .await?;
        }
        for execution in executions {
            if let Some(id) = execution.id {
                let changed = sqlx::query!(
                    r#"UPDATE trade_executions SET
                           executed_at_utc = ?, executed_at_local = ?, market_date = ?,
                           side = ?, position_effect = ?, quantity_micros = ?,
                           price_micros = ?, fee_micros = ?, source_sequence = ?
                       WHERE id = ? AND account_id = ?"#,
                    execution.executed_at_utc,
                    execution.executed_at_local,
                    execution.market_date,
                    execution.side,
                    execution.position_effect,
                    execution.quantity_micros,
                    execution.price_micros,
                    execution.fee_micros,
                    execution.source_sequence,
                    id,
                    account_id,
                )
                .execute(&mut *tx)
                .await?
                .rows_affected();
                if changed == 0 {
                    tx.rollback().await?;
                    return Ok(false);
                }
            } else {
                sqlx::query!(
                    r#"INSERT INTO trade_executions (
                           account_id, event_key, origin, executed_at_utc, executed_at_local,
                           market_date, symbol, side, position_effect, quantity_micros,
                           price_micros, fee_micros, source_sequence, raw_json
                       ) VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')"#,
                    account_id,
                    execution.event_key,
                    execution.executed_at_utc,
                    execution.executed_at_local,
                    execution.market_date,
                    execution.symbol,
                    execution.side,
                    execution.position_effect,
                    execution.quantity_micros,
                    execution.price_micros,
                    execution.fee_micros,
                    execution.source_sequence,
                )
                .execute(&mut *tx)
                .await?;
            }
        }
        let initial_stop_override = initial_stop.unwrap_or(0);
        let active_stop_override = active_stop.unwrap_or(0);
        sqlx::query!(
            r#"INSERT INTO trade_overrides (
                   trade_id, quantity_micros, average_entry_micros,
                   initial_stop_micros, active_stop_micros
               ) VALUES (?, NULL, NULL, ?, ?)
               ON CONFLICT(trade_id) DO UPDATE SET
                   quantity_micros = NULL,
                   average_entry_micros = NULL,
                   initial_stop_micros = excluded.initial_stop_micros,
                   active_stop_micros = excluded.active_stop_micros,
                   updated_at = CURRENT_TIMESTAMP"#,
            trade_id,
            initial_stop_override,
            active_stop_override,
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query!(
            "UPDATE trade_analyzer_state SET data_revision = data_revision + 1 WHERE singleton = 1",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query!(
            "UPDATE trade_accounts SET needs_rebuild = 1 WHERE id = ?",
            account_id,
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn delete_trade(
        &self,
        trade_id: i64,
        expected_revision: i64,
    ) -> anyhow::Result<Option<i64>> {
        let mut tx = self.pool.begin().await?;
        let Some(trade) = sqlx::query!(
            r#"SELECT account_id, symbol,
                      opened_at AS "opened_at?: String", execution_ids_json
               FROM analyzer_trades WHERE id = ? AND revision = ?"#,
            trade_id,
            expected_revision,
        )
        .fetch_optional(&mut *tx)
        .await?
        else {
            tx.rollback().await?;
            return Ok(None);
        };
        let execution_ids = serde_json::from_str::<Vec<i64>>(&trade.execution_ids_json)
            .context("trade execution list is invalid")?;

        sqlx::query!("DELETE FROM analyzer_trades WHERE id = ?", trade_id)
            .execute(&mut *tx)
            .await?;
        for execution_id in execution_ids {
            sqlx::query!(
                "DELETE FROM trade_executions WHERE id = ? AND account_id = ?",
                execution_id,
                trade.account_id,
            )
            .execute(&mut *tx)
            .await?;
        }
        if let Some(opened_at) = trade.opened_at {
            sqlx::query!(
                "DELETE FROM trade_risk_stops WHERE account_id = ? AND symbol = ? AND trade_opened_at_utc = ?",
                trade.account_id,
                trade.symbol,
                opened_at,
            )
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query!(
            "UPDATE trade_analyzer_state SET data_revision = data_revision + 1 WHERE singleton = 1",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query!(
            "UPDATE trade_accounts SET needs_rebuild = 1 WHERE id = ?",
            trade.account_id,
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(trade.account_id))
    }
}
