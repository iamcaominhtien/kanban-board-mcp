/**
 * The dialog of the Docs states boards (frames 18, 19, 26, 33, 50): 16 px corners, a header with title and sub-line,
 * a body and a grey footer; on a phone the same content in a sheet from the bottom (frame 20).
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { useEscape } from '../docsShared';
import { StIcon } from './stIcons';
import './states.css';

interface Props {
  /** Width in px on a desktop or tablet. */
  width: number;
  /** The accessible name; also the title unless `hideHead`. */
  title: string;
  sub?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** No header (frame 50 has its own centred title). */
  hideHead?: boolean;
  /** Draw as a bottom sheet. */
  sheet?: boolean;
  testId?: string;
  /** `alertdialog` for a question that must be answered. */
  role?: 'dialog' | 'alertdialog';
}

/**
 * A board dialog. Esc and a click on the scrim close it; focus moves into it and back when it closes.
 * @param props.width - Width in px (desktop and tablet).
 * @param props.title - Title and accessible name.
 * @param props.sub - Line under the title.
 * @param props.onClose - Called on Esc, the scrim and the close button.
 * @param props.children - The body.
 * @param props.footer - The footer's buttons.
 * @param props.hideHead - Leave the header out.
 * @param props.sheet - A bottom sheet (phone).
 * @param props.testId - `data-testid` of the dialog.
 * @param props.role - The dialog role.
 */
export function StateDialog({
  width,
  title,
  sub,
  onClose,
  children,
  footer,
  hideHead,
  sheet,
  testId,
  role = 'dialog',
}: Props) {
  useEscape(onClose);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    // the marked button, else the main action, else the first button (selectors in this order, not document order)
    const first = ['[data-autofocus]', '.st-btn-primary', 'button']
      .map((sel) => ref.current?.querySelector<HTMLElement>(sel))
      .find(Boolean);
    (first ?? ref.current)?.focus();
    return () => before?.focus?.();
  }, []);
  return (
    <div
      className={`dst-scrim docs-root${sheet ? ' dst-sheet-wrap' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid={testId}
        className={`dst-dialog${sheet ? ' dst-sheet' : ''}`}
        style={sheet ? undefined : { width }}
      >
        {sheet && (
          <div className="dst-sheet-grab" aria-hidden="true">
            <span />
          </div>
        )}
        {!hideHead && (
          <div className="dst-dialog-head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="dst-dialog-title">{title}</div>
              {sub && <div className="dst-dialog-sub">{sub}</div>}
            </div>
            <button type="button" className="dst-dialog-close" aria-label="Close" onClick={onClose}>
              <StIcon name="x" size={16} sw={1.9} />
            </button>
          </div>
        )}
        <div className="dst-dialog-body">{children}</div>
        {footer && <div className="dst-dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}
