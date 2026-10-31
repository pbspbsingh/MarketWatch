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

CREATE TABLE fundamentals (
    symbol TEXT PRIMARY KEY NOT NULL REFERENCES tickers(symbol) ON DELETE CASCADE,
    payload JSON NOT NULL,
    fetched_at DATETIME NOT NULL
);

CREATE TABLE nyse_holidays (
    market_date DATE PRIMARY KEY NOT NULL,
    fetched_at DATETIME NOT NULL
);

CREATE TABLE industry_rankings (
    industry_key TEXT PRIMARY KEY NOT NULL,
    industry_name TEXT NOT NULL,
    market_date DATE NOT NULL,
    fetched_at DATETIME NOT NULL,
    performance_day REAL NOT NULL,
    performance_week REAL NOT NULL,
    performance_month REAL NOT NULL,
    performance_quarter REAL NOT NULL,
    performance_half_year REAL NOT NULL,
    performance_year REAL NOT NULL,
    performance_year_to_date REAL NOT NULL
);

CREATE TABLE industry_memberships (
    industry_key TEXT PRIMARY KEY NOT NULL,
    fetched_at DATETIME NOT NULL,
    industry_name TEXT
);

CREATE TABLE industry_membership_tickers (
    industry_key TEXT NOT NULL REFERENCES industry_memberships(industry_key) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    PRIMARY KEY (industry_key, symbol)
);

CREATE INDEX industry_membership_tickers_symbol
    ON industry_membership_tickers (symbol);

CREATE TABLE industry_classifications (
    industry_key TEXT PRIMARY KEY NOT NULL,
    industry_name TEXT NOT NULL,
    sector_key TEXT NOT NULL,
    sector_name TEXT NOT NULL,
    ticker_count INTEGER NOT NULL CHECK (ticker_count >= 0),
    fetched_at DATETIME NOT NULL
);

CREATE INDEX industry_classifications_sector
    ON industry_classifications (sector_name, industry_name);

CREATE TABLE n_factor_reports (
    symbol TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('stock_titan', 'finviz')),
    payload JSON NOT NULL,
    PRIMARY KEY (symbol, source)
);

CREATE TABLE fundamental_assessments (
    symbol TEXT PRIMARY KEY NOT NULL,
    payload JSON NOT NULL CHECK (json_valid(payload))
);
