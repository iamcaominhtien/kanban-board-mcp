import { useEffect, useState } from 'react';
import { sweepWorkspaces, useUpdateWorkspaceSettings, useWorkspaceSettings } from '../../api/tickets';
import { extractError } from '../../api/extractError';
import type { WorkspaceSweepResult } from '../../types/ticket';
import { Field, ICONS, Pills, SIcon, SettingRow, SettingsCard, Switch } from './settingsUi';
import styles from './SettingsPage.module.css';

const RETENTION = [
  [7, '7 days'],
  [14, '14 days'],
  [30, '30 days'],
  [90, '90 days'],
  [0, 'Forever'],
] as const;

/** Storage & backup › Workspace: on/off, root path, retention and the cleanup sweep (F; H: Workspace turned off). */
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

  function save(data: Parameters<typeof update.mutate>[0]) {
    setStatus(null);
    update.mutate(data, {
      onSuccess: () => setStatus({ ok: true, text: 'Saved' }),
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
      save({ rootPath: folder });
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

  const on = settings.enabled;
  const retention = settings.defaultRetentionDays ?? 0;
  const rootChanged = rootDraft.trim() !== settings.rootPath;

  return (
    <SettingsCard
      title="Workspace"
      hint="A local scratch folder per ticket. AI agents get its path from the MCP server and read and write it directly. Turning it off hides the Workspace tab everywhere."
      setting="workspace"
      status={status}
    >
      <SettingRow title="Enable workspace" hint="Off keeps your folder and retention for next time.">
        <Switch on={on} label="Enable workspace" disabled={update.isPending} onChange={(v) => save({ enabled: v })} />
      </SettingRow>

      {!on && (
        <div className={styles.notice} role="status">
          <SIcon d={ICONS.alert} size={15} stroke="#5B6B60" />
          <span>
            Turned off: the Workspace tab is hidden on every ticket. Your folder and retention stay saved. Turn it on to
            edit them.
          </span>
        </div>
      )}

      <Field label="Root path" htmlFor="ws-root" hint="Existing ticket folders are not moved when the root changes.">
        <div className={styles.row} style={{ flexWrap: 'nowrap' }}>
          <input
            id="ws-root"
            className={`${styles.input} ${styles.mono}`}
            value={rootDraft}
            disabled={!on}
            aria-label="Workspace root path"
            onChange={(e) => setRootDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && rootChanged) save({ rootPath: rootDraft });
            }}
          />
          {isElectron && (
            <button type="button" className={styles.btn} disabled={!on} onClick={browse}>
              <SIcon d={ICONS.folder} size={14} />
              Browse…
            </button>
          )}
          {rootChanged && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={update.isPending}
              onClick={() => save({ rootPath: rootDraft })}
            >
              Apply
            </button>
          )}
        </div>
      </Field>

      <Field
        label="Default retention for new tickets"
        hint="Applies to new folders only. A ticket can override it. An hourly sweep deletes the folder of a Done or Won’t do ticket once it has been idle this long; open tickets are never touched."
      >
        <div style={{ opacity: on ? 1 : 0.5, pointerEvents: on ? undefined : 'none' }}>
          <Pills
            options={RETENTION}
            value={retention}
            label="Default retention"
            onChange={(v) => save({ defaultRetentionDays: v })}
          />
        </div>
      </Field>

      {on && (
        <div className={styles.row}>
          <button type="button" className={styles.btn} onClick={previewSweep}>
            <SIcon d={ICONS.trash} size={14} />
            Clean now…
          </button>
          {sweepPreview && (
            <span className={styles.hint} role="status">
              {sweepPreview.removed.length === 0
                ? 'Nothing is due for cleanup.'
                : `${sweepPreview.removed.length} folder(s) would be deleted: ${sweepPreview.removed
                    .map((r) => r.ticketId)
                    .join(', ')}.`}
            </span>
          )}
          {sweepPreview && sweepPreview.removed.length > 0 && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnDanger}`}
              disabled={sweeping}
              onClick={runSweep}
            >
              Delete them
            </button>
          )}
        </div>
      )}
    </SettingsCard>
  );
}
