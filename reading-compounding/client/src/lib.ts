import type { ApiResponse } from "./api";
import type { api } from "./api";

export type Library = ApiResponse<typeof api, "getLibrary">;
export type Dashboard = ApiResponse<typeof api, "getDashboard">;
export type Book = Library["books"][number];
export type Session = Library["sessions"][number];
export type Snippet = Library["snippets"][number];
export type Card = Library["cards"][number];
export type Reuse = Library["reuses"][number];

// One requestId per save intent. A form keeps its key while it is open,
// so a double-tap or a retried request replays instead of duplicating;
// the key rotates only after a successful save (a genuinely new save).
export function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const BOOK_STATUS_LABEL: Record<Book["status"], string> = {
  want: "○ 想读",
  reading: "● 在读",
  done: "✓ 读完",
};

export const BOOK_SOURCE_LABEL: Record<Book["source"], string> = {
  owner: "自选",
  claude: "Muse 推荐",
};

export const IMPORT_STATUS_LABEL: Record<Book["importStatus"], string> = {
  none: "未导入",
  pending: "待导入",
  processing: "处理中…",
  failed: "导入失败",
  ready: "✓ 可读",
};

export const SNIPPET_SOURCE_LABEL: Record<Snippet["source"], string> = {
  reader: "阅读器划线",
  paste: "粘贴",
  ocr: "截图 OCR",
  chat: "聊天沉淀",
};

// Snippet ↔ book live-version tri-state (CMP-READ-001), shared by
// the snippets list and Home's 片刻回味 so both surfaces judge the
// SAME snippet identically: the two versions are comparable ONLY
// when both sides recorded a live-version token — equal is "same",
// different is "replaced", and a missing token on either side is
// "unknown" (never guessed, never backfilled).
export function snippetVersionState(
  snippet: { liveGen: string | null },
  book: { liveGen: string | null },
): "same" | "replaced" | "unknown" {
  if (snippet.liveGen != null && book.liveGen != null) {
    return snippet.liveGen === book.liveGen ? "same" : "replaced";
  }
  return "unknown";
}

export function sourceLabelOf(s: Snippet): string {
  const parts = [`《${s.bookTitle}》`];
  if (s.versionLabel) parts.push(s.versionLabel);
  parts.push(s.chapterLabel ?? "章节不详");
  return parts.join(" · ");
}

export function fmtMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

export function statusMessage(status: string): string | null {
  switch (status) {
    case "conflict":
      return "内容有冲突：这条记录已被更新，你的输入还保留在表单里，没有被覆盖。";
    case "deleted":
      return "这条记录已被删除，无法再保存到它上面。";
    case "notFound":
      return "找不到这条记录（可能已被删除）。";
    case "refused":
      return "当前身份无权写入（仅所有者可用）。";
    default:
      return null;
  }
}
