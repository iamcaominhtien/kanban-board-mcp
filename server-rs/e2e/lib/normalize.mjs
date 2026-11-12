// Replace volatile values by stable placeholders, numbered by first appearance so equal values stay equal.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TMP = /\/(?:tmp|var\/folders)[^\s"'<>]*?kanban-e2e-[A-Za-z0-9]+(?:\/[^\s"'<>,;)]*)?/g;
const HEX_ID = /\b(?:[a-z]{2,8}_)[0-9a-f]{8,32}\b/g; // prefixed ids such as run_ab12cd34
const LONG_HEX = /\b[0-9a-f]{24,64}\b/g;
const RELTIME = /\b(?:just now|\d+\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mo|months?|y|years?)\s+ago|(?:a|an)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)\b/gi;
const TIMEOFDAY = /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?\b/g;
const MONTHDATE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(?:, \d{4})?\b/g;

export class Normalizer {
  constructor(port) {
    this.port = String(port);
    this.maps = { uuid: new Map(), pid: new Map(), ts: new Map(), hex: new Map(), tmp: new Map() };
  }
  num(kind, value, label) {
    const m = this.maps[kind];
    if (!m.has(value)) m.set(value, m.size + 1);
    return `<${label}:${m.get(value)}>`;
  }
  // timestamps are not numbered (their order carries no meaning)
  str(s, { text = false } = {}) {
    if (typeof s !== 'string') return s;
    let out = s;
    out = out.replace(TMP, (m) => this.num('tmp', m.replace(/kanban-e2e-[A-Za-z0-9]+/, 'ROOT'), 'TMPPATH').replace(/:\d+>/, '>') + (m.includes('/uploads/') ? '' : ''));
    out = out.split(`127.0.0.1:${this.port}`).join('127.0.0.1:<PORT>').split(`localhost:${this.port}`).join('localhost:<PORT>');
    out = out.replace(UUID, (m) => this.num('uuid', m.toLowerCase(), 'UUID'));
    out = out.replace(ISO, '<TS>');
    if (ISO_DATE_ONLY.test(out)) out = out; // plain dates are user data; keep
    out = out.replace(HEX_ID, (m) => this.num('pid', m, 'ID'));
    out = out.replace(LONG_HEX, (m) => this.num('hex', m, 'HEX'));
    if (text) {
      out = out.replace(RELTIME, '<AGO>').replace(TIMEOFDAY, '<TIME>').replace(MONTHDATE, '<DATE>');
    }
    return out;
  }
  json(v) {
    if (v === null || typeof v !== 'object') return typeof v === 'string' ? this.str(v) : v;
    if (Array.isArray(v)) return v.map((x) => this.json(x));
    const o = {};
    for (const k of Object.keys(v).sort()) o[this.str(k)] = this.json(v[k]);
    return o;
  }
  // path with query: ids normalized, query parameters sorted
  path(url) {
    const u = new URL(url);
    const q = [...u.searchParams.entries()].map(([k, val]) => `${k}=${this.str(val)}`).sort().join('&');
    return this.str(u.pathname) + (q ? '?' + q : '');
  }
  text(s) {
    return this.str(s, { text: true });
  }
}
