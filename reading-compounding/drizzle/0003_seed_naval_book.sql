INSERT INTO books (title, author, source, status, note, import_status, created_at, updated_at)
SELECT '纳瓦尔宝典', 'Eric Jorgenson', 'owner', 'want', 'The Almanack of Naval Ravikant。官方免费 EPUB 已暂存于所有者本地，待导入。', 'pending', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM books);
