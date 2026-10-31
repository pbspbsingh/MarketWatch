mod ai;
mod finviz;
pub(crate) mod news;
pub(crate) mod sec;
pub use yahoo;

#[cfg(test)]
pub(crate) use ai::tests::{
    TestAiServer, probe_automatic_preemption, probe_cancellation, probe_wait_for_completion,
};
pub use ai::{AiClient, AiError};
pub(crate) use ai::{AiStreamDelta, BackgroundAiRequest, UserAiJob};
pub use finviz::{FinvizClient, IndustryClassification};
pub use yahoo::{Candle, ChartInterval, ChartRange, YahooClient, YahooError};
pub(crate) use yahoo::{PricingData, spawn_transport};

pub(crate) fn is_http_not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<reqwest::Error>()
            .is_some_and(|error| error.status() == Some(reqwest::StatusCode::NOT_FOUND))
    })
}
