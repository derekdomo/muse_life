import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type ReportPayload = NonNullable<ApiResponse<typeof api, "getReport">["report"]>;
type Listing = ReportPayload["listings"][number];
type Decision = "favorite" | "excluded" | "viewed";

type CityFilter = "全部" | "Santa Clara" | "Sunnyvale" | "Cupertino";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const compactMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

// HH1.1 default annual assumptions (mirror of the server defaults in
// server/src/decision.ts). Both are estimates, labelled as such.
const DEFAULT_TAX_RATE_PCT = 1.18;
const DEFAULT_INSURANCE_RATE_PCT = 0.2;
const DEFAULT_DOWN_PAYMENT_PCT = 30;

// Monthly cost estimate (HH1.1): the same formula the server
// documents — 30-year P&I amortization, tax/insurance as a yearly
// percentage of price spread over 12 months, HOA as recorded. An
// unknown HOA is never folded into the total as 0: the total stays
// null and the UI shows the subtotal with an explicit note.
function costBreakdown(price: number, downPaymentPct: number, annualRatePct: number, taxRatePct: number, insuranceRatePct: number, hoaMonthly: number | null) {
  const principal = price * (1 - downPaymentPct / 100);
  const monthlyRate = annualRatePct / 100 / 12;
  const months = 360;
  const factor = Math.pow(1 + monthlyRate, months);
  const principalInterest = monthlyRate === 0
    ? principal / months
    : (principal * monthlyRate * factor) / (factor - 1);
  const propertyTaxMonthly = (price * (taxRatePct / 100)) / 12;
  const insuranceMonthly = (price * (insuranceRatePct / 100)) / 12;
  const hoaKnown = typeof hoaMonthly === "number" && Number.isFinite(hoaMonthly);
  const subtotalExcludingHoa = principalInterest + propertyTaxMonthly + insuranceMonthly;
  return {
    principalInterest,
    propertyTaxMonthly,
    insuranceMonthly,
    hoaMonthly: hoaKnown ? hoaMonthly : null,
    hoaKnown,
    subtotalExcludingHoa,
    totalMonthly: hoaKnown ? subtotalExcludingHoa + (hoaMonthly as number) : null,
  };
}

type CostInputs = { downPayment: number; rate: number; taxRate: number; insuranceRate: number };

function formatAsOf(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function formatDateOnly(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(parsed);
}

// Status text for a previous-issue status value (HH1.3 change
// markers). Same symbol + text convention as the server labels.
const STATUS_TEXT: Record<string, string> = {
  active: "● 在售",
  contingent: "◐ 已有条件成交",
  pending: "◐ 待成交",
  unknown: "◐ 状态未确认",
  sold: "■ 已售出",
  off_market: "■ 已下架",
};

const DECISION_META: Record<Decision, { symbol: string; label: string; activeLabel: string }> = {
  favorite: { symbol: "★", label: "收藏", activeLabel: "已收藏" },
  excluded: { symbol: "✕", label: "排除", activeLabel: "已排除" },
  viewed: { symbol: "✓", label: "已看房", activeLabel: "已看房" },
};

const SUBSCORE_FIELDS = [
  ["hardCriteria", "硬条件"],
  ["environment", "环境"],
  ["school", "学校/私校"],
  ["ageCondition", "房龄/状态"],
  ["space", "空间"],
  ["priceComps", "价格/可比成交"],
] as const;

function SubScoreDetail({ listing }: { listing: Listing }) {
  if (!listing.subScores) {
    return (
      <div className="subscore-block">
        <span>分项分</span>
        <p>本房源尚无分项评分，总分沿用综合评分，未按分项权重计算。</p>
      </div>
    );
  }
  return (
    <div className="subscore-block">
      <span>分项分（总分 {listing.score} 分）</span>
      <ul className="subscore-list">
        {SUBSCORE_FIELDS.map(([key, label]) => (
          <li key={key}>
            <span>{label}</span>
            <strong>{listing.subScores?.[key] ?? "未评分"}</strong>
          </li>
        ))}
      </ul>
      {listing.scoreComplete ? (
        <p>六项齐全，总分按公开权重加权计算。</p>
      ) : (
        <p>分项不完整（已评 {listing.scorePresentCount}/6），总分按已提供分项加权计算，缺项未按 0 分计。</p>
      )}
    </div>
  );
}

function StaleBadge() {
  return <span className="stale-badge">⚠ stale · 已超过 7 天</span>;
}

function CostBlock({ listing, costs }: { listing: Listing; costs: CostInputs }) {
  const cost = costBreakdown(listing.price, costs.downPayment, costs.rate, costs.taxRate, costs.insuranceRate, listing.hoaMonthly);
  const loan = listing.price * (1 - costs.downPayment / 100);
  return (
    <div className="cost-block" aria-label="月成本估算分项">
      <div className="cost-head">
        <span>月成本估算（分项）</span>
        <strong>
          {money.format(cost.totalMonthly ?? cost.subtotalExcludingHoa)}
          <small>/月</small>
        </strong>
      </div>
      <ul className="cost-list">
        <li><span>本金 + 利息</span><strong>{money.format(cost.principalInterest)}</strong></li>
        <li><span>地税（估算 · {costs.taxRate.toFixed(2)}%/年）</span><strong>{money.format(cost.propertyTaxMonthly)}</strong></li>
        <li><span>房屋保险（估算 · {costs.insuranceRate.toFixed(2)}%/年）</span><strong>{money.format(cost.insuranceMonthly)}</strong></li>
        <li>
          <span>HOA</span>
          {cost.hoaKnown ? <strong>{money.format(cost.hoaMonthly ?? 0)}</strong> : <strong className="cost-unknown">无 / 未知 · 未计入合计</strong>}
        </li>
      </ul>
      {cost.totalMonthly === null ? <p className="cost-note">合计为不含 HOA 的小计：该房源 HOA 无记录或未知，没有按 0 计入。</p> : null}
      <p className="cost-note cost-excludes">估算值 · 不含维修/装修</p>
      <p className="cost-note">贷款 {compactMoney.format(loan)} · {costs.downPayment}% 首付 · 利率 {costs.rate.toFixed(2)}%</p>
    </div>
  );
}

function ChecklistBlock({ listing }: { listing: Listing }) {
  return (
    <div className="checklist-block">
      <span>看房核对清单</span>
      <ul className="checklist-list">
        {listing.checklist.map((item) => (
          <li key={item.key}>
            <span className="checklist-label">
              {item.label}
              {item.state === "from-report"
                ? <em className="checklist-from">报告数据</em>
                : <em className="checklist-unverified">未核实</em>}
            </span>
            <p>{item.detail}</p>
          </li>
        ))}
      </ul>
      <p className="checklist-note">标「未核实」的项目报告中没有数据，看房时请亲自确认，不要当作已确认的事实。</p>
    </div>
  );
}

function DecisionControls({ listing, pending, onDecision }: { listing: Listing; pending: boolean; onDecision: (listing: Listing, decision: Decision | null) => void }) {
  return (
    <div className="decision-row" role="group" aria-label={`标记 ${listing.address} 的状态（三选一）`}>
      {(Object.keys(DECISION_META) as Decision[]).map((key) => {
        const meta = DECISION_META[key];
        const active = listing.decision === key;
        return (
          <button
            key={key}
            className={active ? "decision-button active" : "decision-button"}
            aria-pressed={active}
            disabled={pending}
            onClick={() => onDecision(listing, active ? null : key)}
          >
            <span aria-hidden="true">{meta.symbol}</span> {active ? meta.activeLabel : meta.label}
          </button>
        );
      })}
      <span className="decision-hint">收藏 / 排除 / 已看房 三选一，再点一次可清除</span>
    </div>
  );
}

function ListingRow({
  listing, costs, degraded = false, isOwner, decisionPending, onDecision, compareChecked, compareDisabled, onToggleCompare,
}: {
  listing: Listing;
  costs: CostInputs;
  degraded?: boolean;
  isOwner: boolean;
  decisionPending: boolean;
  onDecision: (listing: Listing, decision: Decision | null) => void;
  compareChecked: boolean;
  compareDisabled: boolean;
  onToggleCompare: (listing: Listing, checked: boolean) => void;
}) {
  const schoolDate = formatDateOnly(listing.schoolAsOf);
  return (
    <article className="listing-row">
      <div className="rank-block" aria-label={`推荐第 ${listing.rank} 名`}>
        <span className="rank-number">{String(listing.rank).padStart(2, "0")}</span>
        <span className="score">{listing.score} 分</span>
      </div>

      <div className="listing-main">
        <div className="listing-heading">
          <div>
            <p className="city-label">{listing.city}</p>
            <h3>{listing.address}</h3>
          </div>
          <div className="price-block">
            <strong>{compactMoney.format(listing.price)}</strong>
            {listing.priceChange !== null && listing.priceChange < 0 ? (
              <span className="price-cut">降价 {compactMoney.format(Math.abs(listing.priceChange))}</span>
            ) : null}
          </div>
        </div>

        <p className="status-line">
          <span className="status-chip">{listing.statusLabel}</span>
          <span className="status-verified">{listing.statusVerifiedLabel}</span>
          {degraded ? <span className="degraded-badge">降级展示 · 非可直接行动</span> : null}
          {listing.decision ? (
            <span className="decision-badge">{DECISION_META[listing.decision].symbol} {DECISION_META[listing.decision].activeLabel}</span>
          ) : null}
        </p>

        {listing.previousPrice !== null || listing.previousStatus !== null ? (
          <p className="change-line">
            {listing.previousPrice !== null ? (
              <span className="change-badge">价格变化：上期 {compactMoney.format(listing.previousPrice)} → 本期 {compactMoney.format(listing.price)}</span>
            ) : null}
            {listing.previousStatus !== null ? (
              <span className="change-badge">状态变化：上期 {STATUS_TEXT[listing.previousStatus] ?? listing.previousStatus} → 本期 {listing.statusLabel}</span>
            ) : null}
          </p>
        ) : null}

        <p className="verdict">{listing.verdict}</p>

        <dl className="fact-strip">
          <div><dt>户型</dt><dd>{listing.bedrooms} 房 · {listing.bathrooms} 卫</dd></div>
          <div><dt>室内</dt><dd>{listing.sqft.toLocaleString()} ft²</dd></div>
          <div><dt>建造</dt><dd>{listing.yearBuilt ?? "未标注"}</dd></div>
          <div><dt>单价</dt><dd>{listing.pricePerSqft ? `${money.format(listing.pricePerSqft)}/ft²` : "未标注"}</dd></div>
        </dl>

        <CostBlock listing={listing} costs={costs} />

        <details>
          <summary>查看判断依据</summary>
          <div className="detail-grid">
            <div><span>居住环境</span><p>{listing.environmentSummary}</p></div>
            <div>
              <span>学校</span>
              <p>{listing.schoolSummary}</p>
              <p className="source-line">
                学校评分来源：{listing.schoolSource ?? "来源未知"} · 日期：{schoolDate ?? "日期未知"}
                {listing.schoolFreshness === "stale" ? <> <StaleBadge /></> : null}
                {listing.schoolFreshness === "unknown" ? " · 无法判断是否过期" : null}
              </p>
            </div>
            <div><span>房屋状态</span><p>{listing.conditionSummary}</p></div>
            {listing.caution ? <div className="caution"><span>要确认</span><p>{listing.caution}</p></div> : null}
          </div>
          <SubScoreDetail listing={listing} />
          <ChecklistBlock listing={listing} />
        </details>

        {isOwner ? (
          <DecisionControls listing={listing} pending={decisionPending} onDecision={onDecision} />
        ) : null}

        <div className="listing-footer">
          <span>{listing.daysOnMarket === null ? "挂牌天数未标注" : `挂牌 ${listing.daysOnMarket} 天`}{listing.hoaMonthly ? ` · HOA ${money.format(listing.hoaMonthly)}/月` : ""}</span>
          <span className="footer-actions">
            <label className="compare-toggle">
              <input
                type="checkbox"
                checked={compareChecked}
                disabled={!compareChecked && compareDisabled}
                onChange={(event) => onToggleCompare(listing, event.target.checked)}
                aria-label={`把 ${listing.address} 加入对比`}
              />
              加入对比
            </label>
            <a href={listing.url} target="_blank" rel="noreferrer">查看 Redfin <span aria-hidden="true">↗</span></a>
          </span>
        </div>
      </div>
    </article>
  );
}

// HH1.2 fixed comparison columns — the set and order are fixed by
// spec and not user-customizable. Missing values render "—".
const COMPARE_COLUMNS = [
  { key: "price", label: "价格" },
  { key: "sqft", label: "居住面积" },
  { key: "lotSqft", label: "占地面积" },
  { key: "age", label: "房龄" },
  { key: "school", label: "学校" },
  { key: "environment", label: "道路/噪音" },
  { key: "status", label: "挂牌状态" },
  { key: "risk", label: "风险" },
  { key: "monthlyCost", label: "月成本" },
] as const;

type CompareKey = (typeof COMPARE_COLUMNS)[number]["key"];

function compareCell(listing: Listing, key: CompareKey, costs: CostInputs, currentYear: number): string {
  switch (key) {
    case "price":
      return money.format(listing.price);
    case "sqft":
      return `${listing.sqft.toLocaleString()} ft²`;
    case "lotSqft":
      return listing.lotSqft ? `${listing.lotSqft.toLocaleString()} ft²` : "—";
    case "age":
      return listing.yearBuilt ? `${currentYear - listing.yearBuilt} 年（${listing.yearBuilt} 建）` : "—";
    case "school":
      return listing.schoolSummary || "—";
    case "environment":
      return listing.environmentSummary || "—";
    case "status":
      return listing.statusTier === "degraded" ? `${listing.statusLabel}（降级展示）` : listing.statusLabel;
    case "risk": {
      const parts: string[] = [];
      if (listing.caution) parts.push(listing.caution);
      if (listing.subScores) {
        const detail = SUBSCORE_FIELDS.map(([k, label]) => `${label} ${listing.subScores?.[k] ?? "未评分"}`).join(" · ");
        parts.push(`分项分（已评 ${listing.scorePresentCount}/6）：${detail}`);
      } else {
        parts.push(`综合分 ${listing.score} 分（无分项评分）`);
      }
      return parts.join("；") || "—";
    }
    case "monthlyCost": {
      const cost = costBreakdown(listing.price, costs.downPayment, costs.rate, costs.taxRate, costs.insuranceRate, listing.hoaMonthly);
      return cost.totalMonthly !== null
        ? `${money.format(cost.totalMonthly)}/月（估算，含 HOA）`
        : `${money.format(cost.subtotalExcludingHoa)}/月（估算，HOA 未知未计入）`;
    }
  }
}

function CompareSection({ listings, costs, onClose }: { listings: Listing[]; costs: CostInputs; onClose: () => void }) {
  const currentYear = new Date().getFullYear();
  return (
    <section className="compare-section" aria-labelledby="compare-heading">
      <div className="section-heading">
        <h2 id="compare-heading">对比 {listings.length} 套房源</h2>
        <button className="compare-close" onClick={onClose}>关闭对比</button>
      </div>
      <p className="compare-note">对比列固定：价格、居住面积、占地面积、房龄、学校、道路/噪音、挂牌状态、风险、月成本（与列表同一估算口径）。缺失字段显示「—」，不猜测填充。</p>
      <div className="compare-homes">
        {listings.map((listing) => (
          <div key={listing.stableKey} className="compare-home">
            <p className="city-label">{listing.city}</p>
            <strong>{listing.address}</strong>
            <span>{listing.statusLabel}</span>
          </div>
        ))}
      </div>
      {COMPARE_COLUMNS.map((col) => (
        <div key={col.key} className="compare-attr">
          <h3>{col.label}</h3>
          <div className="compare-values" data-count={listings.length}>
            {listings.map((listing) => (
              <div key={listing.stableKey} className="compare-value">
                <span className="compare-addr">{listing.address}</span>
                <p>{compareCell(listing, col.key, costs, currentYear)}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [city, setCity] = useState<CityFilter>("全部");
  const [minSqft, setMinSqft] = useState(0);
  const [downPayment, setDownPayment] = useState(DEFAULT_DOWN_PAYMENT_PCT);
  const [rate, setRate] = useState(7.13);
  const [taxRate, setTaxRate] = useState(DEFAULT_TAX_RATE_PCT);
  const [insuranceRate, setInsuranceRate] = useState(DEFAULT_INSURANCE_RATE_PCT);
  const [showExcluded, setShowExcluded] = useState(false);
  const [compareKeys, setCompareKeys] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reportQuery = useQuery({
    queryKey: ["property-report"],
    queryFn: () => api.getReport({}),
    refetchInterval: (query) => query.state.data?.refresh.status === "running" ? 5000 : false,
  });

  useEffect(() => {
    const sourceRate = reportQuery.data?.report?.mortgageRate;
    if (sourceRate) setRate(sourceRate);
  }, [reportQuery.data?.report?.mortgageRate]);

  const refresh = useMutation({
    mutationFn: () => api.refreshReport({}),
    onSuccess: async (result) => {
      setNotice(result.message);
      await queryClient.invalidateQueries({ queryKey: ["property-report"] });
    },
    onError: () => setNotice("刷新没能启动，请稍后再试。"),
  });

  const decisionMutation = useMutation({
    mutationFn: (args: { stableKey: string; decision: Decision | null }) => api.setListingDecision(args),
    onSuccess: async (result) => {
      if (!result.ok) setNotice("只有报告所有者可以标记收藏 / 排除 / 已看房。");
      await queryClient.invalidateQueries({ queryKey: ["property-report"] });
    },
    onError: () => setNotice("标记没能保存，请稍后再试。"),
  });

  const report = reportQuery.data?.report ?? null;
  const isOwner = reportQuery.data?.viewerIsOwner ?? false;
  const costs: CostInputs = { downPayment, rate, taxRate, insuranceRate };

  const filtered = useMemo(() => {
    if (!report) return [];
    return report.listings.filter((item) => {
      const cityMatches = city === "全部" || item.city === city;
      const visibleByDecision = showExcluded || item.decision !== "excluded";
      return cityMatches && visibleByDecision && item.sqft >= minSqft;
    });
  }, [report, city, minSqft, showExcluded]);
  const filteredDegraded = useMemo(() => {
    if (!report) return [];
    return report.degradedListings.filter((item) => {
      const cityMatches = city === "全部" || item.city === city;
      const visibleByDecision = showExcluded || item.decision !== "excluded";
      return cityMatches && visibleByDecision && item.sqft >= minSqft;
    });
  }, [report, city, minSqft, showExcluded]);
  const excludedCount = useMemo(() => {
    if (!report) return 0;
    return [...report.listings, ...report.degradedListings].filter((item) => item.decision === "excluded").length;
  }, [report]);

  const compareListings = useMemo(() => {
    if (!report) return [];
    const all = [...report.listings, ...report.degradedListings];
    return compareKeys
      .map((key) => all.find((item) => item.stableKey === key))
      .filter((item): item is Listing => item !== undefined);
  }, [report, compareKeys]);

  const toggleCompare = (listing: Listing, checked: boolean) => {
    setCompareKeys((prev) => {
      if (checked) return prev.includes(listing.stableKey) || prev.length >= 4 ? prev : [...prev, listing.stableKey];
      return prev.filter((key) => key !== listing.stableKey);
    });
    if (!checked) setCompareOpen(false);
  };

  const handleDecision = (listing: Listing, decision: Decision | null) => {
    decisionMutation.mutate({ stableKey: listing.stableKey, decision });
  };

  const rowProps = {
    costs,
    isOwner,
    decisionPending: decisionMutation.isPending,
    onDecision: handleDecision,
    compareDisabled: compareKeys.length >= 4,
    onToggleCompare: toggleCompare,
  };

  if (reportQuery.isPending) {
    return <main className="loading-shell"><div className="loading-mark" /><p>正在打开看房报告…</p></main>;
  }

  if (reportQuery.error) {
    return (
      <main className="empty-shell">
        <h1>报告暂时打不开</h1>
        <p>数据读取失败了。请稍后再试。</p>
        <button onClick={() => reportQuery.refetch()}>重新加载</button>
      </main>
    );
  }

  if (!report) {
    return (
      <main className="empty-shell">
        <h1>第一期报告正在准备</h1>
        <p>房源短名单、街道环境和利率核对完成后会出现在这里。</p>
        <button disabled={refresh.isPending} onClick={() => refresh.mutate()}>{refresh.isPending ? "正在启动…" : "开始刷新"}</button>
      </main>
    );
  }

  const top = filtered[0];
  const topCost = top ? costBreakdown(top.price, downPayment, rate, taxRate, insuranceRate, top.hoaMonthly) : null;
  const refreshStatus = reportQuery.data?.refresh.status ?? "idle";
  const rateDate = formatDateOnly(report.rateAsOf);
  const rateModified = Math.abs(rate - report.mortgageRate) > 0.0001;

  return (
    <div className="app-shell">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main>
        <section className="report-intro">
          <div className="intro-line">
            <p className="as-of">报告日期：{formatAsOf(report.asOf)}</p>
            <button
              className="refresh-button"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending || refreshStatus === "running"}
              aria-label="刷新看房报告"
            >
              {refreshStatus === "running" ? "核对中…" : "刷新报告"}
            </button>
          </div>
          <h1>先看这几套</h1>
          <p className="summary-copy">{report.summary}</p>
          {notice ? <p className="notice" role="status">{notice}</p> : null}
          {reportQuery.data?.refresh.status === "error" && reportQuery.data.refresh.message ? (
            <p className="error-notice" role="status">上次刷新未完成：{reportQuery.data.refresh.message}</p>
          ) : null}
        </section>

        {top ? (
          <section className="hero" aria-labelledby="top-pick-heading">
            <div className="hero-copy">
              <p className="hero-label">当前筛选首选 · {top.city}</p>
              <h2 id="top-pick-heading">{top.address}</h2>
              <p>{top.verdict}</p>
              <a href={top.url} target="_blank" rel="noreferrer">查看房源 <span aria-hidden="true">↗</span></a>
            </div>
            <div className="hero-payment">
              <span>月成本估算 · 本金利息 + 地税 + 保险{topCost?.hoaKnown ? " + HOA" : ""}</span>
              <strong>{money.format(topCost?.totalMonthly ?? topCost?.subtotalExcludingHoa ?? 0)}</strong>
              <small>每月{topCost && !topCost.hoaKnown ? "（HOA 未知，未计入）" : ""} · {downPayment}% 首付 · {rate.toFixed(2)}% · 估算，不含维修/装修</small>
            </div>
          </section>
        ) : (
          <section className="hero hero-empty" aria-labelledby="top-pick-heading">
            <div className="hero-copy">
              <p className="hero-label">筛选结果</p>
              <h2 id="top-pick-heading">这个筛选下没有房源</h2>
              <p>可以降低最低面积门槛、显示已排除房源，或切回全部城市再看看。</p>
            </div>
          </section>
        )}

        <section className="controls" aria-label="筛选与贷款假设">
          <div className="control-group cities">
            <span className="control-label">城市</span>
            <div className="chip-row" role="group" aria-label="按城市筛选">
              {(["全部", "Santa Clara", "Sunnyvale", "Cupertino"] as const).map((item) => (
                <button key={item} className={city === item ? "chip active" : "chip"} onClick={() => setCity(item)} aria-pressed={city === item}>{item}</button>
              ))}
            </div>
            {excludedCount > 0 ? (
              <label className="excluded-toggle">
                <input type="checkbox" checked={showExcluded} onChange={(event) => setShowExcluded(event.target.checked)} aria-label="显示已排除的房源" />
                显示已排除（{excludedCount} 套）
              </label>
            ) : null}
          </div>
          <div className="finance-controls">
            <label>
              <span>最低室内面积</span>
              <select value={minSqft} onChange={(event) => setMinSqft(Number(event.target.value))} aria-label="最低室内面积">
                <option value={0}>不设门槛</option>
                <option value={1500}>1,500 ft²</option>
                <option value={1800}>1,800 ft²</option>
                <option value={2000}>2,000 ft²</option>
              </select>
            </label>
            <label>
              <span>首付比例{downPayment !== DEFAULT_DOWN_PAYMENT_PCT ? "（已修改）" : "（默认）"}</span>
              <select value={downPayment} onChange={(event) => setDownPayment(Number(event.target.value))} aria-label="首付比例">
                <option value={20}>20%</option>
                <option value={30}>30%</option>
                <option value={40}>40%</option>
              </select>
            </label>
            <label>
              <span>年利率{rateModified ? "（已修改）" : "（报告值）"}</span>
              <div className="rate-input"><input type="number" min="0.1" max="20" step="0.05" value={rate} onChange={(event) => setRate(Number(event.target.value))} aria-label="年利率百分比" /><b>%</b></div>
            </label>
            <label>
              <span>地税年税率{taxRate !== DEFAULT_TAX_RATE_PCT ? "（已修改）" : "（默认）"}</span>
              <div className="rate-input"><input type="number" min="0" max="5" step="0.01" value={taxRate} onChange={(event) => setTaxRate(Number(event.target.value))} aria-label="地税年税率百分比（估算）" /><b>%</b></div>
            </label>
            <label>
              <span>保险年费率{insuranceRate !== DEFAULT_INSURANCE_RATE_PCT ? "（已修改）" : "（默认）"}</span>
              <div className="rate-input"><input type="number" min="0" max="5" step="0.01" value={insuranceRate} onChange={(event) => setInsuranceRate(Number(event.target.value))} aria-label="房屋保险年费率百分比（估算）" /><b>%</b></div>
            </label>
          </div>
          <p className="rate-source">
            {report.rateLabel}：<strong>{report.mortgageRate.toFixed(2)}%</strong> · 来源 <a href={report.rateUrl} target="_blank" rel="noreferrer">{report.rateSource}</a>
            {" "}· 来源日期：{rateDate ?? "日期未知"}
            {report.rateFreshness === "stale" ? <> <StaleBadge /></> : null}
            {report.rateFreshness === "unknown" ? " · 无法判断是否过期" : null}
          </p>
          <p className="assumption-note">
            月成本为估算：地税默认按 Santa Clara 县约 1.18%/年 × 房价、保险默认约 0.20%/年 × 房价（均可在上方修改，标「默认」即未修改）；HOA 按房源记录，无记录时标「无/未知」且不计入合计。估算不含维修/装修。
          </p>
        </section>

        {compareKeys.length > 0 ? (
          <section className="compare-bar" aria-label="对比选择">
            <span>已选 {compareListings.length} 套对比（可选 2–4 套）</span>
            <span className="compare-bar-actions">
              <button
                className="compare-open-button"
                disabled={compareListings.length < 2}
                onClick={() => setCompareOpen(true)}
                aria-label="查看所选房源对比"
              >
                查看对比
              </button>
              <button
                className="compare-clear-button"
                onClick={() => { setCompareKeys([]); setCompareOpen(false); }}
                aria-label="清除对比选择"
              >
                清除
              </button>
            </span>
          </section>
        ) : null}

        {compareOpen && compareListings.length >= 2 ? (
          <CompareSection listings={compareListings} costs={costs} onClose={() => setCompareOpen(false)} />
        ) : null}

        <section className="results" aria-labelledby="results-heading">
          <div className="section-heading">
            <h2 id="results-heading">{filtered.length} 套进入短名单</h2>
            <p>报告日期 {formatAsOf(report.asOf)} · 按综合推荐排序</p>
          </div>
          {filtered.length > 0 ? (
            <div className="listing-list">
              {filtered.map((item) => (
                <ListingRow
                  key={item.id}
                  listing={item}
                  {...rowProps}
                  compareChecked={compareKeys.includes(item.stableKey)}
                />
              ))}
            </div>
          ) : (
            <div className="no-results">
              <h3>这个筛选下没有房源</h3>
              <p>可以降低最低面积，或切回"全部"城市。</p>
              <button onClick={() => { setCity("全部"); setMinSqft(0); }}>清除筛选</button>
            </div>
          )}
        </section>

        {filteredDegraded.length > 0 ? (
          <section className="results degraded-section" aria-labelledby="degraded-heading">
            <div className="section-heading">
              <h2 id="degraded-heading">{filteredDegraded.length} 套待成交 / 未确认房源</h2>
              <p>降级展示</p>
            </div>
            <p className="degraded-note">以下房源为 ◐ 已有条件成交、◐ 待成交或 ◐ 状态未确认，非可直接行动：可能已有买家在推进，或状态尚未核实。它们不进入上面的推荐排名；如仍感兴趣，先向经纪确认最新状态。</p>
            <div className="listing-list">
              {filteredDegraded.map((item) => (
                <ListingRow
                  key={item.id}
                  listing={item}
                  {...rowProps}
                  compareChecked={compareKeys.includes(item.stableKey)}
                  degraded
                />
              ))}
            </div>
          </section>
        ) : null}

        <footer>
          <p>月供为估算（含本金利息、地税与保险估算，HOA 按房源记录），不含维修/装修；地税与保险按上方假设费率计算，不是实际账单。挂牌状态与利率会变化，出价前请向贷款方和房产经纪再次确认。</p>
        </footer>
      </main>
    </div>
  );
}
