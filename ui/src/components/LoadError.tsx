import { useEffect, useRef } from 'react';
import styles from './AppLoading.module.css';

interface LoadErrorProps {
  title: string;
  onRetry: () => void;
  lastAttempt?: Date | null;
}

/** "Couldn't load ..." panel. Only the heading is role=alert, focus moves to Try again. */
export function LoadError({ title, onRetry, lastAttempt }: LoadErrorProps) {
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const focus = () => btn.current?.focus();
    // While the splash is still up the app behind it is inert and cannot take focus
    if (!document.getElementById('kb-splash')) {
      focus();
      return;
    }
    window.addEventListener('kb-splash-gone', focus, { once: true });
    return () => window.removeEventListener('kb-splash-gone', focus);
  }, []);

  return (
    <div className={styles.errorPanel}>
      <div role="alert">
        <h2 className={styles.errorTitle}>{title}</h2>
        <p className={styles.errorText}>We couldn&apos;t reach the server. Check your connection and try again.</p>
      </div>
      <button ref={btn} type="button" className={styles.btn} onClick={onRetry}>
        Try again
      </button>
      {lastAttempt && (
        <span className={styles.chip}>
          <span className={styles.chipDot} />
          Last attempt {lastAttempt.toLocaleTimeString([], { hour12: false })}
        </span>
      )}
    </div>
  );
}
