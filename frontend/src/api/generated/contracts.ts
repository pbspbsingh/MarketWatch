// Generated from Rust. Run cargo run -- --export-contracts.

export type TickerSymbol = string;

export type RejectedTicker = { symbol: TickerSymbol, reason: string, };

export type TickerCollectionFile = { name: string, row_count: number, extracted_count: number, skipped_rows: number, };

export type TickerCollectionSource = { "type": "csv", files: Array<TickerCollectionFile>, } | { "type": "pasted" };

export type TickerCollection = { version: number, source: TickerCollectionSource, symbols: Array<TickerSymbol>, skipped_rows: number, created_at: string, rejected_symbols: Array<RejectedTicker>, };

export type PerformancePeriods = { day: number, week: number, month: number, quarter: number, half_year: number, year: number, };

export type ThemeRanking = { id: number, name: string, etf_symbol: TickerSymbol, ticker_count: number, performance: PerformancePeriods | null, absolute_strength: number | null, previous_close: number | null, };

export type IndustryClassification = { industry_key: string, industry_name: string, sector_key: string, sector_name: string, ticker_count: number, };

export type IndustryResource = { "type": "catalog" } | { "type": "membership", industry_key: string, };

export type IndustryData = { "type": "catalog", industries: Array<IndustryClassification>, } | { "type": "membership", industry_key: string, symbols: Array<string>, };

export type IndustryState = { data: IndustryData, fetched_at: string | null, expires_at: string | null, loading: boolean, error: string | null, };

export type ApplicationResource = { "domain": "industry", "resource": IndustryResource };

export type ApplicationCommand = { "type": "subscribe", subscription_id: string, resource: ApplicationResource, } | { "type": "unsubscribe", subscription_id: string, };

export type ApplicationSnapshot = { "domain": "industry", "state": IndustryState };

export type ApplicationEvent = { "type": "snapshot", subscription_id: string, payload: ApplicationSnapshot, } | { "type": "error", subscription_id: string, message: string, };
