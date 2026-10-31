use chrono::NaiveDate;
use chrono_tz::America::New_York;
use journal::trade_logs::{
    Direction, Tag, TagInput, Trade, TradeInput, TradeStatus, calculate, cash, validate,
};
use serde::{Deserialize, Serialize};
use std::{cmp::Reverse, fmt::Display, str::FromStr};
use ts_rs::TS;
use user_db::Store as UserStore;
use user_db::trade_logs::WriteError;
pub mod market;

#[derive(Debug, thiserror::Error)]
pub enum TradeLogsError {
    #[error("Market data is temporarily unavailable")]
    MarketUnavailable,
    #[error("{0}")]
    Validation(String),
    #[error(transparent)]
    Write(#[from] WriteError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TagScope {
    #[default]
    Any,
    Trade,
    Leg,
}
impl FromStr for TagScope {
    type Err = &'static str;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "any" => Ok(Self::Any),
            "trade" => Ok(Self::Trade),
            "leg" => Ok(Self::Leg),
            _ => Err("Invalid tag source"),
        }
    }
}

fn deserialize_selection<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: FromStr,
    T::Err: Display,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty() {
        return Ok(vec![]);
    }
    value
        .split(',')
        .map(|item| item.trim().parse().map_err(serde::de::Error::custom))
        .collect()
}
#[derive(Debug, Default, Deserialize)]
pub struct Filter {
    pub start: Option<NaiveDate>,
    pub end: Option<NaiveDate>,
    #[serde(default, deserialize_with = "deserialize_selection")]
    pub tag_id: Vec<i64>,
    #[serde(default, deserialize_with = "deserialize_selection")]
    pub tag_scope: Vec<TagScope>,
    #[serde(default, deserialize_with = "deserialize_selection")]
    pub status: Vec<String>,
    pub symbol: Option<String>,
    #[serde(default, deserialize_with = "deserialize_selection")]
    pub direction: Vec<Direction>,
}
impl Filter {
    fn validate(&self) -> Result<(), TradeLogsError> {
        if self
            .start
            .zip(self.end)
            .is_some_and(|(start, end)| start > end)
        {
            return Err(TradeLogsError::Validation(
                "Start date must precede end date".into(),
            ));
        }
        if self
            .status
            .iter()
            .any(|status| !["all", "open", "closed", "win", "loss"].contains(&status.as_str()))
        {
            return Err(TradeLogsError::Validation("Invalid trade status".into()));
        }
        if self.tag_id.iter().any(|id| *id <= 0) {
            return Err(TradeLogsError::Validation("Invalid tag".into()));
        }
        Ok(())
    }
    fn matches_tag(&self, trade: &Trade, tag: i64) -> bool {
        if self.tag_scope.is_empty() {
            has_tag(trade, tag, TagScope::Any)
        } else {
            self.tag_scope
                .iter()
                .any(|scope| has_tag(trade, tag, *scope))
        }
    }
    fn matches(&self, trade: &Trade) -> bool {
        let at = trade.summary.closed_at.unwrap_or(trade.summary.opened_at);
        let date = at.with_timezone(&New_York).date_naive();
        self.start.is_none_or(|start| date >= start)
            && (self.direction.is_empty() || self.direction.contains(&trade.direction))
            && self.end.is_none_or(|end| date <= end)
            && (self.status.is_empty()
                || self.status.iter().any(|status| match status.as_str() {
                    "all" => true,
                    "win" => trade.summary.status == TradeStatus::Closed && trade.net_cash > 0,
                    "loss" => trade.summary.status == TradeStatus::Closed && trade.net_cash < 0,
                    "open" => trade.summary.status == TradeStatus::Open,
                    "closed" => trade.summary.status == TradeStatus::Closed,
                    _ => false,
                }))
            && self.symbol.as_ref().is_none_or(|symbol| {
                trade
                    .symbol
                    .as_str()
                    .contains(&symbol.trim().to_uppercase())
            })
            && (self.tag_id.is_empty()
                || self.tag_id.iter().any(|tag| self.matches_tag(trade, *tag)))
    }
}
pub fn has_tag(trade: &Trade, tag: i64, scope: TagScope) -> bool {
    let direct = || trade.tag_ids.contains(&tag);
    let leg = || {
        trade
            .executions
            .iter()
            .any(|leg| leg.input.tag_ids.contains(&tag))
    };
    match scope {
        TagScope::Trade => direct(),
        TagScope::Leg => leg(),
        TagScope::Any => direct() || leg(),
    }
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(rename = "TradeLogStatistics")]
pub struct Statistics {
    pub closed_trades: usize,
    pub winners: usize,
    pub losers: usize,
    pub breakeven: usize,
    pub net_pnl: String,
    pub average_pnl: Option<String>,
    pub average_winner: Option<String>,
    pub average_loser: Option<String>,
    pub win_rate: Option<f64>,
    pub profit_factor: Option<f64>,
}
pub fn statistics<'a>(trades: impl Iterator<Item = &'a Trade>) -> Statistics {
    let mut count = 0;
    let mut wins = 0;
    let mut losses = 0;
    let mut profit = 0_i128;
    let mut loss = 0_i128;
    for trade in trades.filter(|trade| trade.summary.status == TradeStatus::Closed) {
        count += 1;
        if trade.net_cash > 0 {
            wins += 1;
            profit += trade.net_cash;
        } else if trade.net_cash < 0 {
            losses += 1;
            loss -= trade.net_cash;
        }
    }
    Statistics {
        closed_trades: count,
        winners: wins,
        losers: losses,
        breakeven: count - wins - losses,
        net_pnl: cash(profit - loss),
        average_pnl: (count > 0).then(|| cash((profit - loss) / count as i128)),
        average_winner: (wins > 0).then(|| cash(profit / wins as i128)),
        average_loser: (losses > 0).then(|| cash(-loss / losses as i128)),
        win_rate: (count > 0).then(|| wins as f64 * 100.0 / count as f64),
        profit_factor: (loss > 0).then(|| profit as f64 / loss as f64),
    }
}
#[derive(Serialize, TS)]
#[ts(rename = "TradeLogTagStatistics")]
pub struct TagStatistics {
    pub tag_id: i64,
    pub statistics: Statistics,
}
#[derive(Serialize, TS)]
#[ts(rename = "TradeLogSnapshotData")]
pub struct Snapshot {
    pub trades: Vec<Trade>,
    pub tags: Vec<Tag>,
    pub statistics: Statistics,
    pub tag_statistics: Vec<TagStatistics>,
    pub untagged_trades: usize,
    pub open_trades: usize,
    pub open_realized_pnl: String,
}

pub struct TradeLogsService {
    user_store: UserStore,
}
impl TradeLogsService {
    pub fn new(user_store: UserStore) -> Self {
        Self { user_store }
    }
    async fn all(&self) -> Result<(Vec<Trade>, Vec<Tag>), TradeLogsError> {
        let stored = self.user_store.trade_logs_snapshot().await?;
        let mut trades = stored
            .trades
            .into_iter()
            .map(|stored| {
                calculate(stored.id, stored.revision, &stored.trade)
                    .map_err(|message| sqlx::Error::Decode(message.into()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        trades.sort_by_key(|trade| Reverse((trade.summary.opened_at, trade.id)));
        let tags = stored
            .tags
            .into_iter()
            .map(|tag| Tag {
                trade_count: trades
                    .iter()
                    .filter(|trade| trade.tag_ids.contains(&tag.id))
                    .count(),
                execution_count: trades
                    .iter()
                    .flat_map(|trade| &trade.executions)
                    .filter(|leg| leg.input.tag_ids.contains(&tag.id))
                    .count(),
                id: tag.id,
                name: tag.name,
                description: tag.description,
                revision: tag.revision,
            })
            .collect();
        Ok((trades, tags))
    }
    pub async fn snapshot(&self, filter: Filter) -> Result<Snapshot, TradeLogsError> {
        filter.validate()?;
        let (trades, tags) = self.all().await?;
        let trades: Vec<_> = trades
            .into_iter()
            .filter(|trade| filter.matches(trade))
            .collect();
        let tag_statistics = tags
            .iter()
            .map(|tag| TagStatistics {
                tag_id: tag.id,
                statistics: statistics(
                    trades
                        .iter()
                        .filter(|trade| filter.matches_tag(trade, tag.id)),
                ),
            })
            .collect();
        Ok(Snapshot {
            statistics: statistics(trades.iter()),
            untagged_trades: trades
                .iter()
                .filter(|trade| {
                    trade.tag_ids.is_empty()
                        && trade
                            .executions
                            .iter()
                            .all(|leg| leg.input.tag_ids.is_empty())
                })
                .count(),
            open_trades: trades
                .iter()
                .filter(|trade| trade.summary.status == TradeStatus::Open)
                .count(),
            open_realized_pnl: cash(
                trades
                    .iter()
                    .filter(|trade| trade.summary.status == TradeStatus::Open)
                    .map(|trade| trade.net_cash)
                    .sum(),
            ),
            trades,
            tags,
            tag_statistics,
        })
    }
    pub fn preview(input: TradeInput) -> Result<Trade, TradeLogsError> {
        let trade = validate(input).map_err(TradeLogsError::Validation)?;
        calculate(0, 0, &trade).map_err(TradeLogsError::Validation)
    }
    pub async fn get(&self, id: i64) -> Result<Trade, TradeLogsError> {
        self.all()
            .await?
            .0
            .into_iter()
            .find(|trade| trade.id == id)
            .ok_or(WriteError::NotFound.into())
    }
    pub async fn save(&self, id: Option<i64>, input: TradeInput) -> Result<Trade, TradeLogsError> {
        let validated = validate(input).map_err(TradeLogsError::Validation)?;
        let id = self.user_store.save_trade_log(id, &validated).await?;
        self.get(id).await
    }
    pub async fn delete(&self, id: i64, revision: i64) -> Result<(), TradeLogsError> {
        Ok(self.user_store.delete_trade_log(id, revision).await?)
    }
    pub async fn save_tag(&self, id: Option<i64>, input: TagInput) -> Result<Tag, TradeLogsError> {
        let name = input.name.trim();
        if name.is_empty() || name.len() > 100 || name.chars().any(char::is_control) {
            return Err(TradeLogsError::Validation(
                "Tag names must contain 1–100 bytes and no control characters".into(),
            ));
        }
        let description = input
            .description
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty());
        if description.is_some_and(|text| text.chars().count() > 2_000) {
            return Err(TradeLogsError::Validation(
                "Tag descriptions must contain at most 2,000 characters".into(),
            ));
        }
        let id = self
            .user_store
            .save_trade_log_tag(id, name, description, input.revision)
            .await?;
        self.all()
            .await?
            .1
            .into_iter()
            .find(|tag| tag.id == id)
            .ok_or(WriteError::NotFound.into())
    }
    pub async fn delete_tag(&self, id: i64, revision: i64) -> Result<(), TradeLogsError> {
        Ok(self.user_store.delete_trade_log_tag(id, revision).await?)
    }
}

#[cfg(test)]
mod tests {
    use crate::test_support::TestDatabases;

    use super::*;
    use chrono::{DateTime, Utc};
    use journal::test_support::input;
    use journal::trade_logs::Side;
    use std::iter::once;

    #[tokio::test]
    async fn tag_descriptions_are_optional_editable_and_revision_checked() {
        let service = TradeLogsService::new(TestDatabases::new().await.unwrap().user);
        let input: TagInput =
            serde_json::from_value(serde_json::json!({"name": " Entry:Good "})).unwrap();
        let tag = service.save_tag(None, input).await.unwrap();
        assert_eq!(tag.name, "Entry:Good");
        assert_eq!(tag.description, None);
        let updated = service
            .save_tag(
                Some(tag.id),
                TagInput {
                    name: tag.name.clone(),
                    description: Some("  Buy near support.\nAvoid chasing.  ".into()),
                    revision: Some(tag.revision),
                },
            )
            .await
            .unwrap();
        assert_eq!(
            updated.description.as_deref(),
            Some("Buy near support.\nAvoid chasing.")
        );
        assert_eq!(updated.revision, tag.revision + 1);
        let snapshot = service.snapshot(Filter::default()).await.unwrap();
        assert_eq!(snapshot.tags[0].description, updated.description);
        assert!(matches!(
            service
                .save_tag(
                    Some(tag.id),
                    TagInput {
                        name: tag.name.clone(),
                        description: Some("Stale description".into()),
                        revision: Some(tag.revision),
                    }
                )
                .await,
            Err(TradeLogsError::Write(WriteError::Conflict))
        ));
        let cleared = service
            .save_tag(
                Some(tag.id),
                TagInput {
                    name: tag.name,
                    description: Some(" \n\t ".into()),
                    revision: Some(updated.revision),
                },
            )
            .await
            .unwrap();
        assert_eq!(cleared.description, None);
        assert_eq!(cleared.revision, updated.revision + 1);
    }

    #[tokio::test]
    async fn tag_description_limit_counts_unicode_characters_and_rejects_oversized_updates() {
        let service = TradeLogsService::new(TestDatabases::new().await.unwrap().user);
        let tag = service
            .save_tag(
                None,
                TagInput {
                    name: "Setup".into(),
                    description: Some("é".repeat(2_000)),
                    revision: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(tag.description.as_ref().unwrap().chars().count(), 2_000);
        assert!(matches!(
            service
                .save_tag(
                    Some(tag.id),
                    TagInput {
                        name: "Changed".into(),
                        description: Some("x".repeat(2_001)),
                        revision: Some(tag.revision),
                    }
                )
                .await,
            Err(TradeLogsError::Validation(_))
        ));
        let saved = service
            .snapshot(Filter::default())
            .await
            .unwrap()
            .tags
            .remove(0);
        assert_eq!(saved.name, tag.name);
        assert_eq!(saved.description, tag.description);
        assert_eq!(saved.revision, tag.revision);
    }

    #[test]
    fn outcome_filters_use_final_net_profit_and_combine_with_position_status() {
        use journal::trade_logs::Direction::{Long, Short};
        let trades: Vec<_> = [
            (
                Long,
                vec![(Side::Buy, "1", "10", "0"), (Side::Sell, "1", "15", "0")],
            ),
            (
                Long,
                vec![(Side::Buy, "1", "10", "0"), (Side::Sell, "1", "7", "0")],
            ),
            (
                Long,
                vec![(Side::Buy, "1", "10", "0"), (Side::Sell, "1", "10", "0")],
            ),
            // A gross gain becomes a loss after recorded fees.
            (
                Long,
                vec![(Side::Buy, "1", "10", "2"), (Side::Sell, "1", "11", "0")],
            ),
            (
                Short,
                vec![(Side::Sell, "1", "15", "0"), (Side::Buy, "1", "10", "0")],
            ),
            (
                Short,
                vec![(Side::Sell, "1", "10", "0"), (Side::Buy, "1", "15", "0")],
            ),
            (
                Short,
                vec![(Side::Sell, "1", "10", "0"), (Side::Buy, "1", "10", "0")],
            ),
            // Partial realized outcomes never classify an open position as Win/Loss.
            (
                Long,
                vec![(Side::Buy, "2", "10", "0"), (Side::Sell, "1", "17", "0")],
            ),
            (
                Short,
                vec![(Side::Sell, "2", "10", "0"), (Side::Buy, "1", "15", "0")],
            ),
        ]
        .into_iter()
        .map(|(direction, legs)| {
            let mut source = input(&legs);
            source.direction = direction;
            TradeLogsService::preview(source).unwrap()
        })
        .collect();
        for (statuses, expected) in [
            (vec!["win"], 2),
            (vec!["loss"], 3),
            (vec!["closed"], 7),
            (vec!["open"], 2),
            (vec!["win", "loss"], 5),
            (vec!["open", "win"], 4),
            (vec!["closed", "win", "loss"], 7),
            (vec![], 9),
        ] {
            let filter = Filter {
                status: statuses.into_iter().map(str::to_owned).collect(),
                ..Filter::default()
            };
            filter.validate().unwrap();
            assert_eq!(
                trades.iter().filter(|trade| filter.matches(trade)).count(),
                expected,
                "{filter:?}"
            );
        }
        let short_losses = Filter {
            direction: vec![Short],
            status: vec!["loss".into()],
            ..Filter::default()
        };
        assert_eq!(
            trades
                .iter()
                .filter(|trade| short_losses.matches(trade))
                .count(),
            1
        );
        let losses = Filter {
            status: vec!["loss".into()],
            ..Filter::default()
        };
        let stats = statistics(trades.iter().filter(|trade| losses.matches(trade)));
        assert_eq!(stats.losers, 3);
        assert_eq!(stats.winners, 0);
        assert_eq!(stats.net_pnl, "-9");
    }

    #[test]
    fn selection_queries_parse_lists_and_preserve_single_value_requests() {
        use axum::{extract::Query, http::Uri};
        let uri: Uri = "/api/trade-logs?status=open,closed&direction=long,short&tag_id=1,2&tag_scope=trade,leg".parse().unwrap();
        let Query(filter) = Query::<Filter>::try_from_uri(&uri).unwrap();
        filter.validate().unwrap();
        assert_eq!(filter.status, ["open", "closed"]);
        assert_eq!(filter.direction, [Direction::Long, Direction::Short]);
        assert_eq!(filter.tag_id, [1, 2]);
        assert_eq!(filter.tag_scope, [TagScope::Trade, TagScope::Leg]);
        let Query(single) = Query::<Filter>::try_from_uri(
            &"/api/trade-logs?status=open&direction=short&tag_id=1&tag_scope=leg"
                .parse()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(single.tag_id, [1]);
        assert_eq!(single.direction, [Direction::Short]);
        let Query(empty) = Query::<Filter>::try_from_uri(
            &"/api/trade-logs?status=&direction=&tag_id=&tag_scope="
                .parse()
                .unwrap(),
        )
        .unwrap();
        assert!(
            empty.status.is_empty()
                && empty.direction.is_empty()
                && empty.tag_id.is_empty()
                && empty.tag_scope.is_empty()
        );
        for query in [
            "direction=long,invalid",
            "tag_scope=trade,invalid",
            "tag_id=1,invalid",
        ] {
            assert!(
                Query::<Filter>::try_from_uri(&format!("/api/trade-logs?{query}").parse().unwrap())
                    .is_err()
            );
        }
        for query in ["tag_id=1,0", "status=open,invalid"] {
            let Query(invalid) =
                Query::<Filter>::try_from_uri(&format!("/api/trade-logs?{query}").parse().unwrap())
                    .unwrap();
            assert!(invalid.validate().is_err());
        }
    }

    #[tokio::test]
    async fn multiple_tags_and_sources_union_results_without_duplicating_statistics() {
        let service = TradeLogsService::new(TestDatabases::new().await.unwrap().user);
        let mut ids = vec![];
        for name in ["Entry:Good", "Sale:Early"] {
            ids.push(
                service
                    .save_tag(
                        None,
                        TagInput {
                            name: name.into(),
                            description: None,
                            revision: None,
                        },
                    )
                    .await
                    .unwrap()
                    .id,
            );
        }
        for index in 0..4 {
            let mut source = if index == 2 {
                let mut short = input(&[(Side::Sell, "1", "20", "0"), (Side::Buy, "1", "15", "0")]);
                short.direction = Direction::Short;
                short
            } else if index == 3 {
                input(&[(Side::Buy, "1", "10", "0")])
            } else {
                input(&[(Side::Buy, "1", "10", "0"), (Side::Sell, "1", "15", "0")])
            };
            if index != 1 {
                source.tag_ids = vec![ids[0]];
            }
            if index == 1 || index == 2 {
                source.executions[1].tag_ids = vec![ids[1]];
            }
            service.save(None, source).await.unwrap();
        }
        let selected = || Filter {
            tag_id: vec![ids[0], ids[1], ids[0]],
            tag_scope: vec![TagScope::Trade, TagScope::Leg],
            status: vec!["open".into(), "closed".into()],
            direction: vec![Direction::Long, Direction::Short],
            ..Filter::default()
        };
        let snapshot = service.snapshot(selected()).await.unwrap();
        assert_eq!(snapshot.trades.len(), 4);
        assert_eq!(snapshot.statistics.closed_trades, 3);
        assert_eq!(snapshot.statistics.net_pnl, "15");
        assert_eq!(snapshot.open_trades, 1);
        assert!(
            snapshot
                .tag_statistics
                .iter()
                .all(|row| row.statistics.closed_trades == 2 && row.statistics.net_pnl == "10")
        );
        let trade_only = service
            .snapshot(Filter {
                tag_scope: vec![TagScope::Trade],
                ..selected()
            })
            .await
            .unwrap();
        assert_eq!(trade_only.trades.len(), 3);
        assert_eq!(trade_only.statistics.closed_trades, 2);
        let leg_only = service
            .snapshot(Filter {
                tag_scope: vec![TagScope::Leg],
                ..selected()
            })
            .await
            .unwrap();
        assert_eq!(leg_only.trades.len(), 2);
        assert_eq!(leg_only.statistics.net_pnl, "10");
        let short_closed = service
            .snapshot(Filter {
                direction: vec![Direction::Short],
                status: vec!["closed".into()],
                ..selected()
            })
            .await
            .unwrap();
        assert_eq!(short_closed.trades.len(), 1);
        assert_eq!(short_closed.statistics.net_pnl, "5");
        let open = service
            .snapshot(Filter {
                status: vec!["open".into()],
                ..selected()
            })
            .await
            .unwrap();
        assert_eq!(open.trades.len(), 1);
        assert_eq!(open.statistics.closed_trades, 0);
        assert_eq!(
            service
                .snapshot(Filter::default())
                .await
                .unwrap()
                .trades
                .len(),
            4
        );
    }

    #[tokio::test]
    async fn mixed_long_short_outcomes_and_direction_filters_share_tag_statistics() {
        let service = TradeLogsService::new(TestDatabases::new().await.unwrap().user);
        let tag = service
            .save_tag(
                None,
                TagInput {
                    name: "Entry:Good".into(),
                    description: None,
                    revision: None,
                },
            )
            .await
            .unwrap();
        for (direction, legs) in [
            (
                Direction::Long,
                vec![(Side::Buy, "1", "10", "1"), (Side::Sell, "1", "15", "1")],
            ),
            (
                Direction::Short,
                vec![(Side::Sell, "1", "15", "1"), (Side::Buy, "1", "10", "1")],
            ),
            (
                Direction::Short,
                vec![(Side::Sell, "1", "10", "1"), (Side::Buy, "1", "15", "1")],
            ),
        ] {
            let mut source = input(&legs);
            source.direction = direction;
            source.tag_ids = vec![tag.id];
            source.executions[0].tag_ids = vec![tag.id];
            service.save(None, source).await.unwrap();
        }
        let snapshot = service.snapshot(Filter::default()).await.unwrap();
        assert_eq!(snapshot.statistics.closed_trades, 3);
        assert_eq!(snapshot.statistics.winners, 2);
        assert_eq!(snapshot.statistics.net_pnl, "-1");
        assert_eq!(snapshot.tag_statistics[0].statistics.closed_trades, 3);
        let short = service
            .snapshot(Filter {
                direction: vec![Direction::Short],
                ..Filter::default()
            })
            .await
            .unwrap();
        assert_eq!(short.trades.len(), 2);
        assert_eq!(short.statistics.net_pnl, "-4");
        assert_eq!(short.tag_statistics[0].statistics.net_pnl, "-4");
        let long = service
            .snapshot(Filter {
                direction: vec![Direction::Long],
                ..Filter::default()
            })
            .await
            .unwrap();
        assert_eq!(long.trades.len(), 1);
        assert_eq!(long.statistics.net_pnl, "3");
    }

    #[tokio::test]
    async fn stats_count_parent_trades_once_and_separate_open_realized_profit() {
        let store = TestDatabases::new().await.unwrap();
        let service = TradeLogsService::new(store.user);
        let tag = service
            .save_tag(
                None,
                TagInput {
                    name: " Entry:Good ".into(),
                    description: None,
                    revision: None,
                },
            )
            .await
            .unwrap();
        for exit in ["15", "7", "10"] {
            let mut source = input(&[(Side::Buy, "1", "10", "0"), (Side::Sell, "1", exit, "0")]);
            source.tag_ids = vec![tag.id];
            for leg in &mut source.executions {
                leg.tag_ids = vec![tag.id];
            }
            service.save(None, source).await.unwrap();
        }
        service
            .save(
                None,
                input(&[(Side::Buy, "2", "10", "0"), (Side::Sell, "1", "17", "0")]),
            )
            .await
            .unwrap();
        let snapshot = service.snapshot(Filter::default()).await.unwrap();
        let stats = snapshot.statistics;
        assert_eq!(
            (
                stats.closed_trades,
                stats.winners,
                stats.losers,
                stats.breakeven
            ),
            (3, 1, 1, 1)
        );
        assert_eq!(stats.net_pnl, "2");
        assert_eq!(stats.average_pnl.as_deref(), Some("0.666667"));
        assert_eq!(stats.average_winner.as_deref(), Some("5"));
        assert_eq!(stats.average_loser.as_deref(), Some("-3"));
        assert!((stats.win_rate.unwrap() - 100.0 / 3.0).abs() < 0.0001);
        assert!((stats.profit_factor.unwrap() - 5.0 / 3.0).abs() < 0.0001);
        assert_eq!(snapshot.open_trades, 1);
        assert_eq!(snapshot.open_realized_pnl, "7");
        assert_eq!(snapshot.untagged_trades, 1);
        assert_eq!(snapshot.tag_statistics[0].statistics.closed_trades, 3);
        assert_eq!(snapshot.tags[0].name, "Entry:Good");
        assert_eq!(
            (
                snapshot.tags[0].trade_count,
                snapshot.tags[0].execution_count
            ),
            (3, 6)
        );
        for tag_scope in [TagScope::Any, TagScope::Trade, TagScope::Leg] {
            let filtered = service
                .snapshot(Filter {
                    tag_id: vec![tag.id],
                    tag_scope: vec![tag_scope],
                    ..Filter::default()
                })
                .await
                .unwrap();
            assert_eq!(filtered.trades.len(), 3);
            assert_eq!(filtered.statistics.net_pnl, "2");
        }
    }

    #[test]
    fn scopes_and_date_filters_use_the_selected_source_and_market_date() {
        let mut source = input(&[(Side::Buy, "1", "10", "0"), (Side::Sell, "1", "15", "0")]);
        source.tag_ids = vec![1];
        source.executions[1].tag_ids = vec![2];
        source.executions[1].executed_at = DateTime::parse_from_rfc3339("2025-02-02T01:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let trade = TradeLogsService::preview(source.clone()).unwrap();
        assert!(has_tag(&trade, 2, TagScope::Any));
        assert!(has_tag(&trade, 2, TagScope::Leg));
        assert!(!has_tag(&trade, 2, TagScope::Trade));
        assert!(has_tag(&trade, 1, TagScope::Trade));
        assert!(!has_tag(&trade, 1, TagScope::Leg));
        let day = NaiveDate::from_ymd_opt(2025, 2, 1).unwrap();
        let filter = Filter {
            start: Some(day),
            end: Some(day),
            symbol: Some(" aapl ".into()),
            ..Filter::default()
        };
        assert!(filter.matches(&trade));
        source.executions.pop();
        let open = TradeLogsService::preview(source).unwrap();
        assert!(!filter.matches(&open));
        let empty = statistics(once(&open));
        assert_eq!(empty.closed_trades, 0);
        assert!(empty.win_rate.is_none());
        assert!(empty.profit_factor.is_none());
        assert!(empty.average_pnl.is_none());
        assert!(
            Filter {
                start: Some(day),
                end: Some(day.pred_opt().unwrap()),
                ..Filter::default()
            }
            .validate()
            .is_err()
        );
    }
}
