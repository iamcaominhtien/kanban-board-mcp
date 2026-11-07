import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Notice, StatePanel } from './StatePanel';
import { AsyncBody } from './TextReader';
import { useFileData } from './useFileData';
import { useViewerKeys } from './useViewerKeys';
import { Shape } from './SlideCanvas';
import { XlsxError, parseXlsxBook, type XlsxBook, type XlsxCell, type XlsxSheet } from './xlsxRender';
import type { ReaderProps } from './readerTypes';
import styles from './PreviewViewer.module.css';

const XLSX_LIMIT = 25 * 1024 * 1024;
/** Rows drawn at first, and each time "Show more" is pressed. */
const PAGE_ROWS = 500;
const ROW_HEADER_W = 46;
const COL_HEADER_H = 22;
const GRID = '#e2e2e2';

function colName(i: number): string {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

type Merge = { rs: number; cs: number };

function cellStyle(cell: XlsxCell | undefined, sheet: XlsxSheet, width: number, height: number): CSSProperties {
  const look = cell?.look;
  const bg = cell?.cf?.bg ?? look?.bg;
  const align =
    !look || look.align === 'general'
      ? cell?.kind === 'number'
        ? 'right'
        : cell?.kind === 'bool' || cell?.kind === 'error'
          ? 'center'
          : 'left'
      : look.align;
  const edge = (explicit: string | undefined) => explicit ?? (sheet.showGrid ? `1px solid ${GRID}` : undefined);
  const bar = cell?.cf?.bar;
  return {
    width,
    maxWidth: width,
    height,
    boxSizing: 'border-box',
    padding: `0 ${3}px 0 ${3 + (look?.indentPx ?? 0)}px`,
    overflow: 'hidden',
    background: bar ? `linear-gradient(to right, ${bar.color} ${bar.pct}%, transparent ${bar.pct}%)` : undefined,
    backgroundColor: bg,
    color: cell?.cf?.color ?? cell?.formatColor ?? look?.color ?? '#000000',
    fontWeight: (cell?.cf?.bold ?? look?.bold) ? 700 : 400,
    fontStyle: look?.italic ? 'italic' : 'normal',
    textDecoration:
      [look?.underline ? 'underline' : '', look?.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none',
    fontSize: look ? look.fontPx : 14.67,
    fontFamily: `"${look?.font ?? 'Calibri'}", Calibri, Carlito, system-ui, sans-serif`,
    textAlign: align,
    verticalAlign: look?.vAlign === 'top' ? 'top' : look?.vAlign === 'center' ? 'middle' : 'bottom',
    whiteSpace: look?.wrap ? 'pre-wrap' : 'nowrap',
    overflowWrap: look?.wrap ? 'break-word' : undefined,
    borderLeft: look?.borders[0],
    borderTop: look?.borders[1],
    borderRight: edge(look?.borders[2]),
    borderBottom: edge(look?.borders[3]),
  };
}

function SheetView({
  sheet,
  limit,
  hits,
  current,
}: {
  sheet: XlsxSheet;
  limit: number;
  hits: Set<string>;
  current: string | undefined;
}) {
  const shown = Math.min(limit, sheet.rows.length);
  const cols = Math.max(sheet.columns, sheet.colWidths.length);
  const widths = Array.from({ length: cols }, (_, c) => sheet.colWidths[c] ?? 64);
  const merged = useMemo(() => {
    const starts = new Map<string, Merge>();
    const covered = new Set<string>();
    for (const m of sheet.merges) {
      if (m.r1 >= shown) continue;
      starts.set(`${m.r1}:${m.c1}`, { rs: Math.min(m.r2, shown - 1) - m.r1 + 1, cs: m.c2 - m.c1 + 1 });
      for (let r = m.r1; r <= Math.min(m.r2, shown - 1); r++)
        for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(`${r}:${c}`);
    }
    return { starts, covered };
  }, [sheet, shown]);

  const rowTop: number[] = [];
  let y = COL_HEADER_H;
  for (let r = 0; r < shown; r++) {
    rowTop[r] = y;
    if (!sheet.rowHidden[r]) y += sheet.rowHeights[r] ?? sheet.defaultRowPx;
  }
  const colLeft: number[] = [];
  let x = ROW_HEADER_W;
  for (let c = 0; c < cols; c++) {
    colLeft[c] = x;
    x += widths[c];
  }

  const header: CSSProperties = {
    position: 'sticky',
    top: 0,
    zIndex: 4,
    height: COL_HEADER_H,
    background: '#f3f3f3',
    color: '#555',
    fontSize: 12,
    fontWeight: 400,
    textAlign: 'center',
    borderRight: `1px solid #d4d4d4`,
    borderBottom: `1px solid #d4d4d4`,
    boxSizing: 'border-box',
  };

  return (
    <div style={{ position: 'relative', width: x, minWidth: x }}>
      <table className={styles.xlsxTable} style={{ width: x }}>
        <colgroup>
          <col style={{ width: ROW_HEADER_W }} />
          {widths.map((w, c) => (
            <col key={c} style={{ width: w }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th style={{ ...header, left: 0, zIndex: 6 }} />
            {widths.map((w, c) => (
              <th
                key={c}
                style={{
                  ...header,
                  ...(c < sheet.freezeCols ? { left: colLeft[c], zIndex: 5 } : null),
                  visibility: w === 0 ? 'hidden' : undefined,
                }}
              >
                {colName(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: shown }, (_, r) => {
            if (sheet.rowHidden[r]) return null;
            const row = sheet.rows[r] ?? [];
            const height = sheet.rowHeights[r] ?? sheet.defaultRowPx;
            const tds = [];
            for (let c = 0; c < cols; c++) {
              const key = `${r}:${c}`;
              if (merged.covered.has(key)) continue;
              const cell = row[c];
              const m = merged.starts.get(key);
              let colSpan = m?.cs ?? 1;
              let w = widths[c];
              if (m) for (let k = 1; k < m.cs; k++) w += widths[c + k] ?? 0;
              // text that is longer than its column runs on over the empty cells to its right, as in Excel
              if (
                !m &&
                cell?.kind === 'text' &&
                !cell.look.wrap &&
                cell.look.align !== 'right' &&
                cell.look.align !== 'center'
              ) {
                const need = cell.text.length * cell.look.fontPx * 0.52 + 8;
                while (
                  w < need &&
                  c + colSpan < cols &&
                  !row[c + colSpan]?.text &&
                  !merged.covered.has(`${r}:${c + colSpan}`) &&
                  !merged.starts.has(`${r}:${c + colSpan}`)
                ) {
                  w += widths[c + colSpan];
                  colSpan++;
                }
              }
              const frozenRow = r < sheet.freezeRows;
              const frozenCol = c < sheet.freezeCols;
              const isHit = hits.has(key);
              tds.push(
                <td
                  key={c}
                  colSpan={colSpan}
                  rowSpan={m?.rs}
                  data-cell={key}
                  data-hit={isHit || undefined}
                  data-current={isHit && current === key ? true : undefined}
                  style={{
                    ...cellStyle(cell, sheet, w, height),
                    ...(frozenRow || frozenCol
                      ? {
                          position: 'sticky',
                          top: frozenRow ? rowTop[r] : undefined,
                          left: frozenCol ? colLeft[c] : undefined,
                          zIndex: frozenRow && frozenCol ? 3 : 2,
                          backgroundColor: cell?.cf?.bg ?? cell?.look.bg ?? '#ffffff',
                        }
                      : null),
                    ...(widths[c] === 0 ? { visibility: 'hidden', padding: 0, border: 0 } : null),
                  }}
                >
                  {cell?.text}
                </td>,
              );
              c += colSpan - 1;
            }
            return (
              <tr key={r} style={{ height }}>
                <th
                  scope="row"
                  style={{
                    position: 'sticky',
                    left: 0,
                    zIndex: 3,
                    top: r < sheet.freezeRows ? rowTop[r] : undefined,
                    width: ROW_HEADER_W,
                    background: '#f3f3f3',
                    color: '#555',
                    fontSize: 12,
                    fontWeight: 400,
                    textAlign: 'center',
                    borderRight: '1px solid #d4d4d4',
                    borderBottom: '1px solid #d4d4d4',
                    boxSizing: 'border-box',
                  }}
                >
                  {r + 1}
                </th>
                {tds}
              </tr>
            );
          })}
        </tbody>
      </table>
      {sheet.shapes.length > 0 && (
        <div
          style={{
            position: 'absolute',
            left: ROW_HEADER_W,
            top: COL_HEADER_H,
            width: 0,
            height: 0,
            zIndex: 3,
            pointerEvents: 'none',
          }}
          aria-hidden="true"
        >
          {sheet.shapes.map((s, i) => (
            <Shape key={i} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

/** An Excel workbook drawn as Excel shows it: colours, fonts, borders, merged cells, number formats, charts and pictures. */
export function XlsxReader({ item, onFacts, actions }: ReaderProps) {
  const [state, retry] = useFileData(item.src, XLSX_LIMIT);
  const [book, setBook] = useState<XlsxBook | { error: 'protected' | 'too-large' | 'damaged' } | null>(null);
  const [active, setActive] = useState(0);
  const [limit, setLimit] = useState(PAGE_ROWS);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // The workbook is read when its bytes arrive; its pictures are object URLs that are given back on the way out.
  useEffect(() => {
    if (state.status !== 'ready') return;
    if (state.truncated) {
      setBook({ error: 'too-large' });
      return;
    }
    const urls: string[] = [];
    try {
      setBook(
        parseXlsxBook(state.bytes, (data, mime) => {
          const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
          urls.push(url);
          return url;
        }),
      );
    } catch (err) {
      setBook({ error: err instanceof XlsxError ? err.reason : 'damaged' });
    }
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [state]);

  useEffect(() => {
    setActive(0);
    setLimit(PAGE_ROWS);
  }, [item.src]);
  useEffect(() => {
    setLimit(PAGE_ROWS);
    setCurrent(0);
  }, [active, query]);

  const ok = book && 'sheets' in book ? book : null;
  const sheet = ok ? ok.sheets[Math.min(active, ok.sheets.length - 1)] : null;
  useEffect(() => {
    if (ok) onFacts({ Sheets: String(ok.sheets.length), Columns: String(ok.sheets[0].columns) });
  }, [ok, onFacts]);

  useViewerKeys((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      searchRef.current?.focus();
      return true;
    }
    return false;
  });

  const q = query.trim().toLowerCase();
  const hitList = useMemo(() => {
    if (!sheet || !q) return [] as string[];
    const found: string[] = [];
    sheet.rows.forEach((row, r) =>
      row.forEach((cell, c) => {
        if (cell?.text.toLowerCase().includes(q)) found.push(`${r}:${c}`);
      }),
    );
    return found;
  }, [sheet, q]);
  const hits = useMemo(() => new Set(hitList), [hitList]);
  const here = hitList[current];
  useEffect(() => {
    if (!here) return;
    const row = Number(here.split(':')[0]);
    if (row >= limit) setLimit(Math.ceil((row + 1) / PAGE_ROWS) * PAGE_ROWS);
    scrollRef.current?.querySelector(`[data-cell="${here}"]`)?.scrollIntoView({ block: 'center', inline: 'center' });
  }, [here, limit]);

  function body() {
    if (!book) return null;
    if ('error' in book) {
      const copy = {
        protected: [
          'This file needs a password',
          'Previews cannot open protected files. Download it and open it in an app.',
        ],
        'too-large': ['Too large to preview', `${item.name} is too large to read here. Download it to see everything.`],
        damaged: [
          'Could not make a preview',
          'The file may be damaged or in a format we cannot read. Nothing was changed.',
        ],
      }[book.error];
      return (
        <StatePanel tone={book.error === 'damaged' ? 'error' : 'warn'} title={copy[0]} actions={actions}>
          {copy[1]}
        </StatePanel>
      );
    }
    const s = sheet!;
    const more = s.rows.length > limit;
    return (
      <div className={styles.tableReader}>
        <div className={styles.readerBar}>
          <span className={styles.readerLabel}>
            {item.name} · {s.columns} {s.columns === 1 ? 'column' : 'columns'} ·{' '}
            {s.totalRows > s.rows.length || more
              ? `showing ${Math.min(limit, s.rows.length).toLocaleString()} of ${s.totalRows.toLocaleString()} rows`
              : `${s.totalRows.toLocaleString()} rows`}
          </span>
          <span className={styles.readerBarSpacer} />
          <label className={styles.searchBox}>
            <span className={styles.srOnly}>Search cells</span>
            <input
              ref={searchRef}
              type="search"
              placeholder="Search cells"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hitList.length) {
                  e.preventDefault();
                  setCurrent((c) => (c + (e.shiftKey ? -1 : 1) + hitList.length) % hitList.length);
                } else if (e.key === 'Escape' && query) {
                  e.stopPropagation();
                  setQuery('');
                }
              }}
            />
            {q && (
              <span className={styles.matchCount}>
                {hitList.length ? `${current + 1} of ${hitList.length}` : 'No matches'}
              </span>
            )}
          </label>
        </div>
        {(more || s.totalRows > s.rows.length) && (
          <Notice
            actions={
              <>
                {more && (
                  <button
                    type="button"
                    className={styles.btn}
                    data-testid="more-rows"
                    onClick={() => setLimit(limit + PAGE_ROWS)}
                  >
                    Show {Math.min(PAGE_ROWS, s.rows.length - limit).toLocaleString()} more rows
                  </button>
                )}
                {actions}
              </>
            }
          >
            Showing the first {Math.min(limit, s.rows.length).toLocaleString()} rows of {s.totalRows.toLocaleString()}.
            {!more && ' The rest is in the file: download it to see everything.'}
          </Notice>
        )}
        <div ref={scrollRef} className={styles.xlsxScroll} tabIndex={0} aria-label={`${s.name} sheet`}>
          <SheetView sheet={s} limit={limit} hits={hits} current={here} />
        </div>
        <div className={styles.sheetFooter}>
          {ok && ok.sheets.length > 1 && (
            <div className={styles.sheetTabs} role="tablist" aria-label="Sheets">
              {ok.sheets.map((t, i) => (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={i === active}
                  onClick={() => setActive(i)}
                  style={t.tabColor ? { boxShadow: `inset 0 -3px 0 ${t.tabColor}` } : undefined}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
          <span className={styles.readerLabel}>Formulas show their last saved result.</span>
        </div>
      </div>
    );
  }

  return (
    <AsyncBody state={state} retry={retry} actions={actions} name={item.name}>
      {body()}
    </AsyncBody>
  );
}
