CREATE TABLE industry_classifications (
    industry_key TEXT PRIMARY KEY NOT NULL,
    industry_name TEXT NOT NULL,
    sector_key TEXT NOT NULL,
    sector_name TEXT NOT NULL,
    fetched_at DATETIME NOT NULL
);

CREATE INDEX industry_classifications_sector
    ON industry_classifications (sector_name, industry_name);
