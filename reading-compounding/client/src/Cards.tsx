import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import {
newRequestId,
statusMessage,
type Card,
type Library,
} from "./lib";

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[15px]";
const labelCls = "block text-sm font-medium mb-1";

function parseTagInput(raw: string): string[] {
  return [...new Set(raw.split(/[,，、]/).map((t) => t.trim()).filter(Boolean))];
}

function CardItem({ card, library }: { card: Card; library: Library }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [core, setCore] = useState(card.core);
  const [annotation, setAnnotation] = useState(card.annotation ?? "");
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  const [showReuse, setShowReuse] = useState(false);
  const [rDate, setRDate] = useState(library.today);
  const [rScene, setRScene] = useState("");
  const [rOutcome, setROutcome] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const reuseKeyRef = useRef<string>(newRequestId());

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["library"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const snippet = card.snippetId != null
    ? library.snippets.find((s) => s.id === card.snippetId)
    : undefined;
  const reuses = library.reuses.filter((r) => r.cardId === card.id);
  const ownerTags = card.tags.filter((t) => t.origin === "owner").map((t) => t.tag);

  const saveEdit = useMutation({
    mutationFn: () =>
      api.updateCard({
        id: card.id,
        version: card.version,
        core: core.trim(),
        annotation: annotation.trim() || null,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setEditing(false);
        invalidate();
      } else setMsg(statusMessage(res.status) ?? "保存失败，输入还在。");
    },
    onError: () => setMsg("保存失败，输入还在。"),
  });

  const saveTags = useMutation({
    mutationFn: (tags: string[]) => api.setCardTags({ id: card.id, tags }),
    onSuccess: (res) => {
      if (res.ok) {
        setTagDraft(null);
        invalidate();
      } else setMsg(statusMessage(res.status) ?? "标签保存失败。");
    },
  });

  const registerReuse = useMutation({
    mutationFn: () =>
      api.recordCardReuse({
        requestId: reuseKeyRef.current,
        cardId: card.id,
        date: rDate || undefined,
        scene: rScene.trim(),
        outcome: rOutcome.trim(),
      }),
    onSuccess: (res) => {
      if (res.ok) {
        reuseKeyRef.current = newRequestId();
        setShowReuse(false);
        setRScene("");
        setROutcome("");
        setMsg(res.status === "replayed" ? "这次复用已经登记过了，没有重复计数。" : "✓ 复用已登记");
        invalidate();
      } else {
        setMsg(statusMessage(res.status) ?? "登记失败，输入还在。");
      }
    },
    onError: () => setMsg("登记失败，输入还在。"),
  });

  const del = useMutation({
    mutationFn: () => api.deleteCard({ id: card.id }),
    onSuccess: (res) => {
      if (res.ok) invalidate();
    },
  });

  return (
    <article className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="font-serif-book text-[19px] font-semibold leading-snug">{card.core}</p>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--dim)]">
        {card.sourceLabel && <span>出处：{card.sourceLabel}</span>}
        <span>{card.origin === "chat" ? "聊天沉淀" : "应用内创建"}</span>
        <span className={card.reuseCount > 0 ? "font-medium text-[var(--accent2)]" : ""}>
          ↻ 已复用 {card.reuseCount} 次
          {card.lastReuseDate ? ` · 最近 ${card.lastReuseDate}` : ""}
        </span>
      </p>

      {snippet && (
        <blockquote className="font-serif-book mt-3 border-l-2 border-[var(--border)] pl-3 text-[15px] leading-relaxed text-[var(--dim)]">
          「{snippet.text}」
        </blockquote>
      )}
      {card.annotation && !editing && (
        <p className="mt-3 border-l-2 border-[var(--ok)] pl-3 text-[15px] leading-relaxed">
          <span className="mr-2 text-xs font-medium text-[var(--ok)]">我的批注</span>
          {card.annotation}
        </p>
      )}

      {tagDraft == null ? (
        <p className="mt-3 flex flex-wrap items-center gap-1.5">
          {ownerTags.map((t) => (
            <span key={t} className="rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-xs text-[var(--accent)]">
              {t}
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
        <div className="mt-3">
          <label htmlFor={`ct-${card.id}`} className={labelCls}>标签（逗号分隔）</label>
          <div className="flex gap-2">
            <input id={`ct-${card.id}`} value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} className={inputCls} />
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

      {editing && (
        <div className="mt-3 space-y-3 border-t border-[var(--border)] pt-3">
          <div>
            <label htmlFor={`cc-${card.id}`} className={labelCls}>一句话核心</label>
            <input id={`cc-${card.id}`} value={core} onChange={(e) => setCore(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor={`ca-${card.id}`} className={labelCls}>我的批注</label>
            <textarea id={`ca-${card.id}`} value={annotation} onChange={(e) => setAnnotation(e.target.value)} rows={3} className={inputCls} />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={saveEdit.isPending || !core.trim()}
              onClick={() => saveEdit.mutate()}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              保存
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {showReuse && (
        <div className="mt-3 space-y-3 border-t border-[var(--border)] pt-3">
          <p className="text-xs text-[var(--dim)]">
            只登记真实发生过的调用——在某个决策、项目或讨论里实际用上了这张卡。「以后可能用得上」不算。
          </p>
          <div>
            <label htmlFor={`rd-${card.id}`} className={labelCls}>日期</label>
            <input id={`rd-${card.id}`} type="date" value={rDate} onChange={(e) => setRDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor={`rs-${card.id}`} className={labelCls}>场景（在哪次决策/项目/讨论里用的）</label>
            <input id={`rs-${card.id}`} value={rScene} onChange={(e) => setRScene(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor={`ro-${card.id}`} className={labelCls}>解决了什么</label>
            <textarea id={`ro-${card.id}`} value={rOutcome} onChange={(e) => setROutcome(e.target.value)} rows={2} className={inputCls} />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={registerReuse.isPending || !rScene.trim() || !rOutcome.trim()}
              onClick={() => registerReuse.mutate()}
              className="rounded-lg bg-[var(--accent2)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {registerReuse.isPending ? "登记中…" : "登记这次复用"}
            </button>
            <button
              type="button"
              onClick={() => setShowReuse(false)}
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {!showReuse && (
          <button
            type="button"
            onClick={() => setShowReuse(true)}
            className="rounded-lg bg-[var(--accent2)] px-3 py-1.5 text-sm font-medium text-white"
          >
            ↻ 登记复用
          </button>
        )}
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            编辑
          </button>
        )}
        {confirmDelete ? (
          <button
            type="button"
            disabled={del.isPending}
            onClick={() => del.mutate()}
            className="rounded-lg bg-[var(--accent2)] px-3 py-1.5 text-sm font-medium text-white"
          >
            确认删除这张卡？
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

      {reuses.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-[var(--border)] pt-3">
          {[...reuses].reverse().map((r) => (
            <li key={r.id} className="text-sm">
              <span className="text-[var(--accent2)]">↻</span>{" "}
              <span className="tabular-nums text-[var(--dim)]">{r.date}</span> {r.scene}
              <span className="text-[var(--dim)]"> → {r.outcome}</span>
            </li>
          ))}
        </ul>
      )}
      {msg && (
        <p role="status" className="mt-2 text-sm text-[var(--dim)]">{msg}</p>
      )}
    </article>
  );
}

export function Cards({ library }: { library: Library }) {
  const queryClient = useQueryClient();
  const cardKeyRef = useRef<string>(newRequestId());
  const [core, setCore] = useState("");
  const [snippetId, setSnippetId] = useState<string>("");
  const [annotation, setAnnotation] = useState("");
  const [tags, setTags] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createCard({
        requestId: cardKeyRef.current,
        core: core.trim(),
        snippetId: snippetId ? Number(snippetId) : null,
        annotation: annotation.trim() || undefined,
        tags: parseTagInput(tags),
      }),
    onSuccess: (res) => {
      if (res.ok) {
        cardKeyRef.current = newRequestId();
        setCore("");
        setAnnotation("");
        setTags("");
        setSnippetId("");
        setMsg("✓ 知识卡已保存");
        void queryClient.invalidateQueries({ queryKey: ["library"] });
        void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      } else {
        setMsg(statusMessage(res.status) ?? "保存失败，输入还在。");
      }
    },
    onError: () => setMsg("保存失败，输入还在。"),
  });

  const savedSnippets = library.snippets.filter((s) => s.status === "saved");
  const cards = [...library.cards].reverse();
  const allReuses = [...library.reuses].reverse();

  return (
    <div className="space-y-6">
      <section aria-label="新建知识卡" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="text-base font-semibold">新建知识卡</h2>
        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor="new-core" className={labelCls}>一句话核心</label>
            <input id="new-core" value={core} onChange={(e) => setCore(e.target.value)} placeholder="用自己的一句话概括" className={inputCls} />
          </div>
          <div>
            <label htmlFor="new-snippet" className={labelCls}>对应片段（可不选）</label>
            <select id="new-snippet" value={snippetId} onChange={(e) => setSnippetId(e.target.value)} className={inputCls}>
              <option value="">不关联片段</option>
              {savedSnippets.map((s) => (
                <option key={s.id} value={s.id}>
                  《{s.bookTitle}》「{s.text.slice(0, 40)}…」
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="new-ann" className={labelCls}>我的批注（可空）</label>
            <textarea id="new-ann" value={annotation} onChange={(e) => setAnnotation(e.target.value)} rows={2} className={inputCls} />
          </div>
          <div>
            <label htmlFor="new-tags" className={labelCls}>标签（可空，逗号分隔）</label>
            <input id="new-tags" value={tags} onChange={(e) => setTags(e.target.value)} className={inputCls} />
          </div>
          {msg && <p role="status" className="text-sm text-[var(--dim)]">{msg}</p>}
          <button
            type="button"
            disabled={create.isPending || !core.trim()}
            onClick={() => create.mutate()}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {create.isPending ? "保存中…" : "保存知识卡"}
          </button>
        </div>
      </section>

      <section aria-label="全部知识卡" className="space-y-3">
        <h2 className="text-xs font-medium tracking-wide text-[var(--dim)]">
          全部知识卡（{cards.length}）
        </h2>
        {cards.length === 0 && (
          <p className="rounded-xl border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
            还没有知识卡。从一条片段「写成知识卡」，或在和 Muse 聊书时让它把讨论沉淀成卡。
          </p>
        )}
        {cards.map((c) => (
          <CardItem key={c.id} card={c} library={library} />
        ))}
      </section>

      {allReuses.length > 0 && (
        <section aria-label="复用账本">
          <h2 className="text-xs font-medium tracking-wide text-[var(--dim)]">
            复用账本 ↻（共 {allReuses.length} 笔）
          </h2>
          <ul className="mt-2 divide-y divide-[var(--border)]">
            {allReuses.map((r) => (
              <li key={r.id} className="py-2.5 text-sm">
                <span className="tabular-nums text-[var(--dim)]">{r.date}</span>{" "}
                <span className="font-medium">「{r.cardCore}」</span>
                <p className="mt-0.5 text-[var(--dim)]">
                  {r.scene} → {r.outcome}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
