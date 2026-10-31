use crate::services::trade_logs::Snapshot;
use serde::Serialize;
use ts_rs::TS;

#[derive(Serialize, TS)]
pub struct TradeLogSnapshot {
    #[serde(flatten)]
    pub snapshot: Snapshot,
    pub time_zone: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::trade_logs::statistics;
    use journal::test_support::input;
    use journal::trade_logs::{Side, calculate, validate};

    #[test]
    fn snapshot_keeps_flattened_fields_and_existing_enum_values() {
        let source = input(&[
            (Side::Buy, "10", "20", "0"),
            (Side::Buy, "10", "21", "0"),
            (Side::Sell, "10", "22", "0"),
            (Side::Sell, "10", "23", "0"),
        ]);
        let open = calculate(
            1,
            1,
            &validate(input(&[(Side::Buy, "10", "20", "0")])).unwrap(),
        )
        .unwrap();
        let trade = calculate(2, 1, &validate(source).unwrap()).unwrap();
        let trades = vec![open, trade];
        let response = TradeLogSnapshot {
            snapshot: Snapshot {
                statistics: statistics(trades.iter()),
                trades,
                tags: vec![],
                tag_statistics: vec![],
                untagged_trades: 2,
                open_trades: 1,
                open_realized_pnl: "0".into(),
            },
            time_zone: "America/New_York",
        };
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["time_zone"], "America/New_York");
        assert!(value.get("snapshot").is_none());
        assert_eq!(value["statistics"]["closed_trades"], 1);
        assert_eq!(value["trades"][0]["summary"]["status"], "open");
        let trade = &value["trades"][1];
        assert_eq!(trade["direction"], "long");
        assert_eq!(trade["summary"]["status"], "closed");
        let executions = trade["executions"].as_array().unwrap();
        assert_eq!(
            executions
                .iter()
                .map(|leg| leg["action"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["Open", "Add", "Reduce", "Close"]
        );
        assert_eq!(executions[0]["side"], "buy");
        assert!(executions[0].get("input").is_none());
        assert!(trade.get("net_cash").is_none());
        assert!(trade.get("remaining_basis").is_none());
        assert!(trade.get("raw_realized_pnl").is_none());
        assert!(trade.get("gross_entry_notional").is_none());
    }
}
