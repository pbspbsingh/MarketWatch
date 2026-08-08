use chrono::TimeDelta;

pub const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/// Calendar history retained/requested for roughly 500 trading sessions.
pub const DAILY_CANDLE_HISTORY: TimeDelta = TimeDelta::days(760);

/// Initial weekly-chart history requested for approximately six years.
pub const WEEKLY_CANDLE_HISTORY: TimeDelta = TimeDelta::days(6 * 365);
