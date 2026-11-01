import type { ReactNode } from 'react';
import { Icon, type IconName } from './notificationUi';
import styles from './NotificationPanel.module.css';

/** Nothing here (design M): an icon, a line and a sentence. */
export function EmptyState({ icon, title, text }: { icon: IconName; title: string; text: ReactNode }) {
  return (
    <div className={styles.empty} role="status">
      <Icon name={icon} size={24} stroke={1.7} color="#9AA8A0" />
      <b className={styles.emptyTitle}>{title}</b>
      <div className={styles.emptyText}>{text}</div>
    </div>
  );
}

/** Grey rows while the list loads: a slow start never shows an empty state. */
export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading notifications"
      style={{ display: 'flex', flexDirection: 'column', gap: 7 }}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.shim} />
      ))}
    </div>
  );
}

/** "Not connected": the list is what it was at the time of the last answer. */
export function OfflineNotice({ at, onRetry }: { at: number | null; onRetry: () => void }) {
  const time = at
    ? new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
    : null;
  return (
    <div className={styles.offline} role="alert">
      <span style={{ display: 'flex', marginTop: 1 }}>
        <Icon name="triangle" size={16} stroke={2} />
      </span>
      <div className={styles.offlineBody}>
        <span className={styles.offlineTitle}>Not connected</span>
        <span className={styles.offlineText}>
          {time ? `The list is what it was at ${time}. ` : 'There is no list to show yet. '}
          Notifications are kept on the server and arrive when the connection is back.
        </span>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button type="button" className={styles.btn} onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
