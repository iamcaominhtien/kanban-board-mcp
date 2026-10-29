import { useRef, useState } from 'react';
import { client } from '../../api/client';
import { resolveOrigin } from '../../api/resolveOrigin';
import { useSettings, useSetDataPath } from '../../api/settings';
import { WorkspaceSettingsSection } from './WorkspaceSettingsSection';
import styles from './SettingsPage.module.css';

/** Storage & backup: data folder, workspace, export and import (import confirms inline). */
export function StoragePage() {
  const { data: settings, isLoading } = useSettings();
  const setDataPath = useSetDataPath();
  const [folderInput, setFolderInput] = useState('');
  const [folderStatus, setFolderStatus] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<File | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const isElectron = !!(window as any).electronAPI?.selectFolder;

  async function handleBrowse() {
    const folder = await (window as any).electronAPI?.selectFolder?.();
    if (folder) setFolderInput(folder);
  }

  async function handleApplyFolder() {
    const path = folderInput.trim();
    if (!path) return;
    setFolderStatus(null);
    try {
      const result = await setDataPath.mutateAsync(path);
      let msg = '✓ Data folder updated successfully.';
      if ((result as any)?.warning) msg += ` ⚠️ ${(result as any).warning}`;
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
        setExportStatus(`Export error: ${await res.text()}`);
        return;
      }
      const url = URL.createObjectURL(await res.blob());
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

  function handlePickImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.name.endsWith('.zip')) {
      setImportStatus('Error: Only .zip files are accepted.');
      return;
    }
    setImportStatus(null);
    setPendingImport(file);
  }

  async function runImport() {
    const file = pendingImport;
    if (!file) return;
    setPendingImport(null);
    setImportStatus('Importing...');
    try {
      const formData = new FormData();
      formData.append('file', file);
      await client.post('/data/import', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      setImportStatus('✓ Import successful. The page will reload.');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      setImportStatus(`Error: ${err?.response?.data?.detail ?? err?.message ?? 'Import failed'}`);
    }
  }

  return (
    <>
      <div className={styles.section} data-setting="data-folder">
        <span className={styles.sectionTitle}>Data folder</span>
        <div className={styles.hint}>
          Where tickets, attachments and the database are stored. Current:{' '}
          <span className={styles.code}>{isLoading ? 'Loading…' : settings?.dataFolder || 'Default'}</span>
        </div>
        <div className={styles.inputRow}>
          <input
            className={styles.input}
            type="text"
            aria-label="New data folder path"
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
          <span className={folderStatus.startsWith('✓') ? styles.statusOk : styles.statusErr}>{folderStatus}</span>
        )}
      </div>

      <div data-setting="workspace">
        <WorkspaceSettingsSection />
      </div>

      <div className={styles.section} data-setting="export">
        <span className={styles.sectionTitle}>Import and export</span>
        <div className={styles.hint} data-setting="import">
          Export all data (database and attachments) as a ZIP. Use the same file to restore. Workspace files are not
          included; they live outside the data folder on purpose.
        </div>
        <div className={styles.inputRow}>
          <button type="button" className={styles.btn} onClick={handleExport}>
            ⬇ Export data
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDangerOutline}`}
            onClick={() => importRef.current?.click()}
          >
            ⬆ Import data…
          </button>
          <input ref={importRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={handlePickImport} />
        </div>
        {pendingImport && (
          <div className={styles.confirmBox} role="alertdialog" aria-label="Confirm import">
            <strong>Import will replace all current data</strong>
            <span>
              Tickets, projects, members and attachments. This cannot be undone. Export first if you are not sure. File:{' '}
              <span className={styles.code}>{pendingImport.name}</span>
            </span>
            <div className={styles.inputRow}>
              <button type="button" className={styles.btn} onClick={() => setPendingImport(null)}>
                Cancel
              </button>
              <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={runImport}>
                Replace my data
              </button>
            </div>
          </div>
        )}
        {exportStatus && <span className={styles.statusErr}>{exportStatus}</span>}
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
    </>
  );
}
