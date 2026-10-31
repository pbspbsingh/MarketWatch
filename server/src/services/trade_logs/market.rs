use super::{Filter, TradeLogsError, TradeLogsService};
use crate::services::yahoo::YahooService;
use chrono::{Duration, Utc};
use futures_util::{StreamExt, stream};
use journal::trade_logs::Valuation;
use journal::trade_logs::parse_decimal;
use journal::trade_logs::value_open_trade;
use market_types::TickerSymbol;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use ts_rs::TS;
use yahoo::ChartInterval;
use yahoo::YahooClient;

pub struct TradeLogMarketService {
    logs: Arc<TradeLogsService>,
    yahoo: Arc<YahooService>,
    client: Arc<YahooClient>,
}

#[derive(Serialize, TS)]
#[ts(rename = "TradeLogHourlyCandle")]
pub struct HourlyCandle {
    time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: u64,
}
#[derive(Serialize, TS)]
#[ts(rename = "TradeLogHourlyChart")]
pub struct HourlyChart {
    symbol: TickerSymbol,
    candles: Vec<HourlyCandle>,
    history_limited: bool,
}

impl TradeLogMarketService {
    pub fn new(
        logs: Arc<TradeLogsService>,
        yahoo: Arc<YahooService>,
        client: Arc<YahooClient>,
    ) -> Self {
        Self {
            logs,
            yahoo,
            client,
        }
    }

    pub async fn valuations(&self) -> Result<Vec<Valuation>, TradeLogsError> {
        let trades = self
            .logs
            .snapshot(Filter {
                status: vec!["open".into()],
                ..Filter::default()
            })
            .await?
            .trades;
        let symbols: HashSet<_> = trades.iter().map(|trade| trade.symbol.clone()).collect();
        let marks: HashMap<_, _> = stream::iter(symbols)
            .map(|symbol| async move {
                let mark = match self
                    .yahoo
                    .daily_candles_for_duration(&symbol, Duration::days(30))
                    .await
                {
                    Ok(candles) => candles.last().and_then(|candle| {
                        if !candle.close.is_finite() || candle.close <= 0.0 {
                            return None;
                        }
                        parse_decimal(&format!("{:.6}", candle.close))
                            .ok()
                            .map(|price| (price, candle.market_date))
                    }),
                    Err(error) => {
                        tracing::warn!(%symbol, %error, "trade valuation price unavailable");
                        None
                    }
                };
                (symbol, mark)
            })
            .buffer_unordered(4)
            .collect()
            .await;
        Ok(trades
            .iter()
            .map(|trade| value_open_trade(trade, marks.get(&trade.symbol).copied().flatten()))
            .collect())
    }

    pub async fn hourly_chart(&self, id: i64) -> Result<HourlyChart, TradeLogsError> {
        let trade = self.logs.get(id).await?;
        let now = Utc::now();
        // Yahoo limits its retained hourly history. Never move old fills onto newer candles.
        let earliest = now - Duration::days(729);
        let requested = trade.summary.opened_at - Duration::days(3);
        let start = requested.max(earliest);
        let end = trade
            .summary
            .closed_at
            .map_or(now, |at| (at + Duration::days(3)).min(now));
        if start >= end {
            return Ok(HourlyChart {
                symbol: trade.symbol,
                candles: vec![],
                history_limited: true,
            });
        }
        let candles = self
            .client
            .chart_range_with_pre_post(
                &(&trade.symbol).into(),
                ChartInterval::OneHour,
                start,
                end,
                true,
            )
            .await
            .map_err(|error| {
                tracing::warn!(%error, "trade hourly chart unavailable");
                TradeLogsError::MarketUnavailable
            })?
            .candles;
        let mut candles: Vec<_> = candles
            .into_iter()
            .filter(|candle| {
                [candle.open, candle.high, candle.low, candle.close]
                    .iter()
                    .all(|price| price.is_finite() && *price > 0.0)
            })
            .map(|candle| HourlyCandle {
                time: candle.timestamp.timestamp(),
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
            })
            .collect();
        candles.sort_by_key(|candle| candle.time);
        candles.dedup_by_key(|candle| candle.time);
        Ok(HourlyChart {
            symbol: trade.symbol,
            candles,
            history_limited: requested < earliest,
        })
    }
}
