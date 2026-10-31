use chrono::TimeDelta;

/// Calendar history retained/requested for roughly 500 trading sessions.
pub const DAILY_CANDLE_HISTORY: TimeDelta = TimeDelta::days(760);

/// Initial weekly-chart history requested for approximately six years.
pub const WEEKLY_CANDLE_HISTORY: TimeDelta = TimeDelta::days(6 * 365);
