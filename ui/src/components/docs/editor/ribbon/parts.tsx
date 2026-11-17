/**
 * The small parts the ribbon, the selection toolbar and the phone sheets share: a button with the five control
 * states (off, on, mixed, disabled, focused), a popover placed under its button, and the glyphs the Docs icon set
 * does not have.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Tri } from './format';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * "Mod+Shift+H" as the person's keyboard writes it: "Ctrl+Shift+H", or "⌘⇧H" on a Mac.
 * @param keys - Keys joined with `+`; `Mod` is Ctrl, or ⌘ on a Mac.
 * @param mac - Write Mac symbols.
 */
export function keyLabel(keys: string, mac = IS_MAC): string {
  if (!mac) return keys.replace(/Mod/g, 'Ctrl');
  const sym: Record<string, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃' };
  return keys
    .split('+')
    .map((k) => sym[k] ?? k)
    .join('');
}

/** `aria-keyshortcuts` for "Mod+B". */
export function ariaKeys(keys?: string): string | undefined {
  return keys ? keys.replace(/Mod/g, IS_MAC ? 'Meta' : 'Control') : undefined;
}

interface RBtnProps {
  label: string;
  /** On, mixed (dashed) or off; a plain action leaves it out. */
  state?: Tri | boolean;
  disabled?: boolean;
  keys?: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onDoubleClick?: () => void;
  children: ReactNode;
  /** Opens a menu: sets aria-haspopup and aria-expanded. */
  expanded?: boolean;
  testId?: string;
  className?: string;
  style?: CSSProperties;
  /** Dark selection toolbar look. */
  dark?: boolean;
  btnRef?: React.Ref<HTMLButtonElement>;
}

/**
 * A ribbon button. Its tooltip names it and its shortcut; a mixed state is drawn dashed and reads as
 * `aria-pressed="mixed"`.
 * @param props.label - Accessible name and tooltip.
 * @param props.state - `on`, `mixed`, `off` (or a boolean) for a toggle.
 * @param props.keys - The shortcut ("Mod+B"), shown in the tooltip.
 */
export function RBtn({
  label,
  state,
  disabled,
  keys,
  onClick,
  onDoubleClick,
  children,
  expanded,
  testId,
  className,
  style,
  dark,
  btnRef,
}: RBtnProps) {
  const tri: Tri | undefined =
    state === undefined ? undefined : state === true ? 'on' : state === false ? 'off' : state;
  return (
    <button
      ref={btnRef}
      type="button"
      className={`${dark ? 'dk-bubble-btn' : 'dk-rb'}${tri === 'on' ? ' dk-rb-on' : ''}${tri === 'mixed' ? ' dk-rb-mixed' : ''}${
        className ? ` ${className}` : ''
      }`}
      aria-label={label}
      title={keys ? `${label} (${keyLabel(keys)})` : label}
      aria-keyshortcuts={ariaKeys(keys)}
      aria-pressed={tri === undefined ? undefined : tri === 'mixed' ? 'mixed' : tri === 'on'}
      aria-haspopup={expanded === undefined ? undefined : true}
      aria-expanded={expanded}
      disabled={disabled}
      data-testid={testId}
      style={style}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {children}
    </button>
  );
}

interface PopoverProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  label: string;
  width?: number;
  testId?: string;
  /** `menu` for a list of choices, `dialog` for a small form. */
  role?: 'menu' | 'dialog';
  /** Line the popover's right edge with the button's. */
  alignRight?: boolean;
}

/**
 * A popover under its button, on `<body>` (so a ribbon strip that scrolls does not clip it). It closes on Esc, on a
 * press outside it and its button, and flips above the button when there is no room below.
 * @param props.anchor - The button it belongs to.
 * @param props.onClose - Called to close it.
 */
export function Popover({
  anchor,
  onClose,
  children,
  label,
  width = 240,
  testId,
  role = 'dialog',
  alignRight,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const h = ref.current?.offsetHeight ?? 0;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = alignRight ? r.right - width : r.left;
      left = Math.max(8, Math.min(left, vw - width - 8));
      let top = r.bottom + 6;
      if (h && top + h > vh - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, width, alignRight]);

  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || anchor?.contains(t)) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('touchstart', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('touchstart', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      data-testid={testId}
      data-popover
      className="dk-menu docs-root dk-rb-pop"
      style={{
        position: 'fixed',
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width,
        zIndex: 90,
        maxHeight: 'min(70vh, 520px)',
        overflowY: 'auto',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Glyphs drawn here (24 × 24, currentColor). */
const GLYPHS: Record<string, ReactNode> = {
  undo: <path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />,
  redo: <path d="M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" />,
  painter: (
    <>
      <path d="M4 4h12v5H4zM16 6.5h3v6H11v3" />
      <path d="M10 15.5h2V21h-2z" />
    </>
  ),
  alignLeft: <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />,
  alignCenter: <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />,
  alignRight: <path d="M4 6h16M10 10h10M4 14h16M10 18h10" />,
  alignJustify: <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />,
  indent: <path d="M4 6h16M12 12h8M12 18h8M4 9.5l3 2.5-3 2.5" />,
  outdent: <path d="M4 6h16M12 12h8M12 18h8M7 9.5L4 12l3 2.5" />,
  spacing: <path d="M10 6h10M10 12h10M10 18h10M5 5v14M3 7l2-2 2 2M3 17l2 2 2-2" />,
  dropCap: (
    <>
      <rect x="3.5" y="4" width="8" height="8.5" rx="1" />
      <text x="5.2" y="11" fontSize="8.5" fontWeight="800" fill="currentColor" stroke="none">
        A
      </text>
      <path d="M14.5 5.5H21M14.5 9.5H21M3.5 16h17.5M3.5 20h17.5" />
    </>
  ),
  clear: <path d="M5 5h11M10.5 5l-3 14M14 14l6 6M20 14l-6 6" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  bullets: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1.1" />
      <circle cx="4.5" cy="12" r="1.1" />
      <circle cx="4.5" cy="18" r="1.1" />
    </>
  ),
  numbers: (
    <>
      <path d="M10 6h10M10 12h10M10 18h10" />
      {['1', '2', '3'].map((n, i) => (
        <text key={n} x="2.5" y={8 + i * 6} fontSize="7" fontWeight="700" fill="currentColor" stroke="none">
          {n}
        </text>
      ))}
    </>
  ),
  tasks: (
    <>
      <rect x="3" y="4" width="4.5" height="4.5" rx="1" />
      <path d="M3.5 15.5l1.6 1.6 2.4-3.3M10.5 6.3H21M10.5 16H21" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4 17l5-5 4 4 3-3 4 4" />
    </>
  ),
  table: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M3.5 10h17M3.5 14.5h17M9.5 5v14" />
    </>
  ),
  columns: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M12 5v14" />
    </>
  ),
  callout: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M12 9.5v4.5M12 16.3v.01" />
    </>
  ),
  find: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4-4" />
    </>
  ),
  focus: <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />,
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14h9" />
    </>
  ),
  insert: <path d="M12 5v14M5 12h14" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  chevron: <path d="M6 9l6 6 6-6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  back: <path d="M15 6l-6 6 6 6" />,
  open: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  unlink: <path d="M9 15l-2 2a3 3 0 0 1-4-4l3-3M15 9l2-2a3 3 0 0 1 4 4l-3 3M8 4v3M4 8h3M16 20v-3M20 16h-3" />,
  clipboard: (
    <>
      <rect x="6" y="5" width="12" height="16" rx="2" />
      <path d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M9 11h6M9 15h4" />
    </>
  ),
  check: <path d="M5 12l5 5 9-10" />,
  divider: <path d="M3 12h18M7 7h4M13 7h4M7 17h4M13 17h4" />,
};

/**
 * One of the ribbon's own glyphs.
 * @param props.name - The glyph name.
 * @param props.size - Size in px.
 */
export function Glyph({
  name,
  size = 17,
  strokeWidth = 1.8,
  className,
}: {
  name: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      {GLYPHS[name]}
    </svg>
  );
}

/** "A" over a colour bar: the text colour button. */
export function ColorGlyph({ color, size }: { color?: string; size?: number }) {
  return (
    <span className="dk-rb-color" style={size ? { fontSize: size - 2, lineHeight: 1 } : undefined}>
      <span>A</span>
      <span className="dk-rb-color-bar" style={{ background: color ?? 'currentColor' }} />
    </span>
  );
}

/** A marker pen over a stroke of the highlight colour: the Highlight button. */
export function HighlightGlyph({ color = '#E8B93A', size = 16 }: { color?: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 21h16" stroke={color} strokeWidth={3.2} />
      <path d="M14.5 4.5l4 4L11 16H7v-4z" stroke="currentColor" strokeWidth={1.9} />
      <path d="M12.5 6.5l4 4" stroke="currentColor" strokeWidth={1.9} />
    </svg>
  );
}
