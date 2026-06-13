use reqwest::StatusCode;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum YahooError {
    #[error("Yahoo Finance request failed: {0}")]
    Transport(#[source] reqwest::Error),

    #[error("Yahoo Finance resource not found for {symbol}")]
    NotFound { symbol: String },

    #[error("Yahoo Finance rate limit exceeded")]
    RateLimited,

    #[error("Yahoo Finance authorization failed")]
    Unauthorized,

    #[error("Yahoo Finance server returned HTTP {status}")]
    Server { status: StatusCode },

    #[error("Yahoo Finance returned HTTP {status}")]
    Http { status: StatusCode },

    #[error("Yahoo Finance API error: {message}")]
    Api { message: String },

    #[error("invalid Yahoo Finance response: {message}")]
    InvalidResponse { message: String },

    #[error("unsupported Yahoo Finance exchange for {symbol}: code={code:?}, name={name:?}")]
    UnsupportedExchange {
        symbol: String,
        code: Option<String>,
        name: Option<String>,
    },

    #[error("Yahoo Finance request queue was closed")]
    RequestQueueClosed,
}

impl YahooError {
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::RateLimited | Self::Unauthorized | Self::Transport(_) | Self::Server { .. }
        )
    }
}
