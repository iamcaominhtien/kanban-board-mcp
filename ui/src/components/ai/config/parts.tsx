import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { AiConfig } from '../../../types/ai';
import { ago } from '../aiUi';
import type { ConfigIssue, DiffRow, DocumentedItem } from './configApi';
import './config.css';

/** The editable part of the Configuration tab that is not in `config`: connection fields of the member. */
export interface MemberDraft {
  name: string;
  color: string;
  glyph: string;
  persona: string;
  description: string;
  workingDir: string;
  model: string;
  maxParallel: number;
  maxRunsPerDay: number;
  dailyBudget: number;
  monthlyCap: number;
  config: AiConfig;
}

export type SetCfg = (patch: Partial<AiConfig>) => void;
export type SetDraft = (patch: Partial<MemberDraft>) => void;

/** New id for a config item typed in the UI. */
export function newId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && 'randomUUID' in c) return c.randomUUID().replace(/-/g, '').slice(0, 12);
  return Math.random().toString(16).slice(2, 14).padEnd(12, '0');
}

/** `value`, but only after it stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const MODE_TEXT = {
  synced: 'Synced',
  documented: 'Documented',
  not_supported: 'Not supported',
  direct: 'Used directly',
};

/** Synced / Documented / Not supported chip (design A2 legend). */
export function ModeChip({
  mode,
  label,
}: {
  mode: 'synced' | 'documented' | 'not_supported' | 'direct';
  label?: string;
}) {
  const cls =
    mode === 'synced' || mode === 'direct'
      ? 'cfg-chip-synced'
      : mode === 'documented'
        ? 'cfg-chip-documented'
        : 'cfg-chip-none';
  return (
    <span className={`ai-chip ${cls}`} data-testid={`mode-${mode}`}>
      {label ?? MODE_TEXT[mode]}
    </span>
  );
}

/** Small neutral chip. */
export function Chip({
  children,
  tone = 'plain',
  title,
}: {
  children: ReactNode;
  tone?: 'plain' | 'lib' | 'warn' | 'bad' | 'synced';
  title?: string;
}) {
  return (
    <span className={`ai-chip cfg-chip-${tone}`} title={title} style={{ height: 20, fontSize: 10.5 }}>
      {children}
    </span>
  );
}

/** A card of the tab: title, mode chip, optional right slot. */
export function CfgCard({
  title,
  sub,
  mode,
  right,
  children,
  testId,
  id,
}: {
  title: string;
  sub?: ReactNode;
  mode?: 'synced' | 'documented' | 'not_supported' | 'direct';
  right?: ReactNode;
  children: ReactNode;
  testId?: string;
  id?: string;
}) {
  return (
    <section className="ai-card" data-testid={testId} id={id} style={{ minWidth: 0 }}>
      <div className="cfg-card-head">
        <span className="cfg-card-title">{title}</span>
        {mode && <ModeChip mode={mode} />}
        <span style={{ flex: 1 }} />
        {right}
      </div>
      <div className="cfg-card-body">
        {sub && <div className="cfg-sub">{sub}</div>}
        {children}
      </div>
    </section>
  );
}

/** The messages for one config path (errors red, warnings amber). */
export function IssueText({ issues, path, prefix }: { issues: ConfigIssue[]; path: string; prefix?: boolean }) {
  const mine = issues.filter((i) => (prefix ? i.path === path || i.path.startsWith(`${path}.`) : i.path === path));
  if (!mine.length) return null;
  return (
    <>
      {mine.map((i, k) => (
        <div
          key={k}
          className={i.severity === 'error' ? 'ai-error-text' : 'ai-hint'}
          style={i.severity === 'error' ? undefined : { color: '#8a5a12' }}
          data-testid="cfg-issue"
        >
          {i.message}
        </div>
      ))}
    </>
  );
}

/** Does any error sit on this path (for the red border)? */
export function hasError(issues: ConfigIssue[], path: string, prefix = false): boolean {
  return issues.some((i) => i.severity === 'error' && (i.path === path || (prefix && i.path.startsWith(`${path}.`))));
}

/** Labelled number input with an optional unit and inline error. */
export function NumField({
  label,
  value,
  onChange,
  path,
  issues,
  unit,
  step = 1,
  id,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  path: string;
  issues: ConfigIssue[];
  unit?: string;
  step?: number;
  id?: string;
  hint?: string;
}) {
  return (
    <div className="ai-field">
      <span className="ai-label ai-label-dark">{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          id={id}
          data-path={path}
          className={`ai-input ${hasError(issues, path) ? 'ai-input-error' : ''}`}
          type="number"
          step={step}
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {unit && (
          <span className="ai-muted" style={{ whiteSpace: 'nowrap' }}>
            {unit}
          </span>
        )}
      </div>
      <IssueText issues={issues} path={path} />
      {hint && <span className="ai-muted">{hint}</span>}
    </div>
  );
}

/** A text area with line numbers; lines in `bad` are marked, lines in `mark` softly highlighted. */
export function CodeEditor({
  value,
  onChange,
  rows = 10,
  bad = [],
  mark = [],
  readOnly,
  placeholder,
  path,
  testId,
  ariaLabel,
  insertRef,
}: {
  value: string;
  onChange?: (v: string) => void;
  /** Filled with a function that inserts text at the cursor. */
  insertRef?: MutableRefObject<((text: string) => void) | null>;
  rows?: number;
  bad?: number[];
  mark?: number[];
  readOnly?: boolean;
  placeholder?: string;
  path?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const gut = useRef<HTMLDivElement>(null);
  const hl = useRef<HTMLDivElement>(null);
  const lines = value.split('\n').length;
  const count = Math.max(lines, rows);
  useEffect(() => {
    if (!insertRef) return;
    insertRef.current = (text: string) => {
      const el = ta.current;
      const a = el?.selectionStart ?? value.length;
      const b = el?.selectionEnd ?? a;
      onChange?.(value.slice(0, a) + text + value.slice(b));
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(a + text.length, a + text.length);
      });
    };
  });
  const sync = () => {
    if (!ta.current) return;
    if (gut.current) gut.current.scrollTop = ta.current.scrollTop;
    if (hl.current) hl.current.scrollTop = ta.current.scrollTop;
  };
  return (
    <div className={`cfg-code ${bad.length ? 'cfg-code-err' : ''}`}>
      <div className="cfg-code-gutter" ref={gut} style={{ height: rows * 18 + 16 }} aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={bad.includes(i + 1) ? 'cfg-ln-bad' : ''}>
            {i + 1}
          </div>
        ))}
      </div>
      <div className="cfg-code-pane">
        <div className="cfg-code-hl" ref={hl} aria-hidden="true">
          {Array.from({ length: count }, (_, i) => (
            <div key={i} className={bad.includes(i + 1) ? 'cfg-hl-bad' : mark.includes(i + 1) ? 'cfg-hl-var' : ''} />
          ))}
        </div>
        <textarea
          ref={ta}
          data-testid={testId}
          data-path={path}
          aria-label={ariaLabel}
          spellCheck={false}
          wrap="off"
          readOnly={readOnly}
          placeholder={placeholder}
          value={value}
          rows={rows}
          style={{ height: rows * 18 + 16 }}
          onScroll={sync}
          onChange={(e) => onChange?.(e.target.value)}
        />
      </div>
    </div>
  );
}

/** A unified diff: line numbers, + and - rows. */
export function DiffView({ rows, empty = 'No changes.' }: { rows: DiffRow[]; empty?: string }) {
  if (!rows.length) return <div className="ai-muted">{empty}</div>;
  return (
    <div className="cfg-diff" data-testid="cfg-diff">
      {rows.map((r, i) =>
        r.t === '…' ? (
          <div key={i} className="cfg-diff-row cfg-diff-gap" style={{ justifyContent: 'center' }}>
            ⋯
          </div>
        ) : (
          <div key={i} className={`cfg-diff-row ${r.t === '+' ? 'cfg-diff-add' : r.t === '-' ? 'cfg-diff-del' : ''}`}>
            <span className="cfg-diff-n">{r.n ?? ''}</span>
            <span className="cfg-diff-t">{r.t === ' ' ? '' : r.t}</span>
            <span>{r.text}</span>
          </div>
        ),
      )}
    </div>
  );
}

/** “I've done this” for a Documented item: who, when, cleared when the item changes (design C2). */
export function TickRow({
  item,
  onTick,
  busy,
}: {
  item: DocumentedItem | undefined;
  onTick: (done: boolean) => void;
  busy?: boolean;
}) {
  if (!item) return null;
  return (
    <div
      className={`cfg-tick ${item.done ? 'cfg-tick-done' : item.stale ? 'cfg-tick-stale' : ''}`}
      data-testid={`tick-${item.key}`}
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, cursor: 'pointer' }}>
        <input type="checkbox" checked={item.done} disabled={busy} onChange={(e) => onTick(e.target.checked)} />
        I’ve done this
      </label>
      <span className="ai-muted" style={{ flex: 1 }}>
        {item.done
          ? `Ticked by ${item.by ?? 'someone'} · ${ago(item.at)}`
          : item.stale
            ? 'This changed after you ticked it: copy it again, then tick.'
            : 'Kanban cannot look inside the app, so the tick is a reminder, not a check.'}
      </span>
      <Chip tone={item.done ? 'synced' : 'warn'}>{item.done ? 'Done' : item.stale ? 'Redo' : 'Not done'}</Chip>
    </div>
  );
}

/** Copy text to the clipboard with a short confirmation. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ai-btn ai-btn-sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

/** A small modal shell used by the dialogs of this tab. */
export function Dialog({
  title,
  sub,
  width = 520,
  onClose,
  children,
  foot,
  testId,
}: {
  title: string;
  sub?: ReactNode;
  width?: number;
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
  testId?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="ai-overlay">
      <div
        className="ai-modal"
        role="dialog"
        aria-label={title}
        data-testid={testId}
        style={{
          width,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 48px)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">{title}</h2>
          {sub && <div className="ai-hint">{sub}</div>}
        </div>
        <div className="ai-modal-body" style={{ overflow: 'auto', gap: 10 }}>
          {children}
        </div>
        {foot && <div className="ai-modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

/** Format tokens like 5.8k. */
export function tok(n: number | null | undefined): string {
  if (n == null) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Rough token count (4 characters per token), as the server counts. */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

/** Skeleton card (design F9). */
export function SkeletonCard({ rows = 2 }: { rows?: number }) {
  return (
    <div className="cfg-skel-card" aria-hidden="true">
      <div className="ai-skel" style={{ height: 14, width: '30%' }} />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ai-skel" style={{ height: 32 }} />
      ))}
      <div className="ai-skel" style={{ height: 70 }} />
    </div>
  );
}

/** Dashed empty state (design F10). */
export function EmptyState({
  title,
  text,
  action,
  onAction,
}: {
  title: string;
  text: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div
      style={{
        border: '1px dashed #c7d2cb',
        borderRadius: 10,
        padding: 18,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
      }}
      data-testid="cfg-empty"
    >
      <b style={{ fontSize: 13 }}>{title}</b>
      <span className="cfg-sub">{text}</span>
      <button type="button" className="ai-btn ai-btn-sm" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}
