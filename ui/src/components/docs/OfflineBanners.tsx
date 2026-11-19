import { useCallback, useEffect, useState } from 'react';
import { StateBar } from './states/StateBar';
import { StIcon } from './states/stIcons';
import './docs.css';

/**
 * "You are offline" bar of the editor (Docs states D 21, 22): grey, the edits are kept in this browser.
 * @param props.onRetry - Retry now (not on a phone, where the bar is a slim overlay): checks the connection.
 * @param props.phone - The phone's short words.
 * @param props.checking - A check is running: the button says so and waits.
 */
export function OfflineBanner({
  onRetry,
  phone,
  checking = false,
}: {
  onRetry: () => void;
  phone?: boolean;
  checking?: boolean;
}) {
  return (
    <StateBar
      tone="grey"
      icon="offline"
      testId="offline-banner"
      title="You are offline"
      text={
        phone
          ? 'Edits are kept here and sync when you are back.'
          : 'Your edits are kept in this browser and sync when the connection returns. Publishing needs a connection.'
      }
      actions={
        phone ? undefined : (
          <button type="button" className="st-btn st-btn-sm" onClick={onRetry} disabled={checking} aria-busy={checking}>
            <StIcon name="retry" size={13} sw={2} />
            {checking ? 'Checking…' : 'Retry now'}
          </button>
        )
      }
    />
  );
}

/** How coming back online ended (Docs states D 25): merging, nothing else changed, joined, or a block to choose. */
export type BackOnlineState = 'merging' | 'synced' | 'joined' | 'same';

interface BackOnlineProps {
  state: BackOnlineState;
  /** Who published meanwhile. */
  who?: string;
  /** Blocks they changed (joined) or blocks both changed (same). */
  count?: number;
  /** Joined while publishing, not on reconnecting: the first line names the version instead of "Back online". */
  publish?: boolean;
  version?: number;
  onReview?: () => void;
  onChoose?: () => void;
  onDismiss: () => void;
}

const blocks = (n: number) => `${n} block${n === 1 ? '' : 's'}`;

/**
 * "Back online" bar (`data-testid="online-banner"`): its four endings, from quiet to needing a choice. "Draft synced"
 * goes by itself after 6 seconds.
 * @param props.state - Which ending.
 * @param props.who - Who published meanwhile.
 * @param props.count - How many blocks.
 * @param props.publish - The page was joined while publishing.
 * @param props.version - The version that was joined.
 * @param props.onReview - Opens "Merged for you".
 * @param props.onChoose - Opens the block-by-block choice.
 * @param props.onDismiss - Closes the bar.
 */
export function BackOnlineBanner({
  state,
  who = 'Someone else',
  count = 0,
  publish,
  version,
  onReview,
  onChoose,
  onDismiss,
}: BackOnlineProps) {
  useEffect(() => {
    if (state !== 'synced') return undefined;
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [onDismiss, state]);
  if (state === 'merging')
    return (
      <StateBar
        tone="merging"
        icon="online"
        testId="online-banner"
        title="Back online"
        text="Merging your changes with the saved page…"
        actions={<span className="mc-spin" aria-hidden="true" />}
      />
    );
  if (state === 'synced')
    return (
      <StateBar
        tone="green"
        icon="online"
        testId="online-banner"
        title="Back online"
        text="Draft synced. No one else changed this page while you were away."
        onClose={onDismiss}
      />
    );
  if (state === 'joined')
    return (
      <StateBar
        tone="blue"
        icon="merge"
        testId="online-banner"
        title={publish ? `${who} published v${version ?? ''} meanwhile` : 'Back online'}
        text={
          publish
            ? `${who} changed ${blocks(count)}. They are joined with your changes; publish again when you are ready.`
            : `${who} changed ${blocks(count)} while you were away. They are joined with your changes.`
        }
        actions={
          onReview && (
            <button type="button" className="st-btn st-btn-sm" onClick={onReview} data-testid="merged-review">
              Review
            </button>
          )
        }
        onClose={onDismiss}
      />
    );
  return (
    <StateBar
      tone="amber"
      icon="warn"
      role="alert"
      testId="online-banner"
      title="Back online"
      text={`${blocks(count)} ${count === 1 ? 'was' : 'were'} changed by you and by ${who}. Publish waits until you choose.`}
      actions={
        onChoose && (
          <button
            type="button"
            className="st-btn st-btn-sm st-btn-primary"
            onClick={onChoose}
            data-testid="conflict-choose"
          >
            Choose
          </button>
        )
      }
    />
  );
}

/** Tracks navigator.onLine; `setOnline` lets callers report a failed request. */
export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [justBack, setJustBack] = useState(false);
  useEffect(() => {
    const on = () => {
      setOnline(true);
      setJustBack(true);
    };
    const off = () => {
      setOnline(false);
      setJustBack(false);
    };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  const clearJustBack = useCallback(() => setJustBack(false), []);
  return { online, setOnline, justBack, clearJustBack };
}
