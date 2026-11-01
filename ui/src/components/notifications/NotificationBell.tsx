import { useNotificationCounts } from '../../api/notifications';
import { Icon } from './notificationUi';
import styles from './NotificationBell.module.css';

/** What the bell shows: a red count (Needs you only), a blue dot for unread updates, a grey dot when offline. */
export function bellState(
  counts: { needs: number; updatesUnread: number } | undefined,
  failed: boolean,
): { kind: 'count'; n: number } | { kind: 'blue' } | { kind: 'grey' } | { kind: 'none' } {
  if (failed) return { kind: 'grey' };
  if (!counts) return { kind: 'none' };
  if (counts.needs > 0) return { kind: 'count', n: counts.needs };
  if (counts.updatesUnread > 0) return { kind: 'blue' };
  return { kind: 'none' };
}

/** The bell in the top bar (design C1, M). */
export function NotificationBell({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const q = useNotificationCounts();
  const s = bellState(q.data, q.isError);
  const label =
    s.kind === 'count'
      ? `Notifications, ${s.n} need${s.n === 1 ? 's' : ''} you`
      : s.kind === 'blue'
        ? 'Notifications, unread updates'
        : s.kind === 'grey'
          ? 'Notifications, not connected'
          : 'Notifications';
  return (
    <span className={styles.wrap} data-notification-bell>
      <button
        type="button"
        className={`${styles.btn} ${open ? styles.btnOn : ''}`}
        aria-label={label}
        aria-expanded={open}
        title="Notifications — N"
        onClick={onToggle}
      >
        <Icon name="bell" size={17} stroke={1.9} color={open ? '#1F5A31' : undefined} />
      </button>
      {s.kind === 'count' && <span className={styles.count}>{s.n > 99 ? '99+' : s.n}</span>}
      {s.kind === 'blue' && <span className={`${styles.dot} ${styles.dotBlue}`} data-testid="bell-dot" />}
      {s.kind === 'grey' && <span className={`${styles.dot} ${styles.dotGrey}`} data-testid="bell-dot-offline" />}
    </span>
  );
}
