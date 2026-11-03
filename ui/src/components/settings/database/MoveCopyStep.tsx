import { useState } from 'react';
import {
  useMoveCancel,
  useMovePause,
  useMoveResume,
  useMoveStart,
  type MoveJob,
  type MoveTable,
} from '../../../api/database';
import { extractError } from '../../../api/extractError';
import { SIcon } from '../settingsUi';
import settings from '../SettingsPage.module.css';
import { DB_ICONS, ModalBody, ModalFoot, Spinner } from './dbUi';
import { fmtClock, fmtInt, fmtLeft } from './dbFormat';
import { MoveStopped } from './MoveStopped';
import styles from './Database.module.css';

/** How many waiting tables to show after the current one. */
const NEXT_FEW = 2;
/** How many done tables to show before the current one. */
const DONE_SHOWN = 5;

/** The per-table list: the last done tables, the current one, the next few, then "… N more tables". */
export function TableProgress({ tables, current }: { tables: MoveTable[]; current: string | null }) {
  let at = tables.findIndex((t) => t.state === 'copying' || t.state === 'stopped');
  if (at < 0 && current) at = tables.findIndex((t) => t.name === current);
  if (at < 0) at = tables.findIndex((t) => t.state !== 'done');
  if (at < 0) at = tables.length;
  const doneFrom = Math.max(0, at - DONE_SHOWN);
  const until = Math.min(tables.length, at + 1 + NEXT_FEW);
  const shown = tables.slice(doneFrom, until);
  const more = tables.length - until;
  return (
    <ul className={styles.tableList} data-testid="move-tables">
      {doneFrom > 0 && (
        <li className={styles.tableRow}>
          <SIcon d={DB_ICONS.checkCircle} size={16} stroke="#2E6F40" />
          <span className={styles.tableName}>
            … {doneFrom} table{doneFrom === 1 ? '' : 's'} done
          </span>
        </li>
      )}
      {shown.map((t) => {
        const pct = t.rows ? Math.min(100, (t.copied / t.rows) * 100) : t.state === 'done' ? 100 : 0;
        return (
          <li key={t.name} className={`${styles.tableRow} ${t.state === 'copying' ? styles.tableRowOn : ''}`}>
            {t.state === 'done' ? (
              <SIcon d={DB_ICONS.checkCircle} size={16} stroke="#2E6F40" />
            ) : t.state === 'copying' ? (
              <SIcon d={DB_ICONS.refresh} size={16} stroke="#2F6DB5" />
            ) : t.state === 'stopped' ? (
              <SIcon d={DB_ICONS.warn} size={16} stroke="#C4432A" />
            ) : (
              <SIcon d={DB_ICONS.circle} size={16} stroke="#B8C4BC" />
            )}
            <span className={styles.tableName}>{t.name}</span>
            <span className={styles.miniBar}>
              <i
                style={{ width: `${pct}%` }}
                className={t.state === 'copying' ? styles.miniBarOn : t.state === 'stopped' ? styles.miniBarErr : ''}
              />
            </span>
            <span className={styles.tableCount}>
              {fmtInt(t.copied)} / {fmtInt(t.rows)}
            </span>
          </li>
        );
      })}
      {more > 0 && (
        <li className={styles.tableRow}>
          <SIcon d={DB_ICONS.circle} size={16} stroke="#B8C4BC" />
          <span className={styles.tableName}>
            … {more} more table{more === 1 ? '' : 's'}
          </span>
        </li>
      )}
    </ul>
  );
}

/** "Cancel the copy?" with what it does; the new database is cleared. */
function CancelConfirm({ job, onNo }: { job: MoveJob; onNo: () => void }) {
  const cancel = useMoveCancel();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={settings.confirmBox} role="alertdialog" aria-label="Cancel the copy">
      <span className={settings.confirmTitle}>
        <SIcon d={DB_ICONS.warn} size={16} stroke="#C4432A" />
        Cancel the copy?
      </span>
      <span>
        The new database is cleared: every table the copy made in {job.target.display} is deleted. Your{' '}
        {job.source.label} data is not touched.
      </span>
      {error && <span className={settings.statusErr}>{error}</span>}
      <div className={settings.row}>
        <button type="button" className={settings.btn} onClick={onNo}>
          Keep it
        </button>
        <button
          type="button"
          className={`${settings.btn} ${settings.btnDanger}`}
          disabled={cancel.isPending}
          data-testid="move-cancel-confirm"
          onClick={() => cancel.mutate(undefined, { onSuccess: onNo, onError: (e) => setError(extractError(e)) })}
        >
          {cancel.isPending && <Spinner />}
          Cancel and clear the new database
        </button>
      </div>
    </div>
  );
}

/**
 * Step 3, Copy (design/screens/ai-databases.md D1, D4, E2): the progress table by table with Pause and Cancel; a
 * paused or interrupted copy with Resume, Start over and Cancel; a stopped copy with what the AI suggests.
 */
export function MoveCopyStep({
  job,
  onHide,
  onRestart,
  onClose,
}: {
  job: MoveJob;
  /** Close the dialog; the copy keeps going. */
  onHide: () => void;
  /** Back to step 1 (after a failure or a cancel). */
  onRestart: () => void;
  onClose: () => void;
}) {
  const pause = useMovePause();
  const resume = useMoveResume();
  const start = useMoveStart();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => {
    setError(null);
    p.catch((e) => setError(extractError(e)));
  };

  if (job.state === 'stopped' && job.stop) return <MoveStopped job={job} />;

  const srcIsFile = job.source.engine === 'sqlite';
  const pct = job.rowsTotal ? Math.min(100, (job.rowsDone / job.rowsTotal) * 100) : 0;
  const errorNote = error && (
    <div className={`${settings.notice} ${styles.noticeErr}`} role="alert">
      <SIcon d={DB_ICONS.warn} size={15} stroke="#C4432A" />
      <span>{error}</span>
    </div>
  );

  if (job.state === 'cancelled') {
    return (
      <>
        <ModalBody testId="move-step-copy">
          <div className={settings.notice}>
            <SIcon d={DB_ICONS.info} size={15} />
            <span>
              The copy was cancelled and the new database was cleared. Your {job.source.label} data is as it was.
            </span>
          </div>
        </ModalBody>
        <ModalFoot>
          <button type="button" className={settings.btn} onClick={onClose}>
            Close
          </button>
          <span className={styles.spacer} />
          <button type="button" className={`${settings.btn} ${settings.btnPrimary}`} onClick={onRestart}>
            Start again
          </button>
        </ModalFoot>
      </>
    );
  }

  if (job.state === 'failed') {
    return (
      <>
        <ModalBody testId="move-step-copy">
          <div className={styles.dangerBox} role="alert">
            <SIcon d={DB_ICONS.warn} size={18} stroke="#C4432A" />
            <div>
              <b>The copy could not go on</b>
              <div className={styles.lineDetail}>{job.error?.message ?? 'Something went wrong.'}</div>
            </div>
          </div>
          <p className={styles.para}>
            Your {job.source.label} {srcIsFile ? 'file' : 'database'} was only read; nothing of yours changed.
          </p>
          {errorNote}
        </ModalBody>
        <ModalFoot>
          <button type="button" className={settings.btn} onClick={onRestart}>
            <SIcon d={DB_ICONS.back} size={14} />
            Back
          </button>
          <span className={styles.spacer} />
          <button
            type="button"
            className={`${settings.btn} ${settings.btnPrimary}`}
            disabled={start.isPending}
            onClick={() => run(start.mutateAsync({ mode: job.mode ?? 'copy' }))}
          >
            {start.isPending ? <Spinner /> : <SIcon d={DB_ICONS.refresh} size={14} />}
            Try again
          </button>
        </ModalFoot>
      </>
    );
  }

  if (job.state === 'paused' || job.state === 'interrupted') {
    const at = job.resumeAt ?? job.current ?? '';
    const t = job.tables.find((x) => x.name === at);
    return (
      <>
        <ModalBody testId="move-step-copy">
          <div className={styles.warnBox} data-testid="move-paused">
            <SIcon d={DB_ICONS.warn} size={18} stroke="#B4791E" />
            <div>
              <b>
                {job.state === 'paused' ? 'The copy is paused' : 'The copy stopped'} at {Math.floor(pct)}%
                {at ? `, in table ${at}` : ''}
              </b>
              <div className={styles.lineDetail}>
                {t ? `It was at ${fmtInt(t.copied)} of ${fmtInt(t.rows)} rows. ` : ''}Tables before it are complete and
                checked.
                {job.state === 'interrupted' && ' The app was closed or lost the connection while it copied.'}
              </div>
            </div>
          </div>
          <div className={settings.row}>
            <button
              type="button"
              className={`${settings.btn} ${settings.btnPrimary}`}
              disabled={resume.isPending}
              onClick={() => run(resume.mutateAsync({}))}
              data-testid="move-resume"
            >
              {resume.isPending ? <Spinner /> : <SIcon d={DB_ICONS.play} size={14} />}
              {at ? `Resume from ${at}` : 'Resume'}
            </button>
            <button
              type="button"
              className={settings.btn}
              disabled={resume.isPending}
              onClick={() => run(resume.mutateAsync({ restart: true }))}
            >
              <SIcon d={DB_ICONS.refresh} size={14} />
              Start over
            </button>
            <button type="button" className={settings.btn} onClick={() => setConfirmCancel(true)}>
              <SIcon d={DB_ICONS.close} size={14} />
              Cancel and clear the new database
            </button>
          </div>
          <p className={settings.hint}>
            Resume re-reads the table it stopped in from its start, so a half-copied table never ends up with
            duplicates. The script does the same with <span className={settings.code}>--resume</span>.
          </p>
          {confirmCancel && <CancelConfirm job={job} onNo={() => setConfirmCancel(false)} />}
          {errorNote}
          <TableProgress tables={job.tables} current={at} />
        </ModalBody>
        <ModalFoot>
          <button type="button" className={settings.btn} onClick={onHide}>
            <SIcon d={DB_ICONS.hide} size={14} />
            Hide
          </button>
          <span className={styles.spacer} />
        </ModalFoot>
      </>
    );
  }

  // copying, pausing
  const tableNo = Math.min(job.tablesDone + 1, job.tablesTotal);
  const left = fmtLeft(job.leftS);
  return (
    <>
      <ModalBody testId="move-step-copy">
        <div className={styles.progressHead}>
          <div className={styles.grow}>
            <div className={styles.sectionTitle}>Copying to {job.target.label}</div>
            <div className={styles.dim} data-testid="move-progress-line">
              {[
                `Table ${tableNo} of ${job.tablesTotal}`,
                `${fmtInt(job.rowsDone)} of about ${fmtInt(job.rowsTotal)} rows`,
                `${fmtClock(job.elapsedS)} elapsed`,
                left,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
          <button
            type="button"
            className={settings.btn}
            disabled={job.state === 'pausing' || pause.isPending}
            onClick={() => run(pause.mutateAsync())}
            data-testid="move-pause"
          >
            {job.state === 'pausing' ? <Spinner /> : <SIcon d={DB_ICONS.pause} size={14} />}
            {job.state === 'pausing' ? 'Pausing…' : 'Pause'}
          </button>
          <button type="button" className={settings.btn} onClick={() => setConfirmCancel(true)}>
            <SIcon d={DB_ICONS.close} size={14} />
            Cancel
          </button>
        </div>
        <div
          className={styles.bar}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          aria-label="Copy progress"
        >
          <i style={{ width: `${pct}%` }} />
        </div>
        {confirmCancel && <CancelConfirm job={job} onNo={() => setConfirmCancel(false)} />}
        {errorNote}
        <TableProgress tables={job.tables} current={job.current} />
        <div className={`${settings.notice} ${styles.noticeOk}`}>
          <SIcon d={DB_ICONS.sparkle} size={15} stroke="#2E6F40" />
          <span>
            <b>
              Your {job.source.label} {srcIsFile ? 'file' : 'database'} is only being read.
            </b>{' '}
            If this stops for any reason, nothing is lost: the new database is cleared on <i>Cancel</i>, and{' '}
            <i>Resume</i> continues from the table it stopped at.
          </span>
        </div>
        <p className={settings.hint}>
          You can close this window. It keeps going, and the Database card shows where it is. The same copy can run from
          the script on another machine.
        </p>
      </ModalBody>
      <ModalFoot>
        <button type="button" className={settings.btn} onClick={onHide} data-testid="move-hide">
          <SIcon d={DB_ICONS.hide} size={14} />
          Hide
        </button>
        <span className={styles.spacer} />
        <button type="button" className={settings.btn} disabled>
          <SIcon d={DB_ICONS.arrowRight} size={14} />
          Next
        </button>
      </ModalFoot>
    </>
  );
}
