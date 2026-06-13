CREATE TABLE fundamentals (
    symbol TEXT PRIMARY KEY NOT NULL REFERENCES tickers(symbol) ON DELETE CASCADE,
    payload JSON NOT NULL,
    fetched_at DATETIME NOT NULL
);
