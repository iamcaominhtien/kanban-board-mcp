import { useEffect, useState } from 'react';
import { ICONS, SIcon, SettingsCard } from './settings/settingsUi';
import styles from './settings/SettingsPage.module.css';

type Result =
  { kind: 'latest' } | { kind: 'available'; version: string } | { kind: 'error'; message: string; automatic: boolean };

function formatCheckedAt(at: string): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Settings → Updates (desktop only): installed version, a manual update check and the releases page. */
export function UpdateSettingsSection() {
  const api = window.electronAPI;
  const [version, setVersion] = useState<string | null>(null);
  const [lastCheck, setLastCheck] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    void api?.getUpdateStatus?.().then((status) => {
      setVersion(status.currentVersion);
      setLastCheck(status.lastCheck);
      // Surface what the automatic check found, including a failure that would otherwise stay silent
      if (status.lastCheck?.error) setResult({ kind: 'error', message: status.lastCheck.error, automatic: true });
      else if (status.info) setResult({ kind: 'available', version: status.info.version });
    });
  }, [api]);

  if (!api?.getUpdateStatus || !api.checkForUpdate) return null;

  const checkForUpdate = api.checkForUpdate;
  const check = async () => {
    setChecking(true);
    setResult(null);
    const res = await checkForUpdate();
    setChecking(false);
    setLastCheck(res.lastCheck);
    if (res.error) setResult({ kind: 'error', message: res.error, automatic: false });
    else setResult(res.info ? { kind: 'available', version: res.info.version } : { kind: 'latest' });
  };

  const status =
    result?.kind === 'latest'
      ? { ok: true, text: 'Up to date' }
      : result?.kind === 'error'
        ? { ok: false, text: result.automatic ? 'Last check failed' : "Couldn't check" }
        : null;

  return (
    <SettingsCard
      title="Updates"
      hint={
        <>
          Installed version <span className={styles.code}>{version ?? '…'}</span>
          {' · '}
          {lastCheck ? `last checked ${formatCheckedAt(lastCheck.at)}` : 'not checked yet'}. Kanban Board looks for a
          new version when it starts and every 6 hours.
        </>
      }
      setting="updates"
      status={status}
      testId="update-settings"
    >
      <div className={styles.row}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={checking}
          onClick={() => void check()}
        >
          <SIcon d={ICONS.updates} size={14} />
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
        <button type="button" className={styles.btn} onClick={() => void api.openReleasesPage?.()}>
          <SIcon d={ICONS.external} size={14} />
          Release notes
        </button>
      </div>
      {result?.kind === 'latest' && (
        <span className={styles.statusOk}>
          <SIcon d={ICONS.checkCircle} size={13} width={2.2} />
          You are on the latest version.
        </span>
      )}
      {result?.kind === 'available' && (
        <div className={`${styles.notice} ${styles.noticeWarn}`} role="status">
          <SIcon d={ICONS.updates} size={15} stroke="#B4791E" />
          <span>
            <b>Version {result.version} is available.</b> Download it from the notice in the corner.
          </span>
        </div>
      )}
      {result?.kind === 'error' && (
        <span className={styles.statusErr}>
          {result.automatic ? 'The last update check failed' : "Couldn't check for updates"}: {result.message}
        </span>
      )}
      <div className={styles.hint}>
        If the download in the app does not work, get the installer from the releases page.
      </div>
    </SettingsCard>
  );
}
