/**
 * The save status in the editor bar (RichDocsStates frame 13): one of six things, Saving…, Saved, Not saved, Offline,
 * Merging… or Paused, with the words and marks of the board.
 */

import { StIcon } from './stIcons';
import './states.css';

/** What the bar says about the draft. */
export type SaveView =
  | { kind: 'saving' }
  | { kind: 'saved'; at: Date | null }
  | { kind: 'error' }
  | { kind: 'offline'; waiting: number }
  | { kind: 'merging' }
  | { kind: 'paused' };

/**
 * The short line a screen reader hears for a state (frame 71: "Saved." polite, "Not saved…" assertive).
 * @param view - The state.
 */
export function saveAnnouncement(view: SaveView): string {
  switch (view.kind) {
    case 'saved':
      return 'Saved.';
    case 'error':
      return 'Not saved. Retry is available. Your text is kept in this browser.';
    case 'offline':
      return `Offline. ${view.waiting} change${view.waiting === 1 ? '' : 's'} waiting.`;
    case 'paused':
      return 'Someone else edited this page. Publish is paused.';
    case 'merging':
      return 'Merging.';
    default:
      return '';
  }
}

interface Props {
  view: SaveView;
  /** Short words for a phone header ("Not saved", "Offline"). */
  compact?: boolean;
  onRetry?: () => void;
  /** Opens the list of changes waiting (offline). */
  onOpenWaiting?: () => void;
  waitingOpen?: boolean;
}

/**
 * The save status (`data-testid="save-state"`).
 * @param props.view - What to say.
 * @param props.compact - The phone header's short form: no time, no count, no Retry link.
 * @param props.onRetry - Retry after "Not saved".
 * @param props.onOpenWaiting - Makes the offline status a button that opens the changes waiting.
 * @param props.waitingOpen - Whether that list is open (aria-expanded).
 */
export function SaveStatus({ view, compact, onRetry, onOpenWaiting, waitingOpen }: Props) {
  const label = saveAnnouncement(view);
  switch (view.kind) {
    case 'saving':
      return (
        <span className="dst-save" data-testid="save-state" data-state="saving">
          <span className="mc-spin" aria-hidden="true" />
          Saving…
        </span>
      );
    case 'saved':
      return (
        <span className="dst-save dst-save-saved" data-testid="save-state" data-state="saved" role="status">
          <StIcon name="check" size={13} sw={2.4} />
          Saved
          {view.at && !compact && (
            <span className="dst-save-time">
              {view.at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </span>
      );
    case 'error':
      return (
        <span className="dst-save dst-save-error" data-testid="save-state" data-state="error" role="alert">
          <StIcon name="warn" size={13} sw={2.2} />
          Not saved
          {onRetry && !compact && (
            <button type="button" className="dst-save-link" onClick={onRetry} data-testid="save-retry">
              Retry
            </button>
          )}
        </span>
      );
    case 'offline': {
      const body = (
        <>
          <StIcon name="offline" size={13} sw={2} />
          Offline
          {!compact && <span className="dst-save-waiting">· {plural(view.waiting)} waiting</span>}
        </>
      );
      return onOpenWaiting && !compact ? (
        <button
          type="button"
          className="dst-save dst-save-offline"
          data-testid="save-state"
          data-state="offline"
          aria-label={label}
          aria-expanded={waitingOpen}
          onClick={onOpenWaiting}
        >
          {body}
        </button>
      ) : (
        <span className="dst-save dst-save-offline" data-testid="save-state" data-state="offline" role="status">
          {body}
        </span>
      );
    }
    case 'merging':
      return (
        <span className="dst-save" data-testid="save-state" data-state="merging" role="status">
          <span className="mc-spin" aria-hidden="true" />
          Merging…
        </span>
      );
    case 'paused':
      return (
        <span className="dst-save dst-save-paused" data-testid="save-state" data-state="paused" role="alert">
          <StIcon name="warn" size={13} sw={2.2} />
          Paused
        </span>
      );
  }
}

const plural = (n: number) => `${n} change${n === 1 ? '' : 's'}`;
