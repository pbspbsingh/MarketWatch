CREATE TABLE trade_analyzer_state (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    data_revision INTEGER NOT NULL DEFAULT 0 CHECK (data_revision >= 0)
);
INSERT INTO trade_analyzer_state (singleton) VALUES (1);

CREATE TABLE trade_accounts (
    id INTEGER PRIMARY KEY NOT NULL,
    broker TEXT NOT NULL,
    external_key TEXT NOT NULL,
    label TEXT NOT NULL,
    timezone TEXT NOT NULL,
    needs_rebuild INTEGER NOT NULL DEFAULT 0 CHECK (needs_rebuild IN (0, 1)),
    UNIQUE (broker, external_key)
);

CREATE TABLE trade_imports (
    id INTEGER PRIMARY KEY NOT NULL,
    account_id INTEGER NOT NULL REFERENCES trade_accounts(id),
    broker_adapter TEXT NOT NULL,
    file_hash TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    range_start DATE NOT NULL,
    range_end DATE NOT NULL,
    imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE trade_executions (
    id INTEGER PRIMARY KEY NOT NULL,
    account_id INTEGER NOT NULL REFERENCES trade_accounts(id),
    import_id INTEGER REFERENCES trade_imports(id),
    event_key TEXT NOT NULL UNIQUE,
    origin TEXT NOT NULL CHECK (origin IN ('broker', 'manual')),
    executed_at_utc DATETIME NOT NULL,
    executed_at_local TEXT NOT NULL,
    market_date DATE NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    position_effect TEXT NOT NULL CHECK (position_effect IN ('open', 'close')),
    quantity_micros INTEGER NOT NULL CHECK (quantity_micros > 0),
    price_micros INTEGER NOT NULL CHECK (price_micros > 0),
    fee_micros INTEGER NOT NULL DEFAULT 0,
    source_sequence INTEGER NOT NULL,
    raw_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX trade_executions_lifecycle
    ON trade_executions (account_id, symbol, executed_at_utc, source_sequence);

CREATE TABLE trade_risk_stops (
    id INTEGER PRIMARY KEY NOT NULL,
    account_id INTEGER NOT NULL REFERENCES trade_accounts(id),
    import_id INTEGER REFERENCES trade_imports(id),
    event_key TEXT NOT NULL UNIQUE,
    trade_opened_at_utc DATETIME NOT NULL,
    placed_at_utc DATETIME NOT NULL,
    placed_at_local TEXT NOT NULL,
    market_date DATE NOT NULL,
    symbol TEXT NOT NULL,
    quantity_micros INTEGER NOT NULL,
    price_micros INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('initial', 'active'))
);
CREATE INDEX trade_risk_stops_lifecycle
    ON trade_risk_stops (account_id, symbol, placed_at_utc);

CREATE TABLE analyzer_trades (
    id INTEGER PRIMARY KEY NOT NULL,
    lifecycle_key TEXT NOT NULL UNIQUE,
    account_id INTEGER NOT NULL REFERENCES trade_accounts(id),
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
    position_status TEXT NOT NULL CHECK (position_status IN ('open', 'closed')),
    history_quality TEXT NOT NULL CHECK (history_quality IN ('complete', 'incomplete', 'conflicted')),
    opened_at DATETIME,
    opened_at_local TEXT,
    opening_month TEXT NOT NULL,
    closed_at DATETIME,
    quantity_micros INTEGER NOT NULL,
    remaining_quantity_micros INTEGER NOT NULL,
    average_entry_micros INTEGER,
    average_exit_micros INTEGER,
    initial_stop_micros INTEGER,
    active_stop_micros INTEGER,
    realized_pnl_micros INTEGER,
    fees_micros INTEGER NOT NULL DEFAULT 0,
    execution_ids_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX analyzer_trades_month ON analyzer_trades (account_id, opening_month, opened_at);

CREATE TABLE trade_overrides (
    trade_id INTEGER PRIMARY KEY NOT NULL REFERENCES analyzer_trades(id) ON DELETE CASCADE,
    quantity_micros INTEGER,
    average_entry_micros INTEGER,
    initial_stop_micros INTEGER,
    active_stop_micros INTEGER,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE trade_journals (
    trade_id INTEGER PRIMARY KEY NOT NULL REFERENCES analyzer_trades(id) ON DELETE CASCADE,
    comment TEXT NOT NULL DEFAULT '',
    strategy TEXT NOT NULL DEFAULT '',
    edges TEXT NOT NULL DEFAULT '',
    lessons TEXT NOT NULL DEFAULT '',
    mistakes TEXT NOT NULL DEFAULT '',
    rating INTEGER CHECK (rating BETWEEN 1 AND 5)
);

CREATE TABLE trade_tags (
    id INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE
);
CREATE TABLE trade_tag_assignments (
    trade_id INTEGER NOT NULL REFERENCES analyzer_trades(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES trade_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (trade_id, tag_id)
);
