CREATE TABLE theme_audits (
    symbol TEXT PRIMARY KEY NOT NULL REFERENCES tickers(symbol) ON DELETE CASCADE,
    current_themes JSON NOT NULL,
    suggested_themes JSON NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('matched', 'pending', 'accepted', 'ignored')),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    reasoning TEXT NOT NULL,
    model TEXT NOT NULL,
    input_fingerprint TEXT NOT NULL,
    audited_at DATETIME NOT NULL,
    processed_at DATETIME
);

CREATE INDEX theme_audits_status_confidence
    ON theme_audits (status, confidence DESC);
