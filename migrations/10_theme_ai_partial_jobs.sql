PRAGMA foreign_keys = OFF;

CREATE TABLE theme_ai_jobs_new (
    id INTEGER PRIMARY KEY NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'pending', 'running', 'completed', 'partially_failed', 'failed', 'applied'
    )),
    symbols JSON NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    response TEXT,
    suggestions JSON,
    validation_errors JSON,
    error TEXT,
    retry_of_job_id INTEGER,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

INSERT INTO theme_ai_jobs_new (
    id, status, symbols, model, prompt, response, suggestions, error, created_at, updated_at
)
SELECT id, status, symbols, model, prompt, response, suggestions, error, created_at, updated_at
FROM theme_ai_jobs;

DROP TABLE theme_ai_jobs;
ALTER TABLE theme_ai_jobs_new RENAME TO theme_ai_jobs;

CREATE INDEX theme_ai_jobs_updated_at
    ON theme_ai_jobs (updated_at DESC);

CREATE TABLE theme_ai_processed_symbols (
    symbol TEXT PRIMARY KEY NOT NULL,
    job_id INTEGER,
    outcome TEXT NOT NULL CHECK (outcome IN ('assigned', 'no_theme')),
    processed_at DATETIME NOT NULL,
    FOREIGN KEY (job_id) REFERENCES theme_ai_jobs(id) ON DELETE SET NULL
);

PRAGMA foreign_keys = ON;
