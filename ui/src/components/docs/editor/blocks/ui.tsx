/**
 * Small controls the block panels share: a panel that is a popover on a desktop, a side panel on a tablet and a
 * bottom sheet on a phone (board B 6, L 62, B 10), tabs, a segmented choice, a labelled row and colour swatches.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useDocsLayout, type DocsLayout } from '../../../../hooks/useDocsLayout';
import { Icon } from '../../Icon';
import { colorLabel, swatchHex } from './palette';

/** The layout for the window's width (desktop, tablet, phone). */
export function useBlockLayout(): DocsLayout {
  return useDocsLayout(null);
}

/** True on a touch screen without a mouse (no hover). */
export function useCoarsePointer(): boolean {
  const query = '(hover: none) and (pointer: coarse)';
  const [coarse, setCoarse] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const on = () => setCoarse(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return coarse;
}

interface PanelProps {
  /** The panel's title ("Image properties", "Callout"…). */
  title: string;
  /** Where a desktop popover points: the rect of what it belongs to (viewport coordinates). */
  anchor: DOMRect | null;
  onClose: () => void;
  children: ReactNode;
  /** Popover width on a desktop, in px. */
  width?: number;
  /** Shown at the bottom (Reset…, Done). */
  footer?: ReactNode;
  /** A data-testid for the panel. */
  testId?: string;
  /** A count beside the title ("4 cells"). */
  badge?: ReactNode;
}

/**
 * A properties panel: a popover under (or above) `anchor` on a desktop, a side panel on the right on a tablet, a
 * bottom sheet on a phone. Esc and a click outside close it; changes apply as they are made.
 */
export function Panel({ title, anchor, onClose, children, width = 340, footer, testId, badge }: PanelProps) {
  const layout = useBlockLayout();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const live = useRef(onClose);
  live.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        live.current();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t)) return;
      // a click on the block's own toolbar or another panel keeps this one
      if (t?.closest?.('[data-block-ui]')) return;
      live.current();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, []);

  const aTop = anchor?.top;
  const aBottom = anchor?.bottom;
  const aLeft = anchor?.left;
  useLayoutEffect(() => {
    if (layout !== 'desktop') return;
    const h = ref.current?.offsetHeight ?? 360;
    const below = (aBottom ?? 120) + 8;
    const top =
      below + h > window.innerHeight - 8 && (aTop ?? 0) - 8 - h > 8
        ? (aTop ?? 0) - 8 - h
        : Math.min(below, Math.max(8, window.innerHeight - h - 8));
    const left = Math.max(8, Math.min(aLeft ?? 120, window.innerWidth - width - 8));
    setPos((p) => (p && p.top === top && p.left === left ? p : { top, left }));
  }, [layout, aTop, aBottom, aLeft, width]);

  const head = (
    <div className="dk-bp-head">
      <span>{title}</span>
      {badge != null && <span className="dk-bp-badge">{badge}</span>}
      <button type="button" className="dk-bp-x" aria-label="Close" onClick={onClose}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
  const body = (
    <>
      {head}
      <div className="dk-bp-body">{children}</div>
      {footer && <div className="dk-bp-foot">{footer}</div>}
    </>
  );
  if (layout === 'phone') {
    return (
      <div className="dk-bp-overlay" data-block-ui="">
        <div className="dk-bp-scrim" onMouseDown={onClose} />
        <div ref={ref} className="dk-bp dk-bp-sheet" role="dialog" aria-label={title} data-testid={testId}>
          <div className="dk-bp-grab" aria-hidden="true" />
          {body}
        </div>
      </div>
    );
  }
  if (layout === 'tablet') {
    return (
      <div
        ref={ref}
        className="dk-bp dk-bp-side"
        role="dialog"
        aria-label={title}
        data-testid={testId}
        data-block-ui=""
      >
        {body}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className="dk-bp dk-bp-pop"
      role="dialog"
      aria-label={title}
      data-testid={testId}
      data-block-ui=""
      style={{ width, top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
    >
      {body}
    </div>
  );
}

/**
 * A row of tabs.
 * @param props.tabs - `[value, label]` pairs.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="dk-bp-tabs" role="tablist">
      {tabs.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={v === value}
          className={v === value ? 'on' : undefined}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * A segmented choice (one of a few). Values are compared with `===`, so `null` can be a choice.
 * @param props.label - The accessible name of the group.
 */
export function Seg<T extends string | number | boolean | null>({
  label,
  options,
  value,
  onChange,
  wrap,
}: {
  label: string;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  /** Lets the options wrap onto several lines. */
  wrap?: boolean;
}) {
  return (
    <div className={`dk-track${wrap ? ' dk-track-wrap' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={o.value === value ? 'on' : undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled row of a panel. */
export function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="dk-bp-row">
      <div className="dk-bp-label">{label}</div>
      {children}
      {hint && <div className="dk-bp-hint">{hint}</div>}
    </div>
  );
}

/**
 * A switch with its label.
 * @param props.label - What it turns on.
 */
export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="dk-bp-toggle">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/**
 * Colour swatches from the named palette, with "None" first.
 * @param props.kind - `c` text colours (callouts), `hl` highlight colours (cell shading).
 */
export function Swatches({
  kind,
  names,
  value,
  onChange,
  label,
}: {
  kind: 'c' | 'hl';
  names: readonly string[];
  value: string | null;
  onChange: (v: string | null) => void;
  label: string;
}) {
  return (
    <div className="dk-swatches" role="radiogroup" aria-label={label}>
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        aria-label="None"
        title="None"
        className={`dk-swatch dk-swatch-none${value === null ? ' on' : ''}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onChange(null)}
      />
      {names.map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={colorLabel(n)}
          title={colorLabel(n)}
          className={`dk-swatch${value === n ? ' on' : ''}`}
          style={{ background: swatchHex(kind, n) } as CSSProperties}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange(n)}
        />
      ))}
    </div>
  );
}

/** A centred dialog (a bottom sheet on a phone) with a scrim; Esc closes it. */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 520,
  testId,
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  testId?: string;
  /** An extra class on the dialog box, for a dialog drawn to its own board frame. */
  className?: string;
}) {
  const layout = useBlockLayout();
  const live = useRef(onClose);
  live.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        live.current();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="dk-bp-overlay dk-bp-overlay-center" data-block-ui="">
      <div className="dk-bp-scrim" onMouseDown={onClose} />
      <div
        className={`dk-bp ${layout === 'phone' ? 'dk-bp-sheet' : 'dk-bp-dialog'}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        style={layout === 'phone' ? undefined : { width: `min(${width}px, calc(100vw - 32px))` }}
      >
        {layout === 'phone' && <div className="dk-bp-grab" aria-hidden="true" />}
        <div className="dk-bp-head">
          <span>{title}</span>
          <button type="button" className="dk-bp-x" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="dk-bp-body">{children}</div>
        {footer && <div className="dk-bp-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** "14.2 MB", "380 KB". */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
