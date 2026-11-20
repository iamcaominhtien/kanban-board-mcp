/**
 * "Your session ended" (RichDocsStates F 38, phone 44): the server stopped taking this window's changes (the desktop
 * app was restarted and its secret changed, or the request was refused as not signed in). Nothing is lost: the
 * draft stays in this browser and is sent as soon as the window is accepted again. Signing in opens a new tab, so
 * this page stays as it is.
 */

import { StateDialog } from './StateDialog';
import { StIcon } from './stIcons';
import './states.css';

/**
 * True for an answer that means this window is no longer let in: a 401, or the 403 the app's secret check gives
 * ("This request must come from the board's own window. …", kept word for word on the server).
 * @param err - What a request threw.
 */
export function isSessionEnded(err: unknown): boolean {
  const r = (err as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response;
  if (!r) return false;
  if (r.status === 401) return true;
  return (
    r.status === 403 &&
    typeof r.data?.detail === 'string' &&
    r.data.detail.startsWith("This request must come from the board's own window.")
  );
}

interface Props {
  /** How many changes wait in this browser. */
  waiting: number;
  /** Draw as the phone's sheet. */
  sheet?: boolean;
  /** Opens the sign-in (a new tab). */
  onSignIn: () => void;
  /** Copies the page's text to the clipboard. */
  onCopy: () => void;
  onClose: () => void;
}

const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`;

/**
 * The session-ended dialog (`data-testid="session-ended"`).
 * @param props.waiting - Changes kept in this browser.
 * @param props.sheet - The phone sheet (frame 44).
 * @param props.onSignIn - Sign in again.
 * @param props.onCopy - Copy my text.
 * @param props.onClose - Esc or the scrim.
 */
export function SessionEnded({ waiting, sheet, onSignIn, onCopy, onClose }: Props) {
  const count = Math.max(1, waiting);
  const n = <b>{changes(count)}</b>;
  const are = count === 1 ? 'is' : 'are';
  if (sheet)
    return (
      <StateDialog
        width={390}
        sheet
        title="Your session ended"
        sub="Signing in opens a new tab"
        role="alertdialog"
        testId="session-ended"
        onClose={onClose}
      >
        <div className="dst-session-sheet">
          <div className="dst-session-text">
            You were signed out. Your {n} {are} kept in this browser and saved when you sign in again.
          </div>
          <button type="button" className="st-btn st-btn-primary" onClick={onSignIn} data-testid="session-sign-in">
            <StIcon name="person" size={14} />
            Sign in again
          </button>
          <button type="button" className="st-btn" onClick={onCopy}>
            Copy my text
          </button>
        </div>
      </StateDialog>
    );
  return (
    <StateDialog
      width={520}
      hideHead
      title="Your session ended"
      role="alertdialog"
      testId="session-ended"
      onClose={onClose}
    >
      <div className="dst-session">
        <div className="dst-session-icon">
          <StIcon name="clock" size={24} sw={1.9} />
        </div>
        <div>
          <div className="dst-session-title">Your session ended</div>
          <div className="dst-session-text">
            You were signed out. Nothing was lost: {n} {are} kept in this browser and {are} saved as soon as you sign in
            again.
          </div>
        </div>
        <div className="dst-session-btns">
          <button type="button" className="st-btn st-btn-primary" onClick={onSignIn} data-testid="session-sign-in">
            <StIcon name="person" size={14} />
            Sign in again
          </button>
          <button type="button" className="st-btn" onClick={onCopy}>
            <StIcon name="copy" size={14} />
            Copy my text
          </button>
        </div>
        <div className="st-hint dst-session-hint">Signing in opens a new tab, so this page stays as it is.</div>
      </div>
    </StateDialog>
  );
}
