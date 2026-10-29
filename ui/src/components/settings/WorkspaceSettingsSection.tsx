import { useEffect, useState } from 'react';
import { sweepWorkspaces, useUpdateWorkspaceSettings, useWorkspaceSettings } from '../../api/tickets';
import { extractError } from '../../api/extractError';
import type { WorkspaceSweepResult } from '../../types/ticket';
import styles from './SettingsPage.module.css';

/** Workspace on/off, root path, retention and the cleanup sweep. */
export function WorkspaceSettingsSection() {
  const { data: settings } = useWorkspaceSettings();
  const update = useUpdateWorkspaceSettings();
  const [rootDraft, setRootDraft] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [sweepPreview, setSweepPreview] = useState<WorkspaceSweepResult | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const isElectron = !!(window as any).electronAPI?.selectFolder;

  useEffect(() => {
    if (settings) setRootDraft(settings.rootPath);
  }, [settings]);

  if (!settings) return null;

  function save(data: Parameters<typeof update.mutate>[0], okText?: string) {
    setStatus(null);
    update.mutate(data, {
      onSuccess: () => okText && setStatus({ ok: true, text: okText }),
      onError: (err) => {
        setStatus({ ok: false, text: extractError(err) });
        setRootDraft(settings?.rootPath ?? '');
      },
    });
  }

  async function browse() {
    const folder = await (window as any).electronAPI?.selectFolder?.();
    if (folder) {
      setRootDraft(folder);
      save({ rootPath: folder }, 'Root path saved');
    }
  }

  async function previewSweep() {
    setStatus(null);
    try {
      setSweepPreview(await sweepWorkspaces(true));
    } catch (err) {
      setStatus({ ok: false, text: extractError(err) });
    }
  }

  async function runSweep() {
    setSweeping(true);
    try {
      const res = await sweepWorkspaces(false);
      setSweepPreview(null);
      setStatus({ ok: true, text: `Deleted ${res.removed.length} folder(s)` });
    } catch (err) {
      setStatus({ ok: false, text: extractError(err) });
    } finally {
      setSweeping(false);
    }
  }

  const retention = settings.defaultRetentionDays ?? 0;
  const rootChanged = rootDraft.trim() !== settings.rootPath;

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionHeaderRow}>
          <span className={styles.sectionTitle} style={{ flexGrow: 1 }}>
            Workspace
          </span>
          <div
            className={`${styles.toggleTrack} ${settings.enabled ? styles.toggleTrackActive : ''}`}
            onClick={() => save({ enabled: !settings.enabled })}
            role="switch"
            aria-checked={settings.enabled}
            aria-label="Enable workspace"
          >
            <div className={`${styles.toggleDot} ${settings.enabled ? styles.toggleDotActive : ''}`} />
          </div>
        </div>
        <div className={styles.hint}>
          A local scratch folder per ticket. AI agents get its path from the MCP server and read and write it directly;
          the Workspace tab on a ticket shows what is on disk. Turning this off hides the Workspace tab everywhere.
        </div>

        {settings.enabled && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className={styles.fieldLabel}>Root path</span>
              <div className={styles.inputRow}>
                <input
                  className={styles.input}
                  value={rootDraft}
                  aria-label="Workspace root path"
                  onChange={(e) => setRootDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && rootChanged) save({ rootPath: rootDraft }, 'Root path saved');
                  }}
                />
                {isElectron && (
                  <button type="button" className={styles.btn} onClick={browse}>
                    Browse…
                  </button>
                )}
                <button
                  type="button"
                  className={styles.btn}
                  disabled={!rootChanged || update.isPending}
                  onClick={() => save({ rootPath: rootDraft }, 'Root path saved')}
                >
                  Save
                </button>
              </div>
              <span className={styles.hint} style={{ fontSize: '11px' }}>
                Existing ticket folders are not moved when the root changes.
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className={styles.fieldLabel}>Default retention</span>
              <div className={styles.retentionRow}>
                {[
                  { value: 7, label: '7 days' },
                  { value: 14, label: '14 days' },
                  { value: 30, label: '30 days' },
                  { value: 90, label: '90 days' },
                  { value: 0, label: 'Forever' },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`${styles.retentionOpt} ${retention === opt.value ? styles.retentionOptActive : ''}`}
                    onClick={() => save({ defaultRetentionDays: opt.value })}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <span className={styles.hint} style={{ fontSize: '11px' }}>
                A background sweep (hourly) deletes the folder of a Done / Won&apos;t do ticket once it has been idle
                this long. Open tickets and tickets set to &quot;Forever&quot; are never touched. A ticket can override
                this from its own Workspace tab.
              </span>
              <div className={styles.inputRow}>
                <button type="button" className={styles.btn} onClick={previewSweep}>
                  Clean now…
                </button>
              </div>
              {sweepPreview && (
                <div className={styles.hint} role="status">
                  {sweepPreview.removed.length === 0 ? (
                    'Nothing is due for cleanup.'
                  ) : (
                    <>
                      {sweepPreview.removed.length} folder(s) would be deleted:{' '}
                      {sweepPreview.removed.map((r) => r.ticketId).join(', ')}.{' '}
                      <button type="button" className={styles.btn} disabled={sweeping} onClick={runSweep}>
                        Delete them
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}
        {status && (
          <div className={styles.hint} role="status" style={{ color: status.ok ? undefined : '#C0392B' }}>
            {status.text}
          </div>
        )}
      </div>
    </>
  );
}
