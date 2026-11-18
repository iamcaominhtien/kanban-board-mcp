#!/usr/bin/env node
// Coverage of the UI by the e2e run, read from a run made with E2E_MEASURE=1:
//   E2E_MEASURE=1 node run.mjs --target rust --keep-going && node measure/report.mjs [--report <folder>]
// Three measures, each with the list of what is not covered:
//   api  — every server call written in ui/src, and whether a step made it (from <report>/rust.json)
//   ui   — every aria-label / placeholder in the components: shown on a page, and acted on (clicked, typed in)
//   code — line, branch and function coverage of ui/src, from the V8 coverage of the pages (needs a ui/dist built
//          with --sourcemap); the chunks the run never loaded count as 0 %
// Writes <report>/measure/summary.md, api-gaps.md, ui-gaps.md, code-files.md, coverage.json and code-html/.
// The UI must be built unminified with source maps, or lines map badly: npx vite build --sourcemap --minify false
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiInventory, uiInventory, templateRegex, labelRegex, sourceFiles } from './inventory.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../..');
const UI_SRC = path.join(REPO, 'ui/src');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const reportDir = path.resolve(opt('report', path.join(here, '../report')));
const target = opt('target', 'rust');
const dist = path.resolve(process.env.E2E_UI_DIST || path.join(REPO, 'ui/dist'));
const outDir = path.join(reportDir, 'measure');
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '100.0');
const rel = (f) => path.relative(REPO, f);

// ---- what the run recorded
const results = JSON.parse(fs.readFileSync(path.join(reportDir, `${target}.json`), 'utf8')).filter(Boolean);
const exchanges = [];
for (const r of results) for (const st of r.steps) for (const ex of st.exchanges || []) exchanges.push({ ...ex, scenario: r.id, step: st.name });
const acts = [];
const seen = new Set();
const v8Files = [];
for (const f of fs.readdirSync(outDir).sort()) {
  if (f.endsWith(`-${target}.acts.json`)) {
    const j = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
    const sc = f.replace(/-[a-z]+\.acts\.json$/, '');
    for (const a of j.acts) acts.push({ ...a, scenario: sc });
    for (const l of j.seen) seen.add(l);
  }
  if (f.endsWith(`-${target}.v8.json`)) v8Files.push(path.join(outDir, f));
}
const failedSteps = results.flatMap((r) => r.steps.filter((s) => s.error).map((s) => `${r.id}: ${s.name}`));

// ---- api
const api = apiInventory(UI_SRC);
const recorded = exchanges.map((e) => ({ ...e, bare: e.path.split('?')[0] })).filter((e) => e.bare !== '/' && e.type !== 'text/html');
const matchedRecorded = new Set();
for (const c of api.calls) {
  const re = templateRegex(c.template);
  const hits = c.method === 'SSE' ? [{ scenario: '*', step: 'always open' }] : recorded.filter((e, i) => {
    if (e.method !== c.method || !re.test(e.bare)) return false;
    matchedRecorded.add(i);
    return true;
  });
  c.hits = hits.length;
  c.by = [...new Set(hits.map((h) => h.scenario))];
}
const notInSource = new Map();
recorded.forEach((e, i) => { if (!matchedRecorded.has(i)) { const k = `${e.method} ${e.bare}`; notInSource.set(k, (notInSource.get(k) || 0) + 1); } });
// a call whose function nothing else names is dead code: listed apart, not counted as a gap
const allSrc = sourceFiles(UI_SRC).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const uses = new Map();
const usedName = (fn) => {
  if (!fn) return true;
  if (!uses.has(fn)) uses.set(fn, (allSrc.match(new RegExp(`\\b${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')) || []).length);
  return uses.get(fn) > 1;
};
for (const c of api.calls) c.unused = c.sites.every((st) => !usedName(st.fn));
const apiTestable = api.calls.filter((c) => c.method !== 'WS' && !c.unused);
const apiHit = apiTestable.filter((c) => c.hits);

// ---- ui labels
const ui = uiInventory(UI_SRC);
const actedNames = new Set(acts.flatMap((a) => a.labels || []));
const actedList = [...actedNames];
const seenList = [...seen];
const byLabel = new Map();
for (const it of ui.items) {
  const k = it.label;
  if (!byLabel.has(k)) byLabel.set(k, { label: k, sites: [] });
  byLabel.get(k).sites.push(`${it.file}:${it.line}`);
}
for (const l of byLabel.values()) {
  const re = labelRegex(l.label);
  l.acted = l.label.includes('\0') ? actedList.some((n) => re.test(n)) : actedNames.has(l.label);
  l.seen = l.acted || (l.label.includes('\0') ? seenList.some((n) => re.test(n)) : seen.has(l.label));
}
const labels = [...byLabel.values()];

// ---- code
let code = null;
try {
  const { CoverageReport } = await import('monocart-coverage-reports');
  const keep = (file) => file.startsWith('src/') && !/\.(test|spec)\.tsx?$/.test(file) && !file.includes('node_modules');
  const mcr = new CoverageReport({
    name: 'UI coverage of the e2e run',
    outputDir: path.join(outDir, 'code-html'),
    reports: ['v8'],
    logging: 'error',
    cleanCache: true,
    // sources from the maps read as ../../src/…; only the UI's own code counts
    sourcePath: (p) => p.replace(/^(\.\.\/)+/, '').replace(/^.*?(?=src\/)/, ''),
    sourceFilter: (p) => keep(p.replace(/^(\.\.\/)+/, '').replace(/^.*?(?=src\/)/, '')),
    entryFilter: (e) => /\/assets\/.*\.js$/.test(e.url),
  });
  const cache = new Map();
  const load = (jsPath) => {
    if (cache.has(jsPath)) return cache.get(jsPath);
    const local = path.join(dist, jsPath.replace(/^\/+/, ''));
    const v = fs.existsSync(local) && fs.existsSync(local + '.map')
      ? { source: fs.readFileSync(local, 'utf8'), sourceMap: JSON.parse(fs.readFileSync(local + '.map', 'utf8')) } : null;
    cache.set(jsPath, v);
    return v;
  };
  const loaded = new Set();
  let noMap = 0;
  for (const f of v8Files) {
    const batch = [];
    for (const e of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      if (!/\/assets\//.test(e.path)) continue;
      const src = load(e.path);
      if (!src) { noMap++; continue; }
      loaded.add(e.path.replace(/^.*\/assets\//, 'assets/'));
      batch.push({ url: `http://ui${e.path}`, source: src.source, sourceMap: src.sourceMap, functions: e.functions });
    }
    if (batch.length) await mcr.add(batch);
  }
  // chunks no page loaded: everything in them is uncovered
  const neverLoaded = [];
  for (const f of fs.readdirSync(path.join(dist, 'assets')).filter((x) => x.endsWith('.js'))) {
    if (loaded.has(`assets/${f}`)) continue;
    const src = load(`/assets/${f}`);
    if (!src) continue;
    neverLoaded.push(f);
    await mcr.add([{ url: `http://ui/assets/${f}`, source: src.source, sourceMap: src.sourceMap, functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: src.source.length, count: 0 }] }] }]);
  }
  const res = await mcr.generate();
  const inMap = new Set(res.files.map((f) => path.join(REPO, 'ui', f.sourcePath)));
  const outsideBundle = sourceFiles(UI_SRC).filter((f) => !inMap.has(f)).map(rel);
  const files = res.files.map((f) => ({ file: 'ui/' + f.sourcePath, s: f.summary }))
    .sort((a, b) => (a.s.lines.pct ?? 0) - (b.s.lines.pct ?? 0) || a.file.localeCompare(b.file));
  const folders = new Map();
  for (const f of files) {
    const parts = f.file.split('/');
    const key = parts.slice(0, Math.min(parts.length - 1, 4)).join('/');
    const g = folders.get(key) || { lines: [0, 0], branches: [0, 0], functions: [0, 0], files: 0 };
    for (const m of ['lines', 'branches', 'functions']) { g[m][0] += f.s[m].covered; g[m][1] += f.s[m].total; }
    g.files++;
    folders.set(key, g);
  }
  code = { total: res.summary, files, folders, neverLoaded, noMap, outsideBundle, runs: v8Files.length };
} catch (e) {
  code = { error: String(e.stack || e) };
}

// ---- write
fs.mkdirSync(outDir, { recursive: true });
const md = [];
md.push(`# UI coverage of the e2e run (${target})`, '');
md.push(`Scenarios: ${results.length}, steps: ${results.reduce((n, r) => n + r.steps.length, 0)}, failed steps: ${failedSteps.length}.`, '');
if (failedSteps.length) md.push('A failed step stops its scenario, so what comes after it is counted as not covered:', '', ...failedSteps.map((s) => `- ${s}`), '');
md.push('| Measure | Covered | Total | % |', '|---|---:|---:|---:|');
md.push(`| Server calls made by a step | ${apiHit.length} | ${apiTestable.length} | ${pct(apiHit.length, apiTestable.length)} |`);
md.push(`| Labelled controls acted on | ${labels.filter((l) => l.acted).length} | ${labels.length} | ${pct(labels.filter((l) => l.acted).length, labels.length)} |`);
md.push(`| Labelled controls shown | ${labels.filter((l) => l.seen).length} | ${labels.length} | ${pct(labels.filter((l) => l.seen).length, labels.length)} |`);
if (code.total) for (const m of ['lines', 'statements', 'branches', 'functions', 'bytes']) if (code.total[m]) md.push(`| Code ${m} (ui/src) | ${code.total[m].covered} | ${code.total[m].total} | ${Number(code.total[m].pct).toFixed(1)} |`);
md.push('');
md.push('Not counted: ' + [
  `${api.dynamic.length} call sites whose URL is not a literal (listed in api-gaps.md)`,
  `${api.calls.filter((c) => c.method === 'WS').length} WebSocket call(s)`,
  `${api.calls.filter((c) => c.unused).length} calls in functions nothing uses (dead code, listed in api-gaps.md)`,
  `${ui.dynamic} labels that are a plain expression`,
].join('; ') + '.', '');
if (code.error) md.push('Code coverage failed: ```' + code.error + '```', '');
else {
  md.push(`Code: ${code.runs} recordings, ${code.neverLoaded.length} chunk(s) never loaded, ${code.outsideBundle.length} source file(s) not in the bundle (type-only modules and the like)${code.noMap ? `, ${code.noMap} script(s) without a source map` : ''}. HTML report: \`measure/code-html/index.html\`.`, '');
  md.push('## Code by folder', '', '| Folder | Files | Lines % | Branches % | Functions % |', '|---|---:|---:|---:|---:|');
  for (const [k, g] of [...code.folders.entries()].sort((a, b) => a[1].lines[0] / (a[1].lines[1] || 1) - b[1].lines[0] / (b[1].lines[1] || 1))) {
    md.push(`| ${k} | ${g.files} | ${pct(...g.lines)} | ${pct(...g.branches)} | ${pct(...g.functions)} |`);
  }
  md.push('');
}
fs.writeFileSync(path.join(outDir, 'summary.md'), md.join('\n') + '\n');

const am = ['# Server calls the e2e run never made', '', 'Grouped by the source file of the call. `fn` is the function it sits in.', ''];
const missing = apiTestable.filter((c) => !c.hits);
const byFile = new Map();
for (const c of missing) { const f = c.sites[0].file; if (!byFile.has(f)) byFile.set(f, []); byFile.get(f).push(c); }
for (const [f, cs] of [...byFile.entries()].sort()) {
  am.push(`## ${f} (${cs.length})`, '');
  for (const c of cs) am.push(`- \`${c.method} ${c.template}\` — ${c.sites.map((s) => `${s.fn || '?'} (${s.file}:${s.line})`).join(', ')}`);
  am.push('');
}
am.push('## Calls in functions nothing in ui/src uses (dead code?)', '', ...api.calls.filter((c) => c.unused).map((c) => `- \`${c.method} ${c.template}\` — ${c.sites.map((st) => `${st.fn} (${st.file}:${st.line})`).join(', ')}${c.hits ? ' (yet a step made it)' : ''}`), '');
am.push('## Call sites with a URL that is not a literal (check by hand)', '', ...api.dynamic.map((d) => `- ${d.method} ${d.file}:${d.line} ${d.fn || ''}`), '');
am.push('## Requests recorded that match no call in ui/src', '', 'Usually a URL built in a way the inventory cannot read; worth a look.', '', ...[...notInSource.entries()].sort().map(([k, n]) => `- \`${k}\` ×${n}`), '');
fs.writeFileSync(path.join(outDir, 'api-gaps.md'), am.join('\n') + '\n');

const um = ['# Labelled controls the e2e run never acted on', '', '"shown" means it was on a page at the end of some step but nothing clicked or typed in it.', ''];
const uiBy = new Map();
for (const l of labels.filter((x) => !x.acted)) { const f = l.sites[0].split(':')[0]; if (!uiBy.has(f)) uiBy.set(f, []); uiBy.get(f).push(l); }
for (const [f, ls] of [...uiBy.entries()].sort()) {
  um.push(`## ${f} (${ls.length})`, '');
  for (const l of ls) um.push(`- ${l.seen ? 'shown' : 'never shown'}: \`${l.label.replace(/\0/g, '…')}\` (${l.sites.join(', ')})`);
  um.push('');
}
const keys = [...new Set(acts.filter((a) => a.kind === 'key').map((a) => a.key))].sort();
um.push('## Keys pressed outside text fields', '', keys.join(', ') || '(none)', '');
fs.writeFileSync(path.join(outDir, 'ui-gaps.md'), um.join('\n') + '\n');

if (code.files) {
  const cm = ['# Code coverage per file (lowest first)', '', '| File | Lines % | Branches % | Functions % | Lines |', '|---|---:|---:|---:|---:|'];
  for (const f of code.files) cm.push(`| ${f.file} | ${pct(f.s.lines.covered, f.s.lines.total)} | ${pct(f.s.branches.covered, f.s.branches.total)} | ${pct(f.s.functions.covered, f.s.functions.total)} | ${f.s.lines.total} |`);
  fs.writeFileSync(path.join(outDir, 'code-files.md'), cm.join('\n') + '\n');
}
fs.writeFileSync(path.join(outDir, 'coverage.json'), JSON.stringify({
  api: { covered: apiHit.length, total: apiTestable.length, missing: missing.map((c) => `${c.method} ${c.template}`) },
  ui: { acted: labels.filter((l) => l.acted).length, seen: labels.filter((l) => l.seen).length, total: labels.length },
  code: code.total || null,
  failedSteps,
}, null, 1));
console.log(fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8').split('## Code by folder')[0]);
