// What the UI can do, read from its source: every call it makes to the server and every labelled control.
// Both lists are matched against what an e2e run recorded (see report.mjs).
import fs from 'node:fs';
import path from 'node:path';

const SKIP = /\.(test|spec)\.tsx?$|\.d\.ts$/;

/** Lists the .ts/.tsx files under `dir`, tests left out. */
export function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !SKIP.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

const lineOf = (src, i) => src.slice(0, i).split('\n').length;

// Reads the string or template literal that starts at src[i]; returns { text, end } with every ${…} replaced by \0,
// or null when the argument is not a literal (a variable, a call).
function literalAt(src, i) {
  while (/\s/.test(src[i])) i++;
  const q = src[i];
  if (q === "'" || q === '"') {
    const end = src.indexOf(q, i + 1);
    return end < 0 ? null : { text: src.slice(i + 1, end), end: end + 1 };
  }
  if (q !== '`') return null;
  let text = '';
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { text += src[j + 1]; j++; continue; }
    if (c === '`') return { text, end: j + 1 };
    if (c === '$' && src[j + 1] === '{') {
      let depth = 1;
      const from = j + 2;
      j += 2;
      for (; j < src.length && depth; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
      }
      j--;
      text += '\0' + src.slice(from, j).replace(/\0/g, '') + '\0';
      continue;
    }
    text += c;
  }
  return null;
}

// A URL template as written in the source → { template: '/projects/:p/members', origin: bool }.
// `consts` maps a file's own `const NAME = '…'` / `const name = (…) => `…`` to their text, so `${BASE}/x` resolves.
function shapeUrl(text, consts = {}) {
  let t = text.replace(/^\0\s*([A-Za-z_$][\w$]*)\s*(?:\([^\0]*\))?\s*\0/, (m, id) => (id in consts ? consts[id] : m));
  // the origin prefix: ${resolveOrigin()}, ${origin}, ${base} …
  const lead = t.match(/^\0([^\0]*)\0/);
  if (lead && /origin|base|host|api/i.test(lead[1])) t = t.slice(lead[0].length);
  if (!t.startsWith('/')) return null;
  t = t.split('?')[0];
  // a ${…} at the very end that builds a query string (`${qs}`, `${params ? '?'+… : ''}`) is not a path segment
  t = t.replace(/\0([^\0]*)\0$/, (m, expr) => (/\?|qs|query|params|search/i.test(expr) ? '' : m));
  t = t.replace(/\0[^\0]*\0/g, ':p');
  return t.replace(/\/+$/, '') || '/';
}

// Name of the function the call sits in (the nearest declaration before it).
function enclosingName(src, i) {
  const head = src.slice(Math.max(0, i - 4000), i);
  const re = /(?:function\s+([A-Za-z0-9_$]+)|(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>|function))/g;
  let m, name = null;
  while ((m = re.exec(head))) name = m[1] || m[2];
  return name;
}

/**
 * Returns every server call the UI makes: { method, template, sites: [{file, line, fn}] }, plus `dynamic`, the call
 * sites whose URL is not a literal (listed so a person can check them by hand).
 */
export function apiInventory(uiSrc) {
  const byKey = new Map();
  const dynamic = [];
  for (const file of sourceFiles(uiSrc)) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.dirname(uiSrc), file);
    const consts = {};
    for (const m of src.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)\s*(?::\s*\w+\s*)?=>\s*)?(?=['"`])/gm)) {
      const lit = literalAt(src, m.index + m[0].length);
      if (lit && lit.text.startsWith('/')) consts[m[1]] = lit.text;
    }
    const add = (method, text, at) => {
      const site = { file: rel, line: lineOf(src, at), fn: enclosingName(src, at) };
      const template = text == null ? null : shapeUrl(text, consts);
      if (!template) { if (text == null || /^\0/.test(text)) dynamic.push({ method, ...site }); return; }
      const key = `${method} ${template}`;
      if (!byKey.has(key)) byKey.set(key, { method, template, sites: [] });
      byKey.get(key).sites.push(site);
    };
    for (const m of src.matchAll(/\bclient\.(get|post|put|patch|delete)\s*([<(])/g)) {
      let i = m.index + m[0].length - 1;
      if (m[2] === '<') {
        // skip the type arguments, however deeply nested (`=>` inside them is not a closing bracket)
        let depth = 0;
        for (; i < src.length; i++) {
          if (src[i] === '<') depth++;
          else if (src[i] === '>' && src[i - 1] !== '=') { depth--; if (!depth) break; }
        }
        i++;
        while (/\s/.test(src[i])) i++;
        if (src[i] !== '(') continue;
      }
      const lit = literalAt(src, i + 1);
      add(m[1].toUpperCase(), lit ? lit.text : null, m.index);
    }
    for (const m of src.matchAll(/\bfetch\s*\(/g)) {
      const lit = literalAt(src, m.index + m[0].length);
      if (!lit) { dynamic.push({ method: 'FETCH', file: rel, line: lineOf(src, m.index), fn: enclosingName(src, m.index) }); continue; }
      const tail = src.slice(lit.end, lit.end + 400);
      const mm = tail.match(/^\s*,\s*\{[^}]*?method:\s*['"`](\w+)/s);
      add(mm ? mm[1].toUpperCase() : 'GET', lit.text, m.index);
    }
    for (const m of src.matchAll(/new\s+(EventSource|WebSocket)\s*\(/g)) {
      const lit = literalAt(src, m.index + m[0].length);
      add(m[1] === 'EventSource' ? 'SSE' : 'WS', lit ? lit.text : null, m.index);
    }
  }
  const calls = [...byKey.values()].sort((a, b) => a.template.localeCompare(b.template) || a.method.localeCompare(b.method));
  return { calls, dynamic };
}

/** Turns a template into a RegExp that matches a recorded path (query string removed). */
export function templateRegex(template) {
  const esc = template.split(':p').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + esc.join('[^/]+') + '/?$');
}

/**
 * Returns every labelled control in the components: { label, kind, file, line } where kind is aria-label,
 * placeholder or text (the visible text of a button, link, tab or menu item) and label may hold `\0` for a ${…} part; `dynamic` counts the labels that are a plain expression.
 */
export function uiInventory(uiSrc) {
  const items = [];
  let dynamic = 0;
  for (const file of sourceFiles(uiSrc).filter((f) => f.endsWith('.tsx'))) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.dirname(uiSrc), file);
    for (const m of src.matchAll(/\b(aria-label|placeholder)=/g)) {
      let i = m.index + m[0].length;
      let lit = null;
      if (src[i] === '"' || src[i] === "'") lit = literalAt(src, i);
      else if (src[i] === '{') {
        lit = literalAt(src, i + 1);
        // {cond ? 'A' : 'B'}: take both branches
        if (!lit) {
          const end = src.indexOf('}', i);
          const expr = src.slice(i + 1, end);
          const parts = [...expr.matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] || x[2]);
          if (/\?/.test(expr) && parts.length >= 2) {
            for (const p of parts) items.push({ label: p, kind: m[1], file: rel, line: lineOf(src, m.index) });
            continue;
          }
        } else if (src.slice(lit.end).trimStart()[0] !== '}') lit = null; // `'a' + b` and the like
      }
      if (!lit || !lit.text.replace(/\0[^\0]*\0/g, '').trim()) { dynamic++; continue; }
      items.push({ label: lit.text.replace(/\0[^\0]*\0/g, '\0'), kind: m[1], file: rel, line: lineOf(src, m.index) });
    }
    // the visible text of buttons, links, tabs and menu items: <button …>Save</button>
    for (const m of src.matchAll(/<(button|Button|a|MenuItem|Tab|summary|option)\b(?:[^>{]|\{(?:[^{}]|\{[^{}]*\})*\})*>\s*([^<>{}]*[A-Za-z][^<>{}]*?)\s*</g)) {
      const text = m[2].replace(/\s+/g, ' ').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&').trim();
      if (text.length < 2 || text.length > 60) continue;
      items.push({ label: text, kind: 'text', file: rel, line: lineOf(src, m.index) });
    }
  }
  return { items, dynamic };
}

/** Turns a label (with \0 for its ${…} parts) into a RegExp matching a recorded accessible name. */
export function labelRegex(label) {
  const esc = label.split('\0').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + esc.join('.*') + '$', 's');
}
