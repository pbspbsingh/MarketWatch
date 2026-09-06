use crate::models::{Fundamentals, QuarterFundamentals, TickerSymbol};
use crate::services::details::TickerDetailsService;
use futures_util::{Stream, StreamExt, stream};
use serde::Serialize;
use std::cmp::Ordering;
use std::sync::Arc;
use tracing::warn;

const LOAD_CONCURRENCY: usize = 8;
const METRIC_WEIGHT: f64 = 0.5;
const ACCELERATION_WEIGHT: f64 = 0.35;
const QUARTERLY_GROWTH_WEIGHT: f64 = 0.15;
const YEARLY_GROWTH_WEIGHT: f64 = 0.15;
const LATEST_SURPRISE_WEIGHT: f64 = 0.20;
const PRIOR_EXECUTION_WEIGHT: f64 = 0.10;
const OUTLOOK_WEIGHT: f64 = 0.05;
const GROWTH_SENSITIVITY: f64 = 0.50;
const ACCELERATION_SENSITIVITY: f64 = 0.35;
const SURPRISE_SENSITIVITY: f64 = 0.20;
const NEUTRAL_SCORE: f64 = 50.0;

#[derive(Debug, Serialize)]
pub struct FundamentalScore {
    pub symbol: TickerSymbol,
    pub score: f64,
    pub eps_score: f64,
    pub revenue_score: f64,
    pub coverage: f64,
    pub reasons: Vec<String>,
}

#[derive(Clone, Copy)]
enum Metric {
    Eps,
    Revenue,
}

impl Metric {
    fn label(self) -> &'static str {
        match self {
            Self::Eps => "EPS",
            Self::Revenue => "Revenue",
        }
    }

    fn actual(self, quarter: &QuarterFundamentals) -> Option<f64> {
        finite(match self {
            Self::Eps => quarter.earnings_per_share,
            Self::Revenue => quarter.revenue,
        })
    }

    fn estimate(self, quarter: &QuarterFundamentals) -> Option<f64> {
        finite(match self {
            Self::Eps => quarter.earnings_per_share_estimate,
            Self::Revenue => quarter.revenue_estimate,
        })
    }

    fn forecast(self, fundamentals: &Fundamentals) -> Option<f64> {
        finite(match self {
            Self::Eps => fundamentals.next_quarter.earnings_per_share,
            Self::Revenue => fundamentals.next_quarter.revenue,
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct FiscalPeriod(i32);

impl FiscalPeriod {
    fn parse(value: &str) -> Option<Self> {
        let (year, quarter) = value.split_once('Q')?;
        let year = year.parse::<i32>().ok()?;
        let quarter = quarter.parse::<i32>().ok()?;
        (1..=4)
            .contains(&quarter)
            .then_some(Self(year.checked_mul(4)? + quarter - 1))
    }

    fn offset(self, quarters: i32) -> Option<Self> {
        self.0.checked_add(quarters).map(Self)
    }
}

struct ScoredComponent {
    score: f64,
    coverage: f64,
    weight: f64,
    reason: Option<String>,
}

struct MetricResult {
    score: f64,
    coverage: f64,
    latest_surprise: Option<f64>,
    reasons: Vec<(f64, String)>,
}

pub async fn load_scores(
    details: Arc<TickerDetailsService>,
    symbols: Vec<TickerSymbol>,
) -> Vec<FundamentalScore> {
    let mut scores = score_stream(details, symbols).collect::<Vec<_>>().await;
    scores.sort_unstable_by(|left, right| left.symbol.cmp(&right.symbol));
    scores
}

pub fn score_stream(
    details: Arc<TickerDetailsService>,
    symbols: Vec<TickerSymbol>,
) -> impl Stream<Item = FundamentalScore> {
    stream::iter(symbols.into_iter().map(move |symbol| {
        let details = details.clone();
        async move {
            match details.details(&symbol, false).await {
                Ok(details) => calculate(&details.fundamentals),
                Err(error) => {
                    warn!(%symbol, %error, "failed to load fundamentals for FUN score");
                    None
                }
            }
        }
    }))
    .buffer_unordered(LOAD_CONCURRENCY)
    .filter_map(|score| async move { score })
}

fn calculate(fundamentals: &Fundamentals) -> Option<FundamentalScore> {
    // Fiscal-period lookup prevents a missing quarter from silently turning a QoQ or YoY
    // comparison into the wrong interval. Missing components stay at 50 instead of having
    // their weights redistributed, so sparse companies cannot receive exaggerated scores.
    let latest_period = fundamentals
        .quarters
        .iter()
        .filter_map(|quarter| FiscalPeriod::parse(&quarter.fiscal_period))
        .max()?;
    let eps = score_metric(fundamentals, latest_period, Metric::Eps);
    let revenue = score_metric(fundamentals, latest_period, Metric::Revenue);
    let coverage = eps.coverage * METRIC_WEIGHT + revenue.coverage * METRIC_WEIGHT;
    if coverage == 0.0 {
        return None;
    }

    // EPS and revenue deliberately remain equal partners. Revenue confirmation reduces the
    // chance that EPS momentum caused only by expense changes dominates the final rating.
    let score = eps.score * METRIC_WEIGHT + revenue.score * METRIC_WEIGHT;
    let reasons = build_reasons(&eps, &revenue);

    Some(FundamentalScore {
        symbol: fundamentals.symbol.clone(),
        score: round(score, 1),
        eps_score: round(eps.score, 1),
        revenue_score: round(revenue.score, 1),
        coverage: round(coverage, 2),
        reasons,
    })
}

fn score_metric(
    fundamentals: &Fundamentals,
    latest_period: FiscalPeriod,
    metric: Metric,
) -> MetricResult {
    // Symmetric change is bounded and treats loss improvement correctly. The ticker's median
    // historical magnitude is the denominator floor, preventing tiny near-zero EPS values from
    // producing an extreme score. tanh then maps each signal smoothly onto the absolute 0-100 scale.
    let scale = median_magnitude(fundamentals, metric);
    let latest = quarter(fundamentals, latest_period);
    let previous = latest_period
        .offset(-1)
        .and_then(|period| quarter(fundamentals, period));
    let year_ago = latest_period
        .offset(-4)
        .and_then(|period| quarter(fundamentals, period));
    let previous_year_ago = latest_period
        .offset(-5)
        .and_then(|period| quarter(fundamentals, period));

    let latest_yoy = change_between(metric, latest, year_ago, scale);
    let previous_yoy = change_between(metric, previous, previous_year_ago, scale);
    let acceleration = latest_yoy
        .zip(previous_yoy)
        .map(|(latest, previous)| latest - previous);
    let quarterly_growth = change_between(metric, latest, previous, scale);
    let latest_surprise = latest.and_then(|quarter| {
        symmetric_change(metric.actual(quarter)?, metric.estimate(quarter)?, scale)
    });

    let acceleration_reason = acceleration_reason(
        metric,
        latest.and_then(|quarter| metric.actual(quarter)),
        year_ago.and_then(|quarter| metric.actual(quarter)),
        previous.and_then(|quarter| metric.actual(quarter)),
        previous_year_ago.and_then(|quarter| metric.actual(quarter)),
        acceleration,
    );
    let quarterly_reason = growth_reason(
        metric,
        "quarter over quarter",
        latest.and_then(|quarter| metric.actual(quarter)),
        previous.and_then(|quarter| metric.actual(quarter)),
    );
    let yearly_reason = growth_reason(
        metric,
        "year over year",
        latest.and_then(|quarter| metric.actual(quarter)),
        year_ago.and_then(|quarter| metric.actual(quarter)),
    );
    let surprise_reason = latest.and_then(|quarter| {
        surprise_reason(metric, metric.actual(quarter)?, metric.estimate(quarter)?)
    });

    let mut components = vec![
        component(
            acceleration,
            ACCELERATION_SENSITIVITY,
            ACCELERATION_WEIGHT,
            acceleration_reason,
        ),
        component(
            quarterly_growth,
            GROWTH_SENSITIVITY,
            QUARTERLY_GROWTH_WEIGHT,
            quarterly_reason,
        ),
        component(
            latest_yoy,
            GROWTH_SENSITIVITY,
            YEARLY_GROWTH_WEIGHT,
            yearly_reason,
        ),
        component(
            latest_surprise,
            SURPRISE_SENSITIVITY,
            LATEST_SURPRISE_WEIGHT,
            surprise_reason,
        ),
        prior_execution_component(fundamentals, latest_period, metric, scale),
        outlook_component(fundamentals, latest_period, metric, scale),
    ];

    let score = components
        .iter()
        .map(|component| component.score * component.weight)
        .sum();
    let coverage = components
        .iter()
        .map(|component| component.coverage * component.weight)
        .sum();
    let reasons = components
        .drain(..)
        .filter_map(|component| {
            component.reason.map(|reason| {
                (
                    (component.score - NEUTRAL_SCORE) * component.weight * METRIC_WEIGHT,
                    reason,
                )
            })
        })
        .collect();

    MetricResult {
        score,
        coverage,
        latest_surprise,
        reasons,
    }
}

fn build_reasons(eps: &MetricResult, revenue: &MetricResult) -> Vec<String> {
    // Agreement between the latest EPS and revenue surprises is surfaced first because research
    // treats revenue confirmation as materially stronger than an isolated earnings beat or miss.
    let mut reasons = Vec::new();
    if let Some((eps_surprise, revenue_surprise)) = eps.latest_surprise.zip(revenue.latest_surprise)
    {
        if eps_surprise > 0.0 && revenue_surprise > 0.0 {
            reasons.push("EPS and revenue both exceeded their latest estimates.".to_owned());
        } else if eps_surprise < 0.0 && revenue_surprise < 0.0 {
            reasons.push("EPS and revenue both missed their latest estimates.".to_owned());
        }
    }

    // EPS and revenue each receive an explanation slot when available, matching their equal score
    // weights. The remaining slot still surfaces the strongest unused positive or negative driver.
    let mut eps_candidates = eps
        .reasons
        .iter()
        .filter(|(impact, _)| impact.abs() >= 0.25)
        .collect::<Vec<_>>();
    let mut revenue_candidates = revenue
        .reasons
        .iter()
        .filter(|(impact, _)| impact.abs() >= 0.25)
        .collect::<Vec<_>>();
    let by_absolute_impact = |left: &&(f64, String), right: &&(f64, String)| {
        right
            .0
            .abs()
            .partial_cmp(&left.0.abs())
            .unwrap_or(Ordering::Equal)
    };
    eps_candidates.sort_by(by_absolute_impact);
    revenue_candidates.sort_by(by_absolute_impact);

    for candidate in [eps_candidates.first(), revenue_candidates.first()]
        .into_iter()
        .flatten()
    {
        let candidate = &candidate.1;
        if reasons.len() < 3 && !reasons.contains(candidate) {
            reasons.push(candidate.clone());
        }
    }

    let mut remaining = eps_candidates
        .into_iter()
        .chain(revenue_candidates)
        .collect::<Vec<_>>();
    remaining.sort_by(by_absolute_impact);
    for (_, candidate) in remaining {
        if reasons.len() == 3 {
            break;
        }
        if !reasons.contains(candidate) {
            reasons.push(candidate.clone());
        }
    }
    if reasons.is_empty() {
        reasons.push("Available EPS and revenue signals are neutral or mixed.".to_owned());
    }
    reasons
}

fn component(
    raw: Option<f64>,
    sensitivity: f64,
    weight: f64,
    reason: Option<String>,
) -> ScoredComponent {
    ScoredComponent {
        score: raw.map_or(NEUTRAL_SCORE, |value| normalize(value, sensitivity)),
        coverage: f64::from(raw.is_some()),
        weight,
        reason: raw.and(reason),
    }
}

fn prior_execution_component(
    fundamentals: &Fundamentals,
    latest_period: FiscalPeriod,
    metric: Metric,
    scale: f64,
) -> ScoredComponent {
    let recency_weights = [(1, 0.5), (2, 0.3), (3, 0.2)];
    let mut score = 0.0;
    let mut coverage = 0.0;
    let mut beats = 0;
    let mut observations = 0;
    for (offset, weight) in recency_weights {
        let surprise = latest_period
            .offset(-offset)
            .and_then(|period| quarter(fundamentals, period))
            .and_then(|quarter| {
                let actual = metric.actual(quarter)?;
                let estimate = metric.estimate(quarter)?;
                observations += 1;
                beats += usize::from(actual > estimate);
                symmetric_change(actual, estimate, scale)
            });
        score += surprise.map_or(NEUTRAL_SCORE, |value| {
            normalize(value, SURPRISE_SENSITIVITY)
        }) * weight;
        coverage += f64::from(surprise.is_some()) * weight;
    }

    ScoredComponent {
        score,
        coverage,
        weight: PRIOR_EXECUTION_WEIGHT,
        reason: (observations > 0).then(|| {
            format!(
                "{} beat estimates in {beats} of {observations} prior quarters.",
                metric.label()
            )
        }),
    }
}

fn outlook_component(
    fundamentals: &Fundamentals,
    latest_period: FiscalPeriod,
    metric: Metric,
    scale: f64,
) -> ScoredComponent {
    let forecast_period = fundamentals
        .next_quarter
        .fiscal_period
        .as_deref()
        .and_then(FiscalPeriod::parse);
    let valid_forecast = forecast_period == latest_period.offset(1);
    let comparison = latest_period
        .offset(-3)
        .and_then(|period| quarter(fundamentals, period))
        .and_then(|quarter| metric.actual(quarter));
    let forecast = valid_forecast
        .then(|| metric.forecast(fundamentals))
        .flatten();
    let raw = forecast
        .zip(comparison)
        .and_then(|(forecast, comparison)| symmetric_change(forecast, comparison, scale));

    component(
        raw,
        GROWTH_SENSITIVITY,
        OUTLOOK_WEIGHT,
        forecast.zip(comparison).map(|(forecast, comparison)| {
            growth_reason_values(metric, "in its next-quarter outlook", forecast, comparison)
        }),
    )
}

fn quarter(fundamentals: &Fundamentals, period: FiscalPeriod) -> Option<&QuarterFundamentals> {
    fundamentals
        .quarters
        .iter()
        .find(|quarter| FiscalPeriod::parse(&quarter.fiscal_period) == Some(period))
}

fn change_between(
    metric: Metric,
    current: Option<&QuarterFundamentals>,
    previous: Option<&QuarterFundamentals>,
    scale: f64,
) -> Option<f64> {
    symmetric_change(metric.actual(current?)?, metric.actual(previous?)?, scale)
}

fn symmetric_change(current: f64, previous: f64, scale: f64) -> Option<f64> {
    if !current.is_finite() || !previous.is_finite() || !scale.is_finite() {
        return None;
    }
    let denominator = (current.abs() + previous.abs()).max(scale);
    if denominator <= f64::EPSILON {
        return Some(0.0);
    }
    Some((2.0 * (current - previous) / denominator).clamp(-2.0, 2.0))
}

fn median_magnitude(fundamentals: &Fundamentals, metric: Metric) -> f64 {
    let mut values = fundamentals
        .quarters
        .iter()
        .filter_map(|quarter| metric.actual(quarter))
        .map(f64::abs)
        .collect::<Vec<_>>();
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(Ordering::Equal));
    match values.len() {
        0 => 0.0,
        len if len % 2 == 1 => values[len / 2],
        len => (values[len / 2 - 1] + values[len / 2]) / 2.0,
    }
}

fn normalize(value: f64, sensitivity: f64) -> f64 {
    NEUTRAL_SCORE + NEUTRAL_SCORE * (value / sensitivity).tanh()
}

fn finite(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite())
}

fn acceleration_reason(
    metric: Metric,
    latest: Option<f64>,
    year_ago: Option<f64>,
    previous: Option<f64>,
    previous_year_ago: Option<f64>,
    acceleration: Option<f64>,
) -> Option<String> {
    let (latest, year_ago, previous, previous_year_ago, acceleration) = latest
        .zip(year_ago)
        .zip(previous)
        .zip(previous_year_ago)
        .zip(acceleration)
        .map(
            |((((latest, year_ago), previous), previous_year_ago), acceleration)| {
                (latest, year_ago, previous, previous_year_ago, acceleration)
            },
        )?;
    let latest_growth = conventional_growth(latest, year_ago);
    let previous_growth = conventional_growth(previous, previous_year_ago);
    match latest_growth.zip(previous_growth) {
        Some((latest_growth, previous_growth)) => Some(format!(
            "{} YoY growth {} from {} to {}.",
            metric.label(),
            if acceleration >= 0.0 {
                "accelerated"
            } else {
                "decelerated"
            },
            format_percent(previous_growth),
            format_percent(latest_growth),
        )),
        None => Some(format!(
            "{} YoY trend {} across a profit/loss transition.",
            metric.label(),
            if acceleration >= 0.0 {
                "improved"
            } else {
                "weakened"
            },
        )),
    }
}

fn growth_reason(
    metric: Metric,
    horizon: &str,
    current: Option<f64>,
    previous: Option<f64>,
) -> Option<String> {
    current
        .zip(previous)
        .map(|(current, previous)| growth_reason_values(metric, horizon, current, previous))
}

fn growth_reason_values(metric: Metric, horizon: &str, current: f64, previous: f64) -> String {
    conventional_growth(current, previous).map_or_else(
        || {
            format!(
                "{} {} from {} to {} {}.",
                metric.label(),
                if current >= previous {
                    "improved"
                } else {
                    "weakened"
                },
                format_value(metric, previous),
                format_value(metric, current),
                horizon,
            )
        },
        |growth| {
            format!(
                "{} {} {} {}.",
                metric.label(),
                if growth >= 0.0 { "grew" } else { "declined" },
                format_percent(growth.abs()),
                horizon,
            )
        },
    )
}

fn surprise_reason(metric: Metric, actual: f64, estimate: f64) -> Option<String> {
    conventional_growth(actual, estimate).map_or_else(
        || {
            Some(format!(
                "{} reported {} versus a {} estimate.",
                metric.label(),
                format_value(metric, actual),
                format_value(metric, estimate),
            ))
        },
        |surprise| {
            Some(format!(
                "{} {} its latest estimate by {}.",
                metric.label(),
                if surprise >= 0.0 { "beat" } else { "missed" },
                format_percent(surprise.abs()),
            ))
        },
    )
}

fn conventional_growth(current: f64, previous: f64) -> Option<f64> {
    (previous > 0.0).then_some((current / previous) - 1.0)
}

fn format_percent(value: f64) -> String {
    format!("{:.1}%", value * 100.0)
}

fn format_value(metric: Metric, value: f64) -> String {
    match metric {
        Metric::Eps => format!("{value:.2}"),
        Metric::Revenue if value.abs() >= 1_000_000_000.0 => {
            format!("{:.2}B", value / 1_000_000_000.0)
        }
        Metric::Revenue if value.abs() >= 1_000_000.0 => {
            format!("{:.1}M", value / 1_000_000.0)
        }
        Metric::Revenue => format!("{value:.0}"),
    }
}

fn round(value: f64, decimal_places: i32) -> f64 {
    let factor = 10_f64.powi(decimal_places);
    (value * factor).round() / factor
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Forecast;
    use chrono::Utc;

    #[test]
    fn equally_weights_eps_and_revenue() {
        let score = calculate(&complete_fundamentals()).unwrap();

        assert!((score.score - (score.eps_score + score.revenue_score) / 2.0).abs() <= 0.1);
        assert_eq!(score.coverage, 1.0);
    }

    #[test]
    fn reasoning_represents_eps_and_revenue() {
        let score = calculate(&complete_fundamentals()).unwrap();

        assert!(
            score
                .reasons
                .iter()
                .any(|reason| reason.starts_with("EPS "))
        );
        assert!(
            score
                .reasons
                .iter()
                .any(|reason| reason.starts_with("Revenue "))
        );
    }

    #[test]
    fn acceleration_is_the_largest_component() {
        let accelerating = complete_fundamentals();
        let mut decelerating = complete_fundamentals();
        decelerating.quarters[0].earnings_per_share = Some(0.8);
        decelerating.quarters[0].revenue = Some(80.0);

        let accelerating = calculate(&accelerating).unwrap();
        let decelerating = calculate(&decelerating).unwrap();

        assert!(accelerating.score > decelerating.score);
        assert!(
            accelerating
                .reasons
                .iter()
                .any(|reason| reason.contains("accelerated"))
        );
    }

    #[test]
    fn missing_fiscal_period_is_neutral_instead_of_using_the_wrong_quarter() {
        let mut fundamentals = complete_fundamentals();
        fundamentals
            .quarters
            .retain(|quarter| quarter.fiscal_period != "2025Q1");

        let score = calculate(&fundamentals).unwrap();

        assert_eq!(score.coverage, 0.65);
        assert!(
            !score
                .reasons
                .iter()
                .any(|reason| reason.contains("YoY growth accelerated"))
        );
    }

    #[test]
    fn ignores_outlook_when_forecast_is_not_the_next_fiscal_period() {
        let mut fundamentals = complete_fundamentals();
        fundamentals.next_quarter.fiscal_period = Some("2027Q1".to_owned());

        let score = calculate(&fundamentals).unwrap();

        assert_eq!(score.coverage, 0.95);
    }

    #[test]
    fn loss_improvement_and_zero_revenue_remain_finite() {
        let mut fundamentals = complete_fundamentals();
        fundamentals.quarters[0].earnings_per_share = Some(0.1);
        fundamentals.quarters[4].earnings_per_share = Some(-0.5);
        fundamentals.quarters[0].revenue = Some(0.0);
        fundamentals.quarters[1].revenue = Some(0.0);

        let score = calculate(&fundamentals).unwrap();

        assert!(score.score.is_finite());
        assert!((0.0..=100.0).contains(&score.score));
    }

    fn complete_fundamentals() -> Fundamentals {
        Fundamentals {
            symbol: TickerSymbol::parse("TEST").unwrap(),
            currency: None,
            annual: Some(Vec::new()),
            quarters: vec![
                quarter("2026Q2", 1.50, 1.30, 150.0, 140.0),
                quarter("2026Q1", 1.10, 1.00, 110.0, 105.0),
                quarter("2025Q4", 0.95, 0.90, 100.0, 98.0),
                quarter("2025Q3", 0.85, 0.80, 90.0, 88.0),
                quarter("2025Q2", 1.00, 0.95, 100.0, 97.0),
                quarter("2025Q1", 0.90, 0.85, 95.0, 92.0),
                quarter("2024Q4", 0.80, 0.75, 85.0, 82.0),
                quarter("2024Q3", 0.70, 0.65, 80.0, 78.0),
            ],
            next_quarter: Forecast {
                fiscal_period: Some("2026Q3".to_owned()),
                earnings_release_date: None,
                earnings_per_share: Some(1.20),
                revenue: Some(120.0),
            },
            fetched_at: Utc::now(),
        }
    }

    fn quarter(
        fiscal_period: &str,
        eps: f64,
        eps_estimate: f64,
        revenue: f64,
        revenue_estimate: f64,
    ) -> QuarterFundamentals {
        QuarterFundamentals {
            fiscal_period: fiscal_period.to_owned(),
            earnings_release_date: None,
            earnings_per_share: Some(eps),
            earnings_per_share_estimate: Some(eps_estimate),
            revenue: Some(revenue),
            revenue_estimate: Some(revenue_estimate),
        }
    }
}
