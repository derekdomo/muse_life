ALTER TABLE books ADD COLUMN import_gen TEXT;
--> statement-breakpoint
ALTER TABLE books ADD COLUMN import_blob_key TEXT;
--> statement-breakpoint
CREATE TABLE import_staged_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id),
  gen TEXT NOT NULL,
  idx INTEGER NOT NULL,
  title TEXT,
  html TEXT NOT NULL,
  char_count INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX import_staged_chapters_book_gen_idx ON import_staged_chapters (book_id, gen, idx);
