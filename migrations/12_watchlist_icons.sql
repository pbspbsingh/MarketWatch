ALTER TABLE watchlists
    ADD COLUMN icon_key TEXT NOT NULL DEFAULT 'bookmark';

CREATE UNIQUE INDEX watchlists_icon_key
    ON watchlists (icon_key);

CREATE UNIQUE INDEX watchlists_single_favourites
    ON watchlists (kind)
    WHERE kind = 'favourites';
