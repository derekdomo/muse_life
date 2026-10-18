import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, desc, eq } from "drizzle-orm";
import * as schema from "./schema";

const citySchema = z.enum(["Santa Clara", "Sunnyvale", "Cupertino"]);
const statusSchema = z.enum(["active", "contingent", "pending", "unknown"]);

const listingInputSchema = z.object({
  rank: z.number().int().min(1).max(30),
  score: z.number().int().min(0).max(100),
  address: z.string().min(3).max(180),
  city: citySchema,
  url: z.string().url(),
  price: z.number().int().min(1_000_000).max(5_000_000),
  bedrooms: z.number().int().min(3).max(12),
  bathrooms: z.number().min(1).max(12),
  sqft: z.number().int().min(500).max(10_000),
  lotSqft: z.number().int().positive().nullable(),
  yearBuilt: z.number().int().min(1850).max(2035).nullable(),
  daysOnMarket: z.number().int().min(0).max(3650).nullable(),
  pricePerSqft: z.number().int().positive().nullable(),
  priceChange: z.number().int().nullable(),
  hoaMonthly: z.number().int().min(0).nullable(),
  status: statusSchema,
  schoolSummary: z.string().min(2).max(500),
  environmentSummary: z.string().min(2).max(500),
  conditionSummary: z.string().min(2).max(500),
  verdict: z.string().min(2).max(500),
  caution: z.string().max(500).nullable(),
});

const listingOutputSchema = listingInputSchema.extend({ id: z.number() });

const reportResponseSchema = z.object({
  report: z.object({
    id: z.number(),
    asOf: z.string(),
    mortgageRate: z.number(),
    rateLabel: z.string(),
    rateSource: z.string(),
    rateUrl: z.string(),
    summary: z.string(),
    createdAt: z.string(),
    listings: z.array(listingOutputSchema),
  }).nullable(),
  refresh: z.object({
    status: z.enum(["idle", "running", "error"]),
    taskId: z.string().nullable(),
    message: z.string().nullable(),
    updatedAt: z.string().nullable(),
  }),
});

const initialListings: Array<z.infer<typeof listingInputSchema>> = [
  {
    rank: 1, score: 94, address: "880 Lansdown Ct", city: "Sunnyvale", url: "https://www.redfin.com/CA/Sunnyvale/880-Lansdown-Ct-94087/home/1717735",
    price: 2898000, bedrooms: 4, bathrooms: 3, sqft: 2170, lotSqft: 6200, yearBuilt: 1964, daysOnMarket: 5, pricePerSqft: 1335, priceChange: null, hoaMonthly: 0, status: "active",
    schoolSummary: "Cumberland 10 / Sunnyvale Middle 9 / Homestead 10",
    environmentSummary: "安静 cul-de-sac，Redfin 噪音 9.8/10；距 CA-85 约 1 英里。",
    conditionSummary: "Split-level，一楼另有套房；太阳能与电池备份。",
    verdict: "学区、安静度与 4 房空间最均衡，本周综合首选。",
    caution: "曾短暂 contingent 后重新上市，建议问清原因。",
  },
  {
    rank: 2, score: 92, address: "835 Poplar Ave", city: "Sunnyvale", url: "https://www.redfin.com/CA/Sunnyvale/835-Poplar-Ave-94086/home/1488469",
    price: 2388000, bedrooms: 4, bathrooms: 2.5, sqft: 1934, lotSqft: 6050, yearBuilt: 1977, daysOnMarket: 4, pricePerSqft: 1235, priceChange: null, hoaMonthly: 0, status: "active",
    schoolSummary: "Ponderosa 9 / Peterson 9 / Wilcox 8",
    environmentSummary: "Ponderosa Park 内街，Redfin 噪音 9.8/10。",
    conditionSummary: "厨房、卫浴、地板与油漆均有更新，可直接入住。",
    verdict: "四房、翻新状态和单价组合最有性价比。",
    caution: "新挂牌且关注度高，优质房源可能走得快。",
  },
  {
    rank: 3, score: 90, address: "716 Fairlane Ave", city: "Santa Clara", url: "https://www.redfin.com/CA/Santa-Clara/716-Fairlane-Ave-95051/home/691720",
    price: 2199000, bedrooms: 3, bathrooms: 2, sqft: 2023, lotSqft: 6000, yearBuilt: 1959, daysOnMarket: 31, pricePerSqft: 1087, priceChange: null, hoaMonthly: 0, status: "active",
    schoolSummary: "Sutter 7 / Buchser 8 / Santa Clara High 8",
    environmentSummary: "Southwest Santa Clara 安静内街，噪音 9.7/10。",
    conditionSummary: "1959 年 ranch，面积在 Santa Clara 同价位中较充足。",
    verdict: "价格、面积、学校和街道环境最均衡的 Santa Clara 选择。",
    caution: "Redfin 估值高于挂牌约 $120K，可能有竞争。",
  },
  {
    rank: 4, score: 88, address: "2611 Monticello Way", city: "Santa Clara", url: "https://www.redfin.com/CA/Santa-Clara/2611-Monticello-Way-95051/home/1542894",
    price: 2488000, bedrooms: 4, bathrooms: 3, sqft: 1784, lotSqft: 6300, yearBuilt: 1960, daysOnMarket: 9, pricePerSqft: 1395, priceChange: null, hoaMonthly: 0, status: "active",
    schoolSummary: "Briarwood 6 / Cabrillo 7 / Wilcox 8；Stratford Pomeroy 约 0.5 英里",
    environmentSummary: "安静住宅街，距 Lawrence Expressway 数个街区。",
    conditionSummary: "四房三卫，家庭功能完整。",
    verdict: "四房需求和私校备选兼顾得较好。",
    caution: "小学评分一般，面积不算宽裕。",
  },
  {
    rank: 5, score: 86, address: "693 Windsor Ter", city: "Sunnyvale", url: "https://www.redfin.com/CA/Sunnyvale/693-Windsor-Ter-94087/home/1212887",
    price: 2488000, bedrooms: 3, bathrooms: 2.5, sqft: 1906, lotSqft: 3632, yearBuilt: 1995, daysOnMarket: 37, pricePerSqft: 1305, priceChange: -200000, hoaMonthly: 125, status: "active",
    schoolSummary: "Cumberland 10 / Sunnyvale Middle 9 / Fremont 9",
    environmentSummary: "Fairbrae 社区，非主干道正面，噪音 7.2/10。",
    conditionSummary: "1995 年建，是本轮较新的选择。",
    verdict: "新旧程度、学区与刚降价 $200K 的时点很有吸引力。",
    caution: "地块仅约 3,632 平方英尺，另有 $125/月 HOA。",
  },
  {
    rank: 6, score: 85, address: "10112 Adelheid Ct", city: "Cupertino", url: "https://www.redfin.com/CA/Cupertino/10112-Adelheid-Ct-95014/home/1214253",
    price: 2599888, bedrooms: 4, bathrooms: 2.5, sqft: 1995, lotSqft: 3780, yearBuilt: 1977, daysOnMarket: 26, pricePerSqft: 1303, priceChange: null, hoaMonthly: 550, status: "active",
    schoolSummary: "Stevens Creek 9 / Kennedy 9 / Monta Vista 10",
    environmentSummary: "Monta Vista North 安静 cul-de-sac，噪音 9.9/10。",
    conditionSummary: "Cupertino 同预算里难得接近 2,000 平方英尺的四房。",
    verdict: "Cupertino 四房里单价和空间最突出。",
    caution: "$550/月 HOA 偏高，需核实涵盖项目。",
  },
  {
    rank: 7, score: 82, address: "7536 Dumas Dr", city: "Cupertino", url: "https://www.redfin.com/CA/Cupertino/7536-Dumas-Dr-95014/home/784657",
    price: 2488000, bedrooms: 3, bathrooms: 2, sqft: 1265, lotSqft: 6050, yearBuilt: 1959, daysOnMarket: 4, pricePerSqft: 1967, priceChange: null, hoaMonthly: 0, status: "active",
    schoolSummary: "Lincoln 9 / Lawson 10 / Monta Vista 10",
    environmentSummary: "Jollyman Park 旁安静街道，噪音 9.8/10。",
    conditionSummary: "单层、更新过厨房；房屋面积较小。",
    verdict: "以较低总价进入 Cupertino 顶级学区，土地与学校是主要价值。",
    caution: "仅 1,265 平方英尺，可能低于你的空间预期。",
  },
  {
    rank: 8, score: 81, address: "2477 Amethyst Dr", city: "Santa Clara", url: "https://www.redfin.com/CA/Santa-Clara/2477-Amethyst-Dr-95051/home/673151",
    price: 2399000, bedrooms: 4, bathrooms: 3, sqft: 1696, lotSqft: 5400, yearBuilt: 1954, daysOnMarket: 25, pricePerSqft: 1415, priceChange: null, hoaMonthly: 0, status: "active",
    schoolSummary: "Bracher 6 / Cabrillo 7 / Wilcox 8",
    environmentSummary: "宝石街区安静内街，噪音 8.8/10。",
    conditionSummary: "四房三卫，布局实用但面积偏紧凑。",
    verdict: "安静街道上的四房，挂牌一段时间后有谈价空间。",
    caution: "学区和单位面积价格不如前几名。",
  },
  {
    rank: 9, score: 80, address: "3015 Machado Ave", city: "Santa Clara", url: "https://www.redfin.com/CA/Santa-Clara/3015-Machado-Ave-95051/home/677339",
    price: 2499000, bedrooms: 4, bathrooms: 3, sqft: 2019, lotSqft: 5500, yearBuilt: 1956, daysOnMarket: 73, pricePerSqft: 1238, priceChange: -140000, hoaMonthly: 0, status: "active",
    schoolSummary: "Briarwood 6 / Cabrillo 7 / Wilcox 8",
    environmentSummary: "住宅街但靠近 Wilcox 校园与球场，噪音 4.8/10。",
    conditionSummary: "厨卫更新，四房且超过 2,000 平方英尺。",
    verdict: "降价、久挂与面积带来最明显的议价机会。",
    caution: "学校活动噪音需要实地感受。",
  },
  {
    rank: 10, score: 78, address: "10815 E Estates Dr", city: "Cupertino", url: "https://www.redfin.com/CA/Cupertino/10815-E-Estates-Dr-95014/home/1493807",
    price: 2868000, bedrooms: 4, bathrooms: 2, sqft: 1617, lotSqft: 6510, yearBuilt: 1955, daysOnMarket: 19, pricePerSqft: 1774, priceChange: null, hoaMonthly: 0, status: "active",
    schoolSummary: "Eaton 9 / Lawson 10 / Cupertino High 10",
    environmentSummary: "South Blaney，噪音 7.1/10。",
    conditionSummary: "厨房、卫浴、油漆和木地板有更新。",
    verdict: "顶级学区里的更新四房，地块尚可。",
    caution: "房屋面积偏小且总价接近预算上沿。",
  },
  {
    rank: 11, score: 76, address: "267 Eureka Ct", city: "Sunnyvale", url: "https://www.redfin.com/CA/Sunnyvale/267-Eureka-Ct-94085/home/723571",
    price: 2595000, bedrooms: 4, bathrooms: 3, sqft: 2168, lotSqft: 6100, yearBuilt: 1954, daysOnMarket: 85, pricePerSqft: 1197, priceChange: null, hoaMonthly: 0, status: "active",
    schoolSummary: "Bishop 7 / Columbia 6 / Fremont 9",
    environmentSummary: "安静 cul-de-sac，噪音 9.8/10。",
    conditionSummary: "2020 年翻新，单层四房。",
    verdict: "面积与安静度好，但更像需要大幅议价的备选。",
    caution: "久挂且估值低于挂牌约 $108K；同街成交价也更低。",
  },
  {
    rank: 12, score: 73, address: "1893 Cook Ct", city: "Santa Clara", url: "https://www.redfin.com/CA/Santa-Clara/1893-Cook-CT-95050/home/201942856",
    price: 2598000, bedrooms: 4, bathrooms: 3.5, sqft: 2721, lotSqft: 3363, yearBuilt: 2026, daysOnMarket: 16, pricePerSqft: 955, priceChange: null, hoaMonthly: 245, status: "active",
    schoolSummary: "Westwood 6 / Buchser 8 / Santa Clara High 8；附近有 Stratford",
    environmentSummary: "Pruneridge 附近私密小区，但 Redfin 噪音仅 3.7/10。",
    conditionSummary: "2026 新建，含独立 ADU，面积最大且单价最低。",
    verdict: "若把房屋新旧和面积放在第一位，它很突出。",
    caution: "环境噪音与 $245/月 HOA 明显违背核心偏好。",
  },
  {
    rank: 13, score: 69, address: "3444 Kenyon Dr", city: "Santa Clara", url: "https://www.redfin.com/CA/Santa-Clara/3444-Kenyon-Dr-95051/home/1226043",
    price: 2295000, bedrooms: 3, bathrooms: 2, sqft: 1592, lotSqft: 7900, yearBuilt: 1961, daysOnMarket: 1, pricePerSqft: 1442, priceChange: null, hoaMonthly: 0, status: "active",
    schoolSummary: "Sutter 7 / Buchser 8 / Santa Clara High 8",
    environmentSummary: "安静住宅街，噪音 9.7/10。",
    conditionSummary: "厨房更新，地块大；室内面积有限。",
    verdict: "新挂牌、环境好，但单位面积价格偏高。",
    caution: "仅 1,592 平方英尺，需要确认空间是否够用。",
  },
  {
    rank: 14, score: 61, address: "2044 Finley Pl", city: "Santa Clara", url: "https://www.redfin.com/CA/Santa-Clara/2044-Finley-Pl-95050/home/1306917",
    price: 2988000, bedrooms: 4, bathrooms: 3, sqft: 2360, lotSqft: 3100, yearBuilt: 2000, daysOnMarket: 58, pricePerSqft: 1266, priceChange: null, hoaMonthly: 154, status: "active",
    schoolSummary: "Scott Lane 3 / Buchser 8 / Santa Clara High 8",
    environmentSummary: "安静 cul-de-sac，噪音 7.5/10。",
    conditionSummary: "2000 年建并翻新，面积充足。",
    verdict: "较新、安静、面积够，但综合性价比受学校和价格拖累。",
    caution: "小学 3/10，且接近预算上限；另有 $154/月 HOA。",
  },
];

// Authorization (L0.2 + trusted platform channels). Write/trigger actions
// admit exactly two kinds of caller, checked before any database write,
// task spawn, or state change:
//  1. The owner, identified by the runtime-verified viewer
//     (ctx.viewer?.isOwner === true). Browser calls always carry a viewer,
//     so a non-owner or anonymous browser call never qualifies.
//  2. A platform-originated invocation with NO viewer, identified by the
//     daemon-minted ctx.invocationId channel prefix. The invocation id is
//     assigned by the runtime per ingress channel; it is not an action
//     argument and cannot be set or forged by a client or by the page:
//       - "space-action-…" — the daemon's direct action-invocation channel,
//         which is how the scheduler's space_action execution invokes
//         refreshReport for the weekly refresh.
//       - "space-task-return-…" — a background task returning through its
//         declared expectsAction contract. The daemon only mints this id
//         after validating the call against the live task's expected return
//         (missing/stale/mismatched returns are rejected before the action
//         runs); this is how the research task calls ingestResearch.
// Direct tool/agent calls arrive on the "artifact-action-tool-…" channel
// and ordinary invocations carry other ids; neither is admitted here, so a
// viewer-less direct call stays forbidden with zero writes.
function isOwner(ctx: Ctx): boolean {
  return ctx.viewer?.isOwner === true;
}

function isScheduledPlatformCall(ctx: Ctx): boolean {
  return !ctx.viewer && ctx.invocationId.startsWith("space-action-");
}

function isTaskReturnCallback(ctx: Ctx): boolean {
  return !ctx.viewer && ctx.invocationId.startsWith("space-task-return-");
}

// HH0.2 stale recovery, mirroring the weekly-finance pattern: a refresh
// stuck in "running" for over 2 hours is treated as a dead refresh —
// getReport presents it as a retryable error and refreshReport may start
// over it instead of staying blocked forever. The stored row itself is
// never rewritten by this mapping (updatedAt keeps its original value).
export const staleRefreshThresholdMs = 2 * 60 * 60 * 1000;

export function isStaleRunningState(
  status: "idle" | "running" | "error" | null | undefined,
  updatedAt: Date | null | undefined,
  now: Date,
): boolean {
  if (status !== "running" || !updatedAt) return false;
  return now.getTime() - updatedAt.getTime() > staleRefreshThresholdMs;
}

// Ingest decision for a research callback, with generation binding
// (HH0.2). A callback may only settle the refresh generation it belongs
// to:
//  - A success whose asOf is the same as or older than the latest stored
//    report never inserts, in ANY refresh state — inserting it would make
//    the visible report regress or duplicate the current one.
//  - While a refresh is running, a success whose asOf predates the moment
//    this refresh started (refreshUpdatedAt) provably belongs to the
//    previous generation's task: it is ignored and the running state is
//    left untouched.
//  - A failure may only settle a still-running refresh; a late failure
//    arriving after the state settled (idle/error/no row) is ignored.
// Semantics of "apply": for a running refresh, "apply" only means the
// callback is ELIGIBLE to enter the handler's atomic generation
// arbitration (the conditional refresh_state claim in ingestResearch).
// The arbitration result — not this function — decides whether the
// callback actually inserts a report or settles the state, so two
// concurrent callbacks of the same generation cannot both apply.
export function decideIngestCallback(input: {
  refreshStatus: "idle" | "running" | "error" | null | undefined;
  refreshUpdatedAt: Date | string | null | undefined;
  latestReportAsOf: string | null | undefined;
  incomingSuccess: boolean;
  incomingAsOf: string | null | undefined;
}): "apply" | "ignore" {
  const incomingMs = input.incomingAsOf != null ? Date.parse(input.incomingAsOf) : NaN;
  const latestMs = input.latestReportAsOf != null ? Date.parse(input.latestReportAsOf) : NaN;
  if (input.incomingSuccess) {
    // No regression or duplicate insert, whatever the refresh state.
    if (!Number.isNaN(incomingMs) && !Number.isNaN(latestMs) && incomingMs <= latestMs) {
      return "ignore";
    }
    if (input.refreshStatus === "running") {
      // A result stamped before this refresh started is the previous
      // generation's task returning late — ignore it, state untouched.
      const startedMs =
        input.refreshUpdatedAt instanceof Date
          ? input.refreshUpdatedAt.getTime()
          : input.refreshUpdatedAt != null
            ? Date.parse(input.refreshUpdatedAt)
            : NaN;
      if (!Number.isNaN(incomingMs) && !Number.isNaN(startedMs) && incomingMs < startedMs) {
        return "ignore";
      }
    }
    return "apply";
  }
  // Failure: eligible to settle only while a refresh is still running
  // (subject to winning the arbitration, per the note above); a failure
  // arriving after the state settled is a late return and is ignored.
  if (input.refreshStatus === "running") return "apply";
  return "ignore";
}

type RefreshStateRow = typeof schema.refreshState.$inferSelect;

// The refresh block getReport returns: a stale "running" row is mapped to
// a retryable error; taskId stays owner-only as before.
function presentRefreshState(state: RefreshStateRow | undefined, owner: boolean) {
  const stale = isStaleRunningState(state?.status, state?.updatedAt, new Date());
  return {
    status: stale ? ("error" as const) : (state?.status ?? "idle"),
    taskId: owner ? (state?.taskId ?? null) : null,
    message: stale ? "上次刷新未完成，可以重新刷新" : (state?.message ?? null),
    updatedAt: state?.updatedAt?.toISOString() ?? null,
  };
}

async function setRefreshState(ctx: Ctx, status: "idle" | "running" | "error", taskId: string | null, message: string | null) {
  const db = ctx.db<typeof schema>();
  const existing = await db.select().from(schema.refreshState).where(eq(schema.refreshState.id, 1)).limit(1);
  if (existing[0]) {
    await db.update(schema.refreshState).set({ status, taskId, message, updatedAt: new Date() }).where(eq(schema.refreshState.id, 1));
  } else {
    await db.insert(schema.refreshState).values({ id: 1, status, taskId, message, updatedAt: new Date() });
  }
}

export const Actions = {
  getReport: defineAction({
    request: z.object({}),
    response: reportResponseSchema,
    async handler(ctx): Promise<z.infer<typeof reportResponseSchema>> {
      // Read policy (confirmed for L0.2): the report itself stays publicly
      // readable as currently designed — it contains only public listing
      // data and published rate sources, no owner-private fields. The one
      // internal identifier, the refresh taskId, is owner-private plumbing
      // and is withheld from non-owner and anonymous readers.
      const owner = isOwner(ctx);
      const db = ctx.db<typeof schema>();
      const reportRows = await db.select().from(schema.reports).orderBy(desc(schema.reports.id)).limit(1);
      const report = reportRows[0];
      const stateRows = await db.select().from(schema.refreshState).where(eq(schema.refreshState.id, 1)).limit(1);
      const state = stateRows[0];
      if (!report) {
        return {
          report: null,
          refresh: presentRefreshState(state, owner),
        };
      }
      const rows = await db.select().from(schema.listings).where(eq(schema.listings.reportId, report.id)).orderBy(schema.listings.rank);
      return {
        report: {
          id: report.id,
          asOf: report.asOf,
          mortgageRate: report.mortgageRate,
          rateLabel: report.rateLabel,
          rateSource: report.rateSource,
          rateUrl: report.rateUrl,
          summary: report.summary,
          createdAt: report.createdAt.toISOString(),
          listings: rows.map((row) => ({
            id: row.id,
            rank: row.rank,
            score: row.score,
            address: row.address,
            city: row.city,
            url: row.url,
            price: row.price,
            bedrooms: row.bedrooms,
            bathrooms: row.bathrooms,
            sqft: row.sqft,
            lotSqft: row.lotSqft,
            yearBuilt: row.yearBuilt,
            daysOnMarket: row.daysOnMarket,
            pricePerSqft: row.pricePerSqft,
            priceChange: row.priceChange,
            hoaMonthly: row.hoaMonthly,
            status: row.status,
            schoolSummary: row.schoolSummary,
            environmentSummary: row.environmentSummary,
            conditionSummary: row.conditionSummary,
            verdict: row.verdict,
            caution: row.caution,
          })),
        },
        refresh: presentRefreshState(state, owner),
      };
    },
  }),

  initializeReport: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.boolean(), created: z.boolean() }),
    async handler(ctx) {
      if (!isOwner(ctx)) return { ok: false, created: false };
      const db = ctx.db<typeof schema>();
      const existing = await db.select({ id: schema.reports.id }).from(schema.reports).limit(1);
      if (existing[0]) return { ok: true, created: false };
      const inserted = await db.insert(schema.reports).values({
        asOf: "2026-09-19T12:00:00-07:00",
        mortgageRate: 7.13,
        rateLabel: "30 年固定 jumbo 参考利率",
        rateSource: "Bankrate via WSJ Buy Side",
        rateUrl: "https://www.wsj.com/buyside/personal-finance/mortgage/mortgage-rates-today-9-16-2026",
        summary: "本周优先看 Sunnyvale 的空间与学区平衡，再比较 Santa Clara 的单位面积性价比；Cupertino 学区强，但同预算下房屋普遍更小。",
      }).returning({ id: schema.reports.id });
      const report = inserted[0];
      if (!report) return { ok: false, created: false };
      await db.insert(schema.listings).values(initialListings.map((item) => ({ ...item, reportId: report.id })));
      await setRefreshState(ctx, "idle", null, "已载入 9 月 19 日快照");
      ctx.invalidateQueries();
      return { ok: true, created: true };
    },
  }),

  refreshReport: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.boolean(), status: z.enum(["started", "already_running", "error", "forbidden"]), message: z.string() }),
    async handler(ctx) {
      // Admit the owner, or the scheduler's platform invocation
      // (space_action execution arrives viewer-less on the daemon's
      // direct action channel). Any other caller is rejected before any
      // state write or task spawn.
      if (!isOwner(ctx) && !isScheduledPlatformCall(ctx)) {
        return { ok: false, status: "forbidden" as const, message: "仅报告所有者可以刷新" };
      }
      const db = ctx.db<typeof schema>();
      const stateRows = await db.select().from(schema.refreshState).where(eq(schema.refreshState.id, 1)).limit(1);
      // A stale "running" row is a dead refresh: fall through and start
      // over it (the setRefreshState below overwrites the old row).
      const currentState = stateRows[0];
      if (currentState?.status === "running" && !isStaleRunningState(currentState.status, currentState.updatedAt, new Date())) {
        return { ok: true, status: "already_running" as const, message: "刷新已经在进行中" };
      }
      await setRefreshState(ctx, "running", null, "正在核对房源、街道环境、学校与利率");
      ctx.invalidateQueries();
      const task = await ctx.agent.spawnTask(
        `为一个南湾每周看房报告做一次完整刷新。研究当前在售的 Santa Clara、Sunnyvale、Cupertino 独栋住宅，预算 $2,000,000–$3,000,000，至少 3 卧。核心排序维度：性价比、安静住宅环境（排除紧邻高速或主要干道）、房龄/翻新状态、室内面积、学校质量或靠谱私校距离。必须打开并核对每个保留房源的真实页面和地图/道路背景，优先 Redfin，保持每个公开 URL 原样。给出 8–15 套有理由的短名单并排序，不能编造缺失字段；已 pending/contingent 可保留但必须标注。另查找有日期的当前 30 年 jumbo 固定按揭利率（若无 jumbo，才使用 30 年固定全国平均，并写清标签和来源 URL）。为每套写简洁中文 schoolSummary、environmentSummary、conditionSummary、verdict、caution。asOf 使用带时区 ISO 时间。若研究无法完成，回传失败状态与中文错误说明。`,
        { expectsAction: "ingestResearch", dedupeKey: "weekly-south-bay-home-report" },
      );
      if (!task.ok) {
        await setRefreshState(ctx, "error", null, "刷新任务未能启动，请稍后重试");
        ctx.invalidateQueries();
        return { ok: false, status: "error" as const, message: "刷新任务未能启动" };
      }
      await setRefreshState(ctx, "running", task.taskId, "正在核对房源、街道环境、学校与利率");
      return { ok: true, status: "started" as const, message: "已开始刷新，完成后会自动更新" };
    },
  }),

  ingestResearch: defineAction({
    request: z.discriminatedUnion("success", [
      z.object({ success: z.literal(false), error: z.string().min(1).max(500) }),
      z.object({
        success: z.literal(true),
        asOf: z.string().min(10),
        mortgageRate: z.number().min(0.1).max(20),
        rateLabel: z.string().min(2).max(120),
        rateSource: z.string().min(2).max(120),
        rateUrl: z.string().url(),
        summary: z.string().min(10).max(1000),
        listings: z.array(listingInputSchema).min(3).max(20),
      }),
    ]),
    response: z.object({ ok: z.boolean(), saved: z.number() }),
    async handler(ctx, args) {
      // Ingest is a write path: reject before any state write or insert.
      // Admit the owner, or the research task's platform return callback:
      // a task spawned with expectsAction "ingestResearch" returns on the
      // daemon-validated "space-task-return-…" channel with no viewer.
      // Any other viewer-less or non-owner call is denied.
      if (!isOwner(ctx) && !isTaskReturnCallback(ctx)) return { ok: false, saved: 0 };
      // Generation binding + idempotency (HH0.2): decideIngestCallback
      // first filters out provably stale callbacks — a success no newer
      // than the stored report, a success stamped before this refresh
      // started, and any late failure after the state settled. A callback
      // that passes must then win an atomic generation arbitration before
      // it may insert a report or settle the state: a conditional UPDATE
      // on refresh_state that bumps only updatedAt and matches only while
      // status and updatedAt are exactly what this call just read.
      // Exactly one concurrent callback can claim a given generation; the
      // loser (0 rows claimed) re-reads state and the latest report and
      // re-decides once — if still applicable it proceeds directly, with
      // no second claim, so arbitration cannot livelock.
      const db = ctx.db<typeof schema>();
      const readIngestInputs = async () => {
        const stateRows = await db.select().from(schema.refreshState).where(eq(schema.refreshState.id, 1)).limit(1);
        const latestRows = await db.select({ asOf: schema.reports.asOf }).from(schema.reports).orderBy(desc(schema.reports.id)).limit(1);
        return { state: stateRows[0], latestAsOf: latestRows[0]?.asOf ?? null };
      };
      const decideFor = (state: RefreshStateRow | undefined, latestAsOf: string | null) =>
        decideIngestCallback({
          refreshStatus: state?.status,
          refreshUpdatedAt: state?.updatedAt ?? null,
          latestReportAsOf: latestAsOf,
          incomingSuccess: args.success,
          incomingAsOf: args.success ? args.asOf : null,
        });
      const ignoredResult = () => (args.success ? { ok: true, saved: 0 } : { ok: false, saved: 0 });

      const firstRead = await readIngestInputs();
      if (decideFor(firstRead.state, firstRead.latestAsOf) === "ignore") {
        return ignoredResult();
      }
      let claimed = false;
      if (firstRead.state) {
        const claimRows = await db
          .update(schema.refreshState)
          .set({ updatedAt: new Date() })
          .where(
            and(
              eq(schema.refreshState.id, 1),
              eq(schema.refreshState.status, firstRead.state.status),
              eq(schema.refreshState.updatedAt, firstRead.state.updatedAt),
            ),
          )
          .returning({ id: schema.refreshState.id });
        claimed = claimRows.length === 1;
      }
      if (!claimed) {
        // Lost the claim (or there was no state row to claim): the state
        // changed under us — re-read and re-decide exactly once.
        const secondRead = await readIngestInputs();
        if (decideFor(secondRead.state, secondRead.latestAsOf) === "ignore") {
          return ignoredResult();
        }
        // Still applicable after the re-read: proceed without claiming
        // again (single retry only).
      }
      if (!args.success) {
        await setRefreshState(ctx, "error", null, args.error);
        ctx.invalidateQueries();
        return { ok: false, saved: 0 };
      }
      const clean = args.listings
        .filter((item) => item.url.startsWith("https://www.redfin.com/"))
        .filter((item) => item.price >= 2_000_000 && item.price <= 3_000_000 && item.bedrooms >= 3)
        .sort((a, b) => a.rank - b.rank)
        .slice(0, 20);
      if (clean.length < 3) {
        await setRefreshState(ctx, "error", null, "刷新结果不足 3 套已核实房源，保留上一期报告");
        ctx.invalidateQueries();
        return { ok: false, saved: 0 };
      }
      // HH0.3 pre-save integrity: a duplicated URL, or a duplicated
      // address after case/whitespace normalization, in the filtered
      // result means this round's data is untrustworthy — insert nothing
      // and keep the previous report.
      const seenUrls = new Set<string>();
      const seenAddresses = new Set<string>();
      let hasDuplicate = false;
      for (const item of clean) {
        const addressKey = item.address.trim().toLowerCase();
        if (seenUrls.has(item.url) || seenAddresses.has(addressKey)) {
          hasDuplicate = true;
          break;
        }
        seenUrls.add(item.url);
        seenAddresses.add(addressKey);
      }
      if (hasDuplicate) {
        await setRefreshState(ctx, "error", null, "刷新结果存在重复房源，保留上一期报告");
        ctx.invalidateQueries();
        return { ok: false, saved: 0 };
      }
      const inserted = await db.insert(schema.reports).values({
        asOf: args.asOf,
        mortgageRate: args.mortgageRate,
        rateLabel: args.rateLabel,
        rateSource: args.rateSource,
        rateUrl: args.rateUrl,
        summary: args.summary,
      }).returning({ id: schema.reports.id });
      const report = inserted[0];
      if (!report) {
        await setRefreshState(ctx, "error", null, "报告保存失败，保留上一期报告");
        return { ok: false, saved: 0 };
      }
      await db.insert(schema.listings).values(clean.map((item, index) => ({ ...item, rank: index + 1, reportId: report.id })));
      await setRefreshState(ctx, "idle", null, `已更新 ${clean.length} 套房源`);
      ctx.invalidateQueries();
      return { ok: true, saved: clean.length };
    },
  }),
} satisfies ActionsModule;

export type Actions = typeof Actions;
