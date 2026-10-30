// Generated from Rust. Run cargo run -- --export-contracts.

export type TickerSymbol = string;

export type YahooSymbol = string;

export type VolumeEventKind = "history_high" | "year_high";

export type MarketChartInterval = "daily" | "weekly";

export type MarketChartCandle = { date: string, open: number, high: number, low: number, close: number, volume: number, volume_event?: VolumeEventKind, };

export type MarketChartPoint = { date: string, value: number, };

export type MarketChartSeries = { period: number, points: Array<MarketChartPoint>, };

export type MarketChartIndicators = { date: string, adr_percent: number | null, extension_from_50_sma: number | null, average_volume: number | null, };

export type MarketChartSnapshot = { symbol: TickerSymbol, interval: MarketChartInterval, candles: Array<MarketChartCandle>, moving_averages: Array<MarketChartSeries>, volume_average: MarketChartSeries, indicators: Array<MarketChartIndicators>, relative_strength: MarketChartRelativeStrength | null, earliest_date: string | null, latest_date: string | null, has_more_before: boolean, };

export type MarketChartRelativeStrength = { comparison_symbol: TickerSymbol, line: RelativeStrengthCalculation, structure: RelativeStrengthStructure, };

export type RelativeStrengthCalculation = { moving_average_period: number, points: Array<RelativeStrengthCalculationPoint>, };

export type RelativeStrengthCalculationPoint = { date: string, value: number, ticker_return_percent: number | null, comparison_return_percent: number | null, relative_return_percent: number | null, };

export type RelativeStrengthSwingKind = "high" | "low";

export type RelativeStrengthTrend = "uptrend" | "downtrend" | "unclear";

export type RelativeStrengthSwing = { date: string, value: number, kind: RelativeStrengthSwingKind, };

export type RelativeStrengthStructure = { confirmed: Array<RelativeStrengthSwing>, provisional: RelativeStrengthSwing | null, trend: RelativeStrengthTrend, };

export type StudyCandle = { date: string, open: number, high: number, low: number, close: number, volume: number, volume_event?: VolumeEventKind, };

export type StudyMovingAveragePoint = { date: string, value: number, };

export type StudyMovingAverage = { period: number, points: Array<StudyMovingAveragePoint>, };

export type StudySeries = { symbol: TickerSymbol, company_name: string | null, candles: Array<StudyCandle>, moving_averages: Array<StudyMovingAverage>, volume_average: StudyMovingAverage, indicators: Array<MarketChartIndicators>, };

export type StudyResult = { date: string, interval: MarketChartInterval, range_start: string, range_end: string, has_more_before: boolean, has_more_after: boolean, series: Array<StudySeries>, relative_strength: MarketChartRelativeStrength | null, };

export type VolumeRunRate = { symbol: YahooSymbol, market_date: string, visible: boolean, cached: boolean, ratio: number | null, sample_days: number, updated_at: string | null, calculated_at: string, };

export type LiveCommand = { "type": "set_subscriptions", request_id: number, charts: Array<RawLiveChartRequest>, symbols: Array<string>, };

export type RawLiveChartRequest = { volume_run_rate: boolean, chart_id: string, symbol: string, interval: MarketChartInterval, comparison_symbol: string | null, relative_strength_period: number | null, };

export type LiveChartDelta = { chart_id: string, symbol: TickerSymbol, interval: MarketChartInterval, candle: MarketChartCandle, moving_averages: Array<MarketChartSeries>, volume_average: MarketChartSeries, indicators: MarketChartIndicators | null, relative_strength: MarketChartRelativeStrength | null, };

export type LiveSessionKind = "pre_market" | "post_market";

export type LiveSessionDelta = { chart_id: string, symbol: YahooSymbol, date: string, session: LiveSessionKind, candle: MarketChartCandle | null, price: number, indicators: MarketChartIndicators | null, };

export type LiveEvent = { "type": "availability", available: boolean, market_date: string, } | { "type": "price", request_id: number, symbol: YahooSymbol, price: number, updated_at: string, } | { "type": "volume_run_rate", request_id: number, chart_id: string, state: VolumeRunRate, } | { "type": "subscribed", request_id: number, symbols: Array<YahooSymbol>, } | { "type": "delta", request_id: number, delta: LiveChartDelta, } | { "type": "session", request_id: number, delta: LiveSessionDelta, } | { "type": "error", request_id: number, chart_id: string | null, message: string, };

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
