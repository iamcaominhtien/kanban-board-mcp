import type { NotificationRow } from '../../types/notifications';
import { NEEDS_FILTERS, needsFilterCounts, type NeedsFilter } from './needsFilters';
import styles from './NotificationPanel.module.css';

/** All · Board faults · Needs a decision · Asked you · Code · Accounts, each with how many rows it holds. */
export function NeedsFilterBar({
  rows,
  value,
  onChange,
}: Readonly<{ rows: NotificationRow[]; value: NeedsFilter; onChange: (f: NeedsFilter) => void }>) {
  const counts = needsFilterCounts(rows);
  return (
    <div className={styles.needsFilters} role="group" aria-label="Filter what needs you">
      {NEEDS_FILTERS.map((f) => (
        <button
          key={f.id}
          type="button"
          aria-pressed={value === f.id}
          className={`${styles.needsPill} ${value === f.id ? styles.needsPillOn : ''}`}
          onClick={() => onChange(f.id)}
        >
          {f.label}
          <b> {counts[f.id]}</b>
        </button>
      ))}
    </div>
  );
}
