CREATE TABLE n_factor_reports_json (
    symbol TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('stock_titan', 'finviz')),
    payload JSON NOT NULL,
    PRIMARY KEY (symbol, source)
);

INSERT INTO n_factor_reports_json (symbol, source, payload)
SELECT symbol, source, payload FROM n_factor_reports;

DROP TABLE n_factor_reports;
ALTER TABLE n_factor_reports_json RENAME TO n_factor_reports;
