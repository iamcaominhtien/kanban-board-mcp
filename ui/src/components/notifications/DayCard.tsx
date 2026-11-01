import type { DayCardData, NotificationRow } from '../../types/notifications';
import styles from './DayCard.module.css';
import type { RowActionHandler } from './NotificationRow';
import { Icon, type IconName } from './notificationUi';

const LINE_ICONS: Record<string, IconName> = {
  project: 'check',
  quiet: 'check',
  failed: 'triangle',
  waiting: 'bubble',
  docs: 'doc',
  tomorrow: 'calendar',
  snoozed: 'clock',
};

/** Bold the lead of a line: "Kanban Board: 14 ..." and "2 runs failed: ..." read as the design shows them. */
function Line({ text }: { text: string }) {
  const i = text.indexOf(': ');
  const j = text.indexOf(',');
  const cut = i > 0 && (j < 0 || i < j) ? i : j > 0 && /still wait/.test(text.slice(0, j)) ? j : -1;
  if (cut < 0) return <>{text}</>;
  return (
    <>
      <b>{text.slice(0, cut)}</b>
      {text.slice(cut)}
    </>
  );
}

/** The day in one card (design I1): the first row of the Updates tab. */
export function DayCard({
  row,
  onAction,
  onShowNeeds,
}: {
  row: NotificationRow;
  onAction: RowActionHandler;
  onShowNeeds?: () => void;
}) {
  const d = row.data as DayCardData;
  const failed = d.failed ?? 0;
  const waiting = d.waiting ?? 0;
  const money = `$${(d.spent ?? 0).toFixed(2)}`;
  return (
    <div className={styles.card} data-row-id={row.id} data-unread={row.read ? undefined : 'true'}>
      <div className={styles.head}>
        <span className={styles.sun}>
          <Icon name="sun" size={16} stroke={2} />
        </span>
        <div className={styles.titleBox}>
          <div className={styles.title}>{row.title}</div>
          <div className={styles.sub}>{row.body}</div>
        </div>
        <button type="button" className={styles.btn} onClick={() => void onAction(row, 'open')}>
          Open
        </button>
      </div>
      {!d.quiet && (
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.num} style={{ color: '#1F5A31' }}>
              {d.finished ?? 0}
            </span>
            <span className={styles.label}>AI runs finished</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.num} style={{ color: '#A5321E' }}>
              {failed}
            </span>
            <span className={styles.label}>failed</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.num} style={{ color: '#7A5A06' }}>
              {waiting}
            </span>
            <span className={styles.label}>still wait for you</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.num} style={{ color: '#1E2A22' }}>
              {money}
            </span>
            <span className={styles.label}>spent</span>
          </div>
        </div>
      )}
      <div className={styles.lines}>
        {(d.lines ?? []).map((l, i) => (
          <div key={i} className={styles.line}>
            <span className={styles.lineIcon}>
              <Icon name={LINE_ICONS[l.kind] ?? 'check'} size={13} stroke={2} color="#5B6B60" />
            </span>
            <div>
              <Line text={l.text} />
            </div>
          </div>
        ))}
      </div>
      {(waiting > 0 || failed > 0 || !d.quiet) && (
        <div className={styles.actions}>
          {waiting > 0 && (
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onShowNeeds}>
              <Icon name="arrow" />
              Open the {waiting} waiting
            </button>
          )}
          {failed > 0 && (
            <button type="button" className={styles.btn} onClick={() => void onAction(row, 'retry_failed')}>
              {failed === 1
                ? 'Retry the failed run'
                : failed === 2
                  ? 'Retry both failed'
                  : `Retry the ${failed} failed`}
            </button>
          )}
          <button type="button" className={styles.btn} onClick={() => void onAction(row, 'board_health')}>
            Board health
          </button>
        </div>
      )}
    </div>
  );
}
