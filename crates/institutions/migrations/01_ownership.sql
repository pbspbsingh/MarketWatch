CREATE TABLE imported_sources (
    name TEXT PRIMARY KEY NOT NULL,
    fingerprint TEXT NOT NULL,
    imported_at DATETIME NOT NULL
);

CREATE TABLE dataset (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    latest_period INTEGER NOT NULL,
    updated_at DATETIME NOT NULL
);

CREATE TABLE filings (
    archive_period INTEGER NOT NULL,
    accession TEXT NOT NULL,
    fund_id TEXT NOT NULL,
    fund_name TEXT NOT NULL,
    registrant_name TEXT NOT NULL,
    cik TEXT NOT NULL,
    report_date DATE NOT NULL,
    filing_date DATE NOT NULL,
    has_omissions INTEGER NOT NULL,
    PRIMARY KEY (archive_period, accession)
) WITHOUT ROWID;

CREATE TABLE holdings (
    archive_period INTEGER NOT NULL,
    holding_id TEXT NOT NULL,
    accession TEXT NOT NULL,
    cusip TEXT NOT NULL,
    currency TEXT NOT NULL,
    shares REAL,
    portfolio_weight REAL,
    depositary_receipt INTEGER NOT NULL,
    PRIMARY KEY (archive_period, holding_id),
    FOREIGN KEY (archive_period, accession) REFERENCES filings (archive_period, accession)
        ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX holdings_cusip ON holdings (cusip, archive_period);
CREATE INDEX holdings_filing ON holdings (archive_period, accession);

CREATE TABLE identifiers (
    archive_period INTEGER NOT NULL,
    holding_id TEXT NOT NULL,
    ticker TEXT NOT NULL,
    PRIMARY KEY (ticker, archive_period, holding_id)
) WITHOUT ROWID;

CREATE TABLE issuers (
    ticker TEXT PRIMARY KEY NOT NULL,
    cik INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX issuers_cik ON issuers (cik);

CREATE TABLE share_counts (
    cik INTEGER NOT NULL,
    as_of DATE NOT NULL,
    shares REAL NOT NULL,
    PRIMARY KEY (cik, as_of)
) WITHOUT ROWID;
