use crate::models::{Fundamentals, TickerSymbol};
use crate::services::details::TickerDetailsService;
use futures_util::{StreamExt, stream};
use serde::Serialize;
use std::sync::Arc;
use tracing::warn;

const LOAD_CONCURRENCY: usize = 8;
const EPS_WEIGHT: f64 = 0.6;
const REVENUE_WEIGHT: f64 = 0.4;

#[derive(Debug, Serialize)]
pub struct FundamentalScore {
    pub symbol: TickerSymbol,
    pub score: f64,
}

pub async fn load_scores(
    details: Arc<TickerDetailsService>,
    symbols: Vec<TickerSymbol>,
) -> Vec<FundamentalScore> {
    let mut scores = stream::iter(symbols.into_iter().map(|symbol| {
        let details = details.clone();
        async move {
            match details.details(&symbol, false).await {
                Ok(details) => {
                    calculate(&details.fundamentals).map(|score| FundamentalScore { symbol, score })
                }
                Err(error) => {
                    warn!(%symbol, %error, "failed to load fundamentals for FUN score");
                    None
                }
            }
        }
    }))
    .buffer_unordered(LOAD_CONCURRENCY)
    .filter_map(|score| async move { score })
    .collect::<Vec<_>>()
    .await;
    scores.sort_unstable_by(|left, right| left.symbol.cmp(&right.symbol));
    scores
}

fn calculate(fundamentals: &Fundamentals) -> Option<f64> {
    let latest = fundamentals.quarters.first()?;
    let comparison = fundamentals
        .quarters
        .get(if fundamentals.quarters.len() > 4 {
            4
        } else {
            1
        });
    let eps_growth = comparison
        .and_then(|quarter| growth(latest.earnings_per_share, quarter.earnings_per_share))
        .or_else(|| {
            growth(
                latest.earnings_per_share,
                latest.earnings_per_share_estimate,
            )
        });
    let revenue_growth = comparison
        .and_then(|quarter| growth(latest.revenue, quarter.revenue))
        .or_else(|| growth(latest.revenue, latest.revenue_estimate));

    weighted_score([(eps_growth, EPS_WEIGHT), (revenue_growth, REVENUE_WEIGHT)])
}

fn weighted_score(signals: [(Option<f64>, f64); 2]) -> Option<f64> {
    let available_weight = signals
        .iter()
        .filter_map(|(value, weight)| value.map(|_| weight))
        .sum::<f64>();
    if available_weight == 0.0 {
        return None;
    }
    Some(
        signals
            .iter()
            .filter_map(|(value, weight)| value.map(|value| normalize(value) * weight))
            .sum::<f64>()
            / available_weight,
    )
}

fn growth(current: Option<f64>, previous: Option<f64>) -> Option<f64> {
    let (current, previous) = current.zip(previous)?;
    Some(if previous.abs() < f64::EPSILON {
        current.signum()
    } else if previous < 0.0 {
        (current - previous) / previous.abs()
    } else {
        (current / previous) - 1.0
    })
}

fn normalize(growth: f64) -> f64 {
    (50.0 + growth * 100.0).clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Forecast, QuarterFundamentals};
    use chrono::Utc;

    #[test]
    fn uses_sequential_growth_when_yoy_history_is_unavailable() {
        let fundamentals = Fundamentals {
            symbol: TickerSymbol::parse("NEW").unwrap(),
            currency: None,
            quarters: vec![
                quarter(Some(1.25), Some(100.0)),
                quarter(Some(1.0), Some(80.0)),
            ],
            next_quarter: Forecast {
                earnings_per_share: None,
                revenue: None,
            },
            fetched_at: Utc::now(),
        };

        assert!(calculate(&fundamentals).unwrap() > 50.0);
    }

    #[test]
    fn improving_losses_are_positive_progress() {
        assert!(growth(Some(-0.5), Some(-1.0)).unwrap() > 0.0);
        assert!(growth(Some(0.25), Some(-1.0)).unwrap() > 1.0);
    }

    fn quarter(eps: Option<f64>, revenue: Option<f64>) -> QuarterFundamentals {
        QuarterFundamentals {
            fiscal_period: "Q".to_owned(),
            earnings_release_date: None,
            earnings_per_share: eps,
            earnings_per_share_estimate: None,
            revenue,
            revenue_estimate: None,
        }
    }
}
