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
    fetched_at DATETIME NOT NULL
);

CREATE INDEX industry_classifications_sector
    ON industry_classifications (sector_name, industry_name);
