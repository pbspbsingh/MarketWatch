INSERT OR REPLACE INTO theme_ai_processed_symbols (symbol, job_id, outcome, processed_at)
SELECT
    UPPER(TRIM(json_extract(suggestion.value, '$.symbol'))),
    theme_ai_jobs.id,
    CASE
        WHEN json_array_length(json_extract(suggestion.value, '$.themes')) = 0 THEN 'no_theme'
        ELSE 'assigned'
    END,
    theme_ai_jobs.updated_at
FROM theme_ai_jobs, json_each(theme_ai_jobs.suggestions) AS suggestion
WHERE theme_ai_jobs.status IN ('completed', 'applied')
  AND json_type(suggestion.value, '$.symbol') = 'text'
  AND TRIM(json_extract(suggestion.value, '$.symbol')) <> ''
ORDER BY theme_ai_jobs.updated_at;
