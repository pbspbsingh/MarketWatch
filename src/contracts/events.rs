use super::industry::{IndustryResource, IndustryState};
use super::tickers::{TickerMetricsResource, TickerMetricsUpdate};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(
    tag = "domain",
    content = "resource",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ApplicationResource {
    Industry(IndustryResource),
    Tickers(TickerMetricsResource),
}

#[derive(Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ApplicationCommand {
    Subscribe {
        subscription_id: String,
        resource: ApplicationResource,
    },
    Unsubscribe {
        subscription_id: String,
    },
}

#[derive(Serialize, TS)]
#[serde(tag = "domain", content = "state", rename_all = "snake_case")]
pub enum ApplicationSnapshot {
    Industry(IndustryState),
    Tickers(TickerMetricsUpdate),
}

#[derive(Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ApplicationEvent {
    Snapshot {
        subscription_id: String,
        payload: ApplicationSnapshot,
    },
    Error {
        subscription_id: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::tickers::TickerFilters;
    use serde_json::json;

    #[test]
    fn subscription_validation_rejects_unknown_fields_at_every_level() {
        let valid = json!({
            "type": "subscribe", "subscription_id": "test",
            "resource": {"domain": "tickers", "resource": {
                "selection": {"type": "themes", "ids": [1], "include_unassigned": false},
                "filters": TickerFilters::default(),
            }},
        });
        assert!(serde_json::from_value::<ApplicationCommand>(valid.clone()).is_ok());
        for path in [
            "",
            "/resource",
            "/resource/resource",
            "/resource/resource/selection",
            "/resource/resource/filters",
        ] {
            let mut invalid = valid.clone();
            invalid
                .pointer_mut(path)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unexpected".into(), json!(true));
            assert!(
                serde_json::from_value::<ApplicationCommand>(invalid).is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn global_subscriptions_require_a_supported_domain_and_have_no_refresh_command() {
        assert!(serde_json::from_str::<ApplicationCommand>(
            r#"{"type":"subscribe","subscription_id":"test","resource":{"domain":"industry","resource":{"type":"catalog"}}}"#
        ).is_ok());
        for invalid in [
            r#"{"type":"subscribe","subscription_id":"test","resource":{"type":"catalog"}}"#,
            r#"{"type":"subscribe","subscription_id":"test","resource":{"domain":"unknown","resource":{"type":"catalog"}}}"#,
            r#"{"type":"refresh","subscription_id":"test"}"#,
        ] {
            assert!(serde_json::from_str::<ApplicationCommand>(invalid).is_err());
        }
    }
}
