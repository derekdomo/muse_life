// Looping exercise demonstrations for the exercise guides in the
// training plan (home routines + gym Push/Pull/Legs). All demos are
// start/end frame pairs that crossfade in a loop; the bytes are owned
// by the artifact (client/src/assets). Sources:
//
// - "free-exercise-db": real photo pairs from the Open Public Domain
//   Exercise Dataset (Unlicense — license text verified in the repo's
//   LICENSE.md on 2026-10-19; every pair was eyeballed against the
//   movement before use).
// - "video": still frames extracted from real, cleanly licensed
//   demonstration videos (Pexels free license / Wikimedia Commons
//   CC BY 3.0) — same video, same person for both frames of a pair,
//   each pair checked frame by frame against the guide's cues before
//   shipping (2026-10-19 replacement of the AI-generated pairs, which
//   the owner rejected: several had the movement direction wrong).
//   Full source URLs, licenses and frame timestamps are recorded in
//   DATA-PLAN.md.
//
// Movements with NO demo image (text cues only) — no accurate pair
// could be sourced: supine chin tuck, prone Y-T-W, thoracic extension
// over a bench edge, single-leg balance taps, home Bulgarian split
// squat, tibialis raise against a wall, wall sit, reverse pec deck
// and serratus push-up plus. Near-misses were rejected rather than
// shipped: seated presses for the standing barbell press, a forward
// pec-deck fly for the reverse (rear-delt) version, regular push-ups
// (bent elbows) for the straight-arm push-up plus, a band dorsiflexion
// drill for the wall tibialis raise, and a foam-roller roll-out for
// the bench-edge thoracic extension. See DATA-PLAN.md for the full
// rejection log.

import extRotation0 from "./assets/demo-external-rotation-0.jpg";
import extRotation1 from "./assets/demo-external-rotation-1.jpg";
import stepUp0 from "./assets/demo-step-up-0.jpg";
import stepUp1 from "./assets/demo-step-up-1.jpg";
import deadBug0 from "./assets/demo-dead-bug-0.jpg";
import deadBug1 from "./assets/demo-dead-bug-1.jpg";
import sideBridge0 from "./assets/demo-side-bridge-0.jpg";
import sideBridge1 from "./assets/demo-side-bridge-1.jpg";
import benchPress0 from "./assets/demo-bench-press-0.jpg";
import benchPress1 from "./assets/demo-bench-press-1.jpg";
import inclinePress0 from "./assets/demo-incline-press-0.jpg";
import inclinePress1 from "./assets/demo-incline-press-1.jpg";
import dips0 from "./assets/demo-dips-0.jpg";
import dips1 from "./assets/demo-dips-1.jpg";
import widePulldown0 from "./assets/demo-wide-pulldown-0.jpg";
import widePulldown1 from "./assets/demo-wide-pulldown-1.jpg";
import underhandPulldown0 from "./assets/demo-underhand-pulldown-0.jpg";
import underhandPulldown1 from "./assets/demo-underhand-pulldown-1.jpg";
import seatedRow0 from "./assets/demo-seated-row-0.jpg";
import seatedRow1 from "./assets/demo-seated-row-1.jpg";
import facePull0 from "./assets/demo-face-pull-0.jpg";
import facePull1 from "./assets/demo-face-pull-1.jpg";
import ropeCurl0 from "./assets/demo-rope-curl-0.jpg";
import ropeCurl1 from "./assets/demo-rope-curl-1.jpg";
import squat0 from "./assets/demo-squat-0.jpg";
import squat1 from "./assets/demo-squat-1.jpg";
import rdl0 from "./assets/demo-rdl-0.jpg";
import rdl1 from "./assets/demo-rdl-1.jpg";
import legCurl0 from "./assets/demo-leg-curl-0.jpg";
import legCurl1 from "./assets/demo-leg-curl-1.jpg";
import bulgarianGym0 from "./assets/demo-bulgarian-gym-0.jpg";
import bulgarianGym1 from "./assets/demo-bulgarian-gym-1.jpg";
import videoOverheadPress0 from "./assets/demo-video-overhead-press-0.jpg";
import videoOverheadPress1 from "./assets/demo-video-overhead-press-1.jpg";
import videoLateralRaise0 from "./assets/demo-video-lateral-raise-0.jpg";
import videoLateralRaise1 from "./assets/demo-video-lateral-raise-1.jpg";
import videoWideRow0 from "./assets/demo-video-wide-row-0.jpg";
import videoWideRow1 from "./assets/demo-video-wide-row-1.jpg";
import videoCalfRaise0 from "./assets/demo-video-calf-raise-0.jpg";
import videoCalfRaise1 from "./assets/demo-video-calf-raise-1.jpg";

export type ExerciseDemo = {
  kind: "photos";
  frames: readonly [string, string];
  wide: boolean;
  ratio?: string;
  caption: string;
};

const REAL_PHOTO_CAPTION = "真人示范照片，起始 ↔ 结束两帧循环播放 · 来源 free-exercise-db（Unlicense 公共领域）";
const PEXELS_CAPTION = "真人视频截帧，起始 ↔ 结束两帧循环播放 · 来源 Pexels 免费授权视频";
const COMMONS_PRESS_CAPTION = "真人视频截帧，起始 ↔ 结束两帧循环播放 · 来源 Wikimedia Commons / FitnessScape（CC BY 3.0）";

function realPhotos(frames: readonly [string, string], wide: boolean, ratio?: string): ExerciseDemo {
  return { kind: "photos", frames, wide, ratio, caption: REAL_PHOTO_CAPTION };
}

function videoPhotos(frames: readonly [string, string], ratio: string, caption: string): ExerciseDemo {
  return { kind: "photos", frames, wide: false, ratio, caption };
}

export const EXERCISE_DEMOS: Record<string, ExerciseDemo> = {
  // Home A · posture. Only side-external-rotation has a sourced pair;
  // chin tuck / prone Y-T-W / thoracic extension are text-only (see
  // the header note and DATA-PLAN.md).
  "side-external-rotation": realPhotos([extRotation0, extRotation1], false),
  // Home B · snowboard.
  "bench-step-up": realPhotos([stepUp0, stepUp1], false),
  "dead-bug": realPhotos([deadBug0, deadBug1], true),
  "side-plank": realPhotos([sideBridge0, sideBridge1], false),
  // Calf raise (gym "calf-raise" and home "home-calf-raise" share the
  // movement): stills from one Pexels video — forefoot on a step edge,
  // heels dropped into the stretch ↔ raised onto the toes, knees
  // straight throughout.
  "calf-raise": videoPhotos([videoCalfRaise0, videoCalfRaise1], "3 / 4", PEXELS_CAPTION),
  "home-calf-raise": videoPhotos([videoCalfRaise0, videoCalfRaise1], "3 / 4", PEXELS_CAPTION),
  // Gym Push / Pull / Legs. Photo pairs are the free-exercise-db
  // entries named in DATA-PLAN.md, each verified frame by frame;
  // "video" pairs are the licensed video stills named there.
  "barbell-bench": realPhotos([benchPress0, benchPress1], false),
  // Standing barbell press, back view: bar on the upper chest ↔
  // locked out overhead. Frames are cropped to the top band of the
  // source video to exclude its burned-in caption box (the movement
  // itself is untouched).
  "overhead-press": videoPhotos([videoOverheadPress0, videoOverheadPress1], "1280 / 496", COMMONS_PRESS_CAPTION),
  "incline-dumbbell-press": realPhotos([inclinePress0, inclinePress1], false),
  dips: realPhotos([dips0, dips1], false),
  // Standing dumbbell lateral raise, front view: arms at the sides ↔
  // raised to exactly shoulder height, no shrug.
  "lateral-raise": videoPhotos([videoLateralRaise0, videoLateralRaise1], "16 / 9", PEXELS_CAPTION),
  "wide-lat-pulldown": realPhotos([widePulldown0, widePulldown1], false),
  "close-lat-pulldown": realPhotos([underhandPulldown0, underhandPulldown1], false),
  "close-seated-row": realPhotos([seatedRow0, seatedRow1], false),
  // Seated cable row with a wide curved bar: arms extended ↔ bar
  // pulled to the lower ribs with the elbows travelling back and out.
  "wide-seated-row": videoPhotos([videoWideRow0, videoWideRow1], "16 / 9", PEXELS_CAPTION),
  "face-pull": realPhotos([facePull0, facePull1], false),
  "rope-curl": realPhotos([ropeCurl0, ropeCurl1], false),
  "back-squat": realPhotos([squat0, squat1], false),
  "romanian-deadlift": realPhotos([rdl0, rdl1], false),
  // The dataset's "Split Squat with Dumbbells" pair IS the Bulgarian
  // split squat (rear foot on a bench, dumbbells at the sides) — the
  // gym template's loaded version. The pair is portrait, hence ratio.
  "bulgarian-split-squat": realPhotos([bulgarianGym0, bulgarianGym1], false, "3 / 4"),
  "lying-leg-curl": realPhotos([legCurl0, legCurl1], false),
};

export function ExerciseDemoView({ demo, name }: { demo: ExerciseDemo; name: string }) {
  return (
    <div className="guide-demo">
      <div className="demo-media" style={{ aspectRatio: demo.ratio ?? (demo.wide ? "16 / 9" : "3 / 2") }}>
        <img className="frame-a" src={demo.frames[0]} alt={`${name}示范起始位置`} />
        <img className="frame-b" src={demo.frames[1]} alt="" aria-hidden="true" />
      </div>
      <p className="demo-caption">{demo.caption}</p>
    </div>
  );
}
