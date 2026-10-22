DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  import_status TEXT NOT NULL,
  import_error TEXT,
  blob_key TEXT,
  version_label TEXT,
  cur_chapter INTEGER NOT NULL DEFAULT 0,
  cur_offset INTEGER NOT NULL DEFAULT 0,
  progress_value REAL,
  progress_unit TEXT,
  request_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE book_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id),
  idx INTEGER NOT NULL,
  title TEXT,
  html TEXT NOT NULL,
  char_count INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX book_chapters_book_idx ON book_chapters (book_id, idx);
--> statement-breakpoint
CREATE TABLE reading_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER REFERENCES books(id),
  date TEXT NOT NULL,
  minutes INTEGER,
  progress_value REAL,
  progress_unit TEXT,
  note TEXT,
  request_id TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE snippets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER REFERENCES books(id),
  book_title TEXT NOT NULL,
  version_label TEXT,
  chapter_label TEXT,
  chapter_idx INTEGER,
  char_offset INTEGER,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  think_prompt TEXT,
  reflection TEXT,
  internalized_at INTEGER,
  request_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE snippet_tags (
  snippet_id INTEGER NOT NULL REFERENCES snippets(id),
  tag TEXT NOT NULL,
  origin TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX snippet_tags_snippet ON snippet_tags (snippet_id);
--> statement-breakpoint
CREATE TABLE knowledge_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  core TEXT NOT NULL,
  snippet_id INTEGER REFERENCES snippets(id),
  source_label TEXT,
  annotation TEXT,
  origin TEXT NOT NULL,
  request_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE card_tags (
  card_id INTEGER NOT NULL REFERENCES knowledge_cards(id),
  tag TEXT NOT NULL,
  origin TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX card_tags_card ON card_tags (card_id);
--> statement-breakpoint
CREATE TABLE card_reuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES knowledge_cards(id),
  date TEXT NOT NULL,
  scene TEXT NOT NULL,
  outcome TEXT NOT NULL,
  request_id TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE request_keys (
  request_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_table TEXT,
  result_id INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
