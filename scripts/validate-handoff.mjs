import { execFileSync, spawnSync } from 'node:child_process';
import { Script } from 'node:vm';

// Read committed blobs, never the working tree. No dependencies or model calls.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const fail = message => { console.error(message); process.exit(1); };
const resolve = ref => git('rev-parse', '--verify', `${ref}^{commit}`).trim();
const head = resolve(process.argv[3] || 'HEAD');
const requestedBase = process.argv[2];
let base;
if (requestedBase && !/^0+$/.test(requestedBase)) {
  base = resolve(requestedBase); // Invalid refs must fail rather than skip a range.
} else {
  const parent = spawnSync('git', ['rev-parse', '--verify', `${head}^`], { encoding: 'utf8' });
  base = parent.status === 0 ? parent.stdout.trim() : git('hash-object', '-t', 'tree', '/dev/null').trim();
}
git('diff', '--check', base, head);
const files = git('diff', '--name-only', '-z', base, head).split('\0').filter(Boolean);
const present = new Set(git('ls-tree', '-r', '--name-only', '-z', head).split('\0'));
const blob = file => git('show', `${head}:${file}`);
let checkedScripts = 0;
for (const file of files.filter(file => present.has(file))) {
  if (!/\.(?:md|json|[cm]?js|ts|tsx|html|css|ya?ml|sh)$/.test(file)) continue;
  const source = blob(file);
  if (/^(?:<{7} |={7}$|>{7} )/m.test(source)) fail(`Conflict marker in ${file}`);
  if (file.endsWith('.json')) JSON.parse(source);
  if (/\.[cm]?js$/.test(file)) {
    const result = spawnSync(process.execPath, ['--check', '--input-type=' + (file.endsWith('.cjs') ? 'commonjs' : 'module')], { input: source, encoding: 'utf8' });
    if (result.status !== 0) fail(`Syntax error in ${file}: ${result.stderr}`);
    checkedScripts++;
  }
  if (file.endsWith('.html')) {
    for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const [, attributes, code] = match;
      if (/\bsrc\s*=/i.test(attributes) || /\btype\s*=\s*["'](?:application\/ld\+json|application\/json|importmap)["']/i.test(attributes)) continue;
      if (/\btype\s*=\s*["']module["']/i.test(attributes)) {
        const result = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: code, encoding: 'utf8' });
        if (result.status !== 0) fail(`Module syntax error in ${file}: ${result.stderr}`);
      } else new Script(code, { filename: file });
      checkedScripts++;
    }
  }
}
const added = git('diff', '--no-ext-diff', '--unified=0', base, head)
  .split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
// This is a narrow accidental-secret check, not a complete privacy scanner.
if (/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,})/.test(added)) fail('Possible secret in added lines; sanitize before handoff.');
const business = files.filter(file => !file.endsWith('.md') && !file.startsWith('.github/') && !file.startsWith('scripts/'));
if (business.length) {
  if (!files.includes('changes.md') || !present.has('changes.md')) fail('Implementation must update changes.md.');
  const evidence = git('diff', '--unified=0', base, head, '--', 'changes.md')
    .split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  const ids = [...new Set(evidence.match(/\b(?:[A-Z]+\d+(?:\.\d+)?|[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+-\d+|[A-Z]+-\d+)\b/g) || [])];
  const plans = blob('plans.md');
  if (!ids.length || !ids.some(id => plans.includes('`' + id + '`') || plans.includes(id + ' —') || plans.includes(id + ' ·'))) fail('Added changes.md evidence must cite an existing plans.md requirement ID.');
}
console.log(`Handoff checks passed: ${files.length} changed files, ${checkedScripts} scripts checked, ${business.length} implementation files. PM acceptance and runtime review remain separate.`);
