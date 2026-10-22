use crate::models::TickerSymbol;
use chrono::{DateTime, NaiveDate, Utc};
use chrono_tz::America::New_York;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, str::FromStr};

pub const SCALE: i64 = 1_000_000;
const MAX_UNITS: i64 = 1_000_000_000_000;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    #[default]
    Long,
    Short,
}
impl FromStr for Direction {
    type Err = &'static str;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "long" => Ok(Self::Long),
            "short" => Ok(Self::Short),
            _ => Err("Invalid trade direction"),
        }
    }
}
impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Long => "long",
            Self::Short => "short",
        }
    }
    pub fn entry_side(self) -> Side {
        match self {
            Self::Long => Side::Buy,
            Self::Short => Side::Sell,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}
impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Buy => "buy",
            Self::Sell => "sell",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ExecutionInput {
    pub id: Option<i64>,
    pub executed_at: DateTime<Utc>,
    pub side: Side,
    pub quantity: String,
    pub price: String,
    #[serde(default = "zero")]
    pub fee: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
}
fn zero() -> String {
    "0".into()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct TradeInput {
    pub revision: Option<i64>,
    pub symbol: TickerSymbol,
    #[serde(default)]
    pub direction: Direction,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
    pub executions: Vec<ExecutionInput>,
}

#[derive(Clone, Debug)]
pub struct ExecutionValue {
    pub input: ExecutionInput,
    pub quantity: i64,
    pub price: i64,
    pub fee: i64,
}
#[derive(Clone, Debug)]
pub struct ValidatedTrade {
    pub input: TradeInput,
    pub executions: Vec<ExecutionValue>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Execution {
    #[serde(flatten)]
    pub input: ExecutionInput,
    pub market_date: String,
    pub action: &'static str,
    pub remaining_quantity: String,
    pub realized_pnl: String,
    pub net_return_percent: Option<f64>,
}
#[derive(Clone, Debug, Serialize)]
pub struct TradeSummary {
    pub status: &'static str,
    pub remaining_quantity: String,
    pub average_cost: Option<String>,
    pub average_entry_price: String,
    pub realized_pnl: String,
    pub realized_return_percent: Option<f64>,
    pub fees: String,
    pub entry_notional: String,
    pub net_return_percent: Option<f64>,
    pub opened_at: DateTime<Utc>,
    pub closed_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Trade {
    pub id: i64,
    pub revision: i64,
    pub symbol: TickerSymbol,
    pub direction: Direction,
    pub notes: String,
    pub tag_ids: Vec<i64>,
    pub executions: Vec<Execution>,
    pub summary: TradeSummary,
    #[serde(skip)]
    pub net_cash: i128,
    #[serde(skip)]
    pub remaining_basis: i128,
    #[serde(skip)]
    pub raw_realized_pnl: i128,
    #[serde(skip)]
    pub gross_entry_notional: i128,
}

#[derive(Clone, Debug, Serialize)]
pub struct Valuation {
    pub trade_id: i64,
    pub revision: i64,
    pub mark_price: Option<String>,
    pub mark_date: Option<NaiveDate>,
    pub unrealized_pnl: Option<String>,
    pub total_pnl: Option<String>,
    pub net_return_percent: Option<f64>,
}

pub fn value_open_trade(trade: &Trade, mark: Option<(i64, NaiveDate)>) -> Valuation {
    let mark = mark.filter(|(price, date)| {
        *price > 0
            && trade
                .executions
                .last()
                .is_some_and(|leg| date.to_string() >= leg.market_date)
    });
    let unrealized = mark.map(|(price, _)| {
        let quantity = trade.executions.iter().fold(0_i128, |quantity, leg| {
            let units =
                parse_decimal(&leg.input.quantity).expect("validated execution quantity") as i128;
            if leg.input.side == trade.direction.entry_side() {
                quantity + units
            } else {
                quantity - units
            }
        });
        let market_value = quantity * price as i128;
        match trade.direction {
            Direction::Long => market_value - trade.remaining_basis,
            Direction::Short => trade.remaining_basis - market_value,
        }
    });
    let total = unrealized.map(|value| value + trade.raw_realized_pnl);
    Valuation {
        trade_id: trade.id,
        revision: trade.revision,
        mark_price: mark.map(|(price, _)| decimal(price)),
        mark_date: mark.map(|(_, date)| date),
        unrealized_pnl: unrealized.map(cash),
        total_pnl: total.map(cash),
        net_return_percent: total
            .map(|total| total as f64 / trade.gross_entry_notional as f64 * 100.0),
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub revision: i64,
    pub trade_count: usize,
    pub execution_count: usize,
}
#[derive(Debug, Deserialize)]
pub struct TagInput {
    pub name: String,
    pub description: Option<String>,
    pub revision: Option<i64>,
}

pub fn parse_decimal(value: &str) -> Result<i64, String> {
    let text = value.trim();
    if text.is_empty() || text.len() > 24 {
        return Err("Enter a decimal amount with at most 6 decimal places".into());
    }
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    if (whole.is_empty() && fraction.is_empty())
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > 6
    {
        return Err("Amounts must be positive decimals with at most 6 decimal places".into());
    }
    let whole: i64 = if whole.is_empty() {
        0
    } else {
        whole.parse().map_err(|_| "Amount is too large")?
    };
    let fraction: i64 = if fraction.is_empty() {
        0
    } else {
        fraction.parse().map_err(|_| "Invalid decimal amount")?
    };
    let fractional_places = text.split_once('.').map_or(0, |(_, digits)| digits.len());
    let units = whole
        .checked_mul(SCALE)
        .and_then(|n| n.checked_add(fraction * 10_i64.pow(6 - fractional_places as u32)));
    match units {
        Some(n) if n <= MAX_UNITS => Ok(n),
        _ => Err("Each amount must be at most 1,000,000".into()),
    }
}

pub fn decimal(units: i64) -> String {
    scaled(units as i128, SCALE as i128, 6)
}
fn scaled(value: i128, scale: i128, digits: usize) -> String {
    let sign = if value < 0 { "-" } else { "" };
    let value = value.abs();
    let fraction = format!("{:0width$}", value % scale, width = digits);
    let fraction = fraction.trim_end_matches('0');
    if fraction.is_empty() {
        format!("{sign}{}", value / scale)
    } else {
        format!("{sign}{}.{}", value / scale, fraction)
    }
}
/// Cash is accumulated in trillionths of a dollar. Round only at the API boundary,
/// to six decimal places, with ties away from zero.
pub fn cash(value: i128) -> String {
    let rounded = (value.abs() + SCALE as i128 / 2) / SCALE as i128;
    scaled(if value < 0 { -rounded } else { rounded }, SCALE as i128, 6)
}
fn tags(ids: &mut Vec<i64>) -> Result<(), String> {
    if ids.len() > 50 || ids.iter().any(|id| *id <= 0) {
        return Err("Choose up to 50 valid tags".into());
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(())
}

pub fn validate(mut input: TradeInput) -> Result<ValidatedTrade, String> {
    if input.symbol.as_str().len() > 32 {
        return Err("Ticker is too long".into());
    }
    if input.notes.len() > 50_000 {
        return Err("Trade notes are too long".into());
    }
    if input.executions.is_empty() || input.executions.len() > 500 {
        return Err("A trade needs between 1 and 500 executions".into());
    }
    tags(&mut input.tag_ids)?;
    let mut ids = HashSet::new();
    let mut executions = Vec::with_capacity(input.executions.len());
    // Stable sorting preserves user-defined order for identical timestamps.
    input.executions.sort_by_key(|leg| leg.executed_at);
    for (index, leg) in input.executions.iter_mut().enumerate() {
        if let Some(id) = leg.id
            && (id <= 0 || !ids.insert(id))
        {
            return Err("Execution IDs must be unique".into());
        }
        if leg.executed_at > Utc::now() {
            return Err(format!("Execution {} cannot be in the future", index + 1));
        }
        if leg.executed_at.timestamp() < 0 {
            return Err("Execution dates must be after 1970".into());
        }
        if leg.notes.len() > 10_000 {
            return Err("Execution notes are too long".into());
        }
        tags(&mut leg.tag_ids)?;
        let quantity = parse_decimal(&leg.quantity)
            .map_err(|e| format!("Execution {} quantity: {e}", index + 1))?;
        let price =
            parse_decimal(&leg.price).map_err(|e| format!("Execution {} price: {e}", index + 1))?;
        let fee =
            parse_decimal(&leg.fee).map_err(|e| format!("Execution {} fee: {e}", index + 1))?;
        if quantity == 0 || price == 0 {
            return Err(format!(
                "Execution {} needs a positive quantity and price",
                index + 1
            ));
        }
        leg.quantity = decimal(quantity);
        leg.price = decimal(price);
        leg.fee = decimal(fee);
        executions.push(ExecutionValue {
            input: leg.clone(),
            quantity,
            price,
            fee,
        });
    }
    let validated = ValidatedTrade { input, executions };
    calculate(0, 1, &validated)?;
    Ok(validated)
}

/// Allocate with sub-micro-dollar precision while avoiding intermediate overflow.
/// The final exit consumes the entire remaining basis.
fn allocate_basis(basis: i128, quantity: i64, exiting: i64) -> i128 {
    let quantity = quantity as i128;
    let exiting = exiting as i128;
    basis / quantity * exiting + basis % quantity * exiting / quantity
}

pub fn calculate(id: i64, revision: i64, trade: &ValidatedTrade) -> Result<Trade, String> {
    let direction = trade.input.direction;
    let mut quantity = 0_i64;
    let mut basis = 0_i128;
    let mut realized = 0_i128;
    let mut fees = 0_i128;
    let mut entry_notional = 0_i128;
    let mut remaining_entry_notional = 0_i128;
    let mut entry_quantity = 0_i128;
    let mut executions = Vec::with_capacity(trade.executions.len());
    for (index, leg) in trade.executions.iter().enumerate() {
        let cost = leg.quantity as i128 * leg.price as i128;
        let fee = leg.fee as i128 * SCALE as i128;
        fees += fee;
        let (action, pnl, net_return_percent) = if leg.input.side == direction.entry_side() {
            entry_notional += cost;
            remaining_entry_notional += cost;
            entry_quantity += leg.quantity as i128;
            if quantity == 0 && index > 0 {
                return Err(
                    "A trade ends when flat. Record a subsequent entry as a new trade".into(),
                );
            }
            let action = if quantity == 0 { "Open" } else { "Add" };
            quantity = quantity
                .checked_add(leg.quantity)
                .ok_or("Position size is too large")?;
            basis += match direction {
                Direction::Long => cost + fee,
                Direction::Short => cost - fee,
            };
            (action, 0, None)
        } else {
            if leg.quantity > quantity {
                let operation = match direction {
                    Direction::Long => "sells more shares than held",
                    Direction::Short => "covers more shares than shorted",
                };
                return Err(format!("Execution {} {operation} at that time", index + 1));
            }
            let allocated = allocate_basis(basis, quantity, leg.quantity);
            let exited_entry_notional =
                allocate_basis(remaining_entry_notional, quantity, leg.quantity);
            let pnl = match direction {
                Direction::Long => cost - allocated - fee,
                Direction::Short => allocated - cost - fee,
            };
            basis -= allocated;
            remaining_entry_notional -= exited_entry_notional;
            quantity -= leg.quantity;
            realized += pnl;
            (
                if quantity == 0 { "Close" } else { "Reduce" },
                pnl,
                (exited_entry_notional > 0)
                    .then(|| pnl as f64 / exited_entry_notional as f64 * 100.0),
            )
        };
        executions.push(Execution {
            input: leg.input.clone(),
            market_date: leg
                .input
                .executed_at
                .with_timezone(&New_York)
                .date_naive()
                .to_string(),
            action,
            remaining_quantity: decimal(quantity),
            realized_pnl: cash(pnl),
            net_return_percent,
        });
    }
    let first = trade
        .executions
        .first()
        .ok_or("A trade needs an execution")?;
    let last = trade
        .executions
        .last()
        .ok_or("A trade needs an execution")?;
    let realized_entry_notional = entry_notional - remaining_entry_notional;
    Ok(Trade {
        id,
        revision,
        symbol: trade.input.symbol.clone(),
        direction,
        notes: trade.input.notes.clone(),
        tag_ids: trade.input.tag_ids.clone(),
        executions,
        summary: TradeSummary {
            status: if quantity == 0 { "closed" } else { "open" },
            remaining_quantity: decimal(quantity),
            average_cost: (quantity > 0).then(|| cash(basis * SCALE as i128 / quantity as i128)),
            average_entry_price: cash(entry_notional * SCALE as i128 / entry_quantity),
            realized_pnl: cash(realized),
            realized_return_percent: (realized_entry_notional > 0)
                .then(|| realized as f64 / realized_entry_notional as f64 * 100.0),
            fees: cash(fees),
            entry_notional: cash(entry_notional),
            net_return_percent: (quantity == 0)
                .then(|| realized as f64 / entry_notional as f64 * 100.0),
            opened_at: first.input.executed_at,
            closed_at: (quantity == 0).then_some(last.input.executed_at),
        },
        net_cash: ((realized.abs() + SCALE as i128 / 2) / SCALE as i128)
            * SCALE as i128
            * realized.signum(),
        remaining_basis: basis,
        raw_realized_pnl: realized,
        gross_entry_notional: entry_notional,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use chrono::Duration;

    pub fn input(legs: &[(Side, &str, &str, &str)]) -> TradeInput {
        TradeInput {
            revision: None,
            symbol: TickerSymbol::parse("AAPL").unwrap(),
            direction: Direction::Long,
            notes: String::new(),
            tag_ids: vec![],
            executions: legs
                .iter()
                .enumerate()
                .map(|(index, (side, quantity, price, fee))| ExecutionInput {
                    id: None,
                    executed_at: DateTime::parse_from_rfc3339(&format!(
                        "2025-01-{:02}T16:00:00Z",
                        index + 1
                    ))
                    .unwrap()
                    .with_timezone(&Utc),
                    side: *side,
                    quantity: (*quantity).into(),
                    price: (*price).into(),
                    fee: (*fee).into(),
                    notes: String::new(),
                    tag_ids: vec![],
                })
                .collect(),
        }
    }
    fn result(input: TradeInput) -> Trade {
        calculate(1, 1, &validate(input).unwrap()).unwrap()
    }
    #[test]
    fn exact_decimals_and_rounding() {
        for (value, expected) in [
            (".5", 500_000),
            ("1.000001", 1_000_001),
            ("1000000", MAX_UNITS),
            ("000.10", 100_000),
            ("0", 0),
        ] {
            assert_eq!(parse_decimal(value).unwrap(), expected);
            assert_eq!(parse_decimal(&decimal(expected)).unwrap(), expected);
        }
        for value in [
            "",
            ".",
            "-1",
            "NaN",
            "1e2",
            "1.1234567",
            "1.2.3",
            "1000000.000001",
            "999999999999999999999",
        ] {
            assert!(parse_decimal(value).is_err(), "{value}");
        }
        assert_eq!(cash(500_000), "0.000001");
        assert_eq!(cash(-500_000), "-0.000001");
        assert_eq!(cash(499_999), "0");
    }
    #[test]
    fn partials_allocate_entry_fees_and_conserve_cash() {
        let trade = result(input(&[
            (Side::Buy, "100", "10", "1"),
            (Side::Buy, "100", "20", "1"),
            (Side::Sell, "50", "25", "2"),
            (Side::Sell, "150", "30", "3"),
        ]));
        assert_eq!(
            trade
                .executions
                .iter()
                .map(|e| e.action)
                .collect::<Vec<_>>(),
            ["Open", "Add", "Reduce", "Close"]
        );
        assert_eq!(trade.executions[2].realized_pnl, "497.5");
        assert_eq!(trade.executions[3].realized_pnl, "2245.5");
        assert!(
            (trade.executions[2].net_return_percent.unwrap() - 497.5 / 750.0 * 100.0).abs() < 1e-9
        );
        assert!((trade.executions[3].net_return_percent.unwrap() - 99.8).abs() < 1e-9);
        assert_eq!(
            trade.summary.realized_return_percent,
            trade.summary.net_return_percent
        );
        assert_eq!(trade.summary.realized_pnl, "2743");
        assert_eq!(trade.summary.fees, "7");
        assert_eq!(trade.summary.status, "closed");
        assert_eq!(trade.summary.remaining_quantity, "0");
        assert!(trade.summary.average_cost.is_none());
    }
    #[test]
    fn fractional_partials_and_reopening_recompute_from_source() {
        let mut value = input(&[
            (Side::Buy, "0.3", "10", "0.01"),
            (Side::Sell, "0.1", "11", "0.001"),
            (Side::Buy, "0.1", "12", "0"),
            (Side::Sell, "0.3", "13", "0.002"),
        ]);
        assert_eq!(result(value.clone()).summary.realized_pnl, "0.787");
        value.executions.pop();
        let reopened = result(value);
        assert_eq!(reopened.summary.status, "open");
        assert_eq!(reopened.summary.remaining_quantity, "0.3");
        assert_eq!(reopened.summary.average_cost.as_deref(), Some("10.688889"));
        assert_eq!(reopened.summary.realized_pnl, "0.095667");
        assert!(reopened.summary.closed_at.is_none());
    }
    #[test]
    fn rejects_invalid_position_history() {
        for legs in [
            vec![(Side::Sell, "1", "10", "0")],
            vec![(Side::Buy, "1", "10", "0"), (Side::Sell, "2", "10", "0")],
            vec![
                (Side::Buy, "1", "10", "0"),
                (Side::Sell, "1", "10", "0"),
                (Side::Buy, "1", "10", "0"),
            ],
            vec![(Side::Buy, "0", "10", "0")],
            vec![(Side::Buy, "1", "0", "0")],
        ] {
            assert!(validate(input(&legs)).is_err());
        }
    }
    #[test]
    fn stable_timestamp_order_and_market_timezone() {
        let mut value = input(&[(Side::Buy, "1", "10", "0"), (Side::Sell, "1", "11", "0")]);
        let at = DateTime::parse_from_rfc3339("2025-01-02T01:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        for leg in &mut value.executions {
            leg.executed_at = at;
        }
        assert_eq!(
            result(value.clone()).executions[0].market_date,
            "2025-01-01"
        );
        value.executions.swap(0, 1);
        assert!(validate(value).is_err());
    }
    #[test]
    fn validates_dates_ids_and_normalizes_tags() {
        let mut value = input(&[(Side::Buy, "1", "10", "0"), (Side::Buy, "1", "10", "0")]);
        value.tag_ids = vec![2, 1, 2];
        assert_eq!(validate(value.clone()).unwrap().input.tag_ids, [1, 2]);
        value.executions[0].id = Some(1);
        value.executions[1].id = Some(1);
        assert!(validate(value.clone()).is_err());
        value.executions[1].id = Some(2);
        value.executions[0].executed_at = Utc::now() + Duration::days(1);
        assert!(validate(value).is_err());
    }
    #[test]
    fn maximum_inputs_do_not_overflow() {
        let mut value = input(&[(Side::Buy, "1000000", "1000000", "1000000")]);
        value.executions = vec![value.executions[0].clone(); 499];
        let mut sell = value.executions[0].clone();
        sell.side = Side::Sell;
        value.executions.push(sell);
        let trade = result(value);
        assert_eq!(trade.summary.remaining_quantity, "498000000");
        assert_eq!(trade.summary.realized_pnl, "-2000000");
    }

    #[test]
    fn short_adds_partial_covers_and_full_close_include_all_fees() {
        let mut source = input(&[
            (Side::Sell, "100", "20", "1"),
            (Side::Sell, "100", "30", "1"),
            (Side::Buy, "50", "15", "2"),
            (Side::Buy, "150", "10", "3"),
        ]);
        source.direction = Direction::Short;
        let closed = result(source.clone());
        assert_eq!(closed.direction, Direction::Short);
        assert_eq!(
            closed
                .executions
                .iter()
                .map(|leg| leg.action)
                .collect::<Vec<_>>(),
            ["Open", "Add", "Reduce", "Close"]
        );
        assert_eq!(closed.executions[2].realized_pnl, "497.5");
        assert_eq!(closed.executions[3].realized_pnl, "2245.5");
        assert!((closed.executions[2].net_return_percent.unwrap() - 39.8).abs() < 1e-9);
        assert!((closed.executions[3].net_return_percent.unwrap() - 59.88).abs() < 1e-9);
        assert_eq!(
            closed.summary.realized_return_percent,
            closed.summary.net_return_percent
        );
        assert_eq!(closed.summary.realized_pnl, "2743");
        assert_eq!(closed.summary.fees, "7");
        assert_eq!(closed.summary.status, "closed");
        assert!(closed.summary.average_cost.is_none());
        source.executions.pop();
        let reopened = result(source);
        assert_eq!(reopened.summary.status, "open");
        assert_eq!(reopened.summary.remaining_quantity, "150");
        assert_eq!(reopened.summary.average_cost.as_deref(), Some("24.99"));
        assert_eq!(reopened.summary.realized_pnl, "497.5");
    }

    #[test]
    fn marked_returns_include_partial_profit_and_fees_for_both_directions() {
        let date = NaiveDate::from_ymd_opt(2025, 1, 3).unwrap();
        for (direction, legs, price, expected_return) in [
            (
                Direction::Long,
                vec![(Side::Buy, "100", "10", "1"), (Side::Sell, "50", "12", "1")],
                11 * SCALE,
                14.8,
            ),
            (
                Direction::Short,
                vec![(Side::Sell, "100", "20", "1"), (Side::Buy, "50", "18", "1")],
                19 * SCALE,
                7.4,
            ),
        ] {
            let mut source = input(&legs);
            source.direction = direction;
            let trade = result(source);
            let marked = value_open_trade(&trade, Some((price, date)));
            assert_eq!(trade.summary.realized_pnl, "98.5");
            let expected_realized_return = match direction {
                Direction::Long => 19.7,
                Direction::Short => 9.85,
            };
            assert!(
                (trade.summary.realized_return_percent.unwrap() - expected_realized_return).abs()
                    < 1e-9
            );
            assert_eq!(trade.executions[0].net_return_percent, None);
            assert_eq!(
                trade.executions[1].net_return_percent,
                trade.summary.realized_return_percent
            );
            assert_eq!(marked.unrealized_pnl.as_deref(), Some("49.5"));
            assert_eq!(marked.total_pnl.as_deref(), Some("148"));
            assert!((marked.net_return_percent.unwrap() - expected_return).abs() < 0.000001);
            assert!(value_open_trade(&trade, None).total_pnl.is_none());
            assert!(
                value_open_trade(&trade, Some((price, date - Duration::days(2))))
                    .total_pnl
                    .is_none()
            );
            assert!(trade.summary.net_return_percent.is_none());
        }
        let closed = result(input(&[
            (Side::Buy, "1", "10", "1"),
            (Side::Sell, "1", "15", "1"),
        ]));
        assert_eq!(closed.summary.net_return_percent, Some(30.0));
    }

    #[test]
    fn short_losses_fractional_covers_and_fees_above_proceeds() {
        for (legs, expected) in [
            (
                vec![(Side::Sell, "10", "10", "2"), (Side::Buy, "10", "12", "3")],
                "-25",
            ),
            (
                vec![
                    (Side::Sell, "0.3", "10", "0.01"),
                    (Side::Buy, "0.1", "9", "0.001"),
                    (Side::Sell, "0.1", "8", "0"),
                    (Side::Buy, "0.3", "7", "0.002"),
                ],
                "0.787",
            ),
            (
                vec![
                    (Side::Sell, "1", "1", "2"),
                    (Side::Buy, "0.5", "0.5", "0.05"),
                    (Side::Buy, "0.5", "0.5", "0.05"),
                ],
                "-1.6",
            ),
        ] {
            let mut source = input(&legs);
            source.direction = Direction::Short;
            assert_eq!(result(source).summary.realized_pnl, expected);
        }
    }

    #[test]
    fn short_history_rejects_over_covers_and_entries_after_flat() {
        for legs in [
            vec![(Side::Buy, "1", "10", "0")],
            vec![(Side::Sell, "1", "10", "0"), (Side::Buy, "2", "9", "0")],
            vec![
                (Side::Sell, "1", "10", "0"),
                (Side::Buy, "1", "9", "0"),
                (Side::Sell, "1", "8", "0"),
            ],
        ] {
            let mut source = input(&legs);
            source.direction = Direction::Short;
            assert!(validate(source).is_err());
        }
        let source = input(&[(Side::Buy, "1", "10", "0")]);
        let mut json = serde_json::to_value(source).unwrap();
        json.as_object_mut().unwrap().remove("direction");
        assert_eq!(
            serde_json::from_value::<TradeInput>(json.clone())
                .unwrap()
                .direction,
            Direction::Long
        );
        json["direction"] = serde_json::json!("invalid");
        assert!(serde_json::from_value::<TradeInput>(json).is_err());
    }

    #[test]
    fn realized_returns_follow_entry_basis_when_adding_after_partial_exits() {
        for (direction, legs, first_return, final_return) in [
            (
                Direction::Long,
                vec![
                    (Side::Buy, "100", "10", "0"),
                    (Side::Sell, "50", "12", "0"),
                    (Side::Buy, "50", "20", "0"),
                    (Side::Sell, "100", "18", "0"),
                ],
                20.0,
                20.0,
            ),
            (
                Direction::Short,
                vec![
                    (Side::Sell, "100", "20", "0"),
                    (Side::Buy, "50", "18", "0"),
                    (Side::Sell, "50", "30", "0"),
                    (Side::Buy, "100", "20", "0"),
                ],
                10.0,
                600.0 / 3500.0 * 100.0,
            ),
        ] {
            let mut source = input(&legs);
            source.direction = direction;
            let closed = result(source.clone());
            assert!((closed.executions[1].net_return_percent.unwrap() - first_return).abs() < 1e-9);
            assert!((closed.executions[3].net_return_percent.unwrap() - 20.0).abs() < 1e-9);
            assert!((closed.summary.realized_return_percent.unwrap() - final_return).abs() < 1e-9);
            assert_eq!(
                closed.summary.realized_return_percent,
                closed.summary.net_return_percent
            );
            source.executions.pop();
            let open = result(source.clone());
            assert!((open.summary.realized_return_percent.unwrap() - first_return).abs() < 1e-9);
            assert!(open.summary.net_return_percent.is_none());
            source.executions.truncate(1);
            let entry_only = result(source);
            assert!(entry_only.summary.realized_return_percent.is_none());
            assert!(entry_only.executions[0].net_return_percent.is_none());
        }
    }

    #[test]
    fn realized_returns_preserve_losses_breakeven_and_gross_short_entry_value() {
        for (direction, legs, expected) in [
            (
                Direction::Long,
                vec![(Side::Buy, "1", "10", "1"), (Side::Sell, "1", "10", "1")],
                -20.0,
            ),
            (
                Direction::Long,
                vec![(Side::Buy, "1", "10", "0"), (Side::Sell, "1", "10", "0")],
                0.0,
            ),
            (
                Direction::Short,
                vec![
                    (Side::Sell, "1", "1", "2"),
                    (Side::Buy, "0.5", "0.5", "0.05"),
                    (Side::Buy, "0.5", "0.5", "0.05"),
                ],
                -160.0,
            ),
        ] {
            let mut source = input(&legs);
            source.direction = direction;
            let trade = result(source);
            assert!((trade.summary.realized_return_percent.unwrap() - expected).abs() < 1e-9);
            for exit in trade.executions.iter().skip(1) {
                assert!((exit.net_return_percent.unwrap() - expected).abs() < 1e-9);
            }
        }
    }
}
