import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type SkillStat = Dashboard["skills"][number];
type InputRow = Dashboard["inputs"][number];
type SeriesPoint = Dashboard["series"][number];
type SourceType = InputRow["sourceType"];
type OutputType = NonNullable<InputRow["outputType"]>;

const SOURCE_LABEL: Record<SourceType, string> = {
  article: "文章",
  video: "视频",
  research: "调研",
  practice: "实操",
  course: "课程",
};
const SOURCE_TYPES = Object.keys(SOURCE_LABEL) as SourceType[];

const OUTPUT_LABEL: Record<OutputType, string> = {
  note: "笔记",
  experiment: "实验",
  project: "项目推进",
  decision: "决策",
};
const OUTPUT_TYPES = Object.keys(OUTPUT_LABEL) as OutputType[];

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

function formatMinutes(min: number): string {
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分`;
}

function pct(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

/* ---------------- charts ---------------- */

function CompoundChart({ series }: { series: SeriesPoint[] }) {
  const W = 660;
  const H = 230;
  const padL = 36;
  const padR = 12;
  const padT = 16;
  const padB = 24;
  if (series.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-[var(--dim)]">
        还没有记录。记下第一笔输入，积累曲线从这里开始。
      </p>
    );
  }
  const maxY = Math.max(1, ...series.map((p) => Math.max(p.inputs, p.converted)));
  const n = series.length;
  const x = (i: number) =>
    n === 1 ? padL + (W - padL - padR) / 2 : padL + (i * (W - padL - padR)) / (n - 1);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / maxY);
  const path = (get: (p: SeriesPoint) => number) =>
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(get(p)).toFixed(1)}`).join(" ");
  const last = series[n - 1];
  const gridVals = [0, Math.round(maxY / 2), maxY];
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`积累曲线：累计输入 ${last?.inputs ?? 0} 条，累计转化 ${last?.converted ?? 0} 条`}
      >
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
            <text x={padL - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--faint)" className="tnum">
              {v}
            </text>
          </g>
        ))}
        <path d={path((p) => p.inputs)} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        <path
          d={path((p) => p.converted)}
          fill="none"
          stroke="var(--accent-2)"
          strokeWidth="2.5"
          strokeDasharray="7 5"
        />
        {last ? (
          <>
            <circle cx={x(n - 1)} cy={y(last.inputs)} r="4" fill="var(--accent)" />
            <circle cx={x(n - 1)} cy={y(last.converted)} r="4" fill="var(--accent-2)" />
          </>
        ) : null}
        <text x={padL} y={H - 6} fontSize="11" fill="var(--faint)">
          {series[0]?.date ?? ""}
        </text>
        <text x={W - padR} y={H - 6} fontSize="11" fill="var(--faint)" textAnchor="end">
          {last?.date ?? ""}
        </text>
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-sm text-[var(--dim)]">
        <span>
          <span aria-hidden="true" className="mr-1 inline-block h-0 w-6 border-t-[3px] border-solid align-middle" style={{ borderColor: "var(--accent)" }} />
          累计输入（实线）{last?.inputs ?? 0} 条
        </span>
        <span>
          <span aria-hidden="true" className="mr-1 inline-block h-0 w-6 border-t-[3px] border-dashed align-middle" style={{ borderColor: "var(--accent-2)" }} />
          累计转化（虚线）{last?.converted ?? 0} 条
        </span>
      </div>
    </div>
  );
}

function Sparkline({ series }: { series: SeriesPoint[] }) {
  const W = 132;
  const H = 40;
  const pad = 3;
  if (series.length === 0) {
    return <p className="text-xs text-[var(--faint)]">暂无积累曲线</p>;
  }
  const maxY = Math.max(1, ...series.map((p) => Math.max(p.inputs, p.converted)));
  const n = series.length;
  const x = (i: number) => (n === 1 ? W / 2 : pad + (i * (W - pad * 2)) / (n - 1));
  const y = (v: number) => pad + (H - pad * 2) * (1 - v / maxY);
  const path = (get: (p: SeriesPoint) => number) =>
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(get(p)).toFixed(1)}`).join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full max-w-[132px]"
      role="img"
      aria-label="该技能的积累曲线（累计输入与累计转化）"
    >
      <path d={path((p) => p.inputs)} fill="none" stroke="var(--accent)" strokeWidth="2" />
      <path d={path((p) => p.converted)} fill="none" stroke="var(--accent-2)" strokeWidth="2" strokeDasharray="4 3" />
    </svg>
  );
}

/* ---------------- skill card ---------------- */

function SkillCard({ skill }: { skill: SkillStat }) {
  return (
    <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-bold leading-snug">{skill.name}</h3>
          {skill.note ? <p className="mt-0.5 text-sm text-[var(--dim)]">{skill.note}</p> : null}
        </div>
        <div className="shrink-0 text-right">
          <p className="tnum text-2xl font-semibold leading-none">{skill.streakDays}</p>
          <p className="mt-1 text-xs text-[var(--dim)]">连续学习（天）</p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
        <div>
          <dt className="text-xs text-[var(--dim)]">累计投入</dt>
          <dd className="tnum mt-0.5 text-base font-medium">{formatMinutes(skill.totalMinutes)}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--dim)]">已转化产出</dt>
          <dd className="tnum mt-0.5 text-base font-medium">
            {skill.convertedCount} <span className="text-xs text-[var(--dim)]">/ 输入 {skill.inputCount}</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--dim)]">转化率</dt>
          <dd className="tnum mt-0.5 text-base font-medium">{pct(skill.conversionRate)}</dd>
        </div>
      </dl>
      <div className="mt-3 flex items-end justify-between gap-3 border-t border-[var(--border)] pt-3">
        <p className="text-xs text-[var(--dim)]">
          {skill.lastInputDate ? `最近输入 ${skill.lastInputDate}` : "还没有输入记录"}
        </p>
        <Sparkline series={skill.series} />
      </div>
    </section>
  );
}

/* ---------------- quick add ---------------- */

function QuickAdd({ data }: { data: Dashboard }) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState("");
  const [sourceType, setSourceType] = useState<SourceType>("article");
  const [topic, setTopic] = useState("");
  const [skillId, setSkillId] = useState<string>("");
  const [minutes, setMinutes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      api.recordLearningInput({
        date: date || data.today,
        sourceType,
        topic: topic.trim(),
        skillId: skillId === "" ? null : Number(skillId),
        minutes: minutes === "" ? 0 : Number(minutes),
        converted: false,
      }),
    onSuccess: () => {
      setTopic("");
      setMinutes("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => setError(`保存失败：${String(e)}`),
  });

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!topic.trim()) {
      setError("先写下这条输入的主题。");
      return;
    }
    add.mutate();
  };

  const inputCls =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]";

  return (
    <form onSubmit={submit} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="font-display text-lg font-bold">记一笔输入</h2>
      <p className="mt-1 text-sm text-[var(--dim)]">读了、看了、练了——先记下来，转化可以之后再标。</p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="qa-date" className="mb-1 block text-sm text-[var(--dim)]">日期</label>
          <input id="qa-date" aria-label="日期" type="date" className={inputCls} value={date || data.today} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label htmlFor="qa-source" className="mb-1 block text-sm text-[var(--dim)]">来源类型</label>
          <select id="qa-source" aria-label="来源类型" className={inputCls} value={sourceType} onChange={(e) => setSourceType(e.target.value as SourceType)}>
            {SOURCE_TYPES.map((t) => (
              <option key={t} value={t}>{SOURCE_LABEL[t]}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-3">
        <label htmlFor="qa-topic" className="mb-1 block text-sm text-[var(--dim)]">主题</label>
        <input id="qa-topic" aria-label="主题" type="text" className={inputCls} placeholder="例如：多智能体任务拆分模式" value={topic} onChange={(e) => setTopic(e.target.value)} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="qa-skill" className="mb-1 block text-sm text-[var(--dim)]">关联技能</label>
          <select id="qa-skill" aria-label="关联技能" className={inputCls} value={skillId} onChange={(e) => setSkillId(e.target.value)}>
            <option value="">不关联技能</option>
            {data.skills.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="qa-minutes" className="mb-1 block text-sm text-[var(--dim)]">时长（分钟）</label>
          <input id="qa-minutes" aria-label="时长（分钟）" type="number" inputMode="numeric" min={0} max={1440} className={inputCls} placeholder="0" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </div>
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-[var(--accent-2)]">{error}</p> : null}
      <button
        type="submit"
        disabled={add.isPending}
        className="mt-4 w-full rounded-lg bg-[var(--accent)] px-4 py-3 text-base font-semibold text-[#0b1520] disabled:opacity-50"
      >
        {add.isPending ? "保存中…" : "＋ 记入账本"}
      </button>
      <p className="mt-3 text-xs text-[var(--faint)]">Muse 交付调研报告、点子扫描或小红书摘要时，也会直接记入这本账。</p>
    </form>
  );
}

/* ---------------- ledger ---------------- */

function ConvertForm({ row, onDone }: { row: InputRow; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [outputType, setOutputType] = useState<OutputType>("note");
  const [note, setNote] = useState("");
  const mark = useMutation({
    mutationFn: () =>
      api.markConverted({ id: row.id, outputType, outputNote: note.trim() || undefined }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      onDone();
    },
  });
  const inputCls =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]";
  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`cv-type-${row.id}`} className="mb-1 block text-sm text-[var(--dim)]">产出类型</label>
          <select id={`cv-type-${row.id}`} aria-label="产出类型" className={inputCls} value={outputType} onChange={(e) => setOutputType(e.target.value as OutputType)}>
            {OUTPUT_TYPES.map((t) => (
              <option key={t} value={t}>{OUTPUT_LABEL[t]}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`cv-note-${row.id}`} className="mb-1 block text-sm text-[var(--dim)]">产出说明（可选）</label>
          <input id={`cv-note-${row.id}`} aria-label="产出说明" type="text" className={inputCls} placeholder="例如：写成实验方案" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={mark.isPending}
          onClick={() => mark.mutate()}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b1520] disabled:opacity-50"
        >
          确认转化
        </button>
        <button type="button" onClick={onDone} className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--dim)]">
          取消
        </button>
      </div>
      {mark.isError ? <p role="alert" className="mt-2 text-sm text-[var(--accent-2)]">保存失败，请重试。</p> : null}
    </div>
  );
}

function LedgerRow({ row, today }: { row: InputRow; today: string }) {
  const queryClient = useQueryClient();
  const [converting, setConverting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  const unmark = useMutation({ mutationFn: () => api.unmarkConverted({ id: row.id }), onSuccess: invalidate });
  const del = useMutation({ mutationFn: () => api.deleteInput({ id: row.id }), onSuccess: invalidate });

  return (
    <article className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium leading-snug">{row.topic}</p>
        {row.converted ? (
          <span className="shrink-0 rounded-full border border-[var(--accent-2)] px-2 py-0.5 text-xs font-medium text-[var(--accent-2)]">
            ✓ 已转化
          </span>
        ) : (
          <span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-medium text-[var(--dim)]">
            ○ 待转化
          </span>
        )}
      </div>
      <p className="mt-1.5 text-sm text-[var(--dim)]">
        {formatDay(row.date, today)} · {SOURCE_LABEL[row.sourceType]}
        {row.skillName ? ` · ${row.skillName}` : " · 未关联技能"}
        {row.minutes > 0 ? ` · ${row.minutes} 分钟` : ""}
      </p>
      {row.converted ? (
        <p className="mt-2 text-sm">
          <span className="text-[var(--dim)]">产出：</span>
          {row.outputType ? OUTPUT_LABEL[row.outputType] : "已转化"}
          {row.outputNote ? ` — ${row.outputNote}` : ""}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {row.converted ? (
          <button
            type="button"
            disabled={unmark.isPending}
            onClick={() => unmark.mutate()}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)] disabled:opacity-50"
          >
            撤销转化
          </button>
        ) : (
          <button
            type="button"
            aria-expanded={converting}
            onClick={() => setConverting((v) => !v)}
            className="rounded-lg border border-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent)]"
          >
            标记已转化
          </button>
        )}
        {confirmDelete ? (
          <>
            <button
              type="button"
              disabled={del.isPending}
              onClick={() => del.mutate()}
              className="rounded-lg border border-[var(--accent-2)] px-3 py-1.5 text-sm font-medium text-[var(--accent-2)] disabled:opacity-50"
            >
              确认删除这条
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)]">
              不删
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirmDelete(true)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--faint)]">
            删除
          </button>
        )}
      </div>
      {converting && !row.converted ? <ConvertForm row={row} onDone={() => setConverting(false)} /> : null}
    </article>
  );
}

function Ledger({ data }: { data: Dashboard }) {
  const [status, setStatus] = useState<"all" | "converted" | "pending">("all");
  const [skillFilter, setSkillFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.inputs.filter((r) => {
      if (status === "converted" && !r.converted) return false;
      if (status === "pending" && r.converted) return false;
      if (skillFilter === "none" && r.skillId != null) return false;
      if (skillFilter !== "all" && skillFilter !== "none" && r.skillId !== Number(skillFilter)) return false;
      if (q && !r.topic.toLowerCase().includes(q) && !(r.outputNote ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data.inputs, status, skillFilter, search]);

  const groups = useMemo(() => {
    const sorted = [...filtered].sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
    const out: Array<{ date: string; rows: InputRow[] }> = [];
    for (const row of sorted) {
      const lastGroup = out[out.length - 1];
      if (lastGroup && lastGroup.date === row.date) lastGroup.rows.push(row);
      else out.push({ date: row.date, rows: [row] });
    }
    return out;
  }, [filtered]);

  const selectCls =
    "rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="按转化状态筛选" className="flex overflow-hidden rounded-lg border border-[var(--border)]">
          {(
            [
              ["all", "全部"],
              ["pending", "○ 待转化"],
              ["converted", "✓ 已转化"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={status === key}
              onClick={() => setStatus(key)}
              className={`px-3 py-2 text-sm ${status === key ? "bg-[var(--surface-2)] font-semibold text-[var(--text)]" : "text-[var(--dim)]"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <select aria-label="按技能筛选" className={selectCls} value={skillFilter} onChange={(e) => setSkillFilter(e.target.value)}>
          <option value="all">全部技能</option>
          {data.skills.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
          <option value="none">未关联技能</option>
        </select>
        <input
          aria-label="搜索主题"
          type="search"
          placeholder="搜索主题…"
          className={`${selectCls} min-w-[140px] flex-1`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {data.inputs.length === 0 ? (
        <p className="mt-6 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6 text-center text-sm text-[var(--dim)]">
          账本还是空的。用上面的「记一笔输入」记下今天的第一条学习输入。
        </p>
      ) : filtered.length === 0 ? (
        <p className="mt-6 text-center text-sm text-[var(--dim)]">没有符合筛选条件的记录。</p>
      ) : (
        groups.map((g) => (
          <div key={g.date} className="mt-5">
            <h3 className="text-sm font-medium text-[var(--dim)]">{formatDay(g.date, data.today)}</h3>
            <div className="mt-2 space-y-3">
              {g.rows.map((row) => (
                <LedgerRow key={row.id} row={row} today={data.today} />
              ))}
            </div>
          </div>
        ))
      )}
      {data.totals.unconvertedCount > 0 ? (
        <p className="mt-6 text-sm text-[var(--dim)]">
          ○ 待转化 {data.totals.unconvertedCount} 条 — 它们不会过期消失，转化成笔记、实验、项目推进或决策后就会变成资产。
        </p>
      ) : null}
    </div>
  );
}

/* ---------------- skills manager ---------------- */

function SkillManager({ data }: { data: Dashboard }) {
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  const [newName, setNewName] = useState("");
  const [newNote, setNewNote] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editNote, setEditNote] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const addSkill = useMutation({
    mutationFn: () => api.addSkill({ name: newName.trim(), note: newNote.trim() || undefined }),
    onSuccess: () => {
      setNewName("");
      setNewNote("");
      invalidate();
    },
  });
  const updateSkill = useMutation({
    mutationFn: (id: number) => api.updateSkill({ id, name: editName.trim(), note: editNote.trim() || null }),
    onSuccess: () => {
      setEditingId(null);
      invalidate();
    },
  });
  const deleteSkill = useMutation({
    mutationFn: (id: number) => api.deleteSkill({ id }),
    onSuccess: () => {
      setConfirmDeleteId(null);
      invalidate();
    },
  });

  const inputCls =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]";

  return (
    <div>
      <form
        onSubmit={(ev: FormEvent) => {
          ev.preventDefault();
          if (newName.trim()) addSkill.mutate();
        }}
        className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <h2 className="font-display text-lg font-bold">新增技能</h2>
        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor="ns-name" className="mb-1 block text-sm text-[var(--dim)]">技能名称</label>
            <input id="ns-name" aria-label="技能名称" type="text" className={inputCls} placeholder="例如：英语口语" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="ns-note" className="mb-1 block text-sm text-[var(--dim)]">备注（可选）</label>
            <input id="ns-note" aria-label="技能备注" type="text" className={inputCls} placeholder="在学什么、目标是什么" value={newNote} onChange={(e) => setNewNote(e.target.value)} />
          </div>
        </div>
        <button
          type="submit"
          disabled={addSkill.isPending || !newName.trim()}
          className="mt-4 w-full rounded-lg bg-[var(--accent)] px-4 py-2.5 text-base font-semibold text-[#0b1520] disabled:opacity-50"
        >
          ＋ 添加技能
        </button>
        {addSkill.isError ? <p role="alert" className="mt-2 text-sm text-[var(--accent-2)]">添加失败，请重试。</p> : null}
      </form>

      <div className="mt-4 space-y-3">
        {data.skills.map((skill) => (
          <section key={skill.id} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
            {editingId === skill.id ? (
              <div>
                <div className="space-y-3">
                  <div>
                    <label htmlFor={`es-name-${skill.id}`} className="mb-1 block text-sm text-[var(--dim)]">技能名称</label>
                    <input id={`es-name-${skill.id}`} aria-label="编辑技能名称" type="text" className={inputCls} value={editName} onChange={(e) => setEditName(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor={`es-note-${skill.id}`} className="mb-1 block text-sm text-[var(--dim)]">备注</label>
                    <input id={`es-note-${skill.id}`} aria-label="编辑技能备注" type="text" className={inputCls} value={editNote} onChange={(e) => setEditNote(e.target.value)} />
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={updateSkill.isPending || !editName.trim()}
                    onClick={() => updateSkill.mutate(skill.id)}
                    className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b1520] disabled:opacity-50"
                  >
                    保存
                  </button>
                  <button type="button" onClick={() => setEditingId(null)} className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--dim)]">
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-display text-base font-bold">{skill.name}</h3>
                  {skill.note ? <p className="mt-0.5 text-sm text-[var(--dim)]">{skill.note}</p> : null}
                  <p className="tnum mt-1 text-sm text-[var(--dim)]">
                    输入 {skill.inputCount} 条 · 产出 {skill.convertedCount} 个 · 累计 {formatMinutes(skill.totalMinutes)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(skill.id);
                      setEditName(skill.name);
                      setEditNote(skill.note ?? "");
                    }}
                    className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)]"
                  >
                    编辑
                  </button>
                  {confirmDeleteId === skill.id ? (
                    <>
                      <button
                        type="button"
                        disabled={deleteSkill.isPending}
                        onClick={() => deleteSkill.mutate(skill.id)}
                        className="rounded-lg border border-[var(--accent-2)] px-3 py-1.5 text-sm font-medium text-[var(--accent-2)] disabled:opacity-50"
                      >
                        确认删除
                      </button>
                      <button type="button" onClick={() => setConfirmDeleteId(null)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)]">
                        不删
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirmDeleteId(skill.id)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--faint)]">
                      删除
                    </button>
                  )}
                </div>
              </div>
            )}
            {confirmDeleteId === skill.id ? (
              <p className="mt-2 text-xs text-[var(--dim)]">删除技能不会删账本记录，那些输入会变成「未关联技能」保留。</p>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}

/* ---------------- app ---------------- */

type Tab = "overview" | "ledger" | "skills";

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: () => api.getDashboard({}) });
  const data = dashboard.data;

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "overview", label: "总览" },
    { key: "ledger", label: "输入账本" },
    { key: "skills", label: "技能管理" },
  ];

  const loggedToday = data ? data.inputs.some((r) => r.date === data.today) : false;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pb-10">
        <nav aria-label="学习复利视图" className="sticky top-0 z-10 -mx-4 bg-[var(--bg)] px-4 pb-2 pt-3">
          <div role="tablist" className="flex gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`flex-1 rounded-lg px-3 py-2 text-sm ${tab === t.key ? "bg-[var(--surface-2)] font-semibold" : "text-[var(--dim)]"}`}
              >
                {t.label}
                {t.key === "ledger" && data && data.totals.unconvertedCount > 0
                  ? ` · ○ ${data.totals.unconvertedCount}`
                  : ""}
              </button>
            ))}
          </div>
        </nav>

        {dashboard.isPending ? (
          <p className="py-16 text-center text-sm text-[var(--dim)]">加载中…</p>
        ) : dashboard.isError || !data ? (
          <div className="py-16 text-center">
            <p className="text-sm text-[var(--dim)]">加载失败。</p>
            <button
              type="button"
              onClick={() => void dashboard.refetch()}
              className="mt-3 rounded-lg border border-[var(--border)] px-4 py-2 text-sm"
            >
              重试
            </button>
          </div>
        ) : tab === "overview" ? (
          <div>
            <section aria-label="复利总账" className="mt-2">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="tnum font-display text-6xl font-black leading-none">{data.totals.streakDays}</p>
                  <p className="mt-2 text-sm text-[var(--dim)]">当前连续学习天数（天）</p>
                </div>
                <p className="max-w-[180px] text-right text-sm leading-relaxed text-[var(--dim)]">
                  {data.totals.totalInputs === 0
                    ? "从第一笔输入开始滚。"
                    : loggedToday
                      ? "✓ 今天已记录，连续天数保住了。"
                      : "○ 今天还没记 — 记一笔，连续天数继续。"}
                </p>
              </div>
              <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
                {[
                  ["累计输入", `${data.totals.totalInputs} 条`],
                  ["累计转化产出", `${data.totals.totalConverted} 个`],
                  ["总转化率", pct(data.totals.conversionRate)],
                  ["累计投入", formatMinutes(data.totals.totalMinutes)],
                ].map(([label, value]) => (
                  <div key={label} className="bg-[var(--surface)] px-3 py-3">
                    <dt className="text-xs text-[var(--dim)]">{label}</dt>
                    <dd className="tnum mt-0.5 text-lg font-semibold">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
                <h2 className="font-display text-base font-bold">总积累曲线</h2>
                <div className="mt-2">
                  <CompoundChart series={data.series} />
                </div>
                <p className="mt-2 text-xs text-[var(--faint)]">
                  活跃学习日 {data.totals.activeDays} 天 · ○ 待转化 {data.totals.unconvertedCount} 条
                </p>
              </div>
            </section>

            <div className="mt-5">
              <QuickAdd data={data} />
            </div>

            <section aria-label="技能资产" className="mt-6">
              <h2 className="font-display text-xl font-bold">技能资产</h2>
              <div className="mt-3 space-y-3">
                {data.skills.map((skill) => (
                  <SkillCard key={skill.id} skill={skill} />
                ))}
              </div>
              {data.skills.length === 0 ? (
                <p className="mt-3 text-sm text-[var(--dim)]">还没有技能。去「技能管理」添加第一个在学的技能。</p>
              ) : null}
            </section>
          </div>
        ) : tab === "ledger" ? (
          <div className="mt-2">
            <QuickAdd data={data} />
            <div className="mt-6">
              <Ledger data={data} />
            </div>
          </div>
        ) : (
          <div className="mt-2">
            <SkillManager data={data} />
          </div>
        )}
      </main>
    </div>
  );
}
