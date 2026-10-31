use crate::models::chart::{
    MarketChartCandle, MarketChartIndicators, MarketChartInterval, MarketChartRelativeStrength,
    MarketChartSeries,
};
use crate::services::volume_run_rate::VolumeRunRate;
use chrono::{DateTime, NaiveDate, Utc};
use market_types::{TickerSymbol, YahooSymbol};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LiveCommand {
    SetSubscriptions {
        request_id: u64,
        charts: Vec<RawLiveChartRequest>,
        symbols: Vec<String>,
    },
}

#[derive(Deserialize, TS)]
pub struct RawLiveChartRequest {
    #[serde(default)]
    pub volume_run_rate: bool,
    pub chart_id: String,
    pub symbol: String,
    pub interval: MarketChartInterval,
    pub comparison_symbol: Option<String>,
    pub relative_strength_period: Option<usize>,
}

#[derive(Clone, PartialEq, Serialize, TS)]
pub struct LiveChartDelta {
    pub chart_id: String,
    pub symbol: TickerSymbol,
    pub interval: MarketChartInterval,
    pub candle: MarketChartCandle,
    pub moving_averages: Vec<MarketChartSeries>,
    pub volume_average: MarketChartSeries,
    pub indicators: Option<MarketChartIndicators>,
    pub relative_strength: Option<MarketChartRelativeStrength>,
}

#[derive(Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum LiveSessionKind {
    PreMarket,
    PostMarket,
}

#[derive(Clone, PartialEq, Serialize, TS)]
pub struct LiveSessionDelta {
    pub chart_id: String,
    pub symbol: YahooSymbol,
    pub date: NaiveDate,
    pub session: LiveSessionKind,
    pub candle: Option<MarketChartCandle>,
    pub price: f64,
    pub indicators: Option<MarketChartIndicators>,
}

#[derive(Clone, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LiveEvent {
    Availability {
        available: bool,
        market_date: NaiveDate,
    },
    Price {
        request_id: u64,
        symbol: YahooSymbol,
        price: f64,
        updated_at: DateTime<Utc>,
    },
    VolumeRunRate {
        request_id: u64,
        chart_id: String,
        state: VolumeRunRate,
    },
    Subscribed {
        request_id: u64,
        symbols: Vec<YahooSymbol>,
    },
    Delta {
        request_id: u64,
        delta: Box<LiveChartDelta>,
    },
    Session {
        request_id: u64,
        delta: LiveSessionDelta,
    },
    Error {
        request_id: u64,
        chart_id: Option<String>,
        message: String,
    },
}
