import { useState } from 'react';
import {
  reloadAfterSwitch,
  useAddWorkspace,
  useRemoveWorkspace,
  useRenameWorkspace,
  useSwitchWorkspace,
  useWorkspaces,
  workspaceError,
  type WorkspaceItem,
} from '../../api/workspaces';
import { Field, ICONS, SIcon, SettingsCard } from './settingsUi';
import styles from './SettingsPage.module.css';

type Status = { ok: boolean; text: string } | null;

/**
 * Storage & backup › Workspaces: the boards kept on this computer (one data folder each) and a one-click switch
 * between them, in place of exporting one board and importing the other.
 */
export function WorkspacesCard() {
  const { data, isLoading } = useWorkspaces();
  const add = useAddWorkspace();
  const rename = useRenameWorkspace();
  const remove = useRemoveWorkspace();
  const open = useSwitchWorkspace();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const isElectron = !!window.electronAPI?.selectFolder;
  const items = data?.items ?? [];
  const switchable = data?.switchable ?? false;

  async function handleAdd() {
    setStatus(null);
    try {
      await add.mutateAsync({ name, ...(folder.trim() ? { folder: folder.trim() } : {}) });
      setName('');
      setFolder('');
      setStatus({ ok: true, text: 'Workspace added. Switch to it when you are ready.' });
    } catch (e) {
      setStatus({ ok: false, text: workspaceError(e, 'Could not add the workspace') });
    }
  }

  async function handleBrowse() {
    const picked = await window.electronAPI?.selectFolder?.();
    if (picked) setFolder(picked);
  }

  async function handleSwitch(item: WorkspaceItem) {
    setStatus(null);
    try {
      await open.mutateAsync(item.id);
      reloadAfterSwitch();
    } catch (e) {
      setStatus({ ok: false, text: workspaceError(e, 'Could not switch the workspace') });
    }
  }

  async function handleRename() {
    if (!editing) return;
    setStatus(null);
    try {
      await rename.mutateAsync(editing);
      setEditing(null);
    } catch (e) {
      setStatus({ ok: false, text: workspaceError(e, 'Could not rename the workspace') });
    }
  }

  async function handleRemove(id: string) {
    setStatus(null);
    setRemoving(null);
    try {
      await remove.mutateAsync(id);
    } catch (e) {
      setStatus({ ok: false, text: workspaceError(e, 'Could not remove the workspace') });
    }
  }

  return (
    <SettingsCard
      title="Workspaces"
      hint="Keep several boards on this computer, each in its own folder, and switch between them in one click. No export or import."
      setting="workspaces"
      status={status}
      testId="workspaces-card"
    >
      {isLoading && <span className={styles.statusInfo}>Loading…</span>}
      {data && !switchable && (
        <div className={`${styles.notice} ${styles.noticeWarn}`} role="status">
          <SIcon d={ICONS.alert} size={15} stroke="#B4791E" />
          <span>{data.reason}</span>
        </div>
      )}
      <ul className={styles.workspaceList} aria-label="Workspaces">
        {items.map((item) => (
          <li key={item.id} className={styles.workspaceRow} data-active={item.active ? 'true' : undefined}>
            <div className={styles.workspaceText}>
              {editing?.id === item.id ? (
                <input
                  className={styles.input}
                  aria-label="Workspace name"
                  value={editing.name}
                  maxLength={60}
                  autoFocus
                  onChange={(e) => setEditing({ id: item.id, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleRename();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                <b>
                  {item.name}
                  {item.active && <span className={styles.workspaceChip}>In use</span>}
                </b>
              )}
              <span className={`${styles.hint} ${styles.mono}`}>{item.folder}</span>
              {!item.hasBoard && !item.active && <span className={styles.hint}>Empty: a new board starts here.</span>}
            </div>
            <div className={styles.row}>
              {editing?.id === item.id ? (
                <>
                  <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleRename}>
                    Save
                  </button>
                  <button type="button" className={styles.btn} onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </>
              ) : removing === item.id ? (
                <>
                  <span className={styles.hint}>Forget it? The folder and its data stay on disk.</span>
                  <button type="button" className={styles.btn} onClick={() => setRemoving(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnDanger}`}
                    onClick={() => handleRemove(item.id)}
                  >
                    Remove
                  </button>
                </>
              ) : (
                <>
                  {!item.active && (
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      disabled={!switchable || open.isPending}
                      onClick={() => handleSwitch(item)}
                    >
                      {open.isPending && open.variables === item.id ? 'Switching…' : 'Switch'}
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => setEditing({ id: item.id, name: item.name })}
                  >
                    Rename
                  </button>
                  {!item.active && (
                    <button type="button" className={styles.btn} onClick={() => setRemoving(item.id)}>
                      Remove
                    </button>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      <Field label="New workspace" htmlFor="workspace-name-input">
        <input
          id="workspace-name-input"
          className={styles.input}
          type="text"
          placeholder="Name, for example Office"
          maxLength={60}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setStatus(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) void handleAdd();
          }}
        />
      </Field>
      <Field
        label="Folder (optional)"
        htmlFor="workspace-folder-input"
        hint="Leave empty for a new folder next to the settings file. A folder that already holds a board is added as it is."
      >
        <input
          id="workspace-folder-input"
          className={`${styles.input} ${styles.mono}`}
          type="text"
          aria-label="Workspace folder"
          placeholder="/Users/you/boards/home"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        />
      </Field>
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
          disabled={!name.trim() || add.isPending}
          onClick={handleAdd}
        >
          {add.isPending ? 'Adding…' : 'Add workspace'}
        </button>
      </div>
      <div className={styles.hint}>
        Claude Code and VS Code follow the switch by themselves within a few seconds. AI runs must be finished first.
      </div>
    </SettingsCard>
  );
}
