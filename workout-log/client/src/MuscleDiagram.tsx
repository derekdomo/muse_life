// W6.2 muscle diagram for the exercise guide dialog: simple front /
// back body outlines (hand-drawn SVG line silhouettes — no generated
// imagery) with the exercise's muscle groups painted on. Painting is
// driven ONLY by the exercise's existing MUSCLE_MAP entry (primary /
// secondary muscle names) translated through MUSCLE_NAME_REGIONS
// below; a muscle name with no region entry is never guessed onto
// the figure, and an exercise whose mapping is missing — or none of
// whose muscle names resolve to a region — renders the text state
// 暂无肌群图 instead of a figure.
//
// Colour is never the only channel (the owner is colour-weak):
// primary muscles are SOLID vermillion fill, secondary muscles are a
// blue diagonal HATCH with an outline, both in the Okabe-Ito
// colourblind-friendly palette, and the figure always carries a text
// legend naming 主要 (solid) and 次要 (hatch) plus the muscle names.
// If a muscle somehow appears in both the primary and secondary
// lists, or two names share one region, the region resolves to
// primary — the stronger claim wins and is what the legend reports.

import { useId } from "react";
import type { MuscleMapping } from "./App";

export type MusclePaint = "primary" | "secondary";

type RegionDef = {
  // SVG path for the LEFT half of the figure (x axis 0–100, centre 50).
  d: string;
  // True when the region exists on both sides: the right half is the
  // same path mirrored about x=50. Centre regions (abs, neck…) are
  // authored whole and stay unpaired.
  pair?: boolean;
};

// Body silhouette shared by both views, plus the head and neck.
// Deliberately a simple line outline, per the W6.2 brief.
const BODY_OUTLINE_D =
  "M30 29 C26 30 23 33 22 38 L19 72 C18.5 76 18.7 80 19.5 84 L17 108 " +
  "C16.8 112 18 115 20 115.5 L23 115 C24 115 24.5 112 24.3 108 L26 82 L28.5 54 " +
  "C30 62 31.5 70 32.5 78 L33.5 92 C34 98 34.5 101 35 104 L36.5 150 " +
  "C36.8 158 37.2 166 37.8 174 L39 200 L38.5 206.5 L46 206.5 L46.5 200 L47.5 168 " +
  "C48 158 48.2 148 48 138 L48.5 112 C49 109 51 109 51.5 112 L52 138 " +
  "C51.8 148 52 158 52.5 168 L53.5 200 L54 206.5 L61.5 206.5 L61 200 L62.2 174 " +
  "C62.8 166 63.2 158 63.5 150 L65 104 C65.5 101 66 98 66.5 92 L67.5 78 " +
  "C68.5 70 70 62 71.5 54 L74 82 L75.7 108 C75.5 112 76 115 77 115 L80 115.5 " +
  "C82 115 83.2 112 83 108 L80.5 84 C81.3 80 81.5 76 81 72 L78 38 " +
  "C77 33 74 30 70 29 C64 26.8 58 25.8 54 25.4 L46 25.4 C42 25.8 36 26.8 30 29 Z";
const NECK_D = "M45.8 19 L54.2 19 L53.6 26 L46.4 26 Z";

// Paintable regions, front view. Draw order matters where regions
// overlap (later = on top): broad torso areas first, arms and legs
// last.
export const FRONT_REGIONS: Record<string, RegionDef> = {
  "traps-front": { d: "M46.2 24.8 L31.5 28.3 L33.2 32.8 L46.4 29.2 Z", pair: true },
  pec: { d: "M49.8 31 L38 30.5 C34.8 30.8 33.2 33.2 33.4 37 C33.6 41.5 36 44.8 39.5 45.6 L49.8 46.5 Z", pair: true },
  serratus: { d: "M30.8 51 C30.2 56 30.2 61 30.7 65.5 L35.3 64.8 C34.6 60.2 34.6 55.4 35.2 51.5 Z", pair: true },
  obliques: { d: "M35.2 58 C34.6 68 34.8 79 36 89 L41.6 89.5 C41.1 79 41.1 68 41.5 59 Z", pair: true },
  abs: { d: "M43.2 50 L56.8 50 C57.4 64 57.4 78 56.9 92 L43.1 92 C42.6 78 42.6 64 43.2 50 Z" },
  "neck-front": { d: "M46.8 20.5 L53.2 20.5 L52.7 25.8 L47.3 25.8 Z" },
  "delt-front": { d: "M31 27 C26 27.5 22.5 31 22 36.5 C21.7 41.5 23.5 45 27 46 L30.5 39 C31 34.5 31.3 30 31 27 Z", pair: true },
  biceps: { d: "M20.8 48 C19.6 56 19.4 64 20.2 72 L26.6 72 C25.9 64 25.9 55.8 27 48 Z", pair: true },
  quads: { d: "M37 110 C36.6 124 36.8 140 37.6 152 C40 155.5 45 155.8 47.6 153 L48 112 C44 109.5 40 109.3 37 110 Z", pair: true },
  tibialis: { d: "M38.4 161 L43.4 161 L42.7 197 L39.1 197 Z", pair: true },
};
export const FRONT_REGION_ORDER = [
  "traps-front", "pec", "serratus", "obliques", "abs", "neck-front", "delt-front", "biceps", "quads", "tibialis",
];

// Paintable regions, back view.
export const BACK_REGIONS: Record<string, RegionDef> = {
  "traps-back": { d: "M50 23.5 L35 30 C36.5 42 41 51.5 50 59.5 C59 51.5 63.5 42 65 30 Z" },
  lats: { d: "M32.5 50 C30.8 64 32.8 80 38.5 91 C42 96.5 46.5 99 49.8 99.5 L49.9 74 C44 67 38 58.5 32.5 50 Z", pair: true },
  erectors: { d: "M45.8 60.5 C45.5 72 45.5 84 46 95 L49.4 95 C49.1 84 49.1 72 49.4 61 Z", pair: true },
  "lower-back": { d: "M42.5 86 L57.5 86 L57 100 L43 100 Z" },
  rhomboids: { d: "M49.3 39 L41.5 43 C41.8 48 43 52.5 45.5 55.5 L49.3 53 Z", pair: true },
  "delt-back": { d: "M31 27 C26 27.5 22.5 31 22 36.5 C21.7 41.5 23.5 45 27 46 L30.5 39 C31 34.5 31.3 30 31 27 Z", pair: true },
  triceps: { d: "M20.8 48 C19.6 56 19.4 64 20.2 72 L26.6 72 C25.9 64 25.9 55.8 27 48 Z", pair: true },
  glutes: { d: "M35.8 102 C35.2 110 36 119 38.5 124.5 C41.5 128.5 46 129 49.2 126.5 L49.2 103.5 C45 101.5 39.5 101 35.8 102 Z", pair: true },
  hamstrings: { d: "M37.2 128 C36.8 138 37 148 37.8 156 C40.5 158.8 45.5 159 47.9 156.5 L48.1 130 C44.5 127.8 40 127.5 37.2 128 Z", pair: true },
  calves: { d: "M38.2 160 C37.6 170 38.2 182 40 190 C42.5 193 46.5 192.5 48 189.5 L48.3 162 C45 159.8 41 159.5 38.2 160 Z", pair: true },
};
export const BACK_REGION_ORDER = [
  "traps-back", "lats", "erectors", "lower-back", "rhomboids", "delt-back", "triceps", "glutes", "hamstrings", "calves",
];

// Muscle name (exactly as written in MUSCLE_MAP) -> paintable
// regions per view. This is a purely anatomical placement table: it
// adds no muscle to any exercise. 肩前束 and 肩中束 share the front
// deltoid region (indistinguishable on a simple front outline);
// 肩后束 paints the same cap on the back view. 核心 paints the front
// abs and the back lower-back band.
export const MUSCLE_NAME_REGIONS: Record<string, { front?: string[]; back?: string[] }> = {
  "胸": { front: ["pec"] },
  "肩前束": { front: ["delt-front"] },
  "肩中束": { front: ["delt-front"] },
  "肩后束": { back: ["delt-back"] },
  "肱二头肌": { front: ["biceps"] },
  "肱三头肌": { back: ["triceps"] },
  "前锯肌": { front: ["serratus"] },
  "背阔肌": { back: ["lats"] },
  "斜方肌": { front: ["traps-front"], back: ["traps-back"] },
  "菱形肌": { back: ["rhomboids"] },
  "胸椎伸展肌群": { back: ["erectors"] },
  "核心": { front: ["abs"], back: ["lower-back"] },
  "腹斜肌": { front: ["obliques"] },
  "颈深屈肌": { front: ["neck-front"] },
  "股四头肌": { front: ["quads"] },
  "臀大肌": { back: ["glutes"] },
  "腘绳肌": { back: ["hamstrings"] },
  "小腿": { back: ["calves"] },
  "胫骨前肌": { front: ["tibialis"] },
};

export type MuscleDiagramViewPaint = {
  regions: Record<string, MusclePaint>;
  primaryNames: string[];
  secondaryNames: string[];
};
export type MuscleDiagramPaint = {
  // False when there is no mapping at all, or when none of the
  // mapping's muscle names resolves to a paintable region — the UI
  // then shows 暂无肌群图 and never a guessed figure.
  available: boolean;
  front: MuscleDiagramViewPaint;
  back: MuscleDiagramViewPaint;
  // Muscle names from the mapping that have no region entry: never
  // painted and never renamed into a guess.
  unplaced: string[];
};

const emptyViewPaint = (): MuscleDiagramViewPaint => ({ regions: {}, primaryNames: [], secondaryNames: [] });

export function muscleDiagramPaint(mapping: MuscleMapping | undefined): MuscleDiagramPaint {
  const result: MuscleDiagramPaint = { available: false, front: emptyViewPaint(), back: emptyViewPaint(), unplaced: [] };
  if (!mapping) return result;
  const paint = (view: MuscleDiagramViewPaint, regionIds: string[] | undefined, level: MusclePaint) => {
    for (const regionId of regionIds ?? []) {
      // Primary always wins a shared region, whoever claims it first.
      if (level === "primary" || view.regions[regionId] === undefined) view.regions[regionId] = level;
    }
  };
  const apply = (names: string[], level: MusclePaint) => {
    for (const name of names) {
      const entry = MUSCLE_NAME_REGIONS[name];
      if (!entry) {
        if (!result.unplaced.includes(name)) result.unplaced.push(name);
        continue;
      }
      paint(result.front, entry.front, level);
      paint(result.back, entry.back, level);
      // Name summaries follow the paint outcome per view: a name is
      // listed under a view only if it actually paints there, and a
      // name claimed as primary is never also listed as secondary.
      const noteName = (viewPaint: MuscleDiagramViewPaint, hasRegions: boolean) => {
        if (!hasRegions) return;
        if (level === "primary") {
          // A name claimed as primary is never also listed secondary.
          const idx = viewPaint.secondaryNames.indexOf(name);
          if (idx >= 0) viewPaint.secondaryNames.splice(idx, 1);
          if (!viewPaint.primaryNames.includes(name)) viewPaint.primaryNames.push(name);
        } else if (!viewPaint.primaryNames.includes(name) && !viewPaint.secondaryNames.includes(name)) {
          viewPaint.secondaryNames.push(name);
        }
      };
      noteName(result.front, Boolean(entry.front && entry.front.length > 0));
      noteName(result.back, Boolean(entry.back && entry.back.length > 0));
    }
  };
  // Secondary first, then primary, so a primary claim overwrites a
  // secondary claim on any shared region.
  apply(mapping.secondary, "secondary");
  apply(mapping.primary, "primary");
  result.available =
    Object.keys(result.front.regions).length > 0 || Object.keys(result.back.regions).length > 0;
  return result;
}

function BodyFigure({
  label,
  regions,
  order,
  paint,
  hatchId,
  summary,
}: {
  label: string;
  regions: Record<string, RegionDef>;
  order: string[];
  paint: MuscleDiagramViewPaint;
  hatchId: string;
  summary: string;
}) {
  return (
    <figure className="muscle-figure">
      <svg viewBox="0 0 100 212" role="img" aria-label={summary} className="muscle-figure-svg">
        <defs>
          <pattern id={hatchId} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" fill="rgba(0, 114, 178, 0.14)" />
            <line x1="0" y1="0" x2="0" y2="5" stroke="#0072b2" strokeWidth="1.7" />
          </pattern>
        </defs>
        <g className="muscle-body">
          <path d={NECK_D} />
          <path d={BODY_OUTLINE_D} />
          <circle cx="50" cy="13" r="8.5" />
        </g>
        {order.map((regionId) => {
          const level = paint.regions[regionId];
          const def = regions[regionId];
          if (!level || !def) return null;
          const style =
            level === "primary"
              ? { fill: "#d55e00", stroke: "#8a3c00" }
              : { fill: `url(#${hatchId})`, stroke: "#0072b2" };
          return (
            <g key={regionId} className={`muscle-region muscle-region-${level}`} style={style}>
              <path d={def.d} />
              {def.pair ? <path d={def.d} transform="translate(100 0) scale(-1 1)" /> : null}
            </g>
          );
        })}
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

export function MuscleDiagramView({ mapping }: { mapping: MuscleMapping | undefined }) {
  const rawId = useId();
  const paint = muscleDiagramPaint(mapping);
  if (!paint.available) {
    return <p className="muscle-diagram-empty">暂无肌群图</p>;
  }
  const idSuffix = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const summarize = (viewPaint: MuscleDiagramViewPaint, label: string) => {
    const parts: string[] = [];
    if (viewPaint.primaryNames.length > 0) parts.push(`主要 ${viewPaint.primaryNames.join("、")}`);
    if (viewPaint.secondaryNames.length > 0) parts.push(`次要 ${viewPaint.secondaryNames.join("、")}`);
    return parts.length > 0 ? `${label}肌群图：${parts.join("；")}` : `${label}肌群图：本图无标示肌群`;
  };
  return (
    <div className="muscle-diagram">
      <div className="muscle-figures">
        <BodyFigure
          label="正面"
          regions={FRONT_REGIONS}
          order={FRONT_REGION_ORDER}
          paint={paint.front}
          hatchId={`muscle-hatch-front-${idSuffix}`}
          summary={summarize(paint.front, "正面")}
        />
        <BodyFigure
          label="背面"
          regions={BACK_REGIONS}
          order={BACK_REGION_ORDER}
          paint={paint.back}
          hatchId={`muscle-hatch-back-${idSuffix}`}
          summary={summarize(paint.back, "背面")}
        />
      </div>
      <div className="muscle-legend">
        <p>
          <span className="muscle-swatch muscle-swatch-primary" aria-hidden="true" />
          <span><strong>主要</strong>（实心填充）：{mapping && mapping.primary.length > 0 ? mapping.primary.join("、") : "—"}</span>
        </p>
        <p>
          <span className="muscle-swatch muscle-swatch-secondary" aria-hidden="true" />
          <span><strong>次要</strong>（斜纹描边）：{mapping && mapping.secondary.length > 0 ? mapping.secondary.join("、") : "—"}</span>
        </p>
        {paint.unplaced.length > 0 ? (
          <p className="muscle-legend-unplaced">图中未标示：{paint.unplaced.join("、")}（暂无对应轮廓区域）</p>
        ) : null}
      </div>
    </div>
  );
}
