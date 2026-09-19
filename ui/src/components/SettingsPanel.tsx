import { useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import { resolveOrigin } from '../api/resolveOrigin';
import { useSettings, useSetDataPath } from '../api/settings';
import type { Theme } from '../types';
import styles from './SettingsPanel.module.css';

interface SettingsPanelProps {
  onClose: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

export function SettingsPanel({ onClose, theme, onToggleTheme }: SettingsPanelProps) {
  const { data: settings, isLoading } = useSettings();
  const setDataPath = useSetDataPath();
  const [folderInput, setFolderInput] = useState('');
  const [folderStatus, setFolderStatus] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const WORKSPACE_SETTINGS_KEY = 'kanban.workspaceSettings';

  // TODO(backend): workspace settings are local-only (localStorage) for now.
  // Replace with GET/POST against a real workspace-settings endpoint once
  // server/api/settings.py exposes one — see server/config.py for where
  // data-folder settings are currently persisted, as a pattern to follow.
  const [workspaceEnabled, setWorkspaceEnabled] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(WORKSPACE_SETTINGS_KEY);
      if (raw) return !!JSON.parse(raw).enabled;
    } catch {
      // ignore — fall back to default
    }
    return false;
  });
  const [workspaceRootPath, setWorkspaceRootPath] = useState<string>(() => {
    try {
      const raw = localStorage.getItem(WORKSPACE_SETTINGS_KEY);
      if (raw) return JSON.parse(raw).rootPath ?? '';
    } catch {
      // ignore — fall back to default
    }
    return '';
  });
  const [retentionDays, setRetentionDays] = useState<7 | 30 | 90 | null>(() => {
    try {
      const raw = localStorage.getItem(WORKSPACE_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw).retentionDays;
        if (parsed === 7 || parsed === 30 || parsed === 90 || parsed === null) return parsed;
      }
    } catch {
      // ignore — fall back to default
    }
    return null;
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        WORKSPACE_SETTINGS_KEY,
        JSON.stringify({ enabled: workspaceEnabled, rootPath: workspaceRootPath, retentionDays }),
      );
    } catch {
      // ignore — localStorage may be unavailable
    }
  }, [workspaceEnabled, workspaceRootPath, retentionDays]);

  const isElectron = !!(window as any).electronAPI?.selectFolder;

  async function handleBrowse() {
    const folder = await (window as any).electronAPI.selectFolder();
    if (folder) setFolderInput(folder);
  }

  async function handleApplyFolder() {
    const path = folderInput.trim();
    if (!path) return;
    setFolderStatus(null);
    try {
      const result = await setDataPath.mutateAsync(path);
      let msg = '✓ Data folder updated successfully.';
      if ((result as any)?.warning) {
        msg += ` ⚠️ ${(result as any).warning}`;
      }
      setFolderStatus(msg);
      setFolderInput('');
    } catch (e: any) {
      setFolderStatus(`Error: ${e?.response?.data?.detail ?? e?.message ?? 'Failed'}`);
    }
  }

  async function handleExport() {
    setExportStatus(null);
    try {
      const origin = await resolveOrigin();
      const res = await fetch(`${origin}/data/export`);
      if (!res.ok) {
        const msg = await res.text();
        setExportStatus(`Export error: ${msg}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'kanban-export.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setExportStatus(`Export failed: ${e?.message ?? 'Unknown error'}`);
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.zip')) {
      setImportStatus('Error: Only .zip files are accepted.');
      return;
    }
    const confirmed = window.confirm(
      '⚠️ Import will REPLACE all current data (tickets, projects, members, attachments).\n\nThis cannot be undone. Continue?',
    );
    if (!confirmed) {
      e.target.value = '';
      return;
    }
    setImportStatus('Importing...');
    try {
      const formData = new FormData();
      formData.append('file', file);
      await client.post('/data/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setImportStatus('✓ Import successful. The page will reload.');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      setImportStatus(`Error: ${err?.response?.data?.detail ?? err?.message ?? 'Import failed'}`);
    }
    e.target.value = '';
  }

  return (
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-modal="true" aria-label="Settings">
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Data Folder</h3>
          {isLoading ? (
            <p className={styles.hint}>Loading...</p>
          ) : (
            <p className={styles.hint}>
              Current: <code className={styles.code}>{settings?.dataFolder}</code>
            </p>
          )}
          <div className={styles.folderRow}>
            <input
              className={styles.input}
              type="text"
              placeholder="New folder path (e.g. /Users/you/kanban-data)"
              value={folderInput}
              onChange={(e) => { setFolderInput(e.target.value); setFolderStatus(null); }}
            />
            {isElectron && (
              <button type="button" className={styles.browseBtn} onClick={handleBrowse}>
                Browse…
              </button>
            )}
          </div>
          <button
            type="button"
            className={styles.applyBtn}
            disabled={!folderInput.trim() || setDataPath.isPending}
            onClick={handleApplyFolder}
          >
            {setDataPath.isPending ? 'Moving…' : 'Apply'}
          </button>
          {folderStatus && (
            <p className={`${styles.status} ${folderStatus.startsWith('✓') ? styles.statusSuccess : styles.statusError}`}>
              {folderStatus}
            </p>
          )}
        </div>

        <div className={styles.divider} />

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Workspace</h3>
          <p className={styles.hint}>
            Give this board its own root folder and (eventually) an automatic retention policy.
          </p>
          <button
            type="button"
            className={`${styles.workspaceToggle} ${workspaceEnabled ? styles.workspaceToggleActive : ''}`}
            aria-pressed={workspaceEnabled}
            onClick={() => setWorkspaceEnabled((v) => !v)}
          >
            {workspaceEnabled ? 'Enabled' : 'Disabled'}
          </button>

          <input
            className={styles.rootPathInput}
            type="text"
            placeholder="Workspace root path (e.g. /Users/you/workspace)"
            value={workspaceRootPath}
            onChange={(e) => setWorkspaceRootPath(e.target.value)}
            disabled={!workspaceEnabled}
          />

          {/* TODO(backend): retentionDays currently has no effect beyond being
              displayed/persisted locally — there is no cleanup job wired to it yet. */}
          <div className={styles.retentionRow}>
            {([7, 30, 90, null] as const).map((days) => (
              <button
                key={String(days)}
                type="button"
                className={`${styles.retentionChip} ${retentionDays === days ? styles.retentionChipActive : ''}`}
                disabled={!workspaceEnabled}
                onClick={() => setRetentionDays(days)}
              >
                {days === null ? 'Forever' : `${days} days`}
              </button>
            ))}
          </div>

          {workspaceEnabled && workspaceRootPath.trim() === '' && (
            <p className={styles.warningBanner}>Set a root path to finish enabling Workspace.</p>
          )}
        </div>

        <div className={styles.divider} />

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Theme</h3>
          <p className={styles.hint}>
            Switch between color and black & white TV mode.
          </p>
          <button
            type="button"
            className={styles.applyBtn}
            onClick={onToggleTheme}
            style={{ marginTop: '8px' }}
          >
            {theme === 'default' ? '📺 Switch to B&W' : '🎨 Switch to Color'}
          </button>
        </div>

        <div className={styles.divider} />

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Import / Export</h3>
          <p className={styles.hint}>
            Export all data (database + attachments) as a ZIP file. Use the same file to import and
            restore.
          </p>
          <div className={styles.importExportRow}>
            <button type="button" className={styles.exportBtn} onClick={handleExport}>
              ⬇ Export Data
            </button>
            <button type="button" className={styles.importBtn} onClick={() => importRef.current?.click()}>
              ⬆ Import Data
            </button>
            <input ref={importRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={handleImport} />
          </div>
          {exportStatus && (
            <p className={`${styles.status} ${exportStatus.startsWith('✓') ? styles.statusSuccess : styles.statusError}`}>
              {exportStatus}
            </p>
          )}
          {importStatus && (
            <p className={`${styles.status} ${importStatus.startsWith('✓') ? styles.statusSuccess : importStatus === 'Importing...' ? styles.statusInfo : styles.statusError}`}>
              {importStatus}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
