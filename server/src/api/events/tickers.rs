use crate::contracts::events::{ApplicationEvent, ApplicationSnapshot};
use crate::contracts::tickers::{
    TickerFilterExclusions, TickerFilters, TickerMetricsResource, TickerMetricsUpdate,
    TickerSelection,
};
use crate::models::TickerRanking;
use crate::services::{industry_data::IndustryDataService, tickers::TickerCatalogService};
use market_types::TickerSymbol;
use std::{collections::HashMap, fmt::Display, sync::Arc};
use tokio::sync::{
    broadcast::error::RecvError,
    mpsc::{self, Sender},
};

struct Delivery {
    id: String,
    filters: TickerFilters,
    sender: Sender<(u64, ApplicationEvent)>,
    generation: u64,
    exclusions: HashMap<TickerSymbol, TickerFilterExclusions>,
    excluded: TickerFilterExclusions,
    reveal_symbol: Option<TickerSymbol>,
}

impl Delivery {
    async fn update(&self, update: TickerMetricsUpdate) -> bool {
        self.sender
            .send((
                self.generation,
                ApplicationEvent::Snapshot {
                    subscription_id: self.id.clone(),
                    payload: ApplicationSnapshot::Tickers(update),
                },
            ))
            .await
            .is_ok()
    }

    async fn ticker(&mut self, ticker: TickerRanking) -> bool {
        let excluded = self.filters.exclusions(&ticker);
        let previous = self
            .exclusions
            .insert(ticker.symbol.clone(), excluded)
            .unwrap_or_default();
        self.excluded.adr = self.excluded.adr - previous.adr + excluded.adr;
        self.excluded.dollar_volume =
            self.excluded.dollar_volume - previous.dollar_volume + excluded.dollar_volume;
        self.excluded.above_200_sma =
            self.excluded.above_200_sma - previous.above_200_sma + excluded.above_200_sma;
        let update = if self.filters.includes(&ticker) {
            TickerMetricsUpdate::Ticker { ticker }
        } else if self.reveal_symbol.as_ref() == Some(&ticker.symbol) {
            TickerMetricsUpdate::ExcludedTicker { ticker }
        } else {
            TickerMetricsUpdate::Remove {
                symbol: ticker.symbol,
            }
        };
        self.update(update).await
    }

    async fn filter_counts(&self) -> bool {
        self.update(TickerMetricsUpdate::FilterCounts {
            excluded: self.excluded,
        })
        .await
    }

    async fn error(&self, error: impl Display) {
        let _ = self
            .sender
            .send((
                self.generation,
                ApplicationEvent::Error {
                    subscription_id: self.id.clone(),
                    message: error.to_string(),
                },
            ))
            .await;
    }
}

async fn resolve_symbols(
    service: &TickerCatalogService,
    industry: &IndustryDataService,
    selection: &TickerSelection,
    acquire: bool,
) -> anyhow::Result<Vec<TickerSymbol>> {
    let mut symbols = match selection {
        TickerSelection::Industries { keys } if acquire => {
            industry.resolve_industry_symbols(keys).await?
        }
        _ => service.cached_selection_symbols(selection).await?,
    };
    symbols.sort();
    symbols.dedup();
    anyhow::ensure!(symbols.len() <= 10_000, "Too many selected tickers");
    Ok(symbols)
}

async fn acquire_metrics(
    service: &TickerCatalogService,
    symbols: &[TickerSymbol],
    delivery: &mut Delivery,
) -> bool {
    delivery.exclusions.clear();
    delivery.excluded = TickerFilterExclusions::default();
    if !delivery
        .update(TickerMetricsUpdate::Reset {
            total: symbols.len(),
        })
        .await
    {
        return false;
    }
    let (tickers, mut receiver) = mpsc::channel(1);
    let acquisition = service.stream_ranked_symbols(delivery.generation, symbols, &tickers);
    tokio::pin!(acquisition);
    loop {
        tokio::select! {
            result = &mut acquisition => {
                if let Err(error) = result {
                    delivery.error(error).await;
                    return false;
                }
                break;
            }
            Some(ticker) = receiver.recv() => {
                if !delivery.ticker(ticker).await {
                    return false;
                }
            }
        }
    }
    while let Ok(ticker) = receiver.try_recv() {
        if !delivery.ticker(ticker).await {
            return false;
        }
    }
    delivery.filter_counts().await && delivery.update(TickerMetricsUpdate::Complete).await
}

pub(super) async fn forward(
    service: Arc<TickerCatalogService>,
    industry: Arc<IndustryDataService>,
    id: String,
    resource: TickerMetricsResource,
    sender: Sender<(u64, ApplicationEvent)>,
    generation: u64,
) {
    let selection = resource.selection;
    let dynamic = !matches!(selection, TickerSelection::Symbols { .. });
    let mut delivery = Delivery {
        id,
        filters: resource.filters,
        reveal_symbol: resource.reveal_symbol,
        sender,
        generation,
        exclusions: HashMap::new(),
        excluded: TickerFilterExclusions::default(),
    };
    if let Err(error) = delivery.filters.validate() {
        delivery.error(error).await;
        return;
    }
    // Subscribe before lazy acquisition so changes made while resolving groups
    // cannot be lost between the initial snapshot and live delivery.
    let mut changes = service.metric_changes();
    let mut memberships = service.membership_changes();
    let mut symbols = match resolve_symbols(&service, &industry, &selection, true).await {
        Ok(symbols) => symbols,
        Err(error) => {
            delivery.error(error).await;
            return;
        }
    };
    loop {
        if !acquire_metrics(&service, &symbols, &mut delivery).await {
            return;
        }
        loop {
            let affected = tokio::select! {
                changed = memberships.changed(), if dynamic => {
                    if changed.is_err() {
                        return;
                    }
                    let next = match resolve_symbols(&service, &industry, &selection, false).await {
                        Ok(next) => next,
                        Err(error) => {
                            delivery.error(error).await;
                            continue;
                        }
                    };
                    if next == symbols {
                        continue;
                    }
                    for removed in symbols.iter().filter(|symbol| next.binary_search(symbol).is_err()) {
                        if !delivery.update(TickerMetricsUpdate::Remove { symbol: removed.clone() }).await {
                            return;
                        }
                    }
                    symbols = next;
                    break;
                }
                changed = changes.recv() => match changed {
                    Ok(symbol) => {
                        if symbols.binary_search(&symbol).is_ok() {
                            vec![symbol]
                        } else {
                            continue;
                        }
                    }
                    Err(RecvError::Lagged(_)) => symbols.clone(),
                    Err(RecvError::Closed) => return,
                },
            };
            for symbol in affected {
                match service.cached_ticker_ranking(&symbol).await {
                    Ok(ticker) => {
                        if !delivery.ticker(ticker).await {
                            return;
                        }
                    }
                    Err(error) => tracing::warn!(%symbol, %error, "Ticker metric update failed"),
                }
            }
            if !delivery.filter_counts().await {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::tickers::{EnabledFilter, MinimumFilter};
    use crate::models::AssignmentSource;
    use crate::services::industry_data::tests::client;
    use crate::services::industry_data::tests::fixture;
    use crate::services::industry_data::tests::seed_catalog;
    use crate::store::Store;
    use chrono::{TimeDelta, Utc};
    use market_types::{CompanyProfile, DailyCandle, Exchange, TickerSymbol};
    use std::collections::BTreeSet;
    use std::time::Duration;
    use tokio::sync::mpsc::Receiver;

    async fn selected_rows(
        receiver: &mut Receiver<(u64, ApplicationEvent)>,
        visible: &mut BTreeSet<String>,
    ) -> usize {
        let mut total = None;
        loop {
            let (_, event) = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            match event {
                ApplicationEvent::Snapshot {
                    payload: ApplicationSnapshot::Tickers(update),
                    ..
                } => match update {
                    TickerMetricsUpdate::Reset { total: count } => total = Some(count),
                    TickerMetricsUpdate::Ticker { ticker } => {
                        visible.insert(ticker.symbol.to_string());
                    }
                    TickerMetricsUpdate::ExcludedTicker { .. } => {
                        panic!("No reveal symbol was requested")
                    }
                    TickerMetricsUpdate::Remove { symbol } => {
                        visible.remove(symbol.as_str());
                    }
                    TickerMetricsUpdate::Complete => {
                        return total.expect("Reset must precede completion");
                    }
                    TickerMetricsUpdate::FilterCounts { excluded } => {
                        assert_eq!(excluded, TickerFilterExclusions::default())
                    }
                },
                ApplicationEvent::Error { message, .. } => panic!("{message}"),
                _ => panic!("Unexpected domain"),
            }
        }
    }

    #[tokio::test]
    async fn industry_theme_and_unassigned_selections_reconcile_membership_and_counts() {
        for kind in ["industries", "themes", "unassigned"] {
            let store = Store::connect("sqlite::memory:").await.unwrap();
            seed_catalog(&store).await;
            let (industry, service, yahoo) = fixture(store.clone(), client("http://127.0.0.1:1/"));
            let date = yahoo.latest_completed_candle_date();
            let nvda = TickerSymbol::parse("NVDA").unwrap();
            let amd = TickerSymbol::parse("AMD").unwrap();
            for symbol in [&nvda, &amd] {
                store
                    .add_ticker_industry("semiconductors", "Semiconductors", symbol)
                    .await
                    .unwrap();
                store
                    .upsert_company_profile(&CompanyProfile {
                        symbol: symbol.clone(),
                        name: Some(symbol.to_string()),
                        exchange: Exchange::Nasdaq,
                        description: None,
                        fetched_at: Utc::now(),
                    })
                    .await
                    .unwrap();
                let candle = |market_date| DailyCandle {
                    market_date,
                    open: 100.0,
                    high: 110.0,
                    low: 90.0,
                    close: 100.0,
                    volume: 100,
                };
                store
                    .upsert_daily_candles(
                        symbol,
                        &[candle(date - TimeDelta::days(800)), candle(date)],
                    )
                    .await
                    .unwrap();
            }
            let theme = store
                .create_theme("AI", &TickerSymbol::parse("AIQ").unwrap(), None)
                .await
                .unwrap();
            let other = store
                .create_theme("Chips", &TickerSymbol::parse("SMH").unwrap(), None)
                .await
                .unwrap();
            let selection = match kind {
                "industries" => {
                    store
                        .replace_industry_membership(
                            "semiconductors",
                            Utc::now(),
                            std::slice::from_ref(&nvda),
                        )
                        .await
                        .unwrap();
                    TickerSelection::Industries {
                        keys: vec!["semiconductors".into(), "semiconductors".into()],
                    }
                }
                "themes" => {
                    store
                        .replace_theme_assignments(
                            &nvda,
                            &[theme, other],
                            AssignmentSource::Manual,
                            None,
                            None,
                        )
                        .await
                        .unwrap();
                    TickerSelection::Themes {
                        ids: vec![theme, other, theme],
                        include_unassigned: false,
                    }
                }
                _ => {
                    store
                        .replace_theme_assignments(
                            &amd,
                            &[theme],
                            AssignmentSource::Manual,
                            None,
                            None,
                        )
                        .await
                        .unwrap();
                    TickerSelection::Themes {
                        ids: vec![],
                        include_unassigned: true,
                    }
                }
            };
            let (sender, mut receiver) = mpsc::channel(32);
            let worker = tokio::spawn(forward(
                service,
                Arc::new(industry),
                kind.into(),
                TickerMetricsResource {
                    selection,
                    filters: TickerFilters::default(),
                    reveal_symbol: None,
                },
                sender,
                1,
            ));
            let mut visible = BTreeSet::new();
            assert_eq!(
                selected_rows(&mut receiver, &mut visible).await,
                1,
                "{kind}"
            );
            assert_eq!(visible, BTreeSet::from(["NVDA".into()]), "{kind}");
            match kind {
                "industries" => store
                    .replace_industry_membership(
                        "semiconductors",
                        Utc::now(),
                        &[nvda.clone(), amd.clone()],
                    )
                    .await
                    .unwrap(),
                "themes" => store
                    .replace_theme_assignments(&amd, &[other], AssignmentSource::Manual, None, None)
                    .await
                    .unwrap(),
                _ => store
                    .replace_theme_assignments(&amd, &[], AssignmentSource::Manual, None, None)
                    .await
                    .unwrap(),
            }
            assert_eq!(
                selected_rows(&mut receiver, &mut visible).await,
                2,
                "{kind}"
            );
            assert_eq!(
                visible,
                BTreeSet::from(["AMD".into(), "NVDA".into()]),
                "{kind}"
            );
            match kind {
                "industries" => store
                    .replace_industry_membership(
                        "semiconductors",
                        Utc::now(),
                        std::slice::from_ref(&amd),
                    )
                    .await
                    .unwrap(),
                "themes" => store
                    .replace_theme_assignments(&nvda, &[], AssignmentSource::Manual, None, None)
                    .await
                    .unwrap(),
                _ => store
                    .replace_theme_assignments(
                        &nvda,
                        &[theme],
                        AssignmentSource::Manual,
                        None,
                        None,
                    )
                    .await
                    .unwrap(),
            }
            assert_eq!(
                selected_rows(&mut receiver, &mut visible).await,
                1,
                "{kind}"
            );
            assert_eq!(visible, BTreeSet::from(["AMD".into()]), "{kind}");
            if kind == "unassigned" {
                store.delete_theme(theme).await.unwrap();
                assert_eq!(selected_rows(&mut receiver, &mut visible).await, 2);
                assert_eq!(visible, BTreeSet::from(["AMD".into(), "NVDA".into()]));
            }
            let notifications = store.subscribe_memberships();
            assert!(
                store
                    .replace_theme_assignments(
                        &amd,
                        &[i64::MAX],
                        AssignmentSource::Manual,
                        None,
                        None
                    )
                    .await
                    .is_err()
            );
            assert!(
                !notifications.has_changed().unwrap(),
                "Rolled-back assignments must not notify subscribers"
            );
            worker.abort();
        }
    }

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
        let (industry, service, yahoo) = fixture(store.clone(), client("http://127.0.0.1:1/"));
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
            Arc::new(industry),
            "metrics".into(),
            TickerMetricsResource {
                reveal_symbol: None,
                selection: TickerSelection::Symbols {
                    symbols: vec![symbol.clone()],
                },
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
        let mut excluded = None;
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
                    payload:
                        ApplicationSnapshot::Tickers(TickerMetricsUpdate::FilterCounts {
                            excluded: counts,
                        }),
                    ..
                } => excluded = Some(counts),
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
        assert_eq!(excluded.unwrap().dollar_volume, 1);
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
        let (_, counts) = receiver.recv().await.unwrap();
        assert!(matches!(counts, ApplicationEvent::Snapshot {
            payload: ApplicationSnapshot::Tickers(TickerMetricsUpdate::FilterCounts { excluded }), ..
        } if excluded == TickerFilterExclusions::default()));
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
        let (_, counts) = receiver.recv().await.unwrap();
        assert!(matches!(counts, ApplicationEvent::Snapshot {
            payload: ApplicationSnapshot::Tickers(TickerMetricsUpdate::FilterCounts { excluded }), ..
        } if excluded.dollar_volume == 1));
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn exclusion_counts_overlap_and_replace_previous_metrics_without_double_counting() {
        let (sender, mut receiver) = mpsc::channel(16);
        let mut delivery = Delivery {
            reveal_symbol: None,
            id: "counts".into(),
            filters: TickerFilters {
                adr: MinimumFilter {
                    enabled: true,
                    min: 5.0,
                },
                dollar_volume: MinimumFilter {
                    enabled: true,
                    min: 10_000.0,
                },
                above_200_sma: EnabledFilter { enabled: true },
            },
            sender,
            generation: 1,
            exclusions: HashMap::new(),
            excluded: TickerFilterExclusions::default(),
        };
        let mut ticker = TickerRanking {
            symbol: TickerSymbol::parse("NVDA").unwrap(),
            watchlist_ids: vec![],
            performance: None,
            adr_percent: None,
            dollar_volume: Some(5_000.0),
            above_200_sma: Some(false),
        };
        let mut linked = ticker.clone();
        assert!(delivery.ticker(ticker.clone()).await);
        assert!(delivery.ticker(ticker.clone()).await);
        ticker.symbol = TickerSymbol::parse("AMD").unwrap();
        assert!(delivery.ticker(ticker.clone()).await);
        assert_eq!(
            delivery.excluded,
            TickerFilterExclusions {
                adr: 2,
                dollar_volume: 2,
                above_200_sma: 2
            }
        );
        ticker.adr_percent = Some(5.0);
        ticker.dollar_volume = Some(10_000.0);
        ticker.above_200_sma = Some(true);
        assert!(delivery.ticker(ticker).await);
        assert_eq!(
            delivery.excluded,
            TickerFilterExclusions {
                adr: 1,
                dollar_volume: 1,
                above_200_sma: 1
            }
        );
        for _ in 0..3 {
            assert!(matches!(
                receiver.recv().await.unwrap().1,
                ApplicationEvent::Snapshot {
                    payload: ApplicationSnapshot::Tickers(TickerMetricsUpdate::Remove { .. }),
                    ..
                }
            ));
        }
        assert!(matches!(
            receiver.recv().await.unwrap().1,
            ApplicationEvent::Snapshot {
                payload: ApplicationSnapshot::Tickers(TickerMetricsUpdate::Ticker { .. }),
                ..
            }
        ));
        delivery.reveal_symbol = Some(linked.symbol.clone());
        assert!(delivery.ticker(linked.clone()).await);
        assert_eq!(
            delivery.excluded.adr, 1,
            "Revealing a linked row must not change exclusion counts"
        );
        assert!(
            matches!(receiver.recv().await.unwrap().1, ApplicationEvent::Snapshot {
            payload: ApplicationSnapshot::Tickers(TickerMetricsUpdate::ExcludedTicker { ticker }), ..
        } if ticker.symbol == linked.symbol)
        );
        linked.adr_percent = Some(5.0);
        linked.dollar_volume = Some(10_000.0);
        linked.above_200_sma = Some(true);
        assert!(delivery.ticker(linked).await);
        assert_eq!(delivery.excluded, TickerFilterExclusions::default());
        assert!(matches!(
            receiver.recv().await.unwrap().1,
            ApplicationEvent::Snapshot {
                payload: ApplicationSnapshot::Tickers(TickerMetricsUpdate::Ticker { .. }),
                ..
            }
        ));
    }
}
