// W6.2 validation — guide-dialog muscle diagram (front/back body
// outlines painted from MUSCLE_MAP only). Runs the REAL production
// code extracted verbatim from client/src/MuscleDiagram.tsx
// (MUSCLE_NAME_REGIONS, FRONT/BACK_REGIONS + orders, emptyViewPaint,
// muscleDiagramPaint) and client/src/App.tsx (MUSCLE_MAP) over
// synthetic mappings only, plus source wiring checks:
//  - coverage: every muscle name used anywhere in MUSCLE_MAP has a
//    region entry, and every referenced region id exists in the
//    matching view's region table and draw order — so all 30 mapped
//    exercises produce an available diagram with nothing unplaced;
//  - overlap: two names sharing one region （肩前束/肩中束 -> front
//    deltoid) resolve to PRIMARY when either claim is primary, and a
//    name listed as both primary and secondary paints primary and is
//    never also reported as a secondary name;
//  - unknown key: an undefined mapping (custom/unknown exercise key)
//    is unavailable, and a mapping whose names have no region entry
//    is unavailable with the names reported unplaced — never guessed;
//  - back-only exercise （小腿）: front stays empty, diagram still
//    available from the back view alone;
//  - wiring: the guide dialog renders MuscleDiagramView from the
//    same MUSCLE_MAP entry and the 暂无肌群图 text state exists.
//  - hierarchy (guide info order): title -> demonstration (real
//    photo/video frames) or teaching-video link -> cue points, and
//    the primary/secondary muscle text + MuscleDiagramView moved
//    into a default-collapsed 「练到哪里」 disclosure whose expanded
//    panel shows both; closing the dialog only clears the selected
//    guide, so an in-progress workout draft/timer is untouched.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const diagramSrc = readFileSync(new URL('./client/src/MuscleDiagram.tsx', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}
function matchDelim(s, start, open, close) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced delimiters');
}
function extractConstObject(source, name) {
  const idx = source.search(new RegExp(`const ${name}\\s*:`));
  if (idx < 0) throw new Error(`const ${name} not found`);
  const bodyStart = source.indexOf('{', idx);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}
function extractConstArray(source, name) {
  const idx = source.search(new RegExp(`const ${name}\\s*=`));
  if (idx < 0) throw new Error(`const ${name} not found`);
  const bodyStart = source.indexOf('[', idx);
  const bodyEnd = matchDelim(source, bodyStart, '[', ']');
  return source.slice(idx, bodyEnd + 1);
}
function extractFunctionEnd(source, name) {
  const idx = source.search(new RegExp(`function ${name}\\(`));
  if (idx < 0) throw new Error(`function ${name} not found`);
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  const bodyStart = source.indexOf('{', closeParen);
  return matchDelim(source, bodyStart, '{', '}') + 1;
}

// Region tables + orders are standalone consts; the name->region
// table through muscleDiagramPaint is one contiguous chunk (type
// declarations in between are erased by stripTypeScriptTypes).
const chunkStart = diagramSrc.indexOf('const MUSCLE_NAME_REGIONS');
const chunkEnd = extractFunctionEnd(diagramSrc, 'muscleDiagramPaint');
const code = [
  extractConstObject(diagramSrc, 'FRONT_REGIONS'),
  extractConstObject(diagramSrc, 'BACK_REGIONS'),
  extractConstArray(diagramSrc, 'FRONT_REGION_ORDER'),
  extractConstArray(diagramSrc, 'BACK_REGION_ORDER'),
  diagramSrc.slice(chunkStart, chunkEnd),
  extractConstObject(clientSrc, 'MUSCLE_MAP'),
].join('\n').replace(/^export /gm, '');
const {
  FRONT_REGIONS, BACK_REGIONS, FRONT_REGION_ORDER, BACK_REGION_ORDER,
  MUSCLE_NAME_REGIONS, muscleDiagramPaint, MUSCLE_MAP,
} = new Function(
  `${stripTypeScriptTypes(code)}\nreturn { FRONT_REGIONS, BACK_REGIONS, FRONT_REGION_ORDER, BACK_REGION_ORDER, MUSCLE_NAME_REGIONS, muscleDiagramPaint, MUSCLE_MAP };`,
)();

// --- D0: coverage of the real map --------------------------------
{
  const usedNames = new Set();
  for (const entry of Object.values(MUSCLE_MAP)) {
    for (const name of [...entry.primary, ...entry.secondary]) usedNames.add(name);
  }
  const uncovered = [...usedNames].filter((name) => !(name in MUSCLE_NAME_REGIONS));
  check('D0 coverage: every muscle name used in MUSCLE_MAP has a region entry', uncovered.length === 0, uncovered.join(','));
  const badRefs = [];
  for (const [name, entry] of Object.entries(MUSCLE_NAME_REGIONS)) {
    for (const id of entry.front ?? []) if (!(id in FRONT_REGIONS)) badRefs.push(`${name}->front:${id}`);
    for (const id of entry.back ?? []) if (!(id in BACK_REGIONS)) badRefs.push(`${name}->back:${id}`);
  }
  check('D0 coverage: every referenced region id exists in its view table', badRefs.length === 0, badRefs.join(','));
  const orderMismatch =
    [...FRONT_REGION_ORDER].sort().join() !== Object.keys(FRONT_REGIONS).sort().join()
    || [...BACK_REGION_ORDER].sort().join() !== Object.keys(BACK_REGIONS).sort().join();
  check('D0 coverage: draw orders list exactly the region ids of each view', !orderMismatch);
  const unavailable = [];
  const withUnplaced = [];
  for (const [key, entry] of Object.entries(MUSCLE_MAP)) {
    const paint = muscleDiagramPaint(entry);
    if (!paint.available) unavailable.push(key);
    if (paint.unplaced.length > 0) withUnplaced.push(key);
  }
  check('D0 coverage: all 30 mapped exercises produce an available diagram', unavailable.length === 0, unavailable.join(','));
  check('D0 coverage: no mapped exercise leaves a muscle name unplaced', withUnplaced.length === 0, withUnplaced.join(','));
}

// --- D1: primary/secondary overlap on a shared region ------------
{
  const shared = muscleDiagramPaint({ primary: ['肩中束'], secondary: ['肩前束'] });
  check('D1 overlap: 肩前束（次要）+肩中束（主要）share the front deltoid -> region paints PRIMARY',
    shared.front.regions['delt-front'] === 'primary');
  const both = muscleDiagramPaint({ primary: ['胸'], secondary: ['胸', '核心'] });
  check('D1 overlap: a name in BOTH lists （胸） paints primary on its region',
    both.front.regions.pec === 'primary');
  check('D1 overlap: that name is reported as a primary name only, never also secondary',
    both.front.primaryNames.includes('胸') && !both.front.secondaryNames.includes('胸'));
  check('D1 overlap: the genuine secondary （核心） still paints secondary front (abs) and back (lower-back)',
    both.front.regions.abs === 'secondary' && both.back.regions['lower-back'] === 'secondary');
}

// --- D2: unknown key / unplaceable names are never guessed -------
{
  const unknownKey = muscleDiagramPaint(undefined);
  check('D2 unknown key: undefined mapping (custom exercise) -> diagram unavailable -> 暂无肌群图',
    unknownKey.available === false);
  const unknownName = muscleDiagramPaint({ primary: ['不存在的肌群'], secondary: [] });
  check('D2 unknown name: a muscle name with no region entry -> unavailable, reported unplaced, nothing painted',
    unknownName.available === false
    && unknownName.unplaced.join() === '不存在的肌群'
    && Object.keys(unknownName.front.regions).length === 0
    && Object.keys(unknownName.back.regions).length === 0);
  const mixed = muscleDiagramPaint({ primary: ['胸', '不存在的肌群'], secondary: [] });
  check('D2 mixed: known names still paint; the unknown one is only reported unplaced',
    mixed.available === true && mixed.front.regions.pec === 'primary' && mixed.unplaced.join() === '不存在的肌群');
}

// --- D3: back-only and front-only exercises ----------------------
{
  const calf = muscleDiagramPaint(MUSCLE_MAP['calf-raise']);
  check('D3 back-only: calf-raise paints calves PRIMARY on the back, front stays empty, still available',
    calf.available === true
    && calf.back.regions.calves === 'primary'
    && Object.keys(calf.front.regions).length === 0);
  const curl = muscleDiagramPaint(MUSCLE_MAP['rope-curl']);
  check('D3 front-only: rope-curl paints biceps PRIMARY on the front, back stays empty',
    curl.available === true
    && curl.front.regions.biceps === 'primary'
    && Object.keys(curl.back.regions).length === 0);
}

// --- D4: real exercises end to end --------------------------------
{
  const bench = muscleDiagramPaint(MUSCLE_MAP['barbell-bench']);
  check('D4 bench: front pec PRIMARY, front deltoid + back triceps SECONDARY (hatch)',
    bench.front.regions.pec === 'primary'
    && bench.front.regions['delt-front'] === 'secondary'
    && bench.back.regions.triceps === 'secondary');
  const press = muscleDiagramPaint(MUSCLE_MAP['overhead-press']);
  check('D4 press: front deltoid PRIMARY （肩前束+肩中束）, back triceps SECONDARY',
    press.front.regions['delt-front'] === 'primary' && press.back.regions.triceps === 'secondary');
  const plank = muscleDiagramPaint(MUSCLE_MAP['side-plank']);
  check('D4 side-plank: front obliques + abs PRIMARY, back glutes SECONDARY',
    plank.front.regions.obliques === 'primary'
    && plank.front.regions.abs === 'primary'
    && plank.back.regions.glutes === 'secondary');
  const ytw = muscleDiagramPaint(MUSCLE_MAP['prone-ytw']);
  check('D4 prone-ytw: back traps + rear deltoid PRIMARY, rhomboids + erectors SECONDARY',
    ytw.back.regions['traps-back'] === 'primary'
    && ytw.back.regions['delt-back'] === 'primary'
    && ytw.back.regions.rhomboids === 'secondary'
    && ytw.back.regions.erectors === 'secondary');
}

// --- D5: wiring ----------------------------------------------------
{
  check('D5 wiring: App.tsx imports MuscleDiagramView from ./MuscleDiagram',
    clientSrc.includes('import { MuscleDiagramView } from "./MuscleDiagram";'));
  const dialogStart = clientSrc.indexOf('function ExerciseGuideDialog');
  const dialogEnd = clientSrc.indexOf('\nfunction ', dialogStart + 10);
  const dialog = clientSrc.slice(dialogStart, dialogEnd > 0 ? dialogEnd : undefined);
  check('D5 wiring: the guide dialog renders <MuscleDiagramView mapping={muscleMapping} /> from its MUSCLE_MAP entry',
    dialog.includes('<MuscleDiagramView mapping={muscleMapping} />'));
  check('D5 wiring: MuscleDiagram.tsx carries the 暂无肌群图 text state',
    diagramSrc.includes('暂无肌群图'));
  check('D5 wiring: the diagram paints solid primary + hatch secondary from Okabe-Ito colours',
    diagramSrc.includes('#d55e00') && diagramSrc.includes('#0072b2') && diagramSrc.includes('patternUnits="userSpaceOnUse"'));
  check('D5 wiring: the legend names 主要（实心填充）and 次要（斜纹描边）in text',
    diagramSrc.includes('主要') && diagramSrc.includes('实心填充') && diagramSrc.includes('次要') && diagramSrc.includes('斜纹描边'));
}

// --- D6: guide hierarchy — demo/video first, cues next, muscles --
// --- collapsed under 「练到哪里」 --------------------------------
{
  const dialogStart = clientSrc.indexOf('function ExerciseGuideDialog');
  const dialogEnd = clientSrc.indexOf('\nfunction ', dialogStart + 10);
  const dialog = clientSrc.slice(dialogStart, dialogEnd > 0 ? dialogEnd : undefined);
  const at = (needle) => dialog.indexOf(needle);
  const titleAt = at('id="guide-title"');
  const demoAt = at('<ExerciseDemoView demo={guide.demo}');
  const videoAt = at('className="video-link"');
  const cuesAt = at('记住这三点');
  const toggleAt = at('<span>练到哪里</span>');
  const primaryTextAt = at('主要：{muscleMapping.primary');
  const diagramAt = at('<MuscleDiagramView mapping={muscleMapping} />');
  check('D6 order: title renders before the demonstration block',
    titleAt >= 0 && demoAt > titleAt);
  check('D6 order: demonstration (photo/video frames) renders before the cue points',
    demoAt >= 0 && cuesAt > demoAt);
  check('D6 order: teaching-video link entry renders before the cue points (no-frame guides lead with it)',
    videoAt >= 0 && cuesAt > videoAt);
  check('D6 order: cue points render before the 「练到哪里」 section',
    cuesAt >= 0 && toggleAt > cuesAt);
  check('D6 order: primary/secondary muscle text moved below the 「练到哪里」 toggle',
    primaryTextAt > toggleAt && at('次要：{muscleMapping.secondary') > toggleAt);
  check('D6 order: MuscleDiagramView moved below the 「练到哪里」 toggle',
    diagramAt > toggleAt);
  check('D6 collapse: muscle section state starts collapsed (useState(false))',
    dialog.includes('const [musclesOpen, setMusclesOpen] = useState(false);'));
  check('D6 collapse: toggle button is wired with aria-expanded + aria-controls to the panel id',
    dialog.includes('aria-expanded={musclesOpen}')
    && dialog.includes('aria-controls={musclesPanelId}')
    && dialog.includes('id={musclesPanelId}'));
  check('D6 collapse: toggle flips the state on click',
    dialog.includes('onClick={() => setMusclesOpen((open) => !open)}'));
  const panelAt = at('{musclesOpen ? (');
  check('D6 collapse: muscle text + diagram render only inside the expanded panel (after the musclesOpen gate)',
    panelAt > toggleAt && primaryTextAt > panelAt && diagramAt > panelAt);
  check('D6 collapse: toggle label carries visible 展开/收起 text state, not colour or icon alone',
    dialog.includes('musclesOpen ? "收起 ▲" : "展开 ▼"'));
  check('D6 no-image guides: demo stays conditional on guide.demo and the video link on guide.video (text cues + link preserved, nothing generated)',
    dialog.includes('{guide.demo ? <ExerciseDemoView demo={guide.demo} name={guide.title} /> : null}')
    && dialog.includes('{guide.video ? ('));
  check('D6 close safety: closing the guide only clears the selected guide (workout draft/timer state lives outside the dialog)',
    clientSrc.includes('onClose={() => setSelectedGuide(null)}')
    && !dialog.includes('api.'));
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
