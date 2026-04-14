import { useRef, useState } from 'react';
import { client } from '../api/client';
import { resolveOrigin } from '../api/resolveOrigin';
import { useSettings, useSetDataPath } from '../api/settings';
import styles from './SettingsPanel.module.css';

interface SettingsPanelProps {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { data: settings, isLoading } = useSettings();
  const setDataPath = useSetDataPath();
  const [folderInput, setFolderInput] = useState('');
  const [folderStatus, setFolderStatus] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

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
      await setDataPath.mutateAsync(path);
      setFolderStatus('✓ Data folder updated successfully.');
      setFolderInput('');
    } catch (e: any) {
      setFolderStatus(`Error: ${e?.response?.data?.detail ?? e?.message ?? 'Failed'}`);
    }
  }

  async function handleExport() {
    const origin = await resolveOrigin();
    const a = document.createElement('a');
    a.href = `${origin}/data/export`;
    a.download = 'kanban-export.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
              onChange={(e) => setFolderInput(e.target.value)}
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
