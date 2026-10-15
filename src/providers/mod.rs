mod ai;
mod finviz;
pub(crate) mod news;
mod request_throttle;
mod yahoo;

pub use ai::{AiClient, AiError};
pub(crate) use ai::{AiStreamDelta, BackgroundAiRequest, UserAiJob};
pub use finviz::{FinvizClient, IndustryClassification};
pub(crate) use yahoo::live::{PricingData, spawn_transport};
pub use yahoo::{Candle, ChartInterval, ChartRange, YahooClient, YahooError};

pub(crate) fn is_http_not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<reqwest::Error>()
            .is_some_and(|error| error.status() == Some(reqwest::StatusCode::NOT_FOUND))
    })
}
