/** Rows shown for a table; the rest stays in the file. */
export const ROW_LIMIT = 500;
const COLUMN_LIMIT = 100;

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
