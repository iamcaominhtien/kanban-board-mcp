// Compare two runs (python, rust) and write report/diff.md.
import fs from 'node:fs';
import path from 'node:path';

const MAX_DETAIL = 6;

function jsonDiff(a, b, p = '$', out = []) {
  if (out.length >= 8) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const isO = (x) => x && typeof x === 'object';
  if (!isO(a) || !isO(b) || Array.isArray(a) !== Array.isArray(b)) {
    out.push({ path: p, py: a, rs: b });
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push({ path: p + '.length', py: a.length, rs: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) jsonDiff(a[i], b[i], `${p}[${i}]`, out);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    if (!(k in a)) out.push({ path: `${p}.${k}`, py: '(absent)', rs: b[k] });
    else if (!(k in b)) out.push({ path: `${p}.${k}`, py: a[k], rs: '(absent)' });
    else jsonDiff(a[k], b[k], `${p}.${k}`, out);
  }
  return out;
}

// Differences that are by design and carry no meaning for parity.
const IGNORE_BODY = new Set(['GET /version']); // the two servers report their own release number

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

export function compareStep(a, b) {
  const diffs = [];
  if (!a || !b) return [{ kind: 'step', msg: `step exists only on ${a ? 'python' : 'rust'}` }];
  if (!!a.error !== !!b.error) diffs.push({ kind: 'failure', msg: `step ${a.error ? 'failed on python' : 'failed on rust'}: ${a.error || b.error}` });
  // requests
  const spaKeys = new Set(b.exchanges.filter((e) => e.spa).map(key));
  const ga = groupEx(a.exchanges.filter((e) => !spaKeys.has(key(e)))), gb = groupEx(b.exchanges.filter((e) => !e.spa));
  for (const k of new Set([...ga.keys(), ...gb.keys()])) {
    const xa = ga.get(k), xb = gb.get(k);
    if (!xa) { diffs.push({ kind: 'request missing on python', msg: `${k} (rust: ${xb.map((e) => e.status).join(',')})` }); continue; }
    if (!xb) { diffs.push({ kind: 'request missing on rust', msg: `${k} (python: ${xa.map((e) => e.status).join(',')})` }); continue; }
    // status of the full set, query included, compared by distinct statuses
    const sa = [...new Set(xa.map((e) => e.status))].sort().join(','), sb = [...new Set(xb.map((e) => e.status))].sort().join(',');
    if (sa !== sb) { diffs.push({ kind: 'status', msg: `${k}: python ${sa}, rust ${sb}` }); continue; }
    const qa = new Set(xa.map((e) => e.path)), qb = new Set(xb.map((e) => e.path));
    const onlyA = [...qa].filter((x) => !qb.has(x)), onlyB = [...qb].filter((x) => !qa.has(x));
    if (onlyA.length || onlyB.length) diffs.push({ kind: 'query', msg: `${k}: python ${onlyA.join(' ')} / rust ${onlyB.join(' ')}` });
    const mutating = a.exchanges.length && !['GET', 'HEAD'].includes(xa[0].method);
    const pa = mutating ? xa[0] : xa[xa.length - 1], pb = mutating ? xb[0] : xb[xb.length - 1];
    if (!IGNORE_BODY.has(k) && (pa.body !== undefined || pb.body !== undefined)) {
      const d = jsonDiff(pa.body, pb.body);
      if (d.length) diffs.push({ kind: 'body', msg: `${k}`, detail: d });
    }
  }
  // console
  const ca = [...new Set([...a.console, ...a.pageErrors])], cb = [...new Set([...b.console, ...b.pageErrors])];
  for (const c of ca) if (!cb.includes(c)) diffs.push({ kind: 'console error python only', msg: c });
  for (const c of cb) if (!ca.includes(c)) diffs.push({ kind: 'console error rust only', msg: c });
  const fa = [...new Set(a.failedRequests)], fb = [...new Set(b.failedRequests)];
  for (const c of fa) if (!fb.includes(c)) diffs.push({ kind: 'failed request python only', msg: c });
  for (const c of fb) if (!fa.includes(c)) diffs.push({ kind: 'failed request rust only', msg: c });
  // text
  const sa2 = a.snapshot || {}, sb2 = b.snapshot || {};
  for (const r of new Set([...Object.keys(sa2), ...Object.keys(sb2)])) {
    if (r === 'url') continue;
    const la = sa2[r] || [], lb = sb2[r] || [];
    if (JSON.stringify(la) === JSON.stringify(lb)) continue;
    let i = 0;
    while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
    diffs.push({ kind: 'text', msg: `region ${r}, line ${i + 1}: python ${short(la[i] ?? '(none)')} / rust ${short(lb[i] ?? '(none)')}` });
  }
  return diffs;
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
      for (const n of names) {
        const a = sp.steps.find((s) => s.name === n), b = sr.steps.find((s) => s.name === n);
        const diffs = compareStep(a, b);
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
