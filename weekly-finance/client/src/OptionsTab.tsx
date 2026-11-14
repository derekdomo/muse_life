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
                <MetricCell label="卖出权利金（毛成交价）">{money.format(row.premium)}</MetricCell>
                <MetricCell label={`模型价（${row.modelNote}）`}>
                  {row.modelPrice != null ? money.format(row.modelPrice) : "不可用"}
                </MetricCell>
                <MetricCell label="已捕获权利金（模型口径）">{fmtCaptured(row.capturedPct)}</MetricCell>
                <MetricCell label="浮动盈亏（模型口径）">
                  <SignedMoney n={row.unrealizedPnl} />
                </MetricCell>
              </div>
              <p className="mt-1.5 text-[11px] text-[var(--dim)]">{row.dataNote}</p>
            </li>
          ))}
        </ul>
      )}
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
              </div>
              <p className="font-num mt-1.5 text-[11px] text-[var(--dim)]">
                指派日 {fmtDate(lot.assignedDate)}
                <span className="mx-1.5">·</span>原合约到期 {fmtDate(lot.exp)}
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
                {row.stale ? (
                  <span className="shrink-0 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] text-[var(--text)]">
                    该标的已过期
                  </span>
                ) : null}
                <span className="min-w-0 flex-1" />
                <span className="shrink-0 text-xs text-[var(--dim)]">{row.dataText}</span>
              </div>
              {row.dataState === "ok" ? (
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <MetricCell label="净 GEX">
                    {row.netGex != null ? `${row.netGex >= 0 ? "+" : "−"}${compact.format(Math.abs(row.netGex))}` : "—"}
                  </MetricCell>
                  <MetricCell label="flip 点">{row.flip != null ? money.format(row.flip) : "—"}</MetricCell>
                  <MetricCell label="现价">{row.spot != null ? money.format(row.spot) : "—"}</MetricCell>
                  <MetricCell label="现价距 flip">{fmtSignedPct(row.flipDistancePct)}</MetricCell>
                </div>
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
      <OpenPositions view={view} />
      <Campaigns view={view} />
      <AcbLots view={view} />
      <Timeline view={view} />
      <Gates view={view} />
      <GexPanel view={view} />
      <footer className="mt-8 space-y-1.5 px-1 pb-4 text-[11px] leading-relaxed text-[var(--dim)]">
        <p>
          模型价为 Black-Scholes 估算（无风险利率 4%、无股息），以现价与 IV 近似；合约市价不可用时以模型口径标注，不冒充市价。已捕获比例 = 1 − 模型价 ÷ 卖出权利金，同为模型口径。
        </p>
        <p>
          Campaign 与有效成本为账本口径：指派接货批的有效成本 = 行权价 − 该腿卖出权利金，买回平仓按 FIFO 配对；与券商成本基础口径不同，税务以 1099-B 为准。
        </p>
        <p>数据日期 {fmtDate(view.asOf)}（交易同步生成日）；现价 / IV / RV / GEX / 财报日未收录处均如实标注，不补造。</p>
      </footer>
    </>
  );
}
