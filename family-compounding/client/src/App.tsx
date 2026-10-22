import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import {
decideSaveOutcome,
draftsEqual,
outcomeKindOfResult,
type SaveDecision,
type SubmittedDraft,
} from "./saveOutcome";

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type WeekPoint = Dashboard["series"][number];
type ActivityRow = Dashboard["recentActivities"][number];
type TypeRow = Dashboard["types"][number];

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function parseKey(key: string): Date {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDay(key: string, today: string): string {
  const dt = parseKey(key);
  const label = `${dt.getMonth() + 1}月${dt.getDate()}日 · 周${WEEKDAYS[dt.getDay()] ?? ""}`;
  if (key === today) return `今天 · ${label}`;
  return label;
}

function formatWeek(weekStart: string): string {
  const dt = parseKey(weekStart);
  return `${dt.getMonth() + 1}月${dt.getDate()}日`;
}

function formatMinutes(total: number): string {
  if (total < 60) return `${total} 分钟`;
  const h = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分钟`;
}

function monthLabel(month: string): string {
  const [y = "—", m = "1"] = month.split("-");
  return `${y}年${Number(m)}月`;
}

function shiftMonth(month: string, delta: number): string {
  const [y = 1970, m = 1] = month.split("-").map(Number);
  const dt = new Date(y, m - 1 + delta, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
}

function newRequestKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `rk-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]";

const sectionCls =
  "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5";

/* ---------------- accumulation chart ---------------- */

function AccumulationChart({ series, total }: { series: WeekPoint[]; total: number }) {
  const W = 660;
  const H = 230;
  const padL = 36;
  const padR = 12;
  const padT = 16;
  const padB = 24;
  if (series.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-[var(--dim)]">
        还没有记录。记下第一条家庭活动，积累曲线从这里开始。
      </p>
    );
  }
  // One fact line: cumulative activity count per week. Meaning rides on
  // the axis numbers, the +N labels and the legend text — the line is a
  // solid sky-blue stroke with filled circle markers, and a dashed
  // orange reference line marks the current total (line style + text
  // label, never color alone).
  const maxY = Math.max(1, ...series.map((p) => p.cumulative));
  const n = series.length;
  const x = (i: number) =>
    n === 1 ? padL + (W - padL - padR) / 2 : padL + (i * (W - padL - padR)) / (n - 1);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / maxY);
  const linePath = series
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.cumulative).toFixed(1)}`)
    .join(" ");
  const last = series[n - 1];
  const gridVals = [...new Set([0, Math.round(maxY / 2), maxY])];
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`积累曲线：累计家庭活动（实线 · 圆点）共 ${total} 次；虚线是当前累计总数的位置`}
      >
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
            <text x={padL - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--faint)" className="tnum">
              {v}
            </text>
          </g>
        ))}
        <line
          x1={padL}
          x2={W - padR}
          y1={y(total)}
          y2={y(total)}
          stroke="var(--accent-2)"
          strokeWidth="1.5"
          strokeDasharray="6 5"
        />
        <text x={W - padR} y={y(total) - 6} textAnchor="end" fontSize="11" fill="var(--dim)" className="tnum">
          当前累计 {total} 次
        </text>
        <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        {series.map((p, i) => (
          <g key={p.weekStart}>
            <circle cx={x(i)} cy={y(p.cumulative)} r="4" fill="var(--accent)" />
            {p.newCount > 0 ? (
              <text
                x={x(i)}
                y={y(p.cumulative) - 10}
                textAnchor="middle"
                fontSize="11"
                fill="var(--dim)"
                className="tnum"
              >
                +{p.newCount}
              </text>
            ) : null}
          </g>
        ))}
        <text x={padL} y={H - 6} fontSize="11" fill="var(--faint)">
          {series[0] ? formatWeek(series[0].weekStart) : ""}当周
        </text>
        <text x={W - padR} y={H - 6} fontSize="11" fill="var(--faint)" textAnchor="end">
          {last ? formatWeek(last.weekStart) : ""}当周
        </text>
      </svg>
      <div className="mt-1 space-y-1.5 text-sm text-[var(--dim)]">
        <p>
          <span
            aria-hidden="true"
            className="mr-1.5 inline-block h-0 w-6 border-t-[3px] border-solid align-middle"
            style={{ borderColor: "var(--accent)" }}
          />
          <span className="tnum">累计家庭活动（实线 · 圆点）共 {total} 次</span>
          ——按周累计的记录次数，+N 是当周新增条数。
        </p>
        <p>
          <span
            aria-hidden="true"
            className="mr-1.5 inline-block h-0 w-6 border-t-[3px] border-dashed align-middle"
            style={{ borderColor: "var(--accent-2)" }}
          />
          虚线是当前累计总数的位置，曲线走到虚线就停在最新一周。
        </p>
        <p>没有记录的周曲线走平，不补数据；曲线只会持平或上升，删掉记错的记录后会按真实记录重新计算。</p>
      </div>
    </div>
  );
}

/* ---------------- month calendar ---------------- */

function MonthCalendar({ data }: { data: Dashboard }) {
  const [picked, setPicked] = useState<string | null>(null);
  const month = picked ?? data.thisMonth;
  const countByDate = new Map<string, number>();
  for (const m of data.calendar) {
    for (const d of m.days) countByDate.set(d.date, d.count);
  }
  const dataMonths = data.calendar.map((m) => m.month);
  const firstDataMonth = dataMonths[0] ?? data.thisMonth;
  const lastDataMonth = dataMonths[dataMonths.length - 1] ?? data.thisMonth;
  const minMonth = firstDataMonth < data.thisMonth ? firstDataMonth : data.thisMonth;
  const maxMonth = lastDataMonth > data.thisMonth ? lastDataMonth : data.thisMonth;
  const [yy = 1970, mm = 1] = month.split("-").map(Number);
  const daysInMonth = new Date(yy, mm, 0).getDate();
  const leading = (new Date(yy, mm - 1, 1).getDay() + 6) % 7; // Monday-first
  const cells: Array<{ date: string; day: number; count: number } | null> = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    cells.push({ date, day: d, count: countByDate.get(date) ?? 0 });
  }
  const monthTotal = [...countByDate.entries()]
    .filter(([date]) => date.startsWith(month))
    .reduce((sum, [, c]) => sum + c, 0);
  const monthNum = Number(month.split("-")[1]);
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          aria-label="上个月"
          disabled={month <= minMonth}
          onClick={() => setPicked(shiftMonth(month, -1))}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)] disabled:opacity-40"
        >
          ← 上个月
        </button>
        <p className="font-display text-lg font-bold">{monthLabel(month)}</p>
        <button
          type="button"
          aria-label="下个月"
          disabled={month >= maxMonth}
          onClick={() => setPicked(shiftMonth(month, 1))}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)] disabled:opacity-40"
        >
          下个月 →
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center" role="grid" aria-label={`${monthLabel(month)}家庭活动日历`}>
        {["一", "二", "三", "四", "五", "六", "日"].map((w) => (
          <div key={w} className="py-1 text-xs text-[var(--faint)]">
            周{w}
          </div>
        ))}
        {cells.map((cell, i) =>
          cell === null ? (
            <div key={`blank-${i}`} aria-hidden="true" />
          ) : (
            <div
              key={cell.date}
              role="gridcell"
              aria-label={
                cell.count > 0
                  ? `${monthNum}月${cell.day}日，${cell.count} 次家庭活动${cell.date === data.today ? "，今天" : ""}`
                  : `${monthNum}月${cell.day}日，没有记录${cell.date === data.today ? "，今天" : ""}`
              }
              className={`flex min-h-11 flex-col items-center justify-center rounded-lg px-0.5 py-1 ${
                cell.count > 0 ? "bg-[var(--surface-2)]" : ""
              } ${cell.date === data.today ? "ring-1 ring-[var(--accent)]" : ""}`}
            >
              <span className={`text-sm tnum ${cell.count > 0 ? "font-bold text-[var(--text)]" : "text-[var(--faint)]"}`}>
                {cell.day}
              </span>
              {cell.count > 0 ? (
                <span className="text-[11px] leading-4 text-[var(--accent)] tnum">
                  ● ×{cell.count}
                </span>
              ) : null}
              {cell.date === data.today ? (
                <span className="text-[10px] leading-3 text-[var(--dim)]">今天</span>
              ) : null}
            </div>
          ),
        )}
      </div>
      <p className="mt-3 text-sm text-[var(--dim)]">
        {monthLabel(month)}共 <span className="tnum font-bold text-[var(--text)]">{monthTotal}</span> 次有记录的家庭活动。
      </p>
      <p className="mt-1 text-sm text-[var(--dim)]">
        日历上留空的日期只是没有记录，不等于没有陪伴——这本账只记你记下的部分。
      </p>
    </div>
  );
}

/* ---------------- record form ---------------- */

// What a submission's outcome does to the form is decided by the pure
// decideSaveOutcome in saveOutcome.ts: EVERY branch (ok / duplicate /
// conflict / deleted / future / forbidden / invalid / network error)
// compares the live draft against the submitted snapshot first, and
// clears fields only when the two still match. An edit made while a
// save was in flight is a new, unsaved draft and is preserved whole —
// including on a `deleted` refusal, where the changed draft stays put
// with an explicit "not saved" note and is only ever stored when the
// owner explicitly saves again (under the fresh request key).

function RecordForm({ data }: { data: Dashboard }) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState(data.today);
  const [pickedType, setPickedType] = useState<string | null>(null);
  const [customType, setCustomType] = useState("");
  const [minutesText, setMinutesText] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [conflictPending, setConflictPending] = useState(false);
  const requestKeyRef = useRef<string>(newRequestKey());
  // Live mirrors of the form fields. The mutation's onSuccess reads
  // these (not the render-scope state, which its closure may predate)
  // to compare the in-flight draft against what is on screen now.
  const dateRef = useRef(data.today);
  const pickedTypeRef = useRef<string | null>(null);
  const customTypeRef = useRef("");
  const minutesTextRef = useRef("");
  const noteRef = useRef("");

  const typeNames = data.types.map((t) => t.name);
  const effectiveType =
    pickedType && typeNames.includes(pickedType) ? pickedType : (typeNames[0] ?? "");

  // The draft exactly as the form currently stands, normalized the
  // same way submitDraft normalizes a submission.
  function currentDraft(): SubmittedDraft {
    const picked = pickedTypeRef.current;
    const pickedName =
      picked && typeNames.includes(picked) ? picked : (typeNames[0] ?? "");
    const typeName = typeNames.length > 0 ? pickedName : customTypeRef.current.trim();
    const mt = minutesTextRef.current.trim();
    let minutes: number | null | undefined = null;
    if (mt !== "") {
      const parsed = Number(mt);
      minutes = Number.isInteger(parsed) ? parsed : undefined;
    }
    const trimmedNote = noteRef.current.trim();
    return {
      date: dateRef.current,
      typeName,
      minutes,
      note: trimmedNote === "" ? null : trimmedNote,
    };
  }

  function draftMatchesSnapshot(submittedSnapshot: SubmittedDraft): boolean {
    return draftsEqual(currentDraft(), submittedSnapshot);
  }

  function clearFlexibleFields() {
    setMinutesText("");
    minutesTextRef.current = "";
    setNote("");
    noteRef.current = "";
  }

  // Apply a SaveDecision from saveOutcome.ts to the form state.
  // Fields the decision leaves undefined stay exactly as they are.
  function applySaveDecision(decision: SaveDecision) {
    if (decision.statusMessage !== undefined) setSavedMsg(decision.statusMessage);
    if (decision.errorMessage !== undefined) setError(decision.errorMessage);
    if (decision.conflictPending !== undefined) setConflictPending(decision.conflictPending);
    if (decision.rotateKey) requestKeyRef.current = newRequestKey();
    if (decision.clearFlexibleFields) clearFlexibleFields();
    if (decision.invalidateDashboard) {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }
  }

  const add = useMutation({
    mutationFn: (vars: {
      date: string;
      typeName: string;
      minutes: number | null;
      note: string | null;
      requestKey: string;
      submittedSnapshot: SubmittedDraft;
    }) =>
      api.addActivity({
        date: vars.date,
        typeName: vars.typeName,
        minutes: vars.minutes,
        note: vars.note,
        requestKey: vars.requestKey,
      }),
    onSuccess: (res, variables) => {
      applySaveDecision(
        decideSaveOutcome(
          outcomeKindOfResult(res),
          draftMatchesSnapshot(variables.submittedSnapshot),
        ),
      );
    },
    onError: () => {
      applySaveDecision(decideSaveOutcome("networkError", false));
    },
  });

  function submitDraft() {
    setSavedMsg(null);
    const typeName = typeNames.length > 0 ? effectiveType : customType.trim();
    if (!typeName) {
      setError("先选一个类型，或填一个类型名。");
      return;
    }
    let minutes: number | null = null;
    const mt = minutesText.trim();
    if (mt !== "") {
      const parsed = Number(mt);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1440) {
        setError("时长请填 1 到 1440 之间的整数分钟，或留空表示未知。");
        return;
      }
      minutes = parsed;
    }
    setError(null);
    setConflictPending(false);
    const noteValue = note.trim() === "" ? null : note.trim();
    const submittedSnapshot: SubmittedDraft = {
      date,
      typeName,
      minutes,
      note: noteValue,
    };
    add.mutate({
      date,
      typeName,
      minutes,
      note: noteValue,
      requestKey: requestKeyRef.current,
      submittedSnapshot,
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submitDraft();
  }

  // Explicit owner choice after a conflict: rotate to a fresh request
  // key and save the current draft as a brand-new record.
  function saveAsNew() {
    requestKeyRef.current = newRequestKey();
    submitDraft();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="activity-date" className="mb-1.5 block text-sm text-[var(--dim)]">
          日期（可以补记过去的日子）
        </label>
        <input
          id="activity-date"
          type="date"
          value={date}
          max={data.today}
          onChange={(e) => {
            setDate(e.target.value);
            dateRef.current = e.target.value;
          }}
          className={inputCls}
          required
        />
      </div>
      <div>
        <span id="type-label" className="mb-1.5 block text-sm text-[var(--dim)]">
          类型
        </span>
        {typeNames.length > 0 ? (
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="type-label">
            {data.types.map((t) => {
              const active = effectiveType === t.name;
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setPickedType(t.name);
                    pickedTypeRef.current = t.name;
                  }}
                  className={`rounded-full border px-3.5 py-2 text-sm ${
                    active
                      ? "border-[var(--accent)] bg-[var(--surface-2)] font-bold text-[var(--text)]"
                      : "border-[var(--border)] text-[var(--dim)]"
                  }`}
                >
                  {active ? "● " : "○ "}
                  {t.name}
                </button>
              );
            })}
          </div>
        ) : (
          <input
            aria-labelledby="type-label"
            value={customType}
            onChange={(e) => {
              setCustomType(e.target.value);
              customTypeRef.current = e.target.value;
            }}
            placeholder="类型名，如 一起吃饭"
            maxLength={20}
            className={inputCls}
          />
        )}
      </div>
      <div>
        <label htmlFor="activity-minutes" className="mb-1.5 block text-sm text-[var(--dim)]">
          时长（分钟，可留空 = 未知，不按 0 算）
        </label>
        <input
          id="activity-minutes"
          type="number"
          inputMode="numeric"
          min={1}
          max={1440}
          value={minutesText}
          onChange={(e) => {
            setMinutesText(e.target.value);
            minutesTextRef.current = e.target.value;
          }}
          placeholder="留空表示未知"
          className={inputCls}
        />
      </div>
      <div>
        <label htmlFor="activity-note" className="mb-1.5 block text-sm text-[var(--dim)]">
          备注（一句话，可留空）
        </label>
        <input
          id="activity-note"
          type="text"
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            noteRef.current = e.target.value;
          }}
          placeholder="如 去公园骑了车"
          maxLength={80}
          className={inputCls}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-[var(--accent-2)]">
          {error}
        </p>
      ) : null}
      {savedMsg ? (
        <p role="status" className="text-sm text-[var(--dim)]">
          {savedMsg}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={add.isPending}
        className="w-full rounded-lg bg-[var(--accent)] px-4 py-3 text-base font-bold text-[#0e1116] disabled:opacity-50"
      >
        {add.isPending ? "保存中…" : "记下这一次"}
      </button>
      {conflictPending ? (
        <button
          type="button"
          onClick={saveAsNew}
          disabled={add.isPending}
          className="w-full rounded-lg border border-[var(--accent)] px-4 py-2.5 text-sm font-bold text-[var(--accent)] disabled:opacity-50"
        >
          作为新的一条保存
        </button>
      ) : null}
    </form>
  );
}

/* ---------------- recent list ---------------- */

function ActivityItem({ row, today }: { row: ActivityRow; today: string }) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useMutation({
    mutationFn: () => api.deleteActivity({ id: row.id }),
    onSuccess: (res) => {
      if (res.ok) {
        void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      } else {
        setConfirmDelete(false);
      }
    },
  });
  return (
    <li className="flex items-start justify-between gap-3 border-b border-[var(--border)] py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="text-base text-[var(--text)]">
          <span className="font-bold">{row.typeName}</span>
          <span className="ml-2 text-sm text-[var(--dim)] tnum">
            {row.minutes === null ? "时长未知" : formatMinutes(row.minutes)}
          </span>
        </p>
        <p className="mt-0.5 text-sm text-[var(--dim)]">{formatDay(row.date, today)}</p>
        <p className="mt-0.5 text-xs text-[var(--faint)]">
          来源：{row.source === null ? "旧来源未记录" : row.source}
        </p>
        {row.note ? <p className="mt-0.5 break-words text-sm text-[var(--dim)]">{row.note}</p> : null}
        {del.isError || (del.isSuccess && !del.data.ok) ? (
          <p role="alert" className="mt-1 text-sm text-[var(--accent-2)]">
            删除失败：这条记录还在，计数没有变化。点「删除」可重试。
          </p>
        ) : null}
      </div>
      {confirmDelete ? (
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => del.mutate()}
            disabled={del.isPending}
            className="rounded-lg border border-[var(--accent-2)] px-3 py-1.5 text-sm font-bold text-[var(--accent-2)] disabled:opacity-50"
          >
            确认删除
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(false)}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)]"
          >
            取消
          </button>
        </div>
      ) : (
        <button
          type="button"
          aria-label={`删除这条${row.typeName}记录`}
          onClick={() => setConfirmDelete(true)}
          className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)]"
        >
          删除
        </button>
      )}
    </li>
  );
}

/* ---------------- type manager ---------------- */

function TypeManager({ types }: { types: TypeRow[] }) {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["dashboard"] });

  const addType = useMutation({
    mutationFn: (name: string) => api.addType({ name }),
    onSuccess: (res) => {
      if (res.ok) {
        setMsg(res.duplicate ? "这个类型已经在列表里了。" : "类型已添加。");
        setNewName("");
        invalidate();
      } else {
        setMsg("添加失败，请重试。");
      }
    },
    onError: () => setMsg("添加失败，请重试。"),
  });
  const deleteType = useMutation({
    mutationFn: (id: number) => api.deleteType({ id }),
    onSuccess: (res) => {
      setConfirmId(null);
      if (res.ok) {
        setMsg("类型已从列表删除。已记录的活动仍保留原来的类型名，不受影响。");
        invalidate();
      } else {
        setMsg("删除失败，请重试。");
      }
    },
    onError: () => setMsg("删除失败，请重试。"),
  });

  function onAdd(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setMsg(null);
    addType.mutate(name);
  }

  return (
    <div>
      <ul className="divide-y divide-[var(--border)]">
        {types.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
            <span className="text-base text-[var(--text)]">
              {t.name}
              {t.isPreset ? <span className="ml-2 text-xs text-[var(--faint)]">预置</span> : null}
            </span>
            {confirmId === t.id ? (
              <span className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => deleteType.mutate(t.id)}
                  disabled={deleteType.isPending}
                  className="rounded-lg border border-[var(--accent-2)] px-3 py-1.5 text-sm font-bold text-[var(--accent-2)] disabled:opacity-50"
                >
                  确认删除类型
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmId(null)}
                  className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)]"
                >
                  取消
                </button>
              </span>
            ) : (
              <button
                type="button"
                aria-label={`删除类型${t.name}`}
                onClick={() => setConfirmId(t.id)}
                className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)]"
              >
                删除
              </button>
            )}
          </li>
        ))}
      </ul>
      {types.length === 0 ? (
        <p className="py-2 text-sm text-[var(--dim)]">类型列表是空的，用下面的输入框添加第一个类型。</p>
      ) : null}
      <form onSubmit={onAdd} className="mt-3 flex gap-2">
        <label htmlFor="new-type-name" className="sr-only">
          新类型名
        </label>
        <input
          id="new-type-name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="新类型名，如 拼图"
          maxLength={20}
          className={inputCls}
        />
        <button
          type="submit"
          disabled={addType.isPending || newName.trim() === ""}
          className="shrink-0 rounded-lg border border-[var(--accent)] px-4 py-2.5 text-sm font-bold text-[var(--accent)] disabled:opacity-50"
        >
          添加类型
        </button>
      </form>
      {msg ? (
        <p role="status" className="mt-2 text-sm text-[var(--dim)]">
          {msg}
        </p>
      ) : null}
    </div>
  );
}

/* ---------------- app ---------------- */

export function App() {
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: () => api.getDashboard({}) });

  return (
    <div className="min-h-full bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim />
      <main className="mx-auto w-full max-w-3xl space-y-5 px-4 pb-16 pt-6">
        {dashboard.isPending ? (
          <p className="py-16 text-center text-sm text-[var(--dim)]">正在打开账本…</p>
        ) : dashboard.isError ? (
          <section className={sectionCls}>
            <p role="alert" className="text-base">
              账本暂时打不开。
            </p>
            <p className="mt-1 text-sm text-[var(--dim)]">数据没有丢，是这次读取失败了。</p>
            <button
              type="button"
              onClick={() => void dashboard.refetch()}
              className="mt-3 rounded-lg border border-[var(--accent)] px-4 py-2 text-sm font-bold text-[var(--accent)]"
            >
              重新读取
            </button>
          </section>
        ) : dashboard.data.forbidden ? (
          <section className={sectionCls}>
            <p className="font-display text-xl font-bold">这本账只对所有者开放</p>
            <p className="mt-2 text-sm leading-6 text-[var(--dim)]">
              这里记录的是所有者的家庭时光账本，当前访问身份无权查看，也不能写入或删除任何记录。
            </p>
          </section>
        ) : (
          <>
            <section className={sectionCls} aria-label="总览">
              <p className="text-sm text-[var(--dim)]">累计家庭活动</p>
              <p className="mt-1 font-display text-5xl font-black leading-none tnum">
                {dashboard.data.totalCount}
                <span className="ml-2 text-xl font-bold text-[var(--dim)]">次</span>
              </p>
              <div className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-[var(--faint)]">累计已知时长</p>
                  <p className="mt-0.5 text-base font-bold tnum">
                    {formatMinutes(dashboard.data.totalKnownMinutes)}
                  </p>
                  {dashboard.data.unknownMinutesCount > 0 ? (
                    <p className="mt-0.5 text-xs text-[var(--dim)]">
                      另有 <span className="tnum">{dashboard.data.unknownMinutesCount}</span> 次时长未知，未计入
                    </p>
                  ) : null}
                </div>
                <div>
                  <p className="text-[var(--faint)]">本月次数</p>
                  <p className="mt-0.5 text-base font-bold tnum">{dashboard.data.thisMonthCount} 次</p>
                </div>
                <div>
                  <p className="text-[var(--faint)]">最近一次</p>
                  <p className="mt-0.5 text-base font-bold">
                    {dashboard.data.lastActivityDate
                      ? formatDay(dashboard.data.lastActivityDate, dashboard.data.today)
                      : "还没有记录"}
                  </p>
                </div>
              </div>
              <p className="mt-4 border-t border-[var(--border)] pt-3 text-base">
                {dashboard.data.totalCount === 0
                  ? "账本还是空的。记下第一条家庭活动，积累从这里开始。"
                  : `本月共 ${dashboard.data.thisMonthCount} 次家庭活动，累计 ${dashboard.data.totalCount} 次——一次一次记下来，就是在长。`}
              </p>
              {dashboard.data.totalCount === 0 ? (
                <p className="mt-2 text-sm text-[var(--dim)]">
                  也可以在聊天里告诉 Muse，由 Muse 代记（来源会标为聊天记录）。
                </p>
              ) : null}
              {dashboard.data.futureRecordCount > 0 ? (
                <p className="mt-2 text-sm text-[var(--dim)]">
                  有 <span className="tnum">{dashboard.data.futureRecordCount}</span>{" "}
                  条记录日期在今天之后，未计入累计；这些记录会在日期到达后自动计入累计，无需重新记录，也可以直接在最近记录里删除。
                </p>
              ) : null}
            </section>

            <section className={sectionCls} aria-label="每周积累曲线">
              <h2 className="font-display text-lg font-bold">每周积累</h2>
              <p className="mb-2 mt-0.5 text-sm text-[var(--dim)]">按周累计次数，长期看这条线怎么长。</p>
              <AccumulationChart series={dashboard.data.series} total={dashboard.data.totalCount} />
            </section>

            <section className={sectionCls} aria-label="月历">
              <h2 className="font-display text-lg font-bold">月历</h2>
              <p className="mb-3 mt-0.5 text-sm text-[var(--dim)]">有记录的日期标出次数（● ×N），没有标记的日期留空。</p>
              <MonthCalendar data={dashboard.data} />
            </section>

            <section className={sectionCls} aria-label="记一条家庭活动">
              <h2 className="font-display text-lg font-bold">记一条</h2>
              <p className="mb-4 mt-0.5 text-sm text-[var(--dim)]">十秒钟记完：日期、类型必填，时长和备注都可以留空。</p>
              <RecordForm data={dashboard.data} />
            </section>

            <section className={sectionCls} aria-label="最近记录">
              <h2 className="font-display text-lg font-bold">最近记录</h2>
              {dashboard.data.recentActivities.length === 0 ? (
                <p className="py-4 text-sm text-[var(--dim)]">
                  还没有任何记录。用上面的表单记一条，或在聊天里告诉 Muse，由 Muse 代记（来源会标为聊天记录）。
                </p>
              ) : (
                <>
                  <ul>
                    {dashboard.data.recentActivities.map((row) => (
                      <ActivityItem key={row.id} row={row} today={dashboard.data.today} />
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-[var(--faint)]">
                    记错了可以删掉这一条——总数、时长、曲线和日历都会按删后的记录重新计算。
                  </p>
                </>
              )}
            </section>

            <section className={sectionCls} aria-label="活动类型管理">
              <h2 className="font-display text-lg font-bold">活动类型</h2>
              <p className="mb-2 mt-0.5 text-sm text-[var(--dim)]">类型可以自由增删，删掉的类型不会影响已经记下的活动。</p>
              <TypeManager types={dashboard.data.types} />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
