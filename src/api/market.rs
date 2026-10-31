use crate::app::AppState;
use crate::contracts::market::MarketHours;
use crate::utils::{MarketSchedule, MarketSession};
use axum::extract::State;
use axum::http::{HeaderName, StatusCode, header::CACHE_CONTROL};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, NaiveTime, TimeZone, Utc};
use serde::Serialize;

#[derive(Serialize)]
struct NextTradingDay {
    date: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/market/next-trading-day", get(next_trading_day))
        .route("/market/hours", get(hours))
}

fn market_hours(schedule: &MarketSchedule, now: DateTime<Utc>) -> anyhow::Result<MarketHours> {
    let market_date = schedule.market_date(now);
    let timezone = schedule.timezone();
    let closes_at = timezone
        .from_local_datetime(&market_date.and_time(schedule.close_time()))
        .latest()
        .ok_or_else(|| anyhow::anyhow!("Invalid market close time"))?
        .to_utc();
    let next_date = market_date
        .succ_opt()
        .ok_or_else(|| anyhow::anyhow!("Market date overflow"))?;
    let day_ends_at = timezone
        .from_local_datetime(&next_date.and_time(NaiveTime::MIN))
        .latest()
        .ok_or_else(|| anyhow::anyhow!("Invalid local midnight"))?
        .to_utc();
    Ok(MarketHours {
        market_date,
        time_zone: timezone.to_string(),
        is_trading_day: schedule.session(now) != MarketSession::Closed,
        closes_at,
        day_ends_at,
        server_time: now,
    })
}

async fn hours(
    State(state): State<AppState>,
) -> Result<([(HeaderName, &'static str); 1], Json<MarketHours>), StatusCode> {
    market_hours(&state.market_schedule, Utc::now())
        .map(|hours| ([(CACHE_CONTROL, "no-store")], Json(hours)))
        .map_err(|error| {
            tracing::error!(%error, "Could not determine market hours");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

async fn next_trading_day(State(state): State<AppState>) -> Json<NextTradingDay> {
    Json(NextTradingDay {
        date: state
            .market_schedule
            .next_trading_day_from_now(Utc::now())
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use chrono::NaiveDate;
    use std::{collections::HashSet, time::Duration};

    #[test]
    fn hours_follow_local_calendar_close_and_dst_midnight() {
        let config: Config = toml::from_str(include_str!("../../config.example.toml")).unwrap();
        let schedule = MarketSchedule::with_holidays(
            &config.market,
            Duration::ZERO,
            HashSet::from([NaiveDate::from_ymd_opt(2026, 7, 3).unwrap()]),
        )
        .unwrap();
        for (timestamp, expected_date, trading) in [
            ("2026-07-16T19:59:59Z", "2026-07-16", true),
            ("2026-07-17T06:59:59Z", "2026-07-16", true),
            ("2026-07-17T07:00:00Z", "2026-07-17", true),
            ("2026-07-18T07:00:00Z", "2026-07-18", false),
            ("2026-07-03T18:00:00Z", "2026-07-03", false),
        ] {
            let now = DateTime::parse_from_rfc3339(timestamp).unwrap().to_utc();
            let hours = market_hours(&schedule, now).unwrap();
            assert_eq!(hours.market_date.to_string(), expected_date);
            assert_eq!(hours.is_trading_day, trading);
            assert!(hours.day_ends_at > now);
            assert_eq!(hours.time_zone, "America/Los_Angeles");
            if expected_date == "2026-07-16" {
                assert_eq!(hours.closes_at.to_rfc3339(), "2026-07-16T20:00:00+00:00");
            }
        }
        let now = DateTime::parse_from_rfc3339("2026-03-08T08:00:00Z")
            .unwrap()
            .to_utc();
        assert_eq!(
            (market_hours(&schedule, now).unwrap().day_ends_at - now).num_hours(),
            23
        );
    }
}
