// CMP-READ-IMPORT-001 validation — import original-key / generation
// protection for EXISTING books (and the new-book path).
//
// Extended for the P0 remainder (PM 2026-10-22): schedule (1) closed-
// generation file immutability, schedule (2) unbound writes never
// completing a bound generation, schedule (3) commit-point
// re-verification under begin/save, begin/promotion and
// begin/upload interleavings, schedule (6) pending-label staging +
// snippet provenance, and the live-copy matrix data. NOTE: the old
// expectation that an unbound (no-importId) write binds to the
// book's current generation was WRONG and has been corrected to a
// typed-conflict expectation.
//
// Reproduces the PM's repro against the REAL handlers
// (server/src/actions.ts) on a throwaway in-memory libsql database
// (schema applied from drizzle/*.sql) with a synthetic blob store:
// an import completes on an existing book, then the SAME beginImport
// key + payload is replayed — chapters, content, importStatus,
// reading position and the ledger must all be untouched. Then the
// full criteria list: same-key retries / conflicts / concurrency on
// both paths; failure + lost-response recovery at every write point
// (begin / upload / chunk / finish); stale-generation writes refused
// with the live copy intact; reads only ever seeing the complete old
// or complete new version; duplicate-idx arbitration; deleted books
// never resurrected; legacy (pre-generation) books and unbound
// old-client writes; strict owner gate with zero db/blob access.
//
// Synthetic data only; the real app.db is never opened.
// Run with: bun validate-import-generations.mjs
import { readFileSync, readdirSync } from "node:fs";

let passed = 0;
let failures = 0;
function check(name, ok, note = "") {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${note ? ` (${note})` : ""}`);
}

/* ---------------- source wiring ---------------- */

const serverSrc = readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8");
const booksSrc = readFileSync(new URL("./client/src/Books.tsx", import.meta.url), "utf8");

function actionSlice(src, name) {
  const start = src.indexOf(`  ${name}: defineAction({`);
  if (start < 0) throw new Error(`action ${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n  \w+: defineAction\(\{/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

{
  const begin = actionSlice(serverSrc, "beginImport");
  check(
    "source: beginImport arbitrates through the ledger on BOTH paths (existingBookId + new book)",
    (begin.match(/arbitrateCreate\(db, args\.requestId, "import-book", hash\)/g) ?? []).length === 2,
  );
  check(
    "source: existing-book fingerprint covers existingBookId + versionLabel",
    begin.includes("existingBookId: args.existingBookId") && begin.includes("versionLabel: args.versionLabel || null"),
  );
  check(
    "source: beginImport never deletes live chapters (no bookChapters delete in begin)",
    !begin.includes("delete(schema.bookChapters)"),
  );
  check(
    "source: generation binding helper arbitrates importId before writes (resolveImportBinding)",
    serverSrc.includes("async function resolveImportBinding") &&
      serverSrc.includes("book.importGen !== importId"),
  );
  const save = actionSlice(serverSrc, "saveImportChapters");
  check(
    "source: saveImportChapters stages into import_staged_chapters (not the live table) on the generation path",
    save.includes("schema.importStagedChapters"),
  );
  const fin = actionSlice(serverSrc, "finishImport");
  check(
    "source: finishImport promotes via guarded insert-select (import_gen + processing guard)",
    fin.includes(".select(") &&
      fin.includes("FROM import_staged_chapters") &&
      fin.includes("import_gen") &&
      fin.includes("import_status = 'processing'"),
  );
  check(
    "source: finishImport validates the staged generation (contiguity + reported chapterCount)",
    fin.includes("idxs.has(i)") && fin.includes("args.chapterCount !== staged.length"),
  );
  check(
    "client: every import write carries the attempt's generation key (importId)",
    (booksSrc.match(/importId: importRequestId/g) ?? []).length >= 4,
    `${(booksSrc.match(/importId: importRequestId/g) ?? []).length} bound calls`,
  );
  check(
    "client: a fresh key is minted per import attempt (no stable per-book retry key)",
    booksSrc.includes("const importRequestId = newRequestId();") && !booksSrc.includes("retry-${target.id}"),
  );
  check(
    "client: finishImport reports the parsed chapter count for server-side validation",
    booksSrc.includes("chapterCount: parsed.chapters.length"),
  );
  check(
    "source: beginImport stages the pending edition label with the generation and NEVER overwrites the live versionLabel",
    (begin.match(/importVersionLabel: args\.versionLabel \|\| null/g) ?? []).length === 2 &&
      (begin.match(/versionLabel: args\.versionLabel \|\| null/g) ?? []).length === 2 &&
      !begin.includes("versionLabel: args.versionLabel || book.versionLabel"),
  );
  check(
    "source: finishImport promotes the staged label from the book row's CURRENT columns inside the batch (COALESCE, label switches with body/file)",
    fin.includes("COALESCE") &&
      fin.includes("importVersionLabel: null") &&
      fin.includes("liveGen: gen"),
  );
  check(
    "source: finishImport freezes the validated staged set and re-validates under the freeze (manifest + deleted + blob existence)",
    fin.includes("stagedManifest(staged)") &&
      fin.includes("importFrozenManifest: manifest") &&
      fin.includes("stagedManifest(stagedAfter) === manifest") &&
      fin.includes("ctx.blobs.head(fresh.importBlobKey)"),
  );
  const upload = actionSlice(serverSrc, "uploadImportFile");
  check(
    "source: the staged file key is content-addressed (rival first uploads can never share a key)",
    serverSrc.includes("function stagedFileKey") &&
      upload.includes("stagedFileKey(args.bookId, gen, hash)"),
  );
  check(
    "source: reader writes bind to the live version (getChapter returns liveVersion; savePosition/createSnippet refuse a stale one)",
    serverSrc.includes("liveVersion: book.liveGen") &&
      serverSrc.includes("args.liveVersion !== book.liveGen"),
  );
  check(
    "source: uploadImportFile arbitrates a generation's file on its recorded content fingerprint (bytesHash + importFileHash)",
    upload.includes("bytesHash(bytes)") &&
      upload.includes("book.importFileHash === hash") &&
      upload.includes("importFileHash: hash"),
  );
  check(
    "source: saveImportChapters re-verifies generation + processing INSIDE the batch (guarded statements + post-batch re-read)",
    save.includes("import_gen = ${gen}") &&
      save.includes("import_status = 'processing'") &&
      save.includes("now.importGen !== gen"),
  );
  check(
    "source: unbound writes are refused when a generation is bound (no presumption of belonging)",
    serverSrc.includes("if (book.importGen != null)") &&
      serverSrc.includes("must NOT be presumed"),
  );
  check(
    "client: the book card separates live-copy readability from import state (saved-version read entry, pending/failed lines, labels apart)",
    booksSrc.includes("继续阅读已保存版本") &&
      booksSrc.includes("新版本正在导入") &&
      booksSrc.includes("新版本未替换成功，旧版本仍可用") &&
      booksSrc.includes("重试新版本") &&
      booksSrc.includes("hasLiveCopy"),
  );
  check(
    "client: a successful re-import states the new version starts from the beginning (position never claimed to migrate)",
    booksSrc.includes("将从头开始阅读"),
  );
}

/* ----- third-round source checks (PM 2026-10-22 15:52) ----- */

const readerSrc = readFileSync(new URL("./client/src/Reader.tsx", import.meta.url), "utf8");
const homeSrc = readFileSync(new URL("./client/src/Home.tsx", import.meta.url), "utf8");
const snippetsSrc = readFileSync(new URL("./client/src/Snippets.tsx", import.meta.url), "utf8");
const libSrc = readFileSync(new URL("./client/src/lib.ts", import.meta.url), "utf8");

{
  const gc = actionSlice(serverSrc, "getChapter");
  check(
    "source (3R): getChapter takes body + TOC + liveVersion + versionLabel from ONE join query (chapters ⋈ books, not-deleted in the same statement)",
    gc.includes(".innerJoin(schema.books") &&
      gc.includes("eq(schema.bookChapters.bookId, schema.books.id)") &&
      gc.includes("isNull(schema.books.deletedAt)"),
  );
  check(
    "source (3R): getChapter's books-row fallback is gated on ZERO chapter rows (no body to mislabel)",
    gc.includes("if (rows.length === 0)"),
  );
  const cs = actionSlice(serverSrc, "createSnippet");
  check(
    "source (3R): createSnippet's snippet AND ledger inserts are both guarded insert-selects over the books row in the same batch",
    (cs.match(/FROM books WHERE \$\{versionGuard\}/g) ?? []).length === 2 &&
      cs.includes(".insert(schema.snippets)") &&
      cs.includes(".insert(schema.requestKeys)"),
  );
  check(
    "source (3R): the createSnippet guard is strict live_gen equality with NULL === NULL, plus id + not-deleted",
    serverSrc.includes(
      "(live_gen IS NULL AND ${baseline} IS NULL) OR live_gen = ${baseline}",
    ) &&
      serverSrc.includes("deleted_at IS NULL"),
  );
  check(
    "source (3R): createSnippet still arbitrates committed keys FIRST (replay never reaches the guard)",
    cs.indexOf("arbitrateCreate(db, args.requestId, \"snippet\", hash)") >= 0 &&
      cs.indexOf("arbitrateCreate(db, args.requestId, \"snippet\", hash)") <
        cs.indexOf("versionGuard"),
  );
  const sp = actionSlice(serverSrc, "savePosition");
  check(
    "source (3R): savePosition's NULL-baseline UPDATE branch pins live_gen IS NULL in its WHERE (CAS)",
    sp.includes("isNull(schema.books.liveGen)"),
  );
  check(
    "source (3R): getBookLiveVersion exists as a metadata-only action (books row: liveGen + versionLabel)",
    serverSrc.includes("getBookLiveVersion: defineAction({") &&
      actionSlice(serverSrc, "getBookLiveVersion").includes("liveGen: schema.books.liveGen"),
  );
  check(
    "source (3R): Reader keeps a display snapshot and the in-page version label comes from it, not the book prop",
    readerSrc.includes("DisplaySnapshot") &&
      readerSrc.includes("snapshot?.versionLabel") &&
      !readerSrc.includes("book.versionLabel"),
  );
  check(
    "source (3R): the 检查新版本 button calls getBookLiveVersion only (never refetches chapter body)",
    readerSrc.includes("api.getBookLiveVersion") && !readerSrc.includes("chapter.refetch()"),
  );
  check(
    "source (3R): stale banner states old-version later chapters are unavailable; same-version check gives the up-to-date note",
    readerSrc.includes("旧版后续章节已不可用") && readerSrc.includes("已是最新版本"),
  );
  check(
    "source (3R): snippet version tri-state is ONE shared helper in lib.ts, used by both Snippets and Home",
    libSrc.includes("export function snippetVersionState") &&
      snippetsSrc.includes("snippetVersionState(snippet, book)") &&
      homeSrc.includes("snippetVersionState(savor, savorBook)"),
  );
  check(
    "source (3R): Home's replaced/unknown states explain and open the current version without the old position",
    homeSrc.includes("原文版本已替换：已保存的原句如上，旧位置无法在新版中确认") &&
      homeSrc.includes("无法确认这段原文与当前版本是否一致（版本记录缺失）") &&
      homeSrc.includes("onOpenReader(savorBook)"),
  );
}

/* ---------------- behavior: real handlers, in-memory db ---------------- */

const { Actions } = await import("./server/src/actions.ts");
const schema = await import("./server/src/schema.ts");
const { createClient } = await import("@libsql/client");
const { drizzle } = await import("drizzle-orm/libsql");
const { eq, and } = await import("drizzle-orm");

const client = createClient({ url: ":memory:" });
const migrationDir = new URL("./drizzle/", import.meta.url);
for (const file of readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort()) {
  const sqlText = readFileSync(new URL(file, migrationDir), "utf8");
  for (const stmt of sqlText.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim();
    if (trimmed) await client.execute(trimmed);
  }
}
const db = drizzle(client, { schema });

const blobStore = new Map();
const blobCalls = { put: 0, delete: 0 };
let failNextPut = false;
// One-shot put gate for deterministic upload interleavings: when
// armed with a predicate, the first matching put waits until the
// test releases it.
let putGate = null;

function makeCtx(viewer) {
  const state = { dbCalls: 0 };
  const ctx = {
    slug: "space-15-validate-import",
    invocationId: "validate-import-generations",
    spaceDir: "",
    viewer,
    db: () => {
      state.dbCalls += 1;
      return db;
    },
    blobs: {
      put: async (key, data) => {
        blobCalls.put += 1;
        if (failNextPut) {
          failNextPut = false;
          throw new Error("injected blob put failure");
        }
        if (putGate && putGate.match(key)) {
          const gate = putGate;
          putGate = null;
          await gate.promise;
        }
        blobStore.set(key, Buffer.from(data).toString("utf8"));
      },
      getUrl: async () => "",
      head: async (key) => (blobStore.has(key) ? { size: blobStore.get(key).length } : null),
      delete: async (key) => {
        blobCalls.delete += 1;
        blobStore.delete(key);
      },
      list: async () => [],
    },
    inference: {
      complete: async () => ({ tags: ["x"], thinkPrompt: "y" }),
    },
    invalidateQueries: () => {},
    executePrivileged: async () => {
      throw new Error("no privileged contracts in validate");
    },
  };
  return { ctx, state };
}
const OWNER = { id: "owner-1", isOwner: true };
const { ctx: owner } = makeCtx(OWNER);

async function call(name, ctx, args) {
  const action = Actions[name];
  const parsed = action.request.parse(args);
  const res = await action.handler(ctx, parsed);
  action.response.parse(res);
  return res;
}
async function attempt(name, ctx, args) {
  const action = Actions[name];
  const parsed = action.request.parse(args);
  try {
    const res = await action.handler(ctx, parsed);
    action.response.parse(res);
    return { threw: false, res };
  } catch (err) {
    return { threw: true, res: null, err };
  }
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
// Content-addressed staged file key (mirrors stagedFileKey in
// server/src/actions.ts): fingerprint = dual FNV-1a over the raw
// bytes + length, formatted len:h1:h2 with ":" → "-".
function skey(id, gen, bytesStr) {
  const bytes = Buffer.from(bytesStr, "utf8");
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes.readUInt8(i);
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ b, 0x85ebca6b);
  }
  const hash = `${bytes.length}:${(h1 >>> 0).toString(16).padStart(8, "0")}:${(h2 >>> 0).toString(16).padStart(8, "0")}`;
  return `epub-stage/${id}/${gen}/${hash.replaceAll(":", "-")}`;
}

async function bookRow(id) {
  const rows = await db.select().from(schema.books).where(eq(schema.books.id, id));
  return rows[0] ?? null;
}
async function liveChapters(id) {
  const rows = await db
    .select()
    .from(schema.bookChapters)
    .where(eq(schema.bookChapters.bookId, id));
  return rows.sort((a, b) => a.idx - b.idx);
}
async function stagedChapters(id, gen) {
  const cond = gen
    ? and(eq(schema.importStagedChapters.bookId, id), eq(schema.importStagedChapters.gen, gen))
    : eq(schema.importStagedChapters.bookId, id);
  const rows = await db.select().from(schema.importStagedChapters).where(cond);
  return rows.sort((a, b) => a.idx - b.idx);
}
function contentOf(rows) {
  return rows.map((r) => `${r.idx}:${r.html}`).join("|");
}
async function ledgerRow(requestId) {
  const rows = await db
    .select()
    .from(schema.requestKeys)
    .where(eq(schema.requestKeys.requestId, requestId));
  return rows[0] ?? null;
}
async function ledgerCount(requestId) {
  const rows = await db
    .select({ requestId: schema.requestKeys.requestId })
    .from(schema.requestKeys)
    .where(eq(schema.requestKeys.requestId, requestId));
  return rows.length;
}
// The live-version token a reader would pin for this book right
// now (reader writes must carry it — see the live-version binding
// checks at the end of this script).
async function liveVersionOf(id) {
  const r = await call("getChapter", owner, { bookId: id, idx: 0 });
  return r.liveVersion;
}
async function trigger(name, sqlText) {
  await client.execute(`CREATE TRIGGER ${name} ${sqlText}`);
}
async function dropTrigger(name) {
  await client.execute(`DROP TRIGGER IF EXISTS ${name}`);
}

// Seed row lands via the first owner read.
await call("getLibrary", owner, {});

/* ----- PM repro: existing-book import, then original-key replay ----- */

const added = await call("addBook", owner, {
  requestId: "imp-add-1",
  title: "既有之书",
  author: "合成作者",
  source: "owner",
  status: "reading",
  importStatus: "pending",
});
check("PM setup: addBook saved", added.ok === true && added.status === "saved");
const bookId = added.id;

const K1 = "imp-gen-1";
const begin1 = await call("beginImport", owner, {
  requestId: K1,
  title: "既有之书",
  author: "合成作者",
  source: "owner",
  versionLabel: "v1.epub",
  existingBookId: bookId,
});
check(
  "PM: beginImport on an existing book saves and returns the generation binding",
  begin1.ok === true && begin1.status === "saved" && begin1.id === bookId && begin1.gen === K1,
);
{
  const row = await bookRow(bookId);
  check(
    "PM: begin claims the generation (import_gen) and marks processing without touching the live copy",
    row?.importGen === K1 && row?.importStatus === "processing" && row?.blobKey === null,
  );
  const key = await ledgerRow(K1);
  check(
    "PM: the import key IS in the ledger from the start (result points at the book)",
    key != null && key.kind === "import-book" && key.resultTable === "books" && key.resultId === bookId,
  );
  check(
    "PM (schedule 6): begin stages the edition label with the generation — the LIVE versionLabel is untouched",
    row?.importVersionLabel === "v1.epub" && row?.versionLabel == null,
  );
}

const up1 = await call("uploadImportFile", owner, {
  bookId,
  importId: K1,
  dataBase64: b64("EPUB-BYTES-V1"),
});
{
  const row = await bookRow(bookId);
  check(
    "PM: upload stages the file under the generation key; the LIVE file pointer is untouched",
    up1.ok === true &&
      row?.importBlobKey === skey(bookId, K1, "EPUB-BYTES-V1") &&
      row?.blobKey === null &&
      blobStore.get(skey(bookId, K1, "EPUB-BYTES-V1")) === "EPUB-BYTES-V1",
  );
}

const save1 = await call("saveImportChapters", owner, {
  bookId,
  importId: K1,
  chapters: [{ idx: 0, title: "第一章", html: "<p>第一版正文</p>" }],
});
{
  const live = await liveChapters(bookId);
  const staged = await stagedChapters(bookId, K1);
  const view = await call("getChapter", owner, { bookId, idx: 0 });
  check(
    "PM: chapters stage in isolation — the reader still sees NO live chapter mid-import",
    save1.ok === true && staged.length === 1 && live.length === 0 && view.found === false,
  );
}

const fin1 = await call("finishImport", owner, {
  bookId,
  importId: K1,
  ok: true,
  chapterCount: 1,
});
{
  const row = await bookRow(bookId);
  const live = await liveChapters(bookId);
  check(
    "PM: finish promotes the generation (ready, 1 live chapter, file pointer flipped, staging drained)",
    fin1.ok === true &&
      row?.importStatus === "ready" &&
      live.length === 1 &&
      live[0]?.html === "<p>第一版正文</p>" &&
      row?.blobKey === skey(bookId, K1, "EPUB-BYTES-V1") &&
      row?.importBlobKey === null &&
      (await stagedChapters(bookId)).length === 0,
  );
  check(
    "PM (schedule 6): promotion moves the staged label into the LIVE versionLabel and clears the staging slot, atomically with body/file",
    row?.versionLabel === "v1.epub" && row?.importVersionLabel === null,
  );
}

await call("savePosition", owner, { bookId, chapterIdx: 0, charOffset: 42, liveVersion: await liveVersionOf(bookId) });
const liveBeforeReplay = contentOf(await liveChapters(bookId));

// THE PM REPRO: replay the original beginImport key + payload.
const replay = await call("beginImport", owner, {
  requestId: K1,
  title: "既有之书",
  author: "合成作者",
  source: "owner",
  versionLabel: "v1.epub",
  existingBookId: bookId,
});
{
  const row = await bookRow(bookId);
  const live = await liveChapters(bookId);
  check(
    "PM repro fixed: replayed beginImport returns the original result as 'replayed'",
    replay.ok === true && replay.status === "replayed" && replay.id === bookId && replay.gen === K1,
  );
  check(
    "PM repro fixed: chapters, content, status and reading position are ALL unchanged",
    live.length === 1 &&
      contentOf(live) === liveBeforeReplay &&
      row?.importStatus === "ready" &&
      row?.curChapter === 0 &&
      row?.curOffset === 42 &&
      row?.blobKey === skey(bookId, K1, "EPUB-BYTES-V1"),
  );
  check(
    "PM repro fixed: exactly one ledger row for the import key, consistent with the result",
    (await ledgerCount(K1)) === 1 && (await ledgerRow(K1))?.resultId === bookId,
  );
}

{
  const conflict = await call("beginImport", owner, {
    requestId: K1,
    title: "既有之书",
    source: "owner",
    versionLabel: "another-file.epub",
    existingBookId: bookId,
  });
  const row = await bookRow(bookId);
  check(
    "PM: same key + different payload (another file) is a typed conflict and changes nothing",
    conflict.ok === false && conflict.status === "conflict" &&
      row?.importStatus === "ready" && (await liveChapters(bookId)).length === 1,
  );
  const finReplay = await call("finishImport", owner, { bookId, importId: K1, ok: true });
  const finLateFail = await call("finishImport", owner, {
    bookId,
    importId: K1,
    ok: false,
    error: "迟到的失败",
  });
  const row2 = await bookRow(bookId);
  check(
    "PM: duplicate success finish replays harmlessly; a late failure finish is refused and the good copy stands",
    finReplay.ok === true && finLateFail.ok === false && finLateFail.status === "conflict" &&
      row2?.importStatus === "ready" && (await liveChapters(bookId)).length === 1 && row2?.curOffset === 42,
  );
}

/* ----- new-book path: triad + generation staging ----- */
{
  const N1 = "imp-new-1";
  const args = { requestId: N1, title: "新导入之书", source: "owner", versionLabel: "n.epub" };
  const begun = await call("beginImport", owner, args);
  check(
    "new-book: begin saves a processing book owned by the generation",
    begun.ok === true && begun.status === "saved" && begun.gen === N1 &&
      (await bookRow(begun.id))?.importGen === N1,
  );
  const again = await call("beginImport", owner, args);
  check(
    "new-book: same key + same payload replays (no duplicate book)",
    again.ok === true && again.status === "replayed" && again.id === begun.id,
  );
  const conf = await call("beginImport", owner, { ...args, title: "新导入之书·改" });
  check(
    "new-book: same key + different payload conflicts",
    conf.ok === false && conf.status === "conflict",
  );
  await call("saveImportChapters", owner, {
    bookId: begun.id,
    importId: N1,
    chapters: [
      { idx: 0, title: null, html: "<p>N1</p>" },
      { idx: 1, title: null, html: "<p>N2</p>" },
    ],
  });
  const fin = await call("finishImport", owner, {
    bookId: begun.id,
    importId: N1,
    ok: true,
    chapterCount: 2,
  });
  const live = await liveChapters(begun.id);
  check(
    "new-book: full flow promotes both chapters and marks ready",
    fin.ok === true && live.length === 2 && (await bookRow(begun.id))?.importStatus === "ready",
  );
}

/* ----- failure + lost-response recovery at every write point ----- */
{
  // begin: ledger insert aborts → nothing changes; same key retries.
  const rowBefore = await bookRow(bookId);
  await trigger(
    "fail_keys_ins",
    "BEFORE INSERT ON request_keys BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END",
  );
  const failedBegin = await attempt("beginImport", owner, {
    requestId: "imp-gen-fail",
    title: "既有之书",
    source: "owner",
    versionLabel: "v2.epub",
    existingBookId: bookId,
  });
  await dropTrigger("fail_keys_ins");
  const rowMid = await bookRow(bookId);
  check(
    "write-point begin: injected ledger failure throws and leaves gen/status/staging untouched",
    failedBegin.threw === true &&
      rowMid?.importGen === rowBefore?.importGen &&
      rowMid?.importStatus === "ready" &&
      (await ledgerRow("imp-gen-fail")) === null,
  );
  const retryBegin = await call("beginImport", owner, {
    requestId: "imp-gen-fail",
    title: "既有之书",
    source: "owner",
    versionLabel: "v2.epub",
    existingBookId: bookId,
  });
  check(
    "write-point begin: the same key retries into the generation claim",
    retryBegin.ok === true && retryBegin.status === "saved" &&
      (await bookRow(bookId))?.importGen === "imp-gen-fail",
  );
  // Close this generation as failed to restore a known state.
  await call("finishImport", owner, {
    bookId,
    importId: "imp-gen-fail",
    ok: false,
    error: "验证用收尾",
  });
  const rowAfter = await bookRow(bookId);
  check(
    "write-point begin: failure finish keeps the live v1 chapters + position (status only)",
    rowAfter?.importStatus === "failed" &&
      contentOf(await liveChapters(bookId)) === liveBeforeReplay &&
      rowAfter?.curOffset === 42 && rowAfter?.blobKey === skey(bookId, K1, "EPUB-BYTES-V1"),
  );
}
{
  // upload: blob put throws → no pointer moves; same key retries.
  const G = "imp-up-1";
  await call("beginImport", owner, {
    requestId: G,
    title: "既有之书",
    source: "owner",
    versionLabel: "v3.epub",
    existingBookId: bookId,
  });
  failNextPut = true;
  const failedUp = await attempt("uploadImportFile", owner, {
    bookId,
    importId: G,
    dataBase64: b64("EPUB-BYTES-V3"),
  });
  const rowMid = await bookRow(bookId);
  check(
    "write-point upload: blob failure throws; no staged pointer, live pointer intact",
    failedUp.threw === true && rowMid?.importBlobKey === null &&
      rowMid?.blobKey === skey(bookId, K1, "EPUB-BYTES-V1"),
  );
  const retryUp = await call("uploadImportFile", owner, {
    bookId,
    importId: G,
    dataBase64: b64("EPUB-BYTES-V3"),
  });
  check(
    "write-point upload: same-key retry stages the file",
    retryUp.ok === true &&
      (await bookRow(bookId))?.importBlobKey === skey(bookId, G, "EPUB-BYTES-V3"),
  );
  // chunk: staged insert aborts → whole chunk rolls back; retry whole.
  await trigger(
    "fail_staged_ins",
    "BEFORE INSERT ON import_staged_chapters BEGIN SELECT RAISE(ABORT, 'injected staged failure'); END",
  );
  const failedChunk = await attempt("saveImportChapters", owner, {
    bookId,
    importId: G,
    chapters: [{ idx: 0, title: "一", html: "<p>三版一</p>" }],
  });
  await dropTrigger("fail_staged_ins");
  check(
    "write-point chunk: injected staged-insert failure rolls the chunk back whole",
    failedChunk.threw === true && (await stagedChapters(bookId, G)).length === 0,
  );
  const retryChunk = await call("saveImportChapters", owner, {
    bookId,
    importId: G,
    chapters: [
      { idx: 0, title: "一", html: "<p>三版一</p>" },
      { idx: 1, title: "二", html: "<p>三版二</p>" },
    ],
  });
  check(
    "write-point chunk: same-key retry stages the whole chunk; live copy still v1",
    retryChunk.ok === true &&
      (await stagedChapters(bookId, G)).length === 2 &&
      contentOf(await liveChapters(bookId)) === liveBeforeReplay,
  );
  // finish: promotion aborts at the book update → live old copy and
  // staging both survive; same-key retry promotes.
  await trigger(
    "fail_promote",
    "BEFORE UPDATE ON books WHEN NEW.import_status = 'ready' BEGIN SELECT RAISE(ABORT, 'injected promotion failure'); END",
  );
  const failedFin = await attempt("finishImport", owner, {
    bookId,
    importId: G,
    ok: true,
    chapterCount: 2,
  });
  await dropTrigger("fail_promote");
  const rowMid2 = await bookRow(bookId);
  check(
    "write-point finish: promotion failure leaves the complete OLD version live and staging intact",
    failedFin.threw === true &&
      rowMid2?.importStatus === "processing" &&
      contentOf(await liveChapters(bookId)) === liveBeforeReplay &&
      (await stagedChapters(bookId, G)).length === 2,
  );
  const retryFin = await call("finishImport", owner, {
    bookId,
    importId: G,
    ok: true,
    chapterCount: 2,
  });
  const liveNow = await liveChapters(bookId);
  const rowNow = await bookRow(bookId);
  check(
    "write-point finish: same-key retry promotes atomically (new content, pointer flipped, position reset by the NEW import)",
    retryFin.ok === true && rowNow?.importStatus === "ready" &&
      contentOf(liveNow) === "0:<p>三版一</p>|1:<p>三版二</p>" &&
      rowNow?.blobKey === skey(bookId, G, "EPUB-BYTES-V3") &&
      rowNow?.curChapter === 0 && rowNow?.curOffset === 0,
  );
  check(
    "write-point finish: the superseded generation's staged file blob is cleaned up after promotion",
    !blobStore.has(skey(bookId, K1, "EPUB-BYTES-V1")) && blobStore.get(skey(bookId, G, "EPUB-BYTES-V3")) === "EPUB-BYTES-V3",
  );
  // Lost response on finish: retrying the same finish replays.
  const finAgain = await call("finishImport", owner, {
    bookId,
    importId: G,
    ok: true,
    chapterCount: 2,
  });
  check(
    "write-point finish: a lost-response retry of the same finish answers ok and changes nothing",
    finAgain.ok === true && (await liveChapters(bookId)).length === 2,
  );
}

/* ----- concurrency: same key, same / different payload ----- */
{
  const raceArgs = {
    requestId: "imp-race-1",
    title: "既有之书",
    source: "owner",
    versionLabel: "race.epub",
    existingBookId: bookId,
  };
  const [r1, r2] = await Promise.all([
    call("beginImport", owner, raceArgs),
    call("beginImport", owner, raceArgs),
  ]);
  const statuses = [r1.status, r2.status].sort().join("+");
  check(
    "concurrency (existing book): same key + same payload → one saved, one replayed, one ledger row",
    r1.ok === true && r2.ok === true && statuses === "replayed+saved" &&
      (await ledgerCount("imp-race-1")) === 1,
    statuses,
  );
  const [c1, c2] = await Promise.all([
    call("beginImport", owner, { ...raceArgs, requestId: "imp-race-2", versionLabel: "a.epub" }),
    call("beginImport", owner, { ...raceArgs, requestId: "imp-race-2", versionLabel: "b.epub" }),
  ]);
  const oks = [c1, c2].filter((r) => r.ok);
  const confs = [c1, c2].filter((r) => !r.ok && r.status === "conflict");
  check(
    "concurrency (existing book): same key + different payload → one saved, one typed conflict",
    oks.length === 1 && confs.length === 1 && (await ledgerCount("imp-race-2")) === 1,
    `${c1.status}/${c2.status}`,
  );
  const [n1, n2] = await Promise.all([
    call("beginImport", owner, { requestId: "imp-race-3", title: "并发新书", source: "owner" }),
    call("beginImport", owner, { requestId: "imp-race-3", title: "并发新书", source: "owner" }),
  ]);
  check(
    "concurrency (new book): same key race yields one book, one replay",
    n1.id === n2.id && [n1.status, n2.status].sort().join("+") === "replayed+saved",
  );
  // The winning race generation currently owns the book; close it as
  // failed so later sections start from the stable v3 copy.
  const ownerGen = (await bookRow(bookId))?.importGen;
  await call("finishImport", owner, {
    bookId,
    importId: ownerGen ?? undefined,
    ok: false,
    error: "验证用收尾",
  });
}

/* ----- stale generation: late writes never touch the new generation ----- */
{
  const v3 = contentOf(await liveChapters(bookId));
  await call("savePosition", owner, { bookId, chapterIdx: 1, charOffset: 7, liveVersion: await liveVersionOf(bookId) });
  const OLD = "imp-stale-old";
  const NEW = "imp-stale-new";
  await call("beginImport", owner, {
    requestId: OLD,
    title: "既有之书",
    source: "owner",
    versionLabel: "old.epub",
    existingBookId: bookId,
  });
  await call("saveImportChapters", owner, {
    bookId,
    importId: OLD,
    chapters: [{ idx: 0, title: null, html: "<p>旧代内容</p>" }],
  });
  await call("beginImport", owner, {
    requestId: NEW,
    title: "既有之书",
    source: "owner",
    versionLabel: "new.epub",
    existingBookId: bookId,
  });
  check(
    "stale gen: a newer begin supersedes — the old generation's staged chapters are cleared, live copy untouched",
    (await stagedChapters(bookId, OLD)).length === 0 &&
      contentOf(await liveChapters(bookId)) === v3 &&
      (await bookRow(bookId))?.importGen === NEW,
  );
  const putsBefore = blobCalls.put;
  const lateSave = await call("saveImportChapters", owner, {
    bookId,
    importId: OLD,
    chapters: [{ idx: 0, title: null, html: "<p>旧代迟到章</p>" }],
  });
  const lateUp = await call("uploadImportFile", owner, {
    bookId,
    importId: OLD,
    dataBase64: b64("OLD-FILE"),
  });
  const lateFinOk = await call("finishImport", owner, { bookId, importId: OLD, ok: true });
  const lateFinFail = await call("finishImport", owner, {
    bookId,
    importId: OLD,
    ok: false,
    error: "旧代迟到失败",
  });
  const rowMid = await bookRow(bookId);
  check(
    "stale gen: late chapter/upload/finish (ok AND fail) from the old generation are all typed conflicts",
    lateSave.status === "conflict" && lateUp.status === "conflict" &&
      lateFinOk.status === "conflict" && lateFinFail.status === "conflict",
  );
  check(
    "stale gen: the refusals wrote nothing — no blob call, live content/position/status/generation intact",
    blobCalls.put === putsBefore &&
      contentOf(await liveChapters(bookId)) === v3 &&
      rowMid?.importStatus === "processing" && rowMid?.importGen === NEW &&
      rowMid?.curChapter === 1 && rowMid?.curOffset === 7,
  );
  // The new generation completes; reads switch to it whole.
  await call("uploadImportFile", owner, { bookId, importId: NEW, dataBase64: b64("NEW-FILE") });
  await call("saveImportChapters", owner, {
    bookId,
    importId: NEW,
    chapters: [{ idx: 0, title: null, html: "<p>新代正文</p>" }],
  });
  const viewMid = await call("getChapter", owner, { bookId, idx: 0 });
  check(
    "stale gen: mid-import reads still serve the complete OLD version",
    viewMid.found === true && viewMid.html === "<p>三版一</p>",
  );
  const finNew = await call("finishImport", owner, {
    bookId,
    importId: NEW,
    ok: true,
    chapterCount: 1,
  });
  const viewAfter = await call("getChapter", owner, { bookId, idx: 0 });
  check(
    "stale gen: after promotion reads serve the complete NEW version (content + file pointer)",
    finNew.ok === true && viewAfter.html === "<p>新代正文</p>" &&
      (await bookRow(bookId))?.blobKey === skey(bookId, NEW, "NEW-FILE"),
  );
  // And the old generation stays refused even after the new one closed.
  const lateAfter = await call("finishImport", owner, { bookId, importId: OLD, ok: true });
  check(
    "stale gen: old generation remains refused after the new generation finished",
    lateAfter.ok === false && lateAfter.status === "conflict" &&
      contentOf(await liveChapters(bookId)) === "0:<p>新代正文</p>",
  );
}

/* ----- validation: gaps / count mismatch fail the generation, not the book ----- */
{
  const GAP = "imp-gap-1";
  await call("beginImport", owner, {
    requestId: GAP,
    title: "既有之书",
    source: "owner",
    versionLabel: "gap.epub",
    existingBookId: bookId,
  });
  await call("saveImportChapters", owner, {
    bookId,
    importId: GAP,
    chapters: [
      { idx: 0, title: null, html: "<p>缺口零</p>" },
      { idx: 2, title: null, html: "<p>缺口二</p>" },
    ],
  });
  const finGap = await call("finishImport", owner, {
    bookId,
    importId: GAP,
    ok: true,
    chapterCount: 2,
  });
  const rowGap = await bookRow(bookId);
  check(
    "validation: a chapter gap (idx 1 missing) refuses promotion — generation failed, live copy intact",
    finGap.ok === false && finGap.status === "conflict" &&
      rowGap?.importStatus === "failed" &&
      contentOf(await liveChapters(bookId)) === "0:<p>新代正文</p>",
  );
  const CNT = "imp-gap-2";
  await call("beginImport", owner, {
    requestId: CNT,
    title: "既有之书",
    source: "owner",
    versionLabel: "cnt.epub",
    existingBookId: bookId,
  });
  await call("saveImportChapters", owner, {
    bookId,
    importId: CNT,
    chapters: [{ idx: 0, title: null, html: "<p>计数章</p>" }],
  });
  const finCnt = await call("finishImport", owner, {
    bookId,
    importId: CNT,
    ok: true,
    chapterCount: 5,
  });
  check(
    "validation: staged count != reported chapterCount refuses promotion, live copy intact",
    finCnt.ok === false && finCnt.status === "conflict" &&
      contentOf(await liveChapters(bookId)) === "0:<p>新代正文</p>",
  );
  const finCntRetry = await call("finishImport", owner, {
    bookId,
    importId: CNT,
    ok: true,
    chapterCount: 1,
  });
  check(
    "validation: a closed (failed) generation cannot be re-finished into success — a fresh begin is required",
    finCntRetry.ok === false && finCntRetry.status === "conflict",
  );
}

/* ----- duplicate idx arbitration ----- */
{
  const DUP = "imp-dup-1";
  await call("beginImport", owner, {
    requestId: DUP,
    title: "既有之书",
    source: "owner",
    versionLabel: "dup.epub",
    existingBookId: bookId,
  });
  await call("saveImportChapters", owner, {
    bookId,
    importId: DUP,
    chapters: [
      { idx: 0, title: null, html: "<p>先到版本</p>" },
      { idx: 0, title: null, html: "<p>后到版本胜出</p>" },
    ],
  });
  const stagedDup = await stagedChapters(bookId, DUP);
  check(
    "dup idx: duplicate idx within one chunk arbitrates to ONE staged row (last wins)",
    stagedDup.length === 1 && stagedDup[0]?.html === "<p>后到版本胜出</p>",
  );
  await call("saveImportChapters", owner, {
    bookId,
    importId: DUP,
    chapters: [{ idx: 0, title: null, html: "<p>重发覆盖</p>" }],
  });
  const stagedDup2 = await stagedChapters(bookId, DUP);
  check(
    "dup idx: re-sending an idx in a later chunk upserts the same staged row (no rival rows)",
    stagedDup2.length === 1 && stagedDup2[0]?.html === "<p>重发覆盖</p>",
  );
  const finDup = await call("finishImport", owner, {
    bookId,
    importId: DUP,
    ok: true,
    chapterCount: 1,
  });
  check(
    "dup idx: promotion yields exactly one live chapter with the arbitrated content",
    finDup.ok === true && contentOf(await liveChapters(bookId)) === "0:<p>重发覆盖</p>",
  );
}

/* ----- failure preserves excerpts / provenance ----- */
{
  const snip = await call("createSnippet", owner, {
    requestId: "imp-snip-1",
    bookId,
    text: "重发覆盖",
    chapterLabel: "第 1 章",
    liveVersion: await liveVersionOf(bookId),
  });
  check("provenance setup: snippet saved against the imported book", snip.ok === true);
  const FAILG = "imp-fail-keep";
  await call("beginImport", owner, {
    requestId: FAILG,
    title: "既有之书",
    source: "owner",
    versionLabel: "willfail.epub",
    existingBookId: bookId,
  });
  await call("saveImportChapters", owner, {
    bookId,
    importId: FAILG,
    chapters: [{ idx: 0, title: null, html: "<p>不会上线的内容</p>" }],
  });
  await call("finishImport", owner, {
    bookId,
    importId: FAILG,
    ok: false,
    error: "解析中断",
  });
  const lib = await call("getLibrary", owner, {});
  const kept = lib.snippets.find((s) => s.id === snip.id);
  const bookView = lib.books.find((b) => b.id === bookId);
  check(
    "failure preservation: a failed import keeps live chapters, the excerpt and its provenance untouched",
    kept?.text === "重发覆盖" && kept?.chapterLabel === "第 1 章" &&
      contentOf(await liveChapters(bookId)) === "0:<p>重发覆盖</p>" &&
      bookView?.importStatus === "failed" && bookView?.chapterCount === 1,
  );
}

/* ----- schedule (1): a closed generation's file is immutable ----- */
{
  const addedS1 = await call("addBook", owner, {
    requestId: "s1-add",
    title: "封闭代之书",
    source: "owner",
    status: "want",
    importStatus: "pending",
  });
  const b = addedS1.id;
  const G = "s1-gen";
  await call("beginImport", owner, {
    requestId: G,
    title: "封闭代之书",
    source: "owner",
    versionLabel: "ORIGINAL.epub",
    existingBookId: b,
  });
  await call("uploadImportFile", owner, {
    bookId: b,
    importId: G,
    dataBase64: b64("ORIGINAL FILE"),
  });
  const putsAfterFirst = blobCalls.put;
  const sameMid = await call("uploadImportFile", owner, {
    bookId: b,
    importId: G,
    dataBase64: b64("ORIGINAL FILE"),
  });
  const diffMid = await call("uploadImportFile", owner, {
    bookId: b,
    importId: G,
    dataBase64: b64("DIFFERENT FILE"),
  });
  check(
    "schedule 1 (open gen): a same-bytes re-upload is idempotent (zero blob writes); a different-bytes upload conflicts and the staged bytes stand",
    sameMid.ok === true && sameMid.status === "saved" &&
      diffMid.ok === false && diffMid.status === "conflict" &&
      blobCalls.put === putsAfterFirst &&
      blobStore.get(skey(b, G, "ORIGINAL FILE")) === "ORIGINAL FILE",
  );
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: G,
    chapters: [{ idx: 0, title: "一", html: "<p>GOOD</p>" }],
  });
  const finS1 = await call("finishImport", owner, {
    bookId: b,
    importId: G,
    ok: true,
    chapterCount: 1,
  });
  const rowReady = await bookRow(b);
  check(
    "schedule 1 setup: generation completes — the live pointer IS the generation key, the label is promoted, the file fingerprint is recorded",
    finS1.ok === true && rowReady?.importStatus === "ready" &&
      rowReady?.blobKey === skey(b, G, "ORIGINAL FILE") &&
      rowReady?.versionLabel === "ORIGINAL.epub" &&
      rowReady?.importVersionLabel === null &&
      rowReady?.importFileHash != null,
  );
  const putsClosed = blobCalls.put;
  const diffClosed = await call("uploadImportFile", owner, {
    bookId: b,
    importId: G,
    dataBase64: b64("REPLACEMENT FILE"),
  });
  const rowAfterDiff = await bookRow(b);
  check(
    "schedule 1: uploading a DIFFERENT file under the CLOSED generation's key is a typed conflict — live blob bytes, pointers, fingerprint and status all untouched, zero blob writes",
    diffClosed.ok === false && diffClosed.status === "conflict" &&
      blobCalls.put === putsClosed &&
      blobStore.get(skey(b, G, "ORIGINAL FILE")) === "ORIGINAL FILE" &&
      rowAfterDiff?.blobKey === skey(b, G, "ORIGINAL FILE") &&
      rowAfterDiff?.importBlobKey === null &&
      rowAfterDiff?.importStatus === "ready" &&
      rowAfterDiff?.importFileHash === rowReady?.importFileHash,
  );
  const sameClosed = await call("uploadImportFile", owner, {
    bookId: b,
    importId: G,
    dataBase64: b64("ORIGINAL FILE"),
  });
  check(
    "schedule 1: re-uploading the SAME bytes under the closed generation's key is an idempotent no-op (saved, zero blob writes)",
    sameClosed.ok === true && sameClosed.status === "saved" &&
      blobCalls.put === putsClosed &&
      blobStore.get(skey(b, G, "ORIGINAL FILE")) === "ORIGINAL FILE",
  );
}

/* ----- schedule (2): unbound writes never complete a bound generation ----- */
{
  const addedS2 = await call("addBook", owner, {
    requestId: "s2-add",
    title: "无绑定之书",
    source: "owner",
    status: "reading",
    importStatus: "pending",
  });
  const b = addedS2.id;
  const G = "s2-gen-g";
  await call("beginImport", owner, {
    requestId: G,
    title: "无绑定之书",
    source: "owner",
    versionLabel: "old.epub",
    existingBookId: b,
  });
  await call("uploadImportFile", owner, {
    bookId: b,
    importId: G,
    dataBase64: b64("OLD-FILE"),
  });
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: G,
    chapters: [{ idx: 0, title: null, html: "<p>OLD</p>" }],
  });
  await call("finishImport", owner, {
    bookId: b,
    importId: G,
    ok: true,
    chapterCount: 1,
  });
  await call("savePosition", owner, { bookId: b, chapterIdx: 0, charOffset: 11, liveVersion: await liveVersionOf(b) });
  const H = "s2-gen-h";
  await call("beginImport", owner, {
    requestId: H,
    title: "无绑定之书",
    source: "owner",
    versionLabel: "new.epub",
    existingBookId: b,
  });
  await call("uploadImportFile", owner, {
    bookId: b,
    importId: H,
    dataBase64: b64("NEW-FILE"),
  });
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: H,
    chapters: [{ idx: 0, title: null, html: "<p>NEW</p>" }],
  });
  const putsBeforeS2 = blobCalls.put;
  const unboundSave = await call("saveImportChapters", owner, {
    bookId: b,
    chapters: [{ idx: 0, title: null, html: "<p>OLD</p>" }],
  });
  const unboundFin = await call("finishImport", owner, { bookId: b, ok: true });
  const unboundUp = await call("uploadImportFile", owner, {
    bookId: b,
    dataBase64: b64("OLD-FILE"),
  });
  const rowMidS2 = await bookRow(b);
  const viewMidS2 = await call("getChapter", owner, { bookId: b, idx: 0 });
  check(
    "schedule 2: unbound save/finish/upload against a book with a bound generation are ALL typed conflicts",
    unboundSave.ok === false && unboundSave.status === "conflict" &&
      unboundFin.ok === false && unboundFin.status === "conflict" &&
      unboundUp.ok === false && unboundUp.status === "conflict",
  );
  check(
    "schedule 2: the unbound writes caused ZERO current-generation writes — H still owns the book in processing, its staging holds only NEW, the reader still serves OLD, position kept, zero blob writes",
    rowMidS2?.importGen === H && rowMidS2?.importStatus === "processing" &&
      contentOf(await stagedChapters(b, H)) === "0:<p>NEW</p>" &&
      (await stagedChapters(b)).length === 1 &&
      viewMidS2.found === true && viewMidS2.html === "<p>OLD</p>" &&
      rowMidS2?.curOffset === 11 && blobCalls.put === putsBeforeS2,
  );
  const finH = await call("finishImport", owner, {
    bookId: b,
    importId: H,
    ok: true,
    chapterCount: 1,
  });
  const viewAfterS2 = await call("getChapter", owner, { bookId: b, idx: 0 });
  check(
    "schedule 2: the bound generation H still completes normally afterwards (content + file pointer switch together)",
    finH.ok === true && viewAfterS2.html === "<p>NEW</p>" &&
      (await bookRow(b))?.blobKey === skey(b, H, "NEW-FILE") &&
      blobStore.get(skey(b, H, "NEW-FILE")) === "NEW-FILE",
  );
}

/* ----- schedule (3): commit-point re-verification under interleaving ----- */
{
  // A ctx whose db() hands the handler a Proxy that runs
  // `interleave` exactly once, just before the handler's first
  // db.batch executes — i.e. after every pre-check has passed, at
  // the commit point itself. This is the PM's schedule: the bound
  // call passes its binding check, THEN a newer begin commits,
  // THEN the bound call's batch runs.
  function raceCtx(interleave) {
    const { ctx } = makeCtx(OWNER);
    let fired = false;
    const proxied = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (items) => {
            if (!fired) {
              fired = true;
              await interleave();
            }
            return target.batch(items);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    return { ...ctx, db: () => proxied };
  }

  const addedS3 = await call("addBook", owner, {
    requestId: "s3-add",
    title: "竞态之书",
    source: "owner",
    status: "want",
    importStatus: "pending",
  });
  const b = addedS3.id;
  const G = "s3-gen-g";
  await call("beginImport", owner, {
    requestId: G,
    title: "竞态之书",
    source: "owner",
    versionLabel: "g.epub",
    existingBookId: b,
  });
  const H = "s3-gen-h";
  const raceSave = raceCtx(async () => {
    await call("beginImport", owner, {
      requestId: H,
      title: "竞态之书",
      source: "owner",
      versionLabel: "h.epub",
      existingBookId: b,
    });
  });
  const racedSave = await call("saveImportChapters", raceSave, {
    bookId: b,
    importId: G,
    chapters: [{ idx: 0, title: null, html: "<p>竞态旧代章</p>" }],
  });
  const rowRaceSave = await bookRow(b);
  check(
    "schedule 3 (chapters): a G-bound save whose batch commits AFTER begin H answers conflict and leaves ZERO staged rows anywhere — the guard was re-verified inside the atomic unit",
    racedSave.ok === false && racedSave.status === "conflict" &&
      rowRaceSave?.importGen === H &&
      (await stagedChapters(b)).length === 0 &&
      (await liveChapters(b)).length === 0,
  );

  await call("saveImportChapters", owner, {
    bookId: b,
    importId: H,
    chapters: [{ idx: 0, title: null, html: "<p>H代正文</p>" }],
  });
  const I = "s3-gen-i";
  const raceFin = raceCtx(async () => {
    await call("beginImport", owner, {
      requestId: I,
      title: "竞态之书",
      source: "owner",
      versionLabel: "i.epub",
      existingBookId: b,
    });
  });
  const racedFin = await call("finishImport", raceFin, {
    bookId: b,
    importId: H,
    ok: true,
    chapterCount: 1,
  });
  const rowRaceFin = await bookRow(b);
  check(
    "schedule 3 (promotion): a finish whose promotion batch commits AFTER begin I answers conflict — nothing promoted, nothing live, I owns the book",
    racedFin.ok === false && racedFin.status === "conflict" &&
      rowRaceFin?.importGen === I && rowRaceFin?.importStatus === "processing" &&
      (await liveChapters(b)).length === 0,
  );

  // Upload interleave: the blob store's put runs begin J first, so
  // the upload's guarded pointer update commits after J owns the
  // book. The update must match zero rows and answer conflict.
  const J = "s3-gen-j";
  const { ctx: upBase } = makeCtx(OWNER);
  let putFired = false;
  const upCtx = {
    ...upBase,
    blobs: {
      ...upBase.blobs,
      put: async (key, data, opts) => {
        if (!putFired) {
          putFired = true;
          await call("beginImport", owner, {
            requestId: J,
            title: "竞态之书",
            source: "owner",
            versionLabel: "j.epub",
            existingBookId: b,
          });
        }
        return upBase.blobs.put(key, data, opts);
      },
    },
  };
  const racedUp = await call("uploadImportFile", upCtx, {
    bookId: b,
    importId: I,
    dataBase64: b64("I-FILE"),
  });
  const rowRaceUp = await bookRow(b);
  check(
    "schedule 3 (upload): an upload whose pointer update commits AFTER begin J answers conflict — J owns the book, no staged/live pointer or fingerprint moved",
    racedUp.ok === false && racedUp.status === "conflict" &&
      rowRaceUp?.importGen === J &&
      rowRaceUp?.importBlobKey === null && rowRaceUp?.importFileHash === null &&
      rowRaceUp?.blobKey === null,
  );
}

/* ----- schedule (6) + live-copy matrix data: labels, provenance, position ----- */
{
  const addedS4 = await call("addBook", owner, {
    requestId: "s4-add",
    title: "版本之书",
    source: "owner",
    status: "reading",
    importStatus: "pending",
  });
  const b = addedS4.id;
  const G1 = "s4-gen-1";
  await call("beginImport", owner, {
    requestId: G1,
    title: "版本之书",
    source: "owner",
    versionLabel: "OLD EDITION",
    existingBookId: b,
  });
  await call("uploadImportFile", owner, {
    bookId: b,
    importId: G1,
    dataBase64: b64("OLD-FILE"),
  });
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: G1,
    chapters: [{ idx: 0, title: "旧章", html: "<p>旧版正文一句话</p>" }],
  });
  await call("finishImport", owner, {
    bookId: b,
    importId: G1,
    ok: true,
    chapterCount: 1,
  });
  await call("savePosition", owner, { bookId: b, chapterIdx: 0, charOffset: 5, liveVersion: await liveVersionOf(b) });
  const snipOld = await call("createSnippet", owner, {
    requestId: "s4-snip-1",
    bookId: b,
    text: "旧版正文一句话",
    chapterLabel: "旧章",
    liveVersion: await liveVersionOf(b),
  });
  const libAfterG1 = await call("getLibrary", owner, {});
  const snipOldRow = libAfterG1.snippets.find((s) => s.id === snipOld.id);
  check(
    "provenance setup: a snippet saved from the live copy snapshots the LIVE edition label",
    snipOld.ok === true && snipOldRow?.versionLabel === "OLD EDITION",
  );
  const G2 = "s4-gen-2";
  await call("beginImport", owner, {
    requestId: G2,
    title: "版本之书",
    source: "owner",
    versionLabel: "NEW EDITION",
    existingBookId: b,
  });
  const rowMidS4 = await bookRow(b);
  check(
    "schedule 6: beginImport stages NEW EDITION with the generation — the live label, body, file pointer and reading position are all untouched",
    rowMidS4?.versionLabel === "OLD EDITION" &&
      rowMidS4?.importVersionLabel === "NEW EDITION" &&
      rowMidS4?.blobKey === skey(b, G1, "OLD-FILE") &&
      rowMidS4?.curOffset === 5 &&
      contentOf(await liveChapters(b)) === "0:<p>旧版正文一句话</p>",
  );
  const libMidS4 = await call("getLibrary", owner, {});
  const bookMidS4 = libMidS4.books.find((x) => x.id === b);
  check(
    "live-copy matrix (processing): the library keeps the live copy countable/readable with live and pending labels SEPARATE",
    bookMidS4?.importStatus === "processing" && bookMidS4?.chapterCount === 1 &&
      bookMidS4?.versionLabel === "OLD EDITION" &&
      bookMidS4?.pendingVersionLabel === "NEW EDITION",
  );
  const snipMid = await call("createSnippet", owner, {
    requestId: "s4-snip-2",
    bookId: b,
    text: "旧版正文一句话",
    chapterLabel: "旧章",
    liveVersion: await liveVersionOf(b),
  });
  const libMid2S4 = await call("getLibrary", owner, {});
  const snipMidRow = libMid2S4.snippets.find((s) => s.id === snipMid.id);
  check(
    "schedule 6: a snippet created from the still-live OLD body during the new import is stamped OLD EDITION — never the pending label",
    snipMid.ok === true && snipMidRow?.versionLabel === "OLD EDITION",
  );
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: G2,
    chapters: [{ idx: 0, title: "新章", html: "<p>新版正文</p>" }],
  });
  await call("finishImport", owner, {
    bookId: b,
    importId: G2,
    ok: false,
    error: "新版解析失败",
  });
  const rowFailedS4 = await bookRow(b);
  const libFailedS4 = await call("getLibrary", owner, {});
  const bookFailedS4 = libFailedS4.books.find((x) => x.id === b);
  const viewFailedS4 = await call("getChapter", owner, { bookId: b, idx: 0 });
  check(
    "live-copy matrix (failed): the failed new import leaves the old copy fully readable — live label, body, position, and the pending label recorded apart",
    rowFailedS4?.importStatus === "failed" &&
      rowFailedS4?.versionLabel === "OLD EDITION" &&
      rowFailedS4?.importVersionLabel === "NEW EDITION" &&
      rowFailedS4?.curOffset === 5 &&
      viewFailedS4.found === true && viewFailedS4.html === "<p>旧版正文一句话</p>" &&
      bookFailedS4?.chapterCount === 1 &&
      bookFailedS4?.pendingVersionLabel === "NEW EDITION",
  );
  const G3 = "s4-gen-3";
  await call("beginImport", owner, {
    requestId: G3,
    title: "版本之书",
    source: "owner",
    versionLabel: "NEW EDITION",
    existingBookId: b,
  });
  await call("uploadImportFile", owner, {
    bookId: b,
    importId: G3,
    dataBase64: b64("NEW-FILE"),
  });
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: G3,
    chapters: [{ idx: 0, title: "新章", html: "<p>新版正文</p>" }],
  });
  const finG3 = await call("finishImport", owner, {
    bookId: b,
    importId: G3,
    ok: true,
    chapterCount: 1,
  });
  const rowPromoted = await bookRow(b);
  const libPromoted = await call("getLibrary", owner, {});
  const snipOldAfter = libPromoted.snippets.find((s) => s.id === snipOld.id);
  check(
    "promotion: body, file and live label switch together exactly once; the position restarts at the beginning (never carried over); old snippets keep their OLD EDITION provenance",
    finG3.ok === true && rowPromoted?.importStatus === "ready" &&
      rowPromoted?.versionLabel === "NEW EDITION" &&
      rowPromoted?.importVersionLabel === null &&
      rowPromoted?.blobKey === skey(b, G3, "NEW-FILE") &&
      blobStore.get(skey(b, G3, "NEW-FILE")) === "NEW-FILE" &&
      contentOf(await liveChapters(b)) === "0:<p>新版正文</p>" &&
      rowPromoted?.curChapter === 0 && rowPromoted?.curOffset === 0 &&
      snipOldAfter?.versionLabel === "OLD EDITION",
  );
  check(
    "ledger: every generation key of this book is recorded exactly once, pointing at the book",
    (await ledgerCount(G1)) === 1 && (await ledgerCount(G2)) === 1 &&
      (await ledgerCount(G3)) === 1 && (await ledgerRow(G3))?.resultId === b,
  );
}

/* ----- unbound writes vs a pre-generation book WITH a live copy ----- */
{
  const legacyReady = await db
    .insert(schema.books)
    .values({
      title: "老成品之书",
      source: "owner",
      status: "reading",
      importStatus: "ready",
      requestId: null,
    })
    .returning({ id: schema.books.id });
  const lb = legacyReady[0]?.id ?? -1;
  await db.insert(schema.bookChapters).values({
    bookId: lb,
    idx: 0,
    title: null,
    html: "<p>老成品正文</p>",
    charCount: 12,
  });
  const putsBeforeLegacy = blobCalls.put;
  const uSave = await call("saveImportChapters", owner, {
    bookId: lb,
    chapters: [{ idx: 0, title: null, html: "<p>覆盖尝试</p>" }],
  });
  const uUp = await call("uploadImportFile", owner, {
    bookId: lb,
    dataBase64: b64("X"),
  });
  const uFin = await call("finishImport", owner, {
    bookId: lb,
    ok: false,
    error: "无绑定收尾",
  });
  check(
    "unbound vs live copy: a pre-generation book WITH a complete live copy refuses unbound save/upload/finish — the copy stands, status stays ready, zero blob writes",
    uSave.ok === false && uSave.status === "conflict" &&
      uUp.ok === false && uUp.status === "conflict" &&
      uFin.ok === false && uFin.status === "conflict" &&
      contentOf(await liveChapters(lb)) === "0:<p>老成品正文</p>" &&
      (await bookRow(lb))?.importStatus === "ready" &&
      blobCalls.put === putsBeforeLegacy,
  );
}

/* ----- deleted book: imports never resurrect ----- */
{
  const del = await call("deleteBook", owner, { id: bookId });
  check("deleted setup: deleteBook ok", del.ok === true);
  const replayDeleted = await call("beginImport", owner, {
    requestId: "imp-dup-1",
    title: "既有之书",
    source: "owner",
    versionLabel: "dup.epub",
    existingBookId: bookId,
  });
  check(
    "deleted: replaying the import key of a deleted book answers 'deleted'",
    replayDeleted.ok === false && replayDeleted.status === "deleted",
  );
  const freshDeleted = await call("beginImport", owner, {
    requestId: "imp-after-delete",
    title: "既有之书",
    source: "owner",
    versionLabel: "x.epub",
    existingBookId: bookId,
  });
  const lateWrite = await call("saveImportChapters", owner, {
    bookId,
    importId: "imp-dup-1",
    chapters: [{ idx: 0, title: null, html: "<p>复活尝试</p>" }],
  });
  const lib = await call("getLibrary", owner, {});
  const view = await call("getChapter", owner, { bookId, idx: 0 });
  check(
    "deleted: a fresh import key gets notFound, late writes are refused, and the book stays deleted",
    freshDeleted.status === "notFound" && lateWrite.ok === false &&
      !lib.books.some((b) => b.id === bookId) && view.found === false,
  );
}

/* ----- legacy books + old-client (unbound) writes ----- */
{
  // A book imported BEFORE generations existed: live chapters written
  // directly, import_gen NULL, no import ledger rows.
  const legacy = await db
    .insert(schema.books)
    .values({
      title: "老导入之书",
      source: "owner",
      status: "reading",
      importStatus: "processing",
      requestId: null,
    })
    .returning({ id: schema.books.id });
  const legacyId = legacy[0]?.id ?? -1;
  const upLegacy = await call("uploadImportFile", owner, {
    bookId: legacyId,
    dataBase64: b64("LEGACY-FILE"),
  });
  const saveLegacy = await call("saveImportChapters", owner, {
    bookId: legacyId,
    chapters: [{ idx: 0, title: null, html: "<p>老路径正文</p>" }],
  });
  const finLegacy = await call("finishImport", owner, { bookId: legacyId, ok: true });
  const liveLegacy = await liveChapters(legacyId);
  check(
    "legacy: unbound writes on a pre-generation book follow the direct path and complete",
    upLegacy.ok === true && saveLegacy.ok === true && finLegacy.ok === true &&
      liveLegacy.length === 1 && liveLegacy[0]?.html === "<p>老路径正文</p>" &&
      (await bookRow(legacyId))?.blobKey === `epub/${legacyId}.epub` &&
      (await bookRow(legacyId))?.importStatus === "ready",
  );

  // Old client against a generation-owned book: unbound writes are
  // NOT presumed to belong to the current generation (the previous
  // suite treated this as success — that expectation was WRONG and
  // is corrected here, per PM schedule 2). They are typed conflicts
  // with zero writes, and the bound generation completes normally
  // afterwards.
  const addedOld = await call("addBook", owner, {
    requestId: "imp-old-add",
    title: "老客户端之书",
    source: "owner",
    status: "want",
    importStatus: "pending",
  });
  const oldId = addedOld.id;
  const begunKeyed = await call("beginImport", owner, {
    requestId: "imp-old-gen",
    title: "老客户端之书",
    source: "owner",
    versionLabel: "old-client.epub",
    existingBookId: oldId,
  });
  check("legacy: keyed begin on the old-client book", begunKeyed.ok === true);
  const putsBeforeUnbound = blobCalls.put;
  const saveUnbound = await call("saveImportChapters", owner, {
    bookId: oldId,
    chapters: [{ idx: 0, title: null, html: "<p>老客户端章节</p>" }],
  });
  const upUnbound = await call("uploadImportFile", owner, {
    bookId: oldId,
    dataBase64: b64("UNBOUND-FILE"),
  });
  const finUnbound = await call("finishImport", owner, { bookId: oldId, ok: true });
  const rowUnbound = await bookRow(oldId);
  check(
    "legacy (corrected): unbound save/upload/finish against a generation-owned book are typed conflicts with ZERO writes — the generation still owns the book in processing",
    saveUnbound.ok === false && saveUnbound.status === "conflict" &&
      upUnbound.ok === false && upUnbound.status === "conflict" &&
      finUnbound.ok === false && finUnbound.status === "conflict" &&
      blobCalls.put === putsBeforeUnbound &&
      (await stagedChapters(oldId)).length === 0 &&
      (await liveChapters(oldId)).length === 0 &&
      rowUnbound?.importGen === "imp-old-gen" && rowUnbound?.importStatus === "processing",
  );
  await call("saveImportChapters", owner, {
    bookId: oldId,
    importId: "imp-old-gen",
    chapters: [{ idx: 0, title: null, html: "<p>老客户端章节</p>" }],
  });
  const finBound = await call("finishImport", owner, {
    bookId: oldId,
    importId: "imp-old-gen",
    ok: true,
  });
  check(
    "legacy (corrected): the bound generation completes normally after the unbound refusals",
    finBound.ok === true && contentOf(await liveChapters(oldId)) === "0:<p>老客户端章节</p>",
  );

  // The old client's stable per-book key pattern: first use works;
  // after that import finished, replaying the same key + payload is
  // answered from the ledger (zero writes), and proceeding to write
  // chapters against the closed generation is REFUSED explicitly —
  // the good copy is never silently wiped or half-replaced.
  const stableKey = `retry-${oldId}`;
  const firstUse = await call("beginImport", owner, {
    requestId: stableKey,
    title: "老客户端之书",
    source: "owner",
    versionLabel: "stable.epub",
    existingBookId: oldId,
  });
  await call("saveImportChapters", owner, {
    bookId: oldId,
    importId: stableKey,
    chapters: [{ idx: 0, title: null, html: "<p>稳定键第二版</p>" }],
  });
  await call("finishImport", owner, { bookId: oldId, importId: stableKey, ok: true });
  check(
    "legacy: the old stable-key pattern completes its first import",
    firstUse.ok === true && contentOf(await liveChapters(oldId)) === "0:<p>稳定键第二版</p>",
  );
  const secondUse = await call("beginImport", owner, {
    requestId: stableKey,
    title: "老客户端之书",
    source: "owner",
    versionLabel: "stable.epub",
    existingBookId: oldId,
  });
  const writeAfterReplay = await call("saveImportChapters", owner, {
    bookId: oldId,
    chapters: [{ idx: 0, title: null, html: "<p>不该写入</p>" }],
  });
  check(
    "legacy: replaying the finished stable key is a zero-write replay; an unbound write against the closed generation is explicitly refused, good copy intact",
    secondUse.ok === true && secondUse.status === "replayed" &&
      writeAfterReplay.ok === false && writeAfterReplay.status === "conflict" &&
      contentOf(await liveChapters(oldId)) === "0:<p>稳定键第二版</p>" &&
      (await stagedChapters(oldId)).length === 0 &&
      (await bookRow(oldId))?.importStatus === "ready",
  );
}

/* ----- guest / anonymous: typed forbidden, zero db + blob access ----- */
for (const [label, viewer] of [["non-owner", { id: "someone-else", isOwner: false }], ["anonymous", undefined]]) {
  const { ctx, state } = makeCtx(viewer);
  const putsBefore = blobCalls.put;
  const stagedBefore = (await stagedChapters(bookId)).length;
  const attempts = [
    ["beginImport", { requestId: `imp-x-${label}`, title: "越权导入", source: "owner" }],
    ["beginImport", { requestId: `imp-x-${label}`, title: "越权导入", source: "owner", existingBookId: bookId }],
    ["uploadImportFile", { bookId, importId: "imp-dup-1", dataBase64: b64("X") }],
    ["saveImportChapters", { bookId, importId: "imp-dup-1", chapters: [{ idx: 0, title: null, html: "<p>x</p>" }] }],
    ["finishImport", { bookId, importId: "imp-dup-1", ok: true }],
  ];
  let allForbidden = true;
  for (const [name, args] of attempts) {
    const res = await call(name, ctx, args);
    if (!(res.ok === false && res.forbidden === true)) allForbidden = false;
  }
  check(
    `${label}: every import write point is typed forbidden`,
    allForbidden,
  );
  check(
    `${label}: zero database access and zero blob calls across the import surface`,
    state.dbCalls === 0 && blobCalls.put === putsBefore,
    `dbCalls=${state.dbCalls} blobPuts=${blobCalls.put - putsBefore}`,
  );
  check(
    `${label}: staging untouched by the refused calls`,
    (await stagedChapters(bookId)).length === stagedBefore,
  );
}

/* ----- second-round schedule 1: same-gen first-upload contention + pointer recovery ----- */
{
  const nb = await call("addBook", owner, {
    requestId: "s5-add-1",
    title: "争用之书",
    source: "owner",
    status: "reading",
    importStatus: "pending",
  });
  const b = nb.id;
  const G = "s5-gen-1";
  await call("beginImport", owner, {
    requestId: G,
    title: "争用之书",
    source: "owner",
    versionLabel: "race.epub",
    existingBookId: b,
  });
  // A passes its head check and pauses inside put; B (different
  // bytes, same generation) runs to completion first.
  let releaseA;
  putGate = {
    match: (key) => key === skey(b, G, "FILE-A"),
    promise: new Promise((res) => {
      releaseA = res;
    }),
  };
  const pA = call("uploadImportFile", owner, {
    bookId: b,
    importId: G,
    dataBase64: b64("FILE-A"),
  });
  const resB = await call("uploadImportFile", owner, {
    bookId: b,
    importId: G,
    dataBase64: b64("FILE-B"),
  });
  releaseA();
  const resA = await pA;
  const rowRace = await bookRow(b);
  check(
    "schedule 1R: rival first uploads under one generation — the pointer winner's bytes stand, the loser conflicts and overwrites NOTHING",
    resB.ok === true &&
      resA.ok === false &&
      resA.status === "conflict" &&
      rowRace?.importBlobKey === skey(b, G, "FILE-B") &&
      blobStore.get(skey(b, G, "FILE-B")) === "FILE-B" &&
      blobStore.get(rowRace?.importBlobKey) === "FILE-B",
  );
  // Pointer-commit failure recovery: a trigger aborts the pointer
  // update after the put landed; the same-bytes retry must adopt
  // its own content-addressed orphan and commit the pointer.
  const G2 = "s5-gen-2";
  await call("beginImport", owner, {
    requestId: G2,
    title: "争用之书",
    source: "owner",
    versionLabel: "recover.epub",
    existingBookId: b,
  });
  await trigger(
    "fail_ptr_upd",
    "BEFORE UPDATE OF import_blob_key ON books BEGIN SELECT RAISE(ABORT, 'injected pointer failure'); END",
  );
  const failedPtr = await attempt("uploadImportFile", owner, {
    bookId: b,
    importId: G2,
    dataBase64: b64("RECOVER-FILE"),
  });
  await dropTrigger("fail_ptr_upd");
  const rowOrphan = await bookRow(b);
  check(
    "schedule 1R: pointer commit failure leaves the put as an unpointed orphan (no pointer, no fingerprint)",
    failedPtr.threw === true &&
      rowOrphan?.importBlobKey === null &&
      rowOrphan?.importFileHash === null &&
      blobStore.get(skey(b, G2, "RECOVER-FILE")) === "RECOVER-FILE",
  );
  const retryPtr = await call("uploadImportFile", owner, {
    bookId: b,
    importId: G2,
    dataBase64: b64("RECOVER-FILE"),
  });
  const rowRecovered = await bookRow(b);
  check(
    "schedule 1R: same-bytes retry after pointer failure ADOPTS the orphan and commits (no head-refusal deadlock)",
    retryPtr.ok === true &&
      rowRecovered?.importBlobKey === skey(b, G2, "RECOVER-FILE") &&
      blobStore.get(rowRecovered?.importBlobKey) === "RECOVER-FILE",
  );
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: G2,
    chapters: [{ idx: 0, title: null, html: "<p>恢复正文</p>" }],
  });
  const finRec = await call("finishImport", owner, {
    bookId: b,
    importId: G2,
    ok: true,
    chapterCount: 1,
  });
  check(
    "schedule 1R: the recovered generation finishes with body+file consistent",
    finRec.ok === true &&
      (await bookRow(b))?.blobKey === skey(b, G2, "RECOVER-FILE") &&
      contentOf(await liveChapters(b)) === "0:<p>恢复正文</p>",
  );
}

/* ----- second-round schedule 2: finish freeze — staged change / delete / upload in the window ----- */
{
  const nb = await call("addBook", owner, {
    requestId: "s6-add-1",
    title: "冻结之书",
    source: "owner",
    status: "reading",
    importStatus: "pending",
  });
  const b = nb.id;
  const G1 = "s6-gen-1";
  await call("beginImport", owner, {
    requestId: G1,
    title: "冻结之书",
    source: "owner",
    versionLabel: "old.epub",
    existingBookId: b,
  });
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: G1,
    chapters: [{ idx: 0, title: null, html: "<p>冻结旧正文</p>" }],
  });
  await call("finishImport", owner, { bookId: b, importId: G1, ok: true, chapterCount: 1 });
  const liveV1 = contentOf(await liveChapters(b));

  // (a) A staged chapter INSERT lands at the freeze moment (trigger
  // on the freeze update): finish must refuse, live untouched,
  // freeze released so the generation can be completed honestly.
  const G2 = "s6-gen-2";
  await call("beginImport", owner, {
    requestId: G2,
    title: "冻结之书",
    source: "owner",
    versionLabel: "new.epub",
    existingBookId: b,
  });
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: G2,
    chapters: [{ idx: 0, title: null, html: "<p>冻结新正文</p>" }],
  });
  await trigger(
    "freeze_inject_ch",
    `AFTER UPDATE OF import_frozen_manifest ON books WHEN NEW.import_frozen_manifest IS NOT NULL BEGIN INSERT INTO import_staged_chapters (book_id, gen, idx, title, html, char_count) VALUES (NEW.id, NEW.import_gen, 2, NULL, '<p>窗口注入</p>', 9); END`,
  );
  const finFrozen = await call("finishImport", owner, {
    bookId: b,
    importId: G2,
    ok: true,
    chapterCount: 1,
  });
  await dropTrigger("freeze_inject_ch");
  const rowFrozen = await bookRow(b);
  check(
    "schedule 2R: a staged chapter landing AT the freeze point makes finish conflict — live copy untouched, freeze released, status still processing",
    finFrozen.ok === false &&
      finFrozen.status === "conflict" &&
      contentOf(await liveChapters(b)) === liveV1 &&
      rowFrozen?.importFrozenManifest === null &&
      rowFrozen?.importStatus === "processing",
  );
  // The injected row is real staged data now: completing the set
  // honestly (add idx 1, report 3) promotes one consistent whole.
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: G2,
    chapters: [{ idx: 1, title: null, html: "<p>补齐一</p>" }],
  });
  const finWhole = await call("finishImport", owner, {
    bookId: b,
    importId: G2,
    ok: true,
    chapterCount: 3,
  });
  check(
    "schedule 2R: after the freeze conflict the completed set promotes as ONE consistent whole (no silent widening earlier)",
    finWhole.ok === true &&
      contentOf(await liveChapters(b)) ===
        "0:<p>冻结新正文</p>|1:<p>补齐一</p>|2:<p>窗口注入</p>",
  );

  // (b) A delete lands at the freeze moment: finish must conflict
  // and must NOT promote over (or resurrect) the deleted book.
  const G3 = "s6-gen-3";
  await call("beginImport", owner, {
    requestId: G3,
    title: "冻结之书",
    source: "owner",
    versionLabel: "third.epub",
    existingBookId: b,
  });
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: G3,
    chapters: [{ idx: 0, title: null, html: "<p>三版正文</p>" }],
  });
  const liveBeforeDelete = contentOf(await liveChapters(b));
  await trigger(
    "freeze_inject_del",
    `AFTER UPDATE OF import_frozen_manifest ON books WHEN NEW.import_frozen_manifest IS NOT NULL BEGIN UPDATE books SET deleted_at = 1700000000000 WHERE id = NEW.id; END`,
  );
  const finDeleted = await call("finishImport", owner, {
    bookId: b,
    importId: G3,
    ok: true,
    chapterCount: 1,
  });
  await dropTrigger("freeze_inject_del");
  const rawDeleted = await db
    .select()
    .from(schema.books)
    .where(eq(schema.books.id, b));
  check(
    "schedule 2R: a delete landing AT the freeze point makes finish conflict — book stays deleted, live chapters NOT promoted over",
    finDeleted.ok === false &&
      finDeleted.status === "conflict" &&
      rawDeleted[0]?.deletedAt != null &&
      rawDeleted[0]?.importStatus === "processing" &&
      contentOf(await liveChapters(b)) === liveBeforeDelete,
  );
  // Restore for later blocks: undelete directly in the fixture DB.
  await client.execute({
    sql: "UPDATE books SET deleted_at = NULL WHERE id = ?",
    args: [b],
  });

  // (c) An upload pointer swap lands at the freeze moment naming
  // bytes that do not exist: finish must conflict, live untouched.
  const G4 = "s6-gen-4";
  await call("beginImport", owner, {
    requestId: G4,
    title: "冻结之书",
    source: "owner",
    versionLabel: "fourth.epub",
    existingBookId: b,
  });
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: G4,
    chapters: [{ idx: 0, title: null, html: "<p>四版正文</p>" }],
  });
  const liveBeforeSwap = contentOf(await liveChapters(b));
  await trigger(
    "freeze_inject_ptr",
    `AFTER UPDATE OF import_frozen_manifest ON books WHEN NEW.import_frozen_manifest IS NOT NULL BEGIN UPDATE books SET import_blob_key = 'epub-stage/ghost', import_file_hash = 'ghost' WHERE id = NEW.id; END`,
  );
  const finSwap = await call("finishImport", owner, {
    bookId: b,
    importId: G4,
    ok: true,
    chapterCount: 1,
  });
  await dropTrigger("freeze_inject_ptr");
  check(
    "schedule 2R: a file-pointer swap landing AT the freeze point (bytes missing) makes finish conflict — live copy untouched",
    finSwap.ok === false &&
      finSwap.status === "conflict" &&
      contentOf(await liveChapters(b)) === liveBeforeSwap &&
      (await bookRow(b))?.importStatus === "processing",
  );
  await call("finishImport", owner, { bookId: b, importId: G4, ok: false, error: "验证收尾" });
}

/* ----- second-round schedule 3: cross-version reader writes + snippet provenance tokens ----- */
{
  const nb = await call("addBook", owner, {
    requestId: "s7-add-1",
    title: "跨版之书",
    source: "owner",
    status: "reading",
    importStatus: "pending",
  });
  const b = nb.id;
  const G1 = "s7-gen-1";
  await call("beginImport", owner, {
    requestId: G1,
    title: "跨版之书",
    source: "owner",
    versionLabel: "V1 EDITION",
    existingBookId: b,
  });
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: G1,
    chapters: [
      { idx: 0, title: "旧章", html: "<p>跨版旧正文</p>" },
      { idx: 1, title: "旧章二", html: "<p>跨版旧二</p>" },
    ],
  });
  await call("finishImport", owner, { bookId: b, importId: G1, ok: true, chapterCount: 2 });
  const viewV1 = await call("getChapter", owner, { bookId: b, idx: 0 });
  check(
    "schedule 3R: getChapter returns the live-version token + label of the body actually served",
    viewV1.liveVersion === G1 && viewV1.versionLabel === "V1 EDITION",
  );
  const posV1 = await call("savePosition", owner, {
    bookId: b,
    chapterIdx: 1,
    charOffset: 33,
    liveVersion: viewV1.liveVersion,
  });
  const snipV1 = await call("createSnippet", owner, {
    requestId: "s7-snip-1",
    bookId: b,
    text: "跨版旧正文",
    chapterIdx: 0,
    chapterLabel: "旧章",
    liveVersion: viewV1.liveVersion,
  });
  const libV1 = await call("getLibrary", owner, {});
  const snipV1Row = libV1.snippets.find((s) => s.id === snipV1.id);
  const bookV1Row = libV1.books.find((x) => x.id === b);
  check(
    "schedule 3R: same-version reader writes save; the snippet records the live token it was read from",
    posV1.ok === true &&
      snipV1.ok === true &&
      snipV1Row?.liveGen === G1 &&
      snipV1Row?.versionLabel === "V1 EDITION" &&
      bookV1Row?.liveGen === G1,
  );
  // Promote a new edition while the old reader is still open.
  const G2 = "s7-gen-2";
  await call("beginImport", owner, {
    requestId: G2,
    title: "跨版之书",
    source: "owner",
    versionLabel: "V2 EDITION",
    existingBookId: b,
  });
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: G2,
    chapters: [{ idx: 0, title: "新章", html: "<p>跨版新正文</p>" }],
  });
  await call("finishImport", owner, { bookId: b, importId: G2, ok: true, chapterCount: 1 });
  const rowV2 = await bookRow(b);
  check(
    "schedule 3R: promotion resets the position and moves the live token with the body",
    rowV2?.liveGen === G2 && rowV2?.curChapter === 0 && rowV2?.curOffset === 0,
  );
  const staleSnip = await call("createSnippet", owner, {
    requestId: "s7-snip-stale",
    bookId: b,
    text: "跨版旧正文",
    chapterIdx: 0,
    chapterLabel: "旧章",
    liveVersion: G1,
  });
  const stalePos = await call("savePosition", owner, {
    bookId: b,
    chapterIdx: 5,
    charOffset: 777,
    liveVersion: G1,
  });
  const unboundSnip = await call("createSnippet", owner, {
    requestId: "s7-snip-unbound",
    bookId: b,
    text: "跨版旧正文",
    chapterIdx: 0,
  });
  const unboundPos = await call("savePosition", owner, {
    bookId: b,
    chapterIdx: 5,
    charOffset: 777,
  });
  const rowAfterStale = await bookRow(b);
  const libAfterStale = await call("getLibrary", owner, {});
  check(
    "schedule 3R: the OLD reader's snippet + position writes (stale token AND no token) are typed conflicts with ZERO writes — new version's reset position and provenance stand",
    staleSnip.ok === false &&
      staleSnip.status === "conflict" &&
      stalePos.ok === false &&
      stalePos.status === "conflict" &&
      unboundSnip.ok === false &&
      unboundSnip.status === "conflict" &&
      unboundPos.ok === false &&
      rowAfterStale?.curChapter === 0 &&
      rowAfterStale?.curOffset === 0 &&
      libAfterStale.snippets.filter((s) => s.bookId === b).length === 1,
  );
  const libFinal = await call("getLibrary", owner, {});
  const oldRowFinal = libFinal.snippets.find((s) => s.id === snipV1.id);
  const bookFinal = libFinal.books.find((x) => x.id === b);
  check(
    "schedule 3R: the previously saved snippet keeps its OLD token/label verbatim (provably 'replaced', never re-stamped)",
    oldRowFinal?.liveGen === G1 &&
      oldRowFinal?.versionLabel === "V1 EDITION" &&
      bookFinal?.liveGen === G2 &&
      bookFinal?.versionLabel === "V2 EDITION",
  );
  const snipV2 = await call("createSnippet", owner, {
    requestId: "s7-snip-2",
    bookId: b,
    text: "跨版新正文",
    chapterIdx: 0,
    chapterLabel: "新章",
    liveVersion: G2,
  });
  check(
    "schedule 3R: a write carrying the CURRENT token saves under the new edition",
    snipV2.ok === true,
  );
}

/* ----- third-round schedule (a): NULL-baseline CAS in savePosition ----- */
{
  // A legacy book: live copy exists, live_gen was never recorded.
  const ins = await db
    .insert(schema.books)
    .values({
      title: "旧档之书",
      source: "owner",
      status: "reading",
      importStatus: "ready",
      requestId: null,
    })
    .returning({ id: schema.books.id });
  const b = ins[0]?.id ?? -1;
  await db.insert(schema.bookChapters).values({
    bookId: b,
    idx: 0,
    title: null,
    html: "<p>旧档正文</p>",
    charCount: 9,
  });
  const viewLegacy = await call("getChapter", owner, { bookId: b, idx: 0 });
  const okSave = await call("savePosition", owner, {
    bookId: b,
    chapterIdx: 0,
    charOffset: 21,
  });
  check(
    "3R (a): a legacy (live_gen NULL) book's position saves with a null baseline against the same version",
    viewLegacy.liveVersion === null &&
      okSave.ok === true &&
      (await bookRow(b))?.curOffset === 21,
  );
  // The promotion lands BETWEEN savePosition's pre-read and its
  // UPDATE (the update call itself dispatches the promotion first):
  // the NULL-branch WHERE (live_gen IS NULL) must match zero rows.
  const { ctx: raceBase } = makeCtx(OWNER);
  let fired = false;
  const proxied = new Proxy(db, {
    get(target, prop) {
      if (prop === "update") {
        return (...a) => {
          if (!fired) {
            fired = true;
            void client.execute({
              sql: "UPDATE books SET live_gen = 'promoted-gen-x', cur_chapter = 0, cur_offset = 0 WHERE id = ?",
              args: [b],
            });
          }
          return target.update(...a);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const raceCtxPos = { ...raceBase, db: () => proxied };
  const racedSave = await call("savePosition", raceCtxPos, {
    bookId: b,
    chapterIdx: 3,
    charOffset: 99,
  });
  const rowRaced = await bookRow(b);
  check(
    "3R (a): a promotion landing before the UPDATE makes the null-baseline save a typed conflict — the new version's reset position is NOT overwritten",
    racedSave.ok === false &&
      racedSave.status === "conflict" &&
      rowRaced?.liveGen === "promoted-gen-x" &&
      rowRaced?.curChapter === 0 &&
      rowRaced?.curOffset === 0,
  );
  // Same fact from the plain path: liveGen already promoted, a
  // null-baseline save conflicts and changes nothing.
  const plainStale = await call("savePosition", owner, {
    bookId: b,
    chapterIdx: 3,
    charOffset: 99,
  });
  check(
    "3R (a): after promotion, a null-baseline savePosition is a typed conflict with zero writes",
    plainStale.ok === false &&
      plainStale.status === "conflict" &&
      (await bookRow(b))?.curOffset === 0,
  );
}

/* ----- third-round schedule (b)+(c): createSnippet provenance + getChapter consistency + getBookLiveVersion ----- */
{
  const nb = await call("addBook", owner, {
    requestId: "s8-add-1",
    title: "一致之书",
    source: "owner",
    status: "reading",
    importStatus: "pending",
  });
  const b = nb.id;
  const A = "s8-gen-a";
  await call("beginImport", owner, {
    requestId: A,
    title: "一致之书",
    source: "owner",
    versionLabel: "C-V1",
    existingBookId: b,
  });
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: A,
    chapters: [{ idx: 0, title: "甲章", html: "<p>一致一版正文</p>" }],
  });
  await call("finishImport", owner, { bookId: b, importId: A, ok: true, chapterCount: 1 });

  const viewA = await call("getChapter", owner, { bookId: b, idx: 0 });
  check(
    "3R (c): getChapter before promotion returns body + token + label of the SAME version (V1)",
    viewA.found === true &&
      viewA.html === "<p>一致一版正文</p>" &&
      viewA.liveVersion === A &&
      viewA.versionLabel === "C-V1",
  );
  const metaA = await call("getBookLiveVersion", owner, { bookId: b });
  check(
    "3R: getBookLiveVersion (owner) reports the live version metadata",
    metaA.forbidden === false &&
      metaA.found === true &&
      metaA.liveVersion === A &&
      metaA.versionLabel === "C-V1",
  );
  const snipA = await call("createSnippet", owner, {
    requestId: "s8-snip-a",
    bookId: b,
    text: "一致一版正文",
    chapterIdx: 0,
    chapterLabel: "甲章",
    liveVersion: A,
  });
  const libA = await call("getLibrary", owner, {});
  const snipARow = libA.snippets.find((s) => s.id === snipA.id);
  check(
    "3R (b): a same-version createSnippet saves, and its provenance is the book row's CURRENT title/label/token",
    snipA.ok === true &&
      snipARow?.bookTitle === "一致之书" &&
      snipARow?.versionLabel === "C-V1" &&
      snipARow?.liveGen === A,
  );

  const B = "s8-gen-b";
  await call("beginImport", owner, {
    requestId: B,
    title: "一致之书",
    source: "owner",
    versionLabel: "C-V2",
    existingBookId: b,
  });
  await call("saveImportChapters", owner, {
    bookId: b,
    importId: B,
    chapters: [{ idx: 0, title: "乙章", html: "<p>一致二版正文</p>" }],
  });
  await call("finishImport", owner, { bookId: b, importId: B, ok: true, chapterCount: 1 });

  const viewB = await call("getChapter", owner, { bookId: b, idx: 0 });
  const viewMissing = await call("getChapter", owner, { bookId: b, idx: 7 });
  check(
    "3R (c): getChapter after promotion returns body + token + label of the SAME version (V2); a missing chapter still reports V2's TOC/token/label as one snapshot",
    viewB.found === true &&
      viewB.html === "<p>一致二版正文</p>" &&
      viewB.liveVersion === B &&
      viewB.versionLabel === "C-V2" &&
      viewMissing.found === false &&
      viewMissing.toc.length === 1 &&
      viewMissing.liveVersion === B &&
      viewMissing.versionLabel === "C-V2",
  );
  const metaB = await call("getBookLiveVersion", owner, { bookId: b });
  check(
    "3R: getBookLiveVersion tracks the promotion (owner)",
    metaB.found === true && metaB.liveVersion === B && metaB.versionLabel === "C-V2",
  );

  // (b) stale token AFTER the promotion completed: typed conflict,
  // zero new snippets, zero ledger rows for the refused key.
  // (This restates the 3R-schedule coverage of §3R above at the
  // commit-point guard: the refusal now comes from the batch's
  // own insert-select guard, not a pre-check.)
  const staleSnip = await call("createSnippet", owner, {
    requestId: "s8-snip-stale",
    bookId: b,
    text: "一致一版正文",
    chapterIdx: 0,
    chapterLabel: "甲章",
    liveVersion: A,
  });
  const libAfterStale = await call("getLibrary", owner, {});
  check(
    "3R (b): createSnippet with the OLD token after promotion is a typed conflict — zero new snippets, zero ledger rows for the refused key",
    staleSnip.ok === false &&
      staleSnip.status === "conflict" &&
      libAfterStale.snippets.filter((s) => s.bookId === b).length === 1 &&
      (await ledgerRow("s8-snip-stale")) === null,
  );
  // The already-committed key replays through arbitration FIRST —
  // the new batch guard must not misjudge it even though its
  // token is now stale.
  const replaySnip = await call("createSnippet", owner, {
    requestId: "s8-snip-a",
    bookId: b,
    text: "一致一版正文",
    chapterIdx: 0,
    chapterLabel: "甲章",
    liveVersion: A,
  });
  const libAfterReplay = await call("getLibrary", owner, {});
  check(
    "3R (b): replaying the committed snippet key after promotion still returns the original row (arbitration precedes the guard), zero new rows",
    replaySnip.ok === true &&
      replaySnip.status === "replayed" &&
      replaySnip.id === snipA.id &&
      libAfterReplay.snippets.filter((s) => s.bookId === b).length === 1 &&
      (await ledgerCount("s8-snip-a")) === 1,
  );

  // getBookLiveVersion gate: guest + anonymous are forbidden and
  // receive zero content.
  for (const [label, viewer] of [
    ["guest", { id: "guest-1", isOwner: false }],
    ["anon", undefined],
  ]) {
    const { ctx } = makeCtx(viewer);
    const res = await call("getBookLiveVersion", ctx, { bookId: b });
    check(
      `3R: getBookLiveVersion is forbidden for ${label} with zero content`,
      res.forbidden === true &&
        res.found === false &&
        res.liveVersion === null &&
        res.versionLabel === null,
    );
  }

  // (c) after deletion: no content from either read.
  await call("deleteBook", owner, { id: b });
  const viewDel = await call("getChapter", owner, { bookId: b, idx: 0 });
  const metaDel = await call("getBookLiveVersion", owner, { bookId: b });
  check(
    "3R (c): a deleted book returns found=false and NO content from getChapter and getBookLiveVersion",
    viewDel.found === false &&
      viewDel.html === "" &&
      viewDel.toc.length === 0 &&
      viewDel.liveVersion === null &&
      viewDel.versionLabel === null &&
      metaDel.found === false &&
      metaDel.liveVersion === null,
  );
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
