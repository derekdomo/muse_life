// H4.2 训练负荷平衡 (ACWR) validation.
// Runs the REAL production pure module (server/src/acwr.ts — no imports,
// all logic exported) over synthetic fixtures only; no real health data
// is ever used. Covers: (1) 7-day / 28-day window boundaries (inclusive
// edges, outside and future dates excluded), (2) ACWR computation for
// volume and duration, (3) the four Garmin band thresholds with their
// symbols, (4) insufficient-history labelling (「仅 X 天数据」) with the
// chronic average divided by observed days only — never zero-padded,
// (5) per-workout unit conversion (1 lb = 0.45359237 kg), (6) completed
// workouts only, (7) missing duration staying missing, and (8) a zero
// chronic load yielding a null ratio, never 0. Three source mutations
// are executed for real (threshold branch moved, history note deleted,
// chronic divisor replaced by the full 28) and each must flip the
// corresponding assertion. Pure Node, no deps.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const acwrSrc = readFileSync(new URL('./server/src/acwr.ts', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}

function buildModule(src) {
  const code = stripTypeScriptTypes(src.replace(/^export /gm, ''));
  return new Function(`${code}\nreturn { computeAcwr, acwrBandFor, convertAcwrVolume, acwrShiftDate, ACWR_ACUTE_DAYS, ACWR_CHRONIC_DAYS };`)();
}
const { computeAcwr, acwrBandFor, convertAcwrVolume } = buildModule(acwrSrc);

// ------------------------------------------------------------ source checks
check('source: acwr module has no imports (pure module)', !/^import /m.test(acwrSrc));
check('source: server imports computeAcwr from the pure module',
  serverSrc.includes('import { computeAcwr, type AcwrResult } from "./acwr";'));
check('source: getDashboard response carries the additive acwr field',
  serverSrc.includes('acwr: acwrSchema.nullable()') && serverSrc.includes('buildAcwr(snapshot.strengthTraining, snapshot.dataDate)'));
check('source: every defineAction carries a v26 description',
  (serverSrc.match(/defineAction\(\{/g) ?? []).length === (serverSrc.match(/description: "/g) ?? []).length,
  `${(serverSrc.match(/defineAction\(\{/g) ?? []).length} actions`);
check('source: client renders the ACWR panel and the Garmin caliber disclosure',
  clientSrc.includes('训练负荷平衡（ACWR）') && clientSrc.includes('Garmin 公开 Training Load 口径') && clientSrc.includes('ACWR = 急性日均 ÷ 慢性日均'));
check('source: client renders the server history note and never computes ACWR itself',
  clientSrc.includes('acwr.historyNote') && !clientSrc.includes('computeAcwr'));

// ------------------------------------------------------------ fixtures
const AS_OF = '2026-10-28'; // acute 10-22..10-28, chronic 10-01..10-28
const w = (date, totalVolume, extra = {}) => ({
  date, status: 'completed', durationMinutes: 60, totalVolume, unit: 'lb', ...extra,
});
const dailySeries = (start, days, volume, duration = 60) => {
  const out = [];
  let date = start;
  for (let i = 0; i < days; i++) {
    out.push(w(date, volume, { durationMinutes: duration }));
    const next = new Date(`${date}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    date = next.toISOString().slice(0, 10);
  }
  return out;
};

// ------------------------------------------------- (1) window boundaries
{
  const r = computeAcwr([
    w('2026-10-22', 700), // acute edge (asOf - 6): acute + chronic
    w('2026-10-21', 700), // chronic only
    w('2026-10-01', 700), // chronic edge (asOf - 27): chronic only
    w('2026-09-30', 9999), // one day before the chronic window: excluded
    w('2026-10-29', 9999), // after asOf: excluded
  ], AS_OF, 'lb', '2026-10-01');
  check('boundaries: acute edge counts in acute, day before chronic start and future dates excluded',
    r.sessionsAcute === 1 && r.sessionsChronic === 3 && r.acuteVolumeTotal === 700 && r.chronicVolumeTotal === 2100);
  check('boundaries: window dates and full observation days reported',
    r.acuteWindowStart === '2026-10-22' && r.chronicWindowStart === '2026-10-01' && r.acuteDays === 7 && r.chronicDays === 28);
  check('boundaries: full 28-day history is not labelled insufficient',
    r.insufficientHistory === false && r.historyNote === null);
  check('boundaries: daily averages divide window totals by observed days',
    r.acuteVolumeDailyAvg === 100 && r.chronicVolumeDailyAvg === 75 && r.volumeAcwr === 1.33);
}

// ------------------------------------------------- (2) ACWR computation
{
  const uniform = computeAcwr(dailySeries('2026-10-01', 28, 100), AS_OF, 'lb', '2026-10-01');
  check('acwr: uniform load gives volume and duration ACWR exactly 1',
    uniform.volumeAcwr === 1 && uniform.durationAcwr === 1 && uniform.volumeBand?.band === '适宜');
  const doubled = computeAcwr([
    ...dailySeries('2026-10-01', 21, 100),
    ...dailySeries('2026-10-22', 7, 200),
  ], AS_OF, 'lb', '2026-10-01');
  check('acwr: doubled acute week against the 28-day average gives 1.6',
    doubled.chronicVolumeDailyAvg === 125 && doubled.acuteVolumeDailyAvg === 200 && doubled.volumeAcwr === 1.6 && doubled.volumeBand?.band === '过高');
}

// ------------------------------------------------- (3) four band thresholds
{
  check('bands: <0.8 is 不足 with ▼', acwrBandFor(0.79)?.band === '不足' && acwrBandFor(0.79)?.symbol === '▼');
  check('bands: 0.8 and 1.3 are 适宜 with ● (edges inclusive)',
    acwrBandFor(0.8)?.band === '适宜' && acwrBandFor(1.3)?.band === '适宜' && acwrBandFor(0.8)?.symbol === '●');
  check('bands: >1.3 through 1.5 is 偏高 with ▲',
    acwrBandFor(1.31)?.band === '偏高' && acwrBandFor(1.5)?.band === '偏高' && acwrBandFor(1.5)?.symbol === '▲');
  check('bands: >1.5 is 过高 with ◆', acwrBandFor(1.51)?.band === '过高' && acwrBandFor(1.51)?.symbol === '◆');
  check('bands: null ratio has no band', acwrBandFor(null) === null);
}

// --------------------------------------- (4) insufficient history, no zero-fill
{
  const r = computeAcwr([
    w('2026-10-20', 1000),
    w('2026-10-27', 1000),
  ], AS_OF, 'lb', '2026-10-19');
  check('insufficient: 10 observed days are labelled 「仅 10 天数据」',
    r.chronicDays === 10 && r.insufficientHistory === true && r.historyNote === '仅 10 天数据');
  check('insufficient: chronic average divides by the 10 observed days, never by 28',
    r.chronicVolumeDailyAvg === 200 && r.chronicVolumeTotal === 2000);
  check('insufficient: acute window keeps its full 7 observed days when history covers it',
    r.acuteDays === 7 && r.acuteVolumeDailyAvg === 142.86 && r.volumeAcwr === 0.71 && r.volumeBand?.band === '不足');
  const clipped = computeAcwr([w('2026-10-27', 500)], AS_OF, 'lb', '2026-10-25');
  check('insufficient: a 4-day history clips both windows to 4 observed days',
    clipped.acuteDays === 4 && clipped.chronicDays === 4 && clipped.historyNote === '仅 4 天数据' && clipped.volumeAcwr === 1);
  const none = computeAcwr([], AS_OF, 'lb', '2026-10-19');
  check('insufficient: no workouts in the window yields hasData false and a null ratio, never 0',
    none.hasData === false && none.volumeAcwr === null && none.chronicDays === 10);
}

// ------------------------------------------------- (5) unit conversion
{
  check('units: convertAcwrVolume uses 1 lb = 0.45359237 kg both ways',
    Math.abs(convertAcwrVolume(100, 'lb', 'kg') - 45.359237) < 1e-9
    && Math.abs(convertAcwrVolume(45.359237, 'kg', 'lb') - 100) < 1e-9
    && convertAcwrVolume(100, 'kg', 'kg') === 100);
  const kgView = computeAcwr([w('2026-10-27', 1000)], AS_OF, 'kg', '2026-10-01');
  check('units: a 1000 lb workout totals 453.59 in a kg display',
    kgView.chronicVolumeTotal === 453.59 && kgView.acuteVolumeTotal === 453.59);
  const mixed = computeAcwr([
    w('2026-10-27', 1000),
    w('2026-10-26', 100, { unit: 'kg' }),
  ], AS_OF, 'kg', '2026-10-01');
  check('units: mixed-unit workouts are converted per workout before summing',
    mixed.chronicVolumeTotal === 553.59);
}

// --------------------------------------- (6) completed only / (7) missing duration / (8) zero load
{
  const withActive = computeAcwr([
    w('2026-10-27', 1000),
    w('2026-10-27', 5000, { status: 'active' }),
  ], AS_OF, 'lb', '2026-10-01');
  check('completed-only: an active workout contributes no sessions, volume, or duration',
    withActive.sessionsAcute === 1 && withActive.acuteVolumeTotal === 1000 && withActive.acuteDurationTotal === 60);
  const missingDuration = computeAcwr([
    w('2026-10-27', 1000, { durationMinutes: null }),
  ], AS_OF, 'lb', '2026-10-01');
  check('missing duration: duration totals and ratio stay null while volume still computes',
    missingDuration.acuteDurationTotal === null && missingDuration.durationAcwr === null
    && missingDuration.acuteDurationMissing === 1 && missingDuration.volumeAcwr !== null);
  const zeroLoad = computeAcwr([w('2026-10-27', 0)], AS_OF, 'lb', '2026-10-01');
  check('zero chronic load: ratio and band are null (数据不足), never 0 or infinite',
    zeroLoad.volumeAcwr === null && zeroLoad.volumeBand === null && zeroLoad.hasData === true);
}

// ------------------------------------------------------- mutation sensitivity
{
  const thresholdMutant = buildModule(acwrSrc.replace('ratio <= 1.3', 'ratio <= 1.1'));
  check('mutation: moving the 适宜/偏高 threshold flips the band at 1.2',
    acwrBandFor(1.2)?.band === '适宜' && thresholdMutant.acwrBandFor(1.2)?.band === '偏高');
  const noteMutant = buildModule(acwrSrc.replace('insufficientHistory ? `仅 ${chronicDays} 天数据` : null', 'null'));
  const fixture = [w('2026-10-20', 1000), w('2026-10-27', 1000)];
  check('mutation: deleting the insufficient-history note flips the label assertion',
    computeAcwr(fixture, AS_OF, 'lb', '2026-10-19').historyNote === '仅 10 天数据'
    && noteMutant.computeAcwr(fixture, AS_OF, 'lb', '2026-10-19').historyNote === null);
  const padMutant = buildModule(acwrSrc.replace('chronicVolumeRaw / chronicDays', 'chronicVolumeRaw / ACWR_CHRONIC_DAYS'));
  check('mutation: dividing the chronic average by the full 28 flips the no-zero-padding assertion',
    computeAcwr(fixture, AS_OF, 'lb', '2026-10-19').chronicVolumeDailyAvg === 200
    && padMutant.computeAcwr(fixture, AS_OF, 'lb', '2026-10-19').chronicVolumeDailyAvg === 71.43);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
