use crate::contracts::events::{ApplicationEvent, ApplicationSnapshot};
use crate::contracts::tickers::{TickerMetricsResource, TickerMetricsUpdate};
use crate::models::TickerRanking;
use crate::services::tickers::TickerCatalogService;
use std::sync::Arc;
use tokio::sync::{
    broadcast::error::RecvError,
    mpsc::{self, Sender},
};

pub(super) async fn forward(
    service: Arc<TickerCatalogService>,
    id: String,
    resource: TickerMetricsResource,
    sender: Sender<(u64, ApplicationEvent)>,
    generation: u64,
) {
    let mut symbols = resource.symbols;
    let filters = resource.filters;
    symbols.sort();
    symbols.dedup();
    if symbols.len() > 10_000 || filters.validate().is_err() {
        let _ = sender
            .send((
                generation,
                ApplicationEvent::Error {
                    subscription_id: id,
                    message: "Invalid ticker metrics subscription".into(),
                },
            ))
            .await;
        return;
    }
    let mut changes = service.metric_changes();
    let send = |update| {
        sender.send((
            generation,
            ApplicationEvent::Snapshot {
                subscription_id: id.clone(),
                payload: ApplicationSnapshot::Tickers(update),
            },
        ))
    };
    let metric_update = |ticker: TickerRanking| {
        if filters.includes(&ticker) {
            TickerMetricsUpdate::Ticker { ticker }
        } else {
            TickerMetricsUpdate::Remove {
                symbol: ticker.symbol,
            }
        }
    };
    if send(TickerMetricsUpdate::Reset {
        total: symbols.len(),
    })
    .await
    .is_err()
    {
        return;
    }
    // Keep acquisition in this task so dropping the subscription cancels it.
    let (tickers, mut receiver) = mpsc::channel(1);
    let acquisition = service.stream_ranked_symbols(generation, &symbols, &tickers);
    tokio::pin!(acquisition);
    loop {
        tokio::select! {
            result = &mut acquisition => {
                if let Err(error) = result {
                    let _ = sender.send((generation, ApplicationEvent::Error { subscription_id: id.clone(), message: error.to_string() })).await;
                    return;
                }
                break;
            }
            Some(ticker) = receiver.recv() => if send(metric_update(ticker)).await.is_err() { return; },
        }
    }
    // The producer may finish while its last item is still buffered.
    while let Ok(ticker) = receiver.try_recv() {
        if send(metric_update(ticker)).await.is_err() {
            return;
        }
    }
    if send(TickerMetricsUpdate::Complete).await.is_err() {
        return;
    }
    loop {
        let affected = match changes.recv().await {
            Ok(symbol) => {
                if symbols.binary_search(&symbol).is_ok() {
                    vec![symbol]
                } else {
                    continue;
                }
            }
            Err(RecvError::Lagged(_)) => symbols.clone(),
            Err(RecvError::Closed) => return,
        };
        for symbol in affected {
            match service.cached_ticker_ranking(&symbol).await {
                Ok(ticker) => {
                    if send(metric_update(ticker)).await.is_err() {
                        return;
                    }
                }
                Err(error) => tracing::warn!(%symbol, %error, "Ticker metric update failed"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::tickers::{MinimumFilter, TickerFilters};
    use crate::{
        models::{CompanyProfile, DailyCandle, Exchange, TickerSymbol},
        services::industry_data::tests::{client, fixture},
        store::Store,
    };
    use chrono::{TimeDelta, Utc};
    use std::time::Duration;

    #[tokio::test]
    async fn metrics_remain_subscribed_after_completion_and_push_committed_candles() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let symbol = TickerSymbol::parse("NVDA").unwrap();
        store
            .add_ticker_industry("semiconductors", "Semiconductors", &symbol)
            .await
            .unwrap();
        store
            .upsert_company_profile(&CompanyProfile {
                symbol: symbol.clone(),
                name: Some("Nvidia".into()),
                exchange: Exchange::Nasdaq,
                description: None,
                fetched_at: Utc::now(),
            })
            .await
            .unwrap();
        let (_, service, yahoo) = fixture(store.clone(), client("http://127.0.0.1:1/"));
        let date = yahoo.latest_completed_candle_date();
        let candle = |date, close| DailyCandle {
            market_date: date,
            open: close,
            high: close * 1.1,
            low: close * 0.9,
            close,
            volume: 100,
        };
        store
            .upsert_daily_candles(
                &symbol,
                &[
                    candle(date - TimeDelta::days(800), 50.0),
                    candle(date - TimeDelta::days(2), 80.0),
                    candle(date, 100.0),
                ],
            )
            .await
            .unwrap();
        // A reconnect must receive cached metrics first, rather than null
        // placeholders that temporarily exclude rows from active filters.
        {
            let (sender, mut cached) = mpsc::channel(1);
            let symbols = [symbol.clone()];
            let acquisition = service.stream_ranked_symbols(0, &symbols, &sender);
            tokio::pin!(acquisition);
            let first = tokio::select! {
                value = cached.recv() => value.unwrap(),
                result = &mut acquisition => panic!("Acquisition ended before cached delivery: {result:?}"),
            };
            assert_eq!(first.dollar_volume, Some(10_000.0));
        }
        let (sender, mut receiver) = mpsc::channel(32);
        let worker = tokio::spawn(forward(
            service,
            "metrics".into(),
            TickerMetricsResource {
                symbols: vec![symbol.clone()],
                filters: TickerFilters {
                    dollar_volume: MinimumFilter {
                        enabled: true,
                        min: 11_000.0,
                    },
                    ..Default::default()
                },
            },
            sender,
            7,
        ));
        let mut last = None;
        loop {
            let (generation, event) = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(generation, 7);
            match event {
                ApplicationEvent::Snapshot {
                    payload: ApplicationSnapshot::Tickers(TickerMetricsUpdate::Ticker { ticker }),
                    ..
                } => last = Some(ticker),
                ApplicationEvent::Snapshot {
                    payload: ApplicationSnapshot::Tickers(TickerMetricsUpdate::Complete),
                    ..
                } => break,
                ApplicationEvent::Error { message, .. } => panic!("{message}"),
                _ => {}
            }
        }
        assert!(
            last.is_none(),
            "Filtered tickers must not be sent to the client"
        );
        store
            .upsert_daily_candles(&symbol, &[candle(date, 120.0)])
            .await
            .unwrap();
        let (_, event) = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        let ApplicationEvent::Snapshot {
            payload: ApplicationSnapshot::Tickers(TickerMetricsUpdate::Ticker { ticker }),
            ..
        } = event
        else {
            panic!("Expected ticker update")
        };
        assert_eq!(ticker.dollar_volume, Some(12_000.0));
        assert_eq!(ticker.performance.unwrap().day, 0.5);
        let payload = serde_json::to_value(&ticker).unwrap();
        assert!(
            payload.get("above_200_sma").is_none(),
            "Filter-only metrics stay on the server"
        );
        store
            .upsert_daily_candles(&symbol, &[candle(date, 90.0)])
            .await
            .unwrap();
        let (_, event) = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            event,
            ApplicationEvent::Snapshot {
                payload: ApplicationSnapshot::Tickers(TickerMetricsUpdate::Remove { .. }),
                ..
            }
        ));
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
    }
}
