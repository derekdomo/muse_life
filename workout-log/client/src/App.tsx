import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import { EXERCISE_DEMOS, ExerciseDemoView, type ExerciseDemo } from "./ExerciseDemo";
import { MuscleDiagramView } from "./MuscleDiagram";

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type Workout = NonNullable<Dashboard["active_workout"]>;
type WorkoutSet = Workout["sets"][number];
type Routine = Workout["routine"];
type Unit = Workout["unit"];
type WeekSummary = Dashboard["week_summaries"][number];

const ROUTINE_META: Record<Routine, { label: string; title: string; day: string; count: string; warmup: string }> = {
  push: {
    label: "推",
    title: "推日",
    day: "周二",
    count: "6 个动作 · 18 组",
    warmup: "单车 5 分钟 · 弹力带绕肩 15 次 · 手臂绕环前后各 15 次 · 空杆卧推 2×12",
  },
  pull: {
    label: "拉",
    title: "拉日",
    day: "周四",
    count: "7 个动作 · 23 组",
    warmup: "划船机 5 分钟 · 死悬垂 30 秒×2 · 弹力带直臂下拉 15 次 · 轻重量高位下拉 2×12",
  },
  legs: {
    label: "腿",
    title: "腿日",
    day: "周日",
    count: "6 个动作 · 18 组",
    warmup: "单车 5 分钟 · 自重深蹲 15 次 · 前后腿摆动各 15 次 · 臀桥 15 次 · 空杆深蹲 2×10",
  },
  home_posture: {
    label: "在家 A",
    title: "在家 A · 体态",
    day: "周一 · 周五",
    count: "4 个动作 · 9 组",
    warmup: "颈部左右轻转各 5 次 · 肩部绕环前后各 10 次 · 猫牛式 8 次",
  },
  home_snowboard: {
    label: "在家 B",
    title: "在家 B · 单板",
    day: "周三",
    count: "8 个动作 · 20 组",
    warmup: "原地慢跑 2 分钟 · 踝关节绕环各 10 次 · 自重深蹲 12 次 · 单腿站立各 20 秒",
  },
};

// The weekly review's "完整一轮" still means the three gym sessions;
// the home routines are tracked in history but never gate the review.
const GYM_ROUTINES: Routine[] = ["push", "pull", "legs"];
const ALL_ROUTINES: Routine[] = ["push", "pull", "legs", "home_posture", "home_snowboard"];
const SCHEDULE_DAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const SCHEDULE_CODE_LABELS: Record<string, string> = {
  push: "健身房 · 推",
  pull: "健身房 · 拉",
  legs: "健身房 · 腿",
  home_posture: "在家 A · 体态",
  home_snowboard: "在家 B · 单板",
  swim: "游泳 / 休息",
  rest: "休息",
};

type Plan = ApiResponse<typeof api, "getPlan">;
type PlanRoutineEntry = Plan["routines"][number];
type PlanExerciseDraft = { key: string; name: string; sets: number; target: string };

type ExerciseGuide = {
  title: string;
  focus: string;
  setup: string;
  cues: string[];
  mistakes: string[];
  // Optional: only guides with a verified public demonstration carry
  // a video link; newer exercises ship cues without one rather than
  // linking an unchecked video.
  video?: string;
  source?: string;
  // Looping in-dialog demonstration: a start/end pair — either a
  // verified open-license real photo pair or stills from a cleanly
  // licensed real demonstration video, each checked frame by frame
  // against the guide's cues (see DATA-PLAN.md). A guide whose
  // movement has no verified pair ships text cues only rather than
  // a wrong demo.
  demo?: ExerciseDemo;
};

const EXERCISE_GUIDES: Record<string, ExerciseGuide> = {
  "barbell-bench": {
    title: "杠铃卧推",
    focus: "胸大肌 · 肱三头肌 · 三角肌前束",
    setup: "眼睛在杠铃正下方，脚掌踩稳；肩胛骨向后、向下固定，手腕叠在前臂上。",
    cues: ["下放到中下胸，前臂保持接近垂直", "脚持续压地，臀部和上背贴住凳面", "动作全程让肩膀远离耳朵"],
    mistakes: ["肘部横向张到 90°", "杠铃在胸口反弹", "手腕向后折、肩胛失去固定"],
    video: "https://www.youtube.com/watch?v=CjHIKDQ4RQo",
    source: "PureGym 教练示范",
    demo: EXERCISE_DEMOS["barbell-bench"],
  },
  "overhead-press": {
    title: "站姿推举",
    focus: "三角肌 · 肱三头肌 · 上背稳定肌群",
    setup: "双脚与肩同宽，核心和臀部收紧；杠铃置于上胸，手腕在肘部正上方。",
    cues: ["杠铃贴近脸部直线上推", "杠铃过头后让头部回到双臂之间", "肋骨收住，不用后仰借力"],
    mistakes: ["腰椎过度反弓", "杠铃绕出很大的弧线", "用腿蹬起变成借力推举"],
    video: "https://www.youtube.com/watch?v=EK511FpyDEg",
    source: "站姿杠铃推举示范",
    demo: EXERCISE_DEMOS["overhead-press"],
  },
  "incline-dumbbell-press": {
    title: "上斜哑铃卧推",
    focus: "上胸 · 三角肌前束 · 肱三头肌",
    setup: "凳背调至约 30–45°，脚踩稳；哑铃由大腿送到肩侧，肩胛向后下方固定。",
    cues: ["肘部略收，哑铃向上且微微内收", "下放到肩膀略下方并保持控制", "头、上背和臀部留在凳面"],
    mistakes: ["凳背太陡变成肩推", "底部肩膀向前卷", "两只哑铃在顶部撞击"],
    video: "https://www.youtube.com/watch?v=oZVCBM9f8Eo",
    source: "PureGym 教练示范",
    demo: EXERCISE_DEMOS["incline-dumbbell-press"],
  },
  dips: {
    title: "双杠臂屈伸",
    focus: "胸大肌 · 肱三头肌 · 三角肌前束",
    setup: "双手握住平行杠，肩膀主动下沉；躯干略前倾，核心收紧。",
    cues: ["控制下放到肩膀舒适的深度", "肘部向后走，不让肩膀耸起", "向下压杠并稳定推回顶部"],
    mistakes: ["追求过深导致肩前侧不适", "下放时肩膀耸向耳朵", "摆腿或反弹借力"],
    video: "https://www.youtube.com/watch?v=2HYAeF6o7Bc",
    source: "PureGym 教练示范",
    demo: EXERCISE_DEMOS.dips,
  },
  "lateral-raise": {
    title: "哑铃侧平举",
    focus: "三角肌中束",
    setup: "站稳并轻微屈肘，哑铃位于身体两侧略靠前；核心保持稳定。",
    cues: ["由肘部带动向侧上方抬起", "抬到肩高附近即可", "慢速下放，肩膀始终远离耳朵"],
    mistakes: ["重量过大导致摆动", "耸肩让斜方肌代偿", "手臂抬得明显高于肩膀"],
    video: "https://www.youtube.com/watch?v=z-kOn7flIZg",
    source: "PureGym 教练示范",
    demo: EXERCISE_DEMOS["lateral-raise"],
  },
  "wide-lat-pulldown": {
    title: "高位下拉 · 宽握",
    focus: "背阔肌 · 大圆肌 · 肱二头肌",
    setup: "大腿垫压稳，握距略宽于肩；胸口抬起，躯干只需轻微后倾。",
    cues: ["先让肩膀下沉，再把肘部拉向身体两侧", "横杆落向上胸，不拉到颈后", "回程完全伸展但不丢掉控制"],
    mistakes: ["大幅后仰把动作变成划船", "用手臂猛拽或借惯性", "握得过宽导致动作幅度太短"],
    video: "https://www.youtube.com/shorts/UAlGHwshYBM",
    source: "高位下拉真人示范",
    demo: EXERCISE_DEMOS["wide-lat-pulldown"],
  },
  "close-lat-pulldown": {
    title: "高位下拉 · 窄握/反握",
    focus: "背阔肌下部 · 肱二头肌",
    setup: "反握时双手约肩宽，肘部位于手腕下方；胸口抬起、肩膀下沉。",
    cues: ["肘部贴近躯干向下拉", "横杆落向上胸", "顶部让背阔肌充分伸展"],
    mistakes: ["手腕折叠或握距过窄", "身体后仰过多", "只用肱二头肌屈肘"],
    video: "https://www.youtube.com/watch?v=UkgDc61gRcM",
    source: "反握高位下拉示范",
    demo: EXERCISE_DEMOS["close-lat-pulldown"],
  },
  "close-seated-row": {
    title: "坐姿划船 · 窄距",
    focus: "背阔肌 · 菱形肌 · 肱二头肌",
    setup: "脚踩稳，脊柱保持中立；窄握把手置于身前，肩膀下沉。",
    cues: ["肘部贴近身体拉向髋部", "把手落在肚脐附近", "回程让肩胛自然前伸但不弓腰"],
    mistakes: ["身体前后大幅摇摆", "用下背甩起重量", "耸肩并只用手臂拉"],
    video: "https://www.youtube.com/watch?v=O9nVMz5osqY",
    source: "坐姿绳索划船示范",
    demo: EXERCISE_DEMOS["close-seated-row"],
  },
  "wide-seated-row": {
    title: "坐姿划船 · 宽距",
    focus: "上背 · 菱形肌 · 三角肌后束",
    setup: "宽握把手，胸口抬起、脊柱中立；手臂向前伸直但不塌腰。",
    cues: ["肘部向外拉，目标落点在下胸", "顶端夹紧肩胛骨", "用两秒左右控制回程"],
    mistakes: ["把宽距划船拉到肚脐", "肩膀耸起", "为了加重量缩短动作幅度"],
    video: "https://www.youtube.com/shorts/mJLT0tChvFM",
    source: "窄距与宽距划船对比示范",
    demo: EXERCISE_DEMOS["wide-seated-row"],
  },
  "face-pull": {
    title: "面拉",
    focus: "三角肌后束 · 旋转袖 · 中下斜方肌",
    setup: "绳索调到眼睛附近，双手对握；站稳或坐稳，肋骨保持收紧。",
    cues: ["绳索拉向额头，手腕分开", "动作末端做外旋，让手位于耳朵两侧", "轻重量、短暂停顿、慢速回程"],
    mistakes: ["拉向胸口变成普通划船", "重量过大导致身体后仰", "肩膀耸起、肘部掉得太低"],
    video: "https://www.youtube.com/watch?v=4UhV4cCkugM",
    source: "坐姿绳索面拉示范",
    demo: EXERCISE_DEMOS["face-pull"],
  },
  "rope-curl": {
    title: "绳索弯举",
    focus: "肱二头肌 · 肱肌 · 肱桡肌",
    setup: "低位滑轮接绳索，身体站直；肘部固定在身体两侧，手掌相对。",
    cues: ["只让前臂移动", "顶部主动收紧，不让肩膀前移", "全程控制回程并保持张力"],
    mistakes: ["躯干前后摆动", "肘部向前漂移", "回程直接让配重砸下"],
    video: "https://www.youtube.com/watch?v=dLRVpRC4L3Y",
    source: "绳索锤式弯举示范",
    demo: EXERCISE_DEMOS["rope-curl"],
  },
  "back-squat": {
    title: "深蹲",
    focus: "股四头肌 · 臀大肌 · 核心稳定肌群",
    setup: "杠铃稳定落在上背，脚掌三点压地；吸气后做 360° 核心支撑。",
    cues: ["膝盖沿脚尖方向打开", "髋和膝一起下沉", "保持足弓和背部稳定后从中足发力站起"],
    mistakes: ["膝盖向内塌", "脚跟或大脚趾离地", "为了追求深度而失去腰背中立"],
    video: "https://www.youtube.com/watch?v=nEQQle9-0NA",
    source: "深蹲动作解析",
    demo: EXERCISE_DEMOS["back-squat"],
  },
  "romanian-deadlift": {
    title: "罗马尼亚硬拉",
    focus: "腘绳肌 · 臀大肌 · 竖脊肌",
    setup: "双脚与髋同宽，膝盖微屈；杠铃贴近大腿，核心先收紧。",
    cues: ["髋部向后推，而不是向下蹲", "杠铃始终贴近腿部", "感到腘绳肌充分拉伸后用臀部向前驱动"],
    mistakes: ["膝盖越弯越多变成深蹲", "为了下得更低而弓背", "顶部过度后仰挤压腰椎"],
    video: "https://www.youtube.com/watch?v=aa57T45iFSE",
    source: "NASM 哑铃 RDL 示范",
    demo: EXERCISE_DEMOS["romanian-deadlift"],
  },
  "bulgarian-split-squat": {
    title: "保加利亚分腿蹲",
    focus: "股四头肌 · 臀大肌 · 单腿稳定",
    setup: "后脚脚背放在矮凳上，前脚向前找到稳定距离；先用自重试出站距。",
    cues: ["绝大部分重量留在前脚", "前膝沿脚尖方向移动", "后膝向地面下降，再由前脚推起"],
    mistakes: ["前脚离凳太近导致脚跟抬起", "前膝向内塌", "后腿用力过多或左右摇晃"],
    video: "https://www.youtube.com/watch?v=DeCnHqrN22U",
    source: "Buff Dudes 真人示范",
    demo: EXERCISE_DEMOS["bulgarian-split-squat"],
  },
  "lying-leg-curl": {
    title: "俯卧腿弯举",
    focus: "腘绳肌",
    setup: "膝关节对齐机器转轴，滚垫落在脚踝上方；髋部和腹部贴紧垫面。",
    cues: ["脚跟向臀部卷起", "顶部短暂停顿收紧腘绳肌", "用两秒左右控制下放"],
    mistakes: ["髋部离开垫面", "借助下背拱起重量", "回程过快、配重片撞击"],
    video: "https://www.youtube.com/shorts/tLyA9uXn5Wo",
    source: "俯卧腿弯举示范",
    demo: EXERCISE_DEMOS["lying-leg-curl"],
  },
  "push-up-plus": {
    title: "前锯肌 Push-up Plus",
    focus: "前锯肌 · 肩胛稳定",
    setup: "高位平板支撑，手掌在肩膀正下方；手臂全程伸直，靠肩胛骨移动身体。",
    cues: ["先让肩胛自然靠拢，背部微微下沉", "再主动把地面推远，上背顶起呈圆弧", "动作只发生在肩胛，不弯手肘"],
    mistakes: ["变成普通俯卧撑弯手肘", "塌腰或撅臀", "耸肩贴近耳朵"],
    // No demo image: no cleanly licensed real video of the
    // straight-arm scapular push-up plus was found (regular push-up
    // videos bend the elbows — the exact mistake listed above).
    // Teaching video instead (verified 2026-10-19, see DATA-PLAN.md):
    // Marcus Filly's scapular push-up — high plank, arms straight,
    // scapular movement only.
    video: "https://www.youtube.com/watch?v=huGj4aBk9C4",
    source: "外部教学视频 · Marcus Filly 教练 · 肩胛俯卧撑",
  },
  "reverse-pec-deck": {
    title: "反向蝴蝶机 · 后三角",
    focus: "三角肌后束 · 菱形肌 · 中斜方肌",
    setup: "面朝靠垫坐稳，胸口贴紧垫面；把手与肩同高，手臂近乎伸直。",
    cues: ["由肘部带动向身体两侧打开", "末端夹紧肩胛并停 1 秒", "慢速回程，不让配重片落尽"],
    mistakes: ["耸肩让上斜方代偿", "身体后仰借力", "手臂弯曲变成划船"],
    // No demo image: the only licensed-stills pec-deck video found
    // was the FORWARD fly (the opposite direction). Teaching video
    // instead (verified 2026-10-19, see DATA-PLAN.md): Renaissance
    // Periodization's machine reverse flye — seated facing the pad,
    // arms opening backward, rear delts.
    video: "https://www.youtube.com/watch?v=5YK4bgzXDp0",
    source: "外部教学视频 · Renaissance Periodization · 器械反向飞鸟",
  },
  "calf-raise": {
    title: "提踵",
    focus: "腓肠肌 · 比目鱼肌",
    setup: "前脚掌踩稳台阶边缘，脚跟可低于台阶面；扶稳保持平衡。",
    cues: ["脚跟下沉到充分拉伸", "由前脚掌主动蹬起至最高点并停 1 秒", "全程慢速，膝盖保持姿势不变"],
    mistakes: ["借弹跳快速起落", "动作幅度只有一半", "脚踝内外翻"],
    demo: EXERCISE_DEMOS["calf-raise"],
  },
  "tibialis-raise": {
    title: "靠墙胫骨前肌抬脚尖",
    focus: "胫骨前肌",
    setup: "背靠墙站立，双脚向前离墙约一步，脚跟踩地。",
    cues: ["脚尖尽量抬向小腿方向", "顶部停 1 秒再慢放", "脚跟不离地、身体不前倾"],
    mistakes: ["抬得太快靠惯性", "膝盖大幅弯曲代偿", "脚尖外八"],
    // No demo image: no cleanly licensed stills source for the
    // against-the-wall tibialis raise. Teaching video instead
    // (verified 2026-10-19, see DATA-PLAN.md): wall tibialis raises,
    // back against the wall, heels down, toes lifted to the shins.
    video: "https://www.youtube.com/watch?v=VzIcGAgBiaM",
    source: "外部教学视频 · The Barefoot Sprinter · 靠墙胫骨前肌抬脚尖",
  },
  "supine-chin-tuck": {
    title: "仰卧收下巴",
    focus: "深层颈屈肌",
    setup: "仰卧平躺，头下不垫高枕；后脑轻贴地面，眼睛看向天花板。",
    cues: ["像做双下巴一样把下巴水平后收", "每次停 5 秒再完全放松", "后脑不离地、不用力压脖子"],
    mistakes: ["低头把下巴压向胸口", "憋气耸肩", "速度太快不停顿"],
    // No demo image: no cleanly licensed stills source for the
    // supine chin tuck. Teaching video instead (verified 2026-10-19,
    // see DATA-PLAN.md): FitLife physical therapy's supine chin
    // tuck — lying flat, head on the mat, no pillow.
    video: "https://www.youtube.com/watch?v=qFEBNu4vwSg",
    source: "外部教学视频 · FitLife 物理治疗 · 仰卧收下巴",
  },
  "prone-ytw": {
    title: "俯趴 Bench Y-T-W",
    focus: "下斜方肌 · 菱形肌 · 三角肌后束",
    setup: "俯趴在 bench 上，胸口贴稳、脸朝下；双手各拿最小的片（2.5–5 lb 足够）。",
    cues: ["Y：手臂向头顶斜上方举起，拇指朝上", "T：手臂向两侧平举，夹紧肩胛", "W：屈肘呈 W 形后收，肘部向后下方拉"],
    mistakes: ["重量过大靠摆动", "抬头耸肩", "手臂举起时腰部反弓"],
    // No demo image: no cleanly licensed stills source for prone
    // Y-T-W on a bench. Teaching video instead (verified 2026-10-19,
    // see DATA-PLAN.md): The Active Life's prone Y-T-W — face down,
    // working through the Y, T and W positions.
    video: "https://www.youtube.com/watch?v=QdGTI4Lshg4",
    source: "外部教学视频 · The Active Life · 俯卧 Y-T-W",
  },
  "side-external-rotation": {
    title: "侧卧外旋 · 小片",
    focus: "肩袖外旋肌群",
    setup: "侧卧，上方手肘夹一条毛巾贴住身体，手里拿最小的片。",
    cues: ["肘部固定不动，只让前臂向外打开", "打开到舒适的最大角度后慢放", "全程保持肘部夹紧毛巾"],
    mistakes: ["肘部离开身体", "身体向后翻转借力", "重量过大动作变形"],
    demo: EXERCISE_DEMOS["side-external-rotation"],
  },
  "thoracic-extension": {
    title: "胸椎伸展 · Bench 边缘",
    focus: "胸椎活动度",
    setup: "仰卧，上背靠在 bench 边缘，双手托住后脑，臀部贴地。",
    cues: ["以 bench 边缘为支点慢慢向后伸展上背", "每个位置停留数次呼吸", "上下移动几厘米换一个节段"],
    mistakes: ["用腰部后仰代替胸椎伸展", "臀部离地", "动作过猛或憋气"],
    // No demo image: no cleanly licensed stills source for thoracic
    // extension over a bench edge. Teaching video instead (verified
    // 2026-10-19, see DATA-PLAN.md): The Barbell Physio's foam-roller
    // thoracic extensions — the same extension pattern (upper back
    // over a support, hands behind head, hips on the floor), with a
    // foam roller standing in for the bench edge.
    video: "https://www.youtube.com/watch?v=81kPLsMt6wY",
    source: "外部教学视频 · The Barbell Physio · 胸椎伸展（泡沫轴版，同动作模式）",
  },
  "single-leg-balance": {
    title: "单腿平衡触点",
    focus: "踝膝稳定 · 本体感觉",
    setup: "单脚站稳，另一只脚悬空；先扶墙或椅背找平衡。",
    cues: ["悬空脚依次轻触前、侧、后三个点", "支撑腿膝盖对准脚尖方向", "躯干保持直立，目光看前方固定点"],
    mistakes: ["支撑脚脚踝左右晃动失控", "膝盖向内塌", "靠快速摆动保持平衡"],
    // No demo image: no cleanly licensed stills source for the
    // three-point single-leg balance tap. Teaching video instead
    // (verified 2026-10-19, see DATA-PLAN.md): a physical therapist
    // (Dr. Chonko PT, DPT) demonstrating the single-leg balance +
    // 3-way tap — forward, lateral and backward taps.
    video: "https://www.youtube.com/watch?v=QOUYmI6Snqs",
    source: "外部教学视频 · Body Balance 物理治疗 · 单腿平衡三向触点",
  },
  "home-bulgarian-split-squat": {
    title: "保加利亚分腿蹲 · Bench 抱片",
    focus: "股四头肌 · 臀大肌 · 单腿稳定",
    setup: "后脚脚背搭在 bench 上，双手抱一片杠铃片在胸前；这是耐力练法，次数优先。",
    cues: ["绝大部分重量留在前脚", "前膝沿脚尖方向移动", "节奏均匀，不追求大重量"],
    mistakes: ["前脚离凳太近导致脚跟抬起", "前膝向内塌", "后腿用力过多"],
    // No demo image: no cleanly licensed stills source for the home
    // version (stock results were regular squats and walking
    // lunges); the gym version's guide has a verified photo pair of
    // the same movement pattern. Teaching video instead (verified
    // 2026-10-19, see DATA-PLAN.md): ATHLEAN-X's Bulgarian split
    // squat form tutorial (Jeff Cavaliere, physical therapist) —
    // same rear-foot-elevated pattern; this home version holds one
    // plate at the chest instead of dumbbells.
    video: "https://www.youtube.com/watch?v=hiLF_pF3EJM",
    source: "外部教学视频 · ATHLEAN-X · 保加利亚分腿蹲（同动作，居家版抱片）",
  },
  "bench-step-up": {
    title: "Bench 登阶",
    focus: "股四头肌 · 臀大肌 · 单腿力量",
    setup: "面对 bench 站立，一只脚整只踩上凳面；先确认 bench 稳定不滑动。",
    cues: ["由踩上的腿主动发力站直", "下放时慢速控制 2–3 秒", "躯干保持直立，不用后脚蹬地"],
    mistakes: ["后脚猛蹬借力", "膝盖向内塌", "下放直接掉落"],
    demo: EXERCISE_DEMOS["bench-step-up"],
  },
  // W-HOMEB-001: text-only guide, prepared ahead of the dated swap —
  // from 2026-11-16 until the first snowboard trip this replaces the
  // bench-step-up slot in Home B at equal volume (2 sets); the stored
  // plan itself is unchanged until then.
  "lateral-lunge": {
    title: "侧向弓步",
    focus: "横向力量与耐力 · 单板横向重心转移",
    setup: "双脚并拢站立，胸口抬起，双手叉腰或在胸前交握。三周渐进：第 1 周只做体重侧向弓步；第 2 周在底部加 1–2 次小幅脉冲再蹬回；第 3 周以脉冲弓步为主。不做跳跃版。",
    cues: ["向侧面迈一大步，髋部向后坐下", "下蹲腿膝盖对准脚尖方向", "全脚掌压地发力蹬回起始位", "支撑腿保持伸直，躯干别向侧倒"],
    mistakes: ["膝盖向内塌", "步幅太小，练不到横向发力", "蹬回时靠伸直支撑腿把身体拉回来"],
  },
  "home-calf-raise": {
    title: "提踵 · 抱片",
    focus: "腓肠肌 · 比目鱼肌",
    setup: "双手抱片于胸前，前脚掌踩稳台阶或地面边缘，另一手扶稳。",
    cues: ["脚跟下沉到充分拉伸", "蹬起至最高点停 1 秒", "高次数慢节奏，练的是耐力"],
    mistakes: ["借弹跳快速起落", "动作幅度不足", "身体前后摇晃"],
    demo: EXERCISE_DEMOS["home-calf-raise"],
  },
  "wall-sit": {
    title: "靠墙静蹲",
    focus: "股四头肌耐力 · 单板半蹲姿势",
    setup: "背部整片贴墙下滑，膝盖约 90°，双脚向前与肩同宽。",
    cues: ["膝盖对准脚尖方向", "重量均匀落在全脚掌", "呼吸均匀，逐周把每组时间加上去（45 秒 → 90 秒）"],
    mistakes: ["膝盖超过脚尖太多且内塌", "双手撑在大腿上卸力", "下滑角度太浅没有训练效果"],
    // No demo image: no cleanly licensed stills source for the wall
    // sit on Pexels / Pixabay / Wikimedia Commons. Teaching video
    // instead (verified 2026-10-19, see DATA-PLAN.md): E3 Rehab's
    // wall sit — back flat against the wall, knees ~90°, held.
    video: "https://www.youtube.com/watch?v=RG7z0P9qrLk",
    source: "外部教学视频 · E3 Rehab · 靠墙静蹲",
  },
  "dead-bug": {
    title: "死虫",
    focus: "核心抗伸展",
    setup: "仰卧，双臂伸向天花板，髋膝各屈 90°；下背主动压紧地面。",
    cues: ["对侧手脚同时慢慢伸直，不碰地就收回", "下背全程贴地，肋骨收住", "呼气时移动，动作越慢越好"],
    mistakes: ["下背离开地面弓起来", "速度太快靠惯性", "憋气"],
    demo: EXERCISE_DEMOS["dead-bug"],
  },
  "side-plank": {
    title: "侧平板",
    focus: "腹斜肌 · 核心抗侧屈",
    setup: "侧卧，前臂撑地，肘在肩正下方；双腿伸直叠放，髋部抬离地面。",
    cues: ["身体从头到脚成一条直线", "髋部主动向前顶，不下沉", "保持均匀呼吸，先做到目标秒数"],
    mistakes: ["髋部下沉或向后倒", "头部下垂", "肩膀耸起贴近耳朵"],
    demo: EXERCISE_DEMOS["side-plank"],
  },
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", weekday: "short" }).format(new Date(value));
}

function formatClock(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatDuration(start: string, end?: string | null) {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function completedCount(workout: Workout) {
  return workout.sets.filter((set) => set.completed).length;
}

function trainingVolume(workout: Workout) {
  return workout.sets.reduce((sum, set) => {
    if (!set.completed || set.weight == null || set.reps == null) return sum;
    return sum + set.weight * set.reps;
  }, 0);
}

function groupSets(sets: WorkoutSet[]) {
  const groups: { key: string; name: string; target: string; sets: WorkoutSet[] }[] = [];
  for (const set of sets) {
    const existing = groups.find((group) => group.key === set.exercise_key);
    if (existing) existing.sets.push(set);
    else groups.push({ key: set.exercise_key, name: set.exercise_name, target: set.target_reps, sets: [set] });
  }
  return groups;
}

function previousCompleteWeek(now = new Date()) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekday = end.getDay();
  end.setDate(end.getDate() - (weekday === 0 ? 6 : weekday - 1));
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  return { start, end };
}

function workoutsInRange(workouts: Workout[], start: Date, end: Date) {
  return workouts.filter((workout) => {
    const completed = workout.completed_at ? new Date(workout.completed_at) : null;
    return completed != null && completed >= start && completed < end;
  });
}

// W2.3: the in-progress week — Monday (local calendar) through today.
// `today` is the local start-of-day for the current date and `end` is
// tomorrow's start-of-day (exclusive), so a record belongs to this
// window by the same completion-time rule workoutsInRange applies to
// the review week: a late-saved record lands in the week of its
// completed_at, never its started_at. Pure calendar arithmetic via
// setDate, so a week containing a DST transition still spans exactly
// Monday..today local calendar days.
export function currentWeekRange(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekday = today.getDay();
  const start = new Date(today);
  start.setDate(start.getDate() - (weekday === 0 ? 6 : weekday - 1));
  const end = new Date(today);
  end.setDate(end.getDate() + 1);
  return { start, today, end };
}

// W2.3: the in-progress week's saved-completed summary. Only workouts
// with a completed_at inside the window count — an in-progress
// (active) workout has completed_at null and is therefore never
// counted here; the UI lists it on its own line instead. Set totals
// count completed sets only.
export function currentWeekSummary(workouts: Workout[], now = new Date()) {
  const range = currentWeekRange(now);
  const sessions = workoutsInRange(workouts, range.start, range.end);
  return {
    start: range.start,
    today: range.today,
    sessions,
    completedSets: sessions.reduce((sum, workout) => sum + completedCount(workout), 0),
  };
}

// W2.3 (P1 fix): full-week totals for the in-progress week. The detail
// sessions above come from getDashboard's recent_workouts, which is a
// capped sample (recent_limit) — with more saved sessions this week
// than the cap, the sample silently undercounts the week and must
// never be reported as the week's total. The dashboard's
// week_summaries are computed server-side from ALL completed workouts
// of the last 21 days with no limit, so the bucket whose week_start
// matches this week's Monday (local date, YYYY-MM-DD) is the
// full-week truth: its sessions is the week's total session count,
// and measured + unmeasured completed sets is the week's total
// completed-set count (completed sets without a measured load count
// too). When week_summaries is missing, empty, or has no matching
// bucket (e.g. an older response), hasFullTotals is false and the
// totals fall back to the detail sample's own counts — callers must
// then label them as sample counts, never as the full week. Pure: no
// IO, and the two-argument currentWeekSummary above keeps its exact
// semantics for the detail list.
export function currentWeekSummaryWithTotals(
  workouts: Workout[],
  weekSummaries: readonly WeekSummary[] | null | undefined,
  now = new Date(),
) {
  const detail = currentWeekSummary(workouts, now);
  const detailCount = detail.sessions.length;
  const detailCompletedSets = detail.completedSets;
  const monday = detail.start;
  const mondayKey = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
  const bucket = weekSummaries?.find((entry) => entry.week_start === mondayKey) ?? null;
  if (!bucket) {
    return {
      start: detail.start,
      today: detail.today,
      sessions: detail.sessions,
      totalSessions: detailCount,
      totalCompletedSets: detailCompletedSets,
      detailCount,
      detailCompletedSets,
      hasFullTotals: false,
      missingDetailCount: 0,
    };
  }
  const totalSessions = bucket.sessions;
  const totalCompletedSets = bucket.measured_completed_sets + bucket.unmeasured_completed_sets;
  return {
    start: detail.start,
    today: detail.today,
    sessions: detail.sessions,
    totalSessions,
    totalCompletedSets,
    detailCount,
    detailCompletedSets,
    hasFullTotals: true,
    missingDetailCount: Math.max(0, totalSessions - detailCount),
  };
}

function targetRange(target: string) {
  const values = target.match(/\d+/g)?.map(Number).filter(Number.isFinite) ?? [];
  const first = values[0] ?? 0;
  return { min: first, max: values[1] ?? first };
}

// W1.1–W1.4: the single progressive-overload rule — a line-for-line copy
// of progressionDecision in server/src/actions.ts (same name, signature
// and logic), so the start-of-workout prefill and this weekly review can
// never disagree about the "next time" suggestion again. Pure: no IO.
export function progressionDecision(input: {
  plannedSets: number;
  sets: { weight: number | null; reps: number | null; completed: boolean }[];
  targetMin: number;
  targetMax: number;
  unit: "lb" | "kg";
}): { action: "increase" | "hold" | "reduce" | "none"; suggestedWeight: number | null; suggestedReps: number | null } {
  const none: { action: "none"; suggestedWeight: null; suggestedReps: null } = {
    action: "none",
    suggestedWeight: null,
    suggestedReps: null,
  };
  if (input.sets.length === 0 || input.plannedSets <= 0) return none;
  const completed = input.sets.filter((set) => set.completed);
  if (completed.length === 0) return none;
  const weightedWeights = completed
    .map((set) => set.weight)
    .filter((weight): weight is number => weight != null);
  // W1.4: bodyweight / unmeasured sets (weight null) never stand in as a
  // comparable load of 0 — with no weighed completed set there is no
  // weight suggestion at all.
  if (weightedWeights.length === 0) return none;
  const base = Math.max(...weightedWeights);
  const increment = input.unit === "lb" ? 5 : 2.5;
  if (completed.length < input.plannedSets) {
    // Not all planned sets were done: hold the weight; per-set reps are
    // carried over by the caller (suggestedReps null = carry over).
    return { action: "hold", suggestedWeight: base, suggestedReps: null };
  }
  if (completed.some((set) => set.reps == null)) return none;
  if (completed.every((set) => set.weight != null && set.reps != null && set.reps >= input.targetMax)) {
    return {
      action: "increase",
      suggestedWeight: Math.round((base + increment) * 2) / 2,
      suggestedReps: input.targetMin,
    };
  }
  if (completed.some((set) => set.reps != null && set.reps < input.targetMin)) {
    return {
      action: "reduce",
      suggestedWeight: Math.max(0, Math.round((base - increment) * 2) / 2),
      suggestedReps: null,
    };
  }
  return { action: "hold", suggestedWeight: base, suggestedReps: null };
}

// W1.3: same conversion constant and rounding as the server.
export const LB_TO_KG = 0.45359237;

export function convertWeightValue(weight: number, from: Unit, to: Unit): number {
  if (from === to) return weight;
  const converted = from === "lb" ? weight * LB_TO_KG : weight / LB_TO_KG;
  return Math.round(converted * 2) / 2;
}

function compactDate(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(value);
}

type ExercisePerformance = {
  key: string;
  name: string;
  unit: Unit;
  target: string;
  planned: number;
  completed: number;
  atTop: number;
  belowMin: number;
  bestWeight: number | null;
  totalReps: number;
  repsLogged: number;
};

type ExerciseReview = ExercisePerformance & {
  prior: ExercisePerformance | null;
};

function exercisePerformances(workouts: Workout[]): ExercisePerformance[] {
  const performances: ExercisePerformance[] = [];
  for (const workout of workouts) {
    for (const exercise of groupSets(workout.sets)) {
      const completedSets = exercise.sets.filter((set) => set.completed);
      const repsLogged = completedSets.filter((set) => set.reps != null);
      const { min, max } = targetRange(exercise.target);
      const existing = performances.find((item) => item.key === exercise.key && item.unit === workout.unit);
      const bestWeight = completedSets.reduce<number | null>((best, set) => {
        if (set.weight == null) return best;
        return best == null ? set.weight : Math.max(best, set.weight);
      }, null);
      if (existing) {
        existing.planned += exercise.sets.length;
        existing.completed += completedSets.length;
        existing.atTop += completedSets.filter((set) => set.reps != null && set.reps >= max).length;
        existing.belowMin += completedSets.filter((set) => set.reps != null && set.reps < min).length;
        existing.totalReps += repsLogged.reduce((sum, set) => sum + (set.reps ?? 0), 0);
        existing.repsLogged += repsLogged.length;
        if (bestWeight != null) existing.bestWeight = existing.bestWeight == null ? bestWeight : Math.max(existing.bestWeight, bestWeight);
        continue;
      }
      performances.push({
        key: exercise.key,
        name: exercise.name,
        unit: workout.unit,
        target: exercise.target,
        planned: exercise.sets.length,
        completed: completedSets.length,
        atTop: completedSets.filter((set) => set.reps != null && set.reps >= max).length,
        belowMin: completedSets.filter((set) => set.reps != null && set.reps < min).length,
        bestWeight,
        totalReps: repsLogged.reduce((sum, set) => sum + (set.reps ?? 0), 0),
        repsLogged: repsLogged.length,
      });
    }
  }
  return performances;
}

function exerciseReviews(week: Workout[], priorWeek: Workout[]): ExerciseReview[] {
  const current = exercisePerformances(week);
  const prior = exercisePerformances(priorWeek);
  return current.map((performance) => ({
    ...performance,
    prior: prior.find((item) => item.key === performance.key && item.unit === performance.unit) ?? null,
  }));
}

function averageReps(performance: ExercisePerformance) {
  if (performance.repsLogged === 0) return null;
  return Math.round((performance.totalReps / performance.repsLogged) * 10) / 10;
}

function weightTrend(review: ExerciseReview) {
  const currentAverage = averageReps(review);
  const repText = currentAverage == null ? "次数未完整记录" : `平均 ${currentAverage} 次`;
  if (review.bestWeight == null) return `未记录重量 · ${repText}`;
  if (!review.prior || review.prior.bestWeight == null) return `最高 ${review.bestWeight}${review.unit} · 前一周无同单位重量记录 · ${repText}`;
  const delta = Math.round((review.bestWeight - review.prior.bestWeight) * 10) / 10;
  const weightText = delta === 0
    ? `最高 ${review.bestWeight}${review.unit} · 连续两周持平`
    : `最高 ${review.bestWeight}${review.unit} · 较前一周${delta > 0 ? "+" : ""}${delta}${review.unit}`;
  const priorAverage = averageReps(review.prior);
  if (currentAverage == null || priorAverage == null) return `${weightText} · ${repText}`;
  const repDelta = Math.round((currentAverage - priorAverage) * 10) / 10;
  return `${weightText} · 平均次数${repDelta === 0 ? "持平" : `较前一周${repDelta > 0 ? "+" : ""}${repDelta}`}`;
}

type ComparableHistoryEntry = NonNullable<Dashboard["comparable_history"]>[number];
type ReceiptPreviousEntry = NonNullable<Dashboard["receipt_previous"]>[number];

// Shared tail of reviewRecommendation: given ONE comparable candidate
// (target string, source unit, and ALL of the exercise's sets from the
// source workout — completed and uncompleted alike), convert its
// weights into the review unit and run the same progressionDecision
// the server prefill uses, then phrase the verdict. Both candidate
// sources (comparable_history and the recent_workouts fallback) feed
// through here so the wording and the rule can never drift apart.
function recommendationFromCandidate(
  review: ExerciseReview,
  candidate: {
    target: string;
    unit: Unit;
    sets: { weight: number | null; reps: number | null; completed: boolean }[];
  },
) {
  const { min, max } = targetRange(candidate.target);
  const unitConverted = candidate.unit !== review.unit;
  const sets = candidate.sets.map((set) => ({
    weight: set.weight == null
      ? null
      : unitConverted
        ? convertWeightValue(set.weight, candidate.unit, review.unit)
        : set.weight,
    reps: set.reps,
    completed: set.completed,
  }));
  const planned = candidate.sets.length;
  const decision = progressionDecision({
    plannedSets: planned,
    sets,
    targetMin: min,
    targetMax: max,
    unit: review.unit,
  });
  if (decision.action === "increase") {
    return `${review.name}：上次全部 ${planned} 组完成且都达到次数上限 ${max}，下次增至 ${decision.suggestedWeight}${review.unit}`;
  }
  if (decision.action === "reduce") {
    return `${review.name}：上次有组低于目标下限 ${min}，下次降至 ${decision.suggestedWeight}${review.unit}，先回到目标区间`;
  }
  if (decision.action === "hold") {
    const completedCount = sets.filter((set) => set.completed).length;
    if (completedCount < planned) {
      return `${review.name}：上次少完成 ${planned - completedCount} 组，下次保持 ${decision.suggestedWeight}${review.unit}`;
    }
    return `${review.name}：上次未全部达到次数上限，下次保持 ${decision.suggestedWeight}${review.unit}`;
  }
  return `${review.name}：上次没有可比重量记录，暂不做重量建议`;
}

// W2.3: the basis line under each W1 suggestion — the date and unit
// of the record the suggestion actually derives from (the comparable
// source workout), with the existing 已换算 marker when that source's
// unit differs from the review unit and its weights were converted.
function recommendationBasis(sourceCompletedAt: string | null, sourceUnit: Unit, reviewUnit: Unit) {
  const parts: string[] = [];
  if (sourceCompletedAt) parts.push(formatDate(sourceCompletedAt));
  parts.push(`${sourceUnit} 记录`);
  if (sourceUnit !== reviewUnit) parts.push("已换算");
  return `依据：${parts.join(" · ")}`;
}

function reviewRecommendation(
  review: ExerciseReview,
  workouts: Workout[],
  comparableHistory?: ComparableHistoryEntry[],
): { text: string; basis: string | null } {
  // W1: the "next time" suggestion is decided by this exercise's most
  // recent comparable workout, fed through the same progressionDecision
  // the server prefill uses. The week-over-week evidence above stays
  // display-only and no longer derives a second, conflicting verdict.
  // W1-CONSISTENCY-001 (cross-window fix): the candidate comes FIRST
  // from comparable_history — the server's per-routine selection, the
  // exact candidate startWorkout's prefill judges — because
  // recent_workouts is a GLOBAL window (all routines mixed): a
  // comparable record can rank beyond the global 20 while still
  // inside its own routine's 20, and the old scan then reported "no
  // comparable record" while the prefill suggested a weight. Only
  // when comparable_history is absent (older server) does the scan
  // below run, unchanged.
  const historyEntry = comparableHistory?.find((entry) => entry.exercise_key === review.key);
  if (historyEntry) {
    return {
      text: recommendationFromCandidate(review, {
        target: historyEntry.target,
        unit: historyEntry.unit,
        sets: historyEntry.sets,
      }),
      // W2.3: the date comes from the source workout's own completion
      // time (server-passed source_completed_at), never from the
      // review week or from "today".
      basis: recommendationBasis(historyEntry.source_completed_at, historyEntry.unit, review.unit),
    };
  }
  let comparable: { workout: Workout; exercise: ReturnType<typeof groupSets>[number] } | null = null;
  for (const workout of workouts) {
    const exercise = groupSets(workout.sets).find((group) => group.key === review.key);
    if (exercise) {
      comparable = { workout, exercise };
      break;
    }
  }
  if (!comparable) return { text: `${review.name}：上次没有可比重量记录，暂不做重量建议`, basis: null };
  return {
    text: recommendationFromCandidate(review, {
      target: comparable.exercise.target,
      unit: comparable.workout.unit,
      sets: comparable.exercise.sets,
    }),
    basis: recommendationBasis(comparable.workout.completed_at, comparable.workout.unit, review.unit),
  };
}

// --- W4.3-D1: completion receipt derivation (pure) ---
// The receipt is built ONLY from the record read back by the finished
// workout's own id (getDashboard's receipt / receipt_previous fields)
// — never from the active workout's draft sets, and never from
// whichever record happens to be most recent. Per exercise it shows
// this workout's completed/total sets next to the most recent earlier
// same-routine, same-key record (supplied by the server's
// selectReceiptPrevious); a missing entry renders as 暂无可比记录.
// Counts come straight from the stored sets: uncompleted sets are
// counted as uncompleted, never zero-filled, and a real 0 completed
// count stays 0. The next-time suggestion runs the SAME W1
// progressionDecision (above) over THIS workout's own sets — no new
// thresholds, no readiness input — and when the rule has no reliable
// input (its "none" verdict) the line honestly reads 数据不足.
export type ReceiptExerciseLine = {
  key: string;
  name: string;
  completedSets: number;
  totalSets: number;
  incompleteSets: number;
  previous: { sourceDate: string; completedSets: number; totalSets: number } | null;
  suggestion: string;
};

export function receiptExerciseLines(
  workout: Workout,
  previous: ReceiptPreviousEntry[] | undefined,
) {
  const lines: ReceiptExerciseLine[] = groupSets(workout.sets).map((exercise) => {
    const completedSets = exercise.sets.filter((set) => set.completed).length;
    const totalSets = exercise.sets.length;
    const entry = previous?.find((item) => item.exercise_key === exercise.key) ?? null;
    const { min, max } = targetRange(exercise.target);
    const decision = progressionDecision({
      plannedSets: totalSets,
      sets: exercise.sets,
      targetMin: min,
      targetMax: max,
      unit: workout.unit,
    });
    let suggestion: string;
    if (decision.action === "increase") {
      suggestion = `下次增至 ${decision.suggestedWeight}${workout.unit}`;
    } else if (decision.action === "reduce") {
      suggestion = `下次降至 ${decision.suggestedWeight}${workout.unit}`;
    } else if (decision.action === "hold") {
      suggestion = completedSets < totalSets
        ? `下次维持 ${decision.suggestedWeight}${workout.unit}，先完成全部 ${totalSets} 组`
        : `下次维持 ${decision.suggestedWeight}${workout.unit}`;
    } else {
      suggestion = "数据不足";
    }
    return {
      key: exercise.key,
      name: exercise.name,
      completedSets,
      totalSets,
      incompleteSets: totalSets - completedSets,
      previous: entry
        ? { sourceDate: entry.source_completed_at, completedSets: entry.completed_sets, totalSets: entry.total_sets }
        : null,
      suggestion,
    };
  });
  return lines;
}

// W4.3-D1: the receipt's read-back phase. The read locates the record
// strictly by the finished workout's id; while it is in flight the
// receipt shows the intermediate 正在读取记录 state (draft set counts
// are never presented as saved counts), and any failure — transport
// error, or a successful response whose receipt is null — lands in
// the retryable 记录暂未读出 state. Retrying re-runs ONLY this read:
// it never calls completeWorkout again and never reactivates the
// finished record.
export type ReceiptReadPhase = "reading" | "unavailable" | "ready";

export function receiptReadPhase(input: { isPending: boolean; isError: boolean; receiptFound: boolean }) {
  const phase: ReceiptReadPhase = input.isPending
    ? "reading"
    : input.isError || !input.receiptFound
      ? "unavailable"
      : "ready";
  return phase;
}

// --- W6.2 / H4.6: exercise -> muscle-group map (MUSCLE-MAP.md v1) ---
// The single shared mapping, copied verbatim from workout-log/
// MUSCLE-MAP.md map_version 1: all 30 stable exercise_keys with their
// primary (1–2) and secondary muscle groups. An unknown/custom key is
// explicitly unmapped — never guessed from a similar name. Both calf
// keys (calf-raise / home-calf-raise) ARE mapped (primary 小腿）; they
// only lack a demo image, which is a separate concern.
export type MuscleMapping = { primary: string[]; secondary: string[] };

export const MUSCLE_MAP_VERSION = 1;

export const MUSCLE_MAP: Record<string, MuscleMapping> = {
  "barbell-bench": { primary: ["胸"], secondary: ["肱三头肌", "肩前束"] },
  "overhead-press": { primary: ["肩前束", "肩中束"], secondary: ["肱三头肌", "核心"] },
  "incline-dumbbell-press": { primary: ["胸"], secondary: ["肩前束", "肱三头肌"] },
  dips: { primary: ["胸", "肱三头肌"], secondary: ["肩前束"] },
  "lateral-raise": { primary: ["肩中束"], secondary: ["斜方肌"] },
  "push-up-plus": { primary: ["前锯肌"], secondary: ["胸", "核心"] },
  "wide-lat-pulldown": { primary: ["背阔肌"], secondary: ["肱二头肌", "肩后束"] },
  "close-lat-pulldown": { primary: ["背阔肌"], secondary: ["肱二头肌"] },
  "close-seated-row": { primary: ["背阔肌", "菱形肌"], secondary: ["肱二头肌", "斜方肌"] },
  "wide-seated-row": { primary: ["菱形肌", "肩后束"], secondary: ["背阔肌", "斜方肌"] },
  "face-pull": { primary: ["肩后束"], secondary: ["斜方肌", "菱形肌"] },
  "reverse-pec-deck": { primary: ["肩后束"], secondary: ["斜方肌"] },
  "rope-curl": { primary: ["肱二头肌"], secondary: [] },
  "back-squat": { primary: ["股四头肌", "臀大肌"], secondary: ["核心", "腘绳肌"] },
  "romanian-deadlift": { primary: ["腘绳肌", "臀大肌"], secondary: ["斜方肌", "核心"] },
  "bulgarian-split-squat": { primary: ["股四头肌", "臀大肌"], secondary: ["小腿", "核心"] },
  "lying-leg-curl": { primary: ["腘绳肌"], secondary: ["小腿"] },
  "calf-raise": { primary: ["小腿"], secondary: [] },
  "tibialis-raise": { primary: ["胫骨前肌"], secondary: [] },
  "supine-chin-tuck": { primary: ["颈深屈肌"], secondary: [] },
  "prone-ytw": { primary: ["斜方肌", "肩后束"], secondary: ["菱形肌", "胸椎伸展肌群"] },
  "side-external-rotation": { primary: ["肩后束"], secondary: [] },
  "thoracic-extension": { primary: ["胸椎伸展肌群"], secondary: [] },
  "single-leg-balance": { primary: ["小腿", "臀大肌"], secondary: ["核心"] },
  "home-bulgarian-split-squat": { primary: ["股四头肌", "臀大肌"], secondary: ["小腿", "核心"] },
  "bench-step-up": { primary: ["股四头肌", "臀大肌"], secondary: ["小腿"] },
  "lateral-lunge": { primary: ["股四头肌", "臀大肌"], secondary: ["核心"] },
  "home-calf-raise": { primary: ["小腿"], secondary: [] },
  "wall-sit": { primary: ["股四头肌"], secondary: ["臀大肌"] },
  "dead-bug": { primary: ["核心"], secondary: [] },
  "side-plank": { primary: ["腹斜肌", "核心"], secondary: ["臀大肌"] },
};

// H4.6 receipt facts (pure): aggregate THIS workout's completed sets
// only, per muscle group. An exercise belonging to several muscle
// groups is counted under EACH of them (duplicate attribution), so
// the per-group set counts must never be added up into a whole-body
// total. Bodyweight / timed sets (weight null) still count as sets —
// this section reports set counts and exercise names only, never a
// volume, so a missing weight is never zero-filled. Exercises with no
// completed set contribute nothing; an exercise whose key has no
// mapping is listed once under unmapped （尚无映射）, never guessed.
export type MuscleGroupFact = { muscle: string; sets: number; exercises: string[] };
export type MuscleReceiptFacts = {
  primary: MuscleGroupFact[];
  secondary: MuscleGroupFact[];
  unmapped: string[];
};

export function muscleReceiptFacts(workout: Workout): MuscleReceiptFacts {
  const primary: MuscleGroupFact[] = [];
  const secondary: MuscleGroupFact[] = [];
  const unmapped: string[] = [];
  const addFact = (facts: MuscleGroupFact[], muscle: string, sets: number, name: string) => {
    const existing = facts.find((fact) => fact.muscle === muscle);
    if (existing) {
      existing.sets += sets;
      if (!existing.exercises.includes(name)) existing.exercises.push(name);
    } else {
      facts.push({ muscle, sets, exercises: [name] });
    }
  };
  for (const exercise of groupSets(workout.sets)) {
    const completedSets = exercise.sets.filter((set) => set.completed).length;
    if (completedSets === 0) continue;
    const mapping = MUSCLE_MAP[exercise.key];
    if (!mapping) {
      if (!unmapped.includes(exercise.name)) unmapped.push(exercise.name);
      continue;
    }
    for (const muscle of mapping.primary) addFact(primary, muscle, completedSets, exercise.name);
    for (const muscle of mapping.secondary) addFact(secondary, muscle, completedSets, exercise.name);
  }
  return { primary, secondary, unmapped };
}

// W2.3: the in-progress week layer, shown above the previous
// complete week's review. It reports ONLY what is already saved:
// each saved-completed session of this week (Monday through today)
// with its completed/total set counts, plus a totals line. The
// totals come from the server's full-week week_summaries bucket
// (currentWeekSummaryWithTotals): the detail list below is only the
// recent_workouts sample, so when the sample cannot show every
// session of the week a line says how many are not expanded, and
// when no full-week bucket is available the totals are labelled as
// sample counts instead of week totals. A workout still being
// recorded is named on its own line and never folded into the
// completed counts. With zero saved sessions it says exactly that —
// no inference about whether the user trained, and no suggestion. On
// the start page each session row is a button opening that record in
// History (the same focus mechanism the receipt uses); the compact
// variant on the active-workout page renders the same facts without
// the navigation.
function CurrentWeekProgress({ workouts, weekSummaries, activeWorkout, onOpenWorkout, compact }: {
  workouts: Workout[];
  weekSummaries?: readonly WeekSummary[] | null;
  activeWorkout?: Workout | null;
  onOpenWorkout?: (workoutId: number) => void;
  compact?: boolean;
}) {
  const summary = currentWeekSummaryWithTotals(workouts, weekSummaries);
  const title = `本周进行中 · ${compactDate(summary.start)}–${compactDate(summary.today)}`;
  return (
    <section className={`current-week${compact ? " current-week-compact" : ""}`} aria-label={title}>
      <div className="current-week-head">
        <h2>{title}</h2>
        {summary.hasFullTotals ? (
          summary.totalSessions > 0 ? (
            <span>已保存完成 {summary.totalSessions} 次 · 共 {summary.totalCompletedSets} 组</span>
          ) : null
        ) : summary.detailCount > 0 ? (
          <span>最近样本内已保存完成 {summary.detailCount} 次 · 共 {summary.detailCompletedSets} 组（全周总数未确认）</span>
        ) : null}
      </div>
      {summary.sessions.length === 0 ? (
        summary.hasFullTotals && summary.totalSessions > 0 ? null : (
          <p className="current-week-empty">
            {summary.hasFullTotals ? "本周暂无已保存完成记录" : "最近样本内暂无已保存完成记录（全周未确认）"}
          </p>
        )
      ) : (
        <ul className="current-week-list">
          {summary.sessions.map((workout) => {
            const label = `${formatDate(workout.completed_at ?? workout.started_at)} · ${ROUTINE_META[workout.routine].title} · 已完成 ${completedCount(workout)}/${workout.sets.length} 组`;
            return (
              <li key={workout.id}>
                {onOpenWorkout ? (
                  <button
                    type="button"
                    className="current-week-row"
                    aria-label={`查看记录：${label}`}
                    onClick={() => onOpenWorkout(workout.id)}
                  >
                    <span>{label}</span>
                    <span aria-hidden="true">›</span>
                  </button>
                ) : (
                  <span className="current-week-row">{label}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {summary.hasFullTotals && summary.missingDetailCount > 0 ? (
        <p className="current-week-note">明细展示最近 {summary.detailCount} 条，其余 {summary.missingDetailCount} 条未在明细中展开</p>
      ) : null}
      {activeWorkout ? (
        <p className="current-week-active">正在记录：{ROUTINE_META[activeWorkout.routine].title}（未计入完成数）</p>
      ) : null}
    </section>
  );
}

function WeeklyReview({ workouts, comparableHistory }: { workouts: Workout[]; comparableHistory?: ComparableHistoryEntry[] }) {
  const { start, end } = previousCompleteWeek();
  const priorStart = new Date(start);
  priorStart.setDate(priorStart.getDate() - 7);
  const week = workoutsInRange(workouts, start, end);
  const priorWeek = workoutsInRange(workouts, priorStart, start);
  const sets = week.reduce((sum, workout) => sum + completedCount(workout), 0);
  const routines = new Set(week.map((workout) => workout.routine));
  const completeRound = GYM_ROUTINES.every((routine) =>
    week.some((workout) => workout.routine === routine && workout.sets.length > 0 && workout.sets.every((set) => set.completed)),
  );
  const missing = GYM_ROUTINES.filter((routine) => !routines.has(routine));
  const reviews = exerciseReviews(week, priorWeek);
  const recommendations = reviews.map((review) => reviewRecommendation(review, workouts, comparableHistory));
  const endInclusive = new Date(end);
  endInclusive.setDate(endInclusive.getDate() - 1);

  return (
    <section className="weekly-review" aria-labelledby="weekly-review-title">
      <div className="review-header">
        <div>
          <p>上个完整周 · {compactDate(start)}–{compactDate(endInclusive)}</p>
          <h2 id="weekly-review-title">
            {week.length === 0 ? "暂无训练可复盘" : completeRound ? "按实际表现微调" : "先完成完整一轮"}
          </h2>
        </div>
        <span>{week.length} 次 · {sets} 组</span>
      </div>
      <p className="review-body">
        {week.length === 0
          ? "上周一到周日没有完成记录。沿用当前安排，完成推、拉、腿各一练后再判断动作调整。"
          : completeRound
            ? "上周已完成推、拉、腿各一轮。负荷建议只看最近一次可比训练：全部组完成且都达到次数上限才增重，有组低于下限则建议降重，未完成则保持，无可比记录不给建议。"
            : `上周${routines.size > 0 ? `记录了 ${Array.from(routines).map((routine) => ROUTINE_META[routine].label).join("、")}` : "没有有效训练"}${missing.length > 0 ? `，缺少 ${missing.map((routine) => ROUTINE_META[routine].label).join("、")}` : "，但至少一次训练未完成全部组数"}；已记录动作仍按最近一次可比训练判断负荷：全部组完成且都达到次数上限才增重，有组低于下限则建议降重，未完成则保持，无可比记录不给建议。`}
      </p>

      {reviews.length > 0 ? (
        <details className="review-evidence">
          <summary>查看各动作表现依据 <span>{reviews.length} 个动作</span></summary>
          <div>
            {reviews.map((review) => (
              <p key={`${review.key}-${review.unit}`}>
                <strong>{review.name}</strong>
                <span>
                  该复盘周 {review.completed}/{review.planned} 组 · {review.atTop} 组到上限
                  {review.prior ? `；前周 ${review.prior.atTop}/${review.prior.completed} 组到上限` : "；前周无记录"}
                </span>
                <small>{weightTrend(review)}</small>
              </p>
            ))}
          </div>
        </details>
      ) : null}

      <div className="review-change">
        <span>下次训练参考</span>
        {week.length === 0 ? (
          <>
            <strong>暂不新增动作</strong>
            <p>先补齐一轮推、拉、腿；空缺数据不当作训练短板，也不据此改动作。</p>
          </>
        ) : (
          <>
            <strong>动作结构不变，按最近一次可比训练调负荷</strong>
            <ul>
              {recommendations.map((recommendation) => (
                <li key={recommendation.text}>
                  {recommendation.text}
                  {recommendation.basis ? <span className="review-basis">{recommendation.basis}</span> : null}
                </li>
              ))}
            </ul>
            <p>
              {completeRound
                ? "增重幅度与训练预填一致：lb +5、kg +2.5。只有连续几周仍出现明确短板，才考虑替换或新增动作。"
                : "未练到的训练日不当作短板；先补齐完整一轮，再考虑替换或新增动作。"}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

// --- W4.3-D1: completion receipt (start page, non-blocking) ---
// Shown at the top of the start page after a workout finishes. Its
// recovery strategy after a page refresh is deliberate and narrow:
// the receipt exists only in App state, keyed by the exact workoutId
// this session's completeWorkout finished — a refresh drops the
// receipt entirely (the record itself stays in the history below),
// and nothing ever reconstructs a receipt from "the most recent
// record", which could silently be a different workout. Dismissing
// the receipt writes no business data.
function CompletionReceipt({ workoutId, onClose, onViewRecord }: {
  workoutId: number;
  onClose: () => void;
  onViewRecord: (workoutId: number) => void;
}) {
  // Read-back by id only (see receiptReadPhase): this query is the
  // sole source of every number the receipt shows.
  const query = useQuery({
    queryKey: ["workout-receipt", workoutId],
    queryFn: () => api.getDashboard({ recent_limit: 20, receipt_workout_id: workoutId }),
    retry: false,
  });
  const receipt = query.data?.receipt ?? null;
  const phase = receiptReadPhase({
    isPending: query.isPending,
    isError: query.isError,
    receiptFound: receipt != null,
  });

  if (phase === "reading") {
    return (
      <section className="receipt-card" aria-label="训练完成回执">
        <p className="receipt-status" role="status">训练已结束，正在读取记录…</p>
        <p className="receipt-note">组数以读回的已存记录为准。</p>
      </section>
    );
  }

  if (phase === "unavailable" || !receipt) {
    return (
      <section className="receipt-card" aria-label="训练完成回执">
        <p className="receipt-status" role="alert">记录暂未读出</p>
        <p className="receipt-note">训练已结束。重新读取只会再读一次这次记录，不会再次结束训练，也不会把记录恢复为进行中。</p>
        <div className="receipt-actions">
          <button
            type="button"
            className="receipt-primary"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            {query.isFetching ? "正在重新读取…" : "重新读取"}
          </button>
          <button type="button" onClick={onClose}>关闭回执</button>
        </div>
      </section>
    );
  }

  const workout = receipt;
  const lines = receiptExerciseLines(workout, query.data?.receipt_previous);
  const muscleFacts = muscleReceiptFacts(workout);
  const doneTotal = completedCount(workout);
  const totalSets = workout.sets.length;
  const incompleteTotal = totalSets - doneTotal;
  const completedAt = workout.completed_at ?? workout.started_at;
  return (
    <section className="receipt-card" aria-labelledby="receipt-title">
      <div className="receipt-head">
        <div>
          <p className="receipt-kicker">训练完成回执</p>
          <h2 id="receipt-title">{ROUTINE_META[workout.routine].title}训练</h2>
          <p className="receipt-dates">
            训练日 {formatDate(workout.started_at)} · 实际完成 {formatDate(completedAt)} {formatClock(completedAt)}
          </p>
        </div>
        <button type="button" className="receipt-close" aria-label="关闭回执" onClick={onClose}>关闭</button>
      </div>
      <p className="receipt-total">
        已完成 {doneTotal} / {totalSets} 组
        {incompleteTotal > 0 ? <span className="receipt-incomplete"> · {incompleteTotal} 组未完成</span> : null}
      </p>
      <ul className="receipt-lines">
        {lines.map((line) => (
          <li key={line.key}>
            <strong>{line.name}</strong>
            <span>
              本次 {line.completedSets}/{line.totalSets} 组
              {line.incompleteSets > 0 ? `（${line.incompleteSets} 组未完成）` : ""}
            </span>
            <span>
              {line.previous
                ? `上次 ${formatDate(line.previous.sourceDate)} · ${line.previous.completedSets}/${line.previous.totalSets} 组`
                : "暂无可比记录"}
            </span>
            <span className="receipt-suggestion">建议：{line.suggestion}</span>
          </li>
        ))}
      </ul>
      <div className="receipt-muscles">
        <h3>本次训练肌群事实</h3>
        {muscleFacts.primary.length === 0 && muscleFacts.secondary.length === 0 && muscleFacts.unmapped.length === 0 ? (
          <p className="receipt-muscles-empty">本次没有已完成组，暂无肌群事实。</p>
        ) : (
          <>
            {muscleFacts.primary.length > 0 ? (
              <ul className="receipt-muscle-list">
                {muscleFacts.primary.map((fact) => (
                  <li key={`primary-${fact.muscle}`}>
                    <span><span aria-hidden="true">●</span> 主要 · {fact.muscle}</span>
                    <span>{fact.sets} 组 · {fact.exercises.join("、")}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {muscleFacts.secondary.length > 0 ? (
              <ul className="receipt-muscle-list">
                {muscleFacts.secondary.map((fact) => (
                  <li key={`secondary-${fact.muscle}`}>
                    <span><span aria-hidden="true">○</span> 次要 · {fact.muscle}</span>
                    <span>{fact.sets} 组 · {fact.exercises.join("、")}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {muscleFacts.unmapped.length > 0 ? (
              <p className="receipt-muscles-unmapped">尚无映射：{muscleFacts.unmapped.join("、")}</p>
            ) : null}
          </>
        )}
        <p className="receipt-muscles-note">口径：只统计已完成组；同一动作可同时计入多个肌群（重复归属），各肌群组数不可相加为总容量。</p>
      </div>
      <div className="receipt-actions">
        <button type="button" className="receipt-primary" onClick={() => onViewRecord(workout.id)}>
          查看本次记录
        </button>
      </div>
    </section>
  );
}

function ExerciseGuideDialog({ guide, exerciseKey, onClose }: { guide: ExerciseGuide; exerciseKey: string; onClose: () => void }) {
  const muscleMapping = MUSCLE_MAP[exerciseKey];
  // 「练到哪里」 (primary/secondary muscle text + front/back diagram)
  // is secondary reference material: collapsed by default so the
  // demonstration and the cue points lead the dialog.
  const [musclesOpen, setMusclesOpen] = useState(false);
  const musclesPanelId = useId();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="guide-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="guide-dialog" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <div className="guide-topbar">
          <div>
            <p>动作要领</p>
            <h2 id="guide-title">{guide.title}</h2>
          </div>
          <button type="button" aria-label="关闭动作要领" onClick={onClose}>×</button>
        </div>
        <p className="guide-focus">{guide.focus}</p>
        {/* Order: demonstration first (real photo/video frames, or
            the teaching-video link when the guide has no frames),
            then the cue points; the muscle text + diagram live in
            the collapsed 「练到哪里」 section below. */}
        {guide.demo ? <ExerciseDemoView demo={guide.demo} name={guide.title} /> : null}
        {guide.video ? (
          <a className="video-link" href={guide.video} target="_blank" rel="noreferrer">
            <span aria-hidden="true">▶</span>
            <span><strong>看真人教学视频</strong><small>{guide.source} · 在 YouTube 打开</small></span>
            <i aria-hidden="true">↗</i>
          </a>
        ) : null}
        <div className="guide-section">
          <h3>起始位置</h3>
          <p>{guide.setup}</p>
        </div>
        <div className="guide-grid">
          <div>
            <h3>记住这三点</h3>
            <ol>{guide.cues.map((cue) => <li key={cue}>{cue}</li>)}</ol>
          </div>
          <div>
            <h3>常见错误</h3>
            <ul>{guide.mistakes.map((mistake) => <li key={mistake}>{mistake}</li>)}</ul>
          </div>
        </div>
        <div className="guide-section guide-muscles">
          <button
            type="button"
            className="guide-muscles-toggle"
            aria-expanded={musclesOpen}
            aria-controls={musclesPanelId}
            onClick={() => setMusclesOpen((open) => !open)}
          >
            <span>练到哪里</span>
            <span className="guide-muscles-toggle-state">{musclesOpen ? "收起 ▲" : "展开 ▼"}</span>
          </button>
          {musclesOpen ? (
            <div id={musclesPanelId} className="guide-muscles-body">
              {muscleMapping ? (
                <>
                  <p><span aria-hidden="true">●</span> 主要：{muscleMapping.primary.join("、")}</p>
                  <p><span aria-hidden="true">○</span> 次要：{muscleMapping.secondary.length > 0 ? muscleMapping.secondary.join("、") : "—"}</p>
                </>
              ) : (
                <p>尚无映射</p>
              )}
              {/* W6.2 muscle diagram: front/back outlines painted from
                  this same mapping only; renders 暂无肌群图 when the key
                  is unmapped or no muscle name resolves to a region. */}
              <MuscleDiagramView mapping={muscleMapping} />
            </div>
          ) : null}
        </div>
        <p className="guide-safety">动作疼痛时立即停止；视频用于学习动作，不替代现场教练或医疗建议。</p>
      </section>
    </div>
  );
}

// --- W-UI-001 / W0.1 / W0.2: per-set autosave state machine (pure) ---
// A set's draft is autosaved on blur / Enter / short debounce instead of
// only when the completed toggle is flipped. Status is explicit text
// (dirty / saving / saved / error), never colour alone. Saves carry a
// per-set increasing sequence number: only the latest issued save may
// move the status, so a slow earlier response arriving after a newer
// save cannot flip the row back to saved/error. A server refresh only
// adopts new values while the row is clean (saved); dirty / saving /
// error drafts are never overwritten by a refetch.
export type SetDraft = { weight: string; reps: string; completed: boolean };
export type SetSaveStatus = "saved" | "dirty" | "saving" | "error";
export type SetSaveMachine = {
  confirmed: SetDraft;
  draft: SetDraft;
  status: SetSaveStatus;
  seq: number;
  inflightSeq: number | null;
  inflightDraft: SetDraft | null;
};

export function setDraftFromSet(set: WorkoutSet): SetDraft {
  return {
    weight: set.weight == null ? "" : String(set.weight),
    reps: set.reps == null ? "" : String(set.reps),
    completed: set.completed,
  };
}

export function sameSetDraft(a: SetDraft, b: SetDraft): boolean {
  return a.weight === b.weight && a.reps === b.reps && a.completed === b.completed;
}

export function initSetSaveMachine(set: WorkoutSet): SetSaveMachine {
  const draft = setDraftFromSet(set);
  return { confirmed: draft, draft, status: "saved", seq: 0, inflightSeq: null, inflightDraft: null };
}

export function setSaveBlocked(machine: SetSaveMachine): boolean {
  return machine.draft.completed && machine.draft.reps.trim() === "";
}

export function editSetDraft(machine: SetSaveMachine, draft: SetDraft): SetSaveMachine {
  let status: SetSaveStatus;
  if (machine.inflightDraft) {
    // A write is in flight: only the exact in-flight payload reads as
    // saving. Anything else is dirty — including reverting to the old
    // confirmed values, which must never read as saved while the write
    // is still undecided.
    status = sameSetDraft(draft, machine.inflightDraft) ? "saving" : "dirty";
  } else if (sameSetDraft(draft, machine.confirmed)) {
    status = "saved";
  } else {
    status = "dirty";
  }
  return { ...machine, draft, status };
}

export type BeginSetSaveResult = { machine: SetSaveMachine; seq: number };

export function beginSetSave(machine: SetSaveMachine): BeginSetSaveResult | null {
  if (sameSetDraft(machine.draft, machine.confirmed)) return null;
  if (setSaveBlocked(machine)) return null;
  const seq = machine.seq + 1;
  return {
    machine: { ...machine, status: "saving", seq, inflightSeq: seq, inflightDraft: machine.draft },
    seq,
  };
}

export function applySetSaveSuccess(machine: SetSaveMachine, seq: number): SetSaveMachine {
  if (seq !== machine.seq || machine.inflightDraft == null) return machine;
  const confirmed = machine.inflightDraft;
  return {
    ...machine,
    confirmed,
    status: sameSetDraft(machine.draft, confirmed) ? "saved" : "dirty",
    inflightSeq: null,
    inflightDraft: null,
  };
}

export function applySetSaveFailure(machine: SetSaveMachine, seq: number): SetSaveMachine {
  if (seq !== machine.seq || machine.inflightDraft == null) return machine;
  const failedDraft = machine.inflightDraft;
  return {
    ...machine,
    status: sameSetDraft(machine.draft, failedDraft) ? "error" : "dirty",
    inflightSeq: null,
    inflightDraft: null,
  };
}

export function adoptServerDraft(machine: SetSaveMachine, serverDraft: SetDraft): SetSaveMachine {
  if (machine.status !== "saved") return machine;
  return { ...machine, confirmed: serverDraft, draft: serverDraft };
}

export function setSaveStatusLabel(status: SetSaveStatus): string {
  if (status === "dirty") return "未保存";
  if (status === "saving") return "保存中…";
  if (status === "error") return "保存失败";
  return "已保存";
}

export function hasUnsavedSetStatus(statuses: SetSaveStatus[]): boolean {
  return statuses.some((status) => status !== "saved");
}

// --- W-UI-001-D1: top save aggregate (pure) ---
// One line of text summarises every set's save state, kept separate
// from the completion count: a finished set is not a saved set.
// Priority is fixed: failed saves first (with a 查看 jump to the
// first abnormal set), then blocked (completed but missing reps —
// the same 需补次数 wording the card heads use) and dirty drafts,
// then an in-flight save, then the two busy states that must never
// read as 全部已保存 (a pending add the server has not confirmed
// yet, and a finish in progress). Only a fully clean registry earns
// 全部已保存.
export type SetSaveSnapshot = {
  id: number;
  exerciseKey: string;
  status: SetSaveStatus;
  blocked: boolean;
};

export type SaveAggregateKind = "error" | "blocked" | "dirty" | "saving" | "adding" | "finishing" | "saved";

export type SaveAggregate = {
  kind: SaveAggregateKind;
  label: string;
  errorCount: number;
  blockedCount: number;
  firstAbnormal: { exerciseKey: string; setId: number; blocked: boolean } | null;
};

export function aggregateSaveStates(
  snapshots: SetSaveSnapshot[],
  flags: { pendingAdds: number; finishing: boolean },
): SaveAggregate {
  const errors = snapshots.filter((snapshot) => snapshot.status === "error");
  const blockedList = snapshots.filter((snapshot) => snapshot.blocked);
  const dirtyList = snapshots.filter((snapshot) => snapshot.status === "dirty");
  const firstOf = (list: SetSaveSnapshot[]) => {
    const first = list[0];
    return first ? { exerciseKey: first.exerciseKey, setId: first.id, blocked: first.blocked } : null;
  };
  const counts = { errorCount: errors.length, blockedCount: blockedList.length };
  if (errors.length > 0) {
    return { ...counts, kind: "error", label: `有 ${errors.length} 组保存失败`, firstAbnormal: firstOf(errors) };
  }
  if (blockedList.length > 0) {
    return { ...counts, kind: "blocked", label: `有 ${blockedList.length} 组需补次数`, firstAbnormal: firstOf(blockedList) };
  }
  if (dirtyList.length > 0) {
    return { ...counts, kind: "dirty", label: "有未保存的修改", firstAbnormal: firstOf(dirtyList) };
  }
  if (snapshots.some((snapshot) => snapshot.status === "saving")) {
    return { ...counts, kind: "saving", label: "正在保存", firstAbnormal: null };
  }
  if (flags.finishing) {
    return { ...counts, kind: "finishing", label: "正在结束…", firstAbnormal: null };
  }
  if (flags.pendingAdds > 0) {
    return { ...counts, kind: "adding", label: "正在添加一组", firstAbnormal: null };
  }
  return { ...counts, kind: "saved", label: "全部已保存", firstAbnormal: null };
}

// --- W-UI-001-D1: current exercise selection (pure) ---
// The current exercise is the single expanded card and the rest
// timer's anchor. A manual card-head selection always wins while
// that exercise still exists; otherwise the first exercise with an
// unfinished set; when everything is complete the most recent (last)
// exercise stays current instead of collapsing the whole stack.
export type ExerciseProgressSummary = { key: string; hasIncomplete: boolean };

export function resolveCurrentExerciseKey(
  groups: ExerciseProgressSummary[],
  selectedKey: string | null,
): string | null {
  if (groups.length === 0) return null;
  if (selectedKey != null && groups.some((group) => group.key === selectedKey)) return selectedKey;
  const firstIncomplete = groups.find((group) => group.hasIncomplete);
  if (firstIncomplete) return firstIncomplete.key;
  const last = groups[groups.length - 1];
  return last ? last.key : null;
}

// --- W-UI-001-D1: keyboard next-field order (pure) ---
// Enter moves focus 重量 → 本组次数 → 下一组重量, crossing from an
// exercise's last set into the next exercise's first input. The very
// last input resolves to the finish button (keyboard dismissed, focus
// returned there); an unknown current field resolves to null.
export type FocusFieldRef = { exerciseKey: string; setId: number; field: "weight" | "reps" };
export type FocusTarget = { kind: "field"; target: FocusFieldRef } | { kind: "finish" };

export function buildFocusOrder(groups: { key: string; sets: { id: number }[] }[]): FocusFieldRef[] {
  const order: FocusFieldRef[] = [];
  for (const group of groups) {
    for (const set of group.sets) {
      order.push({ exerciseKey: group.key, setId: set.id, field: "weight" });
      order.push({ exerciseKey: group.key, setId: set.id, field: "reps" });
    }
  }
  return order;
}

export function nextFocusTarget(order: FocusFieldRef[], current: FocusFieldRef): FocusTarget | null {
  const index = order.findIndex(
    (item) => item.exerciseKey === current.exerciseKey && item.setId === current.setId && item.field === current.field,
  );
  if (index < 0) return null;
  const next = order[index + 1];
  if (!next) return { kind: "finish" };
  return { kind: "field", target: next };
}

export type SetSaveHandle = {
  id: number;
  getStatus: () => SetSaveStatus;
  flush: () => Promise<boolean>;
  isBlocked: () => boolean;
  isCompleted: () => boolean;
  seal: () => void;
  // W-FINISH-001: seal the queue (no new writes) AND wait for the
  // in-flight drain to fully settle — its success/failure applied to
  // the machine — before resolving. Resolves true only when the row
  // ends up clean (saved, unblocked, nothing in flight).
  sealAndSettle: () => Promise<boolean>;
  // Undo a seal (e.g. a finish attempt failed): the row becomes
  // editable and saveable again with its draft untouched.
  unseal: () => void;
};

// --- W-UI-001 rework: single-writer save queue per set ---
// drainSetSaves is the only loop that issues writes for a set. Each
// successful save re-reads the latest machine; if the draft moved on
// while the write was in flight, the loop saves the newest draft (the
// intermediate values are coalesced — only the latest full payload is
// sent) until the row is clean, blocked, or a save fails. The business
// result is checked, not just transport success: a resolved response
// with ok !== true (e.g. { ok: false, forbidden: true }) takes the
// same failure path as a thrown error — input kept, status error /
// dirty, retryable, never marked saved. Once sealed, the drain issues
// no new writes.
export type SetSaveEnv = {
  getMachine: () => SetSaveMachine;
  setMachine: (machine: SetSaveMachine) => void;
  send: (draft: SetDraft) => Promise<{ ok: boolean }>;
  isSealed: () => boolean;
  onSaved: () => void;
};

export async function drainSetSaves(env: SetSaveEnv): Promise<boolean> {
  for (;;) {
    if (env.isSealed()) return false;
    const begun = beginSetSave(env.getMachine());
    if (!begun) {
      const machine = env.getMachine();
      return machine.status === "saved" && !setSaveBlocked(machine) && machine.inflightDraft == null;
    }
    env.setMachine(begun.machine);
    const payload = begun.machine.inflightDraft;
    if (!payload) return false;
    let result: { ok: boolean };
    try {
      result = await env.send(payload);
    } catch {
      env.setMachine(applySetSaveFailure(env.getMachine(), begun.seq));
      return false;
    }
    if (!result || result.ok !== true) {
      env.setMachine(applySetSaveFailure(env.getMachine(), begun.seq));
      return false;
    }
    env.setMachine(applySetSaveSuccess(env.getMachine(), begun.seq));
    env.onSaved();
  }
}

// createSaveQueue funnels every save request for one set through a
// single shared drain: concurrent requestSave / flush callers join the
// same in-flight promise instead of each issuing their own write after
// waiting, so at most one write per set is ever in flight.
export type SetSaveQueue = {
  requestSave: () => Promise<boolean>;
  flush: () => Promise<boolean>;
  // W-FINISH-001: join the in-flight drain (if any) and resolve with
  // the machine's settled state. Never starts a new write: with no
  // drain running it reports purely from the current machine state.
  settle: () => Promise<boolean>;
};

export function createSaveQueue(env: SetSaveEnv): SetSaveQueue {
  let running: Promise<boolean> | null = null;
  const start = (): Promise<boolean> => {
    if (env.isSealed()) return Promise.resolve(false);
    if (running) return running;
    const run = drainSetSaves(env);
    running = run;
    const clear = () => {
      if (running === run) running = null;
    };
    void run.then(clear, clear);
    return run;
  };
  const settledClean = (): boolean => {
    const machine = env.getMachine();
    return machine.status === "saved" && !setSaveBlocked(machine) && machine.inflightDraft == null;
  };
  const settle = async (): Promise<boolean> => {
    if (running) {
      // Wait for the drain to finish applying its outcome to the
      // machine, then judge cleanliness from that settled state — the
      // drain itself may report false simply because the queue was
      // sealed mid-flight even though the write landed.
      await running;
    }
    return settledClean();
  };
  return { requestSave: start, flush: start, settle };
}

// --- W-FINISH-001: finish flush over a consistent handle set ---
// Collect the registered set handles, flush them, then re-read the
// registry: if the set changed while flushing (e.g. an add-set request
// landed mid-flush and registered a brand-new row), flush the new set
// again. Only a round whose handle set is identical before and after
// its flush is a stable batch whose results may feed the finish gate;
// an unstable batch must be treated as unsaved, never completed on.
export type FlushAllHandlesResult = {
  handles: SetSaveHandle[];
  results: boolean[];
  stable: boolean;
};

export async function flushAllHandles(
  getHandles: () => SetSaveHandle[],
  maxRounds = 3,
): Promise<FlushAllHandlesResult> {
  let lastHandles: SetSaveHandle[] = [];
  let lastResults: boolean[] = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const handles = getHandles();
    const results = await Promise.all(handles.map((handle) => handle.flush().catch(() => false)));
    lastHandles = handles;
    lastResults = results;
    const afterIds = getHandles().map((handle) => handle.id);
    const stable = handles.length === afterIds.length
      && handles.every((handle, index) => handle.id === afterIds[index]);
    if (stable) return { handles, results, stable: true };
  }
  return { handles: lastHandles, results: lastResults, stable: false };
}

// --- W-FINISH-001 (stable seal boundary): the confirmed-finish twin
// of flushAllHandles. Seal-and-settle the current registry, then
// re-read it: a handle registered mid-round (e.g. an add-set landing
// while earlier queues settled) must itself be sealed and settled
// before complete is sent, so repeat until one full round ends with
// the registry identical to the round's start. Only then is the batch
// stable; exhausting the rounds reports stable: false and the caller
// must abort the finish (unseal everything) rather than complete over
// unchecked sets.
export type SealAllAndSettleStableResult = {
  handles: SetSaveHandle[];
  results: boolean[];
  stable: boolean;
};

export async function sealAllAndSettleStable(
  getHandles: () => SetSaveHandle[],
  maxRounds = 5,
): Promise<SealAllAndSettleStableResult> {
  let lastHandles: SetSaveHandle[] = [];
  let lastResults: boolean[] = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const handles = getHandles();
    const results = await Promise.all(handles.map((handle) => handle.sealAndSettle().catch(() => false)));
    lastHandles = handles;
    lastResults = results;
    const afterIds = getHandles().map((handle) => handle.id);
    const stable = handles.length === afterIds.length
      && handles.every((handle, index) => handle.id === afterIds[index]);
    if (stable) return { handles, results, stable: true };
  }
  return { handles: lastHandles, results: lastResults, stable: false };
}

// --- W-FINISH-001 (in-flight addSet joins the finish boundary) ---
// "+ 加一组" clicks register their mutateAsync promise — a chain
// that only settles after the add landed AND the dashboard
// invalidation/refetch completed — into a registry shared at the
// ActiveWorkout level. Before any finish path may flush or seal, it
// joins the registry until it is empty AND stable: await the current
// batch, re-read (a settle may have surfaced a further registration),
// and when a read comes back empty, yield one macrotask and confirm
// it is STILL empty — an add issued in the same tick as the finish
// press registers during that yield and is then awaited like any
// other. A rejected add is a finish failure, never a silent success:
// { ok: false }. Exhausting the rounds with a registry that never
// empties reports { ok: false, stable: false } so the caller aborts
// the finish instead of completing over an unchecked new set.
export type SettlePendingAddsResult = { ok: boolean; stable: boolean };

export async function settlePendingAdds(
  getPending: () => Promise<unknown>[],
  maxRounds = 10,
): Promise<SettlePendingAddsResult> {
  for (let round = 0; round < maxRounds; round += 1) {
    const pending = getPending();
    if (pending.length > 0) {
      try {
        await Promise.all(pending);
      } catch {
        return { ok: false, stable: true };
      }
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (getPending().length === 0) return { ok: true, stable: true };
  }
  return getPending().length === 0
    ? { ok: true, stable: true }
    : { ok: false, stable: false };
}

// --- W-FINISH-001 (registration barrier): the finish paths must not
// judge completion from the handle registry until every set of the
// FINAL dashboard data version has a registered SetRow handle. A
// landed addSet refreshes the dashboard data first, but React still
// has to commit and the new SetRow's effect has to register its
// handle; settlePendingAdds resolving (or an invalidateQueries
// resolving) proves neither. This barrier polls the registry until
// every expected set id is present: { ok: true } only then. If the
// rounds run out first it reports exactly which ids never registered
// ({ ok: false, missing }) and the caller aborts the finish — drafts
// stay editable — instead of completing over a set nobody checked.
// A single setTimeout(0) or one registry read is NOT a substitute:
// registration may lag several commits behind the data.
export type WaitForSetRegistrationResult = { ok: boolean; missing: number[] };

export async function waitForExpectedSetRegistration(
  getRegisteredIds: () => Iterable<number>,
  expectedIds: number[],
  maxRounds = 40,
  delayMs = 50,
): Promise<WaitForSetRegistrationResult> {
  const missingNow = (): number[] => {
    const registered = new Set(getRegisteredIds());
    return expectedIds.filter((id) => !registered.has(id));
  };
  let missing = missingNow();
  for (let round = 0; round < maxRounds && missing.length > 0; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    missing = missingNow();
  }
  return missing.length === 0 ? { ok: true, missing: [] } : { ok: false, missing };
}

// --- W-UI-001 rework: finish gate ---
// Finish proceeds only when every set flushed clean, is saved, is not
// blocked (completed without reps), and is completed. Otherwise the
// reason is picked by priority: unsaved > blocked > incomplete.
export type FinishGateSnapshot = {
  flushOk: boolean;
  status: SetSaveStatus;
  blocked: boolean;
  completed: boolean;
};
export type FinishGateReason = "unsaved" | "blocked" | "incomplete";
export type FinishGateDecision = { proceed: boolean; reason: FinishGateReason | null };

export function finishGateDecision(snapshots: FinishGateSnapshot[]): FinishGateDecision {
  const allClean = snapshots.every(
    (snapshot) => snapshot.flushOk && snapshot.status === "saved" && !snapshot.blocked && snapshot.completed,
  );
  if (allClean) return { proceed: true, reason: null };
  if (snapshots.some((snapshot) => !snapshot.flushOk || snapshot.status !== "saved")) {
    return { proceed: false, reason: "unsaved" };
  }
  if (snapshots.some((snapshot) => snapshot.blocked)) {
    return { proceed: false, reason: "blocked" };
  }
  return { proceed: false, reason: "incomplete" };
}

export type RestTimerState = {
  endsAt: number | null;
  durationSec: number;
  muted: boolean;
  done: boolean;
  // W-TIMER-001: per-workout opt-out for auto-starting the rest timer on
  // a completed set. In-memory only — never persisted anywhere.
  autoEnabled: boolean;
};

export const REST_DURATIONS = [60, 90, 120];
export const DEFAULT_REST_SEC = 90;

export function initRestTimer(durationSec: number = DEFAULT_REST_SEC): RestTimerState {
  return {
    endsAt: null,
    durationSec: REST_DURATIONS.includes(durationSec) ? durationSec : DEFAULT_REST_SEC,
    muted: false,
    done: false,
    autoEnabled: true,
  };
}

// Flips only the auto-start switch: an in-progress countdown keeps its
// endsAt, and turning auto back on does not start a timer by itself —
// the next completed set does.
export function toggleRestAuto(state: RestTimerState): RestTimerState {
  return { ...state, autoEnabled: !state.autoEnabled };
}

export function shouldAutoStartRest(state: RestTimerState): boolean {
  return state.autoEnabled;
}

export function startRestTimer(state: RestTimerState, nowMs: number): RestTimerState {
  return { ...state, endsAt: nowMs + state.durationSec * 1000, done: false };
}

export function restRemainingSec(state: RestTimerState, nowMs: number): number | null {
  if (state.endsAt == null) return null;
  return Math.max(0, Math.ceil((state.endsAt - nowMs) / 1000));
}

export function restTimerDone(state: RestTimerState, nowMs: number): boolean {
  return state.endsAt != null && nowMs >= state.endsAt;
}

export function addRestTime(state: RestTimerState, seconds: number, nowMs: number): RestTimerState {
  if (state.endsAt == null) return state;
  if (nowMs >= state.endsAt) return { ...state, endsAt: nowMs + seconds * 1000, done: false };
  return { ...state, endsAt: state.endsAt + seconds * 1000 };
}

export function skipRestTimer(state: RestTimerState): RestTimerState {
  return { ...state, endsAt: null, done: false };
}

export function setRestDuration(state: RestTimerState, seconds: number): RestTimerState {
  if (!REST_DURATIONS.includes(seconds)) return state;
  return { ...state, durationSec: seconds };
}

export function toggleRestMuted(state: RestTimerState): RestTimerState {
  return { ...state, muted: !state.muted };
}

export function restTimerLabel(state: RestTimerState, nowMs: number): string {
  if (state.endsAt == null) return "";
  if (restTimerDone(state, nowMs)) return "休息结束";
  const remaining = restRemainingSec(state, nowMs) ?? 0;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function playRestBeep() {
  try {
    const AudioCtor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    const context = new AudioCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.22, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.45);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.5);
    oscillator.onended = () => {
      void context.close();
    };
  } catch {
    // Audio is a nicety only; the on-screen 休息结束 state still shows.
  }
}

function SetRow({ set, unit, locked, onSaved, onRegister, onCompleted, onEnterNext }: {
  set: WorkoutSet;
  unit: Unit;
  // W-FINISH-001: while a finish flow owns the workout, entry is
  // locked — inputs, the completion toggle and retry are disabled so
  // no new edit can start behind the seal.
  locked: boolean;
  onSaved: () => void;
  onRegister: (id: number, handle: SetSaveHandle | null) => void;
  onCompleted?: () => void;
  // W-UI-001-D1: after Enter's normal blur-save, the owner moves
  // focus to the next field (see buildFocusOrder / nextFocusTarget).
  onEnterNext?: (field: "weight" | "reps") => void;
}) {
  const [machine, setMachineState] = useState<SetSaveMachine>(() => initSetSaveMachine(set));
  const machineRef = useRef(machine);
  const timerRef = useRef<number | null>(null);
  const sealedRef = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const setMachine = (next: SetSaveMachine) => {
    machineRef.current = next;
    setMachineState(next);
  };

  // All saves for this set go through one queue: at most one updateSet
  // in flight, concurrent callers share the same drain promise.
  const [saveQueue] = useState<SetSaveQueue>(() => createSaveQueue({
    getMachine: () => machineRef.current,
    setMachine: (next) => {
      machineRef.current = next;
      setMachineState(next);
    },
    send: async (payload: SetDraft) => await api.updateSet({
      id: set.id,
      weight: payload.weight.trim() === "" ? null : Number(payload.weight),
      reps: payload.reps.trim() === "" ? null : Number(payload.reps),
      completed: payload.completed,
    }),
    isSealed: () => sealedRef.current,
    onSaved: () => onSavedRef.current(),
  }));

  useEffect(() => {
    setMachine(adoptServerDraft(machineRef.current, setDraftFromSet(set)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set.id, set.weight, set.reps, set.completed]);

  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    onRegister(set.id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set.id]);

  function requestSave(): Promise<boolean> {
    return saveQueue.requestSave();
  }

  async function flushSave(): Promise<boolean> {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    const ok = await saveQueue.flush();
    const current = machineRef.current;
    return ok && current.status === "saved" && !setSaveBlocked(current) && current.inflightDraft == null;
  }

  useEffect(() => {
    onRegister(set.id, {
      id: set.id,
      getStatus: () => machineRef.current.status,
      flush: flushSave,
      isBlocked: () => setSaveBlocked(machineRef.current),
      isCompleted: () => machineRef.current.draft.completed,
      seal: () => {
        sealedRef.current = true;
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
      },
      sealAndSettle: async () => {
        sealedRef.current = true;
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
        return saveQueue.settle();
      },
      unseal: () => {
        sealedRef.current = false;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set.id, machine]);

  function scheduleDebounce() {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { void requestSave(); }, 800);
  }

  function editDraft(draft: SetDraft, immediate: boolean) {
    setMachine(editSetDraft(machineRef.current, draft));
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    if (immediate) void requestSave();
    else scheduleDebounce();
  }

  function numericChange(event: ChangeEvent<HTMLInputElement>, field: "weight" | "reps") {
    const draft = { ...machineRef.current.draft, [field]: event.target.value };
    editDraft(draft, false);
  }

  function onBlurSave() {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    void requestSave();
  }

  function onEnterSave(event: ReactKeyboardEvent<HTMLInputElement>, field: "weight" | "reps") {
    if (event.key === "Enter") {
      event.preventDefault();
      // Blur first: the blur handler runs the normal save path.
      // Enter never toggles completion — it only moves focus on,
      // and an unfilled field may simply stay empty.
      event.currentTarget.blur();
      onEnterNext?.(field);
    }
  }

  function toggleCompleted() {
    const next = { ...machineRef.current.draft, completed: !machineRef.current.draft.completed };
    editDraft(next, true);
    // Only a fresh completion that is not blocked by 先填次数 starts the
    // rest timer; un-completing a set never does.
    if (next.completed && !setSaveBlocked({ ...machineRef.current, draft: next })) onCompleted?.();
  }

  const { draft, status } = machine;
  const blocked = setSaveBlocked(machine);

  return (
    <div className={`set-row ${draft.completed ? "is-complete" : ""}`}>
      <span className="set-index" aria-label={`第 ${set.set_number} 组`}>{set.set_number}</span>
      <label className="field-wrap">
        <span className="sr-only">第 {set.set_number} 组重量（{unit}）</span>
        <input
          aria-label={`${set.exercise_name} 第 ${set.set_number} 组重量，单位 ${unit}`}
          data-focus-set={set.id}
          data-focus-field="weight"
          inputMode="decimal"
          type="number"
          min="0"
          step="0.5"
          value={draft.weight}
          disabled={locked}
          onChange={(event) => numericChange(event, "weight")}
          onBlur={onBlurSave}
          onKeyDown={(event) => onEnterSave(event, "weight")}
          placeholder="—"
        />
        <small>{unit}</small>
      </label>
      <label className="field-wrap">
        <span className="sr-only">第 {set.set_number} 组次数</span>
        <input
          aria-label={`${set.exercise_name} 第 ${set.set_number} 组次数`}
          data-focus-set={set.id}
          data-focus-field="reps"
          inputMode="numeric"
          type="number"
          min="0"
          step="1"
          value={draft.reps}
          disabled={locked}
          onChange={(event) => numericChange(event, "reps")}
          onBlur={onBlurSave}
          onKeyDown={(event) => onEnterSave(event, "reps")}
          placeholder={set.target_reps}
        />
        <small>次</small>
      </label>
      <button
        className="set-check"
        type="button"
        aria-label={draft.completed ? `${set.exercise_name} 第 ${set.set_number} 组取消完成` : `${set.exercise_name} 第 ${set.set_number} 组完成`}
        aria-pressed={draft.completed}
        disabled={locked}
        onClick={toggleCompleted}
      >
        {draft.completed ? "✓" : ""}
      </button>
      <div className="set-status" data-status={status} role="status">
        <span>{blocked ? "先填次数" : setSaveStatusLabel(status)}</span>
        {status === "error" ? (
          <button type="button" className="set-retry" disabled={locked} onClick={() => void requestSave()}>重试</button>
        ) : null}
      </div>
    </div>
  );
}

// W1.3: the "上次" mark for an exercise — the latest completed set's
// weight/reps, with the weight already converted into the active
// workout's unit when the source workout used the other unit.
export type PreviousMark = { weight: number | null; reps: number | null; converted: boolean };

// W-UI-001-D1: what a collapsed card head still shows — the
// exercise's own completion count plus its worst save state as text
// (never colour alone), using the same wording as the top aggregate.
export type ExerciseHeadInfo = {
  doneCount: number;
  statusText: string | null;
  statusKind: "error" | "blocked" | "dirty" | "saving" | null;
};

function ExerciseBlock({ workout, exercise, previous, timerSlot, entryLocked, expanded, headInfo, onSelect, onChanged, onSetCompleted, onOpenGuide, onRegisterSet, onRegisterPendingAdd, onEnterNextSet }: {
  workout: Workout;
  exercise: ReturnType<typeof groupSets>[number];
  previous?: PreviousMark;
  // W-TIMER-001: the rest-timer UI (auto toggle + panel) injected by
  // ActiveWorkout into the current exercise's block only. Purely an
  // extra child node — SetRow mounting/registration is untouched.
  timerSlot?: ReactNode;
  // W-FINISH-001: entry lock while a finish flow owns the workout —
  // set rows render disabled and no new set can be added.
  entryLocked: boolean;
  // W-UI-001-D1: only the current exercise is expanded. Collapsing
  // hides the body with `hidden` — SetRows stay mounted and their
  // save handles stay registered, so an in-flight draft survives a
  // card switch untouched.
  expanded: boolean;
  headInfo: ExerciseHeadInfo;
  onSelect: () => void;
  onChanged: () => void;
  onSetCompleted: () => void;
  onOpenGuide: (guide: ExerciseGuide, key: string) => void;
  onRegisterSet: (id: number, handle: SetSaveHandle | null) => void;
  // W-FINISH-001: an in-flight add registers its promise (which only
  // settles after the dashboard invalidation/refetch completes) into
  // ActiveWorkout's shared pending-add registry, so a finish flow
  // joins it before flushing or sealing anything.
  onRegisterPendingAdd: (promise: Promise<unknown>) => void;
  onEnterNextSet: (setId: number, field: "weight" | "reps") => void;
}) {
  const queryClient = useQueryClient();
  const addSet = useMutation({
    mutationFn: () => api.addSet({ workout_id: workout.id, exercise_key: exercise.key }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      onChanged();
    },
  });
  const guide = EXERCISE_GUIDES[exercise.key];

  // The promise is registered synchronously in the click, before any
  // later finish press can run, and unregistered by the registry
  // owner when it settles.
  function handleAddSet() {
    let promise: Promise<unknown>;
    try {
      promise = addSet.mutateAsync();
    } catch (error) {
      promise = Promise.reject(error);
    }
    onRegisterPendingAdd(promise);
    void promise.catch(() => {});
  }

  return (
    <section className="exercise-block" aria-labelledby={`exercise-${exercise.key}`}>
      <div className="exercise-heading">
        <button
          type="button"
          className="exercise-select"
          aria-expanded={expanded}
          aria-label={`${exercise.name}，已完成 ${headInfo.doneCount}/${exercise.sets.length} 组${headInfo.statusText ? `，${headInfo.statusText}` : ""}，${expanded ? "已展开" : "已折叠，点击展开"}`}
          onClick={onSelect}
        >
          <span className="exercise-title-line">
            <span className="exercise-name" id={`exercise-${exercise.key}`}>{exercise.name}</span>
            <span className="exercise-chevron" aria-hidden="true">{expanded ? "收起 ▴" : "展开 ▾"}</span>
          </span>
          <span className="exercise-meta-line">
            <span>{headInfo.doneCount}/{exercise.sets.length} 组完成 · 每组 {exercise.target} 次</span>
            {previous && exercise.sets.some((set) => set.weight != null || set.reps != null) ? (
              <span className="prefill-note">{workout.prefill_unit_converted ? "已按上次表现预填（含单位换算）" : "已按上次表现预填"}</span>
            ) : null}
            {headInfo.statusText ? (
              <span className="exercise-head-status" data-kind={headInfo.statusKind ?? undefined}>{headInfo.statusText}</span>
            ) : null}
          </span>
        </button>
        <div className="exercise-side">
          {guide ? (
            <button
              className="guide-trigger"
              type="button"
              aria-label={`查看${exercise.name}动作要领`}
              onClick={() => onOpenGuide(guide, exercise.key)}
            >要领</button>
          ) : null}
          {previous && previous.weight != null ? (
            <span className="previous-mark">上次 {previous.weight}{workout.unit} × {previous.reps ?? "—"}{previous.converted ? "（已换算）" : ""}</span>
          ) : null}
        </div>
      </div>
      <div className="exercise-body" hidden={!expanded}>
        <div className="set-columns" aria-hidden="true">
          <span>组</span><span>重量</span><span>次数</span><span>完成</span>
        </div>
        <div className="set-list">
          {exercise.sets.map((set) => (
            <SetRow
              key={set.id}
              set={set}
              unit={workout.unit}
              locked={entryLocked}
              onSaved={onChanged}
              onRegister={onRegisterSet}
              onCompleted={onSetCompleted}
              onEnterNext={(field) => onEnterNextSet(set.id, field)}
            />
          ))}
        </div>
        <button className="add-set" type="button" onClick={handleAddSet} disabled={addSet.isPending || entryLocked}>
          {addSet.isPending ? "添加中…" : "+ 加一组"}
        </button>
        {timerSlot}
      </div>
    </section>
  );
}

function RestTimerPanel({ timer, nowMs, onChange }: {
  timer: RestTimerState;
  nowMs: number;
  onChange: (updater: (state: RestTimerState) => RestTimerState) => void;
}) {
  const done = restTimerDone(timer, nowMs);
  return (
    <section className={`rest-timer${done ? " is-done" : ""}`} aria-label="休息计时器">
      <div className="rest-timer-head">
        <span className="rest-timer-caption">{done ? "休息结束" : "组间休息"}</span>
        <strong className="rest-timer-time" role="timer">{restTimerLabel(timer, nowMs)}</strong>
      </div>
      <div className="rest-timer-controls">
        <div className="rest-timer-durations" role="group" aria-label="休息时长（下一次启动生效）">
          {REST_DURATIONS.map((seconds) => (
            <button
              key={seconds}
              type="button"
              aria-pressed={timer.durationSec === seconds}
              onClick={() => onChange((state) => setRestDuration(state, seconds))}
            >
              {seconds} 秒
            </button>
          ))}
        </div>
        <button type="button" onClick={() => onChange((state) => addRestTime(state, 30, Date.now()))}>+30秒</button>
        <button
          type="button"
          aria-pressed={timer.muted}
          onClick={() => onChange((state) => toggleRestMuted(state))}
        >
          {timer.muted ? "已静音" : "静音"}
        </button>
        <button type="button" onClick={() => onChange((state) => skipRestTimer(state))}>跳过</button>
      </div>
      <p className="rest-timer-note">本次自动休息计时：{timer.autoEnabled ? "开" : "关"} · 刷新页面后计时器会重置</p>
    </section>
  );
}

// W-TIMER-001: the always-visible per-workout auto-timer switch. Local
// UI state only — no server write, no localStorage, no set is touched.
function RestAutoToggle({ timer, onChange }: {
  timer: RestTimerState;
  onChange: (updater: (state: RestTimerState) => RestTimerState) => void;
}) {
  return (
    <button
      type="button"
      className="rest-auto-toggle"
      aria-pressed={timer.autoEnabled}
      onClick={() => onChange((state) => toggleRestAuto(state))}
    >
      本次自动休息计时：{timer.autoEnabled ? "开" : "关"}
    </button>
  );
}

function ActiveWorkout({ workout, recent, weekSummaries, onCompleted }: {
  workout: Workout;
  recent: Workout[];
  weekSummaries?: readonly WeekSummary[] | null;
  // W4.3-D1: fired once with this workout's id when completeWorkout
  // has genuinely succeeded, so App can show the completion receipt
  // for exactly this record on the start page.
  onCompleted: (workoutId: number) => void;
}) {
  const queryClient = useQueryClient();
  const [, setClock] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [finishBlock, setFinishBlock] = useState<FinishGateReason | null>(null);
  const [finishFailed, setFinishFailed] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [unsavedPresent, setUnsavedPresent] = useState(false);
  const [selectedGuide, setSelectedGuide] = useState<{ guide: ExerciseGuide; key: string } | null>(null);
  // W-UI-001-D1: the exercise the user picked by tapping a card
  // head. Null = no manual choice yet, so the first incomplete
  // exercise is current. Once set it changes only on another
  // card-head tap, a 查看 jump, or Enter-focus crossing into the
  // next exercise — never on a save callback or a timer tick.
  const [selectedExerciseKey, setSelectedExerciseKey] = useState<string | null>(null);
  // W-UI-001-D1: live per-set save state mirrored out of the handle
  // registry on every registration/status change, so the top save
  // aggregate and the card heads re-render with each row's status.
  const [handleStates, setHandleStates] = useState<ReadonlyMap<number, { status: SetSaveStatus; blocked: boolean; completed: boolean }>>(new Map());
  const [pendingAddCount, setPendingAddCount] = useState(0);
  const finishButtonRef = useRef<HTMLButtonElement | null>(null);
  const preFinishFocusRef = useRef<HTMLElement | null>(null);
  // Rest timer lives only in this component's memory: no server writes, no
  // localStorage, so a page refresh resets it (workout data itself is still
  // covered by the per-set autosave).
  const [restTimer, setRestTimer] = useState<RestTimerState>(() => initRestTimer());
  const [restNow, setRestNow] = useState(() => Date.now());

  const handleSetCompleted = useCallback(() => {
    // W-TIMER-001: with auto off, completing a set neither starts nor
    // restarts the timer (an already-running countdown is untouched);
    // with auto on this behaves exactly as before.
    setRestTimer((state) => (shouldAutoStartRest(state) ? startRestTimer(state, Date.now()) : state));
  }, []);

  const updateRestTimer = useCallback((updater: (state: RestTimerState) => RestTimerState) => {
    setRestTimer(updater);
  }, []);

  // The interval only triggers re-renders; the remaining time is always
  // derived from endsAt and Date.now(), so backgrounding stays accurate.
  useEffect(() => {
    if (restTimer.endsAt == null) return undefined;
    setRestNow(Date.now());
    const tick = window.setInterval(() => setRestNow(Date.now()), 300);
    return () => window.clearInterval(tick);
  }, [restTimer.endsAt]);

  // Beep exactly once when the countdown reaches zero (unless muted), and
  // mark done so the 休息结束 state stays until skip or the next set.
  useEffect(() => {
    if (restTimer.endsAt == null || restTimer.done) return;
    if (!restTimerDone(restTimer, restNow)) return;
    if (!restTimer.muted) playRestBeep();
    setRestTimer((state) => (state.done ? state : { ...state, done: true }));
  }, [restTimer, restNow]);

  const setHandlesRef = useRef(new Map<number, SetSaveHandle>());

  // W-FINISH-001: shared pending-add registry. Every "+ 加一组"
  // click registers its mutateAsync promise here (the promise only
  // settles after the add landed and the dashboard refetch
  // completed, which is also what mounts the new SetRow and
  // registers its save handle); the entry is removed on settle.
  // Both finish paths join this registry via settlePendingAdds
  // before flushing or sealing anything.
  const pendingAddsRef = useRef(new Set<Promise<unknown>>());
  const registerPendingAdd = useCallback((promise: Promise<unknown>) => {
    pendingAddsRef.current.add(promise);
    // W-UI-001-D1: the pending-add count is rendered state too — the
    // top aggregate shows 正在添加一组 until the add is confirmed
    // and the new set has entered the current data version.
    setPendingAddCount(pendingAddsRef.current.size);
    const unregister = () => {
      pendingAddsRef.current.delete(promise);
      setPendingAddCount(pendingAddsRef.current.size);
    };
    void promise.then(unregister, unregister);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock((value) => value + 1), 30000);
    return () => window.clearInterval(timer);
  }, []);

  // W0.2: warn on page leave while any set is dirty / saving / error.
  useEffect(() => {
    if (!unsavedPresent) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsavedPresent]);

  const refreshHandleStates = () => {
    const next = new Map<number, { status: SetSaveStatus; blocked: boolean; completed: boolean }>();
    for (const handle of setHandlesRef.current.values()) {
      next.set(handle.id, { status: handle.getStatus(), blocked: handle.isBlocked(), completed: handle.isCompleted() });
    }
    setHandleStates(next);
    setUnsavedPresent(hasUnsavedSetStatus([...next.values()].map((entry) => entry.status)));
  };

  const registerSet = (id: number, handle: SetSaveHandle | null) => {
    if (handle) setHandlesRef.current.set(id, handle);
    else setHandlesRef.current.delete(id);
    refreshHandleStates();
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  const complete = useMutation({
    mutationFn: () => api.completeWorkout({ workout_id: workout.id }),
    onSuccess: refresh,
  });

  // W-FINISH-001: a finish attempt only counts when the complete
  // request resolves with ok === true — a business refusal
  // ({ ok: false }) is a failure just like a thrown error. On failure
  // every set is unsealed so all drafts stay editable and saveable,
  // and the failure is surfaced in words.
  async function runComplete(): Promise<boolean> {
    let result: { ok: boolean } | null = null;
    try {
      result = await complete.mutateAsync();
    } catch {
      result = null;
    }
    if (result && result.ok === true) {
      onCompleted(workout.id);
      return true;
    }
    for (const handle of setHandlesRef.current.values()) handle.unseal();
    setFinishFailed(true);
    return false;
  }

  // W-FINISH-001 registration barrier, shared by both finish paths:
  // after the pending adds settle, re-fetch the LATEST dashboard,
  // take the current workout's full set-id list from THAT data as
  // the expected collection, and wait until the handle registry
  // covers every one of those ids. A dashboard refetch returning is
  // not registration: React may not have committed the new SetRow
  // (and its effect may not have registered the handle) yet, and
  // judging from the stale registry would silently skip a landed
  // add's unfinished set. Returns false when the fetch fails or any
  // expected set never registers — the caller then aborts the
  // finish (failure shown, entry unlocked, drafts kept) and never
  // calls complete.
  async function awaitFinalSetRegistration(): Promise<boolean> {
    let latest: Dashboard;
    try {
      latest = await queryClient.fetchQuery({
        queryKey: ["dashboard"],
        queryFn: () => api.getDashboard({ recent_limit: 20 }),
      });
    } catch {
      return false;
    }
    const current = latest.active_workout;
    const expectedIds = (current && current.id === workout.id ? current.sets : workout.sets).map((set) => set.id);
    const registration = await waitForExpectedSetRegistration(
      () => setHandlesRef.current.keys(),
      expectedIds,
    );
    return registration.ok;
  }

  // W-UI-001 finish gate + W-FINISH-001: flush every set over a
  // consistent handle set (flushAllHandles re-reads the registry and
  // re-flushes if the set changed mid-flush; an unstable batch counts
  // as unsaved), then let finishGateDecision consume the full result
  // of that same stable batch. Entry is locked from the moment the
  // finish flow starts (`finishing`) and stays locked until it ends.
  // Only a fully clean batch finishes directly — and then only after
  // sealing that exact batch, so no queued write can land after the
  // workout completes; anything else shows the confirmation for its
  // reason, because finishing would lose edits or skip sets.
  async function handleFinish() {
    // W-UI-001-D1: remember where focus was so cancelling the
    // finish confirmation can restore the exact pre-finish state.
    preFinishFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFinishFailed(false);
    setFinishing(true);
    try {
      // W-FINISH-001: join in-flight adds first, while the finishing
      // entry lock is held. A failed add aborts the finish outright
      // (failure shown, entry unlocked by the finally below, no
      // complete attempted); a landed add has already refreshed the
      // dashboard, so its new SetRow is registered in the handle
      // registry and the flush/gate below judges the FINAL set
      // collection.
      const adds = await settlePendingAdds(() => [...pendingAddsRef.current]);
      if (!adds.ok) {
        setFinishFailed(true);
        return;
      }
      // Registration barrier: only once the registry provably covers
      // every set of the latest dashboard version may the flush/gate
      // below judge the final collection.
      const registered = await awaitFinalSetRegistration();
      if (!registered) {
        setFinishFailed(true);
        return;
      }
      const { handles, results, stable } = await flushAllHandles(() => [...setHandlesRef.current.values()]);
      const snapshots = handles.map((handle, index) => ({
        flushOk: stable && (results[index] ?? false),
        status: handle.getStatus(),
        blocked: handle.isBlocked(),
        completed: handle.isCompleted(),
      }));
      refreshHandleStates();
      const decision = finishGateDecision(snapshots);
      if (decision.proceed) {
        // Seal the batch first: the save queues issue no new writes
        // from here on. `finishing` is NOT reset before runComplete
        // returns; on failure runComplete unseals everything and the
        // drafts stay editable, and only then does the finally below
        // unlock entry.
        for (const handle of handles) handle.seal();
        await runComplete();
        return;
      }
      setFinishBlock(decision.reason);
    } finally {
      setFinishing(false);
    }
  }

  // Confirmed finish despite pending edits: seal AND settle every
  // set's save queue first — no queued write may still be in flight
  // when the complete request is sent, so nothing can land after the
  // workout is finished. The seal runs through
  // sealAllAndSettleStable: the registry is re-read after each round
  // and any handle registered mid-round is sealed and settled too,
  // so complete is never sent over an unchecked new set. If the
  // registry never stabilises, the finish aborts — everything is
  // unsealed, the failure is surfaced, and no complete is attempted.
  // If the complete then fails (thrown or ok !== true), runComplete
  // unseals everything and the workout stays editable with all drafts
  // intact. Entry stays locked (`finishing`) until the flow ends.
  async function confirmFinishAnyway() {
    setFinishBlock(null);
    setFinishFailed(false);
    setFinishing(true);
    try {
      // W-FINISH-001: same pending-add join as handleFinish, before
      // any seal — a failed add aborts with the failure shown and no
      // complete attempted; a landed add's new SetRow is sealed and
      // settled by the rounds below like every other set.
      const adds = await settlePendingAdds(() => [...pendingAddsRef.current]);
      if (!adds.ok) {
        setFinishFailed(true);
        return;
      }
      // Same registration barrier as handleFinish, before any seal:
      // the seal rounds below must cover the landed add's set too,
      // and a set whose handle never registered aborts the finish
      // here (nothing sealed yet, drafts untouched).
      const registered = await awaitFinalSetRegistration();
      if (!registered) {
        setFinishFailed(true);
        return;
      }
      const { stable } = await sealAllAndSettleStable(() => [...setHandlesRef.current.values()]);
      if (!stable) {
        for (const handle of setHandlesRef.current.values()) handle.unseal();
        setFinishFailed(true);
        return;
      }
      await runComplete();
    } finally {
      setFinishing(false);
    }
  }
  const discard = useMutation({
    mutationFn: () => api.discardWorkout({ workout_id: workout.id }),
    onSuccess: refresh,
  });

  const previousByExercise = useMemo(() => {
    // W1.3: cross-unit workouts are comparable too — take the latest
    // completed set per exercise from the most recent completed workout
    // that has one, converting its weight into this workout's unit.
    const result = new Map<string, PreviousMark>();
    for (const oldWorkout of recent) {
      const unitConverted = oldWorkout.unit !== workout.unit;
      for (const set of [...oldWorkout.sets].reverse()) {
        if (set.completed && !result.has(set.exercise_key)) {
          result.set(set.exercise_key, {
            weight: set.weight == null
              ? null
              : unitConverted
                ? convertWeightValue(set.weight, oldWorkout.unit, workout.unit)
                : set.weight,
            reps: set.reps,
            converted: unitConverted && set.weight != null,
          });
        }
      }
    }
    return result;
  }, [recent, workout.unit]);

  const total = workout.sets.length;
  const meta = ROUTINE_META[workout.routine];
  const exerciseGroups = groupSets(workout.sets);
  // W-UI-001-D1: per-set snapshots merge the live save-handle state
  // (registered by each mounted SetRow) over the server data, so the
  // top completion count, the save aggregate and the card heads all
  // read one draft-aware picture. A pending add is not in
  // workout.sets yet, so it never inflates the total — it surfaces
  // separately through the aggregate's 正在添加一组 state, and only
  // counts once the server confirms it into the current data.
  const setSnapshots: (SetSaveSnapshot & { completed: boolean })[] = workout.sets.map((set) => {
    const handle = handleStates.get(set.id);
    return {
      id: set.id,
      exerciseKey: set.exercise_key,
      status: handle?.status ?? "saved",
      blocked: handle?.blocked ?? (set.completed && set.reps == null),
      completed: handle?.completed ?? set.completed,
    };
  });
  const doneCount = setSnapshots.filter((snapshot) => snapshot.completed).length;
  const saveAggregate = aggregateSaveStates(setSnapshots, { pendingAdds: pendingAddCount, finishing });
  const headInfoByKey: Record<string, ExerciseHeadInfo> = {};
  for (const group of exerciseGroups) {
    const list = setSnapshots.filter((snapshot) => snapshot.exerciseKey === group.key);
    const errorCount = list.filter((snapshot) => snapshot.status === "error").length;
    const blockedCount = list.filter((snapshot) => snapshot.blocked).length;
    const dirtyCount = list.filter((snapshot) => snapshot.status === "dirty").length;
    const savingCount = list.filter((snapshot) => snapshot.status === "saving").length;
    let statusText: string | null = null;
    let statusKind: ExerciseHeadInfo["statusKind"] = null;
    if (errorCount > 0) {
      statusText = `有 ${errorCount} 组保存失败`;
      statusKind = "error";
    } else if (blockedCount > 0) {
      statusText = blockedCount > 1 ? `${blockedCount} 组需补次数` : "需补次数";
      statusKind = "blocked";
    } else if (dirtyCount > 0) {
      statusText = "有未保存修改";
      statusKind = "dirty";
    } else if (savingCount > 0) {
      statusText = "保存中…";
      statusKind = "saving";
    }
    headInfoByKey[group.key] = {
      doneCount: list.filter((snapshot) => snapshot.completed).length,
      statusText,
      statusKind,
    };
  }
  // W-UI-001-D1 + W-TIMER-001: the current exercise anchors both the
  // single expanded card and the rest-timer UI, and follows the same
  // rule — a manual card-head selection wins over the first
  // incomplete exercise.
  const currentKey = resolveCurrentExerciseKey(
    exerciseGroups.map((group) => ({
      key: group.key,
      hasIncomplete: setSnapshots.some((snapshot) => snapshot.exerciseKey === group.key && !snapshot.completed),
    })),
    selectedExerciseKey,
  );
  const restTimerUi = (
    <>
      <RestAutoToggle timer={restTimer} onChange={updateRestTimer} />
      {restTimer.endsAt != null ? (
        <RestTimerPanel timer={restTimer} nowMs={restNow} onChange={updateRestTimer} />
      ) : null}
    </>
  );

  function focusSetInput(setId: number, field: "weight" | "reps") {
    // Two frames: the target exercise may need one render to expand
    // before its input becomes focusable.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLInputElement>(`input[data-focus-set="${setId}"][data-focus-field="${field}"]`)
          ?.focus();
      });
    });
  }

  // W-UI-001-D1: the aggregate's 查看 — expand the first abnormal
  // exercise (it becomes the current one) and focus its first
  // abnormal set: the reps input when reps are what's missing, the
  // weight input otherwise.
  function handleViewAbnormal() {
    const target = saveAggregate.firstAbnormal;
    if (!target) return;
    setSelectedExerciseKey(target.exerciseKey);
    focusSetInput(target.setId, target.blocked ? "reps" : "weight");
  }

  // W-UI-001-D1: Enter in a set input has already saved through the
  // normal blur path inside SetRow; here focus only moves on —
  // within the set, to the next set, across into the next exercise
  // (which becomes current and expands), or, after the very last
  // input, back to the 结束训练 button with the keyboard dismissed
  // by the blur.
  function handleEnterNext(exerciseKey: string, setId: number, field: "weight" | "reps") {
    const target = nextFocusTarget(buildFocusOrder(exerciseGroups), { exerciseKey, setId, field });
    if (!target) return;
    if (target.kind === "finish") {
      finishButtonRef.current?.focus();
      return;
    }
    setSelectedExerciseKey(target.target.exerciseKey);
    focusSetInput(target.target.setId, target.target.field);
  }

  // W-UI-001-D1: cancelling the finish confirmation restores the
  // pre-finish state — the current-exercise selection was never
  // touched by the finish flow, and focus returns to the element
  // that held it when 结束训练 was pressed.
  function cancelFinish() {
    setFinishBlock(null);
    const target = preFinishFocusRef.current;
    requestAnimationFrame(() => {
      if (target && target.isConnected) target.focus();
    });
  }

  return (
    <main className="active-shell">
      <header className="active-header">
        <div>
          <p className="live-label"><span />训练中</p>
          <h1>{meta.title}</h1>
        </div>
        <div className="timer" aria-label={`训练时长 ${formatDuration(workout.started_at)}`}>
          <strong>{formatDuration(workout.started_at)}</strong>
        </div>
      </header>

      <CurrentWeekProgress workouts={recent} weekSummaries={weekSummaries} activeWorkout={workout} compact />

      <div className="progress-track" aria-label={`已完成 ${doneCount} 组，共 ${total} 组`}>
        <span style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }} />
      </div>

      <div className="workout-status-bar">
        <span className="completion-count">已完成 {doneCount} / {total} 组</span>
        <span className="save-aggregate" data-kind={saveAggregate.kind} role="status">
          {saveAggregate.label}
          {saveAggregate.firstAbnormal && (saveAggregate.kind === "error" || saveAggregate.kind === "blocked") ? (
            <button type="button" className="save-aggregate-view" onClick={handleViewAbnormal}>查看</button>
          ) : null}
        </span>
      </div>

      <details className="warmup-strip">
        <summary>先热身 <span>展开</span></summary>
        <p>{meta.warmup}</p>
      </details>

      <div className="exercise-stack">
        {exerciseGroups.map((exercise) => (
          <ExerciseBlock
            key={exercise.key}
            workout={workout}
            exercise={exercise}
            previous={previousByExercise.get(exercise.key)}
            timerSlot={currentKey != null && exercise.key === currentKey ? restTimerUi : undefined}
            entryLocked={finishing}
            expanded={exercise.key === currentKey}
            headInfo={headInfoByKey[exercise.key] ?? { doneCount: 0, statusText: null, statusKind: null }}
            onSelect={() => setSelectedExerciseKey(exercise.key)}
            onChanged={refresh}
            onSetCompleted={handleSetCompleted}
            onOpenGuide={(guide, key) => setSelectedGuide({ guide, key })}
            onRegisterSet={registerSet}
            onRegisterPendingAdd={registerPendingAdd}
            onEnterNextSet={(setId, field) => handleEnterNext(exercise.key, setId, field)}
          />
        ))}
      </div>

      {currentKey == null ? <div className="rest-timer-fallback">{restTimerUi}</div> : null}

      <section className="finish-zone">
        <div>
          <p>{doneCount === total ? "全部完成" : `还剩 ${total - doneCount} 组`}</p>
          <span>{unsavedPresent ? "有未保存的修改，结束前会先保存" : "完成后会进入历史记录"}</span>
        </div>
        <button ref={finishButtonRef} type="button" className="finish-button" onClick={() => void handleFinish()} disabled={complete.isPending || finishing}>
          {complete.isPending || finishing ? "正在结束…" : "结束训练"}
        </button>
      </section>

      {finishBlock ? (
        <div className="inline-confirm finish-confirm" role="group" aria-label="确认结束训练">
          <span>
            {finishBlock === "unsaved"
              ? "仍有未保存的修改，结束训练会丢失这些修改"
              : finishBlock === "blocked"
                ? "有已完成但缺次数的组，请先补次数，或确认直接结束"
                : "还有未完成的组，确认结束训练吗？"}
          </span>
          <button type="button" onClick={cancelFinish}>返回继续编辑</button>
          <button type="button" className="danger" onClick={() => void confirmFinishAnyway()} disabled={complete.isPending || finishing}>仍要结束</button>
        </div>
      ) : null}

      {finishFailed ? (
        <p className="error-banner" role="alert">结束失败，修改已保留，可以继续编辑保存后重试结束</p>
      ) : null}

      <div className="discard-zone">
        {!confirmDiscard ? (
          <button type="button" onClick={() => setConfirmDiscard(true)}>放弃这次训练</button>
        ) : (
          <div className="inline-confirm" role="group" aria-label="确认放弃训练">
            <span>这次记录会被删除</span>
            <button type="button" onClick={() => setConfirmDiscard(false)}>返回</button>
            <button type="button" className="danger" onClick={() => discard.mutate()} disabled={discard.isPending}>确认删除</button>
          </div>
        )}
      </div>
      {selectedGuide ? <ExerciseGuideDialog guide={selectedGuide.guide} exerciseKey={selectedGuide.key} onClose={() => setSelectedGuide(null)} /> : null}
    </main>
  );
}

function History({ workouts, focus }: {
  workouts: Workout[];
  // W4.3-D1: the receipt's 查看本次记录 target — expand exactly this
  // workout's row and scroll to it. A nonce makes repeat clicks on
  // the same record re-run the effect.
  focus: { id: number; n: number } | null;
}) {
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(`history-workout-${focus.id}`);
    if (el instanceof HTMLDetailsElement) {
      el.open = true;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      document.querySelector(".history-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [focus]);

  if (workouts.length === 0) {
    return (
      <section className="history-section">
        <div className="section-heading"><h2>最近训练</h2></div>
        <p className="empty-history">第一次训练完成后，重量和次数会留在这里。</p>
      </section>
    );
  }
  return (
    <section className="history-section">
      <div className="section-heading"><h2>最近训练</h2><span>{workouts.length} 次</span></div>
      <div className="history-list">
        {workouts.map((workout) => (
          <details className="history-row" key={workout.id} id={`history-workout-${workout.id}`}>
            <summary>
              <span className="history-date">{formatDate(workout.completed_at ?? workout.started_at)}</span>
              <strong>{ROUTINE_META[workout.routine].label}</strong>
              <span>{completedCount(workout)} 组</span>
              <span>{formatDuration(workout.started_at, workout.completed_at)}</span>
              <i aria-hidden="true">›</i>
            </summary>
            <div className="history-detail">
              <p>总训练量 <strong>{Math.round(trainingVolume(workout)).toLocaleString("zh-CN")} {workout.unit}</strong></p>
              {groupSets(workout.sets).map((exercise) => (
                <div key={exercise.key}>
                  <span>{exercise.name}</span>
                  <span>{exercise.sets.filter((set) => set.completed).map((set) => `${set.weight ?? "自重"}×${set.reps ?? "—"}`).join(" / ") || "未完成"}</span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

// --- 2026-10-18 frequency sync: weekly schedule / daily micro-routine /
// plan editor. All three read the persisted plan (getPlan); the editor
// edits a local draft only — nothing is written until 保存计划 calls
// updatePlan, and server validation errors render inline.

function todayScheduleIndex(now = new Date()) {
  // Monday = 0 … Sunday = 6, matching plan_schedule.day_index.
  return (now.getDay() + 6) % 7;
}

function WeeklySchedule({ plan }: { plan: Plan }) {
  const today = todayScheduleIndex();
  const entries = [...plan.schedule].sort((a, b) => a.day_index - b.day_index);
  if (entries.length === 0) return null;
  return (
    <section className="schedule-section" aria-labelledby="schedule-title">
      <div className="section-heading">
        <h2 id="schedule-title">本周安排</h2>
        <span>今天 {SCHEDULE_DAY_LABELS[today]}</span>
      </div>
      <ol className="schedule-list">
        {entries.map((entry) => {
          const isToday = entry.day_index === today;
          return (
            <li key={entry.day_index} className={`schedule-row${isToday ? " is-today" : ""}`} aria-current={isToday ? "date" : undefined}>
              <span className="schedule-day">{SCHEDULE_DAY_LABELS[entry.day_index] ?? ""}</span>
              <span className="schedule-what">
                <strong>{SCHEDULE_CODE_LABELS[entry.routine_code] ?? entry.routine_code}</strong>
                {entry.note ? <small>{entry.note}</small> : null}
              </span>
              {isToday ? <span className="today-badge">● 今天</span> : null}
            </li>
          );
        })}
      </ol>
      <p className="schedule-note">出发周（12 月初）减量：在家 B 停掉，健身房腿日量减约三成。</p>
    </section>
  );
}

function DailyChecklist({ plan }: { plan: Plan }) {
  const queryClient = useQueryClient();
  const doneSet = new Set(plan.daily_done);
  const toggle = useMutation({
    mutationFn: (args: { item_key: string; done: boolean }) =>
      api.toggleDailyItem({ date_key: plan.daily_date, item_key: args.item_key, done: args.done }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["plan"] }),
  });
  const doneCount = plan.daily_items.filter((item) => doneSet.has(item.key)).length;
  return (
    <section className="daily-section" aria-labelledby="daily-title">
      <div className="section-heading">
        <h2 id="daily-title">每日体态微练 · 5 分钟</h2>
        <span>{doneCount}/{plan.daily_items.length} 已完成</span>
      </div>
      <div className="daily-list">
        {plan.daily_items.map((item) => {
          const done = doneSet.has(item.key);
          return (
            <button
              key={item.key}
              type="button"
              className={`daily-item${done ? " is-done" : ""}`}
              aria-pressed={done}
              aria-label={`${item.title}，${done ? "已完成，点击取消" : "未完成，点击标记完成"}`}
              disabled={toggle.isPending}
              onClick={() => toggle.mutate({ item_key: item.key, done: !done })}
            >
              <span className="daily-check" aria-hidden="true">{done ? "✓" : "○"}</span>
              <span className="daily-text">
                <strong>{item.title}</strong>
                {item.detail ? <small>{item.detail}</small> : null}
              </span>
              <span className="daily-state">{done ? "已完成" : "未完成"}</span>
            </button>
          );
        })}
      </div>
      <p className="daily-note">工作日都做，起床或工间完成即可；打卡只是记录，不影响开始训练。</p>
    </section>
  );
}

// W-PLAN-SAFE-001 follow-up: unconfirmed upgrade conflicts. Rendered
// only while plan.conflicts is non-empty (getPlan omits the field
// entirely when there is nothing to confirm, so a conflict-free plan
// never shows this). The notice is text-first — a heading, the count
// and an explicit 尚未确认 state — never color alone. Each candidate
// copy is listed with its plan fields and its own "以这一份为准"
// button; choosing one calls resolvePlanConflict, after which the
// panel disappears on the refetched plan. Until then the currently
// displayed copy is labelled as unconfirmed, never as the valid one.
function PlanConflicts({ plan }: { plan: Plan }) {
  const queryClient = useQueryClient();
  const conflicts = plan.conflicts ?? [];
  const [resolveError, setResolveError] = useState<string | null>(null);
  const resolve = useMutation({
    mutationFn: (args: {
      routine: string;
      exercise_key: string;
      selected_archive_id: number | null;
      expected_candidate_ids: number[];
      expected_plan_version: string | null;
    }) => api.resolvePlanConflict(args),
    onSuccess: async (result) => {
      if (result.ok) {
        // Includes the already_resolved idempotent receipt: the
        // decision is recorded either way, so just refetch.
        setResolveError(null);
        await queryClient.invalidateQueries({ queryKey: ["plan"] });
        await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      } else {
        setResolveError(result.error ?? "确认失败，请重试");
        if (result.outcome === "stale") {
          // The displayed candidates are outdated: refetch so the
          // owner re-decides on the candidates actually current.
          await queryClient.invalidateQueries({ queryKey: ["plan"] });
        }
      }
    },
    onError: () => setResolveError("确认失败，请再试一次"),
  });
  if (conflicts.length === 0) return null;
  return (
    <section className="plan-conflict-section" aria-labelledby="plan-conflict-title">
      <div className="section-heading">
        <h2 id="plan-conflict-title">计划冲突待确认</h2>
        <span>{conflicts.length} 处未确认</span>
      </div>
      {conflicts.map((conflict) => {
        const routineTitle = (ROUTINE_META as Record<string, { title: string }>)[conflict.routine]?.title ?? conflict.routine;
        return (
          <div key={`${conflict.routine}-${conflict.exercise_key}`} className="plan-conflict-card">
            <p className="plan-conflict-notice" role="alert">
              ▲ 尚未确认：升级时发现「{routineTitle} · {conflict.exercise_name}」有 {conflict.candidate_count} 份不同版本，
              已保留全部副本；下面当前显示的是其中一份，还没有确认以哪一份为准。
              {conflict.archived_at
                ? `（副本归档时间：${new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(conflict.archived_at))}）`
                : ""}
            </p>
            <ul className="plan-conflict-candidates">
              {conflict.candidates.map((candidate) => {
                const isLive = candidate.source === "live";
                const label = isLive ? "当前显示的版本（尚未确认）" : `归档副本${candidate.archive_id != null ? ` #${candidate.archive_id}` : ""}`;
                return (
                  <li key={isLive ? "live" : `archived-${candidate.archive_id}`} className="plan-conflict-candidate">
                    <span className="plan-conflict-candidate-text">
                      <strong>{label}</strong>
                      <span>{candidate.name} · {candidate.sets} 组 · 目标 {candidate.target}</span>
                    </span>
                    <button
                      type="button"
                      className="plan-conflict-pick"
                      aria-label={`以「${candidate.name}」（${label}）为准，确认这条冲突`}
                      disabled={resolve.isPending}
                      onClick={() => resolve.mutate({
                        routine: conflict.routine,
                        exercise_key: conflict.exercise_key,
                        selected_archive_id: candidate.archive_id,
                        // W-PLAN-SAFE-001 P0 tail: bind the decision
                        // to exactly the candidates + plan version
                        // displayed here — if the plan changed in
                        // another window, the server answers stale
                        // and nothing unseen is confirmed.
                        expected_candidate_ids: conflict.candidates.map((c) => c.id),
                        expected_plan_version: conflict.plan_version,
                      })}
                    >
                      以这一份为准
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {resolveError ? <p className="error-banner" role="alert">{resolveError}</p> : null}
      <p className="plan-conflict-note">确认前计划照常可用；在你选择之前，不会把任何一份当作已确认的版本。</p>
    </section>
  );
}

function PlanEditor({ plan }: { plan: Plan }) {
  const queryClient = useQueryClient();
  const [draftRoutines, setDraftRoutines] = useState<PlanRoutineEntry[]>(() =>
    plan.routines.map((entry) => ({ routine: entry.routine, exercises: entry.exercises.map((exercise) => ({ ...exercise })) })),
  );
  const [draftSchedule, setDraftSchedule] = useState(() => plan.schedule.map((entry) => ({ ...entry })));
  const [draftDaily, setDraftDaily] = useState(() => plan.daily_items.map((item) => ({ ...item })));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);

  const save = useMutation({
    mutationFn: () => api.updatePlan({ routines: draftRoutines, schedule: draftSchedule, daily_items: draftDaily }),
    onSuccess: async (result) => {
      if (result.ok) {
        setSaveError(null);
        setSavedNote(true);
        await queryClient.invalidateQueries({ queryKey: ["plan"] });
        await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      } else {
        setSavedNote(false);
        setSaveError(result.error ?? "保存失败，请检查内容后重试");
      }
    },
    onError: () => {
      setSavedNote(false);
      setSaveError("保存失败，请再试一次");
    },
  });

  function clientValidate(): string | null {
    for (const entry of draftRoutines) {
      if (entry.exercises.length === 0) return `${ROUTINE_META[entry.routine].title}至少保留 1 个动作`;
      const keys = new Set<string>();
      for (const exercise of entry.exercises) {
        if (exercise.name.trim() === "") return "动作名称不能为空";
        if (exercise.target.trim() === "") return `目标次数不能为空：${exercise.name}`;
        if (!Number.isInteger(exercise.sets) || exercise.sets < 1 || exercise.sets > 10) return `组数需要在 1–10 之间：${exercise.name}`;
        if (keys.has(exercise.key)) return `同一训练日内动作重复：${exercise.name}`;
        keys.add(exercise.key);
      }
    }
    if (draftSchedule.length !== 7) return "周安排需要正好 7 天";
    if (draftDaily.length === 0) return "每日微练至少保留 1 项";
    for (const item of draftDaily) {
      if (item.title.trim() === "") return "微练名称不能为空";
    }
    return null;
  }

  function handleSave() {
    const error = clientValidate();
    if (error) {
      setSavedNote(false);
      setSaveError(error);
      return;
    }
    setSaveError(null);
    save.mutate();
  }

  function updateExercise(routine: Routine, index: number, patch: Partial<PlanExerciseDraft>) {
    setSavedNote(false);
    setDraftRoutines((prev) => prev.map((entry) => (entry.routine !== routine ? entry : {
      ...entry,
      exercises: entry.exercises.map((exercise, i) => (i === index ? { ...exercise, ...patch } : exercise)),
    })));
  }

  function moveExercise(routine: Routine, index: number, delta: number) {
    setSavedNote(false);
    setDraftRoutines((prev) => prev.map((entry) => {
      if (entry.routine !== routine) return entry;
      const next = [...entry.exercises];
      const target = index + delta;
      if (target < 0 || target >= next.length) return entry;
      const current = next[index];
      const other = next[target];
      if (!current || !other) return entry;
      next[index] = other;
      next[target] = current;
      return { ...entry, exercises: next };
    }));
  }

  function removeExercise(routine: Routine, index: number) {
    setSavedNote(false);
    setDraftRoutines((prev) => prev.map((entry) => (entry.routine !== routine ? entry : {
      ...entry,
      exercises: entry.exercises.filter((_, i) => i !== index),
    })));
  }

  function addExercise(routine: Routine) {
    setSavedNote(false);
    setDraftRoutines((prev) => prev.map((entry) => {
      if (entry.routine !== routine) return entry;
      let suffix = entry.exercises.length + 1;
      let key = `custom-${suffix}`;
      while (entry.exercises.some((exercise) => exercise.key === key)) {
        suffix += 1;
        key = `custom-${suffix}`;
      }
      return { ...entry, exercises: [...entry.exercises, { key, name: "新动作", sets: 3, target: "10–12" }] };
    }));
  }

  return (
    <section className="plan-editor-section" aria-labelledby="plan-editor-title">
      <details className="plan-editor">
        <summary>
          <span id="plan-editor-title">编辑训练计划</span>
          <span>模板 · 周安排 · 每日微练</span>
        </summary>
        <div className="plan-editor-body">
          {draftRoutines.map((entry) => (
            <div key={entry.routine} className="plan-routine">
              <h3>{ROUTINE_META[entry.routine].title}</h3>
              {entry.exercises.map((exercise, index) => (
                <div key={exercise.key} className="plan-exercise-row">
                  <label className="plan-field plan-field-name">
                    <span>动作名称</span>
                    <input
                      aria-label={`${ROUTINE_META[entry.routine].title}第 ${index + 1} 个动作名称`}
                      value={exercise.name}
                      onChange={(event) => updateExercise(entry.routine, index, { name: event.target.value })}
                    />
                  </label>
                  <label className="plan-field plan-field-sets">
                    <span>组数</span>
                    <input
                      aria-label={`${exercise.name}组数`}
                      type="number"
                      min="1"
                      max="10"
                      step="1"
                      value={exercise.sets}
                      onChange={(event) => updateExercise(entry.routine, index, { sets: Number(event.target.value) })}
                    />
                  </label>
                  <label className="plan-field plan-field-target">
                    <span>目标次数</span>
                    <input
                      aria-label={`${exercise.name}目标次数`}
                      value={exercise.target}
                      onChange={(event) => updateExercise(entry.routine, index, { target: event.target.value })}
                    />
                  </label>
                  <div className="plan-row-actions">
                    <button type="button" aria-label={`上移${exercise.name}`} disabled={index === 0} onClick={() => moveExercise(entry.routine, index, -1)}>↑</button>
                    <button type="button" aria-label={`下移${exercise.name}`} disabled={index === entry.exercises.length - 1} onClick={() => moveExercise(entry.routine, index, 1)}>↓</button>
                    <button type="button" aria-label={`删除${exercise.name}`} onClick={() => removeExercise(entry.routine, index)}>删除</button>
                  </div>
                </div>
              ))}
              <button type="button" className="plan-add" onClick={() => addExercise(entry.routine)}>+ 加一个动作</button>
            </div>
          ))}

          <div className="plan-routine">
            <h3>周安排</h3>
            {[...draftSchedule].sort((a, b) => a.day_index - b.day_index).map((entry) => (
              <div key={entry.day_index} className="plan-schedule-row">
                <span className="plan-schedule-day">{SCHEDULE_DAY_LABELS[entry.day_index] ?? ""}</span>
                <label className="plan-field">
                  <span className="sr-only">{SCHEDULE_DAY_LABELS[entry.day_index] ?? ""}安排</span>
                  <select
                    aria-label={`${SCHEDULE_DAY_LABELS[entry.day_index] ?? ""}安排`}
                    value={entry.routine_code}
                    onChange={(event) => {
                      setSavedNote(false);
                      setDraftSchedule((prev) => prev.map((item) => (item.day_index === entry.day_index ? { ...item, routine_code: event.target.value } : item)));
                    }}
                  >
                    {Object.entries(SCHEDULE_CODE_LABELS).map(([code, label]) => (
                      <option key={code} value={code}>{label}</option>
                    ))}
                  </select>
                </label>
                <label className="plan-field plan-field-note">
                  <span className="sr-only">{SCHEDULE_DAY_LABELS[entry.day_index] ?? ""}备注</span>
                  <input
                    aria-label={`${SCHEDULE_DAY_LABELS[entry.day_index] ?? ""}备注`}
                    value={entry.note}
                    placeholder="备注"
                    onChange={(event) => {
                      setSavedNote(false);
                      setDraftSchedule((prev) => prev.map((item) => (item.day_index === entry.day_index ? { ...item, note: event.target.value } : item)));
                    }}
                  />
                </label>
              </div>
            ))}
          </div>

          <div className="plan-routine">
            <h3>每日体态微练</h3>
            {draftDaily.map((item, index) => (
              <div key={item.key} className="plan-exercise-row">
                <label className="plan-field plan-field-name">
                  <span>名称</span>
                  <input
                    aria-label={`微练第 ${index + 1} 项名称`}
                    value={item.title}
                    onChange={(event) => {
                      setSavedNote(false);
                      setDraftDaily((prev) => prev.map((row, i) => (i === index ? { ...row, title: event.target.value } : row)));
                    }}
                  />
                </label>
                <label className="plan-field plan-field-target">
                  <span>说明</span>
                  <input
                    aria-label={`${item.title}说明`}
                    value={item.detail}
                    onChange={(event) => {
                      setSavedNote(false);
                      setDraftDaily((prev) => prev.map((row, i) => (i === index ? { ...row, detail: event.target.value } : row)));
                    }}
                  />
                </label>
                <div className="plan-row-actions">
                  <button
                    type="button"
                    aria-label={`删除微练${item.title}`}
                    onClick={() => {
                      setSavedNote(false);
                      setDraftDaily((prev) => prev.filter((_, i) => i !== index));
                    }}
                  >删除</button>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="plan-add"
              onClick={() => {
                setSavedNote(false);
                setDraftDaily((prev) => {
                  let suffix = prev.length + 1;
                  let key = `daily-custom-${suffix}`;
                  while (prev.some((item) => item.key === key)) {
                    suffix += 1;
                    key = `daily-custom-${suffix}`;
                  }
                  return [...prev, { key, title: "新微练", detail: "" }];
                });
              }}
            >+ 加一项微练</button>
          </div>

          {saveError ? <p className="error-banner" role="alert">{saveError}</p> : null}
          {savedNote ? <p className="plan-saved" role="status">已保存，下次开始训练时生效</p> : null}
          <button type="button" className="plan-save" onClick={handleSave} disabled={save.isPending}>
            {save.isPending ? "正在保存…" : "保存计划"}
          </button>
          <p className="plan-editor-note">修改只保存在这里的草稿里，点保存后才生效；已完成的历史记录不会被改动。</p>
        </div>
      </details>
    </section>
  );
}

function StartScreen({ recent, weekSummaries, comparableHistory, receiptId, onCloseReceipt }: {
  recent: Workout[];
  weekSummaries?: readonly WeekSummary[] | null;
  comparableHistory?: ComparableHistoryEntry[];
  // W4.3-D1: the workoutId this session just finished, or null. The
  // receipt renders non-blockingly at the top of the start page.
  receiptId: number | null;
  onCloseReceipt: () => void;
}) {
  const queryClient = useQueryClient();
  const [unit, setUnit] = useState<Unit>("lb");
  const [historyFocus, setHistoryFocus] = useState<{ id: number; n: number } | null>(null);
  const plan = useQuery({
    queryKey: ["plan"],
    queryFn: () => api.getPlan({}),
  });
  const start = useMutation({
    mutationFn: (routine: Routine) => api.startWorkout({ routine, unit }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
  });
  // W-PLAN-SAFE-001 P0 tail: a getPlan read_error (bounded retries
  // exhausted by another window's saves) carries NO plan body — the
  // screen must keep the last good plan (and the editor's draft,
  // which is keyed to it) and offer a retry, never blank the plan.
  const freshPlan = plan.data && !plan.data.forbidden && !plan.data.read_error ? plan.data : null;
  const [lastGoodPlan, setLastGoodPlan] = useState<Plan | null>(null);
  useEffect(() => {
    if (freshPlan) setLastGoodPlan(freshPlan);
  }, [freshPlan]);
  const planData = freshPlan ?? lastGoodPlan;
  const planReadFailed = plan.isError || (plan.data != null && !plan.data.forbidden && plan.data.read_error != null);

  return (
    <main className="home-shell">
      {receiptId != null ? (
        <CompletionReceipt
          workoutId={receiptId}
          onClose={onCloseReceipt}
          onViewRecord={(id) => setHistoryFocus((prev) => ({ id, n: (prev?.n ?? 0) + 1 }))}
        />
      ) : null}
      <section className="start-hero">
        <div className="hero-copy">
          <p className="date-line">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</p>
          <h1>今天练什么？</h1>
          <p>选一天，动作和组数已经排好。</p>
        </div>
        <div className="unit-switch" aria-label="重量单位">
          <button type="button" aria-pressed={unit === "lb"} onClick={() => setUnit("lb")}>lb</button>
          <button type="button" aria-pressed={unit === "kg"} onClick={() => setUnit("kg")}>kg</button>
        </div>
      </section>

      <CurrentWeekProgress
        workouts={recent}
        weekSummaries={weekSummaries}
        onOpenWorkout={(id) => setHistoryFocus((prev) => ({ id, n: (prev?.n ?? 0) + 1 }))}
      />

      <WeeklyReview workouts={recent} comparableHistory={comparableHistory} />

      <section className="routine-selector" aria-label="选择训练日">
        {ALL_ROUTINES.map((routine, index) => {
          const meta = ROUTINE_META[routine];
          const planEntry: PlanRoutineEntry | undefined = planData?.routines.find((entry) => entry.routine === routine);
          const countText = planEntry
            ? `${planEntry.exercises.length} 个动作 · ${planEntry.exercises.reduce((sum, exercise) => sum + exercise.sets, 0)} 组`
            : meta.count;
          const scheduledDays = planData
            ? planData.schedule.filter((entry) => entry.routine_code === routine).map((entry) => SCHEDULE_DAY_LABELS[entry.day_index] ?? "")
            : [];
          const dayText = scheduledDays.length > 0 ? scheduledDays.join(" · ") : meta.day;
          return (
            <button key={routine} type="button" className={`routine-option routine-${routine}`} onClick={() => start.mutate(routine)} disabled={start.isPending}>
              <span className="routine-number">0{index + 1}</span>
              <span className={`routine-name${routine.startsWith("home") ? " routine-name-home" : ""}`}>{meta.label}</span>
              <span className="routine-detail"><b>{dayText}</b>{countText}</span>
              <span className="routine-arrow" aria-hidden="true">→</span>
            </button>
          );
        })}
      </section>

      {start.isError ? <p className="error-banner">没能开始训练，请再试一次。</p> : null}

      {planReadFailed ? (
        <p className="error-banner" role="alert">
          {plan.data?.read_error ?? "计划读取失败"}——已保留当前显示的计划与编辑草稿，没有清空。
          <button type="button" className="plan-read-retry" onClick={() => plan.refetch()}>重试读取</button>
        </p>
      ) : null}

      {planData ? <WeeklySchedule key={`schedule-${planData.daily_date}`} plan={planData} /> : null}
      {planData ? <DailyChecklist key={`daily-${planData.daily_date}`} plan={planData} /> : null}
      {planData ? <PlanConflicts plan={planData} /> : null}
      {planData ? (
        <PlanEditor
          key={JSON.stringify([planData.routines, planData.schedule, planData.daily_items])}
          plan={planData}
        />
      ) : null}

      <History workouts={recent} focus={historyFocus} />
    </main>
  );
}

export function App() {
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.getDashboard({ recent_limit: 20 }),
  });
  // W4.3-D1: the completion receipt's target — the exact workoutId
  // this session's completeWorkout finished, held in memory only.
  // Refresh strategy (see CompletionReceipt): a page refresh drops
  // the receipt; it is never rebuilt from the most recent record.
  const [receiptId, setReceiptId] = useState<number | null>(null);
  const activeWorkoutId = dashboard.data?.active_workout?.id ?? null;
  useEffect(() => {
    // A (new) active workout supersedes any receipt: the start page
    // is no longer what is on screen.
    if (activeWorkoutId != null) setReceiptId(null);
  }, [activeWorkoutId]);

  if (dashboard.isPending) {
    return <main className="loading-shell"><div className="loading-bar" /><p>正在打开训练表…</p></main>;
  }
  if (dashboard.isError || !dashboard.data) {
    return (
      <main className="loading-shell">
        <h1>暂时打不开记录</h1>
        <p>检查网络后再试一次。</p>
        <button type="button" onClick={() => dashboard.refetch()}>重新加载</button>
      </main>
    );
  }

  if (dashboard.data.forbidden) {
    return (
      <main className="loading-shell">
        <h1>无权访问此训练记录</h1>
        <p>此页面仅对所有者开放。</p>
      </main>
    );
  }

  return (
    <div className="app-root">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      {dashboard.data.active_workout ? (
        <ActiveWorkout
          workout={dashboard.data.active_workout}
          recent={dashboard.data.recent_workouts}
          weekSummaries={dashboard.data.week_summaries}
          onCompleted={(workoutId) => setReceiptId(workoutId)}
        />
      ) : (
        <StartScreen
          recent={dashboard.data.recent_workouts}
          weekSummaries={dashboard.data.week_summaries}
          comparableHistory={dashboard.data.comparable_history}
          receiptId={receiptId}
          onCloseReceipt={() => setReceiptId(null)}
        />
      )}
    </div>
  );
}
