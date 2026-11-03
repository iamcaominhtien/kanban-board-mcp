import { useState } from 'react';
import { useForgetMove, useMoveResume, useMoveSwitch, type MoveJob } from '../../../api/database';
import { extractError } from '../../../api/extractError';
import { SIcon } from '../settingsUi';
import settings from '../SettingsPage.module.css';
import { DB_ICONS, Line, ModalBody, ModalFoot, Spinner } from './dbUi';
import { fmtDuration, fmtInt } from './dbFormat';
import styles from './Database.module.css';

/** Rows of the comparison table shown before "… N more tables". */
const TABLE_ROWS = 6;

/**
 * Step 4, Verify (design/screens/ai-databases.md D2): what was copied and checked, table by table and check by check,
 * then "Keep <source>, switch later" or "Switch to <target> now". After the switch, the board reads the new database.
 */
export function MoveVerifyStep({ job, onClose }: { job: MoveJob; onClose: () => void }) {
  const switchNow = useMoveSwitch();
  const forget = useForgetMove();
  const resume = useMoveResume();
  const [error, setError] = useState<string | null>(null);
  const v = job.verify;
  const srcIsFile = job.source.engine === 'sqlite';

  if (job.state === 'switched') {
    return (
      <>
        <ModalBody testId="move-step-done">
          <div className={styles.success} data-testid="move-switched">
            <SIcon d={DB_ICONS.checkCircle} size={36} stroke="#2E6F40" width={1.6} />
            <div className={styles.successTitle}>The board now uses {job.target.label}</div>
            <div className={styles.dim}>
              Everything you do from now on goes to <span className={settings.mono}>{job.target.display}</span>.
              {srcIsFile && ' The SQLite file stays in the data folder as it was, a way back.'}
            </div>
          </div>
        </ModalBody>
        <ModalFoot>
          <span className={styles.spacer} />
          <button type="button" className={`${settings.btn} ${settings.btnPrimary}`} onClick={onClose}>
            Done
          </button>
        </ModalFoot>
      </>
    );
  }

  if (job.state === 'verifying' || !v) {
    return (
      <>
        <ModalBody testId="move-step-verify">
          <div className={styles.asking} role="status">
            <Spinner size={16} />
            Checking the copy: row counts, a sample read back, links between rows and counters…
          </div>
        </ModalBody>
        <ModalFoot>
          <span className={styles.spacer} />
          <button type="button" className={settings.btn} onClick={onClose}>
            <SIcon d={DB_ICONS.hide} size={14} />
            Hide
          </button>
        </ModalFoot>
      </>
    );
  }

  const ok = v.ok && job.state !== 'verified_with_differences';
  // the biggest tables first: they say most about the copy
  const tables = [...(v.tables ?? [])].sort((a, b) => b.source - a.source);
  const more = tables.slice(TABLE_ROWS);
  const differ = v.differ ?? [];

  async function doSwitch() {
    setError(null);
    try {
      await switchNow.mutateAsync();
    } catch (e) {
      setError(extractError(e));
    }
  }

  async function keep() {
    setError(null);
    try {
      await forget.mutateAsync();
      onClose();
    } catch (e) {
      setError(extractError(e));
    }
  }

  return (
    <>
      <ModalBody testId="move-step-verify">
        {v.empty ? (
          <div className={styles.okBox}>
            <SIcon d={DB_ICONS.checkCircle} size={18} stroke="#2E6F40" />
            <div>
              <b>The new database is ready, and empty</b>
              <div className={styles.lineDetail}>The board’s tables were made; nothing was copied.</div>
            </div>
          </div>
        ) : ok ? (
          <div className={styles.okBox} data-testid="move-verified">
            <SIcon d={DB_ICONS.checkCircle} size={18} stroke="#2E6F40" />
            <div>
              <b>Everything was copied and checked</b>
              <div className={styles.lineDetail}>
                {fmtInt(tables.length)} tables · {fmtInt(v.rows)} rows
                {v.elapsedS != null || job.elapsedS != null ? ` · ${fmtDuration(job.elapsedS ?? v.elapsedS)}` : ''}. The
                new database holds the same data as the {srcIsFile ? 'file' : 'source'}.
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.dangerBox} data-testid="move-differences">
            <SIcon d={DB_ICONS.warn} size={18} stroke="#C4432A" />
            <div>
              <b>The copy does not match everywhere</b>
              <div className={styles.lineDetail}>
                {differ.length > 0
                  ? `Row counts differ in ${differ.length} table${differ.length === 1 ? '' : 's'}: ${differ.slice(0, 6).join(', ')}. `
                  : ''}
                The board will not switch to it. Copy again, or keep {job.source.label}.
              </div>
            </div>
          </div>
        )}

        {!v.empty && (
          <div className={styles.verifyGrid}>
            <table className={styles.cmpTable} data-testid="move-verify-table">
              <thead>
                <tr>
                  <th>Table</th>
                  <th>{job.source.label}</th>
                  <th>{job.target.label}</th>
                  <th aria-label="Same" />
                </tr>
              </thead>
              <tbody>
                {tables.slice(0, TABLE_ROWS).map((t) => (
                  <tr key={t.name}>
                    <td className={styles.tableName}>{t.name}</td>
                    <td className={styles.num}>{fmtInt(t.source)}</td>
                    <td className={styles.num}>{fmtInt(t.target)}</td>
                    <td>
                      <SIcon
                        d={t.same ? DB_ICONS.checkCircle : DB_ICONS.xCircle}
                        size={15}
                        stroke={t.same ? '#2E6F40' : '#C4432A'}
                      />
                    </td>
                  </tr>
                ))}
                {more.length > 0 && (
                  <tr>
                    <td colSpan={3} className={styles.dim}>
                      … {more.length} more tables
                    </td>
                    <td>
                      <SIcon
                        d={more.every((t) => t.same) ? DB_ICONS.checkCircle : DB_ICONS.xCircle}
                        size={15}
                        stroke={more.every((t) => t.same) ? '#2E6F40' : '#C4432A'}
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <ul className={styles.lines}>
              {v.checks.map((c) => (
                <Line key={c.key} level={c.ok ? 'ok' : 'error'} title={c.title} />
              ))}
            </ul>
          </div>
        )}
        {v.empty && (
          <ul className={styles.lines}>
            {v.checks.map((c) => (
              <Line key={c.key} level={c.ok ? 'ok' : 'error'} title={c.title} />
            ))}
          </ul>
        )}

        <p className={styles.para}>
          <b>Switch now</b> points the board at {job.target.label}, with no restart. Anything you do from then on goes
          to the new database; the {job.source.label} {srcIsFile ? 'file' : 'database'} is no longer updated.{' '}
          <b>Switching back</b> is the same wizard in the other direction
          {srcIsFile && (
            <>
              , or <i>Use the SQLite file again</i> on the Database card for the old file as it was
            </>
          )}
          .
        </p>
        {error && (
          <div className={`${settings.notice} ${styles.noticeErr}`} role="alert">
            <SIcon d={DB_ICONS.warn} size={15} stroke="#C4432A" />
            <span>{error}</span>
          </div>
        )}
      </ModalBody>
      <ModalFoot>
        <button type="button" className={settings.btn} disabled={forget.isPending} onClick={keep}>
          <SIcon d={DB_ICONS.clock} size={14} />
          Keep {job.source.label}, switch later
        </button>
        <span className={styles.spacer} />
        {!ok && differ.length > 0 && (
          <button
            type="button"
            className={settings.btn}
            disabled={resume.isPending}
            onClick={() => resume.mutate({ startAt: differ[0] }, { onError: (e) => setError(extractError(e)) })}
          >
            <SIcon d={DB_ICONS.refresh} size={14} />
            Copy again from {differ[0]}
          </button>
        )}
        <button
          type="button"
          className={`${settings.btn} ${settings.btnPrimary}`}
          disabled={job.state !== 'verified' || switchNow.isPending}
          onClick={doSwitch}
          data-testid="move-switch"
        >
          {job.state === 'switching' || switchNow.isPending ? <Spinner /> : <SIcon d={DB_ICONS.check} size={14} />}
          Switch to {job.target.label} now
        </button>
      </ModalFoot>
    </>
  );
}
