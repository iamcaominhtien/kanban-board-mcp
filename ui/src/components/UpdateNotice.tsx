import { useEffect, useState } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import styles from './UpdateNotice.module.css';

const SKIP_KEY = 'skippedUpdateVersion';

type Phase = 'idle' | 'downloading' | 'ready' | 'error';

function readSkipped(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

/** Desktop only: tells the user a newer release exists and downloads / launches its installer. */
export function UpdateNotice() {
  const api = window.electronAPI;
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api?.onUpdateAvailable) return undefined;
    void api.getUpdateInfo?.().then((existing) => existing && setInfo(existing));
    const offAvailable = api.onUpdateAvailable((next) => {
      setInfo(next);
      setDismissed(false);
    });
    const offProgress = api.onUpdateProgress?.(setProgress);
    return () => {
      offAvailable();
      offProgress?.();
    };
  }, [api]);

  if (!api || !info || dismissed || readSkipped() === info.version) return null;

  const isMac = api.platform === 'darwin';

  const download = async () => {
    setPhase('downloading');
    setProgress(0);
    setError(null);
    const res = await api.downloadUpdate?.();
    if (res?.filePath) {
      setFilePath(res.filePath);
      setPhase('ready');
    } else {
      setError(res?.error ?? 'Download failed');
      setPhase('error');
    }
  };

  const install = async () => {
    if (!filePath) return;
    const res = await api.installUpdate?.(filePath);
    if (res && !res.success) {
      setError(res.error ?? 'Could not open the installer');
      setPhase('error');
    }
  };

  const skip = () => {
    try {
      localStorage.setItem(SKIP_KEY, info.version);
    } catch {
      /* storage unavailable — the notice just comes back next launch */
    }
    setDismissed(true);
  };

  return (
    <div className={styles.card} role="status" aria-live="polite">
      <div className={styles.title}>Version {info.version} is available</div>
      {phase === 'idle' && info.notes && (
        <div className={styles.notes}>
          <MarkdownRenderer plain>{info.notes}</MarkdownRenderer>
        </div>
      )}
      {phase === 'downloading' && (
        <div className={styles.bar} aria-label="Download progress">
          <div className={styles.fill} style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {phase === 'ready' && (
        <div className={styles.hint}>
          {isMac
            ? 'Downloaded. Open the disk image, then drag Kanban Board to Applications.'
            : 'Downloaded. Kanban Board will close and the installer will start.'}
        </div>
      )}
      {phase === 'error' && <div className={styles.error}>{error}</div>}
      <div className={styles.actions}>
        {(phase === 'idle' || phase === 'error') && (
          <button className={styles.primary} onClick={() => void download()}>
            {phase === 'error' ? 'Try again' : 'Download'}
          </button>
        )}
        {phase === 'ready' && (
          <button className={styles.primary} onClick={() => void install()}>
            {isMac ? 'Open installer' : 'Install and restart'}
          </button>
        )}
        {phase !== 'downloading' && (
          <>
            <button className={styles.secondary} onClick={() => setDismissed(true)}>
              Later
            </button>
            <button className={styles.secondary} onClick={skip}>
              Skip this version
            </button>
          </>
        )}
        {info.releaseUrl && (
          <button className={styles.link} onClick={() => void api.openExternal?.(info.releaseUrl!)}>
            What's new
          </button>
        )}
      </div>
    </div>
  );
}
