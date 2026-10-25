import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fileToBase64 } from "@hatch/space-sdk/client";
import { api } from "./api";
import { parseEpub } from "./epub";
import {
BOOK_SOURCE_LABEL,
BOOK_STATUS_LABEL,
IMPORT_STATUS_LABEL,
fmtMinutes,
newRequestId,
statusMessage,
type Book,
type Library,
} from "./lib";

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[15px]";
const labelCls = "block text-sm font-medium mb-1";

function BookCard({
  book,
  onOpenReader,
  onImportFile,
  importing,
}: {
  book: Book;
  onOpenReader: (book: Book) => void;
  onImportFile: (book: Book) => void;
  importing: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");
  const [status, setStatus] = useState<Book["status"]>(book.status);
  const [note, setNote] = useState(book.note ?? "");
  const [progressValue, setProgressValue] = useState(
    book.progressValue != null ? String(book.progressValue) : "",
  );
  const [progressUnit, setProgressUnit] = useState<"page" | "chapter">(
    book.progressUnit ?? "page",
  );
  const [msg, setMsg] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["library"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  // Live-copy readability is separate from import-task state
  // (CMP-READ-IMPORT-001 live-copy slice): a complete saved copy
  // (live chapters present) stays readable while a newer import is
  // processing or after it failed — the import status alone never
  // gates the read entry.
  const hasLiveCopy = book.chapterCount > 0;
  const importInProgress = book.importStatus === "processing";
  const importFailed = book.importStatus === "failed";

  const save = useMutation({
    mutationFn: () =>
      api.updateBook({
        id: book.id,
        version: book.version,
        title: title.trim(),
        author: author.trim() || null,
        status,
        note: note.trim() || null,
        progressValue: progressValue.trim() === "" ? null : Number(progressValue),
        progressUnit: progressValue.trim() === "" ? null : progressUnit,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setEditing(false);
        setMsg(null);
        invalidate();
      } else {
        setMsg(statusMessage(res.status) ?? "保存失败，输入还在。");
      }
    },
    onError: () => setMsg("保存失败，输入还在。"),
  });

  const del = useMutation({
    mutationFn: () => api.deleteBook({ id: book.id }),
    onSuccess: (res) => {
      if (res.ok) invalidate();
      else setMsg(statusMessage(res.status) ?? "删除失败。");
    },
  });

  return (
    <article className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-serif-book text-lg font-semibold leading-snug">
            《{book.title}》
          </h3>
          <p className="mt-0.5 text-sm text-[var(--dim)]">
            {book.author ? `${book.author} · ` : ""}
            {BOOK_SOURCE_LABEL[book.source]}
            {book.versionLabel ? ` · ${book.versionLabel}` : ""}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs">
          {BOOK_STATUS_LABEL[book.status]}
        </span>
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--dim)]">
        {hasLiveCopy ? (
          <span>
            已保存版本：共 {book.chapterCount} 章
            {book.versionLabel ? ` · ${book.versionLabel}` : ""}
          </span>
        ) : (
          <span>导入状态：{IMPORT_STATUS_LABEL[book.importStatus]}</span>
        )}
        {book.progressValue != null && (
          <span>
            进度：读到第 {book.progressValue} {book.progressUnit === "chapter" ? "章" : "页"}
          </span>
        )}
        {hasLiveCopy && (
          <span>
            上次读到：第 {book.curChapter + 1} 章
          </span>
        )}
      </p>
      {hasLiveCopy && importInProgress && (
        <p className="mt-1 text-xs text-[var(--dim)]">
          新版本正在导入
          {book.pendingVersionLabel ? `：${book.pendingVersionLabel}` : ""}
          ，导入完成前仍读已保存版本。
        </p>
      )}
      {hasLiveCopy && importFailed && (
        <p className="mt-1 text-xs text-[var(--dim)]">
          新版本未替换成功，旧版本仍可用
          {book.pendingVersionLabel ? `（未导入：${book.pendingVersionLabel}）` : ""}。
        </p>
      )}
      {importFailed && book.importError && (
        <p className="mt-1 text-xs text-[var(--accent2)]">失败原因：{book.importError}</p>
      )}
      {book.note && <p className="mt-2 text-sm leading-relaxed">{book.note}</p>}

      {editing ? (
        <div className="mt-3 space-y-3 border-t border-[var(--border)] pt-3">
          <div>
            <label htmlFor={`bt-${book.id}`} className={labelCls}>书名</label>
            <input id={`bt-${book.id}`} value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor={`ba-${book.id}`} className={labelCls}>作者（可空）</label>
            <input id={`ba-${book.id}`} value={author} onChange={(e) => setAuthor(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor={`bs-${book.id}`} className={labelCls}>状态</label>
            <select
              id={`bs-${book.id}`}
              value={status}
              onChange={(e) => setStatus(e.target.value as Book["status"])}
              className={inputCls}
            >
              <option value="want">○ 想读</option>
              <option value="reading">● 在读</option>
              <option value="done">✓ 读完</option>
            </select>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label htmlFor={`bp-${book.id}`} className={labelCls}>进度（可空，不填百分比）</label>
              <input
                id={`bp-${book.id}`}
                inputMode="numeric"
                value={progressValue}
                onChange={(e) => setProgressValue(e.target.value)}
                placeholder="如 128"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor={`bu-${book.id}`} className={labelCls}>单位</label>
              <select
                id={`bu-${book.id}`}
                value={progressUnit}
                onChange={(e) => setProgressUnit(e.target.value as "page" | "chapter")}
                className={inputCls}
              >
                <option value="page">页</option>
                <option value="chapter">章</option>
              </select>
            </div>
          </div>
          <div>
            <label htmlFor={`bn-${book.id}`} className={labelCls}>备注（可空）</label>
            <textarea id={`bn-${book.id}`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={inputCls} />
          </div>
          {msg && <p role="status" className="text-sm text-[var(--accent2)]">{msg}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={save.isPending || !title.trim()}
              onClick={() => save.mutate()}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {save.isPending ? "保存中…" : "保存"}
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
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {hasLiveCopy && (
            <button
              type="button"
              onClick={() => onOpenReader(book)}
              className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white"
            >
              {importInProgress || importFailed ? "继续阅读已保存版本" : "打开阅读"}
            </button>
          )}
          {!importInProgress &&
            (hasLiveCopy
              ? importFailed || book.importStatus === "ready"
              : book.importStatus === "pending" ||
                book.importStatus === "failed" ||
                book.importStatus === "none") && (
              <button
                type="button"
                disabled={importing}
                onClick={() => onImportFile(book)}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50"
              >
                {hasLiveCopy
                  ? importFailed
                    ? "重试新版本"
                    : "导入新版本"
                  : importFailed
                    ? "重试导入"
                    : "导入 EPUB"}
              </button>
            )}
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
          >
            编辑
          </button>
          {confirmDelete ? (
            <button
              type="button"
              disabled={del.isPending}
              onClick={() => del.mutate()}
              className="rounded-lg bg-[var(--accent2)] px-3 py-2 text-sm font-medium text-white"
            >
              确认删除这本书？
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--dim)]"
            >
              删除
            </button>
          )}
        </div>
      )}
      {!editing && msg && (
        <p role="status" className="mt-2 text-sm text-[var(--accent2)]">{msg}</p>
      )}
    </article>
  );
}

export function Books({
  library,
  onOpenReader,
}: {
  library: Library;
  onOpenReader: (book: Book) => void;
}) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const importTargetRef = useRef<Book | null>(null);
  const addKeyRef = useRef<string>(newRequestId());
  const logKeyRef = useRef<string>(newRequestId());

  const [importPhase, setImportPhase] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  // Presentation only (LIFE-DESIGN-001-B2A): the import area and the
  // reading-log area start collapsed on every open — fold state is
  // never persisted.
  const [showImport, setShowImport] = useState(false);
  const [showLog, setShowLog] = useState(false);

  // Add-book form
  const [showAdd, setShowAdd] = useState(false);
  const [aTitle, setATitle] = useState("");
  const [aAuthor, setAAuthor] = useState("");
  const [aSource, setASource] = useState<"owner" | "claude">("owner");
  const [aStatus, setAStatus] = useState<Book["status"]>("want");
  const [aImport, setAImport] = useState<"none" | "pending">("none");
  const [aNote, setANote] = useState("");
  const [addMsg, setAddMsg] = useState<string | null>(null);

  // Reading log form
  const [lBookId, setLBookId] = useState<string>("");
  const [lDate, setLDate] = useState(library.today);
  const [lMinutes, setLMinutes] = useState("");
  const [lProgress, setLProgress] = useState("");
  const [lUnit, setLUnit] = useState<"page" | "chapter">("page");
  const [lNote, setLNote] = useState("");
  const [logMsg, setLogMsg] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["library"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const addBook = useMutation({
    mutationFn: () =>
      api.addBook({
        requestId: addKeyRef.current,
        title: aTitle.trim(),
        author: aAuthor.trim() || undefined,
        source: aSource,
        status: aStatus,
        note: aNote.trim() || undefined,
        importStatus: aImport,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        addKeyRef.current = newRequestId();
        setATitle("");
        setAAuthor("");
        setANote("");
        setShowAdd(false);
        setAddMsg(null);
        invalidate();
      } else {
        setAddMsg(statusMessage(res.status) ?? "保存失败，输入还在。");
      }
    },
    onError: () => setAddMsg("保存失败，输入还在。"),
  });

  const logReading = useMutation({
    mutationFn: () =>
      api.logReading({
        requestId: logKeyRef.current,
        bookId: lBookId ? Number(lBookId) : null,
        date: lDate || undefined,
        minutes: lMinutes.trim() === "" ? null : Number(lMinutes),
        progressValue: lProgress.trim() === "" ? null : Number(lProgress),
        progressUnit: lProgress.trim() === "" ? null : lUnit,
        note: lNote.trim() || undefined,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        logKeyRef.current = newRequestId();
        setLMinutes("");
        setLProgress("");
        setLNote("");
        setLogMsg("✓ 已记下这次阅读");
        invalidate();
      } else {
        setLogMsg(statusMessage(res.status) ?? "保存失败，输入还在。");
      }
    },
    onError: () => setLogMsg("保存失败，输入还在。"),
  });

  const deleteSession = useMutation({
    mutationFn: (id: number) => api.deleteReadingSession({ id }),
    onSuccess: () => invalidate(),
  });

  // --- EPUB import -------------------------------------------------
  const pickFileFor = (book: Book | null) => {
    importTargetRef.current = book;
    fileRef.current?.click();
  };

  const runImport = async (file: File) => {
    const target = importTargetRef.current;
    setImportError(null);
    setImportNote(null);
    // One import attempt = one generation key (CMP-READ-IMPORT-001).
    // Every write of this attempt — begin, file upload, chapter
    // chunks, finish — carries this key, so retrying any step under
    // the same key replays safely against the ledger, and a later
    // attempt (a new key) can never be disturbed by this attempt's
    // late arrivals. A re-import therefore always mints a fresh key,
    // for existing books too.
    const importRequestId = newRequestId();
    let begunBookId: number | null = null;
    // A complete saved copy exists: a successful import switches
    // the book to the new version wholesale, and a failed one must
    // be recorded as failed (the server keeps the saved copy fully
    // readable — body, file, label, position — either way).
    const targetHadLiveCopy = target != null && target.chapterCount > 0;
    try {
      setImportPhase("正在本机解析 EPUB…");
      const parsed = await parseEpub(file);
      const versionLabel = file.name;
      const begun = await api.beginImport({
        requestId: importRequestId,
        title: target?.title ?? parsed.title,
        author: target?.author ?? parsed.author ?? undefined,
        source: target?.source ?? "owner",
        versionLabel,
        existingBookId: target?.id ?? null,
      });
      if (!begun.ok || begun.id == null) {
        throw new Error(statusMessage(begun.status) ?? "无法开始导入");
      }
      const bookId = begun.id;
      begunBookId = bookId;
      try {
        setImportPhase("正在保存原文件…");
        const { dataBase64 } = await fileToBase64(file);
        const uploaded = await api.uploadImportFile({
          bookId,
          importId: importRequestId,
          dataBase64,
        });
        if (!uploaded.ok) throw new Error("upload refused");
      } catch {
        // The original file could not be stored; chapters still save.
        // The failure is surfaced, not hidden.
        setImportError("原文件保存失败，但正文仍会继续导入。");
      }
      const chunkSize = 4;
      for (let i = 0; i < parsed.chapters.length; i += chunkSize) {
        setImportPhase(
          `正在保存章节 ${Math.min(i + chunkSize, parsed.chapters.length)} / ${parsed.chapters.length}…`,
        );
        const chunk = parsed.chapters.slice(i, i + chunkSize).map((c, j) => ({
          idx: i + j,
          title: c.title,
          html: c.html,
        }));
        const saved = await api.saveImportChapters({
          bookId,
          importId: importRequestId,
          chapters: chunk,
        });
        if (!saved.ok) throw new Error("章节保存失败");
      }
      const finished = await api.finishImport({
        bookId,
        importId: importRequestId,
        ok: true,
        chapterCount: parsed.chapters.length,
      });
      if (!finished.ok) throw new Error("导入收尾失败");
      setImportPhase(null);
      if (targetHadLiveCopy) {
        // Promotion switched body, contents, file and version label
        // to the new version in one step. The saved reading
        // position belonged to the old version's chapters and does
        // not carry over — say so plainly instead of implying it
        // migrated.
        setImportNote(
          `《${target?.title ?? parsed.title}》已切换到新版本「${file.name}」，将从头开始阅读。`,
        );
      }
      invalidate();
    } catch (e) {
      const message = e instanceof Error ? e.message : "导入失败";
      // Record the failure against the generation this attempt began
      // (bound by its key, so it can never disturb a newer import).
      // This runs even when the book already has a readable copy:
      // the server's failure finish moves only the import status —
      // the saved copy's chapters, file, version label and reading
      // position stay exactly as they were, and the book card keeps
      // offering 继续阅读已保存版本 alongside 重试新版本.
      if (begunBookId != null) {
        try {
          const { dataBase64 } = await fileToBase64(file);
          await api.uploadImportFile({
            bookId: begunBookId,
            importId: importRequestId,
            dataBase64,
          });
        } catch {
          /* original file stays wherever it already was */
        }
        await api.finishImport({
          bookId: begunBookId,
          importId: importRequestId,
          ok: false,
          error: message,
        });
        invalidate();
      }
      setImportPhase(null);
      setImportError(message);
    }
  };

  const groups: Array<{ status: Book["status"]; label: string }> = [
    { status: "reading", label: "● 在读" },
    { status: "want", label: "○ 想读" },
    { status: "done", label: "✓ 读完" },
  ];
  const sessions = [...library.sessions].reverse().slice(0, 20);
  const sessionTotal = library.sessions.length;
  const latestSessionDate =
    library.sessions.length > 0
      ? library.sessions.reduce((m, s) => (s.date > m ? s.date : m), "")
      : null;
  const bookTitle = (id: number | null) =>
    id != null ? (library.books.find((b) => b.id === id)?.title ?? null) : null;

  return (
    <div className="space-y-8">
      <input
        ref={fileRef}
        type="file"
        accept=".epub,application/epub+zip"
        aria-label="选择 EPUB 文件"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void runImport(f);
        }}
      />

      <section aria-label="导入新书">
        <button
          type="button"
          aria-expanded={showImport}
          onClick={() => setShowImport((v) => !v)}
          className="rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white"
        >
          {showImport ? "▲ 收起导入" : "＋ 导入新书"}
        </button>
        {importPhase && (
          <p role="status" className="mt-2 text-sm text-[var(--accent)]">
            {importPhase}
          </p>
        )}
        {importError && (
          <p role="alert" className="mt-2 text-sm text-[var(--accent2)]">
            导入失败：{importError}。原文件与原阅读位置都保留着，可以重试。
          </p>
        )}
        {importNote && (
          <p role="status" className="mt-2 text-sm text-[var(--accent)]">
            {importNote}
          </p>
        )}
        {showImport && (
          <>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={importPhase != null}
            onClick={() => pickFileFor(null)}
            className="rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            导入 EPUB 新书
          </button>
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            aria-expanded={showAdd}
            className="rounded-lg border border-[var(--border)] px-4 py-2.5 text-sm"
          >
            {showAdd ? "收起" : "＋ 只加书名（微信读书书架等）"}
          </button>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
          EPUB 在这台设备上解析，正文只存入本应用的私有存储，不会上传到任何外部服务。
          只加书名的条目仅入书单，不代表已读或已导入全文。
        </p>
        {showAdd && (
          <div className="mt-3 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div>
              <label htmlFor="add-title" className={labelCls}>书名</label>
              <input id="add-title" value={aTitle} onChange={(e) => setATitle(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor="add-author" className={labelCls}>作者（可空）</label>
              <input id="add-author" value={aAuthor} onChange={(e) => setAAuthor(e.target.value)} className={inputCls} />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label htmlFor="add-source" className={labelCls}>来源</label>
                <select id="add-source" value={aSource} onChange={(e) => setASource(e.target.value as "owner" | "claude")} className={inputCls}>
                  <option value="owner">自选</option>
                  <option value="claude">Muse 推荐</option>
                </select>
              </div>
              <div className="flex-1">
                <label htmlFor="add-status" className={labelCls}>状态</label>
                <select id="add-status" value={aStatus} onChange={(e) => setAStatus(e.target.value as Book["status"])} className={inputCls}>
                  <option value="want">○ 想读</option>
                  <option value="reading">● 在读</option>
                  <option value="done">✓ 读完</option>
                </select>
              </div>
              <div className="flex-1">
                <label htmlFor="add-import" className={labelCls}>全文</label>
                <select id="add-import" value={aImport} onChange={(e) => setAImport(e.target.value as "none" | "pending")} className={inputCls}>
                  <option value="none">仅书单</option>
                  <option value="pending">待导入 EPUB</option>
                </select>
              </div>
            </div>
            <div>
              <label htmlFor="add-note" className={labelCls}>备注（可空）</label>
              <textarea id="add-note" value={aNote} onChange={(e) => setANote(e.target.value)} rows={2} className={inputCls} />
            </div>
            {addMsg && <p role="status" className="text-sm text-[var(--accent2)]">{addMsg}</p>}
            <button
              type="button"
              disabled={addBook.isPending || !aTitle.trim()}
              onClick={() => addBook.mutate()}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {addBook.isPending ? "保存中…" : "加入书单"}
            </button>
          </div>
        )}
          </>
        )}
      </section>

      {groups.map((g) => {
        const books = library.books.filter((b) => b.status === g.status);
        if (books.length === 0) return null;
        return (
          <section key={g.status} aria-label={g.label}>
            <h2 className="text-xs font-medium tracking-wide text-[var(--dim)]">{g.label}</h2>
            <div className="mt-2 space-y-3">
              {books.map((b) => (
                <BookCard
                  key={b.id}
                  book={b}
                  onOpenReader={onOpenReader}
                  onImportFile={(book) => pickFileFor(book)}
                  importing={importPhase != null}
                />
              ))}
            </div>
          </section>
        );
      })}
      {library.books.length === 0 && (
        <p className="text-sm text-[var(--dim)]">书单是空的。</p>
      )}

      <section aria-label="阅读记录" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <button
          type="button"
          aria-expanded={showLog}
          onClick={() => setShowLog((v) => !v)}
          className="flex w-full items-center justify-between gap-2 text-left"
        >
          <span className="text-base font-semibold">阅读记录</span>
          <span className="text-xs text-[var(--dim)]">
            {sessionTotal > 0
              ? `最近一次 ${latestSessionDate} · 共 ${sessionTotal} 条 · ${showLog ? "▲ 收起" : "▼ 展开"}`
              : `共 0 条 · ${showLog ? "▲ 收起" : "▼ 展开"}`}
          </span>
        </button>
        {showLog && (
          <>
        <h3 className="mt-4 text-sm font-semibold">记一次阅读</h3>
        <p className="mt-1 text-xs text-[var(--dim)]">
          只有这里记下的才算阅读日；导入、看回味都不算。
        </p>
        <div className="mt-3 space-y-3">
          <div className="flex gap-2">
            <div className="flex-1">
              <label htmlFor="log-book" className={labelCls}>书（可不选）</label>
              <select id="log-book" value={lBookId} onChange={(e) => setLBookId(e.target.value)} className={inputCls}>
                <option value="">不指定</option>
                {library.books.map((b) => (
                  <option key={b.id} value={b.id}>《{b.title}》</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="log-date" className={labelCls}>日期</label>
              <input id="log-date" type="date" value={lDate} onChange={(e) => setLDate(e.target.value)} className={inputCls} />
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label htmlFor="log-minutes" className={labelCls}>时长（分钟，可空＝未记）</label>
              <input id="log-minutes" inputMode="numeric" value={lMinutes} onChange={(e) => setLMinutes(e.target.value)} placeholder="如 30" className={inputCls} />
            </div>
            <div className="flex-1">
              <label htmlFor="log-progress" className={labelCls}>读到（可空）</label>
              <input id="log-progress" inputMode="numeric" value={lProgress} onChange={(e) => setLProgress(e.target.value)} placeholder="如 128" className={inputCls} />
            </div>
            <div>
              <label htmlFor="log-unit" className={labelCls}>单位</label>
              <select id="log-unit" value={lUnit} onChange={(e) => setLUnit(e.target.value as "page" | "chapter")} className={inputCls}>
                <option value="page">页</option>
                <option value="chapter">章</option>
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="log-note" className={labelCls}>备注（可空）</label>
            <input id="log-note" value={lNote} onChange={(e) => setLNote(e.target.value)} className={inputCls} />
          </div>
          {logMsg && <p role="status" className="text-sm text-[var(--dim)]">{logMsg}</p>}
          <button
            type="button"
            disabled={logReading.isPending}
            onClick={() => logReading.mutate()}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {logReading.isPending ? "保存中…" : "记下这次阅读"}
          </button>
        </div>
        {sessions.length > 0 && (
          <ul className="mt-4 divide-y divide-[var(--border)] border-t border-[var(--border)]">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-2 py-2 text-sm">
                <span className="tabular-nums text-[var(--dim)]">{s.date}</span>
                <span className="min-w-0 flex-1 truncate">
                  {bookTitle(s.bookId) ? `《${bookTitle(s.bookId)}》` : "未指定书"}
                  {s.progressValue != null
                    ? ` · 读到第 ${s.progressValue} ${s.progressUnit === "chapter" ? "章" : "页"}`
                    : ""}
                  {s.note ? ` · ${s.note}` : ""}
                </span>
                <span className="shrink-0 text-[var(--dim)]">
                  {s.minutes != null ? fmtMinutes(s.minutes) : "时长未记"}
                </span>
                <button
                  type="button"
                  aria-label={`删除 ${s.date} 的阅读记录`}
                  onClick={() => deleteSession.mutate(s.id)}
                  className="shrink-0 rounded px-2 py-1 text-xs text-[var(--dim)]"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
          </>
        )}
      </section>
    </div>
  );
}
