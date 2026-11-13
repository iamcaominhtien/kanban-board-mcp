// Compare two runs (python, rust) and write report/diff.md.
import fs from 'node:fs';
import path from 'node:path';

const MAX_DETAIL = 6;

function jsonDiff(a, b, p = '$', out = [], skip = () => false) {
  if (skip(p)) return out;
  if (out.length >= 8) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const isO = (x) => x && typeof x === 'object';
  if (!isO(a) || !isO(b) || Array.isArray(a) !== Array.isArray(b)) {
    out.push({ path: p, py: a, rs: b });
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push({ path: p + '.length', py: a.length, rs: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) jsonDiff(a[i], b[i], `${p}[${i}]`, out, skip);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    if (!(k in a)) out.push({ path: `${p}.${k}`, py: '(absent)', rs: b[k] });
    else if (!(k in b)) out.push({ path: `${p}.${k}`, py: a[k], rs: '(absent)' });
    else jsonDiff(a[k], b[k], `${p}.${k}`, out, skip);
  }
  return out;
}

// Differences that are by design and carry no meaning for parity.
// JSON paths that carry timings, file sizes and library versions; they differ on every run or by design.
const NOISE_PATH = /\.(?:took_ms|latency_ms|modified)$|^\$\.(?:size|version|sqlite_file\.size)$/;
// Per scenario: requests, JSON paths and screen lines that depend on timing (debounced autosaves, the order in which
// refetches finish), with the reason.
const NOISE = {
  // the description autosave is debounced: whether it fires between two uploads depends on how fast the step runs
  '04-attachments': { requests: [/^PATCH \/tickets\//], paths: [/activity_log/, /description$/], text: [/^Activity — \d+ changes$/, /^ATTACHMENTS · \d+$/, /^in Description$/, /^COMMENTS$/] },
  '07-drawings': { requests: [/^PATCH \/tickets\//], paths: [/activity_log/, /description$/], text: [/^Activity — \d+ changes$/, /^ATTACHMENTS · \d+$/] },
  '03-tickets': { requests: [], paths: [], text: [] },
  // the order in which the editor lists the references of a page in the resolve call depends on render order
  '05-docs': { requests: [/^POST \/projects\/[^/]+\/docs\/resolve$/, /^GET \/docs\/pages\/[^/]+\/versions\/\d+\/diff\/\d+$/], paths: [], text: [] },
  // a canvas is saved by a debounced autosave and by Done: which of the two carries the note differs per run
  '07-drawings#canvas': { requests: [/^PATCH \/canvases\//], paths: [], text: [] },
  // the centre marks rows read by itself after a while
  '09-notifications': { requests: [/^POST \/notifications\/read/], paths: [/^\$\.read$/], text: [] },
};
const noiseOf = (id) => {
  const a = NOISE[id] || { requests: [], paths: [], text: [] }, b = NOISE[id + '#canvas'] || { requests: [], paths: [], text: [] };
  return { requests: [...a.requests, ...b.requests], paths: [...a.paths, ...b.paths], text: [...a.text, ...b.text] };
};

const IGNORE_BODY = new Set(['GET /version', 'GET /version?']); // the two servers report their own release number

const key = (e) => `${e.method} ${e.path.split('?')[0]}`;
const short = (v) => { const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v); return s && s.length > 160 ? s.slice(0, 157) + '...' : s; };

function groupEx(list) {
  const m = new Map();
  for (const e of list) {
    const k = `${key(e)}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(e);
  }
  return m;
}

// Requests of the AI team routes, which the Rust server does not serve yet (the UI then hides or degrades the AI
// controls): reported once at the end of diff.md, never per step.
const AI_GAP = /\/ai\/|\/api\/idea-ai\/|\/ai-|\/ai$/;
// Lines of the screen that exist only because the AI routes answer (buttons and tabs of the AI controls).
const TOAST = /is still in the history|^View history$|^Undo$|^(?:Draft saved on this computer|Not yet saved to the ticket)$|^(?:Mentioned in this ticket|Link a doc)$|^(?:Published v\d+ ·|Restored v\d+ as|Page created|Created [A-Z]+-\d+$|Kept “|Archived “|Moved “|Added IDEA-)/;
const AI_TEXT = /\bAI\b|^…$|^(Ask AI|Ctrl J|Board health|AI|AI runs|Run options|AI activity|Ask|Schedules|\d+|Suggest with AI|Draft more|Shape with AI|Open chat|Get advice|AI help|AI advice in triage|Weekly digest|Write it now|Hide)$|^Chat with Idea AI|^Idea AI can read|^Weekly grooming|^AI advice is on/;

const keyQ = (e) => `${e.method} ${e.path}`;

function compareText(a, b, diffs, noise) {
  const sa2 = a.snapshot || {}, sb2 = b.snapshot || {};
  for (const r of new Set([...Object.keys(sa2), ...Object.keys(sb2)])) {
    if (r === 'url') continue;
    const clean = (l) => l.replace(/^[\d.]+ [KMG]?B · (?=.*tables)/, '');
    const keep = (l) => !AI_TEXT.test(l) && !TOAST.test(l) && !noise.text.some((re) => re.test(l));
    const la = (sa2[r] || []).filter(keep).map(clean), lb = (sb2[r] || []).filter(keep).map(clean);
    if (JSON.stringify(la) === JSON.stringify(lb)) continue;
    let i = 0;
    while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
    diffs.push({ kind: 'text', msg: `region ${r}, line ${i + 1}: python ${short(la[i] ?? '(none)')} / rust ${short(lb[i] ?? '(none)')}` });
  }
}

// Compares one scenario of both runs. Writes (changing requests) are compared per step; reads are compared over the
// whole scenario (a refetch can land in a neighbouring step) and attributed to the step of their last occurrence.
export function compareScenario(sp, sr) {
  const names = [...new Set([...sp.steps.map((s) => s.name), ...sr.steps.map((s) => s.name)])];
  const noise = noiseOf(sp.id);
  const noisyReq = (e) => noise.requests.some((re) => re.test(keyQ(e).replace(/\?.*$/, '')));
  const out = new Map(names.map((n) => [n, []]));
  const spaKeys = new Set();
  for (const st of sr.steps) for (const e of st.exchanges) if (e.spa) spaKeys.add(key(e));
  const gap = (e) => AI_GAP.test(e.path.split('?')[0]) || spaKeys.has(key(e));
  for (const n of names) {
    const a = sp.steps.find((s) => s.name === n), b = sr.steps.find((s) => s.name === n);
    const diffs = out.get(n);
    if (!a || !b) { diffs.push({ kind: 'step', msg: `step exists only on ${a ? 'python' : 'rust'}${(a || b).error ? ': ' + (a || b).error : ''}` }); continue; }
    if (!!a.error !== !!b.error) diffs.push({ kind: 'failure', msg: `step ${a.error ? 'failed on python' : 'failed on rust'}: ${a.error || b.error}` });
    const writes = (e) => e.method !== 'GET' && !gap(e) && !noisyReq(e) && !/^\/(?:logs\/client|notifications\/(?:opened|read))/.test(e.path);
    const wa = a.exchanges.filter(writes), wb = b.exchanges.filter(writes);
    const ga = groupEx(wa), gb = groupEx(wb);
    for (const k of new Set([...ga.keys(), ...gb.keys()])) {
      const xa = ga.get(k), xb = gb.get(k);
      if (!xa) { diffs.push({ kind: 'request missing on python', msg: `${k} (rust: ${xb.map((e) => e.status).join(',')})` }); continue; }
      if (!xb) { diffs.push({ kind: 'request missing on rust', msg: `${k} (python: ${xa.map((e) => e.status).join(',')})` }); continue; }
      const sa = [...new Set(xa.map((e) => e.status))].sort().join(','), sb = [...new Set(xb.map((e) => e.status))].sort().join(',');
      if (sa !== sb) { diffs.push({ kind: 'status', msg: `${k}: python ${sa}, rust ${sb}` }); continue; }
      const pa = xa[0], pb = xb[0];
      const skip = (path) => NOISE_PATH.test(path) || noise.paths.some((re) => re.test(path));
      const dq = jsonDiff(pa.request, pb.request, '$', [], skip);
      if (dq.length) diffs.push({ kind: 'request body', msg: k, detail: dq });
      if (!IGNORE_BODY.has(k) && (pa.body !== undefined || pb.body !== undefined)) {
        const d = jsonDiff(pa.body, pb.body, '$', [], skip);
        if (d.length) diffs.push({ kind: 'body', msg: k, detail: d });
      }
      if (pa.type !== pb.type && pa.status !== 204) diffs.push({ kind: 'content type', msg: `${k}: python ${pa.type}, rust ${pb.type}` });
    }
    const ca = [...new Set([...a.console, ...a.pageErrors])], cb = [...new Set([...b.console, ...b.pageErrors])];
    for (const c of ca) if (!cb.includes(c)) diffs.push({ kind: 'console error python only', msg: c });
    for (const c of cb) if (!ca.includes(c)) diffs.push({ kind: 'console error rust only', msg: c });
    const fa = [...new Set(a.failedRequests)], fb = [...new Set(b.failedRequests)];
    for (const c of fa) if (!fb.includes(c)) diffs.push({ kind: 'failed request python only', msg: c });
    for (const c of fb) if (!fa.includes(c)) diffs.push({ kind: 'failed request rust only', msg: c });
    for (const k of new Set([...Object.keys(a.notes || {}), ...Object.keys(b.notes || {})])) {
      const x = (a.notes || {})[k], y = (b.notes || {})[k];
      if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push({ kind: 'note', msg: `${k}: python ${short(x)} / rust ${short(y)}` });
    }
    compareText(a, b, diffs, noise);
  }
  // Reads: per step, the last answer to each path, when it came after the last change of the step on that server (an
  // earlier answer is stale and its order against the change differs from run to run). Compared when both servers have
  // such an answer. Which requests exist at all is compared over the whole scenario.
  const skip = (path) => NOISE_PATH.test(path) || noise.paths.some((re) => re.test(path));
  const isWrite = (e) => e.method !== 'GET' && !gap(e) && !noisyReq(e) && !/^\/(?:logs\/client|notifications\/)/.test(e.path);
  const finals = (st) => {
    const lastWrite = st.exchanges.reduce((acc, e, i) => (isWrite(e) ? i : acc), -1);
    const m = new Map();
    st.exchanges.forEach((e, i) => { if (e.method === 'GET' && !gap(e) && i > lastWrite) m.set(keyQ(e), e); });
    return m;
  };
  const seen = (sc) => {
    const m = new Map();
    for (const st of sc.steps) for (const e of st.exchanges) if (e.method === 'GET' && !gap(e)) m.set(keyQ(e), { e, step: st.name });
    return m;
  };
  for (const n of names) {
    const a = sp.steps.find((s) => s.name === n), b = sr.steps.find((s) => s.name === n);
    if (!a || !b) continue;
    const fa = finals(a), fb = finals(b);
    for (const [k, ea] of fa) {
      const eb = fb.get(k);
      if (!eb) continue;
      // a revalidated cached answer (304) is the same answer as a 200
      const st = (e) => (e.status === 304 ? 200 : e.status);
      if (st(ea) !== st(eb)) { out.get(n).push({ kind: 'status', msg: `${k}: python ${ea.status}, rust ${eb.status}` }); continue; }
      if (IGNORE_BODY.has(k.split('?')[0])) continue;
      const d = jsonDiff(ea.body, eb.body, '$', [], skip);
      if (d.length) out.get(n).push({ kind: 'body', msg: k, detail: d });
      if (ea.h || eb.h) { const dh = jsonDiff(ea.h, eb.h); if (dh.length) out.get(n).push({ kind: 'headers', msg: k, detail: dh }); }
    }
  }
  const sa = seen(sp), sb = seen(sr);
  const plainKey = (k) => k.split('?')[0];
  // refetches the UI makes only sometimes (depending on when a tab became visible): not a difference between servers
  const SOMETIMES = /\/tickets\/counts$|^\/notifications\/counts$|\/versions\/\d+\/diff\/\d+$/;
  const pathsA = new Set([...sa.keys()].map(plainKey)), pathsB = new Set([...sb.keys()].map(plainKey));
  for (const [k, v] of sa) if (!pathsB.has(plainKey(k)) && !SOMETIMES.test(k.split('?')[0].replace(/^GET /, ''))) out.get(v.step)?.push({ kind: 'request missing on rust', msg: `${k} (python: ${v.e.status})` });
  for (const [k, v] of sb) if (!pathsA.has(plainKey(k)) && !SOMETIMES.test(k.split('?')[0].replace(/^GET /, ''))) out.get(v.step)?.push({ kind: 'request missing on python', msg: `${k} (rust: ${v.e.status})` });
  return out;
}

export function writeReports(py, rs, dir) {
  const lines = ['# Differences between the Python and the Rust server', '', `Generated ${new Date().toISOString()}`, ''];
  const table = [];
  const details = [];
  let same = 0, total = 0, differ = 0;
  const sumByScenario = [];
  for (const group of ['core', 'ai']) {
    for (const sp of py.filter((s) => (s.group || 'core') === group)) {
      const sr = rs.find((s) => s.id === sp.id) || { steps: [] };
      let sSame = 0;
      const names = [...new Set([...sp.steps.map((s) => s.name), ...sr.steps.map((s) => s.name)])];
      const cmp = compareScenario(sp, sr);
      for (const n of names) {
        const diffs = cmp.get(n) || [];
        total++;
        if (!diffs.length) { same++; sSame++; continue; }
        differ++;
        const first = diffs[0];
        table.push(`| ${group} | ${sp.id} | ${n} | ${diffs.length} | ${first.kind}: ${String(first.msg).replace(/\|/g, '\\|').slice(0, 140)} |`);
        details.push({ group, id: sp.id, step: n, diffs });
      }
      sumByScenario.push(`| ${group} | ${sp.id} | ${names.length} | ${sSame} | ${names.length - sSame} |`);
    }
  }
  lines.push(`Steps compared: ${total}; identical: ${same}; with differences: ${differ}.`, '');
  lines.push('## Per scenario', '', '| group | scenario | steps | identical | different |', '|---|---|---|---|---|', ...sumByScenario, '');
  lines.push('## First difference per step', '', '| group | scenario | step | n | first difference |', '|---|---|---|---|---|', ...table, '');
  lines.push('## Details', '');
  for (const d of details) {
    lines.push(`### ${d.group} / ${d.id} / ${d.step}`, '');
    for (const x of d.diffs.slice(0, 30)) {
      lines.push(`- **${x.kind}**: ${x.msg}`);
      for (const j of (x.detail || []).slice(0, MAX_DETAIL)) lines.push(`    - \`${j.path}\`: python ${short(j.py)}, rust ${short(j.rs)}`);
    }
    lines.push('');
  }
  const spa = new Map();
  for (const sc of rs) for (const st of sc.steps) for (const e of st.exchanges) if (e.spa) { const k = `${e.method} ${e.path.split('?')[0]}`; spa.set(k, (spa.get(k) || 0) + 1); }
  lines.push('## Routes the Rust server answered with the UI index.html (200) instead of a JSON reply', '', 'Excluded from the step comparison above; the runner turned them into a 404 for the page so the UI does not crash.', '');
  for (const [k, n] of [...spa.entries()].sort()) lines.push(`- ${k} (${n}x)`);
  lines.push('', '## Screenshots', '');
  for (const s of py) lines.push(`- ${s.id}: python \`${s.screenshot}\`, rust \`${(rs.find((r) => r.id === s.id) || {}).screenshot}\``);
  fs.writeFileSync(path.join(dir, 'diff.md'), lines.join('\n') + '\n');
}
