/**
 * Compact GFM for the stored page (docs ED-4). The editor's serializer pads every table cell to its column width and
 * can leave two blank lines before a heading; stored as is, an untouched table shows as changed lines in history and
 * diffs each time its widest cell changes. This writes tables with one space around each cell (`| GET | /tickets |`)
 * and collapses runs of blank lines to one. Fenced code is left as it is.
 */

const FENCE = /^\s*(```|~~~)/;
const ROW = /^\s*\|.*\|\s*$/;
const DELIM_CELL = /^:?-+:?$/;

/** Cells of a table row: split on `|` that is not escaped (`\|`), as GFM does. */
function cells(line: string): string[] {
  const inner = line.trim().slice(1, -1);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length) {
      cur += ch + inner[i + 1];
      i += 1;
    } else if (ch === '|') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function compactRow(line: string): string {
  const cs = cells(line);
  const delim = cs.length > 0 && cs.every((c) => DELIM_CELL.test(c));
  const parts = delim ? cs.map((c) => `${c.startsWith(':') ? ':' : ''}---${c.endsWith(':') ? ':' : ''}`) : cs;
  return `| ${parts.join(' | ')} |`;
}

/**
 * @param md - Markdown from the editor (after `cleanEditorMarkdown`).
 * @returns The same document with compact tables and single blank lines.
 */
export function compactMarkdown(md: string): string {
  const out: string[] = [];
  let fenced = false;
  let blank = false;
  for (const line of md.split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      blank = false;
      out.push(line);
      continue;
    }
    if (fenced) {
      out.push(line);
      continue;
    }
    if (line.trim() === '') {
      if (blank) continue;
      blank = true;
      out.push('');
      continue;
    }
    blank = false;
    out.push(ROW.test(line) && !/^\s{4,}/.test(line) ? compactRow(line) : line);
  }
  return out.join('\n');
}
