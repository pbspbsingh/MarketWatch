CREATE TABLE trade_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    symbol TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    direction TEXT NOT NULL DEFAULT 'long' CHECK (direction IN ('long', 'short'))
);

CREATE TABLE trade_log_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    trade_id INTEGER NOT NULL REFERENCES trade_logs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    executed_at TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    price INTEGER NOT NULL CHECK (price > 0),
    fee INTEGER NOT NULL CHECK (fee >= 0),
    notes TEXT NOT NULL DEFAULT '',
    UNIQUE (trade_id, sequence)
);
CREATE INDEX trade_log_executions_trade ON trade_log_executions(trade_id);

CREATE TABLE trade_log_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
);

CREATE TABLE trade_log_tag_links (
    trade_id INTEGER NOT NULL REFERENCES trade_logs(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES trade_log_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (trade_id, tag_id)
);
CREATE INDEX trade_log_tag_links_tag ON trade_log_tag_links(tag_id);

CREATE TABLE trade_log_execution_tags (
    execution_id INTEGER NOT NULL REFERENCES trade_log_executions(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES trade_log_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (execution_id, tag_id)
);
CREATE INDEX trade_log_execution_tags_tag ON trade_log_execution_tags(tag_id);
