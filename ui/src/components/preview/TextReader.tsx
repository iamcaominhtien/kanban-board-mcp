import { useEffect, useMemo, useRef, useState } from 'react';
import { StatePanel, Notice } from './StatePanel';
import { decodeText, looksLikeText, useFileData } from './useFileData';
import { isTyping, useViewerKeys } from './useViewerKeys';
import { languageLabel } from './kinds';
import { formatFileSize } from '../../utils/fileIcons';
import type { ReaderProps } from './readerTypes';
import styles from './PreviewViewer.module.css';

/** Most bytes of a text file shown; longer files show the first part with a note. */
export const TEXT_LIMIT = 1024 * 1024;
/** Height of one row; only the rows in view are drawn, so a long log opens at once. */
const LINE_HEIGHT = 20;
const OVERSCAN = 30;
/** Wrapped rows differ in height, so they are not windowed; only the first part is drawn until asked for more. */
const WRAP_LIMIT = 2000;

/** Highlight words in a line of code or log, without running anything. */
function tint(line: string, lang: string): { cls: string; text: string }[] {
  if (/^(\s*\/\/|\s*#|\s*--|\s*\*|\s*\/\*)/.test(line) && lang !== 'Log')
    return [{ cls: styles.tokComment, text: line }];
  if (lang === 'Log') {
    const m = line.match(/\b(ERROR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/);
    if (m && m.index !== undefined) {
      const level = m[1].startsWith('WARN')
        ? styles.tokWarn
        : /ERROR|FATAL/.test(m[1])
          ? styles.tokError
          : styles.tokInfo;
      return [
        { cls: '', text: line.slice(0, m.index) },
        { cls: level, text: m[1] },
        { cls: '', text: line.slice(m.index + m[1].length) },
      ];
    }
    return [{ cls: '', text: line }];
  }
  if (lang === 'Plain text') return [{ cls: '', text: line }];
  const parts: { cls: string; text: string }[] = [];
  const re =
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|for|while|import|export|from|class|async|await|new|throw|try|catch|def|true|false|null|undefined|interface|type)\b|\b(\d+(?:\.\d+)?)\b/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) parts.push({ cls: '', text: line.slice(last, m.index) });
    parts.push({ cls: m[1] ? styles.tokString : m[2] ? styles.tokKeyword : styles.tokNumber, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ cls: '', text: line.slice(last) });
  return parts.length ? parts : [{ cls: '', text: line }];
}

/** Toolbar shared by the text-like readers: search, wrap, line numbers, copy. */
function Toolbar(props: {
  label: string;
  query: string;
  setQuery: (q: string) => void;
  matches: number;
  current: number;
  step: (dir: 1 | -1) => void;
  wrap: boolean;
  setWrap: (v: boolean) => void;
  numbers: boolean;
  setNumbers: (v: boolean) => void;
  onCopy: () => void;
  copied: boolean;
  searchRef: React.RefObject<HTMLInputElement>;
}) {
  const { query, matches, current } = props;
  return (
    <div className={styles.readerBar}>
      <span className={styles.readerLabel}>{props.label}</span>
      <span className={styles.readerBarSpacer} />
      <label className={styles.searchBox}>
        <span className={styles.srOnly}>Search in file</span>
        <input
          ref={props.searchRef}
          type="search"
          placeholder="Search"
          value={query}
          onChange={(e) => props.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              props.step(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape' && query) {
              e.stopPropagation();
              props.setQuery('');
            }
          }}
        />
        {query && <span className={styles.matchCount}>{matches ? `${current + 1} of ${matches}` : 'No matches'}</span>}
      </label>
      <button type="button" onClick={() => props.step(-1)} disabled={!matches} aria-label="Previous match">
        ↑
      </button>
      <button type="button" onClick={() => props.step(1)} disabled={!matches} aria-label="Next match">
        ↓
      </button>
      <label className={styles.check}>
        <input type="checkbox" checked={props.numbers} onChange={(e) => props.setNumbers(e.target.checked)} />
        Line numbers
      </label>
      <label className={styles.check}>
        <input type="checkbox" checked={props.wrap} onChange={(e) => props.setWrap(e.target.checked)} />
        Wrap
      </label>
      <button type="button" onClick={props.onCopy}>
        {props.copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** Lines of text with numbers, colour, search, wrap and copy. Shared by text, code, JSON (raw) and Markdown (source). */
export function TextBody({
  text,
  lang,
  label,
  truncatedNote,
  extraBar,
}: {
  text: string;
  lang: string;
  label: string;
  truncatedNote?: React.ReactNode;
  extraBar?: React.ReactNode;
}) {
  const [wrap, setWrap] = useState(false);
  const [numbers, setNumbers] = useState(lang !== 'Plain text');
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const [copied, setCopied] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [showAllWrapped, setShowAllWrapped] = useState(false);
  const lines = useMemo(() => text.split('\n'), [text]);

  const hits = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return [] as number[];
    const found: number[] = [];
    lines.forEach((l, i) => {
      if (l.toLowerCase().includes(q)) found.push(i);
    });
    return found;
  }, [lines, query]);

  useEffect(() => setCurrent(0), [query]);

  useViewerKeys((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      searchRef.current?.focus();
      searchRef.current?.select();
      return true;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'w' || e.key === 'W') && !isTyping(e)) {
      setWrap((v) => !v);
      return true;
    }
    return false;
  });

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const update = () => setViewH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!hits.length) return;
    const el = bodyRef.current;
    if (!el) return;
    // One row is a fixed height unless lines wrap, so a match is found by its position
    if (!wrap) el.scrollTop = Math.max(0, hits[current] * LINE_HEIGHT - el.clientHeight / 2);
    else el.querySelector(`[data-line="${hits[current]}"]`)?.scrollIntoView({ block: 'center' });
  }, [hits, current, wrap]);

  function step(dir: 1 | -1) {
    if (!hits.length) return;
    setCurrent((c) => (c + dir + hits.length) % hits.length);
  }

  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  const hitSet = useMemo(() => new Set(hits), [hits]);
  const first = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((scrollTop + viewH) / LINE_HEIGHT) + OVERSCAN);
  const width = String(lines.length).length;
  const q = query.toLowerCase();

  function renderLine(line: string, i: number) {
    const parts = tint(line, lang);
    const isHit = hitSet.has(i);
    return (
      <div
        key={i}
        data-line={i}
        className={styles.codeLine}
        data-hit={isHit || undefined}
        data-current={isHit && hits[current] === i ? true : undefined}
      >
        {numbers && (
          <span className={styles.lineNo} style={{ minWidth: `${width}ch` }} aria-hidden="true">
            {i + 1}
          </span>
        )}
        <span className={styles.lineText}>
          {parts.map((p, k) => {
            if (!isHit)
              return (
                <span key={k} className={p.cls}>
                  {p.text}
                </span>
              );
            const low = p.text.toLowerCase();
            const out: React.ReactNode[] = [];
            let from = 0;
            for (let at = low.indexOf(q); at !== -1; at = low.indexOf(q, from)) {
              if (at > from) out.push(p.text.slice(from, at));
              out.push(<mark key={`${k}-${at}`}>{p.text.slice(at, at + q.length)}</mark>);
              from = at + q.length;
            }
            out.push(p.text.slice(from));
            return (
              <span key={k} className={p.cls}>
                {out}
              </span>
            );
          })}
          {line === '' && '​'}
        </span>
      </div>
    );
  }

  return (
    <div className={styles.textReader}>
      <Toolbar
        label={label}
        query={query}
        setQuery={setQuery}
        matches={hits.length}
        current={current}
        step={step}
        wrap={wrap}
        setWrap={setWrap}
        numbers={numbers}
        setNumbers={setNumbers}
        onCopy={copy}
        copied={copied}
        searchRef={searchRef}
      />
      {extraBar}
      {truncatedNote}
      <div
        ref={bodyRef}
        className={styles.codeBody}
        data-wrap={wrap || undefined}
        tabIndex={0}
        aria-label="File contents"
        onScroll={(e) => !wrap && setScrollTop(e.currentTarget.scrollTop)}
      >
        {wrap ? (
          <>
            {lines.slice(0, showAllWrapped ? lines.length : WRAP_LIMIT).map(renderLine)}
            {!showAllWrapped && lines.length > WRAP_LIMIT && (
              <div className={styles.wrapMore}>
                Wrapped lines show the first {WRAP_LIMIT.toLocaleString()} of {lines.length.toLocaleString()} lines.{' '}
                <button type="button" onClick={() => setShowAllWrapped(true)}>
                  Show all
                </button>{' '}
                or turn Wrap off to scroll through everything.
              </div>
            )}
          </>
        ) : (
          <div style={{ height: lines.length * LINE_HEIGHT, position: 'relative', minWidth: 'max-content' }}>
            <div style={{ position: 'absolute', top: first * LINE_HEIGHT, left: 0, minWidth: '100%' }}>
              {lines.slice(first, last).map((line, k) => renderLine(line, first + k))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Text, logs and code. */
export function TextReader({ item, onFacts, actions }: ReaderProps) {
  const [state, retry] = useFileData(item.src, TEXT_LIMIT);
  const lang = languageLabel(item.name);
  const text = useMemo(() => (state.status === 'ready' ? decodeText(state.bytes) : ''), [state]);
  const binary = state.status === 'ready' && !looksLikeText(state.bytes);

  useEffect(() => {
    if (state.status !== 'ready' || binary) return;
    const count = text.split('\n').length;
    onFacts({ Lines: count.toLocaleString(), Encoding: 'UTF-8' });
  }, [state, binary, text, onFacts]);

  return (
    <AsyncBody state={state} retry={retry} actions={actions} name={item.name}>
      {state.status === 'ready' &&
        (binary ? (
          <StatePanel tone="warn" title="Not readable as text" actions={actions}>
            This file has a .{item.name.split('.').pop()} name but contains binary data. Showing the file facts instead.
          </StatePanel>
        ) : (
          <TextBody
            text={text}
            lang={lang}
            label={`${lang} · ${text.split('\n').length.toLocaleString()} lines`}
            truncatedNote={
              state.truncated && (
                <Notice actions={actions}>
                  Showing the first {formatFileSize(TEXT_LIMIT)}
                  {state.total ? ` of ${formatFileSize(state.total)}` : ''}. Only the beginning is shown.
                </Notice>
              )
            }
          />
        ))}
    </AsyncBody>
  );
}

/** Maps a read state to its loading / problem screen, or renders the children when the file is ready. */
export function AsyncBody({
  state,
  retry,
  actions,
  name,
  children,
}: {
  state: import('./useFileData').LoadState;
  retry: () => void;
  actions: React.ReactNode;
  name: string;
  children: React.ReactNode;
}) {
  if (state.status === 'loading') return <StatePanel tone="loading" title={`Opening ${name}…`} />;
  if (state.status === 'missing')
    return (
      <StatePanel tone="warn" title="This file is no longer available" actions={actions}>
        It was deleted, or you do not have access to it. The name shown is “{name}”.
      </StatePanel>
    );
  if (state.status === 'offline')
    return (
      <StatePanel
        tone="warn"
        title="Could not reach the server"
        actions={
          <>
            <button type="button" className={styles.btn} onClick={retry}>
              Retry
            </button>
            {actions}
          </>
        }
      >
        Check your connection. Files already opened in this session stay available.
      </StatePanel>
    );
  if (state.status === 'error')
    return (
      <StatePanel
        tone="error"
        title="Could not make a preview"
        actions={
          <>
            <button type="button" className={styles.btn} onClick={retry}>
              Try again
            </button>
            {actions}
          </>
        }
      >
        The file may be damaged or in a format we cannot read. Nothing was changed.
      </StatePanel>
    );
  return <>{children}</>;
}
