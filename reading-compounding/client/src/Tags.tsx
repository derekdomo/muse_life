import { useState } from "react";
import { sourceLabelOf, type Library } from "./lib";

type TagEntry = {
  snippets: Library["snippets"];
  cards: Library["cards"];
  suggestedOnly: boolean;
};

// One topic section: collapsed by default (LIFE-DESIGN-001-B2A) —
// the summary row is the tag name + 「N 条片段 · M 张卡」; expanding
// shows the exact same jump lists as before. Fold state lives only
// in this component instance and is never persisted, so every open
// starts from the default collapsed state.
function TagSection({
  tag,
  entry,
  onGoSnippet,
  onGoCards,
}: {
  tag: string;
  entry: TagEntry;
  onGoSnippet: (id: number) => void;
  onGoCards: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label={`主题：${tag}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-baseline gap-2 text-left"
      >
        <span className="rounded-full bg-[var(--accent)]/10 px-2.5 py-0.5 text-sm font-semibold text-[var(--accent)]">
          {tag}
        </span>
        <span className="text-xs text-[var(--dim)]">
          {entry.snippets.length} 条片段 · {entry.cards.length} 张卡
          {entry.suggestedOnly ? " · 仅为建议标签，尚未采用" : ""}
        </span>
        <span className="text-xs text-[var(--dim)]">{open ? "▲ 收起" : "▼ 展开"}</span>
      </button>
      {open && (
        <>
          {entry.snippets.length > 0 && (
            <ul className="mt-2 space-y-2">
              {entry.snippets.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onGoSnippet(s.id)}
                    className="block w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-left"
                  >
                    <span className="font-serif-book block text-[15px] leading-relaxed">
                      「{s.text}」
                    </span>
                    <span className="mt-1 block text-xs text-[var(--dim)]">
                      {sourceLabelOf(s)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {entry.cards.length > 0 && (
            <ul className="mt-2 space-y-2">
              {entry.cards.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={onGoCards}
                    className="block w-full rounded-xl border border-[var(--accent2)]/50 bg-[var(--surface)] p-3 text-left"
                  >
                    <span className="block text-[15px] font-medium">{c.core}</span>
                    <span className="mt-1 block text-xs text-[var(--dim)]">
                      知识卡{c.sourceLabel ? ` · ${c.sourceLabel}` : ""} · ↻ 已复用 {c.reuseCount} 次
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// Cross-book aggregation by topic tag: the same theme surfacing in
// different books is the visible shape of compounding knowledge.
export function Tags({
  library,
  onGoSnippet,
  onGoCards,
}: {
  library: Library;
  onGoSnippet: (id: number) => void;
  onGoCards: () => void;
}) {
  const byTag = new Map<string, TagEntry>();
  const ensure = (tag: string) => {
    let entry = byTag.get(tag);
    if (!entry) {
      entry = { snippets: [], cards: [], suggestedOnly: true };
      byTag.set(tag, entry);
    }
    return entry;
  };
  for (const s of library.snippets) {
    if (s.status !== "saved") continue;
    for (const t of s.tags) {
      const entry = ensure(t.tag);
      if (!entry.snippets.some((x) => x.id === s.id)) entry.snippets.push(s);
      if (t.origin === "owner") entry.suggestedOnly = false;
    }
  }
  for (const c of library.cards) {
    for (const t of c.tags) {
      const entry = ensure(t.tag);
      if (!entry.cards.some((x) => x.id === c.id)) entry.cards.push(c);
      if (t.origin === "owner") entry.suggestedOnly = false;
    }
  }
  const tags = [...byTag.entries()].sort((a, b) => {
    const countA = a[1].snippets.length + a[1].cards.length;
    const countB = b[1].snippets.length + b[1].cards.length;
    return countB - countA || a[0].localeCompare(b[0], "zh");
  });

  if (tags.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
        还没有标签。在片段或知识卡上加主题标签后，同一主题跨书的内容会自动聚到这里。
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {tags.map(([tag, entry]) => (
        <TagSection
          key={tag}
          tag={tag}
          entry={entry}
          onGoSnippet={onGoSnippet}
          onGoCards={onGoCards}
        />
      ))}
    </div>
  );
}
