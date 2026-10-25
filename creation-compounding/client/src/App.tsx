import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type Project = Dashboard["projects"][number];
type EntryRow = Dashboard["entries"][number];
type WeekPoint = Dashboard["series"][number];
type StageKey = Project["stages"][number]["stage"];

const STAGE_ORDER: StageKey[] = [
  "idea",
  "first_version",
  "shipped",
  "first_user",
  "first_payment",
];

const STAGE_LABEL: Record<StageKey, string> = {
  idea: "构思",
  first_version: "已做出首版",
  shipped: "内部提交 / 上线",
  first_user: "首位实际使用",
  first_payment: "首笔付费",
};

const STAGE_HINT: Record<StageKey, string> = {
  idea: "想法成形，开始动手",
  first_version: "第一个能跑的版本做出来了",
  shipped: "代码提交或产品上线",
  first_user: "自己以外的人真的用过",
  first_payment: "收到第一笔真实付费",
};

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
  return `${dt.getMonth() + 1}月${dt.getDate()}日当周`;
}

function isUrl(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text.trim());
}

const inputCls =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]";

/* ---------------- accumulation chart ---------------- */

function AccumulationChart({ series }: { series: WeekPoint[] }) {
  const W = 660;
  const H = 230;
  const padL = 36;
  const padR = 12;
  const padT = 16;
  const padB = 24;
  if (series.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-[var(--dim)]">
        还没有记录。标下第一个阶段、或记第一条产出，积累曲线从这里开始。
      </p>
    );
  }
  // Two fact lines on one week axis, distinguished by line style AND
  // marker shape AND legend text — never by color alone (色弱合规):
  // 成果记录 = solid line + filled circles (Okabe-Ito sky blue);
  // 阶段里程碑 = dashed line + hollow squares (Okabe-Ito orange).
  const maxY = Math.max(
    1,
    ...series.map((p) => Math.max(p.cumulativeEntries, p.cumulativeStages)),
  );
  const n = series.length;
  const x = (i: number) =>
    n === 1 ? padL + (W - padL - padR) / 2 : padL + (i * (W - padL - padR)) / (n - 1);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / maxY);
  const linePath = (pick: (p: WeekPoint) => number) =>
    series
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`)
      .join(" ");
  const last = series[n - 1];
  const gridVals = [0, Math.round(maxY / 2), maxY];
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`积累曲线（双线）：累计成果记录（实线）${last?.cumulativeEntries ?? 0} 条；已标记的阶段里程碑（虚线）${last?.cumulativeStages ?? 0} 个`}
      >
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
            <text x={padL - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--faint)" className="tnum">
              {v}
            </text>
          </g>
        ))}
        <path
          d={linePath((p) => p.cumulativeStages)}
          fill="none"
          stroke="var(--accent-2)"
          strokeWidth="2.5"
          strokeDasharray="7 5"
        />
        <path d={linePath((p) => p.cumulativeEntries)} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        {series.map((p, i) =>
          p.newEntries > 0 ? (
            <g key={`e-${p.weekStart}`}>
              <circle cx={x(i)} cy={y(p.cumulativeEntries)} r="4" fill="var(--accent)" />
              <text
                x={x(i)}
                y={y(p.cumulativeEntries) - 10}
                textAnchor="middle"
                fontSize="11"
                fill="var(--dim)"
                className="tnum"
              >
                +{p.newEntries}
              </text>
            </g>
          ) : null,
        )}
        {series.map((p, i) =>
          p.newStages > 0 ? (
            <g key={`s-${p.weekStart}`}>
              <rect
                x={x(i) - 4}
                y={y(p.cumulativeStages) - 4}
                width="8"
                height="8"
                fill="var(--surface)"
                stroke="var(--accent-2)"
                strokeWidth="2"
              />
              <text
                x={x(i)}
                y={y(p.cumulativeStages) + 20}
                textAnchor="middle"
                fontSize="11"
                fill="var(--dim)"
                className="tnum"
              >
                +{p.newStages}
              </text>
            </g>
          ) : null,
        )}
        <text x={padL} y={H - 6} fontSize="11" fill="var(--faint)">
          {series[0]?.weekStart ?? ""}
        </text>
        <text x={W - padR} y={H - 6} fontSize="11" fill="var(--faint)" textAnchor="end">
          {last?.weekStart ?? ""}
        </text>
      </svg>
      <div className="mt-1 space-y-1.5 text-sm text-[var(--dim)]">
        <p>
          <span
            aria-hidden="true"
            className="mr-1.5 inline-block h-0 w-6 border-t-[3px] border-solid align-middle"
            style={{ borderColor: "var(--accent)" }}
          />
          <span className="tnum">累计成果记录（实线 · 圆点）{last?.cumulativeEntries ?? 0} 条</span>
          — 账本里逐条记下的可验证产出，+N 是当周新增条数。
        </p>
        <p>
          <span
            aria-hidden="true"
            className="mr-1.5 inline-block h-0 w-6 border-t-[3px] border-dashed align-middle"
            style={{ borderColor: "var(--accent-2)" }}
          />
          <span className="tnum">已标记的阶段里程碑（虚线 · 方点）{last?.cumulativeStages ?? 0} 个</span>
          — 各项目阶段标尺上已标达成的阶段日期，+N 是当周新标记数；撤销阶段标记只回落这条线。
        </p>
        <p>
          两条线各数各的：一条阶段标记只是项目推进的记号，不等于真实用户或收入增长；没有新增的周两条线都走平，不补数据。
        </p>
      </div>
    </div>
  );
}

/* ---------------- stage ruler ---------------- */

function StageRuler({ project, today }: { project: Project; today: string }) {
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  const [marking, setMarking] = useState<StageKey | null>(null);
  const [markDate, setMarkDate] = useState(today);
  const [confirmClear, setConfirmClear] = useState<StageKey | null>(null);

  const [saveFailed, setSaveFailed] = useState(false);
  const setStage = useMutation({
    mutationFn: (stage: StageKey) =>
      api.setStage({ projectId: project.id, stage, date: markDate || today }),
    onSuccess: (res) => {
      if (!res.forbidden && res.ok) {
        setMarking(null);
        setSaveFailed(false);
      } else {
        setSaveFailed(true);
      }
      invalidate();
    },
    onError: () => setSaveFailed(true),
  });
  const clearStage = useMutation({
    mutationFn: (stage: StageKey) => api.clearStage({ projectId: project.id, stage }),
    onSuccess: (res) => {
      if (!res.forbidden && res.ok) {
        setConfirmClear(null);
        setSaveFailed(false);
      } else {
        setSaveFailed(true);
      }
      invalidate();
    },
    onError: () => setSaveFailed(true),
  });

  const dateByStage = new Map(project.stages.map((s) => [s.stage, s.date]));

  return (
    <div>
      <ol className="space-y-0">
        {STAGE_ORDER.map((stage, idx) => {
          const date = dateByStage.get(stage);
          const reached = date != null;
          return (
            <li key={stage} className="relative flex gap-3 pb-3 last:pb-0">
              {idx < STAGE_ORDER.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute left-[13px] top-7 h-[calc(100%-20px)] w-px bg-[var(--border)]"
                />
              ) : null}
              <span
                aria-hidden="true"
                className={`z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                  reached
                    ? "border-[var(--accent)] bg-[var(--surface-2)] text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--faint)]"
                }`}
              >
                {reached ? "✓" : idx + 1}
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className={`text-sm font-medium ${reached ? "" : "text-[var(--dim)]"}`}>
                    {idx + 1}. {STAGE_LABEL[stage]}
                    <span className="ml-2 text-xs font-normal text-[var(--faint)]">
                      {reached ? `✓ 已达成 · ${date}` : "○ 未达成"}
                    </span>
                  </p>
                  <div className="flex shrink-0 gap-1.5">
                    {reached ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setMarking(marking === stage ? null : stage);
                            setMarkDate(date);
                            setConfirmClear(null);
                          }}
                          className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--dim)]"
                        >
                          改日期
                        </button>
                        {confirmClear === stage ? (
                          <>
                            <button
                              type="button"
                              disabled={clearStage.isPending}
                              onClick={() => clearStage.mutate(stage)}
                              className="rounded-md border border-[var(--accent-2)] px-2 py-1 text-xs font-medium text-[var(--accent-2)] disabled:opacity-50"
                            >
                              确认撤销
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmClear(null)}
                              className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--dim)]"
                            >
                              不撤销
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmClear(stage)}
                            className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--faint)]"
                          >
                            撤销
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setMarking(marking === stage ? null : stage);
                          setMarkDate(today);
                          setConfirmClear(null);
                        }}
                        className="rounded-md border border-[var(--accent)] px-2 py-1 text-xs font-medium text-[var(--accent)]"
                      >
                        标记达成
                      </button>
                    )}
                  </div>
                </div>
                {!reached ? (
                  <p className="mt-0.5 text-xs text-[var(--faint)]">{STAGE_HINT[stage]}</p>
                ) : null}
                {marking === stage ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <div>
                      <label htmlFor={`stage-date-${project.id}-${stage}`} className="mb-1 block text-xs text-[var(--dim)]">
                        达成日期
                      </label>
                      <input
                        id={`stage-date-${project.id}-${stage}`}
                        aria-label={`「${STAGE_LABEL[stage]}」达成日期`}
                        type="date"
                        className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                        value={markDate}
                        onChange={(e) => setMarkDate(e.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      disabled={setStage.isPending}
                      onClick={() => setStage.mutate(stage)}
                      className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-[#0b1520] disabled:opacity-50"
                    >
                      {reached ? "保存日期" : "确认达成"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setMarking(null)}
                      className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--dim)]"
                    >
                      取消
                    </button>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {saveFailed || setStage.isError || clearStage.isError ? (
        <p role="alert" className="mt-2 text-sm text-[var(--accent-2)]">保存失败：阶段记录没有变动，请重试。</p>
      ) : null}
    </div>
  );
}

/* ---------------- project card ---------------- */

function ProjectCard({
  project,
  today,
  onAddProgress,
}: {
  project: Project;
  today: string;
  onAddProgress: (projectId: number) => void;
}) {
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(project.name);
  const [editNote, setEditNote] = useState(project.note ?? "");
  const [editNext, setEditNext] = useState(project.nextMilestone ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  // Stage ruler is collapsed by default; the fold state is local only,
  // so every fresh open of the page/tab starts collapsed.
  const [rulerOpen, setRulerOpen] = useState(false);

  const update = useMutation({
    mutationFn: () =>
      api.updateProject({
        id: project.id,
        name: editName.trim(),
        note: editNote.trim() || null,
        nextMilestone: editNext.trim() || null,
      }),
    onSuccess: (res) => {
      if (!res.forbidden && res.ok) setEditing(false);
      invalidate();
    },
  });
  const del = useMutation({
    mutationFn: () => api.deleteProject({ id: project.id }),
    onSuccess: (res) => {
      if (res.ok && !res.forbidden) {
        setDeleteError(false);
      } else {
        // The delete is atomic server-side: a refusal means NOTHING was
        // deleted. Say so plainly and keep the card (and its records)
        // on screen so the owner can retry from the same state.
        setDeleteError(true);
      }
      invalidate();
    },
    onError: () => setDeleteError(true),
  });

  const allDone = project.nextStage == null;
  // The card's single statement of the next milestone lives in the
  // header below; the ruler summary line only carries stage position.
  const rulerSummary = allDone
    ? `阶段 ${STAGE_ORDER.length} / ${STAGE_ORDER.length} · ✓ 五个阶段全部达成`
    : `阶段 ${project.currentStageIndex} / ${STAGE_ORDER.length} · 下一阶段：${STAGE_LABEL[project.nextStage as StageKey]}`;

  return (
    <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-bold leading-snug">{project.name}</h3>
          {project.note ? <p className="mt-0.5 text-sm text-[var(--dim)]">{project.note}</p> : null}
        </div>
        <span
          className={`tnum shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${
            allDone
              ? "border-[var(--accent-2)] text-[var(--accent-2)]"
              : "border-[var(--border)] text-[var(--dim)]"
          }`}
        >
          {allDone ? "✓ 阶段 5 / 5" : `阶段 ${project.currentStageIndex} / ${STAGE_ORDER.length}`}
        </span>
      </div>

      <p className="mt-2 text-sm">
        <span className="text-[var(--dim)]">下一里程碑：</span>
        {project.nextMilestone ??
          (allDone ? "五个阶段已走完 — 下一步由你定义" : STAGE_LABEL[project.nextStage as StageKey])}
      </p>
      <p className="tnum mt-1 text-sm text-[var(--dim)]">
        推进记录 {project.entryCount} 条
        {project.thisWeekCount > 0 ? ` · 本周 +${project.thisWeekCount}` : " · 本周暂无"}
        {project.lastEntryDate ? ` · 最近一条 ${project.lastEntryDate}` : ""}
      </p>

      <div className="mt-3 border-t border-[var(--border)] pt-3">
        <button
          type="button"
          aria-expanded={rulerOpen}
          aria-label={`${rulerOpen ? "收起" : "展开"}阶段标尺：${rulerSummary}`}
          onClick={() => setRulerOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span className="tnum text-sm">{rulerSummary}</span>
          <span aria-hidden="true" className="shrink-0 text-sm text-[var(--dim)]">
            {rulerOpen ? "▾ 收起" : "▸ 展开"}
          </span>
        </button>
        {rulerOpen ? (
          <div className="mt-3">
            <StageRuler project={project} today={today} />
          </div>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-4 border-t border-[var(--border)] pt-4">
          <div className="space-y-3">
            <div>
              <label htmlFor={`ep-name-${project.id}`} className="mb-1 block text-sm text-[var(--dim)]">项目名称</label>
              <input id={`ep-name-${project.id}`} aria-label="编辑项目名称" type="text" className={inputCls} value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div>
              <label htmlFor={`ep-note-${project.id}`} className="mb-1 block text-sm text-[var(--dim)]">备注（可选）</label>
              <input id={`ep-note-${project.id}`} aria-label="编辑项目备注" type="text" className={inputCls} placeholder="这是什么、给谁用" value={editNote} onChange={(e) => setEditNote(e.target.value)} />
            </div>
            <div>
              <label htmlFor={`ep-next-${project.id}`} className="mb-1 block text-sm text-[var(--dim)]">下一里程碑（可选，留空则按阶段标尺显示）</label>
              <input id={`ep-next-${project.id}`} aria-label="编辑下一里程碑" type="text" className={inputCls} placeholder="例如：把支付链接接上" value={editNext} onChange={(e) => setEditNext(e.target.value)} />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={update.isPending || !editName.trim()}
              onClick={() => update.mutate()}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b1520] disabled:opacity-50"
            >
              保存
            </button>
            <button type="button" onClick={() => setEditing(false)} className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--dim)]">
              取消
            </button>
          </div>
          {update.isError ? <p role="alert" className="mt-2 text-sm text-[var(--accent-2)]">保存失败，请重试。</p> : null}
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
          <button
            type="button"
            onClick={() => onAddProgress(project.id)}
            className="rounded-lg border border-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent)]"
          >
            ＋ 记一条产出
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              setEditName(project.name);
              setEditNote(project.note ?? "");
              setEditNext(project.nextMilestone ?? "");
            }}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)]"
          >
            编辑
          </button>
          {confirmDelete ? (
            <>
              <button
                type="button"
                disabled={del.isPending}
                onClick={() => {
                  setDeleteError(false);
                  del.mutate();
                }}
                className="rounded-lg border border-[var(--accent-2)] px-3 py-1.5 text-sm font-medium text-[var(--accent-2)] disabled:opacity-50"
              >
                确认删除项目
              </button>
              <button type="button" onClick={() => { setConfirmDelete(false); setDeleteError(false); }} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)]">
                不删
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--faint)]">
              删除
            </button>
          )}
        </div>
      )}
      {confirmDelete && !editing ? (
        <p className="mt-2 text-xs text-[var(--dim)]">删除项目会同时删掉它的阶段日期与全部推进记录。</p>
      ) : null}
      {deleteError ? (
        <p role="alert" className="mt-2 text-sm text-[var(--accent-2)]">
          删除失败：项目、阶段日期与推进记录都还完整保留，一条也没有删掉。点「确认删除项目」可直接重试。
        </p>
      ) : null}
    </section>
  );
}

/* ---------------- add progress form ---------------- */

function AddProgressForm({
  data,
  projectId,
  onProjectChange,
}: {
  data: Dashboard;
  projectId: string;
  onProjectChange: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const add = useMutation({
    mutationFn: () =>
      api.addProgress({
        projectId: Number(projectId),
        date: date || data.today,
        description: description.trim(),
        evidence: evidence.trim(),
        note: note.trim() || undefined,
      }),
    onSuccess: (res) => {
      if (res.forbidden) {
        setError("当前身份无权记录：创造数据仅所有者可写。");
        void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        return;
      }
      if (res.duplicate) {
        setError("这条成果已经记过一次（同一项目、同一日期、相同产出与证据），同一成果不重复累计。");
        return;
      }
      if (res.code === "project_deleted") {
        // The project was deleted while this entry was being saved, so
        // the entry is gone with it. The draft stays exactly as typed —
        // only the dead project selection is cleared — so the user can
        // re-file the same entry under another project.
        setError("所选项目已被删除，这条记录没有保存。填写内容已保留——换一个项目再提交即可。");
        onProjectChange("");
        void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        return;
      }
      if (!res.ok) {
        setError("保存失败，请重试。");
        return;
      }
      setDescription("");
      setEvidence("");
      setNote("");
      setError(null);
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => setError(`保存失败：${String(e)}`),
  });

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setSaved(false);
    if (!projectId) {
      setError("先选一个项目。");
      return;
    }
    if (!description.trim()) {
      setError("写下这条可验证的产出是什么。");
      return;
    }
    if (!evidence.trim()) {
      setError("每条记录都要有成果 / 证据引用：一个链接，或一句话说明成果在哪。");
      return;
    }
    add.mutate();
  };

  if (data.projects.length === 0) {
    return (
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="font-display text-lg font-bold">记一条产出</h2>
        <p className="mt-1 text-sm text-[var(--dim)]">先在「项目」里添加一个自有产品 / 项目，再回来记它的推进。</p>
        {error ? <p role="alert" className="mt-2 text-sm text-[var(--accent-2)]">{error}</p> : null}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="font-display text-lg font-bold">记一条产出</h2>
      <p className="mt-1 text-sm text-[var(--dim)]">
        只记产出，不记学习输入。每条要有日期、产出描述和证据引用；同一成果只记一次。
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="ap-project" className="mb-1 block text-sm text-[var(--dim)]">项目</label>
          <select id="ap-project" aria-label="项目" className={inputCls} value={projectId} onChange={(e) => onProjectChange(e.target.value)}>
            <option value="">选择项目…</option>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ap-date" className="mb-1 block text-sm text-[var(--dim)]">日期</label>
          <input id="ap-date" aria-label="日期" type="date" className={inputCls} value={date || data.today} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
      <div className="mt-3">
        <label htmlFor="ap-desc" className="mb-1 block text-sm text-[var(--dim)]">产出描述</label>
        <input id="ap-desc" aria-label="产出描述" type="text" className={inputCls} placeholder="例如：v0.2 上线，落地页可访问" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="mt-3">
        <label htmlFor="ap-evidence" className="mb-1 block text-sm text-[var(--dim)]">成果 / 证据引用</label>
        <input id="ap-evidence" aria-label="成果或证据引用" type="text" className={inputCls} placeholder="链接，或一句话说明成果在哪（如：仓库 tag v0.2）" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      </div>
      <div className="mt-3">
        <label htmlFor="ap-note" className="mb-1 block text-sm text-[var(--dim)]">备注（可选，如投入时长 — 只作备注，不折算进度）</label>
        <input id="ap-note" aria-label="备注" type="text" className={inputCls} placeholder="例如：约 2 小时" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-[var(--accent-2)]">{error}</p> : null}
      {saved && !error ? <p className="mt-3 text-sm text-[var(--accent)]">✓ 已记入账本。</p> : null}
      <button
        type="submit"
        disabled={add.isPending}
        className="mt-4 w-full rounded-lg bg-[var(--accent)] px-4 py-3 text-base font-semibold text-[#0b1520] disabled:opacity-50"
      >
        {add.isPending ? "保存中…" : "＋ 记入账本"}
      </button>
    </form>
  );
}

/* ---------------- ledger ---------------- */

function EntryCard({ row, today }: { row: EntryRow; today: string }) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useMutation({
    mutationFn: () => api.deleteProgress({ id: row.id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
  });
  return (
    <article className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium leading-snug">{row.description}</p>
        <span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-medium text-[var(--dim)]">
          {row.projectName}
        </span>
      </div>
      <p className="mt-1.5 text-sm text-[var(--dim)]">{formatDay(row.date, today)}</p>
      <p className="mt-2 break-words text-sm">
        <span className="text-[var(--dim)]">证据：</span>
        {isUrl(row.evidence) ? (
          <a
            href={row.evidence.trim()}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent)] underline underline-offset-2"
          >
            {row.evidence.trim()}
          </a>
        ) : (
          row.evidence
        )}
      </p>
      {row.note ? <p className="mt-1 text-sm text-[var(--dim)]">备注：{row.note}</p> : null}
      <div className="mt-3 flex gap-2">
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
      {del.isError ? <p role="alert" className="mt-2 text-sm text-[var(--accent-2)]">删除失败，请重试。</p> : null}
    </article>
  );
}

function Ledger({ data, projectFilter, onFilterChange }: { data: Dashboard; projectFilter: string; onFilterChange: (v: string) => void }) {
  const filtered = useMemo(
    () => data.entries.filter((e) => projectFilter === "all" || e.projectId === Number(projectFilter)),
    [data.entries, projectFilter],
  );
  const groups = useMemo(() => {
    const out: Array<{ date: string; rows: EntryRow[] }> = [];
    for (const row of filtered) {
      const lastGroup = out[out.length - 1];
      if (lastGroup && lastGroup.date === row.date) lastGroup.rows.push(row);
      else out.push({ date: row.date, rows: [row] });
    }
    return out;
  }, [filtered]);

  return (
    <div>
      <div className="flex items-center gap-2">
        <select
          aria-label="按项目筛选"
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
          value={projectFilter}
          onChange={(e) => onFilterChange(e.target.value)}
        >
          <option value="all">全部项目</option>
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <p className="tnum text-sm text-[var(--dim)]">共 {filtered.length} 条</p>
      </div>
      {data.entries.length === 0 ? (
        <p className="mt-6 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6 text-center text-sm text-[var(--dim)]">
          账本还是空的。用上面的「记一条产出」记下第一个项目的第一次推进。
        </p>
      ) : filtered.length === 0 ? (
        <p className="mt-6 text-center text-sm text-[var(--dim)]">这个项目还没有推进记录。</p>
      ) : (
        groups.map((g) => (
          <div key={g.date} className="mt-5">
            <h3 className="text-sm font-medium text-[var(--dim)]">{formatDay(g.date, data.today)}</h3>
            <div className="mt-2 space-y-3">
              {g.rows.map((row) => (
                <EntryCard key={row.id} row={row} today={data.today} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/* ---------------- add project form ---------------- */

function AddProjectForm() {
  const queryClient = useQueryClient();
  // Collapsed behind the 「＋ 新增项目」 button by default; local state
  // only, so every fresh open starts collapsed.
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      api.addProject({
        name: name.trim(),
        note: note.trim() || undefined,
        nextMilestone: next.trim() || undefined,
      }),
    onSuccess: (res) => {
      if (res.forbidden) {
        setError("当前身份无权记录：创造数据仅所有者可写。");
      } else if (res.ok) {
        setName("");
        setNote("");
        setNext("");
        setError(null);
      }
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => setError(`保存失败：${String(e)}`),
  });

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!name.trim()) {
      setError("先给项目起个名字。");
      return;
    }
    add.mutate();
  };

  if (!open) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="w-full rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-base font-medium text-[var(--accent)]"
      >
        ＋ 新增项目
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-lg font-bold">新增项目</h2>
        <button
          type="button"
          aria-expanded={true}
          onClick={() => setOpen(false)}
          className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--dim)]"
        >
          收起
        </button>
      </div>
      <p className="mt-1 text-sm text-[var(--dim)]">一个自有产品 / 项目一张卡，阶段标尺各记各的，互不折算。</p>
      <div className="mt-3 space-y-3">
        <div>
          <label htmlFor="np-name" className="mb-1 block text-sm text-[var(--dim)]">项目名称</label>
          <input id="np-name" aria-label="项目名称" type="text" className={inputCls} placeholder="例如：我的小工具" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="np-note" className="mb-1 block text-sm text-[var(--dim)]">备注（可选）</label>
          <input id="np-note" aria-label="项目备注" type="text" className={inputCls} placeholder="这是什么、给谁用" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div>
          <label htmlFor="np-next" className="mb-1 block text-sm text-[var(--dim)]">下一里程碑（可选）</label>
          <input id="np-next" aria-label="下一里程碑" type="text" className={inputCls} placeholder="例如：做出第一个能跑的版本" value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-[var(--accent-2)]">{error}</p> : null}
      <button
        type="submit"
        disabled={add.isPending || !name.trim()}
        className="mt-4 w-full rounded-lg bg-[var(--accent)] px-4 py-2.5 text-base font-semibold text-[#0b1520] disabled:opacity-50"
      >
        ＋ 添加项目
      </button>
    </form>
  );
}

/* ---------------- app ---------------- */

type Tab = "week" | "projects" | "ledger";

export function App() {
  const [tab, setTab] = useState<Tab>("week");
  const [formProjectId, setFormProjectId] = useState<string>("");
  const [ledgerFilter, setLedgerFilter] = useState<string>("all");
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: () => api.getDashboard({}) });
  const data = dashboard.data;

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "week", label: "本周" },
    { key: "projects", label: "项目" },
    { key: "ledger", label: "推进账本" },
  ];

  const goAddProgress = (projectId: number) => {
    setFormProjectId(String(projectId));
    setLedgerFilter("all");
    setTab("ledger");
  };

  // Owner-only data: a refused dashboard renders no creation data and
  // no write entry points at all — just the permission notice.
  if (data?.forbidden) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto w-full max-w-3xl px-4 pb-10">
          <div className="py-16 text-center">
            <h1 className="font-display text-xl font-bold">创造数据仅所有者可查看</h1>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--dim)]">
              这里记录的是所有者的自有产品推进账本，当前访问身份无权查看，也不能写入或删除任何记录。
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pb-10">
        <nav aria-label="创造复利视图" className="sticky top-0 z-10 -mx-4 bg-[var(--bg)] px-4 pb-2 pt-3">
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
                {t.key === "week" && data && data.totals.thisWeekCount > 0
                  ? ` · +${data.totals.thisWeekCount}`
                  : ""}
              </button>
            ))}
          </div>
        </nav>

        {data && data.reconciliation.length > 0 ? (
          <section
            aria-label="重复记录对账"
            className="mt-3 rounded-[var(--radius)] border border-[var(--accent-2)] bg-[var(--surface)] p-4"
          >
            <h2 className="font-display text-base font-bold">
              重复记录对账 · {data.reconciliation.length} 组
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
              下面是早期写入留下的重复记录：已全部原样保留，没有自动删除或合并，目前仍计入总数。
              要清理时，在账本里逐条删掉多余的产出，或在项目阶段标尺上逐个「撤销」重复阶段。
            </p>
            <ul className="mt-2 space-y-1.5 text-sm">
              {data.reconciliation.map((g) => (
                <li key={`${g.kind}-${g.ids.join("-")}`} className="leading-relaxed">
                  {g.kind === "progress" ? (
                    <>
                      产出 ×{g.count}：项目「{g.projectName}」· {g.date} · {g.description}
                      <span className="text-[var(--dim)]">（证据：{g.evidence}）</span>
                      <span className="text-[var(--faint)]"> · 记录 #{g.ids.join("、#")}</span>
                    </>
                  ) : (
                    <>
                      阶段 ×{g.count}：项目「{g.projectName}」· 阶段「
                      {g.stage ? STAGE_LABEL[g.stage] : g.stage}」
                      <span className="text-[var(--dim)]">（日期：{g.dates.join("、")}）</span>
                      <span className="text-[var(--faint)]"> · 记录 #{g.ids.join("、#")}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

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
        ) : tab === "week" ? (
          <div>
            <section aria-label="本周推进" className="mt-2">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="tnum font-display text-6xl font-black leading-none">{data.totals.thisWeekCount}</p>
                  <p className="mt-2 text-sm text-[var(--dim)]">
                    本周新增可验证产出（条）· {formatWeek(data.weekStart)}起
                  </p>
                </div>
                <p className="max-w-[180px] text-right text-sm leading-relaxed text-[var(--dim)]">
                  {data.totals.totalEvents === 0
                    ? "从第一个里程碑开始滚。"
                    : data.totals.thisWeekCount > 0
                      ? "✓ 本周已经推进了 — 复利又多滚了一周。"
                      : "○ 本周还没记产出 — 推进一点点，记下来。"}
                </p>
              </div>
              <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
                {[
                  ["累计里程碑 + 产出", `${data.totals.totalEvents} 个`],
                  ["已达成阶段", `${data.totals.totalStagesReached} 个`],
                  ["推进记录", `${data.totals.totalEntries} 条`],
                  ["有记录的周", `${data.totals.activeWeeks} 周`],
                ].map(([label, value]) => (
                  <div key={label} className="bg-[var(--surface)] px-3 py-3">
                    <dt className="text-xs text-[var(--dim)]">{label}</dt>
                    <dd className="tnum mt-0.5 text-lg font-semibold">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section aria-label="本周各项目" className="mt-6">
              <h2 className="font-display text-xl font-bold">本周各项目</h2>
              {data.projects.length === 0 ? (
                <p className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6 text-center text-sm text-[var(--dim)]">
                  还没有任何项目。去「项目」添加第一个自有产品 / 项目，账本从那里开始。
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {data.projects.map((p) => (
                    <section key={p.id} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="font-display text-base font-bold leading-snug">{p.name}</h3>
                        <span
                          className={`tnum shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${
                            p.thisWeekCount > 0
                              ? "border-[var(--accent)] text-[var(--accent)]"
                              : "border-[var(--border)] text-[var(--dim)]"
                          }`}
                        >
                          {p.thisWeekCount > 0 ? `✓ 本周 +${p.thisWeekCount} 条` : "○ 本周暂无产出"}
                        </span>
                      </div>
                      <p className="mt-1.5 text-sm">
                        <span className="text-[var(--dim)]">下一里程碑：</span>
                        {p.nextMilestone ??
                          (p.nextStage ? STAGE_LABEL[p.nextStage] : "五个阶段已全部达成 ✓")}
                      </p>
                      <p className="tnum mt-1 text-xs text-[var(--faint)]">
                        当前阶段 {p.currentStageIndex} / {STAGE_ORDER.length}
                        {p.nextStage ? ` · 下一阶段「${STAGE_LABEL[p.nextStage]}」` : ""}
                      </p>
                    </section>
                  ))}
                </div>
              )}
            </section>

            {data.thisWeekEntries.length > 0 ? (
              <section aria-label="本周产出明细" className="mt-6">
                <h2 className="font-display text-xl font-bold">本周产出明细</h2>
                <div className="mt-3 space-y-3">
                  {data.thisWeekEntries.slice(0, 5).map((row) => (
                    <EntryCard key={row.id} row={row} today={data.today} />
                  ))}
                </div>
                {data.thisWeekEntries.length > 5 ? (
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <p className="tnum text-sm text-[var(--dim)]">
                      本周共 {data.thisWeekEntries.length} 条，这里只列最近 5 条
                    </p>
                    <button
                      type="button"
                      onClick={() => setTab("ledger")}
                      className="shrink-0 rounded-lg border border-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent)]"
                    >
                      查看全部 →
                    </button>
                  </div>
                ) : null}
              </section>
            ) : null}

            <section aria-label="积累曲线" className="mt-6">
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
                <h2 className="font-display text-base font-bold">积累曲线（按周）：成果记录 × 阶段里程碑</h2>
                <div className="mt-2">
                  <AccumulationChart series={data.series} />
                </div>
              </div>
            </section>
          </div>
        ) : tab === "projects" ? (
          <div className="mt-2">
            <AddProjectForm />
            <div className="mt-5 space-y-3">
              {data.projects.map((p) => (
                <ProjectCard key={p.id} project={p} today={data.today} onAddProgress={goAddProgress} />
              ))}
            </div>
            {data.projects.length === 0 ? (
              <p className="mt-4 text-center text-sm text-[var(--dim)]">
                还没有项目。点上面的「＋ 新增项目」添加第一个 — 名称、当前阶段、下一里程碑都从它开始。
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mt-2">
            <AddProgressForm data={data} projectId={formProjectId} onProjectChange={setFormProjectId} />
            <div className="mt-6">
              <Ledger data={data} projectFilter={ledgerFilter} onFilterChange={setLedgerFilter} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
