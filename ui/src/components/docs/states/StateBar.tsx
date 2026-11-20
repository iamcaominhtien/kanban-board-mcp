/**
 * The bar under the editor header that says what is going on with the page (RichDocsStates C-G): offline, save failed,
 * back online, merging, a page that is getting large. On a phone it is a slim overlay above the page.
 */

import type { ReactNode } from 'react';
import { StIcon, type StIconName } from './stIcons';
import './states.css';

/** The colour of a bar, by what it says. */
export type BarTone = 'grey' | 'red' | 'amber' | 'blue' | 'green' | 'merging';

interface Props {
  tone: BarTone;
  icon: StIconName;
  title: ReactNode;
  text?: ReactNode;
  /** Buttons at the right. */
  actions?: ReactNode;
  /** Shows the 28 px close button. */
  onClose?: () => void;
  testId?: string;
  /** `alert` for a failure the reader must hear at once; `status` (polite) otherwise. */
  role?: 'alert' | 'status';
}

/**
 * One state bar.
 * @param props.tone - Grey (offline), red (failed), amber (paused, large), blue (others changed), green (synced) or
 *   merging (blue with the green icon).
 * @param props.icon - The 18 px icon at the left.
 * @param props.title - The bold first line.
 * @param props.text - The line under it.
 * @param props.actions - Buttons at the right.
 * @param props.onClose - Shows a close button that calls it.
 * @param props.testId - `data-testid` of the bar.
 * @param props.role - `alert` or `status`.
 */
export function StateBar({ tone, icon, title, text, actions, onClose, testId, role = 'status' }: Props) {
  return (
    <div role={role} data-testid={testId} className={`dst-bar dst-bar-${tone}`}>
      <span className="dst-bar-icon">
        <StIcon name={icon} size={18} sw={2} />
      </span>
      <div className="dst-bar-body">
        <div className="dst-bar-title">{title}</div>
        {text && <div className="dst-bar-text">{text}</div>}
      </div>
      {(actions || onClose) && (
        <div className="dst-bar-acts">
          {actions}
          {onClose && (
            <button type="button" className="dst-x" aria-label="Dismiss" onClick={onClose}>
              <StIcon name="x" size={14} sw={1.9} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Where the bars go: in the flow on a desktop or tablet, as an overlay above the page on a phone (frames 17, 22).
 * @param props.phone - Draw as an overlay.
 * @param props.children - The bars.
 */
export function StateBars({ phone, children }: { phone: boolean; children: ReactNode }) {
  if (!phone) return <>{children}</>;
  return (
    <div className="dst-overlay">
      <div>{children}</div>
    </div>
  );
}
