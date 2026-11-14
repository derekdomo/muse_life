// F-DASH-P0-3: the 「期权」 tab — fifth tab, after 总览 / FIRE /
// 明细 / 交易. Pure render of getDashboard's additive
// `optionsTab` field: every figure (Black-Scholes model price,
// captured %, FIFO-paired campaign chains, lot effective
// costs, IV−RV gate states, GEX freshness) is computed
// server-side by server/src/optionsTab.ts; this file only
// formats and lays out. Meaning never rides on colour alone
// (the user is colour-weak): states carry symbol + text +
// number, gains/losses carry +/− and ▲▼.

import type { ReactNode } from "react";
import { api, type ApiResponse } from "./api";

export type OptionsTabData = NonNullable<
  ApiResponse<typeof api, "getDashboard">["optionsTab"]
>;
type OpenRow = OptionsTabData["openPositions"][number];
type Campaign = OptionsTabData["campaigns"][number];
type Lot = OptionsTabData["lots"][number];
type Gate = OptionsTabData["gates"][number];
type GexRow = OptionsTabData["gex"]["rows"][number];
type GexLadderData = NonNullable<GexRow["ladder"]>;
type VolRow = OptionsTabData["volPanel"][number];
type ActionItem = OptionsTabData["actions"][number];
type MgmtRow = OptionsTabData["management"]["rows"][number];
type EarnWindowRow = OptionsTabData["management"]["earningsWindow"][number];

/* ------------------------------- formatting ------------------------------ */

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const money0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

function fmtDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value || "—";
  const [y = "", m = "", d = ""] = value.split("-");
  return `${y}年${Number(m)}月${Number(d)}日`;
}

function fmtPctPoints(value: number | null): string {
  if (value == null) return "未收录";
  return `${(value * 100).toFixed(1)}%`;
}

function fmtSignedPct(value: number | null): string {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}%`;
}

function fmtCaptured(value: number | null): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function fmtSignedNum(value: number | null): string {
  if (value == null) return "—";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function fmtSignedMoneyText(value: number | null): string {
  if (value == null) return "—";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${money.format(Math.abs(value)).replace("-", "")}`;
}

function pnlClass(n: number): string {
  return n > 0 ? "text-[var(--up)]" : n < 0 ? "text-[var(--down)]" : "text-[var(--text)]";
}

function SignedMoney({ n }: { n: number | null }) {
  if (n == null) return <span className="text-[var(--dim)]">—</span>;
  return (
    <span className={`font-num ${pnlClass(n)}`}>
      {n > 0 ? "▲ +" : n < 0 ? "▼ −" : "● "}
      {money.format(Math.abs(n)).replace("-", "")}
    </span>
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <h2 className="text-base font-semibold text-[var(--text)]">{title}</h2>
        {right}
      </div>
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-4">
        {children}
      </div>
    </section>
  );
}

function LockBadge() {
  return (
    <span className="shrink-0 rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--text)]">
      财报锁：不开新 CSP
    </span>
  );
}

function MetricCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-[var(--surface-alt)] px-2.5 py-2">
      <p className="text-[11px] text-[var(--dim)]">{label}</p>
      <p className="font-num mt-0.5 text-sm font-semibold text-[var(--text)]">{children}</p>
    </div>
  );
}

/* ------------------------- action bar (wheel a) -------------------------- */

// The wheel board's 「接下来怎么做」, restricted to the
// options-related items and stated in the F-DASH-P0-4
// overview bar's caliber: facts with dates and counts only.
// An empty list hides the whole block.
function OptionsActionBar({ view }: { view: OptionsTabData }) {
  if (view.actions.length === 0) return null;
  return (
    <Section
      title="接下来怎么做"
      right={<span className="text-xs text-[var(--dim)]">共 {view.actions.length} 条 · 仅期权相关</span>}
    >
      <ul className="divide-y divide-[var(--border)]">
        {view.actions.map((item: ActionItem) => (
          <li
            key={`${item.kind}-${item.text}`}
            className="options-row flex items-baseline gap-2.5 py-2.5"
          >
            <span className="shrink-0 text-sm text-[var(--text)]" aria-hidden="true">
              {item.symbol}
            </span>
            <span className="min-w-0 text-sm leading-relaxed text-[var(--text)]">{item.text}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ---------------------------- open positions ----------------------------- */

function OpenPositions({ view }: { view: OptionsTabData }) {
  const rows = view.openPositions;
  return (
    <Section
      title="未平仓期权"
      right={<span className="text-xs text-[var(--dim)]">共 {rows.length} 个合约</span>}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">当前无未平仓期权合约。</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {rows.map((row: OpenRow) => (
            <li key={`${row.key}-${row.account}`} className="options-row py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-num shrink-0 font-semibold text-[var(--text)]">
                  {row.ticker}
                </span>
                <span className="shrink-0 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] text-[var(--text)]">
                  {row.kindLabel} {money0.format(row.strike)}
                </span>
                {row.earningsLocked ? <LockBadge /> : null}
                <span className="min-w-0 flex-1" />
                <span className="font-num shrink-0 text-sm text-[var(--text)]">
                  {row.side === "short" ? "空头" : "多头"} {row.contracts} 张
                </span>
              </div>
              <p className="font-num mt-1 text-[11px] text-[var(--dim)]">
                到期 {fmtDate(row.exp)}
                {row.daysToExpiry >= 0 ? `（剩 ${row.daysToExpiry} 天）` : "（已到期）"}
                <span className="mx-1.5">·</span>开仓 {fmtDate(row.opened)}
                {row.account ? (
                  <>
                    <span className="mx-1.5">·</span>
                    {row.account}
                  </>
                ) : null}
                {row.earningsDate ? (
                  <>
                    <span className="mx-1.5">·</span>下一财报 {fmtDate(row.earningsDate)}
                  </>
                ) : null}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <MetricCell label="现价">{row.spot != null ? money.format(row.spot) : "未收录"}</MetricCell>
                <MetricCell label="行权价距现价">{fmtSignedPct(row.strikeDistancePct)}</MetricCell>
                <MetricCell label="OTM（（现价 − 行权价）÷ 现价）">{fmtSignedPct(row.otmPct)}</MetricCell>
                <MetricCell label="卖出权利金（毛成交价）">{money.format(row.premium)}</MetricCell>
                <MetricCell label={`模型价（${row.modelNote}）`}>
                  {row.modelPrice != null ? money.format(row.modelPrice) : "不可用"}
                </MetricCell>
                <MetricCell label="已捕获权利金（模型口径）">
                  {fmtCaptured(row.capturedPct)}
                  {row.capturedTargetReached ? " · ✓ 已达 50% 线" : ""}
                </MetricCell>
                <MetricCell label="浮动盈亏（模型口径）">
                  <SignedMoney n={row.unrealizedPnl} />
                </MetricCell>
                <MetricCell label="Delta 当量（股 · 模型口径）">{fmtSignedNum(row.deltaShares)}</MetricCell>
                <MetricCell label="Theta（$ / 天 · 模型口径）">{fmtSignedMoneyText(row.thetaPerDay)}</MetricCell>
                <MetricCell label="Vega（$ / IV +1pt · 模型口径）">{fmtSignedMoneyText(row.vegaPerPoint)}</MetricCell>
              </div>
              <p className="mt-1.5 text-[11px] text-[var(--dim)]">{row.dataNote}</p>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 ? (
        view.portfolioGreeks.available ? (
          <div className="mt-3 rounded-md bg-[var(--surface-alt)] px-3 py-2.5">
            <p className="text-xs font-semibold text-[var(--text)]">
              组合 Greeks 合计（全部未平仓期权 · 模型口径）
            </p>
            <p className="font-num mt-1 text-xs leading-relaxed text-[var(--text)]">
              等值 Delta {fmtSignedNum(view.portfolioGreeks.deltaShares)} 股当量
              <span className="mx-1.5">·</span>Theta {fmtSignedMoneyText(view.portfolioGreeks.thetaPerDay)} / 天
              <span className="mx-1.5">·</span>Vega {fmtSignedMoneyText(view.portfolioGreeks.vegaPerPoint)} / IV +1pt
              <span className="mx-1.5">·</span>未平仓浮动 <SignedMoney n={view.portfolioGreeks.unrealizedPnl} />
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--dim)]">
              覆盖 {view.portfolioGreeks.pricedContracts} / {view.portfolioGreeks.openContracts} 张合约；缺现价 / IV 的合约不计入，不按 0 填充。Greeks 为 Black-Scholes 模型值，非实时报价。
            </p>
          </div>
        ) : (
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--dim)]">
            组合 Greeks 合计：现价 / IV 未收录，暂不可得。
          </p>
        )
      ) : null}
    </Section>
  );
}

/* ------------------------------- campaigns ------------------------------- */

function Campaigns({ view }: { view: OptionsTabData }) {
  const campaigns = view.campaigns;
  return (
    <Section
      title="Campaign 策略链"
      right={<span className="text-xs text-[var(--dim)]">共 {campaigns.length} 条链</span>}
    >
      {campaigns.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">暂无可成链的合约记录。</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {campaigns.map((c: Campaign) => (
            <li key={c.key} className="options-row py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-num shrink-0 font-semibold text-[var(--text)]">{c.ticker}</span>
                <span className="shrink-0 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] text-[var(--text)]">
                  {c.kindLabel} {money0.format(c.strike)} · {fmtDate(c.exp)}到期
                </span>
                <span className="min-w-0 flex-1" />
                <span className="shrink-0 text-sm font-semibold text-[var(--text)]">
                  {c.status === "open" ? "● " : c.status === "assigned" ? "◆ " : "○ "}
                  {c.statusText}
                </span>
              </div>
              <p className="font-num mt-1 text-[11px] leading-relaxed text-[var(--dim)]">
                开仓 {c.openedContracts} 张 · 未平仓 {c.openContracts} 张 · 已平仓 {c.closedContracts} 张 · 已指派 {c.assignedContracts} 张
                <span className="mx-1.5">·</span>滚动 {c.rolls} 次（{c.rollsSource}）
              </p>
              <p className="font-num mt-1 text-[11px] leading-relaxed text-[var(--dim)]">
                已收权利金（毛）{money.format(c.grossPremiumReceived)}
                <span className="mx-1.5">·</span>累计已实现权利金 {money.format(c.realizedPremium)}
                {c.realizedComplete ? "" : "（部分平仓价未收录，为已收录部分）"}
                {c.lotIds.length > 0 ? (
                  <>
                    <span className="mx-1.5">·</span>关联接货批 {c.lotIds.length} 批
                  </>
                ) : null}
                {c.coveredCallKeys.length > 0 ? (
                  <>
                    <span className="mx-1.5">·</span>关联 CC {c.coveredCallKeys.length} 条
                  </>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
        链按标的 + 类型 + 到期日 + 行权价分键推导（原始数据无 campaign_id）；买回平仓按先开仓先配对（FIFO），指派取剩余腿。
      </p>
    </Section>
  );
}

/* ---------------------------------- ACB ---------------------------------- */

function AcbLots({ view }: { view: OptionsTabData }) {
  const lots = view.lots;
  return (
    <Section title="接货批与有效成本（ACB）">
      <p className="rounded-md border border-[var(--accent-soft-strong)] bg-[var(--accent-soft)] px-3 py-2 text-xs leading-relaxed text-[var(--text)]">
        {view.acbDisclaimer}
      </p>
      {lots.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">
          {view.structuredLegs
            ? "暂无指派接货批记录。"
            : "逐腿历史（买回 / 指派）需由交易同步提供结构化腿数据；当前同步仅含未平仓合约，接货批暂未收录。历史平仓记录见「交易」页签。"}
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-[var(--border)]">
          {lots.map((lot: Lot) => (
            <li key={lot.id} className="options-row py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-num shrink-0 font-semibold text-[var(--text)]">{lot.ticker}</span>
                <span className="shrink-0 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] text-[var(--text)]">
                  指派接货 {lot.shares} 股
                </span>
                <span className="min-w-0 flex-1" />
                <span className="shrink-0 text-sm text-[var(--text)]">{lot.statusText}</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <MetricCell label="行权价">{money.format(lot.strike)}</MetricCell>
                <MetricCell label="权利金 / 股">{money.format(lot.premiumPerShare)}</MetricCell>
                <MetricCell label="有效成本（行权价 − 权利金）">{money.format(lot.effectiveCost)}</MetricCell>
                <MetricCell label="CC 权利金累计">
                  {money.format(lot.ccPremiumTotal)}
                  {lot.ccPremiumKnown ? "" : "（部分未收录）"}
                </MetricCell>
                <MetricCell label="现价">{lot.spot != null ? money.format(lot.spot) : "未收录"}</MetricCell>
                <MetricCell label="市值">{lot.marketValue != null ? money.format(lot.marketValue) : "未收录"}</MetricCell>
                <MetricCell label="浮动盈亏（对有效成本）">
                  <SignedMoney n={lot.unrealizedPnl} />
                  {lot.unrealizedPct != null ? `（${fmtSignedPct(lot.unrealizedPct)}）` : ""}
                </MetricCell>
                <MetricCell label="Covered Call 行权价锚">≥ {money.format(lot.ccAnchor)}</MetricCell>
              </div>
              <p className="font-num mt-1.5 text-[11px] leading-relaxed text-[var(--dim)]">
                指派日 {fmtDate(lot.assignedDate)}
                <span className="mx-1.5">·</span>原合约到期 {fmtDate(lot.exp)}
                <span className="mx-1.5">·</span>
                {lot.coveredCalls.length > 0
                  ? lot.coveredCalls.map(
                      (cc) =>
                        `在场 Covered Call ${money0.format(cc.strike)}C ×${cc.contracts}（${fmtDate(cc.exp)}到期）覆盖本批 ${cc.shares} 股`,
                    ).join("；")
                  : "当前无 Covered Call 在场"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/* -------------------------------- timeline -------------------------------- */

function Timeline({ view }: { view: OptionsTabData }) {
  const items = view.timeline;
  return (
    <Section title="到期与财报时间线（未来 90 天）">
      {items.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">未来 90 天内暂无到期合约，相关标的财报日未收录。</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {items.map((item, i) => (
            <li key={`${item.date}-${item.kind}-${item.ticker}-${i}`} className="options-row flex flex-wrap items-baseline gap-2 py-2.5">
              <span className="font-num shrink-0 text-sm text-[var(--dim)]">{fmtDate(item.date)}</span>
              <span className="shrink-0 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] text-[var(--text)]">
                {item.kind === "expiry" ? "期权到期" : "财报"}
              </span>
              <span className="min-w-0 text-sm text-[var(--text)]">{item.text}</span>
              {item.locked ? <LockBadge /> : null}
              {item.note ? <span className="w-full text-[11px] text-[var(--dim)]">{item.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
        财报日未收录的标的不编造日期；财报前 14 天窗口内的标的带「财报锁」文字徽标。
      </p>
    </Section>
  );
}

/* --------------------------------- gates --------------------------------- */

function Gates({ view }: { view: OptionsTabData }) {
  const gates = view.gates;
  return (
    <Section title="IV − RV 门槛">
      {gates.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">暂无相关标的。</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {gates.map((gate: Gate) => (
            <li
              key={gate.ticker}
              className={`options-row py-3 ${gate.state === "blocked" ? "options-gate--blocked" : ""}`}
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-num shrink-0 font-semibold text-[var(--text)]">{gate.ticker}</span>
                {gate.earningsLocked ? <LockBadge /> : null}
                <span className="min-w-0 flex-1" />
                <span className="shrink-0 text-sm font-semibold text-[var(--text)]">
                  {gate.symbol} {gate.text}
                </span>
              </div>
              <p className="font-num mt-1 text-[11px] text-[var(--dim)]">
                IV {fmtPctPoints(gate.iv)}
                <span className="mx-1.5">·</span>RV（20 日）{fmtPctPoints(gate.rv)}
                <span className="mx-1.5">·</span>差值{" "}
                {gate.spreadPp != null ? `${gate.spreadPp >= 0 ? "+" : "−"}${Math.abs(gate.spreadPp).toFixed(1)}pp` : "—"}
                {gate.earningsDate ? (
                  <>
                    <span className="mx-1.5">·</span>下一财报 {fmtDate(gate.earningsDate)}
                  </>
                ) : (
                  <>
                    <span className="mx-1.5">·</span>下一财报 未收录
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
        IV 为期权链反推口径，RV 为 20 日历史波动率；差值 = IV − RV。未收录时不做门槛判定。
      </p>
    </Section>
  );
}

/* ---------------------------------- GEX ----------------------------------- */

function GexLadder({ ladder }: { ladder: GexLadderData }) {
  const summary = ladder.markers.map((m) => `${m.sub} ${m.label}`).join("、");
  return (
    <div className="gex-ladder" role="img" aria-label={`价位标尺：${summary}`}>
      <div className="gex-ladder-track" />
      {ladder.markers.map((marker) => (
        <div
          key={`${marker.kind}-${marker.value}-${marker.sub}`}
          className={`gex-marker gex-marker--${marker.side} gex-marker--tier${marker.tier} gex-marker--${marker.kind}`}
          style={{ left: `${marker.pct}%` }}
          aria-hidden="true"
        >
          <span className="gex-marker-line" />
          <span
            className="gex-marker-tag"
            style={{
              transform: `translateX(${marker.pct < 12 ? "-12%" : marker.pct > 88 ? "-88%" : "-50%"})`,
            }}
          >
            <b>{marker.label}</b>
            <small>{marker.sub}</small>
          </span>
        </div>
      ))}
    </div>
  );
}

function GexPanel({ view }: { view: OptionsTabData }) {
  const gex = view.gex;
  const symbol = gex.state === "fresh" ? "●" : gex.state === "stale" ? "▲" : gex.state === "unverified" ? "◐" : "○";
  return (
    <Section title="GEX 面板">
      <p className="rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2 text-xs leading-relaxed text-[var(--text)]">
        {symbol} {gex.bannerText}
      </p>
      {gex.state !== "unavailable" && gex.rows.length > 0 ? (
        <ul className="mt-2 divide-y divide-[var(--border)]">
          {gex.rows.map((row: GexRow) => (
            <li key={row.ticker} className="options-row py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-num shrink-0 font-semibold text-[var(--text)]">{row.ticker}</span>
                {row.regimeText ? (
                  <span className="shrink-0 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--text)]">
                    {row.regimeText}
                  </span>
                ) : null}
                {row.stale ? (
                  <span className="shrink-0 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] text-[var(--text)]">
                    该标的已过期
                  </span>
                ) : null}
                <span className="min-w-0 flex-1" />
                <span className="shrink-0 text-xs text-[var(--dim)]">{row.dataText}</span>
              </div>
              {row.dataState === "ok" ? (
                <>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <MetricCell label="净 GEX">
                      {row.netGex != null ? `${row.netGex >= 0 ? "+" : "−"}${compact.format(Math.abs(row.netGex))}` : "—"}
                    </MetricCell>
                    <MetricCell label="flip 点">{row.flip != null ? money.format(row.flip) : "—"}</MetricCell>
                    <MetricCell label="现价">{row.spot != null ? money.format(row.spot) : "—"}</MetricCell>
                    <MetricCell label="现价距 flip">{fmtSignedPct(row.flipDistancePct)}</MetricCell>
                    <MetricCell label="Call Wall">{row.callWall != null ? money.format(row.callWall) : "未收录"}</MetricCell>
                    <MetricCell label="Put Wall">{row.putWall != null ? money.format(row.putWall) : "未收录"}</MetricCell>
                  </div>
                  {row.ladder ? <GexLadder ladder={row.ladder} /> : null}
                </>
              ) : (
                <p className="mt-1.5 text-[11px] text-[var(--dim)]">
                  净 GEX 为 0 且无 flip 点，不按正常值展示。
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
        Yahoo 未平仓量于深夜可能清零，清零态不作正常值展示。
      </p>
    </Section>
  );
}

/* --------------------------- vol / edge (wheel c) ------------------------ */

function VolPanel({ view }: { view: OptionsTabData }) {
  const rows = view.volPanel;
  return (
    <Section title="波动率与 Edge（IV30 / RV30）">
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">暂无相关标的。</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {rows.map((row: VolRow) => (
            <li key={row.ticker} className="options-row py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-num shrink-0 font-semibold text-[var(--text)]">{row.ticker}</span>
                <span className="shrink-0 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--text)]">
                  {row.edgeText}
                </span>
                {row.earningsLocked ? <LockBadge /> : null}
                <span className="min-w-0 flex-1" />
                <span className="font-num shrink-0 text-sm text-[var(--text)]">
                  现价 {row.spot != null ? money.format(row.spot) : "未收录"}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <MetricCell label="IV30">{fmtPctPoints(row.iv30)}</MetricCell>
                <MetricCell label="RV20">{fmtPctPoints(row.rv20)}</MetricCell>
                <MetricCell label="RV30">{fmtPctPoints(row.rv30)}</MetricCell>
                <MetricCell label="IV30 − RV30">
                  {row.spreadPp != null ? `${row.spreadPp >= 0 ? "+" : "−"}${Math.abs(row.spreadPp).toFixed(1)}pt` : "—"}
                </MetricCell>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-[var(--text)]">{row.verdict}</p>
              {row.earningsDate ? (
                <p className="font-num mt-1 text-[11px] text-[var(--dim)]">
                  下一财报 {fmtDate(row.earningsDate)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
        IV30 为期权链反推口径，RV30 为近 30 个交易日已实现波动率，RV20 为近 20 日；价差 = IV30 − RV30。样本不足时不编造 IV 百分位。
      </p>
    </Section>
  );
}

/* ------------------------- concentration (wheel f) ----------------------- */

function Concentration({ view }: { view: OptionsTabData }) {
  const c = view.concentration;
  return (
    <Section title="集中度 · 因子口径">
      <p className="text-xs leading-relaxed text-[var(--dim)]">
        因子标的：{c.factorTickers.join(" / ")}——视为同一个高 beta 成长因子合并计算，不按单票分散看。
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricCell label="未平仓 Put 指派义务（因子）">{money0.format(c.putObligation)}</MetricCell>
        <MetricCell label="接货持仓市值（因子）">
          {c.assignedMarketValue != null ? money0.format(c.assignedMarketValue) : "暂不可得"}
        </MetricCell>
        <MetricCell label="因子总敞口">
          {c.exposure != null ? money0.format(c.exposure) : "暂不可得"}
        </MetricCell>
        <MetricCell label="组合总值">
          {c.portfolioTotal != null ? money0.format(c.portfolioTotal) : "未收录"}
        </MetricCell>
      </div>
      {c.putObligationLines.length > 0 ? (
        <p className="font-num mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
          指派义务构成：
          {c.putObligationLines.map((line) => `${line.ticker} ${money0.format(line.amount)}`).join(" · ")}
          {c.nonFactorPutObligation > 0
            ? `；非因子标的 put 义务 ${money0.format(c.nonFactorPutObligation)} 不计入因子敞口`
            : ""}
        </p>
      ) : null}
      {c.assignedMissingSpotTickers.length > 0 ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--dim)]">
          接货现价未收录（{c.assignedMissingSpotTickers.join(" / ")}），接货市值与总敞口暂不可得，不按 0 填充。
        </p>
      ) : null}
      {c.exposurePct != null && c.capAmount != null ? (
        <>
          <div className="relative mt-5 h-4 rounded-full bg-[var(--surface-alt)]" role="img" aria-label={`因子敞口占组合 ${c.exposurePct}%，上限 25%`}>
            <div
              className="h-full rounded-full bg-[var(--accent)]"
              style={{ width: `${Math.min(100, Math.max(0, c.exposurePct))}%` }}
            />
            <div className="absolute -top-1 -bottom-1 w-0.5 bg-[var(--text)]" style={{ left: "25%" }}>
              <span className="absolute -top-4 left-0 -translate-x-1/2 text-[11px] font-semibold whitespace-nowrap text-[var(--text)]">
                上限 25%
              </span>
            </div>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text)]">
            <strong>
              当前 {c.exposurePct}% · {c.overLimit ? "▲ 已超限（文字标注）" : "✓ 未超限（文字标注）"}
            </strong>
            ——25% 上限对应 {money0.format(c.capAmount)}，
            {c.headroom != null && c.headroom >= 0
              ? `距上限余量 ${money0.format(c.headroom)}，未超限。`
              : `已超上限 ${money0.format(Math.abs(c.headroom ?? 0))}。`}
            口径：未平仓 put 指派义务 + 接货持仓市值 = 因子总敞口，占组合总值比例与上限同尺对比。
          </p>
        </>
      ) : (
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
          {c.portfolioTotal == null
            ? "组合总值未收录，占比与上限余量无法计算，不编造分母。"
            : "总敞口暂不可得，占比与上限余量无法计算。"}
        </p>
      )}
    </Section>
  );
}

/* --------------------------- dual ledger (wheel g) ----------------------- */

function DualLedger({ view }: { view: OptionsTabData }) {
  const a = view.dualLedger.caliberA;
  const b = view.dualLedger.caliberB;
  return (
    <Section title="双口径记账">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-[var(--surface-alt)] p-3">
          <h3 className="text-sm font-semibold text-[var(--text)]">口径 A · 权利金与已实现</h3>
          <p className="mt-2 flex items-baseline justify-between gap-2 border-y border-[var(--border)] py-2">
            <span className="text-xs text-[var(--dim)]">已实现期权损益</span>
            <span className="text-lg">
              <SignedMoney n={a.realizedOptionsPnl} />
            </span>
          </p>
          {a.realizedLines.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {a.realizedLines.map((line) => (
                <li
                  key={`${line.ticker}-${line.exp}-${line.strike}-${line.type}`}
                  className="flex items-baseline justify-between gap-2 text-xs text-[var(--dim)]"
                >
                  <span className="min-w-0">
                    {line.ticker} {fmtDate(line.exp)} {money0.format(line.strike)}
                    {line.type === "put" ? "P" : "C"} {line.outcomeText}
                    {line.complete ? "" : "（平仓价未收录）"}
                  </span>
                  <span className="shrink-0">
                    {line.amount != null ? <SignedMoney n={line.amount} /> : "—"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-[var(--dim)]">暂无已平仓期权记录。</p>
          )}
          {a.basisLines.length > 0 ? (
            <ul className="mt-2 space-y-1.5 border-t border-[var(--border)] pt-2">
              {a.basisLines.map((line, i) => (
                <li
                  key={`${line.ticker}-${line.strike}-${i}`}
                  className="flex items-baseline justify-between gap-2 text-xs text-[var(--dim)]"
                >
                  <span className="min-w-0">
                    {line.ticker} {money0.format(line.strike)}P 权利金 → 成本基础（有效成本 {money.format(line.effectiveCost)}）
                  </span>
                  <span className="font-num shrink-0 text-[var(--text)]">{money.format(line.amount)}</span>
                </li>
              ))}
              <li className="flex items-baseline justify-between gap-2 text-xs text-[var(--dim)]">
                <span>转入成本基础的权利金合计</span>
                <span className="font-num shrink-0 text-[var(--text)]">{money.format(a.basisPremiumTotal)}</span>
              </li>
            </ul>
          ) : null}
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
            转入成本基础的权利金不计入已实现损益（它在接货批的有效成本里）。
            {a.realizedComplete ? "" : "部分平仓价未收录，已实现为已收录部分。"}
          </p>
        </div>
        <div className="rounded-lg bg-[var(--surface-alt)] p-3">
          <h3 className="text-sm font-semibold text-[var(--text)]">口径 B · 总权益（全部平仓近似 · 未计税费）</h3>
          <p className="mt-2 flex items-baseline justify-between gap-2 border-y border-[var(--border)] py-2">
            <span className="text-xs text-[var(--dim)]">总权益口径合计</span>
            <span className="text-lg">
              {b.total != null ? <SignedMoney n={b.total} /> : <span className="text-[var(--dim)]">暂不可得</span>}
            </span>
          </p>
          <ul className="mt-2 space-y-1.5">
            <li className="flex items-baseline justify-between gap-2 text-xs text-[var(--dim)]">
              <span>已实现期权损益（口径 A）</span>
              <span className="shrink-0"><SignedMoney n={b.realizedOptionsPnl} /></span>
            </li>
            <li className="flex items-baseline justify-between gap-2 text-xs text-[var(--dim)]">
              <span>接货持仓浮盈亏</span>
              <span className="shrink-0">
                {b.assignedUnrealized != null ? <SignedMoney n={b.assignedUnrealized} /> : "现价未收录"}
              </span>
            </li>
            <li className="flex items-baseline justify-between gap-2 text-xs text-[var(--dim)]">
              <span>未平仓期权浮动 · Put</span>
              <span className="shrink-0">
                {b.openUnrealizedPut != null ? <SignedMoney n={b.openUnrealizedPut} /> : "模型价不可用"}
              </span>
            </li>
            <li className="flex items-baseline justify-between gap-2 text-xs text-[var(--dim)]">
              <span>未平仓期权浮动 · Call</span>
              <span className="shrink-0">
                {b.openUnrealizedCall != null ? <SignedMoney n={b.openUnrealizedCall} /> : "模型价不可用"}
              </span>
            </li>
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
            口径 B = 口径 A 已实现 + 接货浮盈亏 + 未平仓浮动（模型价口径），任一成分未收录时合计不显示，不按 0 凑数。
          </p>
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-[var(--text)]">
        只看权利金记分牌会高估成绩：权利金落袋的同时，接货浮亏与未平仓浮动也在累积——两个口径必须对照着看。
      </p>
    </Section>
  );
}

/* --------------------- management + earnings (wheel h) ------------------- */

function Management({ view }: { view: OptionsTabData }) {
  const { rows, earningsWindow } = view.management;
  return (
    <Section title="管理节点与财报窗口">
      <h3 className="text-sm font-semibold text-[var(--text)]">未平仓仓位 · 管理节点</h3>
      {rows.length === 0 ? (
        <p className="mt-1 text-sm text-[var(--dim)]">当前无未平仓空头仓位。</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {rows.map((row: MgmtRow) => (
            <li key={row.key} className="options-row py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-num shrink-0 font-semibold text-[var(--text)]">{row.ticker}</span>
                <span className="shrink-0 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] text-[var(--text)]">
                  {row.kindLabel} {money0.format(row.strike)} ×{row.contracts}
                </span>
                <span className="min-w-0 flex-1" />
                <span className="font-num shrink-0 text-sm text-[var(--text)]">
                  {row.daysToExpiry >= 0 ? `剩 ${row.daysToExpiry} 天` : "已到期"}
                  <span className="mx-1.5">·</span>Roll {row.rolls} / {row.rollLimit} 次
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text)]">
                <strong>{row.nodeText}</strong>
                <span className="mx-1.5">·</span>captured {fmtCaptured(row.capturedPct)}
                {row.capturedTargetReached ? " ✓ 已达 50% 线" : ""}
                <span className="mx-1.5">·</span>OTM {fmtSignedPct(row.otmPct)}
                <span className="mx-1.5">·</span>浮动盈亏 <SignedMoney n={row.unrealizedPnl} />
              </p>
              <p className="mt-0.5 text-[11px] text-[var(--dim)]">
                到期 {fmtDate(row.exp)} · roll 次数{row.rollsSource}
              </p>
            </li>
          ))}
        </ul>
      )}
      <h3 className="mt-5 text-sm font-semibold text-[var(--text)]">财报窗口 · 14 天内不开新仓</h3>
      {earningsWindow.length === 0 ? (
        <p className="mt-1 text-sm text-[var(--dim)]">暂无相关标的。</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {earningsWindow.map((row: EarnWindowRow) => (
            <li key={row.ticker} className="options-row flex flex-wrap items-baseline gap-2 py-2.5">
              <span className="font-num shrink-0 font-semibold text-[var(--text)]">{row.ticker}</span>
              <span className="font-num shrink-0 text-sm text-[var(--dim)]">
                {row.date ? `${fmtDate(row.date)}${row.daysUntil != null ? ` · ${row.daysUntil} 天后` : ""}` : "未收录"}
              </span>
              <span className="min-w-0 text-sm text-[var(--text)]">
                <strong>{row.stateText}</strong>
                <span className="mx-1.5">·</span>
                {row.gateText}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
        策略 v2 口径：captured 50% 线与 21 天管理节点先到先复核；roll 只计次数、上限 2 次（人工维护）。财报窗口与 IV−RV30 门槛均为事实状态陈述。
      </p>
    </Section>
  );
}

/* ---------------------------------- tab ----------------------------------- */

export function OptionsTab({ view }: { view: OptionsTabData | null }) {
  if (!view) {
    return (
      <div className="py-16 text-center">
        <p className="text-lg font-semibold text-[var(--text)]">等待交易数据首次同步</p>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--dim)]">
          期权视图随交易数据一并同步；同步完成后，这里会显示未平仓期权、Campaign 策略链、接货批有效成本、到期与财报时间线、IV − RV 门槛与 GEX 面板。
        </p>
      </div>
    );
  }
  return (
    <>
      <p className="mt-4 rounded-md border border-[var(--accent-soft-strong)] bg-[var(--accent-soft)] px-3 py-2.5 text-xs font-semibold leading-relaxed text-[var(--text)]">
        {view.disclaimer}
      </p>
      <OptionsActionBar view={view} />
      <OpenPositions view={view} />
      <Campaigns view={view} />
      <AcbLots view={view} />
      <Timeline view={view} />
      <Gates view={view} />
      <VolPanel view={view} />
      <GexPanel view={view} />
      <Concentration view={view} />
      <DualLedger view={view} />
      <Management view={view} />
      <footer className="mt-8 space-y-1.5 px-1 pb-4 text-[11px] leading-relaxed text-[var(--dim)]">
        <p>
          模型价为 Black-Scholes 估算（无风险利率 4%、无股息），以现价与 IV 近似；合约市价不可用时以模型口径标注，不冒充市价。已捕获比例 = 1 − 模型价 ÷ 卖出权利金，同为模型口径。Greeks 同为该模型口径的导数，逐仓可加总到组合合计。
        </p>
        <p>
          Campaign 与有效成本为账本口径：指派接货批的有效成本 = 行权价 − 该腿卖出权利金，买回平仓按 FIFO 配对；与券商成本基础口径不同，税务以 1099-B 为准。
        </p>
        <p>
          OTM 百分比全页新板块统一按（现价 − 行权价）÷ 现价计算；价格口径为当日收盘。集中度为因子口径（指派义务 + 接货市值），双口径记账中口径 B 为全部平仓近似、未计税费。
        </p>
        <p>数据日期 {fmtDate(view.asOf)}（交易同步生成日）；现价 / IV / RV / GEX / 财报日未收录处均如实标注，不补造。</p>
      </footer>
    </>
  );
}
