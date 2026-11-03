import { useState } from 'react';
import {
  moveIsOpen,
  useMove,
  useTestConnection,
  useUseSqlite,
  type DatabaseInfo,
  type MoveJob,
  type TestReport,
} from '../../../api/database';
import { extractError } from '../../../api/extractError';
import { SettingsCard, SIcon } from '../settingsUi';
import settings from '../SettingsPage.module.css';
import { EditConnectionDialog } from './EditConnectionDialog';
import { MoveDatabaseDialog } from './MoveDatabaseDialog';
import { DB_ICONS, EngineBadge, FindingList, Spinner, WhyOnlyThese } from './dbUi';
import { fmtDay, fmtInt, formatBytes } from './dbFormat';
import styles from './Database.module.css';

/** The Database card of Storage & backup (design/screens/ai-databases.md B1 to B3). */

const MOVE_WORDS: Partial<Record<MoveJob['state'], string>> = {
  copying: 'is running',
  pausing: 'is pausing',
  paused: 'is paused',
  stopped: 'stopped',
  interrupted: 'was interrupted',
  verifying: 'is being checked',
  verified: 'is copied and checked; switch when you are ready',
  verified_with_differences: 'finished with differences',
  failed: 'failed',
  switching: 'is switching',
};

/** "Local file" / "Connected" / "Locked" / "Cannot connect" beside the card's title. */
function Chip({ db }: { db: DatabaseInfo }) {
  if (db.locked) {
    return (
      <span className={`${styles.chip} ${styles.chipWarn}`} data-testid="db-chip">
        <SIcon d={DB_ICONS.lock} size={14} />
        Locked
      </span>
    );
  }
  if (!db.reachable) {
    return (
      <span className={`${styles.chip} ${styles.chipErr}`} data-testid="db-chip">
        <SIcon d={DB_ICONS.cloudOff} size={14} />
        Cannot connect
      </span>
    );
  }
  return (
    <span className={styles.chip} data-testid="db-chip">
      <SIcon d={DB_ICONS.checkCircle} size={14} />
      {db.engine === 'sqlite' ? 'Local file' : 'Connected'}
    </span>
  );
}

function facts(db: DatabaseInfo): string {
  if (!db.reachable) return db.unreachable?.error ? `Cannot connect · ${db.unreachable.error}` : 'Cannot connect';
  const parts: string[] = [];
  if (db.engine === 'sqlite') {
    if (db.size != null) parts.push(formatBytes(db.size));
  } else {
    parts.push('Connected');
    if (db.latencyMs != null) parts.push(`${db.latencyMs} ms`);
  }
  if (db.tables != null) parts.push(`${fmtInt(db.tables)} tables`);
  if (db.tickets != null) {
    parts.push(
      `${fmtInt(db.tickets)} ticket${db.tickets === 1 ? '' : 's'} in ${fmtInt(db.projects)} project${db.projects === 1 ? '' : 's'}`,
    );
  }
  if (db.atHead === true) parts.push('up to date');
  else if (db.atHead === false) parts.push('schema update pending');
  if (db.engine !== 'sqlite' && !db.locked) {
    if (!db.passwordSaved) parts.push('no password saved');
    else parts.push(db.passwordStore === 'keychain' ? 'password in your system keychain' : 'password encrypted');
  }
  return parts.join(' · ');
}

function titleOf(db: DatabaseInfo): string {
  if (db.locked) return `${db.label} · set by the environment`;
  if (db.engine === 'sqlite') return 'SQLite · local file';
  return `${db.version || db.label} · ${db.settings.host ?? ''}`;
}

function monoOf(db: DatabaseInfo): string {
  if (db.locked) return db.envVar;
  if (db.engine === 'sqlite') return db.display;
  const ssl = db.secure == null ? '' : ` · SSL ${db.secure ? 'on' : 'off'}`;
  return `${db.display}${ssl}`;
}

/**
 * The database in use: its engine, where it is, how big, whether it answers; Move to another database…, Edit
 * connection…, Test connection, and Use the SQLite file again. Read-only while KANBAN_DATABASE_URL sets it.
 */
export function DatabaseCard({ db }: { db: DatabaseInfo }) {
  const move = useMove();
  const job = move.data ?? db.move;
  const test = useTestConnection();
  const useSqlite = useUseSqlite();
  const [wizard, setWizard] = useState(false);
  const [edit, setEdit] = useState(false);
  const [why, setWhy] = useState(false);
  const [confirmSqlite, setConfirmSqlite] = useState(false);
  const [report, setReport] = useState<TestReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const server = db.engine !== 'sqlite';

  async function runTest() {
    setError(null);
    setReport(null);
    try {
      setReport(
        await test.mutateAsync({
          engine: db.engine,
          host: db.settings.host ?? undefined,
          port: db.settings.port ?? undefined,
          name: db.settings.name ?? undefined,
          user: db.settings.user ?? undefined,
          ssl: db.settings.ssl ?? undefined,
          path: db.settings.path ?? undefined,
          keepPassword: true,
        }),
      );
    } catch (e) {
      setError(extractError(e));
    }
  }

  async function backToSqlite() {
    setError(null);
    try {
      await useSqlite.mutateAsync();
      setConfirmSqlite(false);
    } catch (e) {
      setError(extractError(e));
    }
  }

  const testButton = (
    <button type="button" className={settings.btn} onClick={runTest} disabled={test.isPending}>
      {test.isPending ? <Spinner /> : <SIcon d={DB_ICONS.refresh} size={14} />}
      Test connection
    </button>
  );
  const moveButton = (primary: boolean) => (
    <button
      type="button"
      className={`${settings.btn} ${primary ? settings.btnPrimary : ''}`}
      onClick={() => setWizard(true)}
      data-testid="db-move"
    >
      <SIcon d={DB_ICONS.database} size={14} />
      Move to another database…
    </button>
  );

  return (
    <SettingsCard
      title="Database"
      hint="Where tickets, projects, docs and everything else are stored."
      setting="database"
      aside={<Chip db={db} />}
      testId="database-card"
    >
      <div className={styles.dbRow}>
        <EngineBadge engine={db.engine} />
        <div className={styles.dbText}>
          <div className={styles.dbTitle} data-testid="db-title">
            {titleOf(db)}
          </div>
          <div className={`${settings.mono} ${styles.dbMono}`}>{monoOf(db)}</div>
          {!db.locked && (
            <div className={styles.dbFacts} data-testid="db-facts">
              {facts(db)}
            </div>
          )}
        </div>
      </div>

      {db.locked ? (
        <>
          <div className={`${settings.notice} ${settings.noticeWarn}`} data-testid="db-locked">
            <SIcon d={DB_ICONS.lock} size={15} stroke="#B4791E" />
            <span>
              This computer starts the app with <b>{db.envVar}</b>, so the database cannot be changed from here. Change
              the variable and restart. <b>Test connection</b> still works.
            </span>
          </div>
          <div className={settings.row}>{testButton}</div>
        </>
      ) : (
        <>
          <div className={settings.row}>
            {server ? (
              <>
                <button type="button" className={settings.btn} onClick={() => setEdit(true)}>
                  <SIcon d={DB_ICONS.edit} size={14} />
                  Edit connection…
                </button>
                {testButton}
                {moveButton(false)}
                {db.sqliteFile.exists && (
                  <button type="button" className={settings.btn} onClick={() => setConfirmSqlite(true)}>
                    <SIcon d={DB_ICONS.back} size={14} />
                    Use the SQLite file again
                  </button>
                )}
              </>
            ) : (
              <>
                {moveButton(true)}
                <button type="button" className={settings.btn} aria-expanded={why} onClick={() => setWhy((v) => !v)}>
                  <SIcon d={DB_ICONS.info} size={14} />
                  Why only these?
                </button>
              </>
            )}
          </div>
          {!server && (
            <p className={settings.hint}>
              PostgreSQL and MySQL / MariaDB are supported. Your data stays here until you move it, and the file is
              never changed by a move.
            </p>
          )}
          {why && <WhyOnlyThese tables={db.tables} />}
          {server && (
            <div className={`${settings.notice} ${styles.noticeOk}`}>
              <SIcon d={DB_ICONS.info} size={15} stroke="#2E6F40" />
              <span>
                The database lives on the server. Back it up with your own tools, or use <b>Export data</b> below for a
                copy you can load into any supported database.
              </span>
            </div>
          )}
        </>
      )}

      {(db.otherApps ?? 0) > 0 && (
        <div className={`${settings.notice} ${settings.noticeWarn}`} data-testid="db-other-apps">
          <SIcon d={DB_ICONS.info} size={15} stroke="#B4791E" />
          <span>
            {db.otherApps === 1 ? 'Another app is' : `${db.otherApps} other apps are`} connected to this database,
            perhaps another board. Sharing one database is allowed, but live updates between two boards are not
            guaranteed: a change made in one shows in the other after a refresh.
          </span>
        </div>
      )}

      {confirmSqlite && (
        <div className={settings.confirmBox} role="alertdialog" aria-label="Use the SQLite file again">
          <span className={settings.confirmTitle}>
            <SIcon d={DB_ICONS.warn} size={16} stroke="#C4432A" />
            Use the SQLite file again?
          </span>
          <span>
            The file is as it was when you switched
            {db.sqliteFile.modified ? ` (last written on ${fmtDay(db.sqliteFile.modified)})` : ''}. Anything done since
            is only in {db.label}; it is not copied back. To take it with you, use <b>Move to another database…</b> to
            SQLite instead.
          </span>
          <span className={`${settings.mono} ${styles.dim}`}>{db.sqliteFile.path}</span>
          <div className={settings.row}>
            <button type="button" className={settings.btn} onClick={() => setConfirmSqlite(false)}>
              Cancel
            </button>
            <button
              type="button"
              className={`${settings.btn} ${settings.btnDanger}`}
              disabled={useSqlite.isPending}
              onClick={backToSqlite}
            >
              {useSqlite.isPending && <Spinner />}
              Use the SQLite file
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className={`${settings.notice} ${styles.noticeErr}`} role="alert">
          <SIcon d={DB_ICONS.warn} size={15} stroke="#C4432A" />
          <span>{error}</span>
        </div>
      )}
      {report && <FindingList findings={report.findings} />}

      {moveIsOpen(job) && job && !wizard && (
        <div className={styles.strip} data-testid="db-move-strip">
          <SIcon d={DB_ICONS.database} size={15} stroke="#2E6F40" />
          <span>
            A copy to <b>{job.target.label}</b> {MOVE_WORDS[job.state] ?? job.state}
          </span>
          <span className={styles.spacer} />
          <button type="button" className={settings.btn} onClick={() => setWizard(true)}>
            Open
          </button>
        </div>
      )}

      {wizard && <MoveDatabaseDialog db={db} onClose={() => setWizard(false)} />}
      {edit && (
        <EditConnectionDialog
          current={db.settings}
          passwordStore={db.passwordStore}
          sqlitePath={db.sqliteFile.path}
          onClose={() => setEdit(false)}
        />
      )}
    </SettingsCard>
  );
}
