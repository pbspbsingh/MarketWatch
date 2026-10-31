use crate::trade_logs::{Direction, ExecutionInput, Side, TradeInput};
use chrono::{DateTime, Utc};
use market_types::TickerSymbol;

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
