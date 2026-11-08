import { useEffect, useMemo, useRef, useState } from 'react';
import { Notice, StatePanel } from './StatePanel';
import { AsyncBody } from './TextReader';
import { decodeText, looksLikeText, useFileData } from './useFileData';
import { useViewerKeys } from './useViewerKeys';
import { ROW_LIMIT, csvToSheet, type Sheet } from './tables';
import { XlsxReader } from './XlsxReader';
import { getFileExtension, formatFileSize } from '../../utils/fileIcons';
import type { ReaderProps } from './readerTypes';
import styles from './PreviewViewer.module.css';

const CSV_LIMIT = 8 * 1024 * 1024;

type Parsed = { ok: true; sheets: Sheet[]; delimiter?: string } | { ok: false; reason: 'too-large' | 'binary' };

/** CSV and TSV as a table with search and a frozen header; Excel files are drawn by `XlsxReader`. */
export function TableReader(props: ReaderProps) {
  return getFileExtension(props.item.name) === 'xlsx' ? <XlsxReader {...props} /> : <DelimitedReader {...props} />;
}

function DelimitedReader({ item, onFacts, actions, downloadHref }: ReaderProps) {
  const ext = getFileExtension(item.name);
  const [state, retry] = useFileData(item.src, CSV_LIMIT);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const tableRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const parsed: Parsed | null = useMemo(() => {
    if (state.status !== 'ready') return null;
    if (!looksLikeText(state.bytes)) return { ok: false, reason: 'binary' };
    const { sheet, delimiter } = csvToSheet(decodeText(state.bytes), ext);
    if (state.truncated) sheet.totalRows = Math.max(sheet.totalRows, ROW_LIMIT + 1);
    return { ok: true, sheets: [sheet], delimiter };
  }, [state, ext]);

  useEffect(() => setActive(0), [item.src]);
  useEffect(() => setCurrent(0), [query, active]);

  useEffect(() => {
    if (!parsed?.ok) return;
    const s = parsed.sheets;
    const facts: Record<string, string> = {};
    if (parsed.delimiter) facts.Delimiter = parsed.delimiter;
    facts.Columns = String(s[0].columns);
    onFacts(facts);
  }, [parsed, onFacts]);

  useViewerKeys((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      searchRef.current?.focus();
      return true;
    }
    return false;
  });

  const sheet = parsed?.ok ? parsed.sheets[Math.min(active, parsed.sheets.length - 1)] : null;
  const q = query.trim().toLowerCase();
  const hits = useMemo(() => {
    if (!sheet || !q) return [] as string[];
    const found: string[] = [];
    sheet.rows.forEach((r, i) =>
      r.forEach((cell, j) => {
        if (cell.toLowerCase().includes(q)) found.push(`${i}:${j}`);
      }),
    );
    return found;
  }, [sheet, q]);

  useEffect(() => {
    if (!hits.length) return;
    tableRef.current
      ?.querySelector(`[data-cell="${hits[current]}"]`)
      ?.scrollIntoView({ block: 'center', inline: 'center' });
  }, [hits, current]);

  const hitSet = useMemo(() => new Set(hits), [hits]);

  function body() {
    if (!parsed) return null;
    if (!parsed.ok) {
      const copy = {
        'too-large': ['Too large to preview', `${item.name} is too large to read here. Download it to see everything.`],
        binary: [
          'Not readable as text',
          'This file has a text name but contains binary data. Showing the file facts instead.',
        ],
      }[parsed.reason];
      return (
        <StatePanel tone="warn" title={copy[0]} actions={actions}>
          {copy[1]}
        </StatePanel>
      );
    }
    const shown = sheet!;
    const header = shown.rows[0] ?? [];
    const cols = Math.max(shown.columns, header.length);
    const more = shown.totalRows > shown.rows.length;
    return (
      <div className={styles.tableReader}>
        <div className={styles.readerBar}>
          <span className={styles.readerLabel}>
            {item.name} · {shown.columns} {shown.columns === 1 ? 'column' : 'columns'} ·{' '}
            {more
              ? `showing ${shown.rows.length.toLocaleString()} of ${shown.totalRows.toLocaleString()}${state.status === 'ready' && state.truncated ? '+' : ''} rows`
              : `${shown.totalRows.toLocaleString()} rows`}
          </span>
          {parsed?.ok && parsed.delimiter && (
            <span className={styles.readerChip} data-testid="csv-delimiter">
              Delimiter: {parsed.delimiter}
            </span>
          )}
          <span className={styles.readerBarSpacer} />
          {more && downloadHref && (
            <a className={styles.btn} href={downloadHref} download={item.name} data-testid="csv-download-all">
              Download all rows
            </a>
          )}
          <label className={styles.searchBox}>
            <span className={styles.srOnly}>Search cells</span>
            <input
              ref={searchRef}
              type="search"
              placeholder="Search cells"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hits.length) {
                  e.preventDefault();
                  setCurrent((c) => (c + (e.shiftKey ? -1 : 1) + hits.length) % hits.length);
                } else if (e.key === 'Escape' && query) {
                  e.stopPropagation();
                  setQuery('');
                }
              }}
            />
            {q && (
              <span className={styles.matchCount}>
                {hits.length ? `${current + 1} of ${hits.length}` : 'No matches'}
              </span>
            )}
          </label>
        </div>
        {more && (
          <Notice>
            Showing the first {ROW_LIMIT} rows. The full file has {shown.totalRows.toLocaleString()}
            {state.status === 'ready' && state.truncated ? '+' : ''} rows
            {state.status === 'ready' && state.truncated && state.total ? ` (${formatFileSize(state.total)})` : ''}.
            Download it to see everything.
          </Notice>
        )}
        <div ref={tableRef} className={styles.tableScroll} tabIndex={0} aria-label={`${shown.name} table`}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.rowNo} />
                {Array.from({ length: cols }, (_, j) => (
                  <th key={j} scope="col">
                    {header[j] ?? ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.rows.slice(1).map((r, i) => (
                <tr key={i}>
                  <th scope="row" className={styles.rowNo}>
                    {i + 1}
                  </th>
                  {Array.from({ length: cols }, (_, j) => {
                    const key = `${i + 1}:${j}`;
                    const isHit = hitSet.has(key);
                    return (
                      <td
                        key={j}
                        data-cell={key}
                        data-hit={isHit || undefined}
                        data-current={isHit && hits[current] === key ? true : undefined}
                      >
                        {r[j] ?? ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
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
