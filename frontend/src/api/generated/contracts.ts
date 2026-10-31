// Generated from Rust. Run cargo run -- --export-contracts.

export type TickerSymbol = string;

export type TradingViewSymbol = string;

export type ChartIndustry = { key: string, name: string, };

export type ChartSectorBenchmark = { sector_key: string, sector_name: string, etf_symbol: TickerSymbol, tradingview_symbol: TradingViewSymbol, company_name: string | null, };

export type ChartThemeBenchmark = { theme_name: string, etf_symbol: TickerSymbol, tradingview_symbol: TradingViewSymbol, company_name: string | null, };

export type ChartSummary = { symbol: TickerSymbol, company_name: string | null, description: string | null, industry: ChartIndustry | null, themes: Array<string>, theme_benchmarks: Array<ChartThemeBenchmark>, sector_benchmark: ChartSectorBenchmark | null, tradingview_symbol: TradingViewSymbol, benchmark_symbol: TradingViewSymbol, benchmark_company_name: string | null, adr_percent: number, extension_from_50_sma: number | null, average_volume: number, };

export type HomeCharts = { tickers: [TickerSymbol, TickerSymbol, TickerSymbol, TickerSymbol], };

export type NextEarnings = { date: string, trading_days_until: number, };

export type TickerGroupSummaryItem = { key: string, name: string, ticker_count: number, };

export type TickerGroupSummary = { selected_groups: Array<TickerGroupSummaryItem>, related_groups: Array<TickerGroupSummaryItem>, };

export type FundamentalPeriod = { fiscal_period: string, earnings_release_date: string | null, earnings_per_share: number | null, earnings_per_share_estimate: number | null, gaap_earnings_per_share: number | null, gaap_earnings_per_share_estimate: number | null, revenue: number | null, revenue_estimate: number | null, };

export type FundamentalForecast = { fiscal_period: string | null, earnings_release_date: string | null, earnings_per_share: number | null, gaap_earnings_per_share: number | null, revenue: number | null, };

export type Fundamentals = { symbol: TickerSymbol, currency: string | null, quarters: Array<FundamentalPeriod>,
/**
 * None identifies cached payloads written before annual data was supported.
 */
annual: Array<FundamentalPeriod> | null, next_quarter: FundamentalForecast, quarter_forecasts: Array<FundamentalForecast>, fetched_at: string, };

export type FundamentalGrowthPoint = { period: string, value: number | null, growth: number | null, sma_2: number | null, };

export type FundamentalGrowthSeries = { historical: Array<FundamentalGrowthPoint>, forecasts: Array<FundamentalGrowthPoint>, };

export type FundamentalGrowthMetric = { qoq: FundamentalGrowthSeries, yoy: FundamentalGrowthSeries, annual: FundamentalGrowthSeries, };

export type FundamentalGrowthDetails = { earnings_per_share: FundamentalGrowthMetric, gaap_earnings_per_share: FundamentalGrowthMetric, revenue: FundamentalGrowthMetric, };

export type ProfileDetails = { symbol: TickerSymbol, name: string | null, exchange: string, description: string | null, };

export type TickerDetails = { profile: ProfileDetails, fundamentals: Fundamentals, fundamental_growth: FundamentalGrowthDetails, stale_fundamentals: boolean, };

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

export type TradeLogDirection = "long" | "short";

export type TradeLogSide = "buy" | "sell";

export type TradeLogAction = "Open" | "Add" | "Reduce" | "Close";

export type TradeLogStatus = "open" | "closed";

export type TradeLogExecutionInput = { id: number | null, executed_at: string, side: TradeLogSide, quantity: string, price: string, fee: string, notes: string, tag_ids: Array<number>, };

export type TradeLogInput = { revision: number | null, symbol: TickerSymbol, direction: TradeLogDirection, notes: string, tag_ids: Array<number>, executions: Array<TradeLogExecutionInput>, };

export type TradeLogExecution = { market_date: string, action: TradeLogAction, remaining_quantity: string, realized_pnl: string, net_return_percent: number | null, id: number | null, executed_at: string, side: TradeLogSide, quantity: string, price: string, fee: string, notes: string, tag_ids: Array<number>, };

export type TradeLogSummary = { status: TradeLogStatus, remaining_quantity: string, average_cost: string | null, average_entry_price: string, realized_pnl: string, realized_return_percent: number | null, fees: string, entry_notional: string, net_return_percent: number | null, opened_at: string, closed_at: string | null, };

export type TradeLog = { id: number, revision: number, symbol: TickerSymbol, direction: TradeLogDirection, notes: string, tag_ids: Array<number>, executions: Array<TradeLogExecution>, summary: TradeLogSummary, };

export type TradeLogValuation = { trade_id: number, revision: number, mark_price: string | null, mark_date: string | null, unrealized_pnl: string | null, total_pnl: string | null, net_return_percent: number | null, };

export type TradeLogTag = { id: number, name: string, description: string | null, revision: number, trade_count: number, execution_count: number, };

export type TradeLogTagInput = { name: string, description: string | null, revision: number | null, };

export type TradeLogStatistics = { closed_trades: number, winners: number, losers: number, breakeven: number, net_pnl: string, average_pnl: string | null, average_winner: string | null, average_loser: string | null, win_rate: number | null, profit_factor: number | null, };

export type TradeLogTagStatistics = { tag_id: number, statistics: TradeLogStatistics, };

export type TradeLogSnapshotData = { trades: Array<TradeLog>, tags: Array<TradeLogTag>, statistics: TradeLogStatistics, tag_statistics: Array<TradeLogTagStatistics>, untagged_trades: number, open_trades: number, open_realized_pnl: string, };

export type TradeLogSnapshot = { time_zone: string, trades: Array<TradeLog>, tags: Array<TradeLogTag>, statistics: TradeLogStatistics, tag_statistics: Array<TradeLogTagStatistics>, untagged_trades: number, open_trades: number, open_realized_pnl: string, };

export type TradeLogHourlyCandle = { time: number, open: number, high: number, low: number, close: number, volume: number, };

export type TradeLogHourlyChart = { symbol: TickerSymbol, candles: Array<TradeLogHourlyCandle>, history_limited: boolean, };

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

export type ApplicationResource = { "domain": "industry", "resource": IndustryResource } | { "domain": "tickers", "resource": TickerMetricsResource } | { "domain": "tracker", "resource": TrackerResource };

export type TrackerMode = "theme" | "sector";

export type TrackerResource = { mode: TrackerMode, };

export type TrackerRow = { key: string, name: string, etf_symbol: TickerSymbol, industry_keys: Array<string>, performance: PerformancePeriods | null, previous_close: number | null, loading: boolean, error: string | null, };

export type TrackerUpdate = { "type": "catalog", mode: TrackerMode, rows: Array<TrackerRow>, } | { "type": "row", mode: TrackerMode, row: TrackerRow, } | { "type": "complete", mode: TrackerMode, };

export type MarketHours = { market_date: string, time_zone: string, is_trading_day: boolean, closes_at: string, day_ends_at: string, server_time: string, };

export type ApplicationCommand = { "type": "subscribe", subscription_id: string, resource: ApplicationResource, } | { "type": "unsubscribe", subscription_id: string, };

export type ApplicationSnapshot = { "domain": "industry", "state": IndustryState } | { "domain": "tickers", "state": TickerMetricsUpdate } | { "domain": "tracker", "state": TrackerUpdate };

export type ApplicationEvent = { "type": "snapshot", subscription_id: string, payload: ApplicationSnapshot, } | { "type": "error", subscription_id: string, message: string, };
