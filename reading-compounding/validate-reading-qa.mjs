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
  const countsAfterConflict = await rowCounts();
  check(
    "conflict: card + ledger counts unchanged",
    countsAfterConflict.cards === beforeConflict.cards && countsAfterConflict.keys === beforeConflict.keys,
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

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
