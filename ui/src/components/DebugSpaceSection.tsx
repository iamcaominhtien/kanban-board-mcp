import { useState, useRef, useEffect, useMemo } from 'react';
import type { WorkLogEntry, DebugEntryKind, DebugAttachment } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { uploadAttachment, uploadUrl } from '../api/tickets';
import { extractError } from '../api/extractError';
import styles from './DebugSpaceSection.module.css';

export interface DebugTestCaseOption {
  code: string;
  title: string;
}

interface DebugSpaceSectionProps {
  ticketId?: string;
  entries: WorkLogEntry[];
  /** Real branches / test cases of this ticket, offered as link targets. */
  branchNames?: string[];
  testCases?: DebugTestCaseOption[];
  /** Project members, suggested when typing the author name. */
  memberNames?: string[];
  onAdd: (entry: Omit<WorkLogEntry, 'id'>) => Promise<void> | void;
  onUpdate?: (entryId: string, data: Partial<WorkLogEntry>) => Promise<void> | void;
  onDelete?: (entryId: string) => Promise<void> | void;
  onOpenBranch?: (name: string) => void;
  onOpenTestCase?: (code: string) => void;
  readOnly?: boolean;
  disabled?: boolean;
}

const KINDS: DebugEntryKind[] = [
  'investigation',
  'fix_attempt',
  'root_cause',
  'blocked',
  'resolved',
];

const KIND_CONFIG: Record<
  DebugEntryKind,
  { label: string; dot: string; color: string; bg: string }
> = {
  investigation: {
    label: 'Investigation',
    dot: '#2F6FB0',
    color: '#2F6FB0',
    bg: 'rgba(47,111,176,0.12)',
  },
  fix_attempt: {
    label: 'Fix attempt',
    dot: '#E2793D',
    color: '#B4571F',
    bg: 'rgba(226,121,61,0.14)',
  },
  root_cause: {
    label: 'Root cause',
    dot: '#6D5DD3',
    color: '#6D5DD3',
    bg: 'rgba(109,93,211,0.12)',
  },
  blocked: {
    label: 'Blocked',
    dot: '#C4432A',
    color: '#C4432A',
    bg: 'rgba(196,67,42,0.12)',
  },
  resolved: {
    label: 'Resolved',
    dot: '#2E6F40',
    color: '#2E6F40',
    bg: 'rgba(46,111,64,0.12)',
  },
};

const ROLES = ['Developer', 'Tester', 'BA', 'PM', 'Designer', 'Other'];

const ROLE_CONFIG: Record<string, { bg: string; color: string }> = {
  Developer: { bg: '#DBEAFE', color: '#2563EB' },
  Tester: { bg: '#D1FAE5', color: '#059669' },
  BA: { bg: '#FEF3C7', color: '#D97706' },
  PM: { bg: '#EDE9FE', color: '#7C3AED' },
  Designer: { bg: '#FCE7F3', color: '#DB2777' },
  Other: { bg: '#F3F4F6', color: '#6B7280' },
};

function formatTimeAgo(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

function getInitials(name?: string | null): string {
  if (!name || !name.trim()) return 'DL';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}


const AUTHOR_KEY = 'kanban_debug_author';
const ROLE_KEY = 'kanban_debug_role';

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage may be unavailable (private mode); the form still works
  }
}

/** Entries written by older versions or other clients may carry an unknown kind. */
function kindOf(kind: string | undefined | null): DebugEntryKind {
  return KINDS.includes(kind as DebugEntryKind) ? (kind as DebugEntryKind) : 'investigation';
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatFull(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function wasEdited(entry: WorkLogEntry): boolean {
  if (!entry.updatedAt || !entry.at) return false;
  return new Date(entry.updatedAt).getTime() - new Date(entry.at).getTime() > 1000;
}

interface EntryFormValues {
  kind: DebugEntryKind;
  author: string;
  role: string;
  note: string;
  linkedBranch: string;
  linkedTestCase: string;
  attachments: DebugAttachment[];
}

interface EntryFormProps {
  mode: 'add' | 'edit';
  initial: EntryFormValues;
  branchNames: string[];
  testCases: DebugTestCaseOption[];
  memberNames: string[];
  onSubmit: (values: EntryFormValues) => Promise<void>;
  onCancel: () => void;
}

function EntryForm({ mode, initial, branchNames, testCases, memberNames, onSubmit, onCancel }: EntryFormProps) {
  const [v, setV] = useState<EntryFormValues>(initial);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof EntryFormValues>(key: K, value: EntryFormValues[K]) =>
    setV((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    noteRef.current?.focus();
  }, []);

  // A link whose target was deleted since is still shown, flagged, so it can be cleared
  const missingBranch = v.linkedBranch && !branchNames.includes(v.linkedBranch) ? v.linkedBranch : null;
  const missingTc = v.linkedTestCase && !testCases.some((t) => t.code === v.linkedTestCase) ? v.linkedTestCase : null;

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      const uploaded: DebugAttachment[] = [];
      for (const file of Array.from(files)) uploaded.push(await uploadAttachment(file));
      setV((prev) => ({ ...prev, attachments: [...prev.attachments, ...uploaded] }));
    } catch (err) {
      setError(extractError(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!v.note.trim() || (mode === 'add' && !v.author.trim())) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(v);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.inlineForm} onSubmit={submit} data-testid={`debug-form-${mode}`}>
      <div className={styles.kindPicker}>
        {KINDS.map((k) => {
          const cfg = KIND_CONFIG[k];
          const isSelected = v.kind === k;
          return (
            <button
              key={k}
              type="button"
              className={`${styles.kindOption} ${isSelected ? styles.kindOptionSelected : ''}`}
              style={{
                background: isSelected ? cfg.bg : '#F6FAF7',
                color: isSelected ? cfg.color : '#9AA8A0',
                borderColor: isSelected ? cfg.color : '#E3E8E5',
              }}
              onClick={() => set('kind', k)}
            >
              {cfg.label}
            </button>
          );
        })}
      </div>

      {mode === 'add' && (
        <div className={styles.authorRow}>
          <input
            className={styles.authorInput}
            value={v.author}
            onChange={(e) => set('author', e.target.value)}
            placeholder="Your name…"
            aria-label="Author"
            list="debug-author-options"
            required
          />
          <datalist id="debug-author-options">
            {memberNames.map((n) => <option key={n} value={n} />)}
          </datalist>
          <select className={styles.roleSelect} aria-label="Role" value={v.role} onChange={(e) => set('role', e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      )}

      <div className={styles.noteInputBox}>
        <textarea
          ref={noteRef}
          className={styles.noteTextarea}
          value={v.note}
          onChange={(e) => set('note', e.target.value)}
          placeholder="Write what you found, tried, or ran into… (Markdown supported)"
          aria-label="Note"
          required
        />
      </div>

      <div className={styles.extraLinksRow}>
        <select className={styles.smallInput} aria-label="Linked branch" value={v.linkedBranch} onChange={(e) => set('linkedBranch', e.target.value)}>
          <option value="">{branchNames.length ? 'Link a branch…' : 'No branches on this ticket'}</option>
          {missingBranch && <option value={missingBranch}>{missingBranch} (no longer exists)</option>}
          {branchNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <select className={styles.smallInput} aria-label="Linked test case" value={v.linkedTestCase} onChange={(e) => set('linkedTestCase', e.target.value)}>
          <option value="">{testCases.length ? 'Link a test case…' : 'No test cases on this ticket'}</option>
          {missingTc && <option value={missingTc}>{missingTc} (no longer exists)</option>}
          {testCases.map((t) => <option key={t.code} value={t.code}>{t.code} · {t.title}</option>)}
        </select>
        <button type="button" className={styles.attachBtn} onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? 'Uploading…' : '+ Attach file'}
        </button>
        <input ref={fileRef} type="file" multiple hidden data-testid="debug-attach-input" onChange={(e) => handleFiles(e.target.files)} />
      </div>

      {v.attachments.length > 0 && (
        <div className={styles.chipsRow}>
          {v.attachments.map((att) => (
            <span key={att.id} className={styles.tcFileChip}>
              <span className={styles.attName}>{att.name}</span>
              <span className={styles.attSize}>{formatBytes(att.size)}</span>
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={`Remove ${att.name}`}
                onClick={() => set('attachments', v.attachments.filter((a) => a.id !== att.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <div className={styles.formError} role="alert">{error}</div>}

      <div className={styles.formActions}>
        <button type="button" className={styles.btnCancel} onClick={onCancel}>Cancel</button>
        <button
          type="submit"
          className={styles.btnSubmit}
          disabled={busy || uploading || !v.note.trim() || (mode === 'add' && !v.author.trim())}
        >
          {busy ? 'Saving…' : mode === 'add' ? 'Log entry' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

export function DebugSpaceSection({
  ticketId = 'KAN',
  entries,
  branchNames = [],
  testCases = [],
  memberNames = [],
  onAdd,
  onUpdate,
  onDelete,
  onOpenBranch,
  onOpenTestCase,
  readOnly = false,
  disabled = false,
}: DebugSpaceSectionProps) {
  const [activeFilter, setActiveFilter] = useState<'all' | DebugEntryKind>('all');
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<WorkLogEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const counts: Record<DebugEntryKind, number> = { investigation: 0, fix_attempt: 0, root_cause: 0, blocked: 0, resolved: 0 };
  entries.forEach((e) => { counts[kindOf(e.kind)]++; });

  const pinnedEntries = entries.filter((e) => e.pinned);

  const filteredEntries = useMemo(
    () =>
      [...entries]
        .filter((e) => activeFilter === 'all' || kindOf(e.kind) === activeFilter)
        .sort((a, b) => {
          const timeB = b.at ?? (b as any).date ?? (b as any).createdAt ?? '';
          const timeA = a.at ?? (a as any).date ?? (a as any).createdAt ?? '';
          return String(timeB).localeCompare(String(timeA));
        }),
    [entries, activeFilter],
  );

  async function handleAdd(v: EntryFormValues) {
    await onAdd({
      author: v.author.trim(),
      role: v.role,
      kind: v.kind,
      note: v.note.trim(),
      linkedBranch: v.linkedBranch || null,
      linkedTestCase: v.linkedTestCase || null,
      attachments: v.attachments,
      at: new Date().toISOString(),
      pinned: false,
    });
    writeStored(AUTHOR_KEY, v.author.trim());
    writeStored(ROLE_KEY, v.role);
    setShowAddForm(false);
  }

  async function handleEdit(entry: WorkLogEntry, v: EntryFormValues) {
    if (!onUpdate) return;
    await onUpdate(entry.id, {
      kind: v.kind,
      note: v.note.trim(),
      // "" clears a link (omitting it would leave it unchanged)
      linkedBranch: v.linkedBranch,
      linkedTestCase: v.linkedTestCase,
      attachments: v.attachments,
    });
    setEditingId(null);
  }

  function togglePin(entry: WorkLogEntry) {
    if (!onUpdate) return;
    void onUpdate(entry.id, { pinned: !entry.pinned });
  }

  async function confirmDeleteEntry() {
    if (!confirmDelete || !onDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(confirmDelete.id);
      setConfirmDelete(null);
    } catch (err) {
      setDeleteError(extractError(err));
    } finally {
      setDeleting(false);
    }
  }

  const initialAdd: EntryFormValues = {
    kind: 'investigation',
    author: readStored(AUTHOR_KEY),
    role: ROLES.includes(readStored(ROLE_KEY)) ? readStored(ROLE_KEY) : 'Developer',
    note: '',
    linkedBranch: '',
    linkedTestCase: '',
    attachments: [],
  };

  const branchSet = new Set(branchNames);
  const tcSet = new Set(testCases.map((t) => t.code));

  return (
    <div className={styles.container}>
      <div className={styles.topBar}>
        <span className={styles.tcLabel}>
          {entries.length} ENTRIES · {ticketId}
        </span>
        {!readOnly && (
          <button type="button" className={styles.tcAddBtn} onClick={() => setShowAddForm(true)} disabled={disabled || showAddForm}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M12 5V19" /><path d="M5 12H19" />
            </svg>
            Log entry
          </button>
        )}
      </div>

      <div className={styles.filterRow}>
        <button type="button" className={`${styles.filterChip} ${activeFilter === 'all' ? styles.filterChipActive : ''}`} onClick={() => setActiveFilter('all')}>
          All ({entries.length})
        </button>
        {KINDS.map((kind) => {
          const cfg = KIND_CONFIG[kind];
          return (
            <button key={kind} type="button" className={`${styles.filterChip} ${activeFilter === kind ? styles.filterChipActive : ''}`} onClick={() => setActiveFilter(kind)}>
              <span className={styles.filterDot} style={{ background: cfg.dot }} />
              {cfg.label} ({counts[kind]})
            </button>
          );
        })}
      </div>

      {pinnedEntries.length > 0 && (
        <div className={styles.pinnedSection}>
          <span className={styles.fieldLabel}>Pinned</span>
          {pinnedEntries.map((pe) => {
            const cfg = KIND_CONFIG[kindOf(pe.kind)];
            return (
              <div key={pe.id} className={styles.dbgPinRow}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="#C7A339" style={{ flexShrink: 0 }}>
                  <path d="M12 2L14.4 8.6L21.5 9.2L16 13.8L17.8 20.8L12 16.8L6.2 20.8L8 13.8L2.5 9.2L9.6 8.6Z" />
                </svg>
                <span className={styles.dbgKindBadge} style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                <span className={styles.pinText}>{pe.note.replace(/[#*`\n]/g, ' ')}</span>
                <span className={styles.pinMeta}>{pe.author} · {formatTimeAgo(pe.at)}</span>
              </div>
            );
          })}
        </div>
      )}

      {showAddForm && (
        <EntryForm
          mode="add"
          initial={initialAdd}
          branchNames={branchNames}
          testCases={testCases}
          memberNames={memberNames}
          onSubmit={handleAdd}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      <div className={styles.timeline}>
        {filteredEntries.length === 0 ? (
          <div className={styles.emptyMsg}>
            {entries.length === 0
              ? 'No debug entries yet. Log what you found, tried or got blocked on. AI agents can log here too.'
              : 'No entries in this view.'}
          </div>
        ) : (
          filteredEntries.map((entry, idx) => {
            const kind = kindOf(entry.kind);
            const cfg = KIND_CONFIG[kind];
            const roleCfg = ROLE_CONFIG[entry.role] || ROLE_CONFIG.Other;
            const isLast = idx === filteredEntries.length - 1;
            const isEditing = editingId === entry.id;
            const attachments = entry.attachments ?? [];

            return (
              <div key={entry.id} className={styles.dbgItem} data-testid="debug-entry">
                <div className={styles.dbgRail}>
                  <span className={styles.dbgDot} style={{ background: cfg.dot }} />
                  {!isLast && <span className={styles.dbgLine} />}
                </div>

                <div className={styles.dbgCard}>
                  <div className={styles.cardHeader}>
                    <span className={styles.dbgKindBadge} style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                    <div className={styles.dbgAvatar} style={{ background: roleCfg.bg, color: roleCfg.color }}>
                      {getInitials(entry.author || (entry as any).author_name)}
                    </div>
                    <span className={styles.authorName}>{entry.author || (entry as any).author_name || 'Developer'}</span>
                    <span className={styles.dbgRoleBadge} style={{ background: roleCfg.bg, color: roleCfg.color }}>{entry.role}</span>
                    <span style={{ flexGrow: 1 }} />
                    <span className={styles.timestamp} title={formatFull(entry.at)}>
                      {formatTimeAgo(entry.at)}
                      {wasEdited(entry) && (
                        <span className={styles.editedTag} title={`Edited ${formatFull(entry.updatedAt)}`}> · edited</span>
                      )}
                    </span>

                    {!readOnly && (
                      <button
                        type="button"
                        className={`${styles.dbgPinBtn} ${entry.pinned ? styles.dbgPinBtnPinned : ''}`}
                        onClick={() => togglePin(entry)}
                        title={entry.pinned ? 'Unpin entry' : 'Pin entry'}
                        aria-label={entry.pinned ? 'Unpin entry' : 'Pin entry'}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill={entry.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2L14.4 8.6L21.5 9.2L16 13.8L17.8 20.8L12 16.8L6.2 20.8L8 13.8L2.5 9.2L9.6 8.6Z" />
                        </svg>
                      </button>
                    )}

                    {!readOnly && onUpdate && (
                      <button type="button" className={styles.editBtn} onClick={() => setEditingId(isEditing ? null : entry.id)} title="Edit entry" aria-label="Edit entry">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 20H21" /><path d="M16.5 3.5A2.1 2.1 0 0 1 19.5 6.5L7 19L3 20L4 16Z" />
                        </svg>
                      </button>
                    )}

                    {!readOnly && onDelete && (
                      <button type="button" className={styles.deleteBtn} onClick={() => { setDeleteError(null); setConfirmDelete(entry); }} title="Delete entry" aria-label="Delete entry">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M18 6L6 18" /><path d="M6 6L18 18" />
                        </svg>
                      </button>
                    )}
                  </div>

                  {isEditing ? (
                    <EntryForm
                      mode="edit"
                      initial={{
                        kind,
                        author: entry.author,
                        role: entry.role,
                        note: entry.note,
                        linkedBranch: entry.linkedBranch ?? '',
                        linkedTestCase: entry.linkedTestCase ?? '',
                        attachments,
                      }}
                      branchNames={branchNames}
                      testCases={testCases}
                      memberNames={memberNames}
                      onSubmit={(v) => handleEdit(entry, v)}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <>
                      <div className={styles.tcMd}>
                        <MarkdownRenderer>{entry.note}</MarkdownRenderer>
                      </div>

                      {(entry.linkedBranch || entry.linkedTestCase || attachments.length > 0) && (
                        <div className={styles.chipsRow}>
                          {entry.linkedBranch && (
                            branchSet.has(entry.linkedBranch) && onOpenBranch ? (
                              <button type="button" className={`${styles.dbgLinkChip} ${styles.linkChipBtn}`} onClick={() => onOpenBranch(entry.linkedBranch!)} title="Open the Branches tab">
                                <BranchIcon />{entry.linkedBranch}
                              </button>
                            ) : (
                              <span className={`${styles.dbgLinkChip} ${branchSet.has(entry.linkedBranch) ? '' : styles.linkChipMissing}`} title={branchSet.has(entry.linkedBranch) ? undefined : 'This branch no longer exists on the ticket'}>
                                <BranchIcon />{entry.linkedBranch}
                              </span>
                            )
                          )}
                          {entry.linkedTestCase && (
                            tcSet.has(entry.linkedTestCase) && onOpenTestCase ? (
                              <button type="button" className={`${styles.dbgLinkChip} ${styles.linkChipBtn}`} onClick={() => onOpenTestCase(entry.linkedTestCase!)} title="Open the Test cases tab">
                                <TestIcon />{entry.linkedTestCase}
                              </button>
                            ) : (
                              <span className={`${styles.dbgLinkChip} ${tcSet.has(entry.linkedTestCase) ? '' : styles.linkChipMissing}`} title={tcSet.has(entry.linkedTestCase) ? undefined : 'This test case no longer exists on the ticket'}>
                                <TestIcon />{entry.linkedTestCase}
                              </span>
                            )
                          )}
                          {attachments.map((att: DebugAttachment) => {
                            const href = uploadUrl(att.url);
                            const inner = (
                              <>
                                <span className={styles.tcFileIcon} style={{ background: '#F1F1F1' }}>
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#5B6B60" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M14 3H7C5.9 3 5 3.9 5 5V19C5 20.1 5.9 21 7 21H17C18.1 21 19 20.1 19 19V8L14 3Z" /><path d="M14 3V8H19" />
                                  </svg>
                                </span>
                                <span className={styles.attName}>{att.name}</span>
                                <span className={styles.attSize}>{formatBytes(att.size)}</span>
                              </>
                            );
                            return href ? (
                              <a key={att.id} className={`${styles.tcFileChip} ${styles.attLink}`} href={href} download={att.name} title={`Download ${att.name}`}>
                                {inner}
                              </a>
                            ) : (
                              <span key={att.id} className={styles.tcFileChip}>{inner}</span>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {confirmDelete && (
        <div className={styles.overlay} role="presentation">
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Confirm delete">
            <div className={styles.dialogTitle}>Delete this entry?</div>
            <div className={styles.dialogBody}>
              <span className={styles.dialogQuote}>{confirmDelete.note.slice(0, 140)}{confirmDelete.note.length > 140 ? '…' : ''}</span>
              {' '}will be removed permanently{(confirmDelete.attachments?.length ?? 0) > 0 ? ' (its attachment links go with it)' : ''}.
            </div>
            {deleteError && <div className={styles.formError} role="alert">{deleteError}</div>}
            <div className={styles.dialogActions}>
              <button type="button" className={styles.btnCancel} onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button type="button" className={styles.btnDanger} onClick={confirmDeleteEntry} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BranchIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#5B6B60" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3V21" /><path d="M18 3V21" /><circle cx="6" cy="6" r="2.6" /><circle cx="18" cy="6" r="2.6" /><circle cx="6" cy="18" r="2.6" /><path d="M6 8.6C6 14 10 16.5 15.4 17.3" />
    </svg>
  );
}

function TestIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#5B6B60" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11L12 14L22 4" /><path d="M21 12V19A2 2 0 0 1 19 21H5A2 2 0 0 1 3 19V5A2 2 0 0 1 5 3H16" />
    </svg>
  );
}
