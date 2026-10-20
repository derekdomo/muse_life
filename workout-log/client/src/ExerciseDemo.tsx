// Looping exercise demonstrations for every exercise guide in the
// training plan (home routines + gym Push/Pull/Legs). All demos are
// start/end photo pairs that crossfade in a loop; the bytes are owned
// by the artifact (client/src/assets). Two sources:
//
// - "free-exercise-db": real photo pairs from the Open Public Domain
//   Exercise Dataset (Unlicense — license text verified in the repo's
//   LICENSE.md on 2026-10-19; every pair was eyeballed against the
//   movement before use).
// - "ai": AI-generated photorealistic pairs (2026-10-19, replacing
//   the former hand-drawn stick-figure animations at the owner's
//   request). Each pair was generated as one diptych (same person,
//   clothing, camera and setting across the two frames), then checked
//   frame by frame against the guide's cues — joint angles, body
//   alignment, bench/equipment use — before being split into two
//   frames and shipped. Rejected during review: prone Y-T-W v1
//   (head/feet orientation inverted), home Bulgarian split squat v1
//   (rear foot left the bench in the bottom frame), overhead press
//   v1–v2 (bar behind the neck instead of at the upper chest).
//   Calf raise failed review in 4 consecutive generations (feet off
//   the step edge, extra shoe artifact, bent knees at the top, feet
//   floating above the step), so BOTH calf-raise guides ship with
//   text cues only — no image rather than a wrong demonstration.

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
import aiChinTuck0 from "./assets/demo-ai-chin-tuck-0.jpg";
import aiChinTuck1 from "./assets/demo-ai-chin-tuck-1.jpg";
import aiProneYtw0 from "./assets/demo-ai-prone-ytw-0.jpg";
import aiProneYtw1 from "./assets/demo-ai-prone-ytw-1.jpg";
import aiThoracic0 from "./assets/demo-ai-thoracic-extension-0.jpg";
import aiThoracic1 from "./assets/demo-ai-thoracic-extension-1.jpg";
import aiSingleLeg0 from "./assets/demo-ai-single-leg-balance-0.jpg";
import aiSingleLeg1 from "./assets/demo-ai-single-leg-balance-1.jpg";
import aiHomeBulgarian0 from "./assets/demo-ai-home-bulgarian-0.jpg";
import aiHomeBulgarian1 from "./assets/demo-ai-home-bulgarian-1.jpg";
import aiTibialis0 from "./assets/demo-ai-tibialis-raise-0.jpg";
import aiTibialis1 from "./assets/demo-ai-tibialis-raise-1.jpg";
import aiWallSit0 from "./assets/demo-ai-wall-sit-0.jpg";
import aiWallSit1 from "./assets/demo-ai-wall-sit-1.jpg";
import aiOverheadPress0 from "./assets/demo-ai-overhead-press-0.jpg";
import aiOverheadPress1 from "./assets/demo-ai-overhead-press-1.jpg";
import aiLateralRaise0 from "./assets/demo-ai-lateral-raise-0.jpg";
import aiLateralRaise1 from "./assets/demo-ai-lateral-raise-1.jpg";
import aiWideRow0 from "./assets/demo-ai-wide-row-0.jpg";
import aiWideRow1 from "./assets/demo-ai-wide-row-1.jpg";
import aiReversePecDeck0 from "./assets/demo-ai-reverse-pec-deck-0.jpg";
import aiReversePecDeck1 from "./assets/demo-ai-reverse-pec-deck-1.jpg";
import aiPushUpPlus0 from "./assets/demo-ai-push-up-plus-0.jpg";
import aiPushUpPlus1 from "./assets/demo-ai-push-up-plus-1.jpg";

export type ExerciseDemo = {
  kind: "photos";
  frames: readonly [string, string];
  wide: boolean;
  ratio?: string;
  caption: string;
};

const REAL_PHOTO_CAPTION = "真人示范照片，起始 ↔ 结束两帧循环播放 · 来源 free-exercise-db（Unlicense 公共领域）";
const AI_CAPTION = "AI 生成真人风示范图，起始 ↔ 结束两帧循环播放 · 已逐帧按动作要点核对";

function realPhotos(frames: readonly [string, string], wide: boolean, ratio?: string): ExerciseDemo {
  return { kind: "photos", frames, wide, ratio, caption: REAL_PHOTO_CAPTION };
}

function aiPhotos(frames: readonly [string, string], ratio: string, caption: string = AI_CAPTION): ExerciseDemo {
  return { kind: "photos", frames, wide: false, ratio, caption };
}

export const EXERCISE_DEMOS: Record<string, ExerciseDemo> = {
  // Home A · posture — AI pairs replace the stick figures (2026-10-19).
  "supine-chin-tuck": aiPhotos([aiChinTuck0, aiChinTuck1], "3 / 4"),
  // Y-T-W has three shapes; the pair shows Y ↔ W and the T position
  // (arms straight out to the sides) is the midpoint between them.
  "prone-ytw": aiPhotos([aiProneYtw0, aiProneYtw1], "3 / 4", "AI 生成真人风示范图，Y 形 ↔ W 形两帧循环播放（T 形是中间过渡：手臂向两侧平举） · 已逐帧按动作要点核对"),
  "side-external-rotation": realPhotos([extRotation0, extRotation1], false),
  "thoracic-extension": aiPhotos([aiThoracic0, aiThoracic1], "1 / 1"),
  // Home B · snowboard.
  "single-leg-balance": aiPhotos([aiSingleLeg0, aiSingleLeg1], "3 / 4"),
  "home-bulgarian-split-squat": aiPhotos([aiHomeBulgarian0, aiHomeBulgarian1], "1 / 1"),
  "bench-step-up": realPhotos([stepUp0, stepUp1], false),
  "tibialis-raise": aiPhotos([aiTibialis0, aiTibialis1], "3 / 4"),
  "wall-sit": aiPhotos([aiWallSit0, aiWallSit1], "1 / 1"),
  "dead-bug": realPhotos([deadBug0, deadBug1], true),
  "side-plank": realPhotos([sideBridge0, sideBridge1], false),
  // No "home-calf-raise" / "calf-raise" entries: see the header note —
  // no generated pair passed frame review, so those guides are
  // text-only rather than showing a wrong demonstration.
  // Gym Push / Pull / Legs. Photo pairs are the free-exercise-db
  // entries named in DATA-PLAN.md, each verified frame by frame;
  // "ai" pairs replace the stick figures as noted above.
  "barbell-bench": realPhotos([benchPress0, benchPress1], false),
  "overhead-press": aiPhotos([aiOverheadPress0, aiOverheadPress1], "3 / 4"),
  "incline-dumbbell-press": realPhotos([inclinePress0, inclinePress1], false),
  dips: realPhotos([dips0, dips1], false),
  "lateral-raise": aiPhotos([aiLateralRaise0, aiLateralRaise1], "1 / 1"),
  "push-up-plus": aiPhotos([aiPushUpPlus0, aiPushUpPlus1], "3 / 4"),
  "wide-lat-pulldown": realPhotos([widePulldown0, widePulldown1], false),
  "close-lat-pulldown": realPhotos([underhandPulldown0, underhandPulldown1], false),
  "close-seated-row": realPhotos([seatedRow0, seatedRow1], false),
  "wide-seated-row": aiPhotos([aiWideRow0, aiWideRow1], "3 / 4"),
  "face-pull": realPhotos([facePull0, facePull1], false),
  "reverse-pec-deck": aiPhotos([aiReversePecDeck0, aiReversePecDeck1], "1 / 1"),
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
