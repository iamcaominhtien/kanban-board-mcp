import { useEffect, useState } from 'react';
import styles from './SettingsPanel.module.css';

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

  return (
    <div className={styles.section} data-testid="update-settings">
      <span className={styles.sectionTitle}>Updates</span>
      <div className={styles.hint}>
        Installed version: <span className={styles.code}>{version ?? '…'}</span>
        {' · '}
        {lastCheck ? `Last checked ${formatCheckedAt(lastCheck.at)}` : 'Not checked yet'}
      </div>
      <div className={styles.hint}>
        Kanban Board looks for a new version when it starts and every 6 hours. If the download in the app does not work,
        get the installer from the releases page.
      </div>
      <div className={styles.inputRow}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={checking}
          onClick={() => void check()}
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
        <button type="button" className={styles.btn} onClick={() => void api.openReleasesPage?.()}>
          Open releases page ↗
        </button>
      </div>
      {result?.kind === 'latest' && <span className={styles.statusOk}>✓ You're on the latest version.</span>}
      {result?.kind === 'available' && (
        <span className={styles.statusOk}>
          ✓ Version {result.version} is available. Download it from the notice in the corner.
        </span>
      )}
      {result?.kind === 'error' && (
        <span className={styles.statusErr}>
          ✗ {result.automatic ? 'The last update check failed' : "Couldn't check for updates"}: {result.message}
        </span>
      )}
    </div>
  );
}
