/**
 * Excel number formats: a cell's value shown the way its format code says (decimals, thousands, percent, currency,
 * dates and times, negative and zero sections, text). Colours in a code (`[Red]`) come back with the text.
 */

/** Formats Excel knows by number when the file does not spell them out. */
export const BUILTIN_FORMATS: Record<number, string> = {
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  14: 'm/d/yyyy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm',
  37: '#,##0;(#,##0)',
  38: '#,##0;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mm:ss.0',
  49: '@',
};

export interface Formatted {
  text: string;
  color?: string;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const COLORS: Record<string, string> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  green: '#008000',
  magenta: '#ff00ff',
  red: '#ff0000',
  white: '#ffffff',
  yellow: '#ffff00',
};

/** Split a format code into its sections at the `;` that are not inside quotes or brackets. */
function sections(code: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = false;
  let bracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\') {
      cur += ch + (code[++i] ?? '');
      continue;
    }
    if (ch === '"') quote = !quote;
    else if (!quote && ch === '[') bracket = true;
    else if (!quote && ch === ']') bracket = false;
    if (ch === ';' && !quote && !bracket) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

type Token = { kind: 'lit'; text: string } | { kind: 'code'; text: string };

/** The pieces of a section: quoted and escaped text on one side, format characters on the other. */
function tokens(section: string): { toks: Token[]; color?: string; condition?: string } {
  const toks: Token[] = [];
  let color: string | undefined;
  let condition: string | undefined;
  let i = 0;
  while (i < section.length) {
    const ch = section[i];
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      toks.push({ kind: 'lit', text: section.slice(i + 1, end < 0 ? undefined : end) });
      i = end < 0 ? section.length : end + 1;
    } else if (ch === '\\') {
      toks.push({ kind: 'lit', text: section[i + 1] ?? '' });
      i += 2;
    } else if (ch === '[') {
      const end = section.indexOf(']', i);
      const inner = section.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? section.length : end + 1;
      if (COLORS[inner.toLowerCase()]) color = COLORS[inner.toLowerCase()];
      else if (/^[<>=]/.test(inner)) condition = inner;
      else if (/^\$/.test(inner)) toks.push({ kind: 'lit', text: inner.slice(1).split('-')[0] });
      else if (/^[hms]+$/i.test(inner)) toks.push({ kind: 'code', text: `[${inner.toLowerCase()}]` });
    } else if (ch === '_' || ch === '*') {
      toks.push({ kind: 'lit', text: ch === '_' ? ' ' : '' });
      i += 2;
    } else {
      toks.push({ kind: 'code', text: ch });
      i++;
    }
  }
  return { toks, color, condition };
}

const DATE_CHARS = /[ymdhsa]/i;

function isDateSection(toks: Token[]): boolean {
  const code = toks
    .filter((t) => t.kind === 'code')
    .map((t) => t.text)
    .join('');
  return DATE_CHARS.test(code.replace(/AM\/PM|A\/P/gi, 'a')) && !/[#0?]/.test(code.replace(/\[[hms]+\]/gi, ''));
}

/** True when the format code shows a date or a time. */
export function isDateFormat(code: string): boolean {
  const s = sections(code)[0] ?? '';
  return isDateSection(tokens(s).toks);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function formatDate(serial: number, toks: Token[], date1904: boolean): string {
  const ms = Math.round((serial - (date1904 ? 24107 : 25569)) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const joined = toks.map((t) => (t.kind === 'code' ? t.text : '\u0000')).join('');
  const twelve = /AM\/PM|A\/P/i.test(joined);
  const totalSeconds = Math.round(serial * 86400);
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'lit') {
      out += t.text;
      continue;
    }
    const rest = toks
      .slice(i)
      .map((x) => (x.kind === 'code' ? x.text : '\u0000'))
      .join('');
    const run = (c: string) => new RegExp(`^${c}+`, 'i').exec(rest)?.[0].length ?? 0;
    const ch = t.text.toLowerCase();
    if (ch === 'y') {
      const n = run('y');
      out += n <= 2 ? pad(d.getUTCFullYear() % 100) : String(d.getUTCFullYear());
      i += n - 1;
    } else if (ch === 'd') {
      const n = run('d');
      out +=
        n === 1
          ? String(d.getUTCDate())
          : n === 2
            ? pad(d.getUTCDate())
            : n === 3
              ? DAYS[d.getUTCDay()].slice(0, 3)
              : DAYS[d.getUTCDay()];
      i += n - 1;
    } else if (ch === 'm') {
      const n = run('m');
      // minutes when the letters sit next to an hour or a second, months otherwise
      const before = toks
        .slice(0, i)
        .map((x) => (x.kind === 'code' ? x.text : '\u0000'))
        .join('');
      const after = rest.slice(n);
      const minutes = /(h|\[h\])[^a-z]?$/i.test(before) || /^[^a-z]?s/i.test(after);
      if (minutes) out += n === 1 ? String(d.getUTCMinutes()) : pad(d.getUTCMinutes());
      else
        out +=
          n === 1
            ? String(d.getUTCMonth() + 1)
            : n === 2
              ? pad(d.getUTCMonth() + 1)
              : n === 3
                ? MONTHS[d.getUTCMonth()].slice(0, 3)
                : n === 4
                  ? MONTHS[d.getUTCMonth()]
                  : MONTHS[d.getUTCMonth()][0];
      i += n - 1;
    } else if (ch === 'h') {
      const n = run('h');
      const h = d.getUTCHours();
      const v = twelve ? h % 12 || 12 : h;
      out += n === 1 ? String(v) : pad(v);
      i += n - 1;
    } else if (ch === 's') {
      const n = run('s');
      out += n === 1 ? String(d.getUTCSeconds()) : pad(d.getUTCSeconds());
      i += n - 1;
    } else if (ch === '[h]') out += String(Math.floor(totalSeconds / 3600));
    else if (ch === '[m]') out += String(Math.floor(totalSeconds / 60));
    else if (ch === '[s]') out += String(totalSeconds);
    else if (ch === 'a') {
      const m = /^(AM\/PM|A\/P)/i.exec(rest)?.[0] ?? '';
      if (m) {
        const pm = d.getUTCHours() >= 12;
        out += m.length === 5 ? (pm ? 'PM' : 'AM') : pm ? 'P' : 'A';
        i += m.length - 1;
      }
    } else if (ch === '.' || ch === '0') out += t.text;
    else out += t.text;
  }
  return out;
}

/** A number shown with the digits of a section ("#,##0.00", "0.0%", "0.00E+00"). */
function formatNumber(value: number, toks: Token[]): string {
  const code = toks.map((t) => (t.kind === 'code' ? t.text : '\u0000')).join('');
  const start = code.search(/[0#?]/);
  if (start < 0) return toks.map((t) => (t.kind === 'lit' ? t.text : t.text === '%' ? '%' : t.text)).join('');
  let end = start;
  while (end < code.length && /[0#?.,]/.test(code[end])) end++;
  // an exponent follows the digits
  const sci = /^E[+-]/i.exec(code.slice(end));
  const numberPart = code.slice(start, end);
  const percent = code.includes('%');
  let v = percent ? value * 100 : value;
  // commas after the last digit placeholder scale the number down by a thousand each
  const scale = /,+$/.exec(numberPart)?.[0].length ?? 0;
  const digits = numberPart.replace(/,+$/, '');
  v = v / 1000 ** scale;
  const [intPattern, decPattern = ''] = digits.split('.');
  const decimals = decPattern.length;
  const minDecimals = (decPattern.match(/0/g) ?? []).length;
  const minInt = (intPattern.replace(/,/g, '').match(/0/g) ?? []).length;
  const grouping = intPattern.includes(',');
  let body: string;
  if (sci) {
    const exp = v === 0 ? 0 : Math.floor(Math.log10(Math.abs(v)));
    const mant = v / 10 ** exp;
    body = `${mant.toFixed(decimals)}E${exp < 0 ? '-' : '+'}${pad(Math.abs(exp))}`;
    end += sci[0].length;
    while (end < code.length && code[end] === '0') end++;
  } else {
    const fixed = Math.abs(v).toFixed(decimals);
    let [i, f = ''] = fixed.split('.');
    while (f.length > minDecimals && f.endsWith('0')) f = f.slice(0, -1);
    i = i.replace(/^0+(?=\d)/, '');
    if (i === '0' && minInt === 0 && f) i = '';
    else i = i.padStart(minInt, '0');
    if (grouping) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    body = f ? `${i}.${f}` : i;
  }
  let out = '';
  let placed = false;
  toks.forEach((t, k) => {
    const pos = toks.slice(0, k).reduce((n, x) => n + (x.kind === 'code' ? 1 : 1), 0);
    void pos;
    if (t.kind === 'lit') out += t.text;
    else if (/[0#?.,]/.test(t.text) || (sci && /[E+-]/i.test(t.text))) {
      if (!placed) {
        out += body;
        placed = true;
      }
    } else if (t.text === '%') out += '%';
    else out += t.text;
  });
  return out;
}

function generalNumber(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e11) return String(v);
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e11 || abs < 1e-9))
    return v
      .toExponential(5)
      .replace(/\.?0+e/, 'E')
      .replace('e+', 'E+')
      .replace('e-', 'E-');
  return String(parseFloat(v.toPrecision(11)));
}

/**
 * A cell value as its format code shows it.
 * @param value - The number, or the text, of the cell.
 * @param code - The format code ("General", "#,##0.00", "yyyy-mm-dd", ...).
 * @param date1904 - Whether the workbook counts days from 1904.
 */
export function formatValue(value: number | string, code: string, date1904 = false): Formatted {
  if (!code || /^general$/i.test(code)) return { text: typeof value === 'number' ? generalNumber(value) : value };
  const parts = sections(code);
  if (typeof value === 'string') {
    const textPart = parts[3] ?? (parts.length === 1 && /@/.test(parts[0]) ? parts[0] : undefined);
    if (!textPart) return { text: value };
    const { toks, color } = tokens(textPart);
    return { text: toks.map((t) => (t.kind === 'code' && t.text === '@' ? value : t.text)).join(''), color };
  }
  const positive = tokens(parts[0]);
  let section = 0;
  let sign = '';
  if (value < 0) {
    if (parts.length > 1) section = 1;
    else sign = '-';
  } else if (value === 0 && parts.length > 2) section = 2;
  const { toks, color } = section === 0 ? positive : tokens(parts[section]);
  if (isDateSection(toks)) return { text: formatDate(value, toks, date1904), color };
  const shown = formatNumber(section === 1 ? Math.abs(value) : value, toks);
  const neg = section === 0 && value < 0 ? '-' : '';
  return { text: `${sign}${neg && !shown.startsWith('-') ? neg : ''}${shown}`.replace(/^--/, '-'), color };
}
