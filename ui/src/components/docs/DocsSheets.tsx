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
  /**
   * Which boards it is drawn from: `read` for the reading view (Reader boards: a lighter scrim, an 18 px sheet with a
   * deeper shadow, a drawer with a rule on its edge), `manage` for organising pages and the states (Tree, Shell and
   * States boards: a darker scrim, a 20 px sheet).
   */
  look?: 'read' | 'manage';
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
  look = 'manage',
  scrim,
}: OverlayProps & {
  side?: 'left' | 'right';
  width?: number;
  /** How dark the page behind gets (0-1), when the board draws another value than the look's. */
  scrim?: number;
}) {
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
    // Tree1 A 2-3: 12 0 40 .22; Reader3 49: -12 0 30 .16 with a rule on the open edge
    boxShadow:
      look === 'read'
        ? `${side === 'left' ? 12 : -12}px 0 30px rgba(30,42,34,0.16)`
        : `${side === 'left' ? 12 : -12}px 0 40px rgba(30,42,34,0.22)`,
    ...(look === 'read'
      ? { [side === 'left' ? 'borderRight' : 'borderLeft']: '1px solid var(--dp-rule, #E3E8E5)' }
      : {}),
    display: 'flex',
    flexDirection: 'column',
    outline: 'none',
  };
  return (
    <div className={`dk-overlay dk-overlay-${look} docs-root`} data-testid={testId ? `${testId}-overlay` : undefined}>
      <div
        className="dk-scrim"
        aria-hidden="true"
        onClick={onClose}
        style={scrim != null ? { background: `rgba(30,42,34,${scrim})` } : undefined}
      />
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
 * @param props.eyebrow - Show the title as a small uppercase line without a close button (Reader 28, the More sheet).
 * @param props.look - `read` (Reader boards) or `manage` (Tree, Shell and States boards).
 * @param props.closeText - Draw the close as this word, a green text button (the phone comments sheet), not ×.
 * @param props.onClose - Called by the close button, a tap on the dimmed page, Esc or dragging the sheet down.
 */
export function BottomSheet({
  label,
  onClose,
  children,
  testId,
  hideTitle,
  eyebrow,
  look = 'manage',
  closeText,
}: OverlayProps & { hideTitle?: boolean; eyebrow?: boolean; closeText?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<number | null>(null);
  useOverlayFocus(ref, onClose);
  return (
    <div className={`dk-overlay dk-overlay-${look} docs-root`} data-testid={testId ? `${testId}-overlay` : undefined}>
      <div className="dk-scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`dk-sheet dk-sheet-${look}`}
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
        {!hideTitle && eyebrow && <div className="dk-sheet-eyebrow">{label}</div>}
        {!hideTitle && !eyebrow && (
          <div className="dk-sheet-head">
            <span>{label}</span>
            {closeText ? (
              <button type="button" className="dk-sheet-closetext" data-sheet-close onClick={onClose}>
                {closeText}
              </button>
            ) : (
              <button type="button" className="dk-icobtn" aria-label="Close" data-sheet-close onClick={onClose}>
                <Icon name="close" size={18} strokeWidth={2} />
              </button>
            )}
          </div>
        )}
        <div className="dk-sheet-body">{children}</div>
      </div>
    </div>
  );
}
