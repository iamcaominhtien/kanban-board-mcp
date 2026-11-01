import type { NotificationRow } from '../../types/notifications';
import { diagnosisOf, isBoardFault } from './needsFilters';
import styles from './NotificationRow.module.css';

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * What the board found out about a Needs you row (design/screens/ai-operations.md, D): the diagnosis, what was
 * already tried, who saw it first. Shows nothing for a row that carries none.
 */
export function DiagnosisBlock({ row }: Readonly<{ row: NotificationRow }>) {
  const d = diagnosisOf(row);
  const what = text(d?.what);
  const means = text(d?.means);
  const tried = Array.isArray(d?.tried) ? (d.tried as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  const verdict = text(row.data.verdict);
  const reason = text(row.data.reason);
  if (!what && !means && tried.length === 0 && !verdict && !reason) return null;
  return (
    <div className={styles.diagnosis} data-testid="row-diagnosis">
      {(what || means) && (
        <div>
          <b>Diagnosis.</b> {[what, means].filter(Boolean).join(' ')}
        </div>
      )}
      {(verdict || reason) && (
        <div>
          <b>PM AI.</b> {[verdict && `Verdict: ${verdict}.`, reason].filter(Boolean).join(' ')}
        </div>
      )}
      {tried.length > 0 && (
        <div>
          <span className={styles.triedHead}>ALREADY TRIED</span>
          <ul className={styles.tried}>
            {tried.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {isBoardFault(row) && (
        <span className={`${styles.chip} ${styles.chipFault}`}>
          Board fault · came straight to you, no AI was asked
        </span>
      )}
    </div>
  );
}
