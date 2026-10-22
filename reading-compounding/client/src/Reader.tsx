import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { sanitizeChapterHtml } from "./epub";
import { newRequestId, statusMessage, type Book } from "./lib";

// Find the text node + local offset for a global char offset inside a
// container (offset counts textContent chars — the same measure used
// when a snippet is captured and when the position is saved).
function locateOffset(
  root: HTMLElement,
  target: number,
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = target;
  let node = walker.nextNode() as Text | null;
  let last: Text | null = null;
  while (node) {
    last = node;
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
    node = walker.nextNode() as Text | null;
  }
  return last ? { node: last, offset: last.data.length } : null;
}

function scrollToOffset(root: HTMLElement, target: number) {
  const loc = locateOffset(root, target);
  if (!loc) return;
  const range = document.createRange();
  range.setStart(loc.node, loc.offset);
  range.setEnd(loc.node, loc.offset);
  const rect = range.getBoundingClientRect();
  const top = window.scrollY + rect.top - 120;
  window.scrollTo({ top: Math.max(0, top) });
}

// Char offset of the first visible text near the top of the viewport.
function currentTopOffset(root: HTMLElement): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.bottom > 90) {
      // Estimate the local offset from the vertical fraction visible.
      if (rect.top >= 90 || rect.height === 0) return acc;
      const frac = Math.min(1, Math.max(0, (90 - rect.top) / rect.height));
      return acc + Math.floor(node.data.length * frac);
    }
    acc += node.data.length;
    node = walker.nextNode() as Text | null;
  }
  return acc;
}

interface SelectionInfo {
  text: string;
  charOffset: number;
}

export function Reader({
  book,
  startChapter,
  startOffset,
  onClose,
}: {
  book: Book;
  startChapter?: number;
  startOffset?: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [chapterIdx, setChapterIdx] = useState(startChapter ?? book.curChapter);
  const [showToc, setShowToc] = useState(false);
  const [fontSize, setFontSize] = useState(18);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [snippetMsg, setSnippetMsg] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const snippetKeyRef = useRef<string>(newRequestId());
  const restoredFor = useRef<number>(-1);

  const chapter = useQuery({
    queryKey: ["chapter", book.id, chapterIdx],
    queryFn: () => api.getChapter({ bookId: book.id, idx: chapterIdx }),
  });

  const safeHtml = useMemo(
    () => (chapter.data?.found ? sanitizeChapterHtml(chapter.data.html) : ""),
    [chapter.data],
  );

  const savePosition = useMutation({
    mutationFn: (args: { chapterIdx: number; charOffset: number }) =>
      api.savePosition({ bookId: book.id, ...args }),
  });

  // Restore the saved position once per chapter load.
  useEffect(() => {
    if (!chapter.data?.found || !safeHtml) return;
    if (restoredFor.current === chapterIdx) return;
    restoredFor.current = chapterIdx;
    const root = contentRef.current;
    if (!root) return;
    const target =
      startChapter === chapterIdx && startOffset != null
        ? startOffset
        : chapterIdx === book.curChapter
          ? book.curOffset
          : 0;
    if (target > 0) {
      const t = window.setTimeout(() => scrollToOffset(root, target), 60);
      return () => window.clearTimeout(t);
    }
    window.scrollTo({ top: 0 });
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.data, safeHtml, chapterIdx]);

  // Persist position as the owner scrolls (debounced).
  useEffect(() => {
    let timer: number | undefined;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const root = contentRef.current;
        if (!root) return;
        savePosition.mutate({
          chapterIdx,
          charOffset: currentTopOffset(root),
        });
      }, 600);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterIdx, book.id]);

  const captureSelection = () => {
    const sel = window.getSelection();
    const root = contentRef.current;
    if (!sel || sel.isCollapsed || !root) {
      setSelection(null);
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      setSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer)) {
      setSelection(null);
      return;
    }
    const pre = range.cloneRange();
    pre.selectNodeContents(root);
    pre.setEnd(range.startContainer, range.startOffset);
    setSelection({ text, charOffset: pre.toString().length });
    setSnippetMsg(null);
  };

  const saveSnippet = useMutation({
    mutationFn: (sel: SelectionInfo) =>
      api.createSnippet({
        requestId: snippetKeyRef.current,
        bookId: book.id,
        text: sel.text,
        chapterIdx,
        chapterLabel: chapter.data?.title ?? null,
        charOffset: sel.charOffset,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setSnippetMsg(res.status === "replayed" ? "这句已经存过了。" : "✓ 已存为片段");
        setSelection(null);
        window.getSelection()?.removeAllRanges();
        snippetKeyRef.current = newRequestId();
        void queryClient.invalidateQueries({ queryKey: ["library"] });
      } else {
        setSnippetMsg(statusMessage(res.status) ?? "保存失败，请重试。");
      }
    },
    onError: () => setSnippetMsg("保存失败，请重试（输入还在）。"),
  });

  const toc = chapter.data?.toc ?? [];
  const chapterTitle =
    chapter.data?.title ?? toc.find((t) => t.idx === chapterIdx)?.title ?? "";

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-[var(--bg)]">
      <div className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/95 pt-safe">
        <div className="mx-auto flex max-w-2xl items-center gap-2 px-4 py-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭阅读器"
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            ← 返回
          </button>
          <button
            type="button"
            onClick={() => setShowToc((v) => !v)}
            aria-label="目录"
            aria-expanded={showToc}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            目录
          </button>
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="字号">
            <button
              type="button"
              aria-label="减小字号"
              onClick={() => setFontSize((s) => Math.max(15, s - 1))}
              className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-sm"
            >
              A-
            </button>
            <button
              type="button"
              aria-label="增大字号"
              onClick={() => setFontSize((s) => Math.min(24, s + 1))}
              className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-sm"
            >
              A+
            </button>
          </div>
        </div>
        {showToc && (
          <nav aria-label="章节目录" className="max-h-64 overflow-y-auto border-t border-[var(--border)]">
            <ul className="mx-auto max-w-2xl px-4 py-2">
              {toc.map((t) => (
                <li key={t.idx}>
                  <button
                    type="button"
                    onClick={() => {
                      setChapterIdx(t.idx);
                      restoredFor.current = -1;
                      setShowToc(false);
                    }}
                    aria-current={t.idx === chapterIdx ? "true" : undefined}
                    className={`block w-full truncate py-2 text-left text-sm ${
                      t.idx === chapterIdx
                        ? "font-semibold text-[var(--accent)]"
                        : "text-[var(--text)]"
                    }`}
                  >
                    {t.idx === chapterIdx ? "● " : "○ "}
                    {t.title}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>

      <main className="mx-auto max-w-2xl px-5 pb-40 pt-6">
        <p className="text-xs text-[var(--dim)]">
          《{book.title}》
          {book.versionLabel ? ` · ${book.versionLabel}` : ""}
        </p>
        <h2 className="font-serif-book mt-1 text-xl font-semibold">{chapterTitle}</h2>
        {chapter.isPending && <p className="mt-6 text-sm text-[var(--dim)]">加载章节中…</p>}
        {chapter.data && !chapter.data.found && (
          <p className="mt-6 text-sm text-[var(--dim)]">这一章没有存入正文。</p>
        )}
        {chapter.data?.found && (
          <div
            ref={contentRef}
            role="document"
            aria-label="章节正文"
            onMouseUp={captureSelection}
            onTouchEnd={() => window.setTimeout(captureSelection, 50)}
            className="font-serif-book mt-4 leading-loose text-[var(--text)] [&_p]:mb-4 [&_h1]:mb-4 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:mb-3 [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border)] [&_blockquote]:pl-4 [&_blockquote]:text-[var(--dim)] [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mb-1"
            style={{ fontSize }}
            dangerouslySetInnerHTML={{ __html: safeHtml }}
          />
        )}
        <div className="mt-10 flex items-center justify-between">
          <button
            type="button"
            disabled={chapterIdx <= 0}
            onClick={() => {
              setChapterIdx(chapterIdx - 1);
              restoredFor.current = -1;
            }}
            className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-40"
          >
            ← 上一章
          </button>
          <span className="text-xs text-[var(--dim)]">
            第 {chapterIdx + 1} / {toc.length || "—"} 章
          </span>
          <button
            type="button"
            disabled={toc.length === 0 || chapterIdx >= toc.length - 1}
            onClick={() => {
              setChapterIdx(chapterIdx + 1);
              restoredFor.current = -1;
            }}
            className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-40"
          >
            下一章 →
          </button>
        </div>
      </main>

      {selection && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--border)] bg-[var(--surface)] pb-safe">
          <div className="mx-auto max-w-2xl px-4 py-3">
            <p className="font-serif-book line-clamp-2 text-sm text-[var(--dim)]">
              「{selection.text}」
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={saveSnippet.isPending}
                onClick={() => saveSnippet.mutate(selection)}
                className="flex-1 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white"
              >
                {saveSnippet.isPending ? "保存中…" : "存为片段"}
              </button>
              <button
                type="button"
                onClick={() => setSelection(null)}
                className="rounded-lg border border-[var(--border)] px-4 py-2.5 text-sm"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
      {snippetMsg && !selection && (
        <div
          role="status"
          className="fixed inset-x-0 bottom-6 z-20 mx-auto w-fit max-w-[90%] rounded-full bg-[var(--text)] px-4 py-2 text-sm text-[var(--bg)]"
        >
          {snippetMsg}
        </div>
      )}
    </div>
  );
}
