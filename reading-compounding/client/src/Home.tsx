import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
CartesianGrid,
Line,
LineChart,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api } from "./api";
import {
fmtMinutes,
sourceLabelOf,
statusMessage,
type Book,
type Dashboard,
type Library,
} from "./lib";

export function Home({
  dashboard,
  library,
  onOpenReader,
  onGoSnippets,
  onGoBooks,
}: {
  dashboard: Dashboard;
  library: Library;
  onOpenReader: (book: Book, chapter?: number, offset?: number) => void;
  onGoSnippets: () => void;
  onGoBooks: () => void;
}) {
  const queryClient = useQueryClient();
  const [reflectionDraft, setReflectionDraft] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const savor = dashboard.savor;
  const totals = dashboard.totals;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    void queryClient.invalidateQueries({ queryKey: ["library"] });
  };

  const saveReflection = useMutation({
    mutationFn: () =>
      api.updateSnippetReflection({
        id: savor?.id ?? -1,
        version: savor?.version ?? 1,
        reflection: reflectionDraft ?? "",
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setReflectionDraft(null);
        setMsg("✓ 感悟已记下");
        invalidate();
      } else {
        setMsg(statusMessage(res.status) ?? "保存失败，输入还在。");
      }
    },
    onError: () => setMsg("保存失败，输入还在。"),
  });

  const toggleInternalized = useMutation({
    mutationFn: (internalized: boolean) =>
      api.setSnippetInternalized({ id: savor?.id ?? -1, internalized }),
    onSuccess: (res) => {
      if (res.ok) {
        setMsg(res.ok ? "已更新" : null);
        invalidate();
      }
    },
  });

  const savorBook =
    savor?.bookId != null
      ? (library.books.find((b) => b.id === savor.bookId) ?? null)
      : null;

  const series = dashboard.series;
  const lastPoint = series[series.length - 1];

  return (
    <div className="space-y-8">
      {/* 片刻回味 */}
      <section aria-label="片刻回味">
        <h2 className="text-xs font-medium tracking-wide text-[var(--dim)]">片刻回味</h2>
        {savor ? (
          <article className="mt-3 border-y-2 border-[var(--text)] py-5">
            <blockquote className="font-serif-book text-[22px] leading-relaxed">
              「{savor.text}」
            </blockquote>
            <p className="mt-3 text-sm text-[var(--dim)]">{sourceLabelOf(savor)}</p>
            {savor.tags.length > 0 && (
              <p className="mt-2 flex flex-wrap gap-1.5">
                {savor.tags.map((t) => (
                  <span
                    key={`${t.tag}-${t.origin}`}
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      t.origin === "suggested"
                        ? "border border-dashed border-[var(--dim)] text-[var(--dim)]"
                        : "bg-[var(--accent)]/10 text-[var(--accent)]"
                    }`}
                  >
                    {t.tag}
                    {t.origin === "suggested" ? "（建议）" : ""}
                  </span>
                ))}
              </p>
            )}
            {savor.thinkPrompt && (
              <p className="mt-4 text-[15px] leading-relaxed">
                <span className="mr-2 rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--accent)]">
                  思考提示
                </span>
                {savor.thinkPrompt}
              </p>
            )}
            {savor.reflection && reflectionDraft == null && (
              <p className="mt-3 border-l-2 border-[var(--ok)] pl-3 text-[15px] leading-relaxed">
                <span className="mr-2 text-xs font-medium text-[var(--ok)]">我的感悟</span>
                {savor.reflection}
              </p>
            )}
            {reflectionDraft != null && (
              <div className="mt-3">
                <label htmlFor="savor-reflection" className="text-sm font-medium">
                  补记新感悟
                </label>
                <textarea
                  id="savor-reflection"
                  value={reflectionDraft}
                  onChange={(e) => setReflectionDraft(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[15px]"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={saveReflection.isPending}
                    onClick={() => saveReflection.mutate()}
                    className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
                  >
                    {saveReflection.isPending ? "保存中…" : "保存感悟"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setReflectionDraft(null)}
                    className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {reflectionDraft == null && (
                <button
                  type="button"
                  onClick={() => setReflectionDraft(savor.reflection ?? "")}
                  className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
                >
                  {savor.reflection ? "修改感悟" : "✎ 补记感悟"}
                </button>
              )}
              <button
                type="button"
                disabled={toggleInternalized.isPending}
                onClick={() => toggleInternalized.mutate(!savor.internalized)}
                aria-pressed={savor.internalized}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
              >
                {savor.internalized ? "↩ 取消内化" : "✓ 标为已内化"}
              </button>
              {savorBook != null && savorBook.chapterCount > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    onOpenReader(
                      savorBook,
                      savor.chapterIdx ?? undefined,
                      savor.charOffset ?? undefined,
                    )
                  }
                  className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
                >
                  回到原文
                </button>
              )}
              <button
                type="button"
                onClick={onGoSnippets}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm"
              >
                查看全部片段
              </button>
            </div>
            {msg && (
              <p role="status" className="mt-2 text-sm text-[var(--dim)]">
                {msg}
              </p>
            )}
          </article>
        ) : (
          <div className="mt-3 border-y-2 border-[var(--text)] py-6 text-center">
            <p className="font-serif-book text-lg">还没有存下任何片段。</p>
            <p className="mt-2 text-sm text-[var(--dim)]">
              读到有感觉的句子，在阅读器里选中就能存成片段；也可以粘贴微信读书的片段进来。
            </p>
            <button
              type="button"
              onClick={onGoBooks}
              className="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white"
            >
              去书单导入一本书
            </button>
          </div>
        )}
      </section>

      {/* 复利总览：三列分开，不合并成一个分数 */}
      <section aria-label="复利总览">
        <h2 className="text-xs font-medium tracking-wide text-[var(--dim)]">复利总览</h2>
        <dl className="mt-3 grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <dt className="text-xs text-[var(--dim)]">知识卡</dt>
            <dd className="mt-1 text-3xl font-semibold tabular-nums">{totals.cardTotal}</dd>
            <dd className="text-xs text-[var(--dim)]">张有效卡</dd>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <dt className="text-xs text-[var(--dim)]">↻ 被复用过的卡</dt>
            <dd className="mt-1 text-3xl font-semibold tabular-nums text-[var(--accent2)]">
              {totals.reusedCardCount}
            </dd>
            <dd className="text-xs text-[var(--dim)]">张至少用过一次</dd>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <dt className="text-xs text-[var(--dim)]">↻ 复用总次</dt>
            <dd className="mt-1 text-3xl font-semibold tabular-nums text-[var(--accent2)]">
              {totals.reuseTotal}
            </dd>
            <dd className="text-xs text-[var(--dim)]">次真实调用</dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-[var(--dim)]">
          连续阅读 {totals.streakDays} 天 · 共 {totals.readingDays} 个阅读日 · 已知时长{" "}
          {fmtMinutes(totals.knownMinutes)}
          {totals.unknownMinutesCount > 0
            ? ` · 另有 ${totals.unknownMinutesCount} 次时长未记`
            : ""}
        </p>

        {series.length > 0 && lastPoint ? (
          <figure className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <figcaption className="text-sm font-medium">
              累计知识卡
              <span className="ml-2 text-xs font-normal text-[var(--dim)]">
                按保存日累计，截至 {lastPoint.date} 共 {lastPoint.cards} 张
              </span>
            </figcaption>
            <div className="mt-2 h-44" aria-hidden="true">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: "var(--dim)" }}
                    tickFormatter={(d: string) => d.slice(5)}
                    minTickGap={40}
                  />
                  <YAxis
                    domain={[0, "auto"]}
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: "var(--dim)" }}
                  />
                  <Tooltip
                    formatter={(value) => [`${value} 张`, "累计知识卡"]}
                    labelFormatter={(d) => String(d)}
                  />
                  <Line
                    type="monotone"
                    dataKey="cards"
                    stroke="var(--accent)"
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </figure>
        ) : (
          <p className="mt-4 rounded-xl border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
            还没有知识卡，曲线会在第一张卡保存后出现——只按真实保存日累计，不补历史。
          </p>
        )}
      </section>

      {/* 最近复用 */}
      {dashboard.recentReuses.length > 0 && (
        <section aria-label="最近复用">
          <h2 className="text-xs font-medium tracking-wide text-[var(--dim)]">最近复用 ↻</h2>
          <ul className="mt-2 divide-y divide-[var(--border)]">
            {dashboard.recentReuses.map((r) => (
              <li key={r.id} className="py-2.5">
                <p className="text-sm">
                  <span className="font-medium">「{r.cardCore}」</span>
                  <span className="ml-2 text-xs text-[var(--dim)]">{r.date}</span>
                </p>
                <p className="mt-0.5 text-sm text-[var(--dim)]">
                  {r.scene} → {r.outcome}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
