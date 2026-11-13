import { useRef, useState } from 'react';
import { client } from '../../api/client';
import { resolveOrigin } from '../../api/resolveOrigin';
import { useDatabase } from '../../api/database';
import { useSettings, useSetDataPath } from '../../api/settings';
import { DatabaseCard } from './database/DatabaseCard';
import { WorkspaceSettingsSection } from './WorkspaceSettingsSection';
import { WorkspacesCard } from './WorkspacesCard';
import { Field, ICONS, SIcon, SettingsCard } from './settingsUi';
import styles from './SettingsPage.module.css';

type Status = { ok: boolean; text: string } | null;

/** The Database card, or what stands in for it while it loads or when it cannot load. */
function DatabaseSection({ db }: { db: ReturnType<typeof useDatabase> }) {
  if (db.data) return <DatabaseCard db={db.data} />;
  return (
    <SettingsCard
      title="Database"
      hint="Where tickets, projects, docs and everything else are stored."
      setting="database"
      testId="database-card"
    >
      <span className={db.isError ? styles.statusErr : styles.statusInfo}>
        {db.isError ? 'Could not read which database the board uses.' : 'Loading…'}
      </span>
    </SettingsCard>
  );
}

/**
 * Storage & backup: the database, data folder, workspace, export and import (design/screens/settings-pages.md F, H;
 * ai-databases.md B).
 */
export function StoragePage() {
  const { data: settings, isLoading } = useSettings();
  const database = useDatabase();
  // Once the database is a server, the data folder holds only the attachments (ai-databases.md B2)
  const onServer = !!database.data && database.data.engine !== 'sqlite';
  const setDataPath = useSetDataPath();
  const [folderInput, setFolderInput] = useState<string | null>(null);
  const [folderStatus, setFolderStatus] = useState<Status>(null);
  const [folderWarning, setFolderWarning] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<{ kind: 'ok' | 'err' | 'busy'; text: string } | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<File | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const isElectron = !!(window as any).electronAPI?.selectFolder;

  const current = settings?.dataFolder ?? '';
  const folder = folderInput ?? current;
  const changed = folderInput !== null && folderInput.trim() !== '' && folderInput.trim() !== current;

  async function handleBrowse() {
    const picked = await (window as any).electronAPI?.selectFolder?.();
    if (picked) {
      setFolderInput(picked);
      setFolderStatus(null);
    }
  }

  async function handleApplyFolder() {
    const path = folder.trim();
    if (!path) return;
    setFolderStatus(null);
    setFolderWarning(null);
    try {
      const result = await setDataPath.mutateAsync(path);
      setFolderStatus({ ok: true, text: 'Saved' });
      if ((result as any)?.warning) setFolderWarning((result as any).warning);
      setFolderInput(null);
    } catch (e: any) {
      setFolderStatus({ ok: false, text: e?.response?.data?.detail ?? e?.message ?? 'Could not change the folder' });
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
      setImportStatus({ kind: 'err', text: 'Only .zip files are accepted.' });
      return;
    }
    setImportStatus(null);
    setPendingImport(file);
  }

  async function runImport() {
    const file = pendingImport;
    if (!file) return;
    setPendingImport(null);
    setImportStatus({ kind: 'busy', text: 'Importing…' });
    try {
      const formData = new FormData();
      formData.append('file', file);
      await client.post('/data/import', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      setImportStatus({ kind: 'ok', text: 'Import successful. The page will reload.' });
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      setImportStatus({ kind: 'err', text: err?.response?.data?.detail ?? err?.message ?? 'Import failed' });
    }
  }

  return (
    <>
      <DatabaseSection db={database} />

      <WorkspacesCard />

      <SettingsCard
        title="Data folder"
        hint={
          onServer
            ? 'Where attachments are stored. The database is not here any more.'
            : 'Where tickets, attachments and the database are stored.'
        }
        setting="data-folder"
        status={folderStatus}
      >
        <Field
          label="Current folder"
          htmlFor="data-folder-input"
          hint={changed ? 'Apply moves the database and attachments to the new folder.' : undefined}
        >
          <input
            id="data-folder-input"
            className={`${styles.input} ${styles.mono}`}
            type="text"
            aria-label="Data folder path"
            placeholder={isLoading ? 'Loading…' : '/Users/you/kanban-data'}
            value={folder}
            onChange={(e) => {
              setFolderInput(e.target.value);
              setFolderStatus(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && changed) void handleApplyFolder();
            }}
          />
        </Field>
        {onServer && (
          <div className={styles.hint}>
            Attachments stay on this computer, next to the app. They are not copied to the database.
          </div>
        )}
        <div className={styles.row}>
          {isElectron && (
            <button type="button" className={styles.btn} onClick={handleBrowse}>
              <SIcon d={ICONS.folder} size={14} />
              Browse…
            </button>
          )}
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={!changed || setDataPath.isPending}
            onClick={handleApplyFolder}
          >
            {setDataPath.isPending ? 'Moving…' : 'Apply'}
          </button>
          {changed && (
            <button type="button" className={styles.btn} onClick={() => setFolderInput(null)}>
              Cancel
            </button>
          )}
        </div>
        {folderWarning && (
          <div className={`${styles.notice} ${styles.noticeWarn}`} role="status">
            <SIcon d={ICONS.alert} size={15} stroke="#B4791E" />
            <span>
              <b>Data folder updated.</b> {folderWarning}
            </span>
          </div>
        )}
      </SettingsCard>

      <WorkspaceSettingsSection />

      <SettingsCard
        title="Import and export"
        hint={
          onServer
            ? 'Export all data as a ZIP with a portable copy of the database and the attachments. It loads into SQLite, PostgreSQL or MySQL.'
            : 'Export all data (database and attachments) as a ZIP. Use the same file to restore.'
        }
        setting="export"
      >
        <div className={styles.row} data-setting="import">
          <button type="button" className={styles.btn} onClick={handleExport}>
            <SIcon d={ICONS.download} size={14} />
            Export data
          </button>
          <button type="button" className={styles.btn} onClick={() => importRef.current?.click()}>
            <SIcon d={ICONS.upload} size={14} />
            Import data…
          </button>
          <input ref={importRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={handlePickImport} />
        </div>
        {pendingImport && (
          <div className={styles.confirmBox} role="alertdialog" aria-label="Confirm import">
            <span className={styles.confirmTitle}>
              <SIcon d={ICONS.alert} size={16} stroke="#C4432A" />
              Import will replace all current data
            </span>
            <span>
              Tickets, projects, members and attachments. This cannot be undone. Export first if you are not sure. File:{' '}
              <span className={styles.code}>{pendingImport.name}</span>
            </span>
            <div className={styles.row}>
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
              importStatus.kind === 'ok'
                ? styles.statusOk
                : importStatus.kind === 'busy'
                  ? styles.statusInfo
                  : styles.statusErr
            }
            role="status"
          >
            {importStatus.text}
          </span>
        )}
        <div className={styles.hint}>
          {onServer
            ? 'Import replaces the data in the connected database, after the same confirmation as today.'
            : 'Ticket Workspace files are not included; they live outside the data folder on purpose.'}
        </div>
      </SettingsCard>
    </>
  );
}
