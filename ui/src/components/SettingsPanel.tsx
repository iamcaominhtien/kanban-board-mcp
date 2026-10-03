import { useRef, useState, useEffect } from 'react';
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

  // App-wide workspace configuration state (persisted to localStorage)
  const [workspaceEnabled, setWorkspaceEnabled] = useState<boolean>(() => {
    return localStorage.getItem('kanban_workspace_enabled') !== 'false';
  });
  const [workspaceRoot, setWorkspaceRoot] = useState<string>(() => {
    return localStorage.getItem('kanban_workspace_root') || '~/kanban-workspace';
  });
  const [defaultRetention, setDefaultRetention] = useState<string>(() => {
    return localStorage.getItem('kanban_workspace_retention') || '30';
  });

  useEffect(() => {
    localStorage.setItem('kanban_workspace_enabled', String(workspaceEnabled));
  }, [workspaceEnabled]);

  useEffect(() => {
    localStorage.setItem('kanban_workspace_root', workspaceRoot);
  }, [workspaceRoot]);

  useEffect(() => {
    localStorage.setItem('kanban_workspace_retention', defaultRetention);
  }, [defaultRetention]);

  const isElectron = !!(window as any).electronAPI?.selectFolder;

  async function handleBrowse() {
    if ((window as any).electronAPI?.selectFolder) {
      const folder = await (window as any).electronAPI.selectFolder();
      if (folder) setFolderInput(folder);
    }
  }

  async function handleBrowseWorkspace() {
    if ((window as any).electronAPI?.selectFolder) {
      const folder = await (window as any).electronAPI.selectFolder();
      if (folder) setWorkspaceRoot(folder);
    }
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
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M6 6L18 18M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* Scrollable Body */}
        <div className={styles.body}>
          {/* Data Folder Section */}
          <div className={styles.section}>
            <span className={styles.sectionTitle}>Data Folder</span>
            <div className={styles.hint}>
              Current: <span className={styles.code}>{isLoading ? 'Loading…' : (settings?.dataFolder || 'Default')}</span>
            </div>
            <div className={styles.inputRow}>
              <input
                className={styles.input}
                type="text"
                placeholder="New folder path (e.g. /Users/you/kanban-data)"
                value={folderInput}
                onChange={(e) => {
                  setFolderInput(e.target.value);
                  setFolderStatus(null);
                }}
              />
              {isElectron && (
                <button type="button" className={styles.btn} onClick={handleBrowse}>
                  Browse…
                </button>
              )}
            </div>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              style={{ alignSelf: 'flex-start' }}
              disabled={!folderInput.trim() || setDataPath.isPending}
              onClick={handleApplyFolder}
            >
              {setDataPath.isPending ? 'Moving…' : 'Apply'}
            </button>
            {folderStatus && (
              <span className={folderStatus.startsWith('✓') ? styles.statusOk : styles.statusErr}>
                {folderStatus}
              </span>
            )}
          </div>

          <div className={styles.divider} />

          {/* Workspace Section (App-wide) */}
          <div className={styles.section}>
            <div className={styles.sectionHeaderRow}>
              <span className={styles.sectionTitle} style={{ flexGrow: 1 }}>Workspace</span>
              <div
                className={`${styles.toggleTrack} ${workspaceEnabled ? styles.toggleTrackActive : ''}`}
                onClick={() => setWorkspaceEnabled((v) => !v)}
                role="switch"
                aria-checked={workspaceEnabled}
              >
                <div className={`${styles.toggleDot} ${workspaceEnabled ? styles.toggleDotActive : ''}`} />
              </div>
            </div>
            <div className={styles.hint}>
              Local scratch folder per task, no API — the Workspace tab on a ticket lists whatever's on disk under this root. Turning this off hides the Workspace tab everywhere.
            </div>

            {workspaceEnabled && (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className={styles.fieldLabel}>Root path</span>
                  <div className={styles.inputRow}>
                    <input
                      className={styles.input}
                      value={workspaceRoot}
                      onChange={(e) => setWorkspaceRoot(e.target.value)}
                    />
                    {isElectron && (
                      <button type="button" className={styles.btn} onClick={handleBrowseWorkspace}>
                        Browse…
                      </button>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className={styles.fieldLabel}>Default retention for new tasks</span>
                  <div className={styles.retentionRow}>
                    {[
                      { value: '7', label: '7 days' },
                      { value: '30', label: '30 days' },
                      { value: '90', label: '90 days' },
                      { value: 'forever', label: 'Forever' },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`${styles.retentionOpt} ${defaultRetention === opt.value ? styles.retentionOptActive : ''}`}
                        onClick={() => setDefaultRetention(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <span className={styles.hint} style={{ fontSize: '11px' }}>
                    Applies to new task folders only — a task can override this from its own Workspace tab. A background sweep deletes folders past their window; anything overridden to "Forever" is skipped.
                  </span>
                </div>
              </>
            )}
          </div>

          <div className={styles.divider} />

          {/* Theme Section */}
          <div className={styles.section}>
            <span className={styles.sectionTitle}>Theme</span>
            <div className={styles.hint}>Switch between color and black &amp; white TV mode.</div>
            <button
              type="button"
              className={styles.btn}
              onClick={onToggleTheme}
              style={{ alignSelf: 'flex-start' }}
            >
              {theme === 'default' ? '📺 Switch to B&W' : '🎨 Switch to Color'}
            </button>
          </div>

          <div className={styles.divider} />

          {/* Import / Export Section */}
          <div className={styles.section}>
            <span className={styles.sectionTitle}>Import / Export</span>
            <div className={styles.hint}>
              Export all data (database + attachments) as a ZIP file. Use the same file to import and restore.
            </div>
            <div className={styles.inputRow}>
              <button type="button" className={styles.btn} onClick={handleExport}>
                ⬇ Export Data
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnDangerOutline}`}
                onClick={() => importRef.current?.click()}
              >
                ⬆ Import Data
              </button>
              <input ref={importRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={handleImport} />
            </div>
            {exportStatus && (
              <span className={exportStatus.startsWith('✓') ? styles.statusOk : styles.statusErr}>
                {exportStatus}
              </span>
            )}
            {importStatus && (
              <span
                className={
                  importStatus.startsWith('✓')
                    ? styles.statusOk
                    : importStatus === 'Importing...'
                    ? styles.statusInfo
                    : styles.statusErr
                }
              >
                {importStatus}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
