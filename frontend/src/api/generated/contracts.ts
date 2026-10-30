// Generated from Rust. Run cargo run -- --export-contracts.

export type TickerSymbol = string;

export type RejectedTicker = { symbol: TickerSymbol, reason: string, };

export type TickerCollectionFile = { name: string, row_count: number, extracted_count: number, skipped_rows: number, };

export type TickerCollectionSource = { "type": "csv", files: Array<TickerCollectionFile>, } | { "type": "pasted" };

export type TickerCollection = { version: number, source: TickerCollectionSource, symbols: Array<TickerSymbol>, skipped_rows: number, created_at: string, rejected_symbols: Array<RejectedTicker>, };

export type PerformancePeriods = { day: number, week: number, month: number, quarter: number, half_year: number, year: number, };

export type ThemeRanking = { id: number, name: string, etf_symbol: TickerSymbol, ticker_count: number, performance: PerformancePeriods | null, previous_close: number | null, };

export type TickerRanking = { symbol: TickerSymbol, watchlist_ids: Array<number>, performance: PerformancePeriods | null, adr_percent: number | null, dollar_volume: number | null, };

export type MinimumFilter = { enabled: boolean, min: number, };

export type EnabledFilter = { enabled: boolean, };

export type TickerFilters = { adr: MinimumFilter, dollarVolume: MinimumFilter, above200Sma: EnabledFilter, };

export type TickerFilterExclusions = { adr: number, dollarVolume: number, above200Sma: number, };

export type TickerSelection = { "type": "symbols", symbols: Array<TickerSymbol>, } | { "type": "industries", keys: Array<string>, } | { "type": "themes", ids: Array<number>, include_unassigned: boolean, };

export type TickerMetricsResource = { selection: TickerSelection, filters: TickerFilters, reveal_symbol: TickerSymbol | null, };

export type TickerMetricsUpdate = { "type": "reset", total: number, } | { "type": "ticker", ticker: TickerRanking, } | { "type": "excluded_ticker", ticker: TickerRanking, } | { "type": "remove", symbol: TickerSymbol, } | { "type": "filter_counts", excluded: TickerFilterExclusions, } | { "type": "complete" };

export type IndustryClassification = { industry_key: string, industry_name: string, sector_key: string, sector_name: string, ticker_count: number, };

export type IndustryCatalogEntry = { industry_key: string, industry_name: string, sector_key: string, sector_name: string, ticker_count: number, performance: PerformancePeriods | null, };

export type IndustryResource = { "type": "catalog" };

export type IndustryData = { "type": "catalog", industries: Array<IndustryCatalogEntry>, };

export type IndustryState = { data: IndustryData, fetched_at: string | null, expires_at: string | null, loading: boolean, error: string | null, };

export type ApplicationResource = { "domain": "industry", "resource": IndustryResource } | { "domain": "tickers", "resource": TickerMetricsResource };

export type ApplicationCommand = { "type": "subscribe", subscription_id: string, resource: ApplicationResource, } | { "type": "unsubscribe", subscription_id: string, };

export type ApplicationSnapshot = { "domain": "industry", "state": IndustryState } | { "domain": "tickers", "state": TickerMetricsUpdate };

export type ApplicationEvent = { "type": "snapshot", subscription_id: string, payload: ApplicationSnapshot, } | { "type": "error", subscription_id: string, message: string, };
