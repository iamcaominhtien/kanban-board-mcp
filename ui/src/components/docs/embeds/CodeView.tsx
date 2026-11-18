/**
 * A code block with its options (design "Embeds", section D): a header with the file name tab, the language and
 * Copy ("Copied"), line numbers, wrapping, a light or dark theme, highlighted lines ("5-6,9") and diff mode (the
 * gutter shows + and -, the lines are tinted). Long code scrolls inside the block with "Show all N lines". Copy always
 * copies the code without line numbers or markers. Used by the reader for a block that has any of these options.
 */

import { useState, type ReactNode } from 'react';
import { highlight } from '../docsHighlight';
import { EmbIcon } from './embIcons';
import './embeds.css';

/** A block longer than this many lines scrolls inside a 236 px frame with "Show all N lines" (Embeds 35). */
export const LONG_CODE_LINES = 12;

/**
 * The "Show all N lines" pill over the fade at the foot of a long block, or "Show less" under an opened one.
 * @param props.all - The block is open in full.
 * @param props.lines - How many lines it has.
 * @param props.onToggle - Opens or folds the block.
 */
export function ShowAllButton({ all, lines, onToggle }: { all: boolean; lines: number; onToggle: () => void }) {
  return (
    <div className={all ? 'dk-cv-less' : 'dk-cv-more'} contentEditable={false}>
      {!all && <span className="dk-cv-fade" aria-hidden="true" />}
      <button
        type="button"
        className="dk-cv-all"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggle}
        data-testid="code-show-all"
      >
        <span style={all ? { transform: 'rotate(180deg)', display: 'inline-flex' } : { display: 'inline-flex' }}>
          <EmbIcon name="chevDown" size={13} sw={2.4} />
        </span>
        {all ? 'Show less' : `Show all ${lines} lines`}
      </button>
    </div>
  );
}

/**
 * The line numbers of a "5-6,9" list (1-based). Ranges may be written either way round; anything else is skipped.
 * @param spec - The `highlightLines` attribute.
 */
export function parseLineRanges(spec: string | null | undefined): Set<number> {
  const out = new Set<number>();
  for (const part of (spec ?? '').split(/[,\s]+/)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    const lo = Math.min(a, b);
    const hi = Math.min(Math.max(a, b), lo + 5000);
    for (let n = lo; n <= hi; n += 1) if (n > 0) out.add(n);
  }
  return out;
}

/** One line of a diff: its marker and text. */
export interface DiffLine {
  sign: '+' | '-' | ' ';
  text: string;
}

/** Splits a diff line into its marker (`+`, `-` or a space) and the code after it. */
export function diffLine(line: string): DiffLine {
  const c = line.charAt(0);
  if (c === '+' || c === '-') return { sign: c, text: line.slice(1) };
  return { sign: ' ', text: line.startsWith(' ') ? line.slice(1) : line };
}

/**
 * What Copy puts on the clipboard: the code itself, and for a diff the new version without its markers.
 * @param code - The block's text.
 * @param diff - Diff mode.
 */
export function copyText(code: string, diff: boolean): string {
  if (!diff) return code;
  return code
    .split('\n')
    .map(diffLine)
    .filter((l) => l.sign !== '-')
    .map((l) => l.text)
    .join('\n');
}

/** The name a language is shown with. */
export function languageName(lang: string): string {
  const names: Record<string, string> = {
    py: 'Python',
    python: 'Python',
    ts: 'TypeScript',
    typescript: 'TypeScript',
    js: 'JavaScript',
    javascript: 'JavaScript',
    sh: 'Shell',
    bash: 'Shell',
    json: 'JSON',
    sql: 'SQL',
    yaml: 'YAML',
    xml: 'HTML / XML',
    html: 'HTML',
    css: 'CSS',
    markdown: 'Markdown',
    diff: 'Diff',
    go: 'Go',
    rust: 'Rust',
    java: 'Java',
    ini: 'INI / TOML',
  };
  return names[lang.toLowerCase()] ?? (lang ? lang.charAt(0).toUpperCase() + lang.slice(1) : 'Plain text');
}

/** The options of a code block (its rich attributes). */
export interface CodeOptions {
  language?: string | null;
  filename?: string | null;
  lineNumbers?: boolean;
  wrap?: boolean;
  theme?: 'light' | 'dark' | null;
  highlightLines?: string | null;
  diff?: boolean;
}

/** True when a code block uses any option beyond its language (the reader then draws it with {@link CodeView}). */
export function hasCodeOptions(a: CodeOptions): boolean {
  return !!(a.filename || a.lineNumbers || a.wrap || a.theme || a.highlightLines || a.diff);
}

/** Props of {@link CodeView}. */
export interface CodeViewProps {
  code: string;
  options: CodeOptions;
  /** Attributes of the block element (`data-block-id`, the "Changed in" mark). */
  blockId?: string;
  className?: string;
  changedIn?: string;
}

/** The Copy button of a code header. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="dk-cv-copy"
      aria-label="Copy code"
      data-copied={copied ? '' : undefined}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? <EmbIcon name="check" size={13} sw={2.4} /> : <EmbIcon name="copy" size={13} sw={2.4} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * A code block with its options, read only.
 */
export function CodeView({ code, options, blockId, className, changedIn }: CodeViewProps) {
  const [all, setAll] = useState(false);
  const lang = options.language ?? '';
  const diff = !!options.diff;
  const marked = parseLineRanges(options.highlightLines);
  const lines = code.split('\n');
  const long = lines.length > LONG_CODE_LINES;
  const theme = options.theme === 'light' ? 'light' : 'dark';
  const rows: ReactNode[] = lines.map((raw, i) => {
    const d = diff ? diffLine(raw) : null;
    const text = d ? d.text : raw;
    const cls = [
      'dk-cv-line',
      marked.has(i + 1) ? 'dk-cv-hl' : '',
      d?.sign === '+' ? 'dk-cv-add' : d?.sign === '-' ? 'dk-cv-del' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div key={i} className={cls}>
        {(options.lineNumbers || diff) && (
          <span className="dk-cv-gutter" aria-hidden="true">
            {diff ? d?.sign.trim() || ' ' : i + 1}
          </span>
        )}
        <span className="dk-cv-text">{text ? highlight(text, lang) : ' '}</span>
      </div>
    );
  });
  return (
    <div
      className={['dk-code dk-cv', `dk-cv-${theme}`, options.wrap ? 'dk-cv-wrap' : 'dk-cv-nowrap', className]
        .filter(Boolean)
        .join(' ')}
      data-lang={lang || undefined}
      data-block-id={blockId}
      data-changed-in={changedIn}
      data-testid="code-view"
    >
      <div className="dk-cv-head">
        {options.filename && (
          <span className="dk-cv-file">
            <EmbIcon name="page" size={12} />
            {options.filename}
          </span>
        )}
        <span className="dk-cv-lang">{diff ? 'Diff' : languageName(lang)}</span>
        <CopyButton text={copyText(code, diff)} />
      </div>
      <div className="dk-cv-frame">
        <div className={`dk-cv-body${long && !all ? ' dk-cv-clip' : ''}`}>{rows}</div>
        {long && <ShowAllButton all={all} lines={lines.length} onToggle={() => setAll((v) => !v)} />}
      </div>
    </div>
  );
}
