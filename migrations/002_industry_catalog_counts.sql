-- Catalog entries are disposable provider cache. Reacquire complete entries,
-- including counts, rather than assigning invented counts to cached rows.
DROP TABLE industry_classifications;

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
