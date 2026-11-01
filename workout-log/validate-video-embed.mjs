// Teaching-video embed validation (2026-11-01) — the 9 guides with
// no photo/video-frame demo embed their already-listed YouTube
// teaching video in the guide dialog's demonstration slot. Runs the
// REAL production youtubeEmbedUrl extracted verbatim from
// client/src/App.tsx, plus source wiring checks:
//  - each of the 9 no-demo guides' stored watch URLs converts to
//    the official https://www.youtube.com/embed/{id} endpoint with
//    the exact video id from DATA-PLAN.md;
//  - shorts / youtu.be / embed URL shapes also resolve; non-YouTube
//    hosts, missing ids and garbage input return null (the dialog
//    then falls back to the plain outbound link, unchanged);
//  - wiring: the embed is computed only when the guide has a video
//    and NO demo, renders between the frame demo and the outbound
//    video link (which is retained verbatim as the fallback), uses
//    the standard embed sandbox token set, lazy loading, no-referrer
//    and a titled iframe; guides WITH a demo never embed.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const themeCss = readFileSync(new URL('./client/src/theme.css', import.meta.url), 'utf8');

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
function extractFunctionEnd(source, name) {
  const idx = source.search(new RegExp(`function ${name}\\(`));
  if (idx < 0) throw new Error(`function ${name} not found`);
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  const bodyStart = source.indexOf('{', closeParen);
  return matchDelim(source, bodyStart, '{', '}') + 1;
}

// --- the real function, evaluated verbatim -------------------------
const fnStart = clientSrc.indexOf('export function youtubeEmbedUrl');
const fnEnd = extractFunctionEnd(clientSrc, 'youtubeEmbedUrl');
const fnCode = stripTypeScriptTypes(clientSrc.slice(fnStart, fnEnd).replace(/^export /, ''));
const youtubeEmbedUrl = new Function(`${fnCode}; return youtubeEmbedUrl;`)();

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
  const urlMatch = block.match(/video: "(https:\/\/www\.youtube\.com\/watch\?v=[^"]+)"/);
  check(`${key}: guide carries a YouTube watch URL and no frame demo`,
    Boolean(urlMatch) && !block.includes('demo:'));
  check(`${key}: stored URL embeds as the official /embed/${id}`,
    urlMatch != null && youtubeEmbedUrl(urlMatch[1]) === `https://www.youtube.com/embed/${id}`,
    urlMatch ? youtubeEmbedUrl(urlMatch[1]) : 'no url');
}

// --- URL shape behaviour -------------------------------------------
check('shorts URL resolves to its embed endpoint',
  youtubeEmbedUrl('https://www.youtube.com/shorts/UAlGHwshYBM') === 'https://www.youtube.com/embed/UAlGHwshYBM');
check('youtu.be URL resolves to its embed endpoint',
  youtubeEmbedUrl('https://youtu.be/qFEBNu4vwSg') === 'https://www.youtube.com/embed/qFEBNu4vwSg');
check('an /embed/ URL passes through unchanged',
  youtubeEmbedUrl('https://www.youtube.com/embed/qFEBNu4vwSg') === 'https://www.youtube.com/embed/qFEBNu4vwSg');
check('watch URL with extra params still resolves by v=',
  youtubeEmbedUrl('https://www.youtube.com/watch?v=qFEBNu4vwSg&t=12s') === 'https://www.youtube.com/embed/qFEBNu4vwSg');
check('non-YouTube host returns null',
  youtubeEmbedUrl('https://vimeo.com/123456789') === null);
check('watch URL without v= returns null',
  youtubeEmbedUrl('https://www.youtube.com/watch') === null);
check('garbage input returns null instead of throwing',
  youtubeEmbedUrl('not a url') === null);

// --- dialog wiring ---------------------------------------------------
const dialogStart = clientSrc.indexOf('function ExerciseGuideDialog');
const dialogEnd = clientSrc.indexOf('\nfunction ', dialogStart + 10);
const dialog = clientSrc.slice(dialogStart, dialogEnd > 0 ? dialogEnd : undefined);
check('wiring: embed URL is computed only for a video guide with no frame demo',
  dialog.includes('const videoEmbedUrl = !guide.demo && guide.video ? youtubeEmbedUrl(guide.video) : null;'));
check('wiring: frame demo line is unchanged and still first',
  dialog.includes('{guide.demo ? <ExerciseDemoView demo={guide.demo} name={guide.title} /> : null}'));
const demoAt = dialog.indexOf('<ExerciseDemoView demo={guide.demo}');
const embedAt = dialog.indexOf('className="guide-video-embed"');
const linkAt = dialog.indexOf('className="video-link"');
const cuesAt = dialog.indexOf('记住这三点');
check('wiring: embed renders in the demo slot — after the frame demo, before the outbound link and the cue points',
  demoAt >= 0 && embedAt > demoAt && linkAt > embedAt && cuesAt > linkAt);
check('wiring: outbound YouTube link is retained verbatim as the no-frame fallback',
  dialog.includes('{guide.video ? (') && dialog.includes('在 YouTube 打开'));
check('wiring: iframe carries the standard embed sandbox token set',
  dialog.includes('sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"'));
check('wiring: iframe is lazy, no-referrer, fullscreen-capable and titled with the exercise name',
  dialog.includes('loading="lazy"')
  && dialog.includes('referrerPolicy="no-referrer"')
  && dialog.includes('allowFullScreen')
  && dialog.includes('title={`${guide.title} · 真人教学视频（内嵌播放）`}'));
check('wiring: embed box is a fixed 16/9 frame in theme.css (no layout shift)',
  themeCss.includes('.video-embed-media { position: relative; aspect-ratio: 16 / 9;')
  && themeCss.includes('.video-embed-media iframe { position: absolute; inset: 0;'));

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
