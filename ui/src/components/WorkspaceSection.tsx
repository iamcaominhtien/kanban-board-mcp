import { useMemo, useRef, useState } from 'react';
import {
  createWorkspaceFolder,
  deleteWorkspaceEntry,
  initTicketWorkspace,
  openTicketWorkspace,
  uploadWorkspaceFile,
  useSetTicketWorkspaceRetention,
  useTicketWorkspace,
  useWorkspaceAction,
  useWorkspacePreview,
  workspaceFileUrl,
} from '../api/tickets';
import { extractError } from '../api/extractError';
import type { WorkspaceFile } from '../types/ticket';
import {
  baseName,
  depthOf,
  formatBytes,
  formatTimeAgo,
  formatTimeLeft,
  previewKind,
  visibleEntries,
} from '../utils/workspaceTree';
import styles from './WorkspaceSection.module.css';

interface WorkspaceSectionProps {
  ticketId: string;
  readOnly?: boolean;
}

function Icon({ d, color = 'currentColor', size = 13 }: { d: string | string[]; color?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {(Array.isArray(d) ? d : [d]).map((p) => (
        <path key={p} d={p} />
      ))}
    </svg>
  );
}

const FOLDER =
  'M3 7C3 5.9 3.9 5 5 5H9.2L11.2 7.5H19C20.1 7.5 21 8.4 21 9.5V17C21 18.1 20.1 19 19 19H5C3.9 19 3 18.1 3 17V7Z';
const FILE = ['M14 3H7C5.9 3 5 3.9 5 5V19C5 20.1 5.9 21 7 21H17C18.1 21 19 20.1 19 19V8L14 3Z', 'M14 3V8H19'];
const EYE = [
  'M2 12C4.5 7.5 8 5.5 12 5.5S19.5 7.5 22 12C19.5 16.5 16 18.5 12 18.5S4.5 16.5 2 12Z',
  'M12 14.5A2.5 2.5 0 1 0 12 9.5A2.5 2.5 0 0 0 12 14.5Z',
];
const DOWNLOAD = ['M12 4V15', 'M7 11L12 16L17 11', 'M5 20H19'];
const TRASH = ['M4 7H20', 'M10 11V17', 'M14 11V17', 'M6 7L7 19H17L18 7', 'M9 7V4H15V7'];
const CHEVRON = 'M9 6L15 12L9 18';
const REFRESH = ['M4 4V10H10', 'M4 10L8 6.5A8 8 0 1 1 4 14'];
const UPLOAD = ['M12 16V5', 'M7 9L12 4L17 9', 'M5 20H19'];
const FOLDER_PLUS = [FOLDER, 'M12 10V16', 'M9 13H15'];

function FileIcon({ entry }: { entry: WorkspaceFile }) {
  if (entry.isDir) {
    return (
      <span className={styles.tcFileIcon} style={{ background: '#F1F3F1' }}>
        <Icon d={FOLDER} color="#5B6B60" size={14} />
      </span>
    );
  }
  if (previewKind(entry.name) === 'image' && /\.(png|jpe?g|gif|webp)$/i.test(entry.name)) {
    return (
      <span className={styles.tcFileIcon} style={{ background: '#FBE9E1' }}>
        <Icon d={['M3 5H21V19H3Z', 'M21 15L16 10L5 19']} color="#B4571F" size={14} />
      </span>
    );
  }
  return (
    <span className={styles.tcFileIcon} style={{ background: '#E1EEFB' }}>
      <Icon d={FILE} color="#2F6FB0" size={14} />
    </span>
  );
}

/** Ticket's workspace folder: browse, upload, preview and delete files. */
export function WorkspaceSection({ ticketId, readOnly = false }: WorkspaceSectionProps) {
  const { data: ws, isLoading, refetch, isFetching } = useTicketWorkspace(ticketId);
  const setRetention = useSetTicketWorkspaceRetention();
  const initMut = useWorkspaceAction<void>(ticketId, () => initTicketWorkspace(ticketId));
  const folderMut = useWorkspaceAction<string>(ticketId, (p) => createWorkspaceFolder(ticketId, p));
  const uploadMut = useWorkspaceAction<{ file: File; dir: string }>(ticketId, ({ file, dir }) =>
    uploadWorkspaceFile(ticketId, file, dir),
  );
  const deleteMut = useWorkspaceAction<string>(ticketId, (p) => deleteWorkspaceEntry(ticketId, p));

  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedDir, setSelectedDir] = useState('');
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<WorkspaceFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const files = useMemo(() => ws?.files ?? [], [ws?.files]);
  const rows = useMemo(() => visibleEntries(files, collapsed), [files, collapsed]);
  const previewEntry = previewPath ? files.find((f) => f.name === previewPath && !f.isDir) : undefined;
  const displayPath = ws?.path || `~/kanban-workspace/${ticketId}`;

  function fail(err: unknown) {
    setNotice({ kind: 'error', text: extractError(err) });
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(displayPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice({ kind: 'error', text: 'Could not copy to the clipboard' });
    }
  }

  async function openFolder() {
    try {
      await openTicketWorkspace(ticketId);
      setNotice(null);
    } catch (err) {
      await copyPath();
      setNotice({ kind: 'info', text: `${extractError(err)} — path copied instead.` });
    }
  }

  function uploadFiles(list: FileList | File[]) {
    setNotice(null);
    for (const file of Array.from(list)) {
      uploadMut.mutate({ file, dir: selectedDir }, { onError: fail });
    }
  }

  function toggleDir(name: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function submitFolder() {
    const name = newFolderName.trim().replace(/^\/+|\/+$/g, '');
    if (!name) return;
    folderMut.mutate(selectedDir ? `${selectedDir}/${name}` : name, {
      onSuccess: () => {
        setNewFolderOpen(false);
        setNewFolderName('');
        setNotice(null);
      },
      onError: fail,
    });
  }

  if (isLoading) return <div className={styles.emptyState}>Loading workspace...</div>;

  const override = ws?.retentionOverride ?? null;
  const days = ws?.retentionDays ?? 0;

  let retentionChip: { text: string; forever: boolean };
  if (!days) retentionChip = { text: 'Kept forever', forever: true };
  else if (!ws?.sweepEligible) retentionChip = { text: `Auto-delete ${days}d after Done / Won't do`, forever: false };
  else if (ws?.expiresAt) retentionChip = { text: `Auto-delete ${formatTimeLeft(ws.expiresAt)}`, forever: false };
  else retentionChip = { text: `Auto-delete after ${days} days idle`, forever: false };

  return (
    <div
      className={`${styles.container} ${dragging ? styles.dropActive : ''}`}
      onDragOver={(e) => {
        if (readOnly || !ws?.exists || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (readOnly || !ws?.exists) return;
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
      }}
    >
      <div className={styles.topBar}>
        <div className={styles.wsPathBar}>
          <Icon d={FOLDER} color="#9AA8A0" size={12} />
          <span className={styles.pathText} title={displayPath}>
            {displayPath}
          </span>
          <button
            type="button"
            className={styles.copyBtn}
            onClick={copyPath}
            title={copied ? 'Copied!' : 'Copy path'}
            aria-label="Copy path"
          >
            {copied ? (
              <Icon d="M20 6L9 17L4 12" color="#2E6F40" size={10} />
            ) : (
              <Icon d={['M9 9H21V21H9Z', 'M5 15H4A2 2 0 0 1 2 13V4A2 2 0 0 1 4 2H13A2 2 0 0 1 15 4V5']} size={10} />
            )}
          </button>
        </div>
        <div className={styles.topActions}>
          <span
            className={`${styles.retentionChip} ${retentionChip.forever ? styles.retentionChipForever : ''}`}
            data-testid="retention-chip"
          >
            {retentionChip.text}
          </span>
          <button type="button" className={styles.actionBtn} onClick={openFolder} disabled={!ws?.exists && readOnly}>
            <Icon d={[FOLDER, 'M12 11V16', 'M9.5 13.5L12 11L14.5 13.5']} />
            Open folder
          </button>
        </div>
      </div>

      {notice && (
        <div className={`${styles.notice} ${notice.kind === 'error' ? styles.noticeError : ''}`} role="alert">
          {notice.text}
          <button type="button" className={styles.noticeClose} onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {!readOnly && (
        <div className={styles.retentionCard}>
          <div className={styles.retentionText}>
            <span className={styles.retentionTitle}>Retention Policy</span>
            <span className={styles.retentionHint}>
              Once the ticket is Done or Won&apos;t do, the folder is deleted after it has been idle this long. Open
              tickets are never cleaned.
            </span>
          </div>
          <select
            className={styles.retentionSelect}
            aria-label="Retention policy"
            value={override === null ? 'inherit' : String(override)}
            onChange={(e) =>
              setRetention.mutate(
                { ticketId, retentionDays: e.target.value === 'inherit' ? null : parseInt(e.target.value, 10) },
                { onError: fail },
              )
            }
          >
            <option value="inherit">Inherit workspace default</option>
            <option value="7">Auto-delete after 7 days</option>
            <option value="14">Auto-delete after 14 days</option>
            <option value="30">Auto-delete after 30 days</option>
            <option value="0">Keep forever (never delete)</option>
          </select>
        </div>
      )}

      {!ws?.exists ? (
        <div className={styles.tableContainer}>
          <div className={styles.emptyState}>
            <div>This ticket has no workspace folder yet.</div>
            <div className={styles.emptyHint}>
              AI agents can create it themselves through the MCP workspace path, or create it here.
            </div>
            {!readOnly && (
              <button
                type="button"
                className={`${styles.actionBtn} ${styles.primaryBtn}`}
                onClick={() => initMut.mutate(undefined, { onError: fail })}
                disabled={initMut.isPending}
              >
                <Icon d={FOLDER_PLUS} />
                Create folder
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className={styles.metaRow}>
            <span className={styles.tcLabel}>
              {ws.fileCount} {ws.fileCount === 1 ? 'FILE' : 'FILES'} · {formatBytes(ws.totalBytes)}
              {selectedDir && (
                <button
                  type="button"
                  className={styles.dirChip}
                  onClick={() => setSelectedDir('')}
                  title="Back to the folder root"
                >
                  in /{selectedDir} ×
                </button>
              )}
            </span>
            <div className={styles.topActions}>
              {!readOnly && (
                <>
                  <button type="button" className={styles.actionBtn} onClick={() => setNewFolderOpen((v) => !v)}>
                    <Icon d={FOLDER_PLUS} size={12} />
                    New folder
                  </button>
                  <button
                    type="button"
                    className={styles.actionBtn}
                    onClick={() => fileInput.current?.click()}
                    disabled={uploadMut.isPending}
                  >
                    <Icon d={UPLOAD} size={12} />
                    {uploadMut.isPending ? 'Uploading…' : 'Upload'}
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    hidden
                    data-testid="workspace-upload-input"
                    onChange={(e) => {
                      if (e.target.files) uploadFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </>
              )}
              <button type="button" className={styles.actionBtn} onClick={() => refetch()} disabled={isFetching}>
                <Icon d={REFRESH} size={11} />
                Refresh
              </button>
            </div>
          </div>

          {newFolderOpen && (
            <form
              className={styles.newFolderRow}
              onSubmit={(e) => {
                e.preventDefault();
                submitFolder();
              }}
            >
              <Icon d={FOLDER} color="#5B6B60" size={14} />
              <span className={styles.newFolderPrefix}>{selectedDir ? `${selectedDir}/` : ''}</span>
              <input
                className={styles.newFolderInput}
                autoFocus
                placeholder="folder name"
                aria-label="New folder name"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
              />
              <button
                type="submit"
                className={`${styles.actionBtn} ${styles.primaryBtn}`}
                disabled={!newFolderName.trim() || folderMut.isPending}
              >
                Create
              </button>
              <button
                type="button"
                className={styles.actionBtn}
                onClick={() => {
                  setNewFolderOpen(false);
                  setNewFolderName('');
                }}
              >
                Cancel
              </button>
            </form>
          )}

          <div className={styles.tableContainer}>
            {rows.length === 0 ? (
              <div className={styles.emptyState}>
                No files yet. Drop files here, use Upload, or let an agent write into <code>{displayPath}</code>.
              </div>
            ) : (
              rows.map((file) => (
                <div
                  key={file.name}
                  className={`${styles.wsRow} ${previewPath === file.name ? styles.wsRowActive : ''} ${file.isDir && selectedDir === file.name ? styles.wsRowSelected : ''}`}
                  style={{ paddingLeft: 14 + depthOf(file.name) * 18 }}
                  data-testid="workspace-row"
                  data-name={file.name}
                >
                  {file.isDir ? (
                    <>
                      <button
                        type="button"
                        className={styles.chevronBtn}
                        onClick={() => toggleDir(file.name)}
                        aria-label={`${collapsed.has(file.name) ? 'Expand' : 'Collapse'} ${file.name}`}
                        aria-expanded={!collapsed.has(file.name)}
                      >
                        <span className={`${styles.chevron} ${collapsed.has(file.name) ? '' : styles.chevronOpen}`}>
                          <Icon d={CHEVRON} size={11} />
                        </span>
                      </button>
                      <button
                        type="button"
                        className={styles.dirToggle}
                        onClick={() => setSelectedDir(selectedDir === file.name ? '' : file.name)}
                        aria-pressed={selectedDir === file.name}
                        title="Select as the target for Upload / New folder"
                      >
                        <FileIcon entry={file} />
                        <span className={styles.fileName} title={file.name}>
                          {baseName(file.name)}
                        </span>
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={styles.dirToggle}
                      onClick={() => setPreviewPath(previewPath === file.name ? null : file.name)}
                      aria-label={`Preview ${file.name}`}
                    >
                      <span className={styles.chevronSpacer} />
                      <FileIcon entry={file} />
                      <span className={styles.fileName} title={file.name}>
                        {baseName(file.name)}
                      </span>
                    </button>
                  )}
                  <span className={styles.fileSize}>{file.isDir ? '' : formatBytes(file.size)}</span>
                  <span className={styles.fileTime}>{formatTimeAgo(file.modifiedAt)}</span>
                  <span className={styles.rowActions}>
                    {!file.isDir && (
                      <>
                        <button
                          type="button"
                          className={styles.copyBtn}
                          onClick={() => setPreviewPath(previewPath === file.name ? null : file.name)}
                          title="Preview"
                          aria-label={`Preview ${file.name}`}
                        >
                          <Icon d={EYE} size={12} />
                        </button>
                        <a
                          className={styles.copyBtn}
                          href={workspaceFileUrl(ticketId, file.name, true)}
                          download={baseName(file.name)}
                          title="Download"
                          aria-label={`Download ${file.name}`}
                        >
                          <Icon d={DOWNLOAD} size={12} />
                        </a>
                      </>
                    )}
                    {!readOnly && (
                      <button
                        type="button"
                        className={`${styles.copyBtn} ${styles.dangerBtn}`}
                        onClick={() => setConfirmDelete(file)}
                        title="Delete"
                        aria-label={`Delete ${file.name}`}
                      >
                        <Icon d={TRASH} size={12} />
                      </button>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
          {ws.truncated && <div className={styles.retentionHint}>Showing the first 2000 entries only.</div>}

          {previewEntry && (
            <PreviewPanel ticketId={ticketId} entry={previewEntry} onClose={() => setPreviewPath(null)} />
          )}
        </>
      )}

      {dragging && <div className={styles.dropHint}>Drop to upload{selectedDir ? ` into /${selectedDir}` : ''}</div>}

      {confirmDelete && (
        <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Confirm delete">
          <div className={styles.dialog}>
            <div className={styles.dialogTitle}>Delete {confirmDelete.isDir ? 'folder' : 'file'}?</div>
            <div className={styles.dialogBody}>
              <code>{confirmDelete.name}</code>
              {confirmDelete.isDir && ' and everything inside it'} will be permanently removed from disk.
            </div>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.actionBtn} onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={`${styles.actionBtn} ${styles.dangerAction}`}
                onClick={() => {
                  const target = confirmDelete;
                  deleteMut.mutate(target.name, {
                    onSuccess: () => {
                      if (previewPath && (previewPath === target.name || previewPath.startsWith(`${target.name}/`)))
                        setPreviewPath(null);
                      if (selectedDir === target.name || selectedDir.startsWith(`${target.name}/`)) setSelectedDir('');
                    },
                    onError: fail,
                    onSettled: () => setConfirmDelete(null),
                  });
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewPanel({ ticketId, entry, onClose }: { ticketId: string; entry: WorkspaceFile; onClose: () => void }) {
  const kind = /\.(png|jpe?g|gif|webp)$/i.test(entry.name) ? 'image' : 'text';
  const { data, isLoading, error } = useWorkspacePreview(ticketId, entry.name, kind === 'text');
  return (
    <div className={styles.previewPanel} data-testid="workspace-preview">
      <div className={styles.previewHeader}>
        <span className={styles.previewName} title={entry.name}>
          {entry.name}
        </span>
        <span className={styles.fileSize}>{formatBytes(entry.size)}</span>
        <button type="button" className={styles.copyBtn} onClick={onClose} aria-label="Close preview">
          ×
        </button>
      </div>
      {kind === 'image' ? (
        <div className={styles.previewImageWrap}>
          <img className={styles.previewImage} src={workspaceFileUrl(ticketId, entry.name)} alt={entry.name} />
        </div>
      ) : isLoading ? (
        <div className={styles.emptyState}>Loading…</div>
      ) : error ? (
        <div className={styles.emptyState}>{extractError(error)}</div>
      ) : data?.binary ? (
        <div className={styles.emptyState}>Binary file — no preview. Use Download.</div>
      ) : (
        <>
          <pre className={styles.previewText}>{data?.text || '(empty file)'}</pre>
          {data?.truncated && (
            <div className={styles.retentionHint} style={{ padding: '6px 12px' }}>
              Preview truncated — download for the full file.
            </div>
          )}
        </>
      )}
    </div>
  );
}
