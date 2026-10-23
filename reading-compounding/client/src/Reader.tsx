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
  // Capture-time binding (CMP-READ-001 P1): the DISPLAYED chapter
  // this text was selected in — its snapshot idx, title and pinned
  // live version, frozen at capture time. A later chapter request
  // or response can never re-point a held selection at a chapter
  // its text did not come from.
  chapterIdx: number;
  chapterLabel: string | null;
  liveVersion: string | null;
}

// The DISPLAY SNAPSHOT (CMP-READ-001): the one version of the book
// this reader is actually showing — chapter body, title, TOC and
// the live-version token + edition label it belongs to, as one
// unit. Only data whose liveVersion matches the pinned version (or
// the first load that SETS the pin) may enter it; a late response
// from a different version never overwrites the displayed body,
// TOC, label or selection — it only raises the stale banner.
// `generation` is the switch generation that produced this
// snapshot: 0 for the reader's initial load, incremented on every
// explicit version switch. Position restore keys on it — a
// post-switch snapshot always restores to the top, never to the
// pre-switch start/book offset.
interface DisplaySnapshot {
  idx: number;
  found: boolean;
  title: string | null;
  html: string;
  toc: Array<{ idx: number; title: string }>;
  liveVersion: string | null;
  versionLabel: string | null;
  generation: number;
}

// One getChapter response, as the admission decision sees it.
export interface ChapterResponseData {
  forbidden: boolean;
  found: boolean;
  title: string | null;
  html: string;
  toc: Array<{ idx: number; title: string }>;
  liveVersion: string | null;
  versionLabel: string | null;
}

// The reader's version-pin state, as the admission decision sees
// it. `pinned === undefined` means no version is settled (initial
// load, or an explicit switch whose new version has not landed
// yet). During an explicit switch, `awaitingNewVersion` is set and
// `switchFromVersion` records the version pinned BEFORE the switch.
export interface ReaderVersionState {
  pinned: string | null | undefined;
  awaitingNewVersion: boolean;
  switchFromVersion: string | null | undefined;
}

export type ChapterAdmission =
  // The response enters the display snapshot; `pinned` is the pin
  // after admission (set on first load / on a completed switch,
  // unchanged on a same-version chapter move).
  | { kind: "admit"; pinned: string | null; snapshot: DisplaySnapshot }
  // Awaiting a switch and the response still carries the OLD
  // version (e.g. the chapter-0 cache): ignored wholesale — no
  // pin, no snapshot, no state change.
  | { kind: "ignore" }
  // A different version than the settled pin arrived outside a
  // switch: the display stays; only the stale banner is raised.
  | { kind: "stale" }
  // No usable response (nothing yet, or forbidden): the current
  // display — snapshot and selection draft included — is kept.
  | { kind: "skip" };

// Display-snapshot admission (CMP-READ-001 + P1 switch fix). Pure
// and exported so validate-reader-switch.mjs can drive the REAL
// decision through the cached-response-first / new-response-first
// orderings.
export function admitChapterResponse(
  state: ReaderVersionState,
  requestedIdx: number,
  generation: number,
  data: ChapterResponseData | undefined,
): ChapterAdmission {
  if (!data || data.forbidden) return { kind: "skip" };
  if (state.awaitingNewVersion) {
    // The switch completes only on the first response whose
    // version DIFFERS from the pre-switch pin. An old-version
    // response here is a cache echo of the version being left:
    // admitting it would re-pin the old version and make the
    // real new-version response look stale — the switch would
    // fail. Ignore it entirely.
    if (data.liveVersion === (state.switchFromVersion ?? null)) {
      return { kind: "ignore" };
    }
    return {
      kind: "admit",
      pinned: data.liveVersion,
      snapshot: {
        idx: requestedIdx,
        found: data.found,
        title: data.title,
        html: data.html,
        toc: data.toc,
        liveVersion: data.liveVersion,
        versionLabel: data.versionLabel,
        generation,
      },
    };
  }
  if (
    state.pinned === undefined ||
    data.liveVersion === (state.pinned ?? null)
  ) {
    return {
      kind: "admit",
      pinned: data.liveVersion,
      snapshot: {
        idx: requestedIdx,
        found: data.found,
        title: data.title,
        html: data.html,
        toc: data.toc,
        liveVersion: data.liveVersion,
        versionLabel: data.versionLabel,
        generation,
      },
    };
  }
  return { kind: "stale" };
}

// Position-restore decision (CMP-READ-001 P1): the start/book
// offsets describe the INITIAL generation only. After an explicit
// switch (generation > 0) the new version is read from the
// beginning — the restore target is always the top (0), whatever
// the old startOffset or the book's saved offset say.
export function restoreTargetOffset(args: {
  generation: number;
  snapshotIdx: number;
  startChapter?: number;
  startOffset?: number | null;
  bookChapter: number;
  bookOffset: number;
}): number {
  if (args.generation > 0) return 0;
  if (args.startChapter === args.snapshotIdx && args.startOffset != null) {
    return args.startOffset;
  }
  if (args.snapshotIdx === args.bookChapter) return args.bookOffset;
  return 0;
}

// Capture a selection AGAINST the display snapshot (CMP-READ-001
// P1): idx / title / live version are frozen from the snapshot on
// screen at capture time. No snapshot (or a chapter with no stored
// body) means no capture.
export function captureSelectionBinding(
  snapshot: DisplaySnapshot | null,
  text: string,
  charOffset: number,
): SelectionInfo | null {
  if (!snapshot || !snapshot.found) return null;
  return {
    text,
    charOffset,
    chapterIdx: snapshot.idx,
    chapterLabel: snapshot.title,
    liveVersion: snapshot.liveVersion,
  };
}

// The createSnippet payload for a held selection: built ONLY from
// the capture-time binding — never from the currently requested
// chapter or any later ref value.
export function snippetSavePayload(
  bookId: number,
  requestId: string,
  sel: SelectionInfo,
): {
  requestId: string;
  bookId: number;
  text: string;
  chapterIdx: number;
  chapterLabel: string | null;
  charOffset: number;
  liveVersion: string | null;
} {
  return {
    requestId,
    bookId,
    text: sel.text,
    chapterIdx: sel.chapterIdx,
    chapterLabel: sel.chapterLabel,
    charOffset: sel.charOffset,
    liveVersion: sel.liveVersion,
  };
}

// Writes (position saves, snippet saves) are allowed only under a
// settled pin with no switch in flight: during an explicit switch
// the pin is unset AND awaitingNewVersion is set, and either one
// alone blocks the write.
export function readerWritesBlocked(state: {
  pinned: string | null | undefined;
  awaitingNewVersion: boolean;
}): boolean {
  return state.pinned === undefined || state.awaitingNewVersion;
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
  const [versionStale, setVersionStale] = useState(false);
  const [snapshot, setSnapshot] = useState<DisplaySnapshot | null>(null);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const snippetKeyRef = useRef<string>(newRequestId());
  // Restore bookkeeping, keyed by `${generation}:${idx}` of the
  // DISPLAYED snapshot: a chapter is restored once per generation,
  // and a switch (new generation) restores afresh — at the top.
  const restoredFor = useRef<string>("");
  // The live version this reader session is actually reading. All
  // writes (position, snippets) carry it; the server refuses them
  // once the book's live version moves, so an old reader can never
  // stamp its selections with a new edition's provenance or
  // overwrite the new version's position.
  const pinnedVersionRef = useRef<string | null | undefined>(undefined);
  // Explicit-switch state (CMP-READ-001 P1): while a switch is in
  // flight, `awaitingRef` is set and `switchFromRef` holds the
  // version pinned before it, so a cached old-version response can
  // be told apart from the new version's first response. The
  // generation counts switches; snapshots carry it and restore
  // keys on it. snapshotRef mirrors the displayed snapshot for
  // scroll saves, which must name the DISPLAYED chapter, never
  // the requested one.
  const switchFromRef = useRef<string | null | undefined>(undefined);
  const awaitingRef = useRef(false);
  const generationRef = useRef(0);
  const snapshotRef = useRef<DisplaySnapshot | null>(null);
  const [switching, setSwitching] = useState(false);

  const chapter = useQuery({
    queryKey: ["chapter", book.id, chapterIdx],
    queryFn: () => api.getChapter({ bookId: book.id, idx: chapterIdx }),
  });

  // Display-snapshot admission: every chapter response is decided
  // by admitChapterResponse against the pin/switch state. Admitted
  // data (first load, same-version move, or the first
  // different-version response of an explicit switch) replaces the
  // snapshot as one unit; an old-version cache echo during a
  // switch is ignored wholesale; a different version outside a
  // switch only raises the stale banner — the displayed body/TOC/
  // label (and any selection made on them) stay exactly as they
  // were, never silently relabeled or mixed.
  useEffect(() => {
    const res = admitChapterResponse(
      {
        pinned: pinnedVersionRef.current,
        awaitingNewVersion: awaitingRef.current,
        switchFromVersion: switchFromRef.current,
      },
      chapterIdx,
      generationRef.current,
      chapter.data,
    );
    if (res.kind === "admit") {
      pinnedVersionRef.current = res.pinned;
      snapshotRef.current = res.snapshot;
      if (awaitingRef.current) {
        awaitingRef.current = false;
        setSwitching(false);
      }
      setSnapshot(res.snapshot);
    } else if (res.kind === "stale") {
      setVersionStale(true);
    }
    // "ignore" / "skip": display, pin and selection stay untouched.
  }, [chapter.data, chapterIdx]);

  // "检查新版本" checks VERSION METADATA ONLY (getBookLiveVersion
  // reads one books row) — it never refetches body text. A version
  // different from the pin raises the switch banner; the same
  // version just confirms we're current.
  const checkVersion = useMutation({
    mutationFn: () => api.getBookLiveVersion({ bookId: book.id }),
    onSuccess: (res) => {
      if (res.forbidden || !res.found) {
        setCheckMsg("暂时无法确认版本，请稍后再试。");
        return;
      }
      if (
        pinnedVersionRef.current === undefined ||
        res.liveVersion === pinnedVersionRef.current
      ) {
        setCheckMsg("已是最新版本。");
      } else {
        setCheckMsg(null);
        setVersionStale(true);
      }
    },
    onError: () => setCheckMsg("暂时无法确认版本，请稍后再试。"),
  });

  const safeHtml = useMemo(
    () => (snapshot?.found ? sanitizeChapterHtml(snapshot.html) : ""),
    [snapshot],
  );

  const savePosition = useMutation({
    mutationFn: (args: { chapterIdx: number; charOffset: number }) =>
      api.savePosition({
        bookId: book.id,
        ...args,
        liveVersion: pinnedVersionRef.current ?? null,
      }),
    onSuccess: (res) => {
      if (!res.ok && res.status === "conflict") setVersionStale(true);
    },
  });

  // Restore the saved position once per displayed chapter PER
  // GENERATION (the snapshot is the authority on what's on
  // screen). The target comes from restoreTargetOffset: the
  // initial generation honors the start/book offsets; any
  // post-switch generation restores to the top.
  useEffect(() => {
    if (!snapshot?.found || !safeHtml) return;
    const key = `${snapshot.generation}:${snapshot.idx}`;
    if (restoredFor.current === key) return;
    restoredFor.current = key;
    const root = contentRef.current;
    if (!root) return;
    const target = restoreTargetOffset({
      generation: snapshot.generation,
      snapshotIdx: snapshot.idx,
      startChapter,
      startOffset,
      bookChapter: book.curChapter,
      bookOffset: book.curOffset,
    });
    if (target > 0) {
      const t = window.setTimeout(() => scrollToOffset(root, target), 60);
      return () => window.clearTimeout(t);
    }
    window.scrollTo({ top: 0 });
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, safeHtml]);

  // Persist position as the owner scrolls (debounced). The saved
  // chapter is the DISPLAYED snapshot's idx (read through its ref
  // mirror), never the requested chapterIdx: while a chapter
  // request is still in flight the screen still shows the old
  // chapter, and its scroll position belongs to that chapter.
  useEffect(() => {
    let timer: number | undefined;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const root = contentRef.current;
        if (!root) return;
        // No settled pin, no write: during the explicit version
        // switch the pin is unset and awaiting is set until the
        // new version's first chapter lands — writes are allowed
        // only under a settled pin outside a switch.
        if (
          readerWritesBlocked({
            pinned: pinnedVersionRef.current,
            awaitingNewVersion: awaitingRef.current,
          })
        ) {
          return;
        }
        const snap = snapshotRef.current;
        if (!snap) return;
        savePosition.mutate({
          chapterIdx: snap.idx,
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
  }, [book.id]);

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
    // Bind the selection to the DISPLAY snapshot it was made on
    // (idx / title / pinned version frozen now). Without a display
    // snapshot there is nothing truthful to bind to — no capture.
    const bound = captureSelectionBinding(
      snapshotRef.current,
      text,
      pre.toString().length,
    );
    if (!bound) {
      setSelection(null);
      return;
    }
    setSelection(bound);
    setSnippetMsg(null);
  };

  const saveSnippet = useMutation({
    // The payload comes ONLY from the capture-time binding
    // (snippetSavePayload): the chapter the text was selected in,
    // even if a later chapter was requested or has since landed.
    mutationFn: (sel: SelectionInfo) =>
      api.createSnippet(snippetSavePayload(book.id, snippetKeyRef.current, sel)),
    onSuccess: (res) => {
      if (!res.ok && res.status === "conflict") {
        // The live version moved under this reader: the selection
        // stays on screen (never silently re-stamped), and the
        // banner offers the explicit switch to the new version.
        setVersionStale(true);
        setSnippetMsg("书籍已有新版本，这段选文属于旧版本，未保存。你可以先复制留底，再切换新版。");
        return;
      }
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

  const toc = snapshot?.toc ?? [];
  // Title and chapter counter describe the DISPLAYED snapshot,
  // not the requested chapter: while a chapter request is in
  // flight the screen still shows the snapshot's chapter.
  const chapterTitle =
    snapshot?.title ??
    toc.find((t) => t.idx === snapshot?.idx)?.title ??
    "";

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
          <button
            type="button"
            disabled={checkVersion.isPending}
            onClick={() => {
              setCheckMsg(null);
              checkVersion.mutate();
            }}
            aria-label="检查新版本"
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-40"
          >
            检查新版本
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
        {checkMsg && (
          <p
            role="status"
            className="mx-auto max-w-2xl border-t border-[var(--border)] px-4 py-1.5 text-xs text-[var(--dim)]"
          >
            {checkMsg}
          </p>
        )}
        {showToc && (
          <nav aria-label="章节目录" className="max-h-64 overflow-y-auto border-t border-[var(--border)]">
            <ul className="mx-auto max-w-2xl px-4 py-2">
              {toc.map((t) => (
                <li key={t.idx}>
                  <button
                    type="button"
                    disabled={versionStale}
                    onClick={() => {
                      // While stale, chapter jumps are refused
                      // outright: a new-version chapter must never
                      // be spliced onto the pinned old token.
                      if (versionStale) return;
                      setChapterIdx(t.idx);
                      restoredFor.current = "";
                      setShowToc(false);
                    }}
                    aria-current={t.idx === chapterIdx ? "true" : undefined}
                    className={`block w-full truncate py-2 text-left text-sm disabled:opacity-40 ${
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
        {versionStale && (
          <div role="alert" className="mb-4 rounded-xl border border-[var(--accent)] px-4 py-3">
            <p className="text-sm font-medium">书籍已有新版本</p>
            <p className="mt-1 text-sm text-[var(--dim)]">
              你正在读的是旧版本正文；已经保存的片段和批注仍按旧版本出处保留，不会被改成新版本。
              旧版本的选文和阅读位置不会写入新版本。旧版后续章节已不可用，可保留当前选文后切换新版。
            </p>
            <button
              type="button"
              onClick={() => {
                // The explicit switch: ONE wholesale move into a
                // verifiable awaiting state — the pre-switch pin is
                // recorded (switchFromVersion) so cached
                // old-version responses can be recognized and
                // ignored, the pin is unset, the generation
                // advances (old start/book offsets no longer
                // restore), the target resets to chapter 0 and the
                // new version's chapter 0 is fetched fresh. The
                // current display stays on screen until the new
                // version's first response is admitted; writes stay
                // blocked until then (pin unset + awaiting set).
                switchFromRef.current = pinnedVersionRef.current;
                awaitingRef.current = true;
                setSwitching(true);
                pinnedVersionRef.current = undefined;
                generationRef.current += 1;
                setVersionStale(false);
                setSelection(null);
                setChapterIdx(0);
                restoredFor.current = "";
                void queryClient.invalidateQueries({ queryKey: ["chapter", book.id] });
                void queryClient.invalidateQueries({ queryKey: ["library"] });
              }}
              className="mt-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
            >
              切换新版，从头阅读
            </button>
          </div>
        )}
        <p className="text-xs text-[var(--dim)]">
          《{book.title}》
          {snapshot?.versionLabel ? ` · ${snapshot.versionLabel}` : ""}
        </p>
        <h2 className="font-serif-book mt-1 text-xl font-semibold">{chapterTitle}</h2>
        {switching && (
          <p role="status" className="mt-3 text-sm text-[var(--dim)]">
            正在加载新版本…上方仍是切换前显示的内容，加载完成前不会保存阅读位置或片段。
          </p>
        )}
        {!switching && chapter.isError && snapshot && (
          <p role="status" className="mt-3 text-sm text-[var(--dim)]">
            这一章加载失败，仍显示之前的内容；可从目录重新选择章节重试。
          </p>
        )}
        {chapter.isPending && !snapshot && (
          <p className="mt-6 text-sm text-[var(--dim)]">加载章节中…</p>
        )}
        {snapshot && !snapshot.found && (
          <p className="mt-6 text-sm text-[var(--dim)]">这一章没有存入正文。</p>
        )}
        {snapshot?.found && (
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
            disabled={versionStale || chapterIdx <= 0}
            onClick={() => {
              if (versionStale) return;
              setChapterIdx(chapterIdx - 1);
              restoredFor.current = "";
            }}
            className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-40"
          >
            ← 上一章
          </button>
          <span className="text-xs text-[var(--dim)]">
            第 {(snapshot?.idx ?? chapterIdx) + 1} / {toc.length || "—"} 章
          </span>
          <button
            type="button"
            disabled={versionStale || toc.length === 0 || chapterIdx >= toc.length - 1}
            onClick={() => {
              if (versionStale) return;
              setChapterIdx(chapterIdx + 1);
              restoredFor.current = "";
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
            <p className="mt-1 text-xs text-[var(--dim)]">
              出处：第 {selection.chapterIdx + 1} 章
              {selection.chapterLabel ? ` · ${selection.chapterLabel}` : ""}
              （按选文时显示的章节保存）
            </p>
            {switching && (
              <p role="status" className="mt-1 text-xs text-[var(--dim)]">
                正在切换新版本，切换完成前不能保存；选文会保留在这里。
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={saveSnippet.isPending || switching}
                onClick={() => {
                  // Belt and braces with the disabled state: a
                  // snippet save never fires while a switch is in
                  // flight (pin unset + awaiting set).
                  if (
                    readerWritesBlocked({
                      pinned: pinnedVersionRef.current,
                      awaitingNewVersion: awaitingRef.current,
                    })
                  ) {
                    return;
                  }
                  saveSnippet.mutate(selection);
                }}
                className="flex-1 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
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
