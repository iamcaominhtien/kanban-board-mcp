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
  const asked = row.kind === 'question' && !row.done;
  const judged = Boolean(verdict || reason);
  const fault = isBoardFault(row);
  if (!what && !means && tried.length === 0 && !judged && !asked) return null;
  return (
    <div className={styles.diagnosis} data-testid="row-diagnosis">
      {(what || means) && (
        <div>
          <b>Diagnosis.</b> {[what, means].filter(Boolean).join(' ')}
        </div>
      )}
      {asked && !what && !means && (
        <div>
          <b>Diagnosis.</b> Not a failure. The run is paused and nothing is lost; the answer goes straight back into it.
        </div>
      )}
      {(verdict || reason) && (
        <div>
          <b>PM AI.</b> {[verdict && `Verdict: ${verdict}.`, reason].filter(Boolean).join(' ')}
        </div>
      )}
      {tried.length > 0 && (
        <div className={styles.triedBox}>
          <div className={styles.triedHead}>Already tried</div>
          <ul className={styles.tried}>
            {tried.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {fault && <div className={styles.whoFirst}>Board fault · came straight to you, no AI was asked first</div>}
      {!fault && judged && <div className={styles.whoFirst}>Judgement · the PM AI saw it first and passed it up</div>}
      {!fault && !judged && asked && (
        <div className={styles.whoFirst}>Waiting on you{row.ticketId ? ` · blocks ${row.ticketId}` : ''}</div>
      )}
    </div>
  );
}
