CREATE TABLE theme_ai_jobs (
    id INTEGER PRIMARY KEY NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'applied')),
    symbols JSON NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    response TEXT,
    suggestions JSON,
    error TEXT,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

CREATE INDEX theme_ai_jobs_updated_at
    ON theme_ai_jobs (updated_at DESC);
