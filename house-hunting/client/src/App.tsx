import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type ReportPayload = NonNullable<ApiResponse<typeof api, "getReport">["report"]>;
type Listing = ReportPayload["listings"][number];

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

function monthlyPayment(price: number, downPayment: number, annualRate: number) {
  const principal = price * (1 - downPayment / 100);
  const monthlyRate = annualRate / 100 / 12;
  const months = 360;
  if (monthlyRate === 0) return principal / months;
  const factor = Math.pow(1 + monthlyRate, months);
  return (principal * monthlyRate * factor) / (factor - 1);
}

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

function ListingRow({ listing, rate, downPayment }: { listing: Listing; rate: number; downPayment: number }) {
  const payment = monthlyPayment(listing.price, downPayment, rate);
  const loan = listing.price * (1 - downPayment / 100);

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

        <p className="verdict">{listing.verdict}</p>

        <dl className="fact-strip">
          <div><dt>户型</dt><dd>{listing.bedrooms} 房 · {listing.bathrooms} 卫</dd></div>
          <div><dt>室内</dt><dd>{listing.sqft.toLocaleString()} ft²</dd></div>
          <div><dt>建造</dt><dd>{listing.yearBuilt ?? "未标注"}</dd></div>
          <div><dt>单价</dt><dd>{listing.pricePerSqft ? `${money.format(listing.pricePerSqft)}/ft²` : "未标注"}</dd></div>
        </dl>

        <div className="payment-line">
          <span>预计本金 + 利息</span>
          <strong>{money.format(payment)}<small>/月</small></strong>
          <span className="loan-note">贷款 {compactMoney.format(loan)}</span>
        </div>

        <details>
          <summary>查看判断依据</summary>
          <div className="detail-grid">
            <div><span>居住环境</span><p>{listing.environmentSummary}</p></div>
            <div><span>学校</span><p>{listing.schoolSummary}</p></div>
            <div><span>房屋状态</span><p>{listing.conditionSummary}</p></div>
            {listing.caution ? <div className="caution"><span>要确认</span><p>{listing.caution}</p></div> : null}
          </div>
        </details>

        <div className="listing-footer">
          <span>{listing.daysOnMarket === null ? "挂牌天数未标注" : `挂牌 ${listing.daysOnMarket} 天`}{listing.hoaMonthly ? ` · HOA ${money.format(listing.hoaMonthly)}/月` : ""}</span>
          <a href={listing.url} target="_blank" rel="noreferrer">查看 Redfin <span aria-hidden="true">↗</span></a>
        </div>
      </div>
    </article>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [city, setCity] = useState<CityFilter>("全部");
  const [minSqft, setMinSqft] = useState(0);
  const [downPayment, setDownPayment] = useState(30);
  const [rate, setRate] = useState(7.13);
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

  const report = reportQuery.data?.report ?? null;
  const filtered = useMemo(() => {
    if (!report) return [];
    return report.listings.filter((item) => {
      const cityMatches = city === "全部" || item.city === city;
      return cityMatches && item.sqft >= minSqft;
    });
  }, [report, city, minSqft]);

  if (reportQuery.isPending) {
    return <main className="loading-shell"><div className="loading-mark" /><p>正在打开本周报告…</p></main>;
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

  const top = filtered[0] ?? report.listings[0];
  const topPayment = top ? monthlyPayment(top.price, downPayment, rate) : 0;
  const refreshStatus = reportQuery.data?.refresh.status ?? "idle";

  return (
    <div className="app-shell">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main>
        <section className="report-intro">
          <div className="intro-line">
            <p className="as-of">更新于 {formatAsOf(report.asOf)}</p>
            <button
              className="refresh-button"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending || refreshStatus === "running"}
              aria-label="刷新每周看房报告"
            >
              {refreshStatus === "running" ? "核对中…" : "刷新报告"}
            </button>
          </div>
          <h1>本周先看这几套</h1>
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
              <span>30 年固定 · 本金 + 利息</span>
              <strong>{money.format(topPayment)}</strong>
              <small>每月 · {downPayment}% 首付 · {rate.toFixed(2)}%</small>
            </div>
          </section>
        ) : null}

        <section className="controls" aria-label="筛选与贷款假设">
          <div className="control-group cities">
            <span className="control-label">城市</span>
            <div className="chip-row" role="group" aria-label="按城市筛选">
              {(["全部", "Santa Clara", "Sunnyvale", "Cupertino"] as const).map((item) => (
                <button key={item} className={city === item ? "chip active" : "chip"} onClick={() => setCity(item)} aria-pressed={city === item}>{item}</button>
              ))}
            </div>
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
              <span>首付比例</span>
              <select value={downPayment} onChange={(event) => setDownPayment(Number(event.target.value))} aria-label="首付比例">
                <option value={20}>20%</option>
                <option value={30}>30%</option>
                <option value={40}>40%</option>
              </select>
            </label>
            <label>
              <span>年利率</span>
              <div className="rate-input"><input type="number" min="0.1" max="20" step="0.05" value={rate} onChange={(event) => setRate(Number(event.target.value))} aria-label="年利率百分比" /><b>%</b></div>
            </label>
          </div>
          <p className="rate-source">
            {report.rateLabel}：<strong>{report.mortgageRate.toFixed(2)}%</strong> · <a href={report.rateUrl} target="_blank" rel="noreferrer">{report.rateSource}</a>
          </p>
        </section>

        <section className="results" aria-labelledby="results-heading">
          <div className="section-heading">
            <h2 id="results-heading">{filtered.length} 套进入本周短名单</h2>
            <p>按综合推荐排序</p>
          </div>
          {filtered.length > 0 ? (
            <div className="listing-list">
              {filtered.map((item) => <ListingRow key={item.id} listing={item} rate={rate} downPayment={downPayment} />)}
            </div>
          ) : (
            <div className="no-results">
              <h3>这个筛选下没有房源</h3>
              <p>可以降低最低面积，或切回“全部”城市。</p>
              <button onClick={() => { setCity("全部"); setMinSqft(0); }}>清除筛选</button>
            </div>
          )}
        </section>

        <footer>
          <p>月供仅含本金与利息，不含地税、房屋保险和 HOA。挂牌状态与利率会变化，出价前请向贷款方和房产经纪再次确认。</p>
        </footer>
      </main>
    </div>
  );
}
