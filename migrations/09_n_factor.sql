CREATE TABLE n_factor_reports (
    symbol TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('stock_titan', 'finviz')),
    payload TEXT NOT NULL,
    PRIMARY KEY (symbol, source)
);
