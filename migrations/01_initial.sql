CREATE TABLE industry_snapshots (
    id INTEGER PRIMARY KEY NOT NULL,
    market_date DATE NOT NULL UNIQUE,
    fetched_at DATETIME NOT NULL
);

CREATE TABLE industry_snapshot_rows (
    snapshot_id INTEGER NOT NULL REFERENCES industry_snapshots(id) ON DELETE CASCADE,
    industry_key TEXT NOT NULL,
    industry_name TEXT NOT NULL,
    performance_week REAL NOT NULL,
    performance_month REAL NOT NULL,
    performance_quarter REAL NOT NULL,
    performance_half_year REAL NOT NULL,
    performance_year REAL NOT NULL,
    performance_year_to_date REAL NOT NULL,
    PRIMARY KEY (snapshot_id, industry_key)
);

CREATE INDEX industry_snapshots_market_date_desc
    ON industry_snapshots (market_date DESC);
