import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fileToBase64 } from "@hatch/space-sdk/client";
import { api } from "./api";
import {
SNIPPET_SOURCE_LABEL,
newRequestId,
sourceLabelOf,
statusMessage,
type Book,
type Library,
type Snippet,
} from "./lib";

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[15px]";
const labelCls = "block text-sm font-medium mb-1";

function parseTagInput(raw: string): string[] {
  return [...new Set(raw.split(/[,，、]/).map((t) => t.trim()).filter(Boolean))];
}

function DraftCard({ draft, books }: { draft: Snippet; books: Book[] }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(draft.text);
  const [bookTitle, setBookTitle] = useState(
    draft.bookTitle === "出处待确认" ? "" : draft.bookTitle,
  );
  const [chapterLabel, setChapterLabel] = useState(draft.chapterLabel ?? "");
  const [bookId, setBookId] = useState<string>("");
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["library"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const confirm = useMutation({
    mutationFn: () =>
      api.confirmSnippetDraft({
        id: draft.id,
        version: draft.version,
        text: text.trim(),
        bookTitle: bookTitle.trim(),
        chapterLabel: chapterLabel.trim() || null,
        bookId: bookId ? Number(bookId) : null,
      }),
    onSuccess: (res) => {
      if (res.ok) invalidate();
      else setMsg(statusMessage(res.status) ?? "确认失败，草稿还在。");
    },
    onError: () => setMsg("确认失败，草稿还在。"),
  });

  const discard = useMutation({
    mutationFn: () => api.deleteSnippet({ id: draft.id }),
    onSuccess: (res) => {
      if (res.ok) invalidate();
    },
  });

  return (
    <article className="rounded-xl border-2 border-dashed border-[var(--accent2)] bg-[var(--surface)] p-4">
      <p className="text-xs font-medium text-[var(--accent2)]">
        待确认草稿 · 来源：{SNIPPET_SOURCE_LABEL[draft.source]} — 核对无误才会成为片段
      </p>
      <div className="mt-3 space-y-3">
        <div>
          <label htmlFor={`d-text-${draft.id}`} className={labelCls}>原文（逐字核对）</label>
          <textarea id={`d-text-${draft.id}`} value={text} onChange={(e) => setText(e.target.value)} rows={3} className={`${inputCls} font-serif-book`} />
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label htmlFor={`d-title-${draft.id}`} className={labelCls}>书名</label>
            <input id={`d-title-${draft.id}`} value={bookTitle} onChange={(e) => setBookTitle(e.target.value)} className={inputCls} />
          </div>
          <div className="flex-1">
            <label htmlFor={`d-ch-${draft.id}`} className={labelCls}>章节（不知可留空）</label>
            <input id={`d-ch-${draft.id}`} value={chapterLabel} onChange={(e) => setChapterLabel(e.target.value)} placeholder="留空显示为章节不详" className={inputCls} />
          </div>
        </div>
        <div>
          <label htmlFor={`d-book-${draft.id}`} className={labelCls}>关联书单中的书（可不选）</label>
          <select id={`d-book-${draft.id}`} value={bookId} onChange={(e) => setBookId(e.target.value)} className={inputCls}>
            <option value="">不关联</option>
            {books.map((b) => (
              <option key={b.id} value={b.id}>《{b.title}》</option>
            ))}
          </select>
        </div>
        {msg && <p role="status" className="text-sm text-[var(--accent2)]">{msg}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={confirm.isPending || !text.trim() || !bookTitle.trim()}
            onClick={() => confirm.mutate()}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {confirm.isPending ? "确认中…" : "确认存为片段"}
          </button>
          {confirmDiscard ? (
            <button
              type="button"
              disabled={discard.isPending}
              onClick={() => discard.mutate()}
              className="rounded-lg bg-[var(--accent2)] px-4 py-2 text-sm font-medium text-white"
            >
              确认丢弃草稿？
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDiscard(true)}
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--dim)]"
            >
              丢弃
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

interface QaTurn {
  question: string;
  answer: string;
  suggestedCore: string | null;
}

// 「对这段提问」 panel. Three blocks are always kept apart:
//   原文 (pinned, read-only, with 书名/版本/章节 provenance)
//   我的问题 (the owner's own words)
//   Muse 的解释 (model output, labeled as such — never dressed
//   up as 原文 or as a book source)
// The exchange lives only in this panel's state. A failed/timed-out
// ask keeps the question in the textarea (draft preserved) and the
// pinned 原文 stays put; nothing becomes a knowledge card until the
// owner taps 存为知识卡， which goes through the same request-key
// ledger as every other card save.
function SnippetQaPanel({ snippet }: { snippet: Snippet }) {
  const queryClient = useQueryClient();
  const [turns, setTurns] = useState<QaTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [askError, setAskError] = useState<string | null>(null);
  const [core, setCore] = useState("");
  const [annotation, setAnnotation] = useState("");
  const [cardMsg, setCardMsg] = useState<string | null>(null);
  const [cardDone, setCardDone] = useState(false);
  const cardKeyRef = useRef<string>(newRequestId());

  const ask = useMutation({
    mutationFn: (q: string) =>
      api.askSnippetQuestion({
        snippetId: snippet.id,
        question: q,
        history: turns.slice(-6).map((t) => ({ question: t.question, answer: t.answer })),
      }),
    onSuccess: (res, q) => {
      if (res.ok) {
        setTurns((prev) => [
          ...prev,
          { question: q, answer: res.answer, suggestedCore: res.suggestedCore },
        ]);
        setQuestion("");
        setAskError(null);
        // Prefill the card core with the latest suggestion; the owner
        // can still rewrite it before saving.
        if (res.suggestedCore) setCore(res.suggestedCore);
        setCardDone(false);
      } else if (res.forbidden) {
        setAskError("当前身份无权提问（仅所有者可用）。问题草稿还在输入框里。");
      } else {
        setAskError("这段片段暂时无法提问（可能已被删除）。问题草稿还在输入框里。");
      }
    },
    // Failure/timeout: the draft is NOT cleared and no turn is added,
    // so there is never a half-finished exchange or half a card.
    onError: () =>
      setAskError("提问失败或超时。问题草稿还在输入框里，原文上下文没有丢，可以直接重试。"),
  });

  const saveCard = useMutation({
    mutationFn: () =>
      api.createCard({
        requestId: cardKeyRef.current,
        core: core.trim(),
        snippetId: snippet.id,
        annotation: annotation.trim() || undefined,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        cardKeyRef.current = newRequestId();
        setCardDone(true);
        setCardMsg(null);
        void queryClient.invalidateQueries({ queryKey: ["library"] });
        void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      } else {
        // Conflict/failure: core + annotation stay in the form.
        setCardMsg(statusMessage(res.status) ?? "保存知识卡失败，输入还在下面。");
      }
    },
    onError: () => setCardMsg("保存知识卡失败，输入还在下面，可以重试。"),
  });

  const canAsk = question.trim().length > 0 && !ask.isPending;

  return (
    <section
      aria-label={`对这段提问：${snippet.bookTitle}`}
      className="mt-3 border-t border-[var(--border)] pt-3"
    >
      {/* Pinned source: read-only, never mixed into the answer flow. */}
      <div className="rounded-lg border-2 border-[var(--text)] bg-[var(--bg)] p-3">
        <p className="text-xs font-semibold">
          原文 · 出处固定（不可编辑）
        </p>
        <p className="mt-0.5 text-xs text-[var(--dim)]">{sourceLabelOf(snippet)}</p>
        <blockquote className="font-serif-book mt-2 text-[15px] leading-relaxed">
          「{snippet.text}」
        </blockquote>
      </div>

      {turns.map((t, i) => (
        <div key={i} className="mt-3 space-y-2">
          <div className="rounded-lg border border-[var(--border)] p-3">
            <p className="text-xs font-semibold text-[var(--accent)]">我的问题</p>
            <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed">{t.question}</p>
          </div>
          <div className="rounded-lg border-l-4 border-[var(--accent)] bg-[var(--accent)]/5 p-3">
            <p className="text-xs font-semibold text-[var(--accent)]">
              Muse 的解释 · 模型生成，不是原文
            </p>
            <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed">{t.answer}</p>
          </div>
        </div>
      ))}

      <div className="mt-3">
        <label htmlFor={`qa-q-${snippet.id}`} className={labelCls}>
          {turns.length > 0 ? "继续追问（就这段原文）" : "向 Muse 提问（就这段原文）"}
        </label>
        <textarea
          id={`qa-q-${snippet.id}`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={3}
          placeholder="例如：这句话里的「想要」和「需要」怎么区分？"
          className={inputCls}
        />
        {askError && (
          <p role="alert" className="mt-2 text-sm text-[var(--accent2)]">
            ▲ {askError}
          </p>
        )}
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={!canAsk}
            onClick={() => ask.mutate(question.trim())}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {ask.isPending ? "Muse 思考中…" : turns.length > 0 ? "继续提问" : "提问"}
          </button>
          {askError && (
            <button
              type="button"
              disabled={!canAsk}
              onClick={() => ask.mutate(question.trim())}
              className="rounded-lg border border-[var(--accent2)] px-4 py-2 text-sm font-medium text-[var(--accent2)] disabled:opacity-50"
            >
              重试提问
            </button>
          )}
        </div>
      </div>

      {turns.length > 0 &&
        (cardDone ? (
          <p role="status" className="mt-3 text-sm text-[var(--ok)]">
            ✓ 已沉淀为知识卡（出处：{sourceLabelOf(snippet)}），去「知识卡」页能看到它。
          </p>
        ) : (
          <div className="mt-3 space-y-3 rounded-lg border border-dashed border-[var(--accent)] p-3">
            <p className="text-sm font-medium">把这次讨论沉淀为知识卡</p>
            <div>
              <label htmlFor={`qa-core-${snippet.id}`} className={labelCls}>
                一句话核心（带「建议」的是 Muse 的提炼，可改成你自己的话）
              </label>
              <input
                id={`qa-core-${snippet.id}`}
                value={core}
                onChange={(e) => setCore(e.target.value)}
                placeholder="用一句话写下这次讨论的结论"
                className={inputCls}
              />
              {turns[turns.length - 1]?.suggestedCore && (
                <p className="mt-1 text-xs text-[var(--dim)]">
                  建议核心：{turns[turns.length - 1]?.suggestedCore}
                </p>
              )}
            </div>
            <div>
              <label htmlFor={`qa-ann-${snippet.id}`} className={labelCls}>我的批注（可空）</label>
              <textarea
                id={`qa-ann-${snippet.id}`}
                value={annotation}
                onChange={(e) => setAnnotation(e.target.value)}
                rows={2}
                className={inputCls}
              />
            </div>
            <p className="text-xs text-[var(--dim)]">出处会记为：{sourceLabelOf(snippet)}</p>
            {cardMsg && (
              <p role="status" className="text-sm text-[var(--accent2)]">
                ▲ {cardMsg}
              </p>
            )}
            <button
              type="button"
              disabled={saveCard.isPending || !core.trim()}
              onClick={() => saveCard.mutate()}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {saveCard.isPending ? "保存中…" : "一键存为知识卡"}
            </button>
          </div>
        ))}
    </section>
  );
}

function SnippetCard({
  snippet,
  books,
  onOpenReader,
  highlighted,
}: {
  snippet: Snippet;
  books: Book[];
  onOpenReader: (book: Book, chapter?: number, offset?: number) => void;
  highlighted: boolean;
}) {
  const queryClient = useQueryClient();
  const [showCardForm, setShowCardForm] = useState(false);
  const [showQa, setShowQa] = useState(false);
  const [core, setCore] = useState("");
  const [annotation, setAnnotation] = useState("");
  const [cardTags, setCardTags] = useState("");
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  const [reflectionDraft, setReflectionDraft] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const cardKeyRef = useRef<string>(newRequestId());

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["library"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const book = snippet.bookId != null ? books.find((b) => b.id === snippet.bookId) : undefined;
  const ownerTags = snippet.tags.filter((t) => t.origin === "owner").map((t) => t.tag);
  const suggestedTags = snippet.tags.filter((t) => t.origin === "suggested").map((t) => t.tag);

  const suggest = useMutation({
    mutationFn: () => api.suggestSnippetMeta({ id: snippet.id }),
    onSuccess: (res) => {
      if (res.ok) invalidate();
      else setMsg("生成建议失败，请稍后重试。");
    },
    onError: () => setMsg("生成建议失败，请稍后重试。"),
  });

  const saveTags = useMutation({
    mutationFn: (tags: string[]) => api.setSnippetTags({ id: snippet.id, tags }),
    onSuccess: (res) => {
      if (res.ok) {
        setTagDraft(null);
        invalidate();
      } else setMsg(statusMessage(res.status) ?? "标签保存失败。");
    },
  });

  const saveReflection = useMutation({
    mutationFn: () =>
      api.updateSnippetReflection({
        id: snippet.id,
        version: snippet.version,
        reflection: reflectionDraft ?? "",
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setReflectionDraft(null);
        invalidate();
      } else setMsg(statusMessage(res.status) ?? "保存失败，输入还在。");
    },
    onError: () => setMsg("保存失败，输入还在。"),
  });

  const toggleInternalized = useMutation({
    mutationFn: (v: boolean) => api.setSnippetInternalized({ id: snippet.id, internalized: v }),
    onSuccess: () => invalidate(),
  });

  const del = useMutation({
    mutationFn: () => api.deleteSnippet({ id: snippet.id }),
    onSuccess: (res) => {
      if (res.ok) invalidate();
    },
  });

  const createCard = useMutation({
    mutationFn: () =>
      api.createCard({
        requestId: cardKeyRef.current,
        core: core.trim(),
        snippetId: snippet.id,
        annotation: annotation.trim() || undefined,
        tags: parseTagInput(cardTags),
      }),
    onSuccess: (res) => {
      if (res.ok) {
        cardKeyRef.current = newRequestId();
        setShowCardForm(false);
        setCore("");
        setAnnotation("");
        setCardTags("");
        setMsg("✓ 已写成知识卡，去「知识卡」页能看到它。");
        invalidate();
      } else {
        setMsg(statusMessage(res.status) ?? "保存失败，输入还在。");
      }
    },
    onError: () => setMsg("保存失败，输入还在。"),
  });

  return (
    <article
      id={`snippet-${snippet.id}`}
      className={`rounded-xl border bg-[var(--surface)] p-4 ${
        highlighted ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/40" : "border-[var(--border)]"
      }`}
    >
      <p className="text-xs text-[var(--dim)]">
        <span className="font-medium text-[var(--text)]">原文</span> · {sourceLabelOf(snippet)} ·{" "}
        {SNIPPET_SOURCE_LABEL[snippet.source]}
        {snippet.internalized ? " · ✓ 已内化" : ""}
        {snippet.cardIds.length > 0 ? ` · 已成卡 ${snippet.cardIds.length} 张` : ""}
      </p>
      <blockquote className="font-serif-book mt-2 text-[17px] leading-relaxed">
        「{snippet.text}」
      </blockquote>

      {snippet.thinkPrompt ? (
        <p className="mt-3 text-[15px] leading-relaxed">
          <span className="mr-2 rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--accent)]">
            Muse 思考提示
          </span>
          {snippet.thinkPrompt}
        </p>
      ) : (
        <button
          type="button"
          disabled={suggest.isPending}
          onClick={() => suggest.mutate()}
          className="mt-3 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {suggest.isPending ? "生成中…" : "生成思考提示 + 标签建议"}
        </button>
      )}

      {snippet.reflection && reflectionDraft == null && (
        <p className="mt-3 border-l-2 border-[var(--ok)] pl-3 text-[15px] leading-relaxed">
          <span className="mr-2 text-xs font-medium text-[var(--ok)]">我的批注</span>
          {snippet.reflection}
        </p>
      )}
      {reflectionDraft != null && (
        <div className="mt-3">
          <label htmlFor={`refl-${snippet.id}`} className={labelCls}>我的批注</label>
          <textarea
            id={`refl-${snippet.id}`}
            value={reflectionDraft}
            onChange={(e) => setReflectionDraft(e.target.value)}
            rows={3}
            className={inputCls}
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={saveReflection.isPending}
              onClick={() => saveReflection.mutate()}
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white"
            >
              保存批注
            </button>
            <button
              type="button"
              onClick={() => setReflectionDraft(null)}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="mt-3">
        {tagDraft == null ? (
          <p className="flex flex-wrap items-center gap-1.5">
            {ownerTags.map((t) => (
              <span key={t} className="rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-xs text-[var(--accent)]">
                {t}
              </span>
            ))}
            {suggestedTags.map((t) => (
              <span key={t} className="rounded-full border border-dashed border-[var(--dim)] px-2 py-0.5 text-xs text-[var(--dim)]">
                {t}（建议）
              </span>
            ))}
            <button
              type="button"
              onClick={() => setTagDraft(ownerTags.join("，"))}
              className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs"
            >
              编辑标签
            </button>
          </p>
        ) : (
          <div>
            <label htmlFor={`tags-${snippet.id}`} className={labelCls}>
              标签（逗号分隔；把建议标签写进来即视为采用）
            </label>
            <div className="flex gap-2">
              <input
                id={`tags-${snippet.id}`}
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                className={inputCls}
              />
              <button
                type="button"
                disabled={saveTags.isPending}
                onClick={() => saveTags.mutate(parseTagInput(tagDraft))}
                className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white"
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => setTagDraft(null)}
                className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      {showCardForm && (
        <div className="mt-3 space-y-3 border-t border-[var(--border)] pt-3">
          <div>
            <label htmlFor={`core-${snippet.id}`} className={labelCls}>一句话核心</label>
            <input id={`core-${snippet.id}`} value={core} onChange={(e) => setCore(e.target.value)} placeholder="用自己的一句话概括这条片段" className={inputCls} />
          </div>
          <div>
            <label htmlFor={`ann-${snippet.id}`} className={labelCls}>我的批注（可空）</label>
            <textarea id={`ann-${snippet.id}`} value={annotation} onChange={(e) => setAnnotation(e.target.value)} rows={2} className={inputCls} />
          </div>
          <div>
            <label htmlFor={`ctags-${snippet.id}`} className={labelCls}>标签（可空，逗号分隔）</label>
            <input id={`ctags-${snippet.id}`} value={cardTags} onChange={(e) => setCardTags(e.target.value)} className={inputCls} />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={createCard.isPending || !core.trim()}
              onClick={() => createCard.mutate()}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {createCard.isPending ? "保存中…" : "存为知识卡"}
            </button>
            <button
              type="button"
              onClick={() => setShowCardForm(false)}
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {!showCardForm && (
          <button
            type="button"
            onClick={() => setShowCardForm(true)}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white"
          >
            写成知识卡
          </button>
        )}
        <button
          type="button"
          aria-expanded={showQa}
          onClick={() => setShowQa((v) => !v)}
          className="rounded-lg border border-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent)]"
        >
          {showQa ? "收起提问" : "？对这段提问"}
        </button>
        {reflectionDraft == null && (
          <button
            type="button"
            onClick={() => setReflectionDraft(snippet.reflection ?? "")}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            {snippet.reflection ? "修改批注" : "✎ 写批注"}
          </button>
        )}
        <button
          type="button"
          aria-pressed={snippet.internalized}
          onClick={() => toggleInternalized.mutate(!snippet.internalized)}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
        >
          {snippet.internalized ? "↩ 取消内化" : "✓ 标为已内化"}
        </button>
        {book?.importStatus === "ready" && snippet.chapterIdx != null && (
          <button
            type="button"
            onClick={() => onOpenReader(book, snippet.chapterIdx ?? undefined, snippet.charOffset ?? undefined)}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            回原文
          </button>
        )}
        {confirmDelete ? (
          <button
            type="button"
            disabled={del.isPending}
            onClick={() => del.mutate()}
            className="rounded-lg bg-[var(--accent2)] px-3 py-1.5 text-sm font-medium text-white"
          >
            确认删除？
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)]"
          >
            删除
          </button>
        )}
      </div>
      {msg && (
        <p role="status" className="mt-2 text-sm text-[var(--dim)]">{msg}</p>
      )}
      {showQa && <SnippetQaPanel snippet={snippet} />}
    </article>
  );
}

export function Snippets({
  library,
  focusId,
  onOpenReader,
}: {
  library: Library;
  focusId: number | null;
  onOpenReader: (book: Book, chapter?: number, offset?: number) => void;
}) {
  const queryClient = useQueryClient();
  const draftKeyRef = useRef<string>(newRequestId());
  const ocrRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  const [source, setSource] = useState<"paste" | "ocr">("paste");
  const [bookTitle, setBookTitle] = useState("");
  const [chapterLabel, setChapterLabel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);

  useEffect(() => {
    if (focusId != null) {
      const t = window.setTimeout(() => {
        document.getElementById(`snippet-${focusId}`)?.scrollIntoView({ block: "center" });
      }, 80);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [focusId]);

  const createDraft = useMutation({
    mutationFn: () =>
      api.createSnippetDraft({
        requestId: draftKeyRef.current,
        source,
        text: text.trim(),
        bookTitle: bookTitle.trim() || undefined,
        chapterLabel: chapterLabel.trim() || undefined,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        draftKeyRef.current = newRequestId();
        setText("");
        setBookTitle("");
        setChapterLabel("");
        setSource("paste");
        setMsg("已存为待确认草稿 — 在下方核对后确认，才会成为正式片段。");
        void queryClient.invalidateQueries({ queryKey: ["library"] });
      } else {
        setMsg(statusMessage(res.status) ?? "保存失败，输入还在。");
      }
    },
    onError: () => setMsg("保存失败，输入还在。"),
  });

  const runOcr = async (file: File) => {
    setOcrBusy(true);
    setMsg(null);
    try {
      let blob: Blob = file;
      let mime: "image/jpeg" | "image/png" = file.type === "image/png" ? "image/png" : "image/jpeg";
      if (file.type !== "image/jpeg" && file.type !== "image/png") {
        // Convert other formats (webp/heic where the browser can draw
        // them) to JPEG through a canvas.
        const url = URL.createObjectURL(file);
        try {
          const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error("图片无法读取"));
            el.src = url;
          });
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx2d = canvas.getContext("2d");
          if (!ctx2d) throw new Error("图片无法转换");
          ctx2d.drawImage(img, 0, 0);
          blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (b) => (b ? resolve(b) : reject(new Error("图片无法转换"))),
              "image/jpeg",
              0.92,
            ),
          );
          mime = "image/jpeg";
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      const { dataBase64 } = await fileToBase64(blob);
      const res = await api.ocrExtract({ dataBase64, mimeType: mime });
      if (!res.ok) {
        setMsg("识别失败（可能无权或图片不清晰），可以改用粘贴。");
        return;
      }
      setText(res.text);
      setSource("ocr");
      setMsg("OCR 结果已填入下方，先核对文字，再存为待确认草稿。");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "识别失败，可以改用粘贴。");
    } finally {
      setOcrBusy(false);
    }
  };

  const drafts = library.snippets.filter((s) => s.status === "draft");
  const saved = [...library.snippets.filter((s) => s.status === "saved")].reverse();

  return (
    <div className="space-y-6">
      <section aria-label="微信读书片段入口" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="text-base font-semibold">从微信读书带入片段</h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
          粘贴文字或上传截图识别，先进待确认草稿；你核对原文、书名、章节后才落为片段，并标明来源（粘贴 / OCR）。不接微信读书账号，不抓取。
        </p>
        <input
          ref={ocrRef}
          type="file"
          accept="image/*"
          aria-label="选择微信读书截图"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void runOcr(f);
          }}
        />
        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor="paste-text" className={labelCls}>片段原文</label>
            <textarea id="paste-text" value={text} onChange={(e) => { setText(e.target.value); if (source === "ocr") setSource("paste"); }} rows={3} className={`${inputCls} font-serif-book`} placeholder="把微信读书里复制的句子粘贴到这里" />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label htmlFor="paste-title" className={labelCls}>书名（可先空着，确认时必填）</label>
              <input id="paste-title" value={bookTitle} onChange={(e) => setBookTitle(e.target.value)} className={inputCls} />
            </div>
            <div className="flex-1">
              <label htmlFor="paste-ch" className={labelCls}>章节（可空）</label>
              <input id="paste-ch" value={chapterLabel} onChange={(e) => setChapterLabel(e.target.value)} className={inputCls} />
            </div>
          </div>
          <p className="text-xs text-[var(--dim)]">本次来源：{source === "ocr" ? "截图 OCR" : "粘贴"}</p>
          {msg && <p role="status" className="text-sm text-[var(--dim)]">{msg}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={createDraft.isPending || !text.trim()}
              onClick={() => createDraft.mutate()}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {createDraft.isPending ? "保存中…" : "存为待确认草稿"}
            </button>
            <button
              type="button"
              disabled={ocrBusy}
              onClick={() => ocrRef.current?.click()}
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-50"
            >
              {ocrBusy ? "识别中…" : "上传截图 OCR"}
            </button>
          </div>
        </div>
      </section>

      {drafts.length > 0 && (
        <section aria-label="待确认草稿" className="space-y-3">
          <h2 className="text-xs font-medium tracking-wide text-[var(--dim)]">
            待确认草稿（{drafts.length}）
          </h2>
          {drafts.map((d) => (
            <DraftCard key={d.id} draft={d} books={library.books} />
          ))}
        </section>
      )}

      <section aria-label="全部片段" className="space-y-3">
        <h2 className="text-xs font-medium tracking-wide text-[var(--dim)]">
          全部片段（{saved.length}）
        </h2>
        {saved.length === 0 && (
          <p className="rounded-xl border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
            还没有片段。在阅读器里选中正文即可存片段，或用上方入口从微信读书带入。
          </p>
        )}
        {saved.map((s) => (
          <SnippetCard
            key={s.id}
            snippet={s}
            books={library.books}
            onOpenReader={onOpenReader}
            highlighted={focusId === s.id}
          />
        ))}
      </section>
    </div>
  );
}
