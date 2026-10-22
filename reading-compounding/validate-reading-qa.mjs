// CMP-READ-001 (Q&A slice) validation — in-app questions about ONE
// snippet: pinned provenance, 原文/我的问题/Muse 的解释 kept apart,
// failure keeps the draft, card sedimentation rides the existing
// request-key ledger, strict owner gate.
//
// Two layers:
//  1. Source wiring: askSnippetQuestion's owner gate precedes any
//     ctx.db access AND any ctx.inference call; its typed forbidden
//     response is zero-content; the client panel pins the 原文 block
//     read-only, labels the three blocks separately, keeps the
//     question draft on failure with a retry entry, and saves the
//     card only through api.createCard with a requestId.
//  2. Behavior: the REAL handlers from server/src/actions.ts run
//     against a throwaway in-memory libsql database (schema applied
//     from drizzle/*.sql) behind a synthetic ctx with a stubbed
//     ctx.inference. Owner asks get an answer plus the exact stored
//     provenance snapshot; drafts / deleted / missing snippets are
//     notFound and never reach inference; a throwing inference leaves
//     zero new rows (no half card, no half exchange); non-owner and
//     anonymous callers get typed forbidden with zero db access and
//     zero inference calls. Card saves via the ledger are idempotent
//     per request key, conflict on a changed payload, and never
//     resurrect a deleted card.
//
// Synthetic data only; the real app.db is never opened.
// Run with: bun validate-reading-qa.mjs
import { readFileSync, readdirSync } from "node:fs";

let passed = 0;
let failures = 0;
function check(name, ok, note = "") {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${note ? ` (${note})` : ""}`);
}

/* ---------------- 1. source wiring ---------------- */

const serverSrc = readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8");
const clientSrc = readFileSync(new URL("./client/src/Snippets.tsx", import.meta.url), "utf8");
const themeSrc = readFileSync(new URL("./client/src/theme.css", import.meta.url), "utf8");

function actionSlice(src, name) {
  const start = src.indexOf(`  ${name}: defineAction({`);
  if (start < 0) throw new Error(`action ${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n  \w+: defineAction\(\{/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

check(
  "source: isOwner is exactly ctx.viewer?.isOwner === true",
  serverSrc.includes("return ctx.viewer?.isOwner === true;"),
);

const askSlice = actionSlice(serverSrc, "askSnippetQuestion");
{
  const gateIdx = askSlice.indexOf("if (!isOwner(ctx))");
  const dbIdx = askSlice.indexOf("ctx.db");
  const infIdx = askSlice.indexOf("ctx.inference.complete");
  check("source: askSnippetQuestion is gated", gateIdx > -1);
  check("source: askSnippetQuestion gate precedes any ctx.db access", gateIdx > -1 && gateIdx < dbIdx);
  check("source: askSnippetQuestion gate precedes any inference call", gateIdx > -1 && gateIdx < infIdx);
  check(
    "source: askSnippetQuestion forbidden response is zero-content",
    askSlice.includes('answer: ""') && askSlice.includes('sourceText: ""') && askSlice.includes('sourceLabel: ""'),
  );
  check(
    "source: askSnippetQuestion refuses non-saved (draft) snippets",
    askSlice.includes('snip.status !== "saved"'),
  );
  check(
    "source: askSnippetQuestion returns the stored provenance snapshot (sourceText/sourceLabel)",
    askSlice.includes("sourceText: snip.text") && askSlice.includes("sourceLabel,"),
  );
  check(
    "source: askSnippetQuestion prompt forbids fabricating book content",
    askSlice.includes("不要编造原文之外的书中内容"),
  );
  check(
    "source: askSnippetQuestion history is bounded (max 6 turns)",
    /\.max\(6\)/.test(askSlice),
  );
}

/* client panel wiring */
const panelStart = clientSrc.indexOf("function SnippetQaPanel");
const panelEnd = clientSrc.indexOf("function SnippetCard", panelStart);
const panel = panelStart > -1 ? clientSrc.slice(panelStart, panelEnd > -1 ? panelEnd : undefined) : "";
check("client: SnippetQaPanel exists", panel.length > 0);
check("client: snippet list has the 「对这段提问」 entry", clientSrc.includes("对这段提问"));
check(
  "client: panel pins 原文 with fixed, non-editable provenance header",
  panel.includes("原文 · 出处固定（不可编辑）") && panel.includes("sourceLabelOf(snippet)"),
);
check(
  "client: panel renders snippet text read-only (no setter rewrites 原文 in the panel)",
  panel.includes("{snippet.text}") && !panel.includes("setText"),
);
check(
  "client: three blocks labeled separately — 原文 / 我的问题 / Muse 的解释",
  panel.includes("原文 · 出处固定（不可编辑）") &&
    panel.includes("我的问题") &&
    panel.includes("Muse 的解释 · 模型生成，不是原文"),
);
check(
  "client: ask failure keeps the draft (error copy + retry entry, question cleared only on success)",
  panel.includes("问题草稿还在输入框里") &&
    panel.includes("重试提问") &&
    panel.indexOf('setQuestion("")') > panel.indexOf("onSuccess"),
);
check(
  "client: card sedimentation goes through createCard with the request-key ref",
  panel.includes("api.createCard({") && panel.includes("requestId: cardKeyRef.current"),
);
check(
  "client: suggested core is labeled a suggestion and stays editable",
  panel.includes("建议核心") && panel.includes('value={core}'),
);
check(
  "client: conflict locates the authoritative card ONLY by the ledger resultId (res.resultId), never by snippet guess",
  panel.includes("const authoritativeId = res.resultId") &&
    panel.includes("setConflictCardId(authoritativeId)") &&
    !panel.includes("filter((c) => c.snippetId") &&
    !panel.includes("mine[mine.length - 1]"),
);
check(
  "client: missing/unreadable resultId says 已保存，但暂时无法定位这张卡 with a read-only retry",
  panel.includes("已保存，但暂时无法定位这张卡") && panel.includes("重新读取定位"),
);
{
  const crStart = panel.indexOf("const conflictReadback = async");
  const cr = crStart > -1 ? panel.slice(crStart, crStart + 700) : "";
  check(
    "client: conflict read-back retry is read-only and looks up ONLY the exact conflictCardId",
    cr.includes("refetchQueries") && cr.includes("c.id === conflictCardId") && !cr.includes("createCard"),
  );
}
check(
  "client: status meaning also rides on symbols/text, Okabe-Ito tokens present",
  panel.includes("▲") && panel.includes("✓") &&
    themeSrc.includes("--accent: #0072b2") && themeSrc.includes("--accent2: #d55e00"),
);

/* ---------------- 2. behavior against real handlers ---------------- */

const { Actions } = await import("./server/src/actions.ts");
const schema = await import("./server/src/schema.ts");
const { createClient } = await import("@libsql/client");
const { drizzle } = await import("drizzle-orm/libsql");

const client = createClient({ url: ":memory:" });
const migrationDir = new URL("./drizzle/", import.meta.url);
for (const file of readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort()) {
  const sql = readFileSync(new URL(file, migrationDir), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim();
    if (trimmed) await client.execute(trimmed);
  }
}
const db = drizzle(client, { schema });

const STUB_ANSWER = "这是针对原文的解释：先扣住原文，再展开讨论。";
const STUB_CORE = "建议的一句话核心";
let inferenceImpl = async () => ({ answer: STUB_ANSWER, suggestedCore: STUB_CORE });

function makeCtx(viewer) {
  const state = { dbCalls: 0, inferenceCalls: 0, prompts: [] };
  const ctx = {
    slug: "space-15-validate",
    invocationId: "validate-reading-qa",
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
      complete: async (prompt) => {
        state.inferenceCalls += 1;
        state.prompts.push(prompt);
        return inferenceImpl(prompt);
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
const NON_OWNER = { id: "someone-else", isOwner: false };
const ANON = undefined;

async function call(name, ctx, args) {
  const action = Actions[name];
  const parsedArgs = action.request.parse(args);
  const res = await action.handler(ctx, parsedArgs);
  action.response.parse(res);
  return res;
}

async function db2InsertNoResultKey() {
  await db.insert(schema.requestKeys).values({
    requestId: "qa-conflict-noresult",
    kind: "card",
    payloadHash: "deadbeef",
    resultTable: "knowledge_cards",
    resultId: null,
  });
}

async function rowCounts() {
  const cards = await db.select({ id: schema.knowledgeCards.id }).from(schema.knowledgeCards);
  const keys = await db.select({ requestId: schema.requestKeys.requestId }).from(schema.requestKeys);
  const snips = await db.select({ id: schema.snippets.id }).from(schema.snippets);
  return { cards: cards.length, keys: keys.length, snippets: snips.length };
}

/* ----- owner setup: book + saved snippet + draft snippet ----- */

const { ctx: ownerCtx, state: ownerState } = makeCtx(OWNER);

const lib0 = await call("getLibrary", ownerCtx, {});
const seedBook = lib0.books.find((b) => b.title === "纳瓦尔宝典");
check(
  "seed: 《纳瓦尔宝典》 stays 想读/待导入 (no full text claimed)",
  seedBook?.status === "want" &&
    seedBook?.importStatus === "pending" &&
    lib0.books.every((b) => b.importStatus !== "ready"),
  seedBook ? `${seedBook.status}/${seedBook.importStatus}` : "missing",
);

const book = await call("addBook", ownerCtx, {
  requestId: "qa-book-1",
  title: "验证之书",
  author: "合成作者",
  source: "owner",
  status: "reading",
  importStatus: "none",
});
check("owner: addBook ok", book.ok === true && typeof book.id === "number");

const SNIP_TEXT = "想要是跟自己的约定，在得到它之前一直不快乐。";
const snip = await call("createSnippet", ownerCtx, {
  requestId: "qa-snip-1",
  bookId: book.id,
  text: SNIP_TEXT,
  chapterLabel: "第 3 章 幸福",
  chapterIdx: 2,
  charOffset: 128,
});
check("owner: createSnippet ok", snip.ok === true && typeof snip.id === "number");
const snippetId = snip.id;

const draft = await call("createSnippetDraft", ownerCtx, {
  requestId: "qa-draft-1",
  source: "paste",
  text: "尚未确认的草稿文字",
  bookTitle: "验证之书",
});
check("owner: createSnippetDraft ok", draft.ok === true && typeof draft.id === "number");

/* ----- owner Q&A happy path: provenance complete + separated ----- */

{
  const before = ownerState.inferenceCalls;
  const res = await call("askSnippetQuestion", ownerCtx, {
    snippetId,
    question: "这里的「想要」是什么意思？",
  });
  check("owner: ask answered", res.ok === true && res.forbidden === false && res.status === "answered");
  check("owner: answer is the model explanation", res.answer === STUB_ANSWER);
  check(
    "provenance: sourceText is the stored 原文 verbatim",
    res.sourceText === SNIP_TEXT,
  );
  check(
    "provenance: sourceLabel carries 书名 + 章节",
    res.sourceLabel.includes("《验证之书》") && res.sourceLabel.includes("第 3 章 幸福"),
    res.sourceLabel,
  );
  check(
    "provenance: suggested core returned separately (not merged into 原文/answer)",
    res.suggestedCore === STUB_CORE && !res.answer.includes(SNIP_TEXT),
  );
  check("owner: exactly one inference call per ask", ownerState.inferenceCalls === before + 1);
  const prompt = ownerState.prompts[ownerState.prompts.length - 1] ?? "";
  check(
    "provenance: inference prompt received the real 原文 + question + source label",
    prompt.includes(SNIP_TEXT) && prompt.includes("这里的「想要」是什么意思？") && prompt.includes("《验证之书》"),
  );

  const follow = await call("askSnippetQuestion", ownerCtx, {
    snippetId,
    question: "那跟工作怎么联系？",
    history: [{ question: "这里的「想要」是什么意思？", answer: STUB_ANSWER }],
  });
  check("owner: follow-up with history answered", follow.ok === true && follow.status === "answered");
  const prompt2 = ownerState.prompts[ownerState.prompts.length - 1] ?? "";
  check(
    "discussion: history turn is carried into the next prompt",
    prompt2.includes("这里的「想要」是什么意思？") && prompt2.includes("那跟工作怎么联系？"),
  );
}

/* ----- notFound cases never reach inference ----- */

{
  const before = ownerState.inferenceCalls;
  const draftAsk = await call("askSnippetQuestion", ownerCtx, { snippetId: draft.id, question: "草稿能问吗？" });
  check(
    "draft snippet: ask is typed notFound, zero inference",
    draftAsk.ok === false && draftAsk.status === "notFound" && draftAsk.answer === "" && ownerState.inferenceCalls === before,
  );
  const ghostAsk = await call("askSnippetQuestion", ownerCtx, { snippetId: 999999, question: "不存在的片段？" });
  check(
    "missing snippet: ask is typed notFound, zero inference",
    ghostAsk.ok === false && ghostAsk.status === "notFound" && ownerState.inferenceCalls === before,
  );
  const del = await call("deleteSnippet", ownerCtx, { id: snippetId });
  check("owner: deleteSnippet ok", del.ok === true);
  const tombAsk = await call("askSnippetQuestion", ownerCtx, { snippetId, question: "删了还能问吗？" });
  check(
    "tombstone: deleted snippet never resurfaces for Q&A",
    tombAsk.ok === false && tombAsk.status === "notFound" && ownerState.inferenceCalls === before,
  );
}

/* ----- inference failure: throws, zero new rows, 原文 untouched ----- */

{
  // A fresh saved snippet for the failure + sedimentation checks.
  const snip2 = await call("createSnippet", ownerCtx, {
    requestId: "qa-snip-2",
    bookId: book.id,
    text: "财富是睡觉时仍在赚钱的资产。",
    chapterLabel: "第 1 章 财富",
  });
  const snippet2Id = snip2.id;
  const before = await rowCounts();
  const callsBefore = ownerState.inferenceCalls;
  inferenceImpl = async () => {
    throw new Error("simulated inference timeout");
  };
  let threw = false;
  try {
    const action = Actions.askSnippetQuestion;
    await action.handler(
      ownerCtx,
      action.request.parse({ snippetId: snippet2Id, question: "会失败的问题" }),
    );
  } catch {
    threw = true;
  }
  inferenceImpl = async () => ({ answer: STUB_ANSWER, suggestedCore: STUB_CORE });
  check("failure: inference error propagates (client keeps draft, shows retry)", threw === true);
  check("failure: the attempt did reach inference exactly once", ownerState.inferenceCalls === callsBefore + 1);
  const after = await rowCounts();
  check(
    "failure: zero new rows — no half card, no half exchange, no ledger pollution",
    after.cards === before.cards && after.keys === before.keys && after.snippets === before.snippets,
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
  );
  const libAfterFail = await call("getLibrary", ownerCtx, {});
  const snip2Row = libAfterFail.snippets.find((s) => s.id === snippet2Id);
  check(
    "failure: 原文 untouched by the failed ask",
    snip2Row?.text === "财富是睡觉时仍在赚钱的资产。" && snip2Row?.chapterLabel === "第 1 章 财富",
  );
  const snip3 = await call("createSnippet", ownerCtx, {
    requestId: "qa-snip-3",
    bookId: book.id,
    text: "没有章节信息的片段。",
    chapterLabel: null,
  });
  check(
    "provenance: missing chapter stays 章节不详 in the ask snapshot (never invented)",
    (await call("askSnippetQuestion", ownerCtx, { snippetId: snip3.id, question: "出处呢？" })).sourceLabel.includes("章节不详"),
  );

  /* ----- sedimentation: one tap → card via the request-key ledger ----- */

  const cardArgs = {
    requestId: "qa-card-1",
    core: STUB_CORE,
    snippetId: snippet2Id,
    annotation: "所有者批注：讨论后的结论。",
  };
  const card1 = await call("createCard", ownerCtx, cardArgs);
  check("sediment: createCard from the Q&A panel saves", card1.ok === true && card1.status === "saved" && typeof card1.id === "number");

  const cardRetry = await call("createCard", ownerCtx, cardArgs);
  check(
    "idempotent: same key + same payload replays the original card",
    cardRetry.ok === true && cardRetry.status === "replayed" && cardRetry.id === card1.id,
  );
  const libCards = await call("getLibrary", ownerCtx, {});
  const qaCards = libCards.cards.filter((c) => c.id === card1.id);
  check(
    "idempotent: exactly one card row exists after the retry",
    qaCards.length === 1 && libCards.cards.filter((c) => c.snippetId === snippet2Id).length === 1,
  );
  check(
    "sediment: card carries 一句话核心 + 出处章节 + 所有者批注",
    qaCards[0]?.core === STUB_CORE &&
      qaCards[0]?.annotation === "所有者批注：讨论后的结论。" &&
      (qaCards[0]?.sourceLabel ?? "").includes("验证之书") &&
      (qaCards[0]?.sourceLabel ?? "").includes("第 1 章 财富"),
    qaCards[0]?.sourceLabel ?? "no card",
  );

  const beforeConflict = await rowCounts();
  const conflict = await call("createCard", ownerCtx, { ...cardArgs, core: "改过的核心" });
  check(
    "conflict: same key + different payload is a typed conflict, nothing written",
    conflict.ok === false && conflict.status === "conflict" && conflict.id === null,
  );
  check(
    "conflict: response carries the ledger resultId of the original card",
    conflict.resultId === card1.id,
    `resultId=${conflict.resultId} card=${card1.id}`,
  );
  const countsAfterConflict = await rowCounts();
  check(
    "conflict: card + ledger counts unchanged",
    countsAfterConflict.cards === beforeConflict.cards && countsAfterConflict.keys === beforeConflict.keys,
  );

  // Same snippet, more cards saved AFTER the original key: a later
  // conflict on the original key must still point at the original
  // card, never at the snippet's last card.
  const extra1 = await call("createCard", ownerCtx, {
    requestId: "qa-card-extra-1",
    core: "同片段后存的卡一",
    snippetId: snippet2Id,
  });
  const extra2 = await call("createCard", ownerCtx, {
    requestId: "qa-card-extra-2",
    core: "同片段后存的卡二",
    snippetId: snippet2Id,
  });
  check(
    "conflict-location: setup saves two more cards on the same snippet",
    extra1.ok === true && extra2.ok === true && extra1.id !== card1.id && extra2.id !== card1.id,
  );
  const conflictAgain = await call("createCard", ownerCtx, { ...cardArgs, core: "又改过的核心" });
  check(
    "conflict-location: multi-card snippet — conflict resultId still locates the ORIGINAL key's card precisely",
    conflictAgain.ok === false && conflictAgain.status === "conflict" &&
      conflictAgain.resultId === card1.id && conflictAgain.resultId !== extra2.id,
    `resultId=${conflictAgain.resultId} original=${card1.id} last=${extra2.id}`,
  );
  await db2InsertNoResultKey();
  const noResult = await call("createCard", ownerCtx, {
    requestId: "qa-conflict-noresult",
    core: "任意核心",
    snippetId: snippet2Id,
  });
  check(
    "conflict-location: ledger row without a resultId returns resultId null (client must not guess, says it cannot locate)",
    noResult.ok === false && noResult.status === "conflict" && noResult.resultId === null,
    `resultId=${noResult.resultId}`,
  );
  const delCard = await call("deleteCard", ownerCtx, { id: card1.id });
  check("owner: deleteCard ok", delCard.ok === true);
  const retryDeleted = await call("createCard", ownerCtx, cardArgs);
  check(
    "tombstone: retrying a deleted card's key is typed deleted, never resurrected",
    retryDeleted.ok === false && retryDeleted.status === "deleted",
  );
  const libFinal = await call("getLibrary", ownerCtx, {});
  check(
    "tombstone: deleted card stays gone",
    !libFinal.cards.some((c) => c.id === card1.id),
  );
}

/* ----- non-owner / anonymous: typed forbidden, zero read, zero write ----- */

for (const [label, viewer] of [["non-owner", NON_OWNER], ["anonymous", ANON]]) {
  const { ctx, state } = makeCtx(viewer);
  const before = await rowCounts();

  const ask = await call("askSnippetQuestion", ctx, { snippetId: 1, question: "越权提问" });
  check(
    `${label}: askSnippetQuestion typed forbidden with zero content`,
    ask.ok === false && ask.forbidden === true && ask.status === "refused" &&
      ask.answer === "" && ask.sourceText === "" && ask.sourceLabel === "" && ask.suggestedCore === null,
  );
  const card = await call("createCard", ctx, {
    requestId: `qa-forbidden-${label}`,
    core: "越权知识卡",
    snippetId: 1,
  });
  check(
    `${label}: createCard typed forbidden, no id`,
    card.ok === false && card.forbidden === true && card.id === null,
  );
  check(
    `${label}: zero database access and zero inference calls`,
    state.dbCalls === 0 && state.inferenceCalls === 0,
    `dbCalls=${state.dbCalls} inferenceCalls=${state.inferenceCalls}`,
  );
  const after = await rowCounts();
  check(
    `${label}: zero writes (cards / ledger / snippets unchanged)`,
    after.cards === before.cards && after.keys === before.keys && after.snippets === before.snippets,
  );
}

/* ================= pinned citations (CMP-READ-001 closure) =================
   Every successful ask consumes and returns the binding of exactly
   that ask (questionRequestId + snippet id + the stored version
   actually read + the response-time 原文/出处 snapshot). A card
   distilled from a turn carries the same binding into storage —
   but only after createCard re-verifies it against the stored
   snippet row; a moved source is a typed conflict with zero
   writes, never a silent re-pointing. Asking, saving a card and
   viewing a citation never register reuse. */

const cardsSrc = readFileSync(new URL("./client/src/Cards.tsx", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("./server/src/schema.ts", import.meta.url), "utf8");
const mig5 = readFileSync(new URL("./drizzle/0005_card_qa_discussion_binding.sql", import.meta.url), "utf8");

/* ----- source wiring: binding fields + migration ----- */
{
  const askSchemaStart = serverSrc.indexOf("const askSnippetResponse = z.object({");
  const askSchema = askSchemaStart > -1 ? serverSrc.slice(askSchemaStart, askSchemaStart + 1600) : "";
  check(
    "pin source: ask response schema is named and carries the binding (questionRequestId/snippetId/snippetVersion)",
    askSchema.length > 0 &&
      askSlice.includes("response: askSnippetResponse") &&
      askSchema.includes("questionRequestId: z.string().nullable()") &&
      askSchema.includes("snippetId: z.number().nullable()") &&
      askSchema.includes("snippetVersion: z.number().nullable()"),
  );
  check(
    "pin source: answered ask returns the consumed binding (echo id, stored id + version actually read)",
    askSlice.includes("questionRequestId: args.questionRequestId ?? null") &&
      askSlice.includes("snippetId: snip.id") &&
      askSlice.includes("snippetVersion: snip.version"),
  );
  check(
    "pin source: migration 0005 adds the four binding columns to knowledge_cards",
    mig5.includes("ALTER TABLE `knowledge_cards` ADD COLUMN `qa_question_request_id`") &&
      mig5.includes("ADD COLUMN `qa_snippet_version`") &&
      mig5.includes("ADD COLUMN `qa_source_text`") &&
      mig5.includes("ADD COLUMN `qa_source_label`"),
  );
  check(
    "pin source: schema declares the binding columns on knowledgeCards",
    schemaSrc.includes('qaQuestionRequestId: text("qa_question_request_id")') &&
      schemaSrc.includes('qaSnippetVersion: integer("qa_snippet_version")') &&
      schemaSrc.includes('qaSourceText: text("qa_source_text")') &&
      schemaSrc.includes('qaSourceLabel: text("qa_source_label")'),
  );
  const cardSlice = actionSlice(serverSrc, "createCard");
  check(
    "pin source: createCard re-verifies the binding against the stored row (version + 原文 + 出处） before writing",
    cardSlice.includes("qa.snippetVersion !== snip.version") &&
      cardSlice.includes("qa.sourceText !== snip.text") &&
      cardSlice.includes("qa.sourceLabel !== currentQaLabel"),
  );
  check(
    "pin source: the binding is part of the createCard payload fingerprint",
    cardSlice.includes("qa,") || cardSlice.includes("qaQuestionRequestId: args.qaQuestionRequestId"),
  );
  check(
    "pin client: each turn renders 查看本次原文 from the TURN's own snapshot (t.sourceText), not the live snippet",
    panel.includes("查看本次原文") && panel.includes("{t.sourceText}") && panel.includes("这轮回答时的固定快照"),
  );
  check(
    "pin client: 整理这轮为卡 opens that turn's draft; conclusion vs annotation kept apart",
    panel.includes("整理这轮为卡") && panel.includes("openTurnDraft(i)") &&
      panel.includes("我的一句话结论") && panel.includes("我的批注") &&
      panel.includes("{draftData.sourceText}"),
  );
  check(
    "pin client: late-response guard — a response applies only while it is the in-flight ask with the matching consumed id",
    panel.includes("pendingAskRef") && panel.includes("res.questionRequestId !== pending.id"),
  );
  check(
    "pin client: editing the question rotates its id (a changed question is a new ask); success rotates too",
    panel.includes("keyBoundTextRef") &&
      (panel.match(/questionKeyRef\.current = newRequestId\(\)/g) ?? []).length >= 2,
  );
  check(
    "pin client: a response never clears an edited question draft",
    panel.includes("questionRef.current.trim() === q"),
  );
  check(
    "pin client: moved-source save surfaces 原讨论来源已更新 with old-vs-current views and an explicit choice",
    panel.includes("原讨论来源已更新") && panel.includes("查看旧引用（当次讨论）") &&
      panel.includes("查看当前片段") && panel.includes("改用当前片段出处保存") &&
      panel.includes("先不保存，保留草稿") && panel.includes("没有按新版本默默保存"),
  );
  check(
    "pin client: the card save sends the turn's pinned binding to createCard",
    panel.includes("qaQuestionRequestId: t.questionRequestId") && panel.includes("qaSourceText: t.sourceText"),
  );
  check(
    "pin client: receipt + cards tab read the citation back from the STORED card row",
    panel.includes("receiptCard.qaSourceText") &&
      cardsSrc.includes("card.qaSourceText") && cardsSrc.includes("查看当次讨论引用"),
  );
}

/* ----- behavior: two turns, each with its own citation ----- */

// Per-question stub: the answer names its question, so two turns
// are distinguishable and an out-of-order mix-up would show.
inferenceImpl = async (prompt) => {
  const m = /【读者的问题】(.+)/.exec(prompt ?? "");
  const q = m ? m[1].trim() : "?";
  return { answer: `对「${q}」的解释`, suggestedCore: `核心：${q}` };
};

const pinBook = await call("addBook", ownerCtx, {
  requestId: "pin-book-1",
  title: "固定出处之书",
  source: "owner",
  status: "reading",
  importStatus: "none",
});
const PIN_TEXT = "复利来自重复使用，而不是重复阅读。";
const pinSnip = await call("createSnippet", ownerCtx, {
  requestId: "pin-snip-1",
  bookId: pinBook.id,
  text: PIN_TEXT,
  chapterLabel: "第 2 章 复利",
});
const pinId = pinSnip.id;
const pinLib1 = await call("getLibrary", ownerCtx, {});
const pinV1 = pinLib1.snippets.find((s) => s.id === pinId)?.version ?? 0;
check("pin setup: snippet saved at version 1", pinV1 === 1, `v=${pinV1}`);

const dashBefore = await call("getDashboard", ownerCtx, {});
const countsBeforeTurns = await rowCounts();

const turnA = await call("askSnippetQuestion", ownerCtx, {
  snippetId: pinId,
  question: "问题甲",
  questionRequestId: "pin-q-a",
  snippetVersion: pinV1,
});
check(
  "pin turn A: response consumes + returns its own binding",
  turnA.ok === true && turnA.questionRequestId === "pin-q-a" &&
    turnA.snippetId === pinId && turnA.snippetVersion === pinV1,
  `id=${turnA.questionRequestId} v=${turnA.snippetVersion}`,
);
check(
  "pin turn A: snapshot is the stored 原文 + 出处 at response time",
  turnA.sourceText === PIN_TEXT &&
    turnA.sourceLabel.includes("《固定出处之书》") && turnA.sourceLabel.includes("第 2 章 复利"),
  turnA.sourceLabel,
);
const turnB = await call("askSnippetQuestion", ownerCtx, {
  snippetId: pinId,
  question: "问题乙",
  questionRequestId: "pin-q-b",
  snippetVersion: pinV1,
  history: [{ question: "问题甲", answer: turnA.answer }],
});
check(
  "pin turn B: a different question carries its OWN binding + answer (no cross-turn mix-up)",
  turnB.ok === true && turnB.questionRequestId === "pin-q-b" &&
    turnB.questionRequestId !== turnA.questionRequestId &&
    turnB.answer.includes("问题乙") && turnA.answer.includes("问题甲") &&
    turnB.sourceText === turnA.sourceText,
);
const countsAfterTurns = await rowCounts();
check(
  "pin: asking writes nothing (no rows, no ledger keys)",
  countsAfterTurns.cards === countsBeforeTurns.cards &&
    countsAfterTurns.keys === countsBeforeTurns.keys &&
    countsAfterTurns.snippets === countsBeforeTurns.snippets,
);

/* ----- failure, then the SAME question retried under the SAME id ----- */
{
  const callsBefore = ownerState.inferenceCalls;
  inferenceImpl = async () => {
    throw new Error("simulated timeout before retry");
  };
  let threw = false;
  try {
    const action = Actions.askSnippetQuestion;
    await action.handler(
      ownerCtx,
      action.request.parse({ snippetId: pinId, question: "问题丙", questionRequestId: "pin-q-c" }),
    );
  } catch {
    threw = true;
  }
  inferenceImpl = async (prompt) => {
    const m = /【读者的问题】(.+)/.exec(prompt ?? "");
    const q = m ? m[1].trim() : "?";
    return { answer: `对「${q}」的解释`, suggestedCore: `核心：${q}` };
  };
  const retry = await call("askSnippetQuestion", ownerCtx, {
    snippetId: pinId,
    question: "问题丙",
    questionRequestId: "pin-q-c",
  });
  check(
    "pin retry: failed ask then same question + same id answers under the ORIGINAL id",
    threw === true && retry.ok === true && retry.questionRequestId === "pin-q-c" &&
      ownerState.inferenceCalls === callsBefore + 2,
  );
  const edited = await call("askSnippetQuestion", ownerCtx, {
    snippetId: pinId,
    question: "问题丙（改）",
    questionRequestId: "pin-q-c2",
  });
  check(
    "pin edit: a changed question is a new ask with its own id",
    edited.ok === true && edited.questionRequestId === "pin-q-c2" && edited.answer.includes("问题丙（改）"),
  );
}

/* ----- cards distilled from each turn keep their own citation ----- */

const cardAArgs = {
  requestId: "pin-card-a",
  core: "核心：问题甲",
  snippetId: pinId,
  qaQuestionRequestId: turnA.questionRequestId,
  qaSnippetVersion: turnA.snippetVersion,
  qaSourceText: turnA.sourceText,
  qaSourceLabel: turnA.sourceLabel,
};
const cardA = await call("createCard", ownerCtx, cardAArgs);
check("pin card A: save with turn A's binding succeeds", cardA.ok === true && cardA.status === "saved");
const cardB = await call("createCard", ownerCtx, {
  requestId: "pin-card-b",
  core: "核心：问题乙",
  snippetId: pinId,
  qaQuestionRequestId: turnB.questionRequestId,
  qaSnippetVersion: turnB.snippetVersion,
  qaSourceText: turnB.sourceText,
  qaSourceLabel: turnB.sourceLabel,
});
check("pin card B: save with turn B's binding succeeds", cardB.ok === true && cardB.id !== cardA.id);
{
  const lib = await call("getLibrary", ownerCtx, {});
  const rowA = lib.cards.find((c) => c.id === cardA.id);
  const rowB = lib.cards.find((c) => c.id === cardB.id);
  check(
    "pin cards: each stored card carries ITS OWN turn's citation (read back from the actual rows)",
    rowA?.qaQuestionRequestId === "pin-q-a" && rowB?.qaQuestionRequestId === "pin-q-b" &&
      rowA?.qaSnippetVersion === pinV1 && rowA?.qaSourceText === PIN_TEXT &&
      (rowA?.qaSourceLabel ?? "").includes("第 2 章 复利"),
    `A=${rowA?.qaQuestionRequestId} B=${rowB?.qaQuestionRequestId}`,
  );
}
const cardAReplay = await call("createCard", ownerCtx, cardAArgs);
check(
  "pin old key: replaying card A's exact key + payload returns the original card",
  cardAReplay.ok === true && cardAReplay.status === "replayed" && cardAReplay.id === cardA.id,
);
{
  const before = await rowCounts();
  const partial = await call("createCard", ownerCtx, {
    requestId: "pin-card-partial",
    core: "半套绑定",
    snippetId: pinId,
    qaQuestionRequestId: "pin-q-a",
  });
  check(
    "pin binding: a PARTIAL binding is a typed conflict, zero writes",
    partial.ok === false && partial.status === "conflict" && partial.id === null,
  );
  const noSnippet = await call("createCard", ownerCtx, {
    requestId: "pin-card-nosnip",
    core: "无片段的绑定",
    qaQuestionRequestId: turnA.questionRequestId,
    qaSnippetVersion: turnA.snippetVersion,
    qaSourceText: turnA.sourceText,
    qaSourceLabel: turnA.sourceLabel,
  });
  check(
    "pin binding: a binding without its snippet is refused, zero writes",
    noSnippet.ok === false && noSnippet.status === "conflict",
  );
  const tampered = await call("createCard", ownerCtx, {
    requestId: "pin-card-tampered",
    core: "被改过的快照",
    snippetId: pinId,
    qaQuestionRequestId: turnA.questionRequestId,
    qaSnippetVersion: turnA.snippetVersion,
    qaSourceText: "这段文字被改过了。",
    qaSourceLabel: turnA.sourceLabel,
  });
  check(
    "pin binding: a snapshot that does not match the stored 原文 is refused, zero writes",
    tampered.ok === false && tampered.status === "conflict",
  );
  const after = await rowCounts();
  check(
    "pin binding: all three refusals wrote nothing (cards + ledger unchanged)",
    after.cards === before.cards && after.keys === before.keys,
  );
}

/* ----- the source moves: stale asks refused, stale saves conflict ----- */

const bump = await call("updateSnippetReflection", ownerCtx, {
  id: pinId,
  version: pinV1,
  reflection: "所有者补记",
});
check("pin move: owner edit bumps the snippet version", bump.ok === true);
const pinV2 = pinV1 + 1;
{
  const callsBefore = ownerState.inferenceCalls;
  const staleAsk = await call("askSnippetQuestion", ownerCtx, {
    snippetId: pinId,
    question: "对着旧版本问",
    questionRequestId: "pin-q-stale",
    snippetVersion: pinV1,
  });
  check(
    "pin move: asking against a stale pinned version is notFound, zero inference, binds nothing",
    staleAsk.ok === false && staleAsk.status === "notFound" &&
      staleAsk.questionRequestId === null && staleAsk.snippetVersion === null &&
      ownerState.inferenceCalls === callsBefore,
  );
}
const turnC = await call("askSnippetQuestion", ownerCtx, {
  snippetId: pinId,
  question: "问题丁",
  questionRequestId: "pin-q-d",
});
check(
  "pin move: a fresh ask binds the CURRENT version",
  turnC.ok === true && turnC.snippetVersion === pinV2 && turnC.sourceText === PIN_TEXT,
  `v=${turnC.snippetVersion}`,
);
{
  const before = await rowCounts();
  const staleSave = await call("createCard", ownerCtx, {
    requestId: "pin-card-moved",
    core: "旧讨论的结论",
    snippetId: pinId,
    qaQuestionRequestId: turnA.questionRequestId,
    qaSnippetVersion: turnA.snippetVersion,
    qaSourceText: turnA.sourceText,
    qaSourceLabel: turnA.sourceLabel,
  });
  check(
    "pin move: saving a card with the OLD turn's binding after the source moved is a typed conflict",
    staleSave.ok === false && staleSave.status === "conflict" && staleSave.id === null && staleSave.resultId === null,
  );
  const afterStale = await rowCounts();
  check(
    "pin move: the refused save wrote nothing and did NOT consume the save key",
    afterStale.cards === before.cards && afterStale.keys === before.keys,
  );
  // The owner's explicit choice: same key, binding re-based on the
  // current version (turn C was answered against it).
  const rebound = await call("createCard", ownerCtx, {
    requestId: "pin-card-moved",
    core: "旧讨论的结论",
    snippetId: pinId,
    qaQuestionRequestId: turnC.questionRequestId,
    qaSnippetVersion: turnC.snippetVersion,
    qaSourceText: turnC.sourceText,
    qaSourceLabel: turnC.sourceLabel,
  });
  check(
    "pin move: the same key then saves with the explicitly chosen current binding",
    rebound.ok === true && rebound.status === "saved",
  );
  const lib = await call("getLibrary", ownerCtx, {});
  const row = lib.cards.find((c) => c.id === rebound.id);
  check(
    "pin move: the rebound card stores the CURRENT citation, exactly as chosen",
    row?.qaQuestionRequestId === "pin-q-d" && row?.qaSnippetVersion === pinV2,
  );
}

/* ----- library refresh never rewrites a stored citation ----- */
{
  await call("updateSnippetReflection", ownerCtx, {
    id: pinId,
    version: pinV2,
    reflection: "再次补记",
  });
  const lib = await call("getLibrary", ownerCtx, {});
  const snipNow = lib.snippets.find((s) => s.id === pinId);
  const rowA = lib.cards.find((c) => c.id === cardA.id);
  check(
    "pin refresh: library now shows the newer snippet version, the stored card keeps its v1 citation untouched",
    snipNow?.version === pinV2 + 1 && rowA?.qaSnippetVersion === pinV1 &&
      rowA?.qaSourceText === PIN_TEXT && rowA?.qaQuestionRequestId === "pin-q-a",
    `snippet v=${snipNow?.version} card v=${rowA?.qaSnippetVersion}`,
  );
}

/* ----- source deleted between ask and save ----- */
{
  const goneSnip = await call("createSnippet", ownerCtx, {
    requestId: "pin-snip-gone",
    bookId: pinBook.id,
    text: "马上会被删掉的片段。",
    chapterLabel: "第 9 章",
  });
  const goneTurn = await call("askSnippetQuestion", ownerCtx, {
    snippetId: goneSnip.id,
    question: "删前一问",
    questionRequestId: "pin-q-gone",
  });
  check("pin delete: ask before deletion answered with a binding", goneTurn.ok === true);
  await call("deleteSnippet", ownerCtx, { id: goneSnip.id });
  const before = await rowCounts();
  const saveGone = await call("createCard", ownerCtx, {
    requestId: "pin-card-gone",
    core: "来源已删的结论",
    snippetId: goneSnip.id,
    qaQuestionRequestId: goneTurn.questionRequestId,
    qaSnippetVersion: goneTurn.snippetVersion,
    qaSourceText: goneTurn.sourceText,
    qaSourceLabel: goneTurn.sourceLabel,
  });
  const after = await rowCounts();
  check(
    "pin delete: saving against a deleted source is notFound, zero writes",
    saveGone.ok === false && saveGone.status === "notFound" &&
      after.cards === before.cards && after.keys === before.keys,
  );
}

/* ----- reuse boundary: asks / card saves / citation views add none ----- */
{
  const dashMid = await call("getDashboard", ownerCtx, {});
  check(
    "pin reuse: asking + saving bound cards changed card totals only — reuse totals untouched",
    dashMid.totals.reuseTotal === dashBefore.totals.reuseTotal &&
      dashMid.totals.reusedCardCount === dashBefore.totals.reusedCardCount &&
      dashMid.totals.cardTotal > dashBefore.totals.cardTotal,
    `reuse ${dashBefore.totals.reuseTotal} -> ${dashMid.totals.reuseTotal}, cards ${dashBefore.totals.cardTotal} -> ${dashMid.totals.cardTotal}`,
  );
  const reuseArgs = {
    requestId: "pin-reuse-1",
    cardId: cardA.id,
    date: "2026-10-22",
    scene: "一次真实讨论",
    outcome: "用这张卡定了方向",
  };
  const reuse1 = await call("recordCardReuse", ownerCtx, reuseArgs);
  const reuseReplay = await call("recordCardReuse", ownerCtx, reuseArgs);
  const dashEnd = await call("getDashboard", ownerCtx, {});
  check(
    "pin reuse: one confirmed registration counts exactly once (replay does not double)",
    reuse1.ok === true && reuseReplay.ok === true && reuseReplay.status === "replayed" &&
      reuseReplay.id === reuse1.id &&
      dashEnd.totals.reuseTotal === dashMid.totals.reuseTotal + 1 &&
      dashEnd.totals.reusedCardCount === dashMid.totals.reusedCardCount + 1,
    `reuseTotal ${dashMid.totals.reuseTotal} -> ${dashEnd.totals.reuseTotal}`,
  );
}

/* ----- non-owner: binding fields stay null, zero access ----- */
{
  const { ctx, state } = makeCtx(NON_OWNER);
  const ask = await call("askSnippetQuestion", ctx, {
    snippetId: pinId,
    question: "越权提问",
    questionRequestId: "pin-q-forbidden",
  });
  check(
    "pin forbidden: non-owner ask returns null binding fields with zero db/inference access",
    ask.forbidden === true && ask.questionRequestId === null &&
      ask.snippetId === null && ask.snippetVersion === null &&
      state.dbCalls === 0 && state.inferenceCalls === 0,
  );
  const card = await call("createCard", ctx, {
    requestId: "pin-card-forbidden",
    core: "越权卡",
    snippetId: pinId,
    qaQuestionRequestId: "pin-q-a",
    qaSnippetVersion: pinV1,
    qaSourceText: PIN_TEXT,
    qaSourceLabel: "《固定出处之书》 · 第 2 章 复利",
  });
  check(
    "pin forbidden: non-owner bound card save is refused, no id",
    card.ok === false && card.forbidden === true && card.id === null && state.dbCalls === 0,
  );
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
