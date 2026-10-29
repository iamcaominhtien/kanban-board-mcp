import { unzipSync, type Unzipped } from 'fflate';

/** Rows shown for a table; the rest stays in the file. */
export const ROW_LIMIT = 500;
const COLUMN_LIMIT = 100;
/** Bigger sheet files are not parsed in the browser. */
const SHEET_BYTES_LIMIT = 30 * 1024 * 1024;

/** One sheet, or one CSV, ready to show. */
export interface Sheet {
  name: string;
  rows: string[][];
  /** Rows in the whole sheet, when counted. */
  totalRows: number;
  columns: number;
}

/** Pick the delimiter that splits the first lines into the most equal columns. */
export function detectDelimiter(sample: string, ext: string): { char: string; label: string } {
  if (ext === 'tsv') return { char: '\t', label: 'tab' };
  const candidates: [string, string][] = [
    [',', 'comma'],
    [';', 'semicolon'],
    ['\t', 'tab'],
    ['|', 'pipe'],
  ];
  const lines = sample.split(/\r?\n/).filter(Boolean).slice(0, 10);
  let best = candidates[0];
  let bestScore = -1;
  for (const cand of candidates) {
    const counts = lines.map((l) => l.split(cand[0]).length - 1);
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    const consistent = counts.filter((c) => c === first).length;
    const score = consistent * 100 + first;
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return { char: best[0], label: best[1] };
}

/**
 * Parse delimited text (RFC 4180 quotes). Stops after `maxRows` rows and counts the rest.
 * @param text - File text.
 * @param delimiter - Column separator.
 * @param maxRows - Rows to keep.
 */
export function parseDelimited(text: string, delimiter: string, maxRows: number): { rows: string[][]; total: number } {
  const rows: string[][] = [];
  let total = 0;
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;
  const endRow = () => {
    if (started || field !== '' || row.length) {
      row.push(field);
      total++;
      if (rows.length < maxRows) rows.push(row.slice(0, COLUMN_LIMIT));
    }
    row = [];
    field = '';
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
      started = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      started = true;
    } else if (ch === '\n') {
      endRow();
    } else if (ch === '\r') {
      if (text[i + 1] !== '\n') endRow();
    } else {
      field += ch;
      started = true;
    }
  }
  endRow();
  return { rows, total };
}

/** Turn delimited text into a sheet. */
export function csvToSheet(text: string, ext: string): { sheet: Sheet; delimiter: string } {
  const delim = detectDelimiter(text.slice(0, 8192), ext);
  const { rows, total } = parseDelimited(text, delim.char, ROW_LIMIT);
  const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return { sheet: { name: 'Sheet', rows, totalRows: total, columns }, delimiter: delim.label };
}

// ---- XLSX (values only: formulas are never run, macros are never read) ----

function textOf(doc: Document, tag: string): Element[] {
  return Array.from(doc.getElementsByTagName(tag));
}

function parseXml(bytes: Uint8Array | undefined): Document | null {
  if (!bytes) return null;
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}

function colIndex(ref: string): number {
  const letters = ref.replace(/[^A-Za-z]/g, '').toUpperCase();
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function serialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

function cleanNumber(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return String(Math.round(n * 1e10) / 1e10);
}

/** Thrown when a workbook cannot be opened (damaged, encrypted or too large). */
export class SheetError extends Error {
  reason: 'protected' | 'too-large' | 'damaged';
  constructor(reason: 'protected' | 'too-large' | 'damaged') {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Read the sheets of an .xlsx file. Values only; the first `ROW_LIMIT` rows of each sheet.
 * @param bytes - The file.
 */
export function parseXlsx(bytes: Uint8Array): Sheet[] {
  // An encrypted workbook is an OLE container, not a zip
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) throw new SheetError('protected');
  let files: Unzipped;
  try {
    files = unzipSync(bytes, {
      filter: (f) =>
        /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(
          f.name,
        ) && f.originalSize <= SHEET_BYTES_LIMIT,
    });
  } catch {
    throw new SheetError('damaged');
  }
  const wb = parseXml(files['xl/workbook.xml']);
  if (!wb) throw new SheetError('damaged');
  const rels = parseXml(files['xl/_rels/workbook.xml.rels']);
  const relTarget = new Map<string, string>();
  if (rels)
    for (const r of textOf(rels, 'Relationship'))
      relTarget.set(r.getAttribute('Id') ?? '', r.getAttribute('Target') ?? '');

  const shared: string[] = [];
  const ss = parseXml(files['xl/sharedStrings.xml']);
  if (ss) {
    for (const si of textOf(ss, 'si')) {
      let s = '';
      for (const child of Array.from(si.children)) {
        if (child.tagName === 't') s += child.textContent ?? '';
        else if (child.tagName === 'r') s += child.getElementsByTagName('t')[0]?.textContent ?? '';
      }
      shared.push(s);
    }
  }

  const dateStyles = new Set<number>();
  const styles = parseXml(files['xl/styles.xml']);
  if (styles) {
    const custom = new Map<number, string>();
    for (const n of textOf(styles, 'numFmt'))
      custom.set(Number(n.getAttribute('numFmtId')), n.getAttribute('formatCode') ?? '');
    const xfs = styles.getElementsByTagName('cellXfs')[0];
    Array.from(xfs?.children ?? []).forEach((xf, i) => {
      const id = Number(xf.getAttribute('numFmtId'));
      const code = custom.get(id);
      if (BUILTIN_DATE_IDS.has(id) || (code && /[ymdhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''))))
        dateStyles.add(i);
    });
  }

  const sheets: Sheet[] = [];
  for (const s of textOf(wb, 'sheet')) {
    const name = s.getAttribute('name') ?? `Sheet ${sheets.length + 1}`;
    const rid =
      s.getAttribute('r:id') ??
      s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ??
      '';
    const target = relTarget.get(rid) ?? `worksheets/sheet${sheets.length + 1}.xml`;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const doc = parseXml(files[path]);
    if (!doc) {
      sheets.push({ name, rows: [], totalRows: 0, columns: 0 });
      continue;
    }
    const rows: string[][] = [];
    let total = 0;
    let columns = 0;
    for (const rowEl of textOf(doc, 'row')) {
      total++;
      if (rows.length >= ROW_LIMIT) continue;
      const out: string[] = [];
      for (const c of Array.from(rowEl.children)) {
        if (c.tagName !== 'c') continue;
        const idx = colIndex(c.getAttribute('r') ?? '');
        if (idx >= COLUMN_LIMIT) continue;
        const type = c.getAttribute('t');
        const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
        let value = v;
        if (type === 's') value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = c.getElementsByTagName('t')[0]?.textContent ?? '';
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'str' || type === 'e') value = v;
        else if (v !== '') {
          const style = Number(c.getAttribute('s') ?? '0');
          value = dateStyles.has(style) ? serialToDate(Number(v)) : cleanNumber(v);
        }
        while (out.length < idx) out.push('');
        out[idx] = value;
      }
      columns = Math.max(columns, out.length);
      rows.push(out);
    }
    sheets.push({ name, rows, totalRows: total, columns });
  }
  if (!sheets.length) throw new SheetError('damaged');
  return sheets;
}
