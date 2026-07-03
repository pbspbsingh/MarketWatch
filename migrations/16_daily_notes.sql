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
    mime_type TEXT NOT NULL CHECK (mime_type = 'image/webp'),
    width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 1920),
    height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 1920),
    source_blob BLOB NOT NULL CHECK (length(source_blob) BETWEEN 1 AND 5242880),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE daily_note_image_refs (
    id INTEGER PRIMARY KEY NOT NULL,
    note_date DATE NOT NULL REFERENCES daily_notes(note_date) ON DELETE CASCADE,
    image_id INTEGER NOT NULL REFERENCES daily_note_images(id) ON DELETE CASCADE,
    annotations_json TEXT NOT NULL DEFAULT '{"version":1,"objects":[]}',
    rendered_blob BLOB CHECK (rendered_blob IS NULL OR length(rendered_blob) BETWEEN 1 AND 5242880),
    detached_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (json_valid(annotations_json))
);

CREATE INDEX daily_note_image_refs_image_id
    ON daily_note_image_refs (image_id);

CREATE INDEX daily_note_image_refs_note_date
    ON daily_note_image_refs (note_date);

CREATE INDEX daily_note_image_refs_detached_at
    ON daily_note_image_refs (detached_at)
    WHERE detached_at IS NOT NULL;
