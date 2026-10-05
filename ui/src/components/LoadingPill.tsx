import { useEffect, useState } from 'react';
import type { PillState } from '../hooks/useLoadingPill';
import styles from './AppLoading.module.css';

interface LoadingPillProps {
  state: PillState;
  /** What is loading, e.g. "projects" -> "Loading projects..." */
  what: string;
  onRetry: () => void;
}

/**
 * Status pill in a reserved row (so it never pushes the top bar). The live region is always
 * present and only its content changes, so screen readers announce it once.
 */
export function LoadingPill({ state, what, onRetry }: LoadingPillProps) {
  const [shown, setShown] = useState<PillState>(state);
  const [leaving, setLeaving] = useState(false);
  const [lastWhat, setLastWhat] = useState(what);

  useEffect(() => {
    if (state !== 'hidden') {
      setShown(state);
      setLastWhat(what);
      setLeaving(false);
      return;
    }
    // Data arrived while the pill was visible: fade it out over 150 ms
    setLeaving(true);
    const t = window.setTimeout(() => setShown('hidden'), 150);
    return () => window.clearTimeout(t);
  }, [state, what]);

  return (
    <div className={styles.statusRow} role="status" aria-live="polite">
      {shown === 'loading' && (
        <span className={`${styles.pill} ${leaving ? styles.pillLeaving : ''}`}>
          <span className={styles.ring} aria-hidden="true" />
          Loading {lastWhat}...
        </span>
      )}
      {shown === 'slow' && (
        <span className={`${styles.pill} ${styles.pillSlow} ${leaving ? styles.pillLeaving : ''}`}>
          <span className={styles.pillDot} aria-hidden="true" />
          Still loading... Check your connection
          <button type="button" className={styles.pillRetry} onClick={onRetry}>
            Retry
          </button>
        </span>
      )}
    </div>
  );
}
