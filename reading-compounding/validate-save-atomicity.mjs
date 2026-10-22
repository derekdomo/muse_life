// CMP-READ-SAVE-001 validation — atomic body+ledger saves.
//
// Reproduces the PM's four failure cases against the REAL handlers
// (server/src/actions.ts) on a throwaway in-memory libsql database
// (schema applied from drizzle/*.sql), then walks the full criteria
// list: every create entrypoint (book / session / snippet / draft /
// card / chat-card / reuse) × fresh save, same-key replay, changed-
// payload conflict; same-key concurrency (same and different
// payload); failure injection at EVERY write point (body insert,
// provenance insert, tag insert, ledger insert, ledger tombstone,
// side-effect update); save/delete interleaving and late retries
// after delete; legacy rows with no ledger entry; draft / deleted /
// missing snippets never lending provenance to a card; strict owner
// gate with zero db access for non-owner / anonymous callers.
//
// Synthetic data only; the real app.db is never opened.
// Run with: bun validate-save-atomicity.mjs
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
check(
  "source: creates commit through the atomic batch helper (commitCreate)",
  (serverSrc.match(/commitCreate\(db, args\.requestId/g) ?? []).length >= 7,
  `${(serverSrc.match(/commitCreate\(db, args\.requestId/g) ?? []).length} create paths`,
);
check(
  "source: deletes commit delete+tombstone atomically (commitDelete)",
  (serverSrc.match(/commitDelete\(/g) ?? []).length >= 5,
);
check(
  "source: no select-then-insert claim remains (claimRequest/tombstoneByResult gone)",
  !serverSrc.includes("claimRequest") && !serverSrc.includes("tombstoneByResult"),
);
check(
  "source: createSnippet fingerprint includes chapterLabel (provenance in the hash)",
  /k: "snippet",\s+bookId: args\.bookId,\s+text: args\.text,\s+chapterLabel:/.test(serverSrc),
);
check(
  "source: arbitration checks the created row's own visibility (entityAlive)",
  serverSrc.includes("entityAlive(db, row.resultTable, row.resultId)"),
);

/* client receipt wiring (CMP-READ-001 continuation) */
const snippetsSrc = readFileSync(new URL("./client/src/Snippets.tsx", import.meta.url), "utf8");
const cardsSrc = readFileSync(new URL("./client/src/Cards.tsx", import.meta.url), "utf8");
const appSrc = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
{
  const pStart = snippetsSrc.indexOf("function SnippetQaPanel");
  const pEnd = snippetsSrc.indexOf("function SnippetCard", pStart);
  const panel = pStart > -1 ? snippetsSrc.slice(pStart, pEnd > -1 ? pEnd : undefined) : "";
  check("client: panel exists for receipt checks", panel.length > 0);
  check(
    "client: receipt keeps the server's actual cardId (receipt state from res.id)",
    panel.includes("setReceipt({ cardId: res.id, replayed: res.status === \"replayed\" })"),
  );
  check(
    "client: receipt distinguishes 已保存 / 原键已保存",
    panel.includes("✓ 已保存为知识卡") && panel.includes("✓ 原键已保存"),
  );
  check(
    "client: receipt shows the STORED row's core + 出处 (read back, not the model's text)",
    panel.includes("receiptCard.core") && panel.includes("receiptCard.sourceLabel"),
  );
  check(
    "client: receipt buttons jump by id — 查看这张卡 (onViewCard with the cardId) + 回到原片段",
    panel.includes("onViewCard(receipt.cardId)") && panel.includes("查看这张卡") && panel.includes("回到原片段"),
  );
  check(
    "client: failed read-back says 已保存，详情暂未读出 with a read-only retry",
    panel.includes("✓ 已保存，详情暂未读出") && panel.includes("重新读取详情"),
  );
  const rbStart = panel.indexOf("const readback = async");
  const rb = rbStart > -1 ? panel.slice(rbStart, rbStart + 600) : "";
  check(
    "client: read-back retry is read-only (refetch only — never createCard under a new key)",
    rb.includes("refetchQueries") && !rb.includes("createCard"),
  );
  check(
    "client: deleted receipt card is stated plainly and never rebuilt from the answer",
    panel.includes("这张卡已不存在（可能已被删除），不会从答复里重建它"),
  );
  check(
    "client: conflict keeps the inputs and surfaces the authoritative stored card",
    panel.includes("你的输入保留在下面，没有被覆盖") && panel.includes("已存的权威结果") && panel.includes("onViewCard(conflictCard.id)"),
  );
  check(
    "client: conflict locates the authoritative card ONLY by the ledger resultId from the response (res.resultId)",
    panel.includes("const authoritativeId = res.resultId") && panel.includes("setConflictCardId(authoritativeId)"),
  );
  check(
    "client: conflict never guesses by snippet or list position (no snippetId filter / last-card pick)",
    !panel.includes("filter((c) => c.snippetId") && !panel.includes("mine[mine.length - 1]") && !panel.includes("authoritative = mine"),
  );
  check(
    "client: missing/unreadable resultId says 已保存，但暂时无法定位这张卡 with a read-only retry (no guessing)",
    panel.includes("已保存，但暂时无法定位这张卡") && panel.includes("重新读取定位") && panel.includes("不会拿同一片段的其他卡来代替"),
  );
  const crStart = panel.indexOf("const conflictReadback = async");
  const cr = crStart > -1 ? panel.slice(crStart, crStart + 700) : "";
  check(
    "client: conflict read-back retry is read-only and looks up ONLY the exact conflictCardId",
    cr.includes("refetchQueries") && cr.includes("c.id === conflictCardId") && !cr.includes("createCard"),
  );
  check(
    "server: conflict response carries the ledger resultId (createResult.resultId + claimToResult conflict branch)",
    serverSrc.includes("resultId: z.number().nullable()") && serverSrc.includes('status: "conflict", id: null, resultId: claim.resultId'),
  );
  check(
    "client: asks carry questionRequestId + the pinned snippet version",
    panel.includes("questionRequestId: questionKeyRef.current") && panel.includes("snippetVersion: snippet.version"),
  );
  check(
    "client: App routes 查看这张卡 to the cards tab with that id focused",
    appSrc.includes("setFocusCardId(id)") && appSrc.includes('focusId={focusCardId}') && appSrc.includes("onViewCard={goCard}"),
  );
  check(
    "client: cards tab locates by id (element id + highlight) and names a deleted target",
    cardsSrc.includes("id={`card-${card.id}`}") && cardsSrc.includes("要定位的那张卡已不存在（可能已被删除）"),
  );
  check(
    "client: reuse success locates the real event by reuseId (incl. lost-response replay)",
    cardsSrc.includes("setLastReuseId(res.id)") && cardsSrc.includes("id={`reuse-${r.id}`}") && cardsSrc.includes("刚登记的这一笔"),
  );
}

/* ---------------- behavior: real handlers, in-memory db ---------------- */

const { Actions } = await import("./server/src/actions.ts");
const schema = await import("./server/src/schema.ts");
const { createClient } = await import("@libsql/client");
const { drizzle } = await import("drizzle-orm/libsql");
const { eq } = await import("drizzle-orm");

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

let inferenceCalls = 0;
function makeCtx(viewer) {
  const state = { dbCalls: 0 };
  const ctx = {
    slug: "space-15-validate-atomicity",
    invocationId: "validate-save-atomicity",
    spaceDir: "",
    viewer,
    db: () => {
      state.dbCalls += 1;
      return db;
    },
    blobs: {
      put: async () => {},
      getUrl: async () => "",
      head: async () => null,
    },
    inference: {
      complete: async () => {
        inferenceCalls += 1;
        return { answer: " stub answer ", suggestedCore: " stub core " };
      },
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

// Like call(), but for saves expected to THROW (injected write
// failures): returns { threw, res }.
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

async function counts() {
  const [books, sessions, snippets, cards, reuses, keys, cardTags] = await Promise.all([
    db.select({ id: schema.books.id }).from(schema.books),
    db.select({ id: schema.readingSessions.id }).from(schema.readingSessions),
    db.select({ id: schema.snippets.id }).from(schema.snippets),
    db.select({ id: schema.knowledgeCards.id }).from(schema.knowledgeCards),
    db.select({ id: schema.cardReuses.id }).from(schema.cardReuses),
    db.select({ requestId: schema.requestKeys.requestId }).from(schema.requestKeys),
    db.select({ cardId: schema.cardTags.cardId }).from(schema.cardTags),
  ]);
  return {
    books: books.length,
    sessions: sessions.length,
    snippets: snippets.length,
    cards: cards.length,
    reuses: reuses.length,
    keys: keys.length,
    cardTags: cardTags.length,
  };
}

async function trigger(name, sqlText) {
  await client.execute(`CREATE TRIGGER ${name} ${sqlText}`);
}
async function dropTrigger(name) {
  await client.execute(`DROP TRIGGER IF EXISTS ${name}`);
}
async function ledgerRow(requestId) {
  const rows = await db
    .select()
    .from(schema.requestKeys)
    .where(eq(schema.requestKeys.requestId, requestId));
  return rows[0] ?? null;
}

// Seed row lands via the first owner read (ensureSeeded).
await call("getLibrary", owner, {});
const base = await counts();
check("setup: seed book present, ledger empty", base.books === 1 && base.keys === 0, JSON.stringify(base));

const book = await call("addBook", owner, {
  requestId: "at-book-1",
  title: "原子之书",
  author: "合成作者",
  source: "owner",
  status: "reading",
  importStatus: "none",
});
check("setup: addBook saved", book.ok === true && book.status === "saved");

const snip = await call("createSnippet", owner, {
  requestId: "at-snip-1",
  bookId: book.id,
  text: "原子性是把一次事实存成一行。",
  chapterLabel: "第 1 章 原子",
});
check("setup: createSnippet saved", snip.ok === true && snip.status === "saved");
const snippetId = snip.id;

/* ----- PM repro ①: ledger insert aborts → NO body row; retry completes once ----- */
{
  const before = await counts();
  await trigger(
    "fail_keys_ins",
    "BEFORE INSERT ON request_keys BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END",
  );
  const failed = await attempt("createCard", owner, {
    requestId: "at-card-fail-1",
    core: "账本失败时不应落卡",
    snippetId,
  });
  await dropTrigger("fail_keys_ins");
  const mid = await counts();
  check(
    "repro ①: createCard throws when the ledger insert aborts",
    failed.threw === true,
  );
  check(
    "repro ①: failure leaves NO body row and NO ledger row (all-old state)",
    mid.cards === before.cards && mid.keys === before.keys,
    `${JSON.stringify(before)} -> ${JSON.stringify(mid)}`,
  );
  const retry = await call("createCard", owner, {
    requestId: "at-card-fail-1",
    core: "账本失败时不应落卡",
    snippetId,
  });
  const after = await counts();
  check(
    "repro ①: same key + same payload retries into exactly one complete commit",
    retry.ok === true && retry.status === "saved" && after.cards === before.cards + 1 && after.keys === before.keys + 1,
  );
  const replay = await call("createCard", owner, {
    requestId: "at-card-fail-1",
    core: "账本失败时不应落卡",
    snippetId,
  });
  const afterReplay = await counts();
  check(
    "repro ①: a further retry replays the one stored row (no duplicate card)",
    replay.ok === true && replay.status === "replayed" && replay.id === retry.id && afterReplay.cards === after.cards,
  );
  // Receipt consistency: the stored row IS what the receipt reports.
  const lib = await call("getLibrary", owner, {});
  const stored = lib.cards.find((c) => c.id === retry.id);
  check(
    "receipt: stored row matches the save (core + 出处 from the actual row)",
    stored?.core === "账本失败时不应落卡" && (stored?.sourceLabel ?? "").includes("第 1 章 原子"),
    stored?.sourceLabel ?? "missing",
  );
}

/* ----- PM repro ②: same-key concurrency — exactly one row, loser arbitrated ----- */
{
  const before = await counts();
  const args = { requestId: "at-card-race-1", core: "并发同键只落一行", snippetId };
  const [r1, r2] = await Promise.all([
    call("createCard", owner, args),
    call("createCard", owner, args),
  ]);
  const after = await counts();
  const statuses = [r1.status, r2.status].sort().join("+");
  check(
    "repro ②: concurrent same key + same payload → one saved, one replayed, same id",
    r1.ok === true && r2.ok === true && r1.id === r2.id && statuses === "replayed+saved",
    statuses,
  );
  check(
    "repro ②: exactly one card row + one ledger row after the race",
    after.cards === before.cards + 1 && after.keys === before.keys + 1,
  );

  const before2 = await counts();
  const [c1, c2] = await Promise.all([
    call("createCard", owner, { requestId: "at-card-race-2", core: "载荷甲", snippetId }),
    call("createCard", owner, { requestId: "at-card-race-2", core: "载荷乙", snippetId }),
  ]);
  const after2 = await counts();
  const oks = [c1, c2].filter((r) => r.ok);
  const conflicts = [c1, c2].filter((r) => !r.ok && r.status === "conflict");
  check(
    "repro ②: concurrent same key + different payload → one saved, one typed conflict",
    oks.length === 1 && conflicts.length === 1 && after2.cards === before2.cards + 1 && after2.keys === before2.keys + 1,
    `${c1.status}/${c2.status}`,
  );
}

/* ----- PM repro ③: delete + tombstone atomic; no false "replayed" for a deleted card ----- */
{
  const card = await call("createCard", owner, {
    requestId: "at-card-del-1",
    core: "删除必须与墓碑同生共死",
    snippetId,
  });
  await trigger(
    "fail_keys_upd",
    "BEFORE UPDATE ON request_keys BEGIN SELECT RAISE(ABORT, 'injected tombstone failure'); END",
  );
  const failedDelete = await attempt("deleteCard", owner, { id: card.id });
  await dropTrigger("fail_keys_upd");
  check("repro ③: deleteCard throws when the tombstone update aborts", failedDelete.threw === true);
  const libMid = await call("getLibrary", owner, {});
  const keyMid = await ledgerRow("at-card-del-1");
  check(
    "repro ③: failed delete rolls back BOTH the soft-delete and the tombstone",
    libMid.cards.some((c) => c.id === card.id) && keyMid?.deleted === 0,
  );
  const del = await call("deleteCard", owner, { id: card.id });
  check("repro ③: delete succeeds once the failure is gone", del.ok === true);
  const lateRetry = await call("createCard", owner, {
    requestId: "at-card-del-1",
    core: "删除必须与墓碑同生共死",
    snippetId,
  });
  check(
    "repro ③: late retry of the creation key is typed deleted, never a false replay",
    lateRetry.ok === false && lateRetry.status === "deleted" && lateRetry.id === null,
  );

  // Legacy state: a card soft-deleted BEFORE deletes were atomic —
  // deleted_at set, tombstone stamp missing. Visibility arbitration
  // must still answer "deleted" (and never resurrect).
  const legacy = await call("createCard", owner, {
    requestId: "at-card-legacy-del",
    core: "旧式半删除的卡",
    snippetId,
  });
  await db
    .update(schema.knowledgeCards)
    .set({ deletedAt: new Date() })
    .where(eq(schema.knowledgeCards.id, legacy.id));
  const legacyKey = await ledgerRow("at-card-legacy-del");
  check("legacy: tombstone stamp is indeed missing for this row", legacyKey?.deleted === 0);
  const legacyRetry = await call("createCard", owner, {
    requestId: "at-card-legacy-del",
    core: "旧式半删除的卡",
    snippetId,
  });
  check(
    "legacy: entity-visibility arbitration answers deleted despite the missing stamp",
    legacyRetry.ok === false && legacyRetry.status === "deleted",
  );
  const libLegacy = await call("getLibrary", owner, {});
  check(
    "legacy: the deleted card was not resurrected",
    !libLegacy.cards.some((c) => c.id === legacy.id),
  );
}

/* ----- PM repro ④: snippet fingerprint covers chapterLabel ----- */
{
  const first = await call("createSnippet", owner, {
    requestId: "at-snip-ch",
    bookId: book.id,
    text: "出处章节也是内容的一部分。",
    chapterLabel: "A 章",
  });
  check("repro ④: first save ok", first.ok === true && first.status === "saved");
  const before = await counts();
  const conflict = await call("createSnippet", owner, {
    requestId: "at-snip-ch",
    bookId: book.id,
    text: "出处章节也是内容的一部分。",
    chapterLabel: "B 章",
  });
  const after = await counts();
  check(
    "repro ④: same key, only chapterLabel changed (A→B) → typed conflict, nothing written",
    conflict.ok === false && conflict.status === "conflict" && after.snippets === before.snippets && after.keys === before.keys,
  );
  const lib = await call("getLibrary", owner, {});
  const row = lib.snippets.find((s) => s.id === first.id);
  check(
    "repro ④: the stored snippet keeps the original provenance (A 章）",
    row?.chapterLabel === "A 章",
    row?.chapterLabel ?? "missing",
  );
  const replay = await call("createSnippet", owner, {
    requestId: "at-snip-ch",
    bookId: book.id,
    text: "出处章节也是内容的一部分。",
    chapterLabel: "A 章",
  });
  check(
    "repro ④: same key + identical payload (incl. chapter) replays",
    replay.ok === true && replay.status === "replayed" && replay.id === first.id,
  );
}

/* ----- every entrypoint: fresh / replay / conflict + ledger consistency ----- */
async function triad(label, createName, args, conflictArgs, table, resultTable) {
  const before = await counts();
  const saved = await call(createName, owner, args);
  check(`${label}: fresh save ok`, saved.ok === true && saved.status === "saved" && typeof saved.id === "number");
  const key = await ledgerRow(args.requestId);
  check(
    `${label}: ledger row committed with the actual result id`,
    key != null && key.resultId === saved.id && key.resultTable === resultTable && key.deleted === 0,
    key ? `${key.resultTable}#${key.resultId}` : "no ledger row",
  );
  const replay = await call(createName, owner, args);
  check(
    `${label}: same key + same payload replays the original row`,
    replay.ok === true && replay.status === "replayed" && replay.id === saved.id,
  );
  const mid = await counts();
  check(
    `${label}: replay wrote nothing`,
    mid[table] === before[table] + 1 && mid.keys === before.keys + 1,
  );
  const conflict = await call(createName, owner, conflictArgs);
  const end = await counts();
  check(
    `${label}: same key + different payload is a typed conflict, nothing written`,
    conflict.ok === false && conflict.status === "conflict" && end[table] === mid[table] && end.keys === mid.keys,
  );
  return saved;
}

await triad(
  "book",
  "addBook",
  { requestId: "at-t-book", title: "三件套之书", author: "甲", source: "owner", status: "want", importStatus: "none" },
  { requestId: "at-t-book", title: "三件套之书·改", author: "甲", source: "owner", status: "want", importStatus: "none" },
  "books",
  "books",
);
await triad(
  "session",
  "logReading",
  { requestId: "at-t-reading", bookId: book.id, date: "2026-10-20", minutes: 25, note: "晨读" },
  { requestId: "at-t-reading", bookId: book.id, date: "2026-10-20", minutes: 30, note: "晨读" },
  "sessions",
  "reading_sessions",
);
await triad(
  "import-book",
  "beginImport",
  { requestId: "at-t-import", title: "待导入之书", source: "owner" },
  { requestId: "at-t-import", title: "待导入之书·改", source: "owner" },
  "books",
  "books",
);
await triad(
  "snippet",
  "createSnippet",
  { requestId: "at-t-snip", bookId: book.id, text: "三件套片段。", chapterLabel: "第 9 章" },
  { requestId: "at-t-snip", bookId: book.id, text: "三件套片段·改。", chapterLabel: "第 9 章" },
  "snippets",
  "snippets",
);
await triad(
  "draft",
  "createSnippetDraft",
  { requestId: "at-t-draft", source: "paste", text: "三件套草稿。", bookTitle: "原子之书" },
  { requestId: "at-t-draft", source: "paste", text: "三件套草稿·改。", bookTitle: "原子之书" },
  "snippets",
  "snippets",
);
await triad(
  "card",
  "createCard",
  { requestId: "at-t-card", core: "三件套卡", snippetId, annotation: "批注甲", tags: ["原子"] },
  { requestId: "at-t-card", core: "三件套卡", snippetId, annotation: "批注乙", tags: ["原子"] },
  "cards",
  "knowledge_cards",
);
const chatSaved = await triad(
  "chat-card",
  "recordKnowledgeCardFromChat",
  { requestId: "at-t-chat", core: "聊天三件套卡", snippetText: "聊天里引用的原文。", bookTitle: "原子之书", chapterLabel: "第 2 章", tags: ["聊天"] },
  { requestId: "at-t-chat", core: "聊天三件套卡·改", snippetText: "聊天里引用的原文。", bookTitle: "原子之书", chapterLabel: "第 2 章", tags: ["聊天"] },
  "cards",
  "knowledge_cards",
);
{
  const lib = await call("getLibrary", owner, {});
  const card = lib.cards.find((c) => c.id === chatSaved.id);
  const src = card?.snippetId != null ? lib.snippets.find((s) => s.id === card.snippetId) : undefined;
  check(
    "chat-card: card links the ACTUAL stored source snippet (text + chapter intact)",
    src?.text === "聊天里引用的原文。" && src?.chapterLabel === "第 2 章" && src?.source === "chat",
    src ? `${src.text}/${src.chapterLabel}` : "no source snippet",
  );
}
await triad(
  "reuse",
  "recordCardReuse",
  { requestId: "at-t-reuse", cardId: chatSaved.id, date: "2026-10-21", scene: "项目评审", outcome: "定了方案" },
  { requestId: "at-t-reuse", cardId: chatSaved.id, date: "2026-10-21", scene: "项目评审·改", outcome: "定了方案" },
  "reuses",
  "card_reuses",
);

/* ----- failure injection at every remaining write point ----- */
{
  // Tag insert aborts mid-createCard → card AND ledger roll back.
  const before = await counts();
  await trigger(
    "fail_tags_ins",
    "BEFORE INSERT ON card_tags BEGIN SELECT RAISE(ABORT, 'injected tag failure'); END",
  );
  const failed = await attempt("createCard", owner, {
    requestId: "at-card-tagfail",
    core: "标签失败不应落卡",
    snippetId,
    tags: ["会失败的标签"],
  });
  await dropTrigger("fail_tags_ins");
  const mid = await counts();
  check(
    "write-point: tag insert failure aborts the whole card save (no card, no ledger, no tags)",
    failed.threw === true && mid.cards === before.cards && mid.keys === before.keys && mid.cardTags === before.cardTags,
  );
  const retry = await call("createCard", owner, {
    requestId: "at-card-tagfail",
    core: "标签失败不应落卡",
    snippetId,
    tags: ["会失败的标签"],
  });
  const lib = await call("getLibrary", owner, {});
  const stored = lib.cards.find((c) => c.id === retry.id);
  check(
    "write-point: retry after tag failure commits card + tags together",
    retry.ok === true && retry.status === "saved" && (stored?.tags.some((t) => t.tag === "会失败的标签") ?? false),
  );
}
{
  // Card insert aborts inside a chat-card save → no orphan source snippet.
  const before = await counts();
  await trigger(
    "fail_cards_ins",
    "BEFORE INSERT ON knowledge_cards BEGIN SELECT RAISE(ABORT, 'injected card failure'); END",
  );
  const failed = await attempt("recordKnowledgeCardFromChat", owner, {
    requestId: "at-chat-orphan",
    core: "卡失败时不留孤儿片段",
    snippetText: "这段原文不该单独留下。",
    bookTitle: "原子之书",
  });
  await dropTrigger("fail_cards_ins");
  const mid = await counts();
  check(
    "write-point: chat-card body failure leaves no orphan source snippet and no ledger row",
    failed.threw === true && mid.snippets === before.snippets && mid.cards === before.cards && mid.keys === before.keys,
  );
  const retry = await call("recordKnowledgeCardFromChat", owner, {
    requestId: "at-chat-orphan",
    core: "卡失败时不留孤儿片段",
    snippetText: "这段原文不该单独留下。",
    bookTitle: "原子之书",
  });
  check("write-point: chat-card retry commits snippet + card together", retry.ok === true && retry.status === "saved");
}
{
  // Snippet body insert aborts → no ledger row; book body insert aborts → same.
  const before = await counts();
  await trigger(
    "fail_snip_ins",
    "BEFORE INSERT ON snippets BEGIN SELECT RAISE(ABORT, 'injected snippet failure'); END",
  );
  const failedSnip = await attempt("createSnippet", owner, {
    requestId: "at-snip-bodyfail",
    bookId: book.id,
    text: "主体失败的片段。",
  });
  await dropTrigger("fail_snip_ins");
  await trigger(
    "fail_book_ins",
    "BEFORE INSERT ON books BEGIN SELECT RAISE(ABORT, 'injected book failure'); END",
  );
  const failedBook = await attempt("addBook", owner, {
    requestId: "at-book-bodyfail",
    title: "主体失败的书",
    source: "owner",
    status: "want",
    importStatus: "none",
  });
  await dropTrigger("fail_book_ins");
  const mid = await counts();
  check(
    "write-point: body insert failures leave no ledger rows behind",
    failedSnip.threw === true && failedBook.threw === true && mid.keys === before.keys && mid.snippets === before.snippets && mid.books === before.books,
  );
}
{
  // logReading's book-progress side effect aborts → the session row
  // and its ledger entry roll back too; the book keeps its old marker.
  const libBefore = await call("getLibrary", owner, {});
  const bookBefore = libBefore.books.find((b) => b.id === book.id);
  const before = await counts();
  await trigger(
    "fail_book_upd",
    "BEFORE UPDATE ON books BEGIN SELECT RAISE(ABORT, 'injected progress failure'); END",
  );
  const failed = await attempt("logReading", owner, {
    requestId: "at-reading-sidefail",
    bookId: book.id,
    date: "2026-10-21",
    minutes: 10,
    progressValue: 42,
    progressUnit: "page",
  });
  await dropTrigger("fail_book_upd");
  const mid = await counts();
  check(
    "write-point: progress-update failure rolls back session + ledger atomically",
    failed.threw === true && mid.sessions === before.sessions && mid.keys === before.keys,
  );
  const retry = await call("logReading", owner, {
    requestId: "at-reading-sidefail",
    bookId: book.id,
    date: "2026-10-21",
    minutes: 10,
    progressValue: 42,
    progressUnit: "page",
  });
  const libAfter = await call("getLibrary", owner, {});
  const bookAfter = libAfter.books.find((b) => b.id === book.id);
  check(
    "write-point: retry commits session + progress marker together",
    retry.ok === true && retry.status === "saved" &&
      bookAfter?.progressValue === 42 && bookBefore?.progressValue !== 42,
    `progress=${bookAfter?.progressValue}`,
  );
}

/* ----- save/delete interleave + late retries ----- */
{
  const s = await call("createSnippet", owner, {
    requestId: "at-snip-del",
    bookId: book.id,
    text: "删后晚重试的片段。",
  });
  const del = await call("deleteSnippet", owner, { id: s.id });
  check("interleave: deleteSnippet ok", del.ok === true);
  const late = await call("createSnippet", owner, {
    requestId: "at-snip-del",
    bookId: book.id,
    text: "删后晚重试的片段。",
  });
  check(
    "interleave: late retry after snippet delete is typed deleted",
    late.ok === false && late.status === "deleted",
  );
  // A NEW key with the same content is a genuinely new save.
  const fresh = await call("createCard", owner, {
    requestId: "at-card-after-del",
    core: "删除必须与墓碑同生共死",
    snippetId,
  });
  check(
    "interleave: tombstones are per-key — a new key saves the same content as a new row",
    fresh.ok === true && fresh.status === "saved",
  );
  // Reuse registered, then its card deleted → the reuse key answers deleted.
  const reuse = await call("recordCardReuse", owner, {
    requestId: "at-reuse-del",
    cardId: fresh.id,
    date: "2026-10-21",
    scene: "讨论",
    outcome: "用上了",
  });
  check("interleave: reuse registered", reuse.ok === true && reuse.status === "saved");
  await call("deleteCard", owner, { id: fresh.id });
  const lateReuse = await call("recordCardReuse", owner, {
    requestId: "at-reuse-del",
    cardId: fresh.id,
    date: "2026-10-21",
    scene: "讨论",
    outcome: "用上了",
  });
  check(
    "interleave: reuse key whose card was deleted answers deleted (visibility arbitration)",
    lateReuse.ok === false && lateReuse.status === "deleted",
  );
  const freshReuse = await call("recordCardReuse", owner, {
    requestId: "at-reuse-on-deleted",
    cardId: fresh.id,
    date: "2026-10-21",
    scene: "讨论",
    outcome: "用上了",
  });
  check(
    "interleave: a fresh reuse on a deleted card is notFound, nothing written",
    freshReuse.ok === false && freshReuse.status === "notFound",
  );
  const bk = await call("addBook", owner, {
    requestId: "at-book-del",
    title: "将被删的书",
    source: "owner",
    status: "want",
    importStatus: "none",
  });
  await call("deleteBook", owner, { id: bk.id });
  const lateBook = await call("addBook", owner, {
    requestId: "at-book-del",
    title: "将被删的书",
    source: "owner",
    status: "want",
    importStatus: "none",
  });
  check(
    "interleave: book creation key answers deleted after deleteBook",
    lateBook.ok === false && lateBook.status === "deleted",
  );
}

/* ----- provenance guards: draft / deleted / missing snippets ----- */
{
  const draft = await call("createSnippetDraft", owner, {
    requestId: "at-prov-draft",
    source: "paste",
    text: "还没确认的草稿原文。",
    bookTitle: "原子之书",
  });
  const before = await counts();
  const fromDraft = await call("createCard", owner, {
    requestId: "at-prov-card",
    core: "不该借草稿的出处",
    snippetId: draft.id,
  });
  const mid = await counts();
  check(
    "provenance: a DRAFT snippet cannot lend provenance to a card (notFound, key not consumed)",
    fromDraft.ok === false && fromDraft.status === "notFound" && mid.cards === before.cards && mid.keys === before.keys,
  );
  const ghost = await call("createCard", owner, {
    requestId: "at-prov-ghost",
    core: "不存在的片段",
    snippetId: 999999,
  });
  check(
    "provenance: a missing snippet is notFound, no sourceless card substituted",
    ghost.ok === false && ghost.status === "notFound",
  );
  const confirm = await call("confirmSnippetDraft", owner, {
    id: draft.id,
    version: 1,
    text: "还没确认的草稿原文。",
    bookTitle: "原子之书",
    chapterLabel: "第 5 章",
  });
  check("provenance: draft confirmed by owner", confirm.ok === true);
  const afterConfirm = await call("createCard", owner, {
    requestId: "at-prov-card",
    core: "不该借草稿的出处",
    snippetId: draft.id,
  });
  const lib = await call("getLibrary", owner, {});
  const stored = lib.cards.find((c) => c.id === afterConfirm.id);
  check(
    "provenance: the same key saves once the snippet is confirmed, with its real 出处",
    afterConfirm.ok === true && afterConfirm.status === "saved" &&
      (stored?.sourceLabel ?? "").includes("第 5 章"),
    stored?.sourceLabel ?? "missing",
  );
  const noSource = await call("createCard", owner, {
    requestId: "at-prov-none",
    core: "本来就无出处的卡",
    snippetId: null,
  });
  const lib2 = await call("getLibrary", owner, {});
  const storedNone = lib2.cards.find((c) => c.id === noSource.id);
  check(
    "provenance: an explicitly source-less card stays source-less (nothing invented)",
    noSource.ok === true && storedNone?.sourceLabel === null && storedNone?.snippetId === null,
  );
  const delSnip = await call("createSnippet", owner, {
    requestId: "at-prov-delsnip",
    bookId: book.id,
    text: "将被删的出处片段。",
  });
  await call("deleteSnippet", owner, { id: delSnip.id });
  const fromDeleted = await call("createCard", owner, {
    requestId: "at-prov-delcard",
    core: "不该借已删片段的出处",
    snippetId: delSnip.id,
  });
  check(
    "provenance: a deleted snippet cannot lend provenance either",
    fromDeleted.ok === false && fromDeleted.status === "notFound",
  );
}

/* ----- legacy rows: no ledger entry, no requestId — reads + new saves still work ----- */
{
  const inserted = await db
    .insert(schema.knowledgeCards)
    .values({ core: "账本之前的老卡", snippetId: null, sourceLabel: null, origin: "ui", requestId: null })
    .returning({ id: schema.knowledgeCards.id });
  const legacyCardId = inserted[0]?.id;
  const lib = await call("getLibrary", owner, {});
  check(
    "legacy: a card with no ledger row still reads back",
    lib.cards.some((c) => c.id === legacyCardId && c.core === "账本之前的老卡"),
  );
  const reuse = await call("recordCardReuse", owner, {
    requestId: "at-legacy-reuse",
    cardId: legacyCardId,
    date: "2026-10-21",
    scene: "复盘",
    outcome: "帮了忙",
  });
  check(
    "legacy: new saves against a legacy card work through the ledger",
    reuse.ok === true && reuse.status === "saved",
  );
  const dash = await call("getDashboard", owner, {});
  const libNow = await call("getLibrary", owner, {});
  check(
    "legacy: dashboard totals and library agree (counts consistent)",
    dash.totals.cardTotal === libNow.cards.length && dash.totals.reuseTotal === libNow.reuses.length,
    `dash cards=${dash.totals.cardTotal} lib cards=${libNow.cards.length}`,
  );
}

/* ----- ask binding: questionRequestId + snippet version reference ----- */
{
  const lib = await call("getLibrary", owner, {});
  const snipRow = lib.snippets.find((s) => s.id === snippetId);
  const before = inferenceCalls;
  const okAsk = await call("askSnippetQuestion", owner, {
    snippetId,
    question: "版本对得上吗？",
    questionRequestId: "at-q-1",
    snippetVersion: snipRow?.version,
  });
  check(
    "ask binding: matching snippet version + questionRequestId answers",
    okAsk.ok === true && okAsk.status === "answered" && inferenceCalls === before + 1,
  );
  const stale = await call("askSnippetQuestion", owner, {
    snippetId,
    question: "版本过期还问吗？",
    questionRequestId: "at-q-2",
    snippetVersion: (snipRow?.version ?? 1) + 5,
  });
  check(
    "ask binding: a stale snippet version is refused (notFound) with zero inference",
    stale.ok === false && stale.status === "notFound" && inferenceCalls === before + 1,
  );
  const noVersion = await call("askSnippetQuestion", owner, {
    snippetId,
    question: "老客户端不带版本呢？",
  });
  check(
    "ask binding: omitting the version still works (old-client compatible)",
    noVersion.ok === true && noVersion.status === "answered",
  );
}

/* ----- conflict resultId: same snippet, many cards — precise location ----- */
{
  const first = await call("createCard", owner, {
    requestId: "at-conflict-first",
    core: "原键那张卡",
    snippetId,
  });
  const second = await call("createCard", owner, {
    requestId: "at-conflict-second",
    core: "同片段第二张卡",
    snippetId,
  });
  const third = await call("createCard", owner, {
    requestId: "at-conflict-third",
    core: "同片段最后一张卡",
    snippetId,
  });
  check(
    "conflict-location: setup saves three distinct cards on the SAME snippet",
    first.ok === true && second.ok === true && third.ok === true &&
      new Set([first.id, second.id, third.id]).size === 3,
    `${first.id}/${second.id}/${third.id}`,
  );
  const conflict = await call("createCard", owner, {
    requestId: "at-conflict-first",
    core: "异载荷的核心",
    snippetId,
  });
  check(
    "conflict-location: same key + different payload returns the ledger resultId of the ORIGINAL card (not the last card on the snippet)",
    conflict.ok === false && conflict.status === "conflict" &&
      conflict.resultId === first.id && conflict.resultId !== second.id && conflict.resultId !== third.id,
    `resultId=${conflict.resultId} first=${first.id} last=${third.id}`,
  );
  check(
    "conflict-location: conflict keeps id null — resultId is the separate precise locator",
    conflict.id === null,
  );
  const libConflict = await call("getLibrary", owner, {});
  const located = libConflict.cards.find((c) => c.id === conflict.resultId);
  check(
    "conflict-location: locating by resultId yields exactly the original card's stored content",
    located?.core === "原键那张卡",
    located?.core ?? "not found",
  );
  // Ledger row with no recorded result: conflict must report
  // resultId null so the client can say it cannot locate the card
  // instead of guessing one from the snippet.
  await db.insert(schema.requestKeys).values({
    requestId: "at-conflict-noresult",
    kind: "card",
    payloadHash: "deadbeef",
    resultTable: "knowledge_cards",
    resultId: null,
  });
  const noResult = await call("createCard", owner, {
    requestId: "at-conflict-noresult",
    core: "任意核心",
    snippetId,
  });
  check(
    "conflict-location: ledger row without a resultId returns conflict with resultId null (client must not guess)",
    noResult.ok === false && noResult.status === "conflict" && noResult.resultId === null,
    `resultId=${noResult.resultId}`,
  );
}

/* ----- guest / anonymous: typed forbidden, zero db access, zero writes ----- */
for (const [label, viewer] of [["non-owner", { id: "someone-else", isOwner: false }], ["anonymous", undefined]]) {
  const { ctx, state } = makeCtx(viewer);
  const before = await counts();
  const attempts = [
    ["addBook", { requestId: `at-x-${label}`, title: "越权之书", source: "owner" }],
    ["logReading", { requestId: `at-x-${label}`, minutes: 5 }],
    ["createSnippet", { requestId: `at-x-${label}`, bookId: book.id, text: "越权片段" }],
    ["createSnippetDraft", { requestId: `at-x-${label}`, source: "paste", text: "越权草稿" }],
    ["createCard", { requestId: `at-x-${label}`, core: "越权卡" }],
    ["recordKnowledgeCardFromChat", { requestId: `at-x-${label}`, core: "越权聊天卡" }],
    ["recordCardReuse", { requestId: `at-x-${label}`, cardId: 1, scene: "s", outcome: "o" }],
    ["deleteCard", { id: 1 }],
    ["deleteSnippet", { id: 1 }],
  ];
  let allForbidden = true;
  for (const [name, args] of attempts) {
    const res = await call(name, ctx, args);
    if (!(res.ok === false && res.forbidden === true)) allForbidden = false;
  }
  const after = await counts();
  check(
    `${label}: every create/delete path is typed forbidden`,
    allForbidden,
  );
  check(
    `${label}: zero database access across all paths`,
    state.dbCalls === 0,
    `dbCalls=${state.dbCalls}`,
  );
  check(
    `${label}: zero writes (all tables unchanged)`,
    JSON.stringify(after) === JSON.stringify(before),
  );
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
