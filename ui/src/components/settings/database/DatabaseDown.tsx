import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getDatabaseHealth, useDatabase, useUseSqlite, type Engine } from '../../../api/database';
import {
  clearDatabaseUnreachable,
  databaseUnreachableNow,
  subscribeDatabaseUnreachable,
  type DatabaseUnreachable,
} from '../../../api/databaseDown';
import { extractError } from '../../../api/extractError';
import { SIcon } from '../settingsUi';
import settings from '../SettingsPage.module.css';
import { EditConnectionDialog } from './EditConnectionDialog';
import { DB_ICONS, Spinner } from './dbUi';
import { fmtDay } from './dbFormat';
import styles from './Database.module.css';

/** "40 seconds", "3 minutes", "2 hours". */
function fmtSince(s: number): string {
  if (s < 90) return `${Math.max(1, Math.round(s))} seconds`;
  if (s < 90 * 60) return `${Math.round(s / 60)} minutes`;
  return `${Math.round(s / 3600)} hours`;
}

/** The reconnect screen itself (exported for tests); `down` is what the server said. */
export function DatabaseDownScreen({ down }: { down: DatabaseUnreachable }) {
  const qc = useQueryClient();
  const db = useDatabase();
  const useSqlite = useUseSqlite();
  const [retryS, setRetryS] = useState(8);
  const [nextAt, setNextAt] = useState(() => Date.now() + 8000);
  const [now, setNow] = useState(() => Date.now());
  const [trying, setTrying] = useState(false);
  const [edit, setEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const tryNow = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setTrying(true);
    try {
      const h = await getDatabaseHealth();
      if (h.retryS) setRetryS(h.retryS);
      if (h.ok && !h.unreachable) {
        clearDatabaseUnreachable();
        void qc.invalidateQueries();
        return;
      }
    } catch {
      /* still down; try again later */
    } finally {
      busy.current = false;
      setTrying(false);
      setNextAt(Date.now() + retryS * 1000);
    }
  }, [qc, retryS]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (now >= nextAt && !busy.current) void tryNow();
  }, [now, nextAt, tryNow]);

  const t = down.target ?? {};
  const label = t.label ?? 'The database';
  const where = t.host ? `${t.host}${t.port ? `:${t.port}` : ''}` : (t.display ?? '');
  const since = Math.max(0, now / 1000 - down.since);
  const left = Math.max(0, Math.ceil((nextAt - now) / 1000));
  const sqlite = db.data?.sqliteFile;

  async function openSqlite() {
    setError(null);
    try {
      await useSqlite.mutateAsync();
      clearDatabaseUnreachable();
      window.location.reload();
    } catch (e) {
      setError(extractError(e));
    }
  }

  return (
    <div className={styles.downOverlay} role="alertdialog" aria-labelledby="db-down-title" data-testid="database-down">
      <div className={styles.downBox}>
        <SIcon d={DB_ICONS.cloudOff} size={34} stroke="#C4432A" />
        <h1 id="db-down-title" className={styles.downTitle}>
          The board cannot reach its database
        </h1>
        <p className={styles.para}>
          {label}
          {where && (
            <>
              {' '}
              at <b>{where}</b>
            </>
          )}{' '}
          did not answer for {fmtSince(since)}. Nothing is lost: the board reconnects by itself and{' '}
          {trying ? 'is trying now' : `tries again in ${left} second${left === 1 ? '' : 's'}`}.
        </p>
        {down.error && <div className={`${settings.mono} ${styles.downError}`}>{down.error}</div>}
        <div className={settings.row}>
          <button
            type="button"
            className={`${settings.btn} ${settings.btnPrimary}`}
            disabled={trying}
            onClick={() => void tryNow()}
          >
            {trying ? <Spinner /> : <SIcon d={DB_ICONS.refresh} size={14} />}
            Try now
          </button>
          <button type="button" className={settings.btn} onClick={() => setEdit(true)}>
            <SIcon d={DB_ICONS.edit} size={14} />
            Edit connection…
          </button>
        </div>
        {sqlite?.exists && (
          <div className={styles.box}>
            <b>Use the old SQLite file instead</b>
            <span>
              {sqlite.modified ? `It was last written on ${fmtDay(sqlite.modified)}, before you switched. ` : ''}
              Anything done since is only in {label}.
            </span>
            <div className={settings.row}>
              <button type="button" className={settings.btn} disabled={useSqlite.isPending} onClick={openSqlite}>
                {useSqlite.isPending ? <Spinner /> : <SIcon d={DB_ICONS.database} size={14} />}
                Open the SQLite file
              </button>
            </div>
          </div>
        )}
        {error && <span className={settings.statusErr}>{error}</span>}
      </div>
      {edit && (
        <EditConnectionDialog
          current={db.data?.settings ?? { ...t, engine: (t.engine ?? 'postgresql') as Engine }}
          passwordStore={db.data?.passwordStore ?? 'file'}
          sqlitePath={sqlite?.path ?? ''}
          onClose={() => setEdit(false)}
          onSaved={(info) => {
            if (info.reachable) {
              clearDatabaseUnreachable();
              void qc.invalidateQueries();
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * "The board cannot reach its database" (design/screens/ai-databases.md E3), over the whole app: shown when an API
 * call answers 503 database_unreachable, until GET /database/health says the database answers again.
 */
export function DatabaseDown() {
  const down = useSyncExternalStore(subscribeDatabaseUnreachable, databaseUnreachableNow, () => null);
  if (!down) return null;
  return <DatabaseDownScreen down={down} />;
}
