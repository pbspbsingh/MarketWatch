CREATE TABLE fundamental_assessments (
    symbol TEXT PRIMARY KEY NOT NULL,
    payload JSON NOT NULL CHECK (json_valid(payload))
);
