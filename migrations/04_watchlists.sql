CREATE TABLE watchlists (
    id INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('favourites', 'custom')),
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    icon_key TEXT NOT NULL DEFAULT 'bookmark'
);

CREATE TABLE watchlist_tickers (
    watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL COLLATE NOCASE REFERENCES tickers(symbol) ON DELETE CASCADE,
    added_at DATETIME NOT NULL,
    PRIMARY KEY (watchlist_id, symbol)
);

CREATE INDEX watchlist_tickers_symbol
    ON watchlist_tickers (symbol);

CREATE UNIQUE INDEX watchlists_icon_key
    ON watchlists (icon_key);

CREATE UNIQUE INDEX watchlists_single_favourites
    ON watchlists (kind)
    WHERE kind = 'favourites';

INSERT INTO watchlists (name, kind, icon_key, created_at, updated_at)
VALUES ('Favourites', 'favourites', 'bookmark', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
