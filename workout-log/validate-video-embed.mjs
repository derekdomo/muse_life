// Teaching-video embed REMOVAL validation (2026-11-01, W6.2-LOCAL-DEMO-001)
// — the YouTube iframe embed added earlier on 2026-11-01 was removed
// at the owner's instruction ("我不想嵌入YouTube，只要想你之前加的
// 那种简单动图就好了"). The guide dialog is back to local demos only:
// guides with real frames play the local dual-frame loop, and the 9
// guides without a demo image show text cues plus the retained
// outbound 「看真人教学视频」 link card — no player placeholder.
// This validator asserts:
//  - no iframe anywhere in the client source, no youtube.com/embed
//    reference, no youtubeEmbedUrl helper, no videoEmbedUrl wiring;
//  - no .guide-video-embed / .video-embed-media styles remain;
//  - each of the 9 no-demo guides still carries its original YouTube
//    watch URL and no frame demo (URLs unchanged);
//  - the dialog retains the frame-demo rendering and the outbound
//    video-link card verbatim, with no embed block between them;
//  - the dialog makes zero third-party media requests: no iframe,
//    no embed src, no remote thumbnail / cover loading.
import { readFileSync } from 'node:fs';

const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const themeCss = readFileSync(new URL('./client/src/theme.css', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}

// --- removal: no embed machinery remains ---------------------------
check('removal: no youtubeEmbedUrl helper in client source',
  !clientSrc.includes('youtubeEmbedUrl'));
check('removal: no videoEmbedUrl wiring in client source',
  !clientSrc.includes('videoEmbedUrl'));
check('removal: no guide-video-embed block in client source',
  !clientSrc.includes('guide-video-embed'));
check('removal: no youtube.com/embed reference in client source',
  !clientSrc.includes('youtube.com/embed') && !clientSrc.includes('/embed/'));
check('removal: no <iframe anywhere in client source',
  !/<iframe[\s>]/.test(clientSrc));
check('removal: no .guide-video-embed style in theme.css',
  !themeCss.includes('.guide-video-embed'));
check('removal: no .video-embed-media style in theme.css',
  !themeCss.includes('.video-embed-media'));
check('removal: no iframe selector in theme.css',
  !themeCss.includes('iframe'));

// --- the 9 no-demo guides: key -> YouTube id (DATA-PLAN.md) --------
const NINE = {
  'supine-chin-tuck': 'qFEBNu4vwSg',
  'prone-ytw': 'QdGTI4Lshg4',
  'thoracic-extension': '81kPLsMt6wY',
  'single-leg-balance': 'QOUYmI6Snqs',
  'home-bulgarian-split-squat': 'hiLF_pF3EJM',
  'tibialis-raise': 'VzIcGAgBiaM',
  'wall-sit': 'RG7z0P9qrLk',
  'reverse-pec-deck': '5YK4bgzXDp0',
  'push-up-plus': 'huGj4aBk9C4',
};

function guideBlock(key) {
  const start = clientSrc.indexOf(`"${key}": {`);
  if (start < 0) return '';
  const end = clientSrc.indexOf('\n  },', start);
  return clientSrc.slice(start, end > start ? end : undefined);
}

for (const [key, id] of Object.entries(NINE)) {
  const block = guideBlock(key);
  check(`${key}: guide still carries its original YouTube watch URL (id ${id}) and no frame demo`,
    block.includes(`video: "https://www.youtube.com/watch?v=${id}"`) && !block.includes('demo:'));
  check(`${key}: guide retains its text cues`,
    block.includes('cues:') && block.includes('setup:'));
}

// --- dialog wiring: text + retained outbound link only -------------
const dialogStart = clientSrc.indexOf('function ExerciseGuideDialog');
const dialogEnd = clientSrc.indexOf('\n// --- W-UI-001', dialogStart + 10);
const dialog = clientSrc.slice(dialogStart, dialogEnd > 0 ? dialogEnd : undefined);
check('wiring: frame demo line is unchanged and still rendered',
  dialog.includes('{guide.demo ? <ExerciseDemoView demo={guide.demo} name={guide.title} /> : null}'));
check('wiring: outbound YouTube link card is retained verbatim',
  dialog.includes('{guide.video ? (') && dialog.includes('className="video-link"')
  && dialog.includes('看真人教学视频') && dialog.includes('在 YouTube 打开'));
check('wiring: no embed block between the frame demo and the outbound link',
  (() => {
    const demoAt = dialog.indexOf('<ExerciseDemoView demo={guide.demo}');
    const linkAt = dialog.indexOf('className="video-link"');
    const between = demoAt >= 0 && linkAt > demoAt ? dialog.slice(demoAt, linkAt) : '';
    return demoAt >= 0 && linkAt > demoAt && !between.includes('iframe') && !between.includes('embed');
  })());
check('wiring: dialog contains no iframe, embed src, or remote cover/thumbnail',
  !dialog.includes('<iframe') && !dialog.includes('youtube.com/embed')
  && !dialog.includes('i.ytimg.com') && !dialog.includes('img.youtube.com'));
check('wiring: dialog cue sections are intact',
  dialog.includes('记住这三点') && dialog.includes('常见错误') && dialog.includes('起始位置'));
check('zero third-party media: client source loads no remote image/media for guides',
  !clientSrc.includes('i.ytimg.com') && !clientSrc.includes('img.youtube.com')
  && !clientSrc.includes('googlevideo.com'));

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
