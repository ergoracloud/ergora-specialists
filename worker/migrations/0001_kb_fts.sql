-- D1 `ergora-kb-fts`: keyword fallback for the public specialists KB.
-- Holds only rows that passed the sync gate (recurated, allowlisted https source, non-empty summary).
-- kb_docs doubles as the sync manifest (id + content_hash), so the weekly job knows what to delete.

CREATE TABLE IF NOT EXISTS kb_docs (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,          -- same id as the Vectorize vector: <vertical>_<supabase id>
  vertical TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
  title, summary, vertical,
  content = 'kb_docs', content_rowid = 'rid',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS kb_docs_ai AFTER INSERT ON kb_docs BEGIN
  INSERT INTO kb_fts (rowid, title, summary, vertical) VALUES (new.rid, new.title, new.summary, new.vertical);
END;

CREATE TRIGGER IF NOT EXISTS kb_docs_ad AFTER DELETE ON kb_docs BEGIN
  INSERT INTO kb_fts (kb_fts, rowid, title, summary, vertical) VALUES ('delete', old.rid, old.title, old.summary, old.vertical);
END;

CREATE TRIGGER IF NOT EXISTS kb_docs_au AFTER UPDATE ON kb_docs BEGIN
  INSERT INTO kb_fts (kb_fts, rowid, title, summary, vertical) VALUES ('delete', old.rid, old.title, old.summary, old.vertical);
  INSERT INTO kb_fts (rowid, title, summary, vertical) VALUES (new.rid, new.title, new.summary, new.vertical);
END;
