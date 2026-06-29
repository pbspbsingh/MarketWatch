ALTER TABLE industry_snapshot_rows
ADD COLUMN performance_day REAL NOT NULL DEFAULT 0.0;

DELETE FROM industry_snapshots
WHERE market_date = (
    SELECT MAX(market_date)
    FROM industry_snapshots
);
