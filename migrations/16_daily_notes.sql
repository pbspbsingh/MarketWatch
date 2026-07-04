CREATE TABLE daily_notes (
    note_date DATE PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    markdown TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE daily_notes_fts USING fts5(
    title,
    markdown,
    content = 'daily_notes',
    content_rowid = 'rowid',
    tokenize = 'trigram'
);

CREATE TRIGGER daily_notes_fts_insert
AFTER INSERT ON daily_notes
BEGIN
    INSERT INTO daily_notes_fts (rowid, title, markdown)
    VALUES (new.rowid, new.title, new.markdown);
END;

CREATE TRIGGER daily_notes_fts_update
AFTER UPDATE OF title, markdown ON daily_notes
BEGIN
    INSERT INTO daily_notes_fts (daily_notes_fts, rowid, title, markdown)
    VALUES ('delete', old.rowid, old.title, old.markdown);
    INSERT INTO daily_notes_fts (rowid, title, markdown)
    VALUES (new.rowid, new.title, new.markdown);
END;

CREATE TRIGGER daily_notes_fts_delete
AFTER DELETE ON daily_notes
BEGIN
    INSERT INTO daily_notes_fts (daily_notes_fts, rowid, title, markdown)
    VALUES ('delete', old.rowid, old.title, old.markdown);
END;

CREATE TABLE daily_note_images (
    id INTEGER PRIMARY KEY NOT NULL,
    note_date DATE NOT NULL REFERENCES daily_notes(note_date) ON DELETE CASCADE,
    width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 1920),
    height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 1920),
    image_blob BLOB NOT NULL CHECK (length(image_blob) BETWEEN 1 AND 5242880),
    detached_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX daily_note_images_note_date
    ON daily_note_images (note_date);

CREATE INDEX daily_note_images_detached_at
    ON daily_note_images (detached_at)
    WHERE detached_at IS NOT NULL;
