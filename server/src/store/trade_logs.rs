use super::Store;
use crate::models::trade_logs::{
    Direction, ExecutionInput, ExecutionValue, Side, TradeInput, ValidatedTrade, decimal,
};
use chrono::{DateTime, SecondsFormat, Utc};
use market_types::TickerSymbol;
use std::collections::{HashMap, HashSet};

#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    #[error("Trade or tag no longer exists")]
    NotFound,
    #[error("This record changed in another tab. Reload the saved version before editing again")]
    Conflict,
    #[error("{0}")]
    Validation(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

pub struct StoredTrade {
    pub id: i64,
    pub revision: i64,
    pub trade: ValidatedTrade,
}
pub struct StoredTag {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub revision: i64,
}
pub struct Snapshot {
    pub trades: Vec<StoredTrade>,
    pub tags: Vec<StoredTag>,
}

impl Store {
    pub async fn trade_logs_snapshot(&self) -> Result<Snapshot, sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query!(
            "SELECT id, symbol, direction, notes, revision FROM trade_logs ORDER BY id DESC"
        )
        .fetch_all(&mut *tx)
        .await?;
        let legs = sqlx::query!("SELECT id, trade_id, executed_at, side, quantity, price, fee, notes FROM trade_log_executions ORDER BY trade_id, sequence").fetch_all(&mut *tx).await?;
        let links =
            sqlx::query!("SELECT trade_id, tag_id FROM trade_log_tag_links ORDER BY tag_id")
                .fetch_all(&mut *tx)
                .await?;
        let leg_links = sqlx::query!(
            "SELECT execution_id, tag_id FROM trade_log_execution_tags ORDER BY tag_id"
        )
        .fetch_all(&mut *tx)
        .await?;
        let tags = sqlx::query!(
            "SELECT id, name, description, revision FROM trade_log_tags ORDER BY name COLLATE NOCASE, id"
        )
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        let mut trade_tags: HashMap<i64, Vec<i64>> = HashMap::new();
        for link in links {
            trade_tags
                .entry(link.trade_id)
                .or_default()
                .push(link.tag_id);
        }
        let mut execution_tags: HashMap<i64, Vec<i64>> = HashMap::new();
        for link in leg_links {
            execution_tags
                .entry(link.execution_id)
                .or_default()
                .push(link.tag_id);
        }
        let mut executions: HashMap<i64, Vec<ExecutionValue>> = HashMap::new();
        for leg in legs {
            let executed_at = DateTime::parse_from_rfc3339(&leg.executed_at)
                .map_err(|e| sqlx::Error::Decode(Box::new(e)))?
                .with_timezone(&Utc);
            let side = match leg.side.as_str() {
                "buy" => Side::Buy,
                "sell" => Side::Sell,
                _ => return Err(sqlx::Error::Decode("Invalid stored execution side".into())),
            };
            executions
                .entry(leg.trade_id)
                .or_default()
                .push(ExecutionValue {
                    input: ExecutionInput {
                        id: Some(leg.id),
                        executed_at,
                        side,
                        quantity: decimal(leg.quantity),
                        price: decimal(leg.price),
                        fee: decimal(leg.fee),
                        notes: leg.notes,
                        tag_ids: execution_tags.remove(&leg.id).unwrap_or_default(),
                    },
                    quantity: leg.quantity,
                    price: leg.price,
                    fee: leg.fee,
                });
        }
        let trades = rows
            .into_iter()
            .map(|row| {
                let executions = executions.remove(&row.id).unwrap_or_default();
                Ok(StoredTrade {
                    id: row.id,
                    revision: row.revision,
                    trade: ValidatedTrade {
                        input: TradeInput {
                            revision: Some(row.revision),
                            symbol: TickerSymbol::parse(row.symbol)
                                .map_err(|e| sqlx::Error::Decode(Box::new(e)))?,
                            direction: match row.direction.as_str() {
                                "long" => Direction::Long,
                                "short" => Direction::Short,
                                _ => {
                                    return Err(sqlx::Error::Decode(
                                        "Invalid stored trade direction".into(),
                                    ));
                                }
                            },
                            notes: row.notes,
                            tag_ids: trade_tags.remove(&row.id).unwrap_or_default(),
                            executions: executions.iter().map(|leg| leg.input.clone()).collect(),
                        },
                        executions,
                    },
                })
            })
            .collect::<Result<_, sqlx::Error>>()?;
        Ok(Snapshot {
            trades,
            tags: tags
                .into_iter()
                .map(|row| StoredTag {
                    id: row.id,
                    name: row.name,
                    description: row.description,
                    revision: row.revision,
                })
                .collect(),
        })
    }

    pub async fn save_trade_log(
        &self,
        id: Option<i64>,
        trade: &ValidatedTrade,
    ) -> Result<i64, WriteError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let symbol = trade.input.symbol.as_str();
        let direction = trade.input.direction.as_str();
        let notes = &trade.input.notes;
        let id = if let Some(id) = id {
            let Some(revision) = trade.input.revision else {
                tx.rollback().await?;
                return Err(WriteError::Validation("A revision is required".into()));
            };
            let result = sqlx::query!("UPDATE trade_logs SET symbol = ?, direction = ?, notes = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND revision = ?", symbol, direction, notes, id, revision).execute(&mut *tx).await?;
            if result.rows_affected() == 0 {
                let exists = sqlx::query_scalar!("SELECT id FROM trade_logs WHERE id = ?", id)
                    .fetch_optional(&mut *tx)
                    .await?;
                tx.rollback().await?;
                return Err(if exists.is_some() {
                    WriteError::Conflict
                } else {
                    WriteError::NotFound
                });
            }
            let existing: HashSet<i64> =
                sqlx::query_scalar!("SELECT id FROM trade_log_executions WHERE trade_id = ?", id)
                    .fetch_all(&mut *tx)
                    .await?
                    .into_iter()
                    .collect();
            if trade
                .executions
                .iter()
                .filter_map(|leg| leg.input.id)
                .any(|id| !existing.contains(&id))
            {
                tx.rollback().await?;
                return Err(WriteError::Validation(
                    "An execution does not belong to this trade".into(),
                ));
            }
            id
        } else {
            if trade.executions.iter().any(|leg| leg.input.id.is_some()) {
                tx.rollback().await?;
                return Err(WriteError::Validation(
                    "New trades cannot reuse existing executions".into(),
                ));
            }
            sqlx::query!(
                "INSERT INTO trade_logs (symbol, direction, notes) VALUES (?, ?, ?)",
                symbol,
                direction,
                notes
            )
            .execute(&mut *tx)
            .await?
            .last_insert_rowid()
        };
        let tag_ids: HashSet<i64> = trade
            .input
            .tag_ids
            .iter()
            .copied()
            .chain(
                trade
                    .executions
                    .iter()
                    .flat_map(|leg| leg.input.tag_ids.iter().copied()),
            )
            .collect();
        let tag_json = serde_json::to_string(&tag_ids).expect("tag IDs serialize");
        let known = sqlx::query_scalar!(
            "SELECT id FROM trade_log_tags WHERE id IN (SELECT value FROM json_each(?))",
            tag_json
        )
        .fetch_all(&mut *tx)
        .await?;
        if known.len() != tag_ids.len() {
            tx.rollback().await?;
            return Err(WriteError::Validation(
                "A selected tag was deleted. Refresh the tag library and remove it from the draft"
                    .into(),
            ));
        }
        sqlx::query!("DELETE FROM trade_log_tag_links WHERE trade_id = ?", id)
            .execute(&mut *tx)
            .await?;
        sqlx::query!("DELETE FROM trade_log_executions WHERE trade_id = ?", id)
            .execute(&mut *tx)
            .await?;
        for tag in &trade.input.tag_ids {
            sqlx::query!(
                "INSERT INTO trade_log_tag_links (trade_id, tag_id) VALUES (?, ?)",
                id,
                tag
            )
            .execute(&mut *tx)
            .await?;
        }
        for (sequence, leg) in trade.executions.iter().enumerate() {
            let sequence = sequence as i64;
            let execution_id = leg.input.id;
            let at = leg
                .input
                .executed_at
                .to_rfc3339_opts(SecondsFormat::Millis, true);
            let side = leg.input.side.as_str();
            let notes = &leg.input.notes;
            let result = sqlx::query!("INSERT INTO trade_log_executions (id, trade_id, sequence, executed_at, side, quantity, price, fee, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", execution_id, id, sequence, at, side, leg.quantity, leg.price, leg.fee, notes).execute(&mut *tx).await?;
            let execution_id = result.last_insert_rowid();
            for tag in &leg.input.tag_ids {
                sqlx::query!(
                    "INSERT INTO trade_log_execution_tags (execution_id, tag_id) VALUES (?, ?)",
                    execution_id,
                    tag
                )
                .execute(&mut *tx)
                .await?;
            }
        }
        tx.commit().await?;
        Ok(id)
    }

    pub async fn delete_trade_log(&self, id: i64, revision: i64) -> Result<(), WriteError> {
        let result = sqlx::query!(
            "DELETE FROM trade_logs WHERE id = ? AND revision = ?",
            id,
            revision
        )
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(WriteError::Conflict);
        }
        Ok(())
    }

    pub async fn save_trade_log_tag(
        &self,
        id: Option<i64>,
        name: &str,
        description: Option<&str>,
        revision: Option<i64>,
    ) -> Result<i64, WriteError> {
        if let Some(id) = id {
            let revision =
                revision.ok_or_else(|| WriteError::Validation("A revision is required".into()))?;
            let result = sqlx::query!("UPDATE trade_log_tags SET name = ?, description = ?, revision = revision + 1 WHERE id = ? AND revision = ?", name, description, id, revision).execute(&self.pool).await?;
            if result.rows_affected() == 0 {
                return Err(WriteError::Conflict);
            }
            Ok(id)
        } else {
            Ok(sqlx::query!(
                "INSERT INTO trade_log_tags (name, description) VALUES (?, ?)",
                name,
                description
            )
            .execute(&self.pool)
            .await?
            .last_insert_rowid())
        }
    }

    pub async fn delete_trade_log_tag(&self, id: i64, revision: i64) -> Result<(), WriteError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let current = sqlx::query_scalar!("SELECT revision FROM trade_log_tags WHERE id = ?", id)
            .fetch_optional(&mut *tx)
            .await?;
        if current != Some(revision) {
            tx.rollback().await?;
            return Err(WriteError::Conflict);
        }
        sqlx::query!("UPDATE trade_logs SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id IN (SELECT trade_id FROM trade_log_tag_links WHERE tag_id = ? UNION SELECT e.trade_id FROM trade_log_execution_tags t JOIN trade_log_executions e ON e.id = t.execution_id WHERE t.tag_id = ?)", id, id).execute(&mut *tx).await?;
        sqlx::query!("DELETE FROM trade_log_tags WHERE id = ?", id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::trade_logs::{
        ExecutionAction, TradeStatus, calculate, tests::input, validate,
    };

    #[tokio::test]
    async fn short_direction_round_trips_and_can_be_corrected_with_its_legs() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let mut source = input(&[(Side::Sell, "10", "20", "1"), (Side::Buy, "5", "10", "1")]);
        source.direction = Direction::Short;
        let id = store
            .save_trade_log(None, &validate(source).unwrap())
            .await
            .unwrap();
        let stored = store.trade_logs_snapshot().await.unwrap().trades.remove(0);
        assert_eq!(stored.trade.input.direction, Direction::Short);
        assert_eq!(
            calculate(id, stored.revision, &stored.trade)
                .unwrap()
                .summary
                .realized_pnl,
            "48.5"
        );
        let mut edit = stored.trade.input.clone();
        edit.direction = Direction::Long;
        for leg in &mut edit.executions {
            leg.side = if leg.side == Side::Sell {
                Side::Buy
            } else {
                Side::Sell
            };
        }
        let ids: Vec<_> = edit.executions.iter().map(|leg| leg.id).collect();
        store
            .save_trade_log(Some(id), &validate(edit).unwrap())
            .await
            .unwrap();
        let stored = store.trade_logs_snapshot().await.unwrap().trades.remove(0);
        assert_eq!(stored.revision, 2);
        assert_eq!(stored.trade.input.direction, Direction::Long);
        assert_eq!(
            stored
                .trade
                .input
                .executions
                .iter()
                .map(|leg| leg.id)
                .collect::<Vec<_>>(),
            ids
        );
        assert_eq!(
            calculate(id, stored.revision, &stored.trade)
                .unwrap()
                .summary
                .realized_pnl,
            "-51.5"
        );
    }

    #[tokio::test]
    async fn atomic_saves_preserve_ids_and_reject_stale_or_foreign_edits() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let tag = store
            .save_trade_log_tag(None, "Entry:Good", None, None)
            .await
            .unwrap();
        let mut source = input(&[(Side::Buy, "10", "10", "1"), (Side::Sell, "10", "12", "1")]);
        source.tag_ids = vec![tag];
        source.executions[1].tag_ids = vec![tag];
        let id = store
            .save_trade_log(None, &validate(source.clone()).unwrap())
            .await
            .unwrap();
        let snapshot = store.trade_logs_snapshot().await.unwrap();
        let original = &snapshot.trades[0];
        assert_eq!(original.id, id);
        let leg_id = original.trade.input.executions[0].id;
        let mut update = original.trade.input.clone();
        update.executions.pop();
        update.notes = "Reopened after correcting the exit".into();
        store
            .save_trade_log(Some(id), &validate(update.clone()).unwrap())
            .await
            .unwrap();
        assert!(matches!(
            store
                .save_trade_log(Some(id), &validate(update).unwrap())
                .await,
            Err(WriteError::Conflict)
        ));
        let snapshot = store.trade_logs_snapshot().await.unwrap();
        let updated = &snapshot.trades[0];
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.trade.input.executions[0].id, leg_id);
        assert_eq!(
            calculate(id, 2, &updated.trade).unwrap().summary.status,
            TradeStatus::Open
        );
        let mut invalid = updated.trade.input.clone();
        invalid.notes = "Must roll back".into();
        invalid.tag_ids.push(tag + 1000);
        assert!(matches!(
            store
                .save_trade_log(Some(id), &validate(invalid).unwrap())
                .await,
            Err(WriteError::Validation(_))
        ));
        let other = store
            .save_trade_log(None, &validate(source).unwrap())
            .await
            .unwrap();
        let snapshot = store.trade_logs_snapshot().await.unwrap();
        let mut invalid = snapshot
            .trades
            .iter()
            .find(|t| t.id == id)
            .unwrap()
            .trade
            .input
            .clone();
        invalid.executions[0].id = snapshot
            .trades
            .iter()
            .find(|t| t.id == other)
            .unwrap()
            .trade
            .input
            .executions[0]
            .id;
        assert!(matches!(
            store
                .save_trade_log(Some(id), &validate(invalid).unwrap())
                .await,
            Err(WriteError::Validation(_))
        ));
        let snapshot = store.trade_logs_snapshot().await.unwrap();
        let unchanged = snapshot.trades.iter().find(|t| t.id == id).unwrap();
        assert_eq!(unchanged.revision, 2);
        assert_eq!(
            unchanged.trade.input.notes,
            "Reopened after correcting the exit"
        );
        assert_eq!(unchanged.trade.input.executions[0].id, leg_id);
        assert_eq!(unchanged.trade.input.tag_ids, [tag]);
        store.delete_trade_log(other, 1).await.unwrap();
        store.delete_trade_log(id, 2).await.unwrap();
        assert!(store.trade_logs_snapshot().await.unwrap().trades.is_empty());
        let legs = sqlx::query_scalar!("SELECT COUNT(*) FROM trade_log_executions")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        let links = sqlx::query_scalar!("SELECT COUNT(*) FROM trade_log_execution_tags")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!((legs, links), (0, 0));
    }

    #[tokio::test]
    async fn tags_are_unique_and_deletion_invalidates_affected_drafts_once() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let tag = store
            .save_trade_log_tag(None, "Entry:Good", None, None)
            .await
            .unwrap();
        assert!(
            store
                .save_trade_log_tag(None, "entry:good", None, None)
                .await
                .is_err()
        );
        let mut source = input(&[(Side::Buy, "1", "10", "0")]);
        source.tag_ids = vec![tag];
        source.executions[0].tag_ids = vec![tag];
        let id = store
            .save_trade_log(None, &validate(source).unwrap())
            .await
            .unwrap();
        let stale = store
            .trade_logs_snapshot()
            .await
            .unwrap()
            .trades
            .remove(0)
            .trade;
        store
            .save_trade_log_tag(Some(tag), "Entry:Excellent", None, Some(1))
            .await
            .unwrap();
        assert!(matches!(
            store
                .save_trade_log_tag(Some(tag), "Stale", None, Some(1))
                .await,
            Err(WriteError::Conflict)
        ));
        assert!(matches!(
            store.delete_trade_log_tag(tag, 1).await,
            Err(WriteError::Conflict)
        ));
        store.delete_trade_log_tag(tag, 2).await.unwrap();
        let snapshot = store.trade_logs_snapshot().await.unwrap();
        assert!(snapshot.tags.is_empty());
        assert_eq!(snapshot.trades[0].revision, 2);
        assert!(snapshot.trades[0].trade.input.tag_ids.is_empty());
        assert!(
            snapshot.trades[0].trade.input.executions[0]
                .tag_ids
                .is_empty()
        );
        assert!(matches!(
            store.save_trade_log(Some(id), &stale).await,
            Err(WriteError::Conflict)
        ));
        assert!(matches!(
            store.delete_trade_log(id, 1).await,
            Err(WriteError::Conflict)
        ));
    }

    #[tokio::test]
    async fn same_timestamp_sequence_and_leg_only_tag_survive_round_trip() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let tag = store
            .save_trade_log_tag(None, "Sale:Early", None, None)
            .await
            .unwrap();
        let mut source = input(&[
            (Side::Buy, "3", "10", "0"),
            (Side::Sell, "1", "11", "0"),
            (Side::Sell, "2", "12", "0"),
        ]);
        let at = source.executions[0].executed_at;
        for leg in &mut source.executions {
            leg.executed_at = at;
        }
        source.executions[2].tag_ids = vec![tag];
        store
            .save_trade_log(None, &validate(source).unwrap())
            .await
            .unwrap();
        let stored = store.trade_logs_snapshot().await.unwrap().trades.remove(0);
        let trade = calculate(stored.id, stored.revision, &stored.trade).unwrap();
        assert_eq!(trade.summary.realized_pnl, "5");
        assert_eq!(trade.executions[2].action, ExecutionAction::Close);
        store.delete_trade_log_tag(tag, 1).await.unwrap();
        assert_eq!(
            store.trade_logs_snapshot().await.unwrap().trades[0].revision,
            2
        );
    }
}
