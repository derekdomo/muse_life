// Pure save-outcome decisions for the record form (CMP-FAMILY-SAVE-001).
//
// The server answers every addActivity call with a typed result
// (ok / duplicate / conflict / deleted / future / forbidden / plain
// refusal), and the transport itself can fail outright (network
// error). Which outcome arrived decides what happens to the form —
// and the rule protecting the owner's words is uniform across ALL
// branches: the live draft is compared against the exact snapshot the
// in-flight submission carried, and fields are cleared ONLY when the
// two still match. Any difference — minutes, note, date or type
// edited while the save was in flight — means the form now holds a
// NEW, still-unsaved draft, and every branch preserves it whole.
//
// This module is deliberately free of React and SDK imports so the
// validation script executes the very same decision code the form
// runs (validate-family-ledger.mjs imports it directly).

// The exact draft a submission carried. `minutes: undefined` marks an
// unparseable minutes field; it can never match a submitted snapshot
// (a submission always carries number | null).
export interface SubmittedDraft {
  date: string;
  typeName: string;
  minutes: number | null | undefined;
  note: string | null;
}

// Field-for-field equality between two drafts: date, type, minutes
// and note must ALL match for the live draft to count as "the same"
// as what was submitted.
export function draftsEqual(a: SubmittedDraft, b: SubmittedDraft): boolean {
  return (
    a.date === b.date &&
    a.typeName === b.typeName &&
    a.minutes === b.minutes &&
    a.note === b.note
  );
}

export type SaveOutcomeKind =
  | "ok"
  | "duplicate"
  | "conflict"
  | "deleted"
  | "future"
  | "forbidden"
  | "invalid"
  | "networkError";

// Map a typed addActivity result onto its outcome kind. Exactly one
// flag is ever set on a refusal, so the order here is unambiguous.
export function outcomeKindOfResult(res: {
  ok: boolean;
  duplicate: boolean;
  conflict: boolean;
  deleted: boolean;
  future: boolean;
  forbidden: boolean;
}): SaveOutcomeKind {
  if (res.ok) return res.duplicate ? "duplicate" : "ok";
  if (res.conflict) return "conflict";
  if (res.deleted) return "deleted";
  if (res.future) return "future";
  if (res.forbidden) return "forbidden";
  return "invalid";
}

export interface SaveDecision {
  // Clear the flexible fields (minutes + note). True ONLY when the
  // outcome is resolved AND the live draft still equals the submitted
  // snapshot — never when the owner has typed something newer.
  clearFlexibleFields: boolean;
  // Rotate to a fresh request key so the NEXT explicit save goes out
  // as a new submission under a new requestId. Rotating never submits
  // anything by itself.
  rotateKey: boolean;
  invalidateDashboard: boolean;
  // undefined = leave that piece of UI state untouched.
  statusMessage?: string | null;
  errorMessage?: string | null;
  conflictPending?: boolean;
}

export function decideSaveOutcome(
  kind: SaveOutcomeKind,
  draftMatchesSnapshot: boolean,
): SaveDecision {
  switch (kind) {
    case "ok":
      return draftMatchesSnapshot
        ? {
            clearFlexibleFields: true,
            rotateKey: true,
            invalidateDashboard: true,
            statusMessage: "已记下。",
            errorMessage: null,
            conflictPending: false,
          }
        : {
            clearFlexibleFields: false,
            rotateKey: true,
            invalidateDashboard: true,
            statusMessage: "已记下。（你刚修改的新内容已保留，还没保存。）",
            errorMessage: null,
            conflictPending: false,
          };
    case "duplicate":
      return draftMatchesSnapshot
        ? {
            clearFlexibleFields: true,
            rotateKey: true,
            invalidateDashboard: true,
            statusMessage: "这条已经记过了——重复提交没有重复计数。",
            errorMessage: null,
            conflictPending: false,
          }
        : {
            clearFlexibleFields: false,
            rotateKey: true,
            invalidateDashboard: true,
            statusMessage:
              "这条已经记过了——重复提交没有重复计数。（你刚修改的新内容已保留，还没保存。）",
            errorMessage: null,
            conflictPending: false,
          };
    case "conflict":
      // Same key, different content: keep the whole draft AND the
      // request key untouched. The owner decides explicitly — edit
      // and resubmit, or save the draft as a new record.
      return {
        clearFlexibleFields: false,
        rotateKey: false,
        invalidateDashboard: false,
        statusMessage: null,
        errorMessage:
          "这次提交已经保存过了，但内容和现在填写的不一样——已保存的那一条没有被改动，现在填写的内容也保留着。可以改好后重新点「记下这一次」，或把当前内容作为新的一条保存。",
        conflictPending: true,
      };
    case "deleted":
      // The record this key once saved is deleted and is NOT re-added
      // — no automatic resurrection, no automatic resubmission under
      // a fresh key. When the live draft still equals the submitted
      // snapshot, the matter is resolved and the flexible fields
      // clear like any resolved save. When the owner edited during
      // the flight, the form holds different, unsaved content:
      // preserve EVERY field (minutes, note, date, type) exactly as
      // it stands and say plainly that it has not been saved. The key
      // rotates so that an explicit later save — and only that —
      // goes out as a brand-new record under a new requestId.
      return draftMatchesSnapshot
        ? {
            clearFlexibleFields: true,
            rotateKey: true,
            invalidateDashboard: true,
            statusMessage: "这条记录已删除，未重新添加。",
            errorMessage: null,
            conflictPending: false,
          }
        : {
            clearFlexibleFields: false,
            rotateKey: true,
            invalidateDashboard: true,
            statusMessage: "原记录已删除，未重新添加；你修改的新内容尚未保存",
            errorMessage: null,
            conflictPending: false,
          };
    case "future":
      return {
        clearFlexibleFields: false,
        rotateKey: false,
        invalidateDashboard: false,
        errorMessage: "日期在今天之后，还没发生的事不能记为已完成；填写内容已保留。",
      };
    case "forbidden":
      return {
        clearFlexibleFields: false,
        rotateKey: false,
        invalidateDashboard: false,
        errorMessage: "当前身份无权写入这本账，记录没有保存。",
      };
    case "invalid":
      return {
        clearFlexibleFields: false,
        rotateKey: false,
        invalidateDashboard: false,
        errorMessage: "保存失败：日期可能不是真实日期。填写内容已保留，改好后可直接重试。",
      };
    case "networkError":
      // Nothing came back at all: keep the draft and the key, so an
      // explicit retry replays the same submission and can never
      // double-count.
      return {
        clearFlexibleFields: false,
        rotateKey: false,
        invalidateDashboard: false,
        errorMessage: "保存失败，请重试。用同一个请求重试不会重复计数，填写内容已保留。",
      };
  }
}
