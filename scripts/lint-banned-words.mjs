// banned-words:ignore-file  (this file defines the rules, so it contains the words)
// Banned-word lint (PRD 4.4, F9b-AC1). Flags unhedged claims in product source and copy.
// Hedged wording such as "may have leaked" and negated wording such as "not guaranteed" is allowed.
// Escape hatches: put `banned-words:ignore` on a line, or `banned-words:ignore-file` in the first 5 lines.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEDGE_BEFORE = /\b(?:may|might|could|possibly|potentially)\b[^.!?\n]{0,24}$/i;
const NEGATION_BEFORE = /\b(?:not|never|no|cannot|can't|can’t|isn't|isn’t|aren't|aren’t|without|nor)\b[^.!?\n]{0,24}$/i;

export const RULES = [
  { id: 'will-delete', re: /\bwill\s+(?:be\s+)?delete[d]?\b/gi, message: 'promises deletion; say what we ask for, not what will happen' },
  { id: 'guaranteed', re: /\bguaranteed\b/gi, allowIfBefore: NEGATION_BEFORE, message: 'claims a guarantee' },
  { id: 'compliant', re: /\b(?:non-?compliant|compliant)\b/gi, message: 'compliance is a legal conclusion; use the neutral response labels' },
  { id: 'legal-accusation', re: /\b(?:violating|illegal)\b/gi, message: 'legal accusation; use neutral wording' },
  { id: 'data-safe', re: /\byour data is safe\b/gi, message: 'unsupported safety claim' },
  { id: 'leaked', re: /\bleaked\b/gi, allowIfBefore: HEDGE_BEFORE, message: 'states a leak as fact; hedge it ("may have shared", "may have leaked")' },
];

export function findViolations(text, rules = RULES) {
  const head = text.split('\n', 5).join('\n');
  if (head.includes('banned-words:ignore-file')) return [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const lines = text.split('\n');
  const out = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const before = text.slice(Math.max(0, m.index - 60), m.index);
      if (rule.allowIfBefore && rule.allowIfBefore.test(before)) continue;
      const line = lineOf(m.index);
      if (lines[line].includes('banned-words:ignore')) continue;
      out.push({ rule: rule.id, line: line + 1, match: m[0], message: rule.message });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.mdx', '.html', '.css', '.py', '.yml', '.yaml', '.toml', '.sql', '.txt']);
const SKIP_DIR = new Set(['node_modules', '.next', 'dist', '.turbo', '.venv', 'coverage', '.git', '__pycache__', 'screens', '_runtime', 'openapi', 'migrations']);
// docs/design/source is design reference, not shipped copy. Known wording drift there is listed in docs/OPEN-QUESTIONS.md.
const SCAN_ROOTS = ['apps', 'packages', 'services', 'README.md', 'docs/design/README.md'];

function* walk(p) {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) { if (TEXT_EXT.has(path.extname(p))) yield p; return; }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.isDirectory() && SKIP_DIR.has(e.name)) continue;
    yield* walk(path.join(p, e.name));
  }
}

export function lintRepo(root) {
  const results = [];
  for (const r of SCAN_ROOTS) {
    for (const file of walk(path.join(root, r))) {
      const v = findViolations(fs.readFileSync(file, 'utf8'));
      if (v.length) results.push({ file: path.relative(root, file).split(path.sep).join('/'), violations: v });
    }
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const results = lintRepo(root);
  for (const { file, violations } of results)
    for (const v of violations) console.error(`${file}:${v.line}  [${v.rule}] "${v.match}" - ${v.message}`);
  if (results.length) { console.error(`\nBanned-word lint failed: ${results.reduce((n, r) => n + r.violations.length, 0)} problem(s).`); process.exit(1); }
  console.log('Banned-word lint passed.');
}
