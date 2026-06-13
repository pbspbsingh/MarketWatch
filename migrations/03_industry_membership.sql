CREATE TABLE industry_memberships (
    industry_key TEXT PRIMARY KEY NOT NULL,
    fetched_at DATETIME NOT NULL
);

CREATE TABLE industry_membership_tickers (
    industry_key TEXT NOT NULL REFERENCES industry_memberships(industry_key) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    PRIMARY KEY (industry_key, symbol)
);

CREATE INDEX industry_membership_tickers_symbol
    ON industry_membership_tickers (symbol);

