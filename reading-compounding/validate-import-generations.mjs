// CMP-READ-IMPORT-001 validation — import original-key / generation
// protection for EXISTING books (and the new-book path).
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
      row?.importBlobKey === `epub-stage/${bookId}/${K1}` &&
      row?.blobKey === null &&
      blobStore.get(`epub-stage/${bookId}/${K1}`) === "EPUB-BYTES-V1",
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
      row?.blobKey === `epub-stage/${bookId}/${K1}` &&
      row?.importBlobKey === null &&
      (await stagedChapters(bookId)).length === 0,
  );
}

await call("savePosition", owner, { bookId, chapterIdx: 0, charOffset: 42 });
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
      row?.blobKey === `epub-stage/${bookId}/${K1}`,
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
      rowAfter?.curOffset === 42 && rowAfter?.blobKey === `epub-stage/${bookId}/${K1}`,
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
      rowMid?.blobKey === `epub-stage/${bookId}/${K1}`,
  );
  const retryUp = await call("uploadImportFile", owner, {
    bookId,
    importId: G,
    dataBase64: b64("EPUB-BYTES-V3"),
  });
  check(
    "write-point upload: same-key retry stages the file",
    retryUp.ok === true &&
      (await bookRow(bookId))?.importBlobKey === `epub-stage/${bookId}/${G}`,
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
      rowNow?.blobKey === `epub-stage/${bookId}/${G}` &&
      rowNow?.curChapter === 0 && rowNow?.curOffset === 0,
  );
  check(
    "write-point finish: the superseded generation's staged file blob is cleaned up after promotion",
    !blobStore.has(`epub-stage/${bookId}/${K1}`) && blobStore.get(`epub-stage/${bookId}/${G}`) === "EPUB-BYTES-V3",
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
  await call("savePosition", owner, { bookId, chapterIdx: 1, charOffset: 7 });
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
      (await bookRow(bookId))?.blobKey === `epub-stage/${bookId}/${NEW}`,
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

  // Old client against a generation-owned book: unbound writes bind
  // to the CURRENT generation (the only one it can mean) and stage.
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
  const saveUnbound = await call("saveImportChapters", owner, {
    bookId: oldId,
    chapters: [{ idx: 0, title: null, html: "<p>老客户端章节</p>" }],
  });
  check(
    "legacy: an unbound chapter save binds the current generation and STAGES (live untouched)",
    saveUnbound.ok === true &&
      (await stagedChapters(oldId, "imp-old-gen")).length === 1 &&
      (await liveChapters(oldId)).length === 0,
  );
  const finUnbound = await call("finishImport", owner, { bookId: oldId, ok: true });
  check(
    "legacy: an unbound finish promotes the current generation",
    finUnbound.ok === true && contentOf(await liveChapters(oldId)) === "0:<p>老客户端章节</p>",
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
    "legacy: replaying the finished stable key is a zero-write replay; writing against the closed generation is explicitly refused, good copy intact",
    secondUse.ok === true && secondUse.status === "replayed" &&
      writeAfterReplay.ok === false && writeAfterReplay.status === "conflict" &&
      contentOf(await liveChapters(oldId)) === "0:<p>稳定键第二版</p>" &&
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

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
