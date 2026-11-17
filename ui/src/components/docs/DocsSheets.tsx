/**
 * The overlays of the touch layouts (design board "Rich Docs — app frame", C and D): a drawer that slides over the
 * page from the left or the right, and a bottom sheet. Both dim the page behind them and close with their button, a
 * tap outside, Esc, or a swipe (the drawer back to its side, the sheet down).
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './Icon';

interface OverlayProps {
  /** Read by screen readers; the sheet also shows it as its title. */
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** `data-testid` of the panel. */
  testId?: string;
}

/** Closes on Esc and moves the focus into the panel when it opens (back to where it was when it closes). */
function useOverlayFocus(ref: React.RefObject<HTMLElement>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(
      'input, button:not([data-sheet-close]), [href], [tabindex]:not([tabindex="-1"])',
    );
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (prev?.isConnected) prev.focus();
    };
  }, [ref]);
}

/**
 * A drawer over the page, from the left (the tree, the project sidebar) or the right (Page settings on a tablet).
 * @param props.side - The edge it slides from.
 * @param props.width - Its width in CSS pixels (never more than the window minus 40).
 * @param props.label - Accessible name.
 * @param props.onClose - Called by a tap on the dimmed page, Esc or a swipe back.
 */
export function DocsDrawer({
  side = 'left',
  width = 340,
  label,
  onClose,
  children,
  testId,
}: OverlayProps & { side?: 'left' | 'right'; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<number | null>(null);
  useOverlayFocus(ref, onClose);
  const panel: CSSProperties = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    [side]: 0,
    width: `min(${width}px, calc(100% - 40px))`,
    background: '#FFFFFF',
    boxShadow: side === 'left' ? '8px 0 24px rgba(30,42,34,0.18)' : '-8px 0 24px rgba(30,42,34,0.18)',
    display: 'flex',
    flexDirection: 'column',
    outline: 'none',
  };
  return (
    <div className="dk-overlay docs-root" data-testid={testId ? `${testId}-overlay` : undefined}>
      <div className="dk-scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`dk-drawer dk-drawer-${side}`}
        data-testid={testId}
        style={panel}
        onTouchStart={(e) => (start.current = e.touches[0]?.clientX ?? null)}
        onTouchEnd={(e) => {
          const x0 = start.current;
          const x1 = e.changedTouches[0]?.clientX;
          start.current = null;
          if (x0 == null || x1 == null) return;
          if ((side === 'left' && x0 - x1 > 60) || (side === 'right' && x1 - x0 > 60)) onClose();
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A bottom sheet (phone): a grab handle, a title row with a close button and its content, at most 85 % of the
 * screen high.
 * @param props.label - Title and accessible name.
 * @param props.hideTitle - Leave the title row out (the content has its own).
 * @param props.onClose - Called by the close button, a tap on the dimmed page, Esc or dragging the sheet down.
 */
export function BottomSheet({ label, onClose, children, testId, hideTitle }: OverlayProps & { hideTitle?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<number | null>(null);
  useOverlayFocus(ref, onClose);
  return (
    <div className="dk-overlay docs-root" data-testid={testId ? `${testId}-overlay` : undefined}>
      <div className="dk-scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="dk-sheet"
        data-testid={testId}
      >
        <div
          className="dk-sheet-grab"
          onTouchStart={(e) => (start.current = e.touches[0]?.clientY ?? null)}
          onTouchEnd={(e) => {
            const y0 = start.current;
            const y1 = e.changedTouches[0]?.clientY;
            start.current = null;
            if (y0 != null && y1 != null && y1 - y0 > 50) onClose();
          }}
        >
          <span />
        </div>
        {!hideTitle && (
          <div className="dk-sheet-head">
            <span>{label}</span>
            <button type="button" className="dk-icobtn" aria-label="Close" data-sheet-close onClick={onClose}>
              <Icon name="close" size={18} strokeWidth={2} />
            </button>
          </div>
        )}
        <div className="dk-sheet-body">{children}</div>
      </div>
    </div>
  );
}
