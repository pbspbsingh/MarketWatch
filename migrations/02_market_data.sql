CREATE TABLE tickers (
    symbol TEXT PRIMARY KEY NOT NULL,
    name TEXT,
    exchange TEXT NOT NULL,
    description TEXT,
    profile_fetched_at DATETIME
);

CREATE TABLE daily_candles (
    symbol TEXT NOT NULL REFERENCES tickers(symbol) ON DELETE CASCADE,
    market_date DATE NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume INTEGER NOT NULL,
    PRIMARY KEY (symbol, market_date)
);

CREATE INDEX daily_candles_symbol_market_date_desc
    ON daily_candles (symbol, market_date DESC);
