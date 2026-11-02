// H4.1 行为—恢复影响 validation.
// Runs the REAL production pure module (server/src/behavior-impact.ts —
// no imports, all logic exported) over synthetic fixtures only; no real
// health data is ever used. Covers: (1) the 5-tagged-day sample gate
// (below it: sufficient=false and NO differences, even when data
// exists), (2) strict next-day (D → D+1) alignment for both HRV and
// readiness, (3) missing next-day pairs excluded and counted (never
// zero-filled), with HRV/readiness counted independently, (4) the
// baseline comparison (check-in days WITHOUT the tag; days with no
// check-in belong to neither group), and (5) tag parse/serialize
// robustness for legacy/corrupt stored values. Two source mutations
// are executed for real (the 5-day gate deleted, the next-day
// alignment replaced by same-day) and each must flip the
// corresponding assertion. Pure Node, no deps.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const behaviorSrc = readFileSync(new URL('./server/src/behavior-impact.ts', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const schemaSrc = readFileSync(new URL('./server/src/schema.ts', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const migrationSrc = readFileSync(new URL('./drizzle/0018_add_behavior_tags_to_morning_checkin.sql', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}

function buildModule(src) {
  const code = stripTypeScriptTypes(src.replace(/^export /gm, ''));
  return new Function(`${code}\nreturn { computeBehaviorImpact, parseBehaviorTags, serializeBehaviorTags, behaviorDirection, behaviorNextDate, BEHAVIOR_TAGS, BEHAVIOR_MIN_SAMPLE };`)();
}
const { computeBehaviorImpact, parseBehaviorTags, serializeBehaviorTags, behaviorDirection, behaviorNextDate, BEHAVIOR_TAGS, BEHAVIOR_MIN_SAMPLE } = buildModule(behaviorSrc);

const itemFor = (items, tag) => items.find((item) => item.tag === tag);

// ------------------------------------------------------------ source checks
check('source: behavior module has no imports (pure module)', !/^import /m.test(behaviorSrc));
check('source: server imports computeBehaviorImpact from the pure module',
  serverSrc.includes('computeBehaviorImpact') && serverSrc.includes('from "./behavior-impact"'));
check('source: getDashboard response carries the additive behaviorImpact field',
  serverSrc.includes('behaviorImpact: behaviorImpactSchema') && serverSrc.includes('loadBehaviorImpact(ctx, health, readinessDate, todayTags)'));
check('source: schema + migration add the nullable behavior_tags column additively',
  schemaSrc.includes('behaviorTags: text("behavior_tags")')
  && migrationSrc.includes('ALTER TABLE `morning_checkin` ADD COLUMN `behavior_tags` text')
  && !/DROP|DELETE/.test(migrationSrc));
check('source: saveMorningCheckin keeps the owner gate and accepts optional tags on the same path',
  serverSrc.includes('tags: z.array(behaviorTagSchema)') && serverSrc.includes('serializeBehaviorTags(args.tags)'));
check('source: every defineAction carries a v26 description',
  (serverSrc.match(/defineAction\(\{/g) ?? []).length === (serverSrc.match(/description: "/g) ?? []).length,
  `${(serverSrc.match(/defineAction\(\{/g) ?? []).length} actions`);
check('source: client renders the panel, the correlation disclaimer, and the sample gate wording',
  clientSrc.includes('行为—恢复影响') && clientSrc.includes('仅相关性、非因果') && clientSrc.includes('样本不足'));
check('source: client never computes the impact itself and saves tags through saveMorningCheckin',
  !clientSrc.includes('computeBehaviorImpact') && clientSrc.includes('api.saveMorningCheckin({ date: readiness.date, feeling, tags })'));
check('source: preset tags are the five briefed behaviours',
  JSON.stringify(BEHAVIOR_TAGS) === JSON.stringify(['饮酒', '咖啡因', '晚睡', '晚进食', '出差']) && BEHAVIOR_MIN_SAMPLE === 5);

// ------------------------------------------- (4) baseline comparison (main fixture)
// 饮酒 on 10-01..10-05 (exactly the gate), no tag on 10-06..10-10.
// Next-day HRV: tagged outcomes 40 ms, baseline outcomes 50 ms.
// Next-day readiness: tagged outcomes 6.0, baseline outcomes 8.0.
{
  const checkins = [
    ...['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].map((date) => ({ date, tags: ['饮酒'] })),
    ...['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'].map((date) => ({ date, tags: [] })),
  ];
  const daily = [
    { date: '2026-10-02', hrvMs: 40 }, { date: '2026-10-03', hrvMs: 40 }, { date: '2026-10-04', hrvMs: 40 },
    { date: '2026-10-05', hrvMs: 40 }, { date: '2026-10-06', hrvMs: 40 },
    { date: '2026-10-07', hrvMs: 50 }, { date: '2026-10-08', hrvMs: 50 }, { date: '2026-10-09', hrvMs: 50 },
    { date: '2026-10-10', hrvMs: 50 }, { date: '2026-10-11', hrvMs: 50 },
    // A day with NO check-in whose next day carries an extreme HRV:
    // it belongs to neither group and must not move either mean.
    { date: '2026-10-20', hrvMs: 999 }, { date: '2026-10-21', hrvMs: 999 },
  ];
  const readiness = [
    { date: '2026-10-02', score: 6 }, { date: '2026-10-03', score: 6 }, { date: '2026-10-04', score: 6 },
    { date: '2026-10-05', score: 6 }, { date: '2026-10-06', score: 6 },
    { date: '2026-10-07', score: 8 }, { date: '2026-10-08', score: 8 }, { date: '2026-10-09', score: 8 },
    { date: '2026-10-10', score: 8 }, { date: '2026-10-11', score: 8 },
    { date: '2026-10-21', score: 0 },
  ];
  const item = itemFor(computeBehaviorImpact(checkins, daily, readiness), '饮酒');
  check('baseline: tagged-day count and pair counts are exact',
    item.taggedDays === 5 && item.hrvTaggedPairs === 5 && item.hrvBaselinePairs === 5
    && item.readinessTaggedPairs === 5 && item.readinessBaselinePairs === 5
    && item.hrvExcluded === 0 && item.readinessExcluded === 0);
  check('baseline: next-day means compare tagged vs untagged check-in days only',
    item.hrvTaggedMean === 40 && item.hrvBaselineMean === 50 && item.readinessTaggedMean === 6 && item.readinessBaselineMean === 8);
  check('baseline: differences are tagged mean − baseline mean',
    item.hrvDiff === -10 && item.readinessDiff === -2 && item.sufficient === true);
  check('baseline: an untagged behaviour with zero tagged days is insufficient with null differences',
    (() => { const none = itemFor(computeBehaviorImpact(checkins, daily, readiness), '出差'); return none.taggedDays === 0 && none.sufficient === false && none.hrvDiff === null && none.readinessDiff === null; })());
}

// ------------------------------------------------- (1) the 5-day sample gate
{
  const fourDays = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map((date) => ({ date, tags: ['咖啡因'] }));
  const baseline = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'].map((date) => ({ date, tags: [] }));
  const daily = [
    { date: '2026-10-02', hrvMs: 30 }, { date: '2026-10-03', hrvMs: 30 }, { date: '2026-10-04', hrvMs: 30 }, { date: '2026-10-05', hrvMs: 30 },
    { date: '2026-10-07', hrvMs: 60 }, { date: '2026-10-08', hrvMs: 60 }, { date: '2026-10-09', hrvMs: 60 }, { date: '2026-10-10', hrvMs: 60 }, { date: '2026-10-11', hrvMs: 60 },
  ];
  const readiness = daily.map((row) => ({ date: row.date, score: row.hrvMs === 30 ? 5 : 9 }));
  const four = itemFor(computeBehaviorImpact([...fourDays, ...baseline], daily, readiness), '咖啡因');
  check('gate: 4 tagged days is 样本不足 — no differences even though every pair exists',
    four.taggedDays === 4 && four.sufficient === false && four.hrvDiff === null && four.readinessDiff === null
    && four.hrvTaggedPairs === 4 && four.hrvTaggedMean === 30);
  const five = itemFor(computeBehaviorImpact([...fourDays, { date: '2026-10-05', tags: ['咖啡因'] }, ...baseline],
    [...daily, { date: '2026-10-06', hrvMs: 30 }], [...readiness, { date: '2026-10-06', score: 5 }]), '咖啡因');
  check('gate: the 5th tagged day flips the behaviour to sufficient with differences',
    five.taggedDays === 5 && five.sufficient === true && five.hrvDiff === -30 && five.readinessDiff === -4);
}

// ------------------------------------------------- (2) next-day alignment
{
  // Alternating days: tagged on odd dates, baseline on even dates.
  // HRV is 100 on odd dates and 40 on even dates, so the NEXT day of a
  // tagged (odd) day is 40 and of a baseline (even) day is 100:
  // next-day alignment gives −60; same-day alignment would give +60.
  const checkins = [];
  const daily = [];
  const readiness = [];
  for (let day = 1; day <= 11; day++) {
    const date = `2026-10-${String(day).padStart(2, '0')}`;
    daily.push({ date, hrvMs: day % 2 === 1 ? 100 : 40 });
    readiness.push({ date, score: day % 2 === 1 ? 9 : 5 });
    if (day <= 10) checkins.push({ date, tags: day % 2 === 1 ? ['晚睡'] : [] });
  }
  const item = itemFor(computeBehaviorImpact(checkins, daily, readiness), '晚睡');
  check('alignment: outcomes come from D+1, never from D itself',
    item.hrvTaggedMean === 40 && item.hrvBaselineMean === 100 && item.hrvDiff === -60
    && item.readinessTaggedMean === 5 && item.readinessBaselineMean === 9 && item.readinessDiff === -4);
  check('alignment: behaviorNextDate crosses month and year boundaries',
    behaviorNextDate('2026-10-31') === '2026-11-01' && behaviorNextDate('2026-12-31') === '2027-01-01');
}

// --------------------------------------- (3) missing next-day pairs excluded
{
  // 晚进食 on 6 days (10-01..10-06). Next-day HRV missing for 10-04
  // (null) → the 10-03 pair is excluded. Next-day readiness missing
  // for 10-05 (no archive row) and 10-07 (null score) → the 10-04 and
  // 10-06 pairs are excluded. Baseline days 10-07..10-11 all present.
  const checkins = [
    ...['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'].map((date) => ({ date, tags: ['晚进食'] })),
    ...['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'].map((date) => ({ date, tags: [] })),
  ];
  const daily = [
    { date: '2026-10-02', hrvMs: 40 }, { date: '2026-10-03', hrvMs: 40 }, { date: '2026-10-04', hrvMs: null },
    { date: '2026-10-05', hrvMs: 40 }, { date: '2026-10-06', hrvMs: 40 }, { date: '2026-10-07', hrvMs: 40 },
    { date: '2026-10-08', hrvMs: 50 }, { date: '2026-10-09', hrvMs: 50 }, { date: '2026-10-10', hrvMs: 50 },
    { date: '2026-10-11', hrvMs: 50 }, { date: '2026-10-12', hrvMs: 50 },
  ];
  const readiness = [
    { date: '2026-10-02', score: 6 }, { date: '2026-10-03', score: 6 }, { date: '2026-10-04', score: 6 },
    // 2026-10-05 absent entirely
    { date: '2026-10-06', score: 6 }, { date: '2026-10-07', score: null },
    { date: '2026-10-08', score: 8 }, { date: '2026-10-09', score: 8 }, { date: '2026-10-10', score: 8 },
    { date: '2026-10-11', score: 8 }, { date: '2026-10-12', score: 8 },
  ];
  const item = itemFor(computeBehaviorImpact(checkins, daily, readiness), '晚进食');
  check('missing: excluded pairs are counted per metric, independently',
    item.taggedDays === 6 && item.hrvTaggedPairs === 5 && item.hrvExcluded === 1
    && item.readinessTaggedPairs === 4 && item.readinessExcluded === 2);
  check('missing: means divide by surviving pairs only — missing is never 0',
    item.hrvTaggedMean === 40 && item.readinessTaggedMean === 6 && item.hrvDiff === -10 && item.readinessDiff === -2);
  const noBaseline = itemFor(computeBehaviorImpact(checkins.slice(0, 6), daily, readiness), '晚进食');
  check('missing: with no baseline pairs the difference is null, never 0 or invented',
    noBaseline.sufficient === true && noBaseline.hrvBaselinePairs === 0 && noBaseline.hrvDiff === null && noBaseline.readinessDiff === null);
}

// ------------------------------------------------- (5) tag parse / serialize
{
  check('tags: legacy null and empty stored values read as no tags',
    parseBehaviorTags(null).length === 0 && parseBehaviorTags(undefined).length === 0 && parseBehaviorTags('').length === 0);
  check('tags: unknown values and duplicates are dropped, known tags keep canonical order',
    JSON.stringify(parseBehaviorTags('["晚睡","未知","饮酒","晚睡"]')) === JSON.stringify(['饮酒', '晚睡']));
  check('tags: malformed JSON and non-array payloads degrade to no tags',
    parseBehaviorTags('{oops').length === 0 && parseBehaviorTags('"饮酒"').length === 0 && parseBehaviorTags('[1,2]').length === 0);
  check('tags: serialize keeps only known tags, deduped, in canonical order',
    serializeBehaviorTags(['晚睡', '饮酒', '晚睡', '未知']) === '["饮酒","晚睡"]' && serializeBehaviorTags([]) === '[]');
  check('direction: symbols pair with words (▲ higher / ▼ lower / ● flat / — no data)',
    behaviorDirection(2).symbol === '▲' && behaviorDirection(-2).symbol === '▼'
    && behaviorDirection(0).symbol === '●' && behaviorDirection(null).symbol === '—');
}

// ------------------------------------------------------- mutation sensitivity
{
  const gateMutant = buildModule(behaviorSrc.replace('taggedDates.length >= BEHAVIOR_MIN_SAMPLE', 'true'));
  const fourDays = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map((date) => ({ date, tags: ['咖啡因'] }));
  const baseline = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'].map((date) => ({ date, tags: [] }));
  const daily = [
    { date: '2026-10-02', hrvMs: 30 }, { date: '2026-10-03', hrvMs: 30 }, { date: '2026-10-04', hrvMs: 30 }, { date: '2026-10-05', hrvMs: 30 },
    { date: '2026-10-07', hrvMs: 60 }, { date: '2026-10-08', hrvMs: 60 }, { date: '2026-10-09', hrvMs: 60 }, { date: '2026-10-10', hrvMs: 60 }, { date: '2026-10-11', hrvMs: 60 },
  ];
  const readiness = daily.map((row) => ({ date: row.date, score: row.hrvMs === 30 ? 5 : 9 }));
  const realFour = itemFor(computeBehaviorImpact([...fourDays, ...baseline], daily, readiness), '咖啡因');
  const mutantFour = itemFor(gateMutant.computeBehaviorImpact([...fourDays, ...baseline], daily, readiness), '咖啡因');
  check('mutation: deleting the 5-day gate flips the 样本不足 assertion',
    realFour.sufficient === false && realFour.hrvDiff === null
    && mutantFour.sufficient === true && mutantFour.hrvDiff === -30);

  const alignMutant = buildModule(behaviorSrc.replace('lookup.get(behaviorNextDate(date))', 'lookup.get(date)'));
  const checkins = [];
  const altDaily = [];
  const altReadiness = [];
  for (let day = 1; day <= 11; day++) {
    const date = `2026-10-${String(day).padStart(2, '0')}`;
    altDaily.push({ date, hrvMs: day % 2 === 1 ? 100 : 40 });
    altReadiness.push({ date, score: day % 2 === 1 ? 9 : 5 });
    if (day <= 10) checkins.push({ date, tags: day % 2 === 1 ? ['晚睡'] : [] });
  }
  const realAligned = itemFor(computeBehaviorImpact(checkins, altDaily, altReadiness), '晚睡');
  const mutantAligned = itemFor(alignMutant.computeBehaviorImpact(checkins, altDaily, altReadiness), '晚睡');
  check('mutation: scrambling next-day alignment to same-day flips the alignment assertion',
    realAligned.hrvDiff === -60 && mutantAligned.hrvDiff === 60);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
