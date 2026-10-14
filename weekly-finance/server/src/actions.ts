import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { eq } from "drizzle-orm";
import * as schema from "./schema";

const financeTypeSchema = z.enum([
  "investment",
  "investment_contribution",
  "account",
  "fixed_spend",
  "transfer",
  "income",
]);

const sourceEntrySchema = z.object({
  financeSource: z.string().min(1).max(160),
  type: financeTypeSchema,
  number: z.number(),
});

const rawMonthSchema = z.object({
  key: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entries: z.array(sourceEntrySchema).max(200),
});

const plaidAccountSchema = z.object({
  institution: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  type: z.string().min(1).max(40),
  subtype: z.string().max(80).nullable().optional(),
  mask: z.string().regex(/^\d{2,4}$/).nullable(),
  current: z.number().nullable(),
});

const holdingInputSchema = z.object({
  ticker: z.string().max(32).nullable(),
  name: z.string().min(1).max(180),
  value: z.number(),
});

const plaidTransactionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number(),
  name: z.string().min(1).max(240),
  pending: z.boolean().default(false),
  internalTransfer: z.boolean().default(false),
  transferLike: z.boolean().default(false),
});

const transactionCoverageSchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  complete: z.boolean(),
}).nullable();

const monthSchema = z.object({
  key: z.string(),
  total: z.number(),
  investment: z.number(),
  investmentContribution: z.number(),
  saving: z.number(),
  deposits: z.number().nullable().default(null),
  loans: z.number().nullable().default(null),
  fixedSpend: z.number(),
  transfer: z.number(),
  income: z.number(),
  contribution: z.number(),
  flexibleSpend: z.number(),
  flexibleSpendAnomaly: z.boolean().default(false),
  totalSpend: z.number(),
  investmentReturn: z.number().nullable(),
});

const holdingSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  value: z.number(),
  share: z.number(),
});

const accountSchema = z.object({
  source: z.string(),
  label: z.string(),
  type: financeTypeSchema,
  value: z.number(),
  live: z.boolean(),
  institution: z.string().nullable(),
  mask: z.string().nullable(),
});

const dashboardSchema = z.object({
  asOf: z.string(),
  sourceMonth: z.string(),
  months: z.array(monthSchema),
  live: z.object({
    netWorth: z.number(),
    investment: z.number(),
    saving: z.number(),
    deposits: z.number().nullable().default(null),
    loans: z.number().nullable().default(null),
    weeklyDelta: z.number().nullable(),
  }),
  holdings: z.array(holdingSchema),
  cashPosition: z.number().nullable().default(null),
  concentrationTop3: z.number(),
  accounts: z.array(accountSchema),
  fire: z.object({
    annualContribution: z.number(),
    annualSpend: z.number(),
    target: z.number(),
    progress: z.number().nullable(),
    gap: z.number(),
  }),
});

type Dashboard = z.infer<typeof dashboardSchema>;
type SourceEntry = z.infer<typeof sourceEntrySchema>;
type RawMonth = z.infer<typeof rawMonthSchema>;
type PlaidAccount = z.infer<typeof plaidAccountSchema>;
type HoldingInput = z.infer<typeof holdingInputSchema>;
type PlaidTransaction = z.infer<typeof plaidTransactionSchema>;
type TransactionCoverage = z.infer<typeof transactionCoverageSchema>;

const refreshResponse = z.object({
  ok: z.boolean(),
  status: z.enum(["started", "already_running", "error", "forbidden"]),
  message: z.string(),
});

const ingestResponse = z.object({ ok: z.boolean(), savedMonths: z.number() });

const excludedLiveSources = new Set([
  "titan",
  "titan_ira",
  "wealthfront_saving",
  "citi",
  "usbank_cc",
  "bonds",
]);

function isOwner(ctx: Ctx): boolean {
  return ctx.viewer?.isOwner === true;
}

function displayLabel(source: string): string {
  return source
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function contribution(month: { investmentContribution: number; transfer: number }): number {
  return month.investmentContribution || month.transfer || 0;
}

function monthEnd(monthKey: string): string {
  const [year = 0, month = 0] = monthKey.slice(0, 7).split("-").map(Number);
  if (!year || !month) return "";
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function subtractDays(dateText: string, days: number): string | null {
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function amountMatches(amount: number, candidate: number): boolean {
  return Math.abs(Math.abs(amount) - Math.abs(candidate)) <= Math.max(2, Math.abs(candidate) * 0.01);
}

function transactionSpendForMonth(
  month: RawMonth,
  transactions: PlaidTransaction[],
): number {
  const monthPrefix = month.key.slice(0, 7);
  const fixedAmounts = month.entries.filter((entry) => entry.type === "fixed_spend").map((entry) => entry.number);
  const contributionAmounts = month.entries
    .filter((entry) => entry.type === "investment_contribution" || entry.type === "transfer")
    .map((entry) => entry.number);
  return transactions
    .filter((transaction) => transaction.date.startsWith(monthPrefix) && !transaction.pending && transaction.amount > 0)
    .filter((transaction) => {
      if (transaction.internalTransfer) return false;
      if (!transaction.transferLike) return true;
      if (fixedAmounts.some((amount) => amountMatches(transaction.amount, amount))) return true;
      if (contributionAmounts.some((amount) => amountMatches(transaction.amount, amount))) return false;
      return transaction.amount < 5_000;
    })
    .reduce((sum, transaction) => sum + transaction.amount, 0);
}

function aggregateMonths(
  rawMonths: RawMonth[],
  transactions: PlaidTransaction[],
  coverage: TransactionCoverage,
  asOf: string,
): Dashboard["months"] {
  const sorted = [...rawMonths]
    .filter((month) => !Number.isNaN(new Date(`${month.key}T00:00:00`).getTime()))
    .sort((a, b) => a.key.localeCompare(b.key));

  const base = sorted.map((month) => {
    const result = {
      key: month.key,
      total: 0,
      investment: 0,
      investmentContribution: 0,
      saving: 0,
      deposits: 0,
      loans: 0,
      fixedSpend: 0,
      transfer: 0,
      income: 0,
    };
    for (const entry of month.entries) {
      if (entry.type === "investment") {
        result.investment += entry.number;
        result.total += entry.number;
      } else if (entry.type === "investment_contribution") {
        result.investmentContribution += entry.number;
      } else if (entry.type === "account") {
        result.saving += entry.number;
        if (entry.number < 0) result.loans += Math.abs(entry.number);
        else result.deposits += entry.number;
        result.total += entry.number;
      } else if (entry.type === "fixed_spend") {
        result.fixedSpend += entry.number;
      } else if (entry.type === "transfer") {
        result.transfer += entry.number;
      } else if (entry.type === "income") {
        result.income += entry.number;
      }
    }
    return result;
  });

  return base.map((month, index) => {
    const previous = index > 0 ? base[index - 1] : undefined;
    const monthContribution = contribution(month);
    const inferredFlexibleSpend =
      month.income -
      monthContribution -
      month.fixedSpend -
      (month.saving - (previous?.saving ?? 0));
    const monthStart = `${month.key.slice(0, 7)}-01`;
    const end = monthEnd(month.key);
    const fullTransactionCoverage = Boolean(
      coverage?.complete &&
      end &&
      monthStart >= coverage.start &&
      end <= coverage.end,
    );
    const lookbackStart = subtractDays(asOf, 730);
    const shouldHaveTransactionCoverage = Boolean(lookbackStart && end && end >= lookbackStart);
    const transactionSpend = fullTransactionCoverage
      ? transactionSpendForMonth(sorted[index] ?? { key: month.key, entries: [] }, transactions)
      : null;
    const rawFlexibleSpend = transactionSpend == null
      ? inferredFlexibleSpend
      : transactionSpend - month.fixedSpend;
    const flexibleSpend = Math.max(0, rawFlexibleSpend);
    const investmentReturn = previous
      ? month.investment - previous.investment - monthContribution
      : null;
    return {
      ...month,
      contribution: monthContribution,
      flexibleSpend,
      flexibleSpendAnomaly: transactionSpend == null
        ? (shouldHaveTransactionCoverage || rawFlexibleSpend < 0)
        : rawFlexibleSpend < 0,
      totalSpend: month.fixedSpend + flexibleSpend,
      investmentReturn,
    };
  });
}

function sourceCanUseLive(source: string): boolean {
  const lower = source.toLowerCase();
  if (excludedLiveSources.has(lower) || lower.startsWith("fidelity_")) return false;
  return /_\d{4}$/.test(lower);
}

function normalizedLiveValue(account: PlaidAccount): number | null {
  if (account.current == null || !Number.isFinite(account.current)) return null;
  const type = account.type.toLowerCase();
  if (type === "credit" || type === "loan") return -Math.abs(account.current);
  return account.current;
}

function findPlaidAccount(source: string, plaidAccounts: PlaidAccount[]): PlaidAccount | undefined {
  if (!sourceCanUseLive(source)) return undefined;
  const mask = source.slice(-4);
  const candidates = plaidAccounts.filter((account) => account.mask === mask && account.current != null);
  if (candidates.length <= 1) return candidates[0];
  const normalizedSource = source.toLowerCase().replace(/[^a-z0-9]/g, "");
  return candidates.find((account) => {
    const institution = account.institution.toLowerCase().replace(/[^a-z0-9]/g, "");
    const name = account.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return normalizedSource.includes(institution) || normalizedSource.includes(name);
  }) ?? candidates[0];
}

function mergeLatestEntries(entries: SourceEntry[], plaidAccounts: PlaidAccount[]): Dashboard["accounts"] {
  return entries.map((entry) => {
    const match = findPlaidAccount(entry.financeSource, plaidAccounts);
    const liveValue = match ? normalizedLiveValue(match) : null;
    return {
      source: entry.financeSource,
      label: displayLabel(entry.financeSource),
      type: entry.type,
      value: liveValue ?? entry.number,
      live: liveValue != null,
      institution: match?.institution ?? null,
      mask: match?.mask ?? null,
    };
  });
}

function cleanSecurityName(name: string, ticker: string): string {
  const compact = name.trim().replace(/\s+/g, " ");
  const repeated = compact.match(/^(.+?)(?:\s*[·|/—-]\s*|\s+)(\1)$/i);
  if (repeated?.[1]) return repeated[1].trim();
  const words = compact.split(" ");
  if (words.length > 1 && words.length % 2 === 0) {
    const midpoint = words.length / 2;
    const firstHalf = words.slice(0, midpoint).join(" ");
    const secondHalf = words.slice(midpoint).join(" ");
    if (firstHalf.localeCompare(secondHalf, undefined, { sensitivity: "accent" }) === 0) return firstHalf;
  }
  return compact.toUpperCase() === ticker ? "" : compact;
}

function normalizeHoldings(inputs: HoldingInput[]): {
  holdings: Dashboard["holdings"];
  cashPosition: number | null;
  concentrationTop3: number;
} {
  const byTicker = new Map<string, { name: string; value: number }>();
  let cashPosition = 0;
  for (const item of inputs) {
    if (!Number.isFinite(item.value) || item.value <= 0) continue;
    const ticker = (item.ticker?.trim() || item.name.trim()).toUpperCase();
    if (!ticker) continue;
    if (ticker === "CUR:USD") {
      cashPosition += item.value;
      continue;
    }
    const current = byTicker.get(ticker);
    byTicker.set(ticker, {
      name: current?.name || cleanSecurityName(item.name, ticker),
      value: (current?.value ?? 0) + item.value,
    });
  }
  const sorted = [...byTicker.entries()]
    .map(([ticker, item]) => ({ ticker, ...item }))
    .sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, item) => sum + item.value, 0);
  const holdings = sorted.slice(0, 10).map((item) => ({
    ...item,
    share: total > 0 ? item.value / total : 0,
  }));
  const concentrationTop3 = total > 0
    ? sorted.slice(0, 3).reduce((sum, item) => sum + item.value, 0) / total
    : 0;
  return { holdings, cashPosition: cashPosition > 0 ? cashPosition : null, concentrationTop3 };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function completeFireMonths(months: Dashboard["months"], asOf: string): Dashboard["months"] {
  const asOfMonth = asOf.match(/^\d{4}-\d{2}/)?.[0];
  if (!asOfMonth) return months.slice(-12);
  return months.filter((month) => month.key.slice(0, 7) < asOfMonth).slice(-12);
}

function normalizedFireSpend(month: Dashboard["months"][number]): number {
  return Math.max(0, month.fixedSpend + Math.max(0, month.flexibleSpend));
}

function normalizeFireMetrics(dashboard: Dashboard): Dashboard {
  const months = dashboard.months.map((month) => {
    const hadNegativeFlexibleSpend = month.flexibleSpend < 0;
    const flexibleSpend = Math.max(0, month.flexibleSpend);
    return {
      ...month,
      flexibleSpend,
      flexibleSpendAnomaly: month.flexibleSpendAnomaly || hadNegativeFlexibleSpend,
      totalSpend: month.fixedSpend + flexibleSpend,
    };
  });
  const fireMonths = completeFireMonths(months, dashboard.asOf);
  const fireSpendMonths = fireMonths.filter((month) => !month.flexibleSpendAnomaly);
  const annualContribution = average(fireMonths.map((month) => month.contribution)) * 12;
  const annualSpend = average(fireSpendMonths.map(normalizedFireSpend)) * 12;
  const target = annualSpend > 0 ? annualSpend / 0.04 : 0;
  const progress = target > 0 ? dashboard.live.netWorth / target : null;
  return {
    ...dashboard,
    months,
    fire: {
      annualContribution,
      annualSpend,
      target,
      progress,
      gap: Math.max(0, target - dashboard.live.netWorth),
    },
  };
}

function buildDashboard(
  asOf: string,
  rawMonths: RawMonth[],
  plaidAccounts: PlaidAccount[],
  holdingInputs: HoldingInput[],
  plaidTransactions: PlaidTransaction[],
  transactionCoverage: TransactionCoverage,
  previousLiveNetWorth: number | null,
): Dashboard | null {
  const months = aggregateMonths(rawMonths, plaidTransactions, transactionCoverage, asOf);
  const latestRaw = [...rawMonths].sort((a, b) => a.key.localeCompare(b.key)).at(-1);
  if (!latestRaw || months.length === 0) return null;
  const accounts = mergeLatestEntries(latestRaw.entries, plaidAccounts);
  const liveInvestment = accounts
    .filter((account) => account.type === "investment")
    .reduce((sum, account) => sum + account.value, 0);
  const cashAccounts = accounts.filter((account) => account.type === "account");
  const liveDeposits = cashAccounts
    .filter((account) => account.value >= 0)
    .reduce((sum, account) => sum + account.value, 0);
  const liveLoans = cashAccounts
    .filter((account) => account.value < 0)
    .reduce((sum, account) => sum + Math.abs(account.value), 0);
  const liveSaving = liveDeposits - liveLoans;
  const liveNetWorth = liveInvestment + liveDeposits - liveLoans;
  const recent = completeFireMonths(months, asOf);
  const recentSpendMonths = recent.filter((month) => !month.flexibleSpendAnomaly);
  const annualContribution = average(recent.map((month) => month.contribution)) * 12;
  const annualSpend = average(recentSpendMonths.map(normalizedFireSpend)) * 12;
  const target = annualSpend > 0 ? annualSpend / 0.04 : 0;
  const progress = target > 0 ? liveNetWorth / target : null;
  const normalized = normalizeHoldings(holdingInputs);

  return {
    asOf,
    sourceMonth: latestRaw.key,
    months,
    live: {
      netWorth: liveNetWorth,
      investment: liveInvestment,
      saving: liveSaving,
      deposits: liveDeposits,
      loans: liveLoans,
      weeklyDelta: previousLiveNetWorth == null ? null : liveNetWorth - previousLiveNetWorth,
    },
    holdings: normalized.holdings,
    cashPosition: normalized.cashPosition,
    concentrationTop3: normalized.concentrationTop3,
    accounts: accounts.sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return Math.abs(b.value) - Math.abs(a.value);
    }),
    fire: {
      annualContribution,
      annualSpend,
      target,
      progress,
      gap: Math.max(0, target - liveNetWorth),
    },
  };
}

function ensureSeparatedCashPosition(dashboard: Dashboard): Dashboard {
  let cashPosition = dashboard.cashPosition ?? 0;
  const ranked = dashboard.holdings
    .filter((holding) => {
      if (holding.ticker.toUpperCase() !== "CUR:USD") return true;
      cashPosition += holding.value;
      return false;
    })
    .map((holding) => ({
      ...holding,
      name: cleanSecurityName(holding.name, holding.ticker),
    }));
  const total = ranked.reduce((sum, holding) => sum + holding.value, 0);
  const holdings = ranked.slice(0, 10).map((holding) => ({
    ...holding,
    share: total > 0 ? holding.value / total : 0,
  }));
  return {
    ...dashboard,
    holdings,
    cashPosition: cashPosition > 0 ? cashPosition : null,
    concentrationTop3: total > 0
      ? ranked.slice(0, 3).reduce((sum, holding) => sum + holding.value, 0) / total
      : 0,
  };
}

function ensureSplitBalances(dashboard: Dashboard): Dashboard {
  if (dashboard.live.deposits != null && dashboard.live.loans != null) return dashboard;
  const cashAccounts = dashboard.accounts.filter((account) => account.type === "account");
  const deposits = cashAccounts
    .filter((account) => account.value >= 0)
    .reduce((sum, account) => sum + account.value, 0);
  const loans = cashAccounts
    .filter((account) => account.value < 0)
    .reduce((sum, account) => sum + Math.abs(account.value), 0);
  return {
    ...dashboard,
    live: {
      ...dashboard.live,
      deposits,
      loans,
    },
  };
}

async function getState(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.financeState).where(eq(schema.financeState.id, 1)).limit(1);
  return rows[0];
}

const staleRefreshThresholdMs = 2 * 60 * 60 * 1000;

function isStaleRunningState(state: Awaited<ReturnType<typeof getState>>): boolean {
  return Boolean(
    state?.status === "running" &&
    Date.now() - state.updatedAt.getTime() > staleRefreshThresholdMs,
  );
}

async function writeState(
  ctx: Ctx,
  values: {
    payload?: string | null;
    previousLiveNetWorth?: number | null;
    status: "idle" | "running" | "error";
    taskId?: string | null;
    message?: string | null;
  },
) {
  const existing = await getState(ctx);
  const row = {
    id: 1,
    payload: values.payload === undefined ? (existing?.payload ?? null) : values.payload,
    previousLiveNetWorth: values.previousLiveNetWorth === undefined
      ? (existing?.previousLiveNetWorth ?? null)
      : values.previousLiveNetWorth,
    status: values.status,
    taskId: values.taskId ?? null,
    message: values.message ?? null,
    updatedAt: new Date(),
  };
  await ctx.db<typeof schema>()
    .insert(schema.financeState)
    .values(row)
    .onConflictDoUpdate({ target: schema.financeState.id, set: row });
}

export const Actions = {
  getDashboard: defineAction({
    request: z.object({}),
    response: z.object({
      access: z.enum(["owner", "guest_denied"]),
      data: dashboardSchema.nullable(),
      refresh: z.object({
        status: z.enum(["idle", "running", "error"]),
        message: z.string().nullable(),
        updatedAt: z.string().nullable(),
      }),
    }),
    async handler(ctx) {
      if (!isOwner(ctx)) {
        return {
          access: "guest_denied" as const,
          data: null,
          refresh: { status: "idle" as const, message: "财务数据仅所有者可查看", updatedAt: null },
        };
      }
      const state = await getState(ctx);
      let data: Dashboard | null = null;
      if (state?.payload) {
        const parsed = dashboardSchema.safeParse(JSON.parse(state.payload));
        if (parsed.success) data = normalizeFireMetrics(ensureSplitBalances(ensureSeparatedCashPosition(parsed.data)));
      }
      const staleRunning = isStaleRunningState(state);
      return {
        access: "owner" as const,
        data,
        refresh: {
          status: staleRunning ? "error" : (state?.status ?? "idle"),
          message: staleRunning ? "上次更新未完成，可以重新更新" : (state?.message ?? null),
          updatedAt: state?.updatedAt?.toISOString() ?? null,
        },
      };
    },
  }),

  refreshFinanceData: defineAction({
    request: z.object({}),
    response: refreshResponse,
    async handler(ctx): Promise<z.infer<typeof refreshResponse>> {
      if (!isOwner(ctx)) {
        return { ok: false, status: "forbidden", message: "财务数据仅所有者可更新" };
      }
      const state = await getState(ctx);
      if (state?.status === "running" && !isStaleRunningState(state)) {
        return { ok: true, status: "already_running", message: "每周更新正在进行中" };
      }
      await writeState(ctx, { status: "running", message: "正在同步 Firance 与 Plaid" });
      ctx.invalidateQueries();
      const task = await ctx.agent.spawnTask(
        `刷新“每周财务总览”的真实数据。只读，不得写 Mac 文件，不得操作任何金融账户。\n\n1. 先定位目标设备：用设备列表工具列出当前可访问的设备，按设备名找到用户的 Mac mini（设备名含 “Mac mini” 的那台），本次刷新只使用这个运行时解析出的设备 ID。若按设备名找不到 Mac mini，或有多台候选无法唯一确定，不要猜测、不要用任何预置或写死的 ID 兜底，立即以 success:false 回调 ingestFinanceData 并在 error 中明确说明未能按设备名定位 Mac mini。在定位到的 Mac mini 上，先在运行时解析当前登录用户的主目录（home directory），再据此构造 Firance 数据目录为 <home>/Library/Application Support/Firance/FinanceData/（即 ~/Library/Application Support/Firance/FinanceData/）；不得使用任何写死的用户名或绝对用户路径。若无法解析主目录，不要猜测路径，立即以 success:false 回调 ingestFinanceData 并在 error 中说明无法解析主目录。然后用文件列表工具列出该目录，再读取全部文件名符合 YYYY-MM-DD 的无扩展名文件。每条记录是连续三行 key/value，key 为 finance_source、type、number，但三行顺序会变化，必须按 key 解析。只保留 type 为 investment、investment_contribution、account、fixed_spend、transfer、income 且 number 为有限数字的记录。若 Mac 不在线或文件读取失败，不要伪造；用 success:false 回调并说明失败。\n2. 在 Muse runtime 依次运行只读命令 plaid accounts、plaid liabilities、plaid investments-holdings。将账户整理为 institution/name/type/subtype/mask/current。将 mortgage current 余额作为 loan 账户返回；不要返回内部 account_id 或 credential_id。将 holdings 按 security_id 与 securities 关联后返回 ticker/name/institution_value；不要返回任何内部 ID、原始 JSON 或凭证。\n3. 再用 Plaid transactions 拉取 checking/savings 账户最多最近 730 天的交易，分页取全。只返回 date、amount、name、pending，以及根据 Plaid 类别和交易对手判断的 internalTransfer（自己名下账户互转）与 transferLike（疑似转账）布尔值；Plaid 正数表示流出。返回 transactionCoverage={start,end,complete}，只有覆盖区间内分页完整无缺失时 complete=true；交易读取失败时保留其他数据并将 transactionCoverage 设为 null、plaidTransactions 设为空数组。\n4. 完成后调用 ingestFinanceData。成功参数必须是：{success:true,asOf:<带时区ISO>,months:[{key,entries:[{financeSource,type,number}]}],plaidAccounts:[{institution,name,type,subtype,mask,current}],holdings:[{ticker,name,value}],plaidTransactions:[{date,amount,name,pending,internalTransfer,transferLike}],transactionCoverage:{start,end,complete}|null}。Firance、账户余额或持仓任一步无法可靠完成时调用 {success:false,error:<简洁中文>}；只有交易读取失败按上述方式回退，不使整次刷新失败。不要发送聊天消息。`,
        { expectsAction: "ingestFinanceData", dedupeKey: "weekly-firance-finance-refresh" },
      );
      if (!task.ok) {
        await writeState(ctx, { status: "error", message: "本次更新失败，显示上次数据" });
        ctx.invalidateQueries();
        return { ok: false, status: "error", message: "刷新任务未能启动" };
      }
      await writeState(ctx, { status: "running", taskId: task.taskId, message: "正在同步 Firance 与 Plaid" });
      return { ok: true, status: "started", message: "更新已开始" };
    },
  }),

  ingestFinanceData: defineAction({
    request: z.discriminatedUnion("success", [
      z.object({ success: z.literal(false), error: z.string().min(1).max(500) }),
      z.object({
        success: z.literal(true),
        asOf: z.string().min(10).max(80),
        months: z.array(rawMonthSchema).min(1).max(240),
        plaidAccounts: z.array(plaidAccountSchema).max(100),
        holdings: z.array(holdingInputSchema).max(1000),
        plaidTransactions: z.array(plaidTransactionSchema).max(20_000).default([]),
        transactionCoverage: transactionCoverageSchema.default(null),
      }),
    ]),
    response: ingestResponse,
    async handler(ctx, args): Promise<z.infer<typeof ingestResponse>> {
      if (!isOwner(ctx)) return { ok: false, savedMonths: 0 };
      if (!args.success) {
        await writeState(ctx, { status: "error", message: "本次更新失败，显示上次数据" });
        ctx.invalidateQueries();
        return { ok: false, savedMonths: 0 };
      }
      const state = await getState(ctx);
      let previousLiveNetWorth: number | null = null;
      if (state?.payload) {
        const prior = dashboardSchema.safeParse(JSON.parse(state.payload));
        if (prior.success) previousLiveNetWorth = prior.data.live.netWorth;
      }
      const dashboard = buildDashboard(
        args.asOf,
        args.months,
        args.plaidAccounts,
        args.holdings,
        args.plaidTransactions,
        args.transactionCoverage,
        previousLiveNetWorth,
      );
      if (!dashboard) {
        await writeState(ctx, { status: "error", message: "本次更新没有可用的月度数据，显示上次数据" });
        ctx.invalidateQueries();
        return { ok: false, savedMonths: 0 };
      }
      await writeState(ctx, {
        payload: JSON.stringify(dashboard),
        previousLiveNetWorth,
        status: "idle",
        message: "更新完成",
      });
      ctx.invalidateQueries();
      return { ok: true, savedMonths: dashboard.months.length };
    },
  }),
} satisfies ActionsModule;
