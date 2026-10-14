import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import {
Area,
AreaChart,
Bar,
BarChart,
CartesianGrid,
Line,
LineChart,
PolarAngleAxis,
PolarGrid,
Radar,
RadarChart,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";

type DashboardResponse = ApiResponse<typeof api, "getDashboard">;
type Snapshot = NonNullable<DashboardResponse["snapshot"]>;
type Readiness = NonNullable<DashboardResponse["readiness"]>;
type TrendPoint = Snapshot["trends"][number];
type Daily = Snapshot["historyDaily"][number];
type StrengthWorkout = Snapshot["strengthTraining"]["workouts"][number];
type Tab = "today" | "trends" | "history";
type Status = "正常" | "偏低" | "偏高" | "数据缺失";

const ROUTINE_LABELS: Record<StrengthWorkout["routine"], string> = { push: "推", pull: "拉", legs: "腿" };

function statusClass(status: Status): string {
  if (status === "正常") return "status-ok";
  if (status === "数据缺失") return "status-missing";
  return "status-watch";
}

function dateLabel(date: string): string {
  const [, month = "", day = ""] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function fullDateLabel(date: string): string {
  const [year = "", month = "", day = ""] = date.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function updatedLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function numberLabel(value: number | null, digits = 0): string {
  if (value === null) return "—";
  return value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function volumeLabel(value: number): string {
  return Math.round(value).toLocaleString("zh-CN");
}

function durationLabel(value: number | null): string {
  if (value === null) return "进行中";
  if (value < 60) return `${Math.round(value)} 分钟`;
  return `${Math.floor(value / 60)} 小时 ${Math.round(value % 60)} 分`;
}

function actualSleepHours(sleep: Pick<Snapshot["sleep"], "coreHours" | "deepHours" | "remHours" | "inBedHours">): number {
  const stageTotal = (sleep.coreHours ?? 0) + (sleep.deepHours ?? 0) + (sleep.remHours ?? 0);
  return stageTotal > 0 ? stageTotal : sleep.inBedHours;
}

function Kpi({ label, value, unit, detail, status }: { label: string; value: string; unit?: string; detail: string; status: Status }) {
  return (
    <div className="kpi">
      <div className="kpi-topline"><span>{label}</span><span className={`status-chip ${statusClass(status)}`}>{status}</span></div>
      <div className="kpi-value">{value}{unit ? <span>{unit}</span> : null}</div>
      <p>{detail}</p>
    </div>
  );
}

function MetricBars({ title, unit, points, getValue, baseline, formatValue }: {
  title: string; unit: string; points: TrendPoint[]; getValue: (point: TrendPoint) => number | null; baseline: number; formatValue: (value: number) => string;
}) {
  const values = points.map(getValue).filter((value): value is number => value !== null);
  const max = Math.max(...values, baseline, 1);
  return (
    <section className="trend-block" aria-label={`${title}近7天趋势`}>
      <div className="section-line"><h3>{title}</h3><span>基线 {formatValue(baseline)} {unit}</span></div>
      <div className="bar-chart">
        {points.map((point) => {
          const value = getValue(point);
          const height = value === null ? 12 : Math.max(12, Math.round((value / max) * 92));
          return (
            <div className="bar-column" key={`${title}-${point.date}`}>
              <span className={`bar-value ${value === null ? "missing-text" : ""}`}>{value === null ? "缺失" : formatValue(value)}</span>
              <div className={`bar ${value === null ? "bar-missing" : ""}`} style={{ height: `${height}px` }} aria-label={`${dateLabel(point.date)} ${value === null ? "缺失" : `${formatValue(value)} ${unit}`}`} />
              <span className="bar-date">{dateLabel(point.date)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SleepPanel({ sleep }: { sleep: Snapshot["sleep"] }) {
  const actualHours = actualSleepHours(sleep);
  const hasStages = sleep.coreHours !== null && sleep.deepHours !== null && sleep.remHours !== null;
  const timelineHours = actualHours + (sleep.awakeMinutes ?? 0) / 60;
  const pct = (value: number) => `${Math.max(0, (value / Math.max(timelineHours, 0.01)) * 100)}%`;
  return (
    <section className="sleep-panel" aria-labelledby="sleep-title">
      <div className="section-heading">
        <div><p className="section-kicker">昨晚睡眠</p><h2 id="sleep-title">{actualHours.toFixed(1)} 小时</h2></div>
        <span className={`status-chip ${statusClass(sleep.status)}`}>{sleep.status}</span>
      </div>
      <div className="sleep-clock"><div><span>入睡</span><strong>{sleep.bedtime}</strong></div><div className="sleep-line" aria-hidden="true" /><div><span>起床</span><strong>{sleep.wakeTime}</strong></div></div>
      {hasStages ? (
        <>
          <div className="sleep-stages" aria-label="睡眠分期">
            <span className="stage-core" style={{ width: pct(sleep.coreHours ?? 0) }} /><span className="stage-deep" style={{ width: pct(sleep.deepHours ?? 0) }} />
            <span className="stage-rem" style={{ width: pct(sleep.remHours ?? 0) }} /><span className="stage-awake" style={{ width: pct((sleep.awakeMinutes ?? 0) / 60) }} />
          </div>
          <div className="stage-legend">
            <span><i className="dot core" />浅睡 <b>{(sleep.coreHours ?? 0).toFixed(1)}h</b></span><span><i className="dot deep" />深睡 <b>{Math.round((sleep.deepHours ?? 0) * 60)}m</b></span><span><i className="dot rem" />REM <b>{(sleep.remHours ?? 0).toFixed(1)}h</b></span>
          </div>
        </>
      ) : <p className="empty-inline">本次同步暂未返回睡眠分期。</p>}
      <div className="sleep-stats"><div><span>质量</span><strong>{numberLabel(sleep.quality)}</strong></div><div><span>效率</span><strong>{sleep.efficiency === null ? "—" : `${sleep.efficiency.toFixed(1)}%`}</strong></div><div><span>醒来</span><strong>{sleep.awakenings === null ? "—" : `${sleep.awakenings} 次`}</strong></div></div>
    </section>
  );
}

function StrengthPanel({ strength }: { strength: Snapshot["strengthTraining"] }) {
  const workouts = [...strength.workouts].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const latest = workouts[0];
  const currentWeek = strength.weeklyTrend[strength.weeklyTrend.length - 1];
  const previousWeek = strength.weeklyTrend[strength.weeklyTrend.length - 2];
  const delta = currentWeek && previousWeek && previousWeek.volume > 0
    ? Math.round(((currentWeek.volume - previousWeek.volume) / previousWeek.volume) * 100)
    : null;

  return (
    <section className="strength-panel" aria-labelledby="strength-title">
      <div className="section-heading">
        <div><p className="section-kicker">训练记录</p><h2 id="strength-title">力量训练</h2></div>
        <span className="record-count">{currentWeek?.sessions ?? 0} 次 / 本周</span>
      </div>
      {latest ? (
        <>
          <div className="strength-latest">
            <div className={`routine-badge routine-${latest.routine}`}><span>{dateLabel(latest.date)}</span><strong>{ROUTINE_LABELS[latest.routine]}</strong></div>
            <div className="strength-primary"><span>{latest.status === "active" ? "当前已完成训练量" : "总训练量"}</span><strong>{volumeLabel(latest.totalVolume)} <small>{latest.unit}</small></strong><p>{latest.completedSets}/{latest.totalSets} 组 · {durationLabel(latest.durationMinutes)}</p></div>
          </div>
          <div className="strength-week">
            <div><span>本周负荷</span><strong>{volumeLabel(currentWeek?.volume ?? 0)} {strength.displayUnit}</strong></div>
            <div><span>对比上周</span><strong>{delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta}%`}</strong></div>
          </div>
          <p className="strength-note">仅计算已完成且同时填写重量与次数的组。</p>
        </>
      ) : <p className="empty-inline">{strength.note}</p>}
    </section>
  );
}

function ReadinessPanel({ readiness }: { readiness: Readiness }) {
  const queryClient = useQueryClient();
  const [feeling, setFeeling] = useState(readiness.morningFeeling ?? 5);
  useEffect(() => setFeeling(readiness.morningFeeling ?? 5), [readiness.morningFeeling]);
  const saveFeeling = useMutation({
    mutationFn: () => api.saveMorningCheckin({ date: readiness.date, feeling }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
  });
  const scoreStyle = { "--readiness-score": (readiness.score ?? 0) * 10 } as CSSProperties;
  return (
    <section className="readiness-panel" aria-labelledby="readiness-title">
      <div className="readiness-score-wrap">
        <div className={`readiness-ring readiness-${readiness.status}`} style={scoreStyle} role="img" aria-label={readiness.score === null ? "身体准备度数据不足" : `身体准备度 ${readiness.score} 分，满分 10 分`}>
          <div><strong>{readiness.score ?? "—"}</strong><span>/ 10</span></div>
        </div>
        <div className="readiness-copy">
          <div className="readiness-meta"><p className="section-kicker">身体准备度 · {dateLabel(readiness.date)}</p><span className={`confidence confidence-${readiness.confidence}`}>置信度{readiness.confidence} · {readiness.signalCount} 项</span></div>
          <h2 id="readiness-title">{readiness.status}</h2>
          <p>{readiness.summary}</p>
          {readiness.sleepDebtHours !== null ? <p className="sleep-debt">7 天睡眠债 <strong>{readiness.sleepDebtHours.toFixed(1)}h</strong></p> : null}
        </div>
      </div>

      <div className="readiness-radar" aria-label="睡眠、恢复、运动、心肺、生命体征五维雷达图">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={readiness.radar} outerRadius="68%">
            <PolarGrid stroke="var(--grid)" />
            <PolarAngleAxis dataKey="label" tick={{ fill: "var(--dim)", fontSize: 10 }} />
            <Radar dataKey="score" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.2} strokeWidth={2} />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      <form className="morning-checkin" onSubmit={(event) => { event.preventDefault(); saveFeeling.mutate(); }}>
        <div><label htmlFor="morning-feeling">今天感觉</label><output htmlFor="morning-feeling">{feeling}/10</output></div>
        <input id="morning-feeling" aria-label="今天感觉 1 到 10" type="range" min="1" max="10" step="1" value={feeling} onChange={(event) => setFeeling(Number(event.target.value))} />
        <button type="submit" disabled={saveFeeling.isPending}>{saveFeeling.isPending ? "保存中…" : readiness.morningFeeling === null ? "保存晨检" : "更新晨检"}</button>
        <p>{saveFeeling.isSuccess ? "已保存；感觉好不会上调客观分，感觉差只会保守下调。" : "只向保守方向修正客观分。"}</p>
      </form>

      {readiness.adjustments.length ? <div className="readiness-adjustments" aria-label="保守修正规则">{readiness.adjustments.map((item) => <p key={item}>{item}</p>)}</div> : null}

      <details className="readiness-drivers">
        <summary>谁在拉分</summary>
        <div className="readiness-components" aria-label="身体准备度组成">
          {readiness.components.map((component) => (
            <div className="readiness-component" key={component.key}>
              <div><span>{component.label}</span><small>原权重 {component.weight}%</small></div>
              <strong>{component.score ?? "—"}</strong>
              <dl><div><dt>原始值</dt><dd>{component.raw}</dd></div><div><dt>滚动基线</dt><dd>{component.baseline}</dd></div><div><dt>贡献</dt><dd>{component.contribution === null ? "未纳入" : `${component.contribution > 0 ? "+" : ""}${component.contribution.toFixed(2)} z`}</dd></div></dl>
              <p>{component.missingLabel ? <span className="missing-pill">{component.missingLabel}</span> : null}{component.detail}</p>
            </div>
          ))}
        </div>
      </details>
      <details className="readiness-method">
        <summary>评分方法</summary>
        <p>总分 = 5 + 2.0 × 加权平均 z，钳制到 0–10。HRV 32.5%（先取 ln）、静息心率 25%、昨晚睡眠 10%、7 天睡眠银行 10%、训练负荷 15%、呼吸频率 5%；呼吸只在升高时扣分。每项至少有 8 个历史读数才纳入；缺项权重按可用信号重新归一化。睡眠按时长 50 / 就寝规律 30 / 中断 20 评分。</p>
        <p>HRV 被压制且静息心率升高，或睡眠债超过 3 小时，都会直接降一档。腕温不纳入。分数看趋势不看单日；静息心率是跨设备最准的指标。这只是健康参考，不做诊断，身体不适请及时看医生。</p>
      </details>
    </section>
  );
}

function TodayView({ snapshot, readiness }: { snapshot: Snapshot; readiness: Readiness | null }) {
  const missing = [snapshot.restingHr.value === null ? "静息心率" : null, snapshot.hrv.value === null ? "HRV" : null].filter(Boolean).join("、");
  const stepSummary = snapshot.steps.status === "正常" ? "步数在常见范围" : snapshot.steps.status === "数据缺失" ? "步数未记录" : `步数${snapshot.steps.status}`;
  const sleepHours = actualSleepHours(snapshot.sleep);
  return (
    <div className="today-view">
      {readiness ? <ReadinessPanel readiness={readiness} /> : null}
      <section className="verdict" aria-labelledby="verdict-title">
        <p>昨日概览</p>
        <h1 id="verdict-title"><span>{numberLabel(snapshot.steps.value)}</span> 步，{stepSummary}；睡眠 <em>{sleepHours.toFixed(1)} 小时</em>。</h1>
        {missing ? <div className="missing-note"><span aria-hidden="true" />{snapshot.dataDate} {missing}无记录 · {snapshot.coverageIncomplete ? "还没同步完" : "当天没戴表"}</div> : null}
      </section>
      <section className="kpi-board" aria-label="关键健康指标">
        <Kpi label="步数" value={numberLabel(snapshot.steps.value)} detail={`基线约 ${numberLabel(snapshot.steps.baseline)} · ${snapshot.steps.distanceKm?.toFixed(2) ?? "—"} km`} status={snapshot.steps.status} />
        <Kpi label="静息心率" value={numberLabel(snapshot.restingHr.value, 1)} unit="bpm" detail={`基线约 ${snapshot.restingHr.baseline} · 常见 ${snapshot.restingHr.usualMin}–${snapshot.restingHr.usualMax}`} status={snapshot.restingHr.status} />
        <Kpi label="HRV" value={numberLabel(snapshot.hrv.value, 1)} unit="ms" detail={`基线约 ${snapshot.hrv.baseline} · 常见 ${snapshot.hrv.usualMin}–${snapshot.hrv.usualMax}`} status={snapshot.hrv.status} />
        <Kpi label="睡眠" value={sleepHours.toFixed(1)} unit="h" detail={`质量 ${numberLabel(snapshot.sleep.quality)} · 效率 ${snapshot.sleep.efficiency?.toFixed(1) ?? "—"}%`} status={snapshot.sleep.status} />
      </section>
      <StrengthPanel strength={snapshot.strengthTraining} />
      {snapshot.morningReference ? (
        <section className="morning-strip" aria-label="今晨参考">
          <div><span>今晨参考 · {dateLabel(snapshot.morningReference.date)}</span><strong>HRV {numberLabel(snapshot.morningReference.hrvMs, 1)} ms</strong></div>
          <div><span>平均心率</span><strong>{numberLabel(snapshot.morningReference.avgHrBpm, 1)} bpm</strong></div>
          <p>今日数据仍在累计，不与完整日比较。</p>
        </section>
      ) : null}
      <SleepPanel sleep={snapshot.sleep} />
      <section className="workout-line" aria-label="运动记录"><div><span>近7天运动</span><strong>{snapshot.workouts.count7d} 次</strong></div><p>{snapshot.workouts.note}</p></section>
    </div>
  );
}

function ChartPanel({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return <section className="chart-panel"><div className="chart-title"><span>{eyebrow}</span><h2>{title}</h2></div><div className="chart-frame">{children}</div></section>;
}

const tooltipStyle = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 };

function TrendsView({ snapshot }: { snapshot: Snapshot }) {
  const history = useMemo(() => snapshot.historyDaily.slice(-30).map((row) => ({ ...row, label: dateLabel(row.date) })), [snapshot.historyDaily]);
  return (
    <div className="trends-view">
      <section className="trends" aria-labelledby="trends-title">
        <div className="section-heading"><div><p className="section-kicker">近7天</p><h2 id="trends-title">短期趋势</h2></div><span className="trend-range">{dateLabel(snapshot.trends[0]?.date ?? snapshot.dataDate)}–{dateLabel(snapshot.trends[snapshot.trends.length - 1]?.date ?? snapshot.dataDate)}</span></div>
        <MetricBars title="步数" unit="步" points={snapshot.trends} getValue={(point) => point.stepCount} baseline={snapshot.steps.baseline} formatValue={(value) => Math.round(value).toLocaleString("zh-CN")} />
        <MetricBars title="静息心率" unit="bpm" points={snapshot.trends} getValue={(point) => point.restingHrBpm} baseline={snapshot.restingHr.baseline} formatValue={(value) => value.toFixed(value % 1 === 0 ? 0 : 1)} />
        <MetricBars title="HRV" unit="ms" points={snapshot.trends} getValue={(point) => point.hrvMs} baseline={snapshot.hrv.baseline} formatValue={(value) => value.toFixed(value % 1 === 0 ? 0 : 1)} />
      </section>

      <section className="strength-trend-section" aria-labelledby="strength-trend-title">
        <div className="history-intro"><p className="section-kicker">训练记录</p><h2 id="strength-trend-title">每周力量负荷</h2><p>按周汇总已完成组的重量 × 次数。</p></div>
        {snapshot.strengthTraining.weeklyTrend.length ? (
          <ChartPanel eyebrow={`总训练量 · ${snapshot.strengthTraining.displayUnit}`} title="周训练趋势">
            <ResponsiveContainer width="100%" height="100%"><BarChart data={snapshot.strengthTraining.weeklyTrend.map((week) => ({ ...week, label: dateLabel(week.weekStart) }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis domain={[0, "auto"]} width={50} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Bar dataKey="volume" name="训练量" unit={` ${snapshot.strengthTraining.displayUnit}`} fill="var(--strength)" radius={[3,3,0,0]} /></BarChart></ResponsiveContainer>
          </ChartPanel>
        ) : <p className="empty-inline">完成训练记录并同步后，这里会按周显示训练量趋势。</p>}
      </section>

      {history.length ? (
        <section className="history-charts" aria-labelledby="history-charts-title">
          <div className="history-intro"><p className="section-kicker">近30天</p><h2 id="history-charts-title">每日明细</h2><p>缺失值保留为空白，不按 0 计算。</p></div>
          <div className="chart-grid">
            <ChartPanel eyebrow="步数 · 左轴（步）" title="日活动量">
              <ResponsiveContainer width="100%" height="100%"><AreaChart data={history} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="label" interval="preserveStartEnd" tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis domain={[0, "auto"]} width={46} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Area type="monotone" dataKey="steps" name="步数" unit=" 步" stroke="var(--accent)" fill="var(--accent-fade)" strokeWidth={2.25} connectNulls={false} /></AreaChart></ResponsiveContainer>
            </ChartPanel>
            <ChartPanel eyebrow="左轴 kcal · 右轴 分钟" title="活动能量与运动时间">
              <ResponsiveContainer width="100%" height="100%"><LineChart data={history} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="label" interval="preserveStartEnd" tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis yAxisId="kcal" domain={[0, "auto"]} width={42} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis yAxisId="minutes" orientation="right" domain={[0, "auto"]} width={34} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Line yAxisId="kcal" type="monotone" dataKey="activeKcal" name="活动能量" unit=" kcal" stroke="var(--amber)" strokeWidth={2} dot={false} connectNulls={false} /><Line yAxisId="minutes" type="monotone" dataKey="exerciseMinutes" name="运动时间" unit=" 分钟" stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls={false} /></LineChart></ResponsiveContainer>
            </ChartPanel>
            <ChartPanel eyebrow="左轴 bpm · 右轴 ms" title="静息心率与 HRV">
              <ResponsiveContainer width="100%" height="100%"><LineChart data={history} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="label" interval="preserveStartEnd" tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis yAxisId="hr" domain={["dataMin - 3", "dataMax + 3"]} width={34} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis yAxisId="hrv" orientation="right" domain={["dataMin - 5", "dataMax + 5"]} width={34} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Line yAxisId="hr" type="linear" dataKey="restingHr" name="静息心率" unit=" bpm" stroke="var(--amber)" strokeWidth={2} dot={false} connectNulls={false} /><Line yAxisId="hrv" type="linear" dataKey="hrvMs" name="HRV" unit=" ms" stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls={false} /></LineChart></ResponsiveContainer>
            </ChartPanel>
            <ChartPanel eyebrow="游泳 · 米" title="每日游泳距离">
              <ResponsiveContainer width="100%" height="100%"><BarChart data={history} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="label" interval="preserveStartEnd" tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis domain={[0, "auto"]} width={42} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Bar dataKey="swimMeters" name="游泳距离" unit=" 米" fill="var(--blue)" radius={[3,3,0,0]} /></BarChart></ResponsiveContainer>
            </ChartPanel>
            <ChartPanel eyebrow="体重 · kg" title="称重记录">
              <ResponsiveContainer width="100%" height="100%"><LineChart data={history} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="label" interval="preserveStartEnd" tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis domain={["dataMin - 0.5", "dataMax + 0.5"]} width={42} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Line type="linear" dataKey="weightKg" name="体重" unit=" kg" stroke="var(--blue)" strokeWidth={2.25} dot={{ r: 3 }} connectNulls={false} /></LineChart></ResponsiveContainer>
            </ChartPanel>
          </div>
        </section>
      ) : <p className="empty-inline">完成一次同步后，这里会显示近30天每日趋势。</p>}
    </div>
  );
}

function HistoryView({ snapshot }: { snapshot: Snapshot }) {
  const strengths = [...snapshot.strengthTraining.workouts].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const swims = snapshot.historyWorkouts.filter((workout) => workout.type.toLowerCase().includes("swim")).slice().reverse();
  const weights = snapshot.historyDaily.filter((row): row is Daily & { weightKg: number } => row.weightKg !== null).slice().reverse();
  const sleeps = snapshot.historySleeps.slice().reverse();
  return (
    <div className="history-view">
      <section className="history-section" aria-labelledby="strength-history-title">
        <div className="section-heading"><div><p className="section-kicker">训练记录</p><h2 id="strength-history-title">力量训练历史</h2></div><span className="record-count">{strengths.length} 次</span></div>
        {strengths.length ? <div className="strength-history-list">{strengths.map((workout) => (
          <details className="strength-history-row" key={workout.id}>
            <summary>
              <span className={`routine-dot routine-${workout.routine}`}>{ROUTINE_LABELS[workout.routine]}</span>
              <span><strong>{dateLabel(workout.date)} · {workout.status === "active" ? "进行中" : durationLabel(workout.durationMinutes)}</strong><small>{workout.completedSets}/{workout.totalSets} 组</small></span>
              <span className="history-volume">{volumeLabel(workout.totalVolume)} {workout.unit}</span>
              <i aria-hidden="true">›</i>
            </summary>
            <div className="strength-exercise-list">
              {workout.exercises.map((exercise) => <div key={exercise.key}><span>{exercise.name}</span><strong>{volumeLabel(exercise.volume)} {workout.unit}</strong><small>{exercise.sets.filter((set) => set.completed).map((set) => `${set.weight ?? "自重"}×${set.reps ?? "—"}`).join(" / ") || "未完成"}</small></div>)}
            </div>
          </details>
        ))}</div> : <p className="empty-inline">{snapshot.strengthTraining.note}</p>}
      </section>

      <section className="history-section" aria-labelledby="swim-history-title">
        <div className="section-heading"><div><p className="section-kicker">HealthKit workout</p><h2 id="swim-history-title">游泳记录</h2></div><span className="record-count">{swims.length} 次</span></div>
        {swims.length ? <div className="record-list">{swims.map((workout) => <article className="record-row" key={workout.id}><div><strong>{dateLabel(workout.date)}</strong><span>{numberLabel(workout.distanceMeters)} 米</span></div><dl><div><dt>时长</dt><dd>{workout.durationMinutes === null ? "—" : `${workout.durationMinutes.toFixed(1)} 分`}</dd></div><div><dt>平均心率</dt><dd>{workout.averageHr === null ? "—" : `${workout.averageHr.toFixed(0)} bpm`}</dd></div><div><dt>消耗</dt><dd>{workout.energyKcal === null ? "—" : `${workout.energyKcal.toFixed(0)} kcal`}</dd></div></dl></article>)}</div> : <p className="empty-inline">近30天没有游泳 workout 记录。</p>}
      </section>

      <section className="history-section" aria-labelledby="weight-history-title">
        <div className="section-heading"><div><p className="section-kicker">近30天</p><h2 id="weight-history-title">体重记录</h2></div><span className="record-count">{weights.length} 次</span></div>
        {weights.length ? <div className="weight-list">{weights.map((row) => <div key={row.date}><span>{dateLabel(row.date)}</span><strong>{row.weightKg.toFixed(2)} kg</strong></div>)}</div> : <p className="empty-inline">近30天没有体重记录。</p>}
      </section>

      <section className="history-section" aria-labelledby="sleep-history-title">
        <div className="section-heading"><div><p className="section-kicker">最近记录</p><h2 id="sleep-history-title">睡眠历史</h2></div><span className="record-count">{sleeps.length} 晚</span></div>
        {sleeps.length ? <div className="sleep-list">{sleeps.map((sleep) => <article key={`${sleep.date}-${sleep.start}`}><div><strong>{dateLabel(sleep.date)}</strong><span>{sleep.start}–{sleep.end}</span></div><div><strong>{sleep.totalHours.toFixed(1)} 小时</strong><span>质量 {numberLabel(sleep.quality)}</span></div></article>)}</div> : <p className="empty-inline">暂无睡眠历史记录。</p>}
      </section>
    </div>
  );
}

function Dashboard({ snapshot, readiness }: { snapshot: Snapshot; readiness: Readiness | null }) {
  const [tab, setTab] = useState<Tab>("today");
  const [waitingForSync, setWaitingForSync] = useState(false);
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => api.refreshHealthData({}),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setWaitingForSync(result.accepted);
    },
    onError: () => setWaitingForSync(false),
  });

  useEffect(() => {
    if (!waitingForSync) return;
    const interval = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }, 4_000);
    const timeout = window.setTimeout(() => setWaitingForSync(false), 60_000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [queryClient, waitingForSync]);

  const isSyncing = refresh.isPending || waitingForSync;
  return (
    <>
      <header className="page-meta">
        <div><p>{fullDateLabel(snapshot.dataDate)} · 最近完整日</p><span>更新于 {updatedLabel(snapshot.updatedAt)} · Apple 健康</span></div>
        <button className="sync-button" type="button" aria-label="同步 Apple 健康和训练记录" onClick={() => refresh.mutate()} disabled={isSyncing}>{isSyncing ? "同步中…" : snapshot.coverageIncomplete ? "待补全 · 全部同步" : "全部同步"}</button>
      </header>
      <nav className="view-tabs" aria-label="健康看板视图">
        <button type="button" className={tab === "today" ? "selected" : ""} onClick={() => setTab("today")}>今日</button>
        <button type="button" className={tab === "trends" ? "selected" : ""} onClick={() => setTab("trends")}>趋势</button>
        <button type="button" className={tab === "history" ? "selected" : ""} onClick={() => setTab("history")}>历史</button>
      </nav>
      {tab === "today" ? <TodayView snapshot={snapshot} readiness={readiness} /> : tab === "trends" ? <TrendsView snapshot={snapshot} /> : <HistoryView snapshot={snapshot} />}
      {refresh.data ? <p className="refresh-note" role="status">{waitingForSync ? `${refresh.data.message}，完成后会自动更新` : refresh.data.message}</p> : null}
    </>
  );
}

export function App() {
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: () => api.getDashboard({}) });
  const queryClient = useQueryClient();
  const [waitingForFirstSync, setWaitingForFirstSync] = useState(false);
  const firstSync = useMutation({
    mutationFn: () => api.refreshHealthData({}),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setWaitingForFirstSync(result.accepted);
    },
    onError: () => setWaitingForFirstSync(false),
  });

  useEffect(() => {
    if (!waitingForFirstSync) return;
    const interval = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }, 4_000);
    const timeout = window.setTimeout(() => setWaitingForFirstSync(false), 60_000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [queryClient, waitingForFirstSync]);

  const firstSyncing = firstSync.isPending || waitingForFirstSync;
  return (
    <div className="app-shell"><SafeAreaTopScrim backgroundColor="var(--bg)" /><main>
      {dashboard.isPending ? <div className="loading" role="status"><span /><p>正在读取健康数据…</p></div> : dashboard.isError ? <div className="empty-state" role="alert"><h1>暂时无法读取数据</h1><p>请稍后重新打开看板。</p></div> : dashboard.data.forbidden ? <div className="empty-state"><h1>健康数据仅所有者可查看</h1><p>此看板包含所有者的个人健康记录，当前访问身份无权查看。</p></div> : dashboard.data.snapshot ? <Dashboard snapshot={dashboard.data.snapshot} readiness={dashboard.data.readiness} /> : (
        <div className="empty-state">
          <h1>还没有健康数据</h1>
          <p>尚未同步过 Apple 健康。点击下方按钮，从 HealthKit 同步最近的完整日数据后，这里会显示步数、心率、HRV 与睡眠。</p>
          <button className="sync-button" type="button" aria-label="同步 Apple 健康数据" onClick={() => firstSync.mutate()} disabled={firstSyncing}>{firstSyncing ? "同步中…" : "同步 Apple 健康"}</button>
          {firstSync.data ? <p role="status">{waitingForFirstSync ? `${firstSync.data.message}，完成后会自动更新` : firstSync.data.message}</p> : null}
        </div>
      )}
      <footer>仅供健康参考，不做医疗诊断；身体不适请及时看医生。</footer>
    </main></div>
  );
}
