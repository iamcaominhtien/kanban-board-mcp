import { useEffect, useRef, useState } from 'react';
import type { Comment, IssueType, Priority, Status, Ticket, WorkLogEntry } from '../types';
import { ActivityLog } from './ActivityLog';
import { CommentsSection } from './CommentsSection';
import { MarkdownEditor } from './MarkdownEditor';
import { SubTasksSection } from './SubTasksSection';
import { WorkLogSection } from './WorkLogSection';
import styles from './TicketModal.module.css';

const ESTIMATE_OPTIONS = [null, 1, 2, 3, 5, 8, 13] as const;

const PRIORITY_COLORS: Record<Priority, { bg: string; color: string }> = {
  critical: { bg: '#DC2626', color: 'white' },
  high:     { bg: '#E8441A', color: 'white' },
  medium:   { bg: '#F5C518', color: 'var(--color-dark)' },
  low:      { bg: '#9CA3AF', color: 'var(--color-dark)' },
};

const TYPE_CONFIG: Record<IssueType, { label: string; icon: string; bg: string; color: string }> = {
  bug:     { label: 'Bug',     icon: '🐛', bg: '#FEE2E2', color: '#DC2626' },
  feature: { label: 'Feature', icon: '✨', bg: '#EDE9FE', color: '#7C3AED' },
  task:    { label: 'Task',    icon: '📋', bg: '#DBEAFE', color: '#2563EB' },
  chore:   { label: 'Chore',   icon: '🔧', bg: '#F3F4F6', color: '#6B7280' },
};

const STATUS_LABELS: Record<Status, string> = {
  backlog:     'Backlog',
  todo:        'To Do',
  'in-progress': 'In Progress',
  done:        'Done',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

type TicketModalProps =
  | { mode: 'create'; ticket?: undefined; onSave: (t: Ticket) => void; onDelete?: undefined; onClose: () => void }
  | { mode: 'view' | 'edit'; ticket: Ticket; onSave: (t: Ticket) => void; onDelete?: (id: string) => void; onClose: () => void };

export function TicketModal({ mode: initialMode, ticket, onSave, onDelete, onClose }: TicketModalProps) {
  const [localMode, setLocalMode] = useState<'create' | 'view' | 'edit'>(initialMode);
  const [title, setTitle] = useState(ticket?.title ?? '');
  const [description, setDescription] = useState(ticket?.description ?? '');
  const [status, setStatus] = useState<Status>(ticket?.status ?? 'backlog');
  const [priority, setPriority] = useState<Priority>(ticket?.priority ?? 'medium');
  const [tagsInput, setTagsInput] = useState(ticket?.tags.join(', ') ?? '');
  const [type, setType] = useState<IssueType>(ticket?.type ?? 'task');
  const [dueDate, setDueDate] = useState<string | null>(ticket?.dueDate ?? null);
  const [estimate, setEstimate] = useState<number | null>(ticket?.estimate ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [visible, setVisible] = useState(false);

  // Fix 1: keep onClose ref fresh to avoid stale closure in Escape handler
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Fix 3 & 4: focusable element refs
  const firstFocusRef = useRef<HTMLButtonElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  // Fix 3: focus first element on mount
  useEffect(() => {
    firstFocusRef.current?.focus();
  }, []);

  // Fix 1: Escape handler with stable ref — no stale closure
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setVisible(false);
        setTimeout(() => onCloseRef.current(), 200);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Fix 10: lock body scroll while modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  function handleClose() {
    setVisible(false);
    setTimeout(onClose, 200);
  }

  function handleSave() {
    if (!title.trim()) return;
    const now = new Date().toISOString();
    const tags = [...new Set(tagsInput.split(',').map((t) => t.trim()).filter(Boolean))];

    if (localMode === 'create') {
      onSave({
        id: '',
        title: title.trim(),
        description,
        type,
        status,
        priority,
        tags,
        dueDate: dueDate || null,
        createdAt: now,
        updatedAt: now,
        comments: [],
        subTasks: [],
        estimate,
        activityLog: [],
        workLog: [],
      });
    } else if (ticket) {
      onSave({ ...ticket, title: title.trim(), description, type, status, priority, tags, dueDate: dueDate || null, updatedAt: now, estimate });
    }
    handleClose();
  }

  function handleDelete() {
    if (ticket && onDelete) {
      onDelete(ticket.id);
      handleClose();
    }
  }

  // Fix 4: focus title input after switching to edit
  function handleSwitchToEdit() {
    setLocalMode('edit');
    setTimeout(() => titleInputRef.current?.focus(), 0);
  }

  function handleAddComment(text: string) {
    if (!ticket) return;
    const id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const newComment: Comment = {
      id,
      text,
      createdAt: new Date().toISOString(),
    };
    onSave({ ...ticket, comments: [...ticket.comments, newComment], updatedAt: new Date().toISOString() });
  }

  function handleDeleteComment(id: string) {
    if (!ticket) return;
    onSave({ ...ticket, comments: ticket.comments.filter((c) => c.id !== id), updatedAt: new Date().toISOString() });
  }

  function handleAddSubTask(text: string) {
    if (!ticket) return;
    const id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    onSave({ ...ticket, subTasks: [...ticket.subTasks, { id, text, completed: false }], updatedAt: new Date().toISOString() });
  }

  function handleToggleSubTask(id: string) {
    if (!ticket) return;
    onSave({ ...ticket, subTasks: ticket.subTasks.map((s) => s.id === id ? { ...s, completed: !s.completed } : s), updatedAt: new Date().toISOString() });
  }

  function handleDeleteSubTask(id: string) {
    if (!ticket) return;
    onSave({ ...ticket, subTasks: ticket.subTasks.filter((s) => s.id !== id), updatedAt: new Date().toISOString() });
  }

  function handleAddWorkLog(entry: Omit<WorkLogEntry, 'id'>) {
    if (!ticket) return;
    const id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const newEntry: WorkLogEntry = { id, ...entry };
    onSave({ ...ticket, workLog: [...(ticket.workLog ?? []), newEntry], updatedAt: new Date().toISOString() });
  }

  function handleCancelEdit() {
    setTitle(ticket?.title ?? '');
    setDescription(ticket?.description ?? '');
    setStatus(ticket?.status ?? 'backlog');
    setPriority(ticket?.priority ?? 'medium');
    setTagsInput(ticket?.tags.join(', ') ?? '');
    setType(ticket?.type ?? 'task');
    setDueDate(ticket?.dueDate ?? null);
    setEstimate(ticket?.estimate ?? null);
    setConfirmDelete(false);
    setLocalMode('view');
  }

  const tagChips = tagsInput
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  if (localMode === 'view' && ticket) {
    const pc = PRIORITY_COLORS[ticket.priority];
    return (
      <div
        className={`${styles.overlay} ${visible ? styles.overlayVisible : ''}`}
        onClick={handleClose}
      >
        <div
          className={`${styles.panel} ${visible ? styles.panelVisible : ''}`}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-heading"
        >
          <div className={styles.header}>
            <span id="modal-heading" className={styles.headerTitle}>{ticket.id}</span>
            <button type="button" aria-label="Close modal" className={styles.closeBtn} onClick={handleClose} ref={firstFocusRef}>
              ×
            </button>
          </div>

          <div className={styles.body}>
            <h2 className={styles.viewTitle}>{ticket.title}</h2>

            <div className={styles.twoColLayout}>
              {/* ── Left column: content ── */}
              <div className={styles.mainCol}>
                <MarkdownEditor
                  value={description}
                  onChange={setDescription}
                  readOnly={true}
                />

                <div className={styles.timestamps}>
                  <span>Created: {formatDate(ticket.createdAt)}</span>
                  <span>Updated: {formatDate(ticket.updatedAt)}</span>
                </div>

                <hr className={styles.divider} />

                <SubTasksSection
                  subTasks={ticket.subTasks ?? []}
                  onAdd={handleAddSubTask}
                  onToggle={handleToggleSubTask}
                  onDelete={handleDeleteSubTask}
                />

                <hr className={styles.divider} />

                <CommentsSection
                  comments={ticket.comments ?? []}
                  onAdd={handleAddComment}
                  onDelete={handleDeleteComment}
                />

                <hr className={styles.divider} />

                <ActivityLog entries={ticket.activityLog ?? []} />

                <hr className={styles.divider} />

                <WorkLogSection
                  entries={ticket.workLog ?? []}
                  onAdd={handleAddWorkLog}
                />
              </div>

              {/* ── Right sidebar: metadata ── */}
              <aside className={styles.sidebarCol}>
                <div className={styles.sidebarCard}>
                  <div className={styles.sidebarRow}>
                    <span className={styles.sidebarLabel}>Status</span>
                    <span className={styles.statusBadge}>{STATUS_LABELS[ticket.status]}</span>
                  </div>

                  <div className={styles.sidebarRow}>
                    <span className={styles.sidebarLabel}>Priority</span>
                    <span
                      className={styles.priorityBadge}
                      style={{ backgroundColor: pc.bg, color: pc.color }}
                    >
                      ● {ticket.priority}
                    </span>
                  </div>

                  <div className={styles.sidebarRow}>
                    <span className={styles.sidebarLabel}>Type</span>
                    <span
                      className={styles.typeBadge}
                      style={{ backgroundColor: TYPE_CONFIG[ticket.type].bg, color: TYPE_CONFIG[ticket.type].color }}
                    >
                      {TYPE_CONFIG[ticket.type].icon} {TYPE_CONFIG[ticket.type].label}
                    </span>
                  </div>

                  {ticket.estimate !== null && ticket.estimate !== undefined && (
                    <div className={styles.sidebarRow}>
                      <span className={styles.sidebarLabel}>Story Points</span>
                      <span className={styles.estimateBadge}>SP: {ticket.estimate}</span>
                    </div>
                  )}

                  {ticket.dueDate && (() => {
                    const due = new Date(ticket.dueDate);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const overdue = due < today;
                    const label = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    return (
                      <div className={styles.sidebarRow}>
                        <span className={styles.sidebarLabel}>Due Date</span>
                        <span className={overdue ? styles.dueDateOverdue : styles.dueDateBadge}>
                          {overdue ? '⚠️' : '📅'} {label}
                        </span>
                      </div>
                    );
                  })()}

                  {ticket.tags.length > 0 && (
                    <div className={styles.sidebarSection}>
                      <span className={styles.sidebarLabel}>Tags</span>
                      <div className={styles.tagChips}>
                        {ticket.tags.map((tag, i) => (
                          <span key={`${tag}-${i}`} className={styles.chip}>{tag}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </aside>
            </div>
          </div>

          <div className={styles.footer}>
            <div className={styles.deleteArea}>
              {confirmDelete ? (
                <>
                  <span className={styles.confirmText}>Are you sure?</span>
                  <button type="button" className={styles.confirmBtn} onClick={handleDelete}>
                    Confirm
                  </button>
                  <button type="button" className={styles.cancelBtn} onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                onDelete && (
                  <button type="button" className={styles.deleteOutlineBtn} onClick={() => setConfirmDelete(true)}>
                    Delete
                  </button>
                )
              )}
            </div>
            <button type="button" className={styles.saveBtn} onClick={handleSwitchToEdit}>
              Edit
            </button>
          </div>
          {/* Fix 3: focus trap sentinel */}
          <div tabIndex={0} onFocus={() => firstFocusRef.current?.focus()} aria-hidden="true" />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${styles.overlay} ${visible ? styles.overlayVisible : ''}`}
      onClick={handleClose}
    >
      <div
        className={`${styles.panel} ${visible ? styles.panelVisible : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-heading"
      >
        <div className={styles.header}>
          <span id="modal-heading" className={styles.headerTitle}>
            {localMode === 'create' ? 'New Ticket' : ticket?.id}
          </span>
          <button type="button" aria-label="Close modal" className={styles.closeBtn} onClick={handleClose} ref={firstFocusRef}>
            ×
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.field}>
            <label className={styles.label}>Title</label>
            <input
              ref={titleInputRef}
              className={styles.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ticket title..."
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Description</label>
            <MarkdownEditor
              value={description}
              onChange={setDescription}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Type</label>
            <select
              className={styles.select}
              value={type}
              onChange={(e) => setType(e.target.value as IssueType)}
            >
              <option value="bug">🐛 Bug</option>
              <option value="feature">✨ Feature</option>
              <option value="task">📋 Task</option>
              <option value="chore">🔧 Chore</option>
            </select>
          </div>

          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label}>Status</label>
              <select
                className={styles.select}
                value={status}
                onChange={(e) => setStatus(e.target.value as Status)}
              >
                <option value="backlog">Backlog</option>
                <option value="todo">To Do</option>
                <option value="in-progress">In Progress</option>
                <option value="done">Done</option>
              </select>
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Priority</label>
              <select
                className={styles.select}
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Due Date</label>
            <input
              type="date"
              className={styles.input}
              value={dueDate ?? ''}
              onChange={(e) => setDueDate(e.target.value || null)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Estimate</label>
            <div className={styles.estimateSelector}>
              {ESTIMATE_OPTIONS.map((opt) => (
                <button
                  key={opt === null ? 'none' : opt}
                  type="button"
                  className={estimate === opt ? styles.estimateOptionActive : styles.estimateOption}
                  onClick={() => setEstimate(opt)}
                >
                  {opt === null ? '—' : opt}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Tags</label>
            <input
              className={styles.input}
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="frontend, bug, phase-2..."
            />
            {tagsInput.trim() && (
              <div className={styles.tagChips}>
                {tagsInput.split(',').map((t) => t.trim() && <span key={t.trim()} className={styles.chip}>{t.trim()}</span>)}
              </div>
            )}
          </div>
        </div>

        <div className={styles.footer}>
          {localMode === 'edit' && onDelete && (
            <div className={styles.deleteArea}>
              {confirmDelete ? (
                <>
                  <span className={styles.confirmText}>Are you sure?</span>
                  <button type="button" className={styles.confirmBtn} onClick={handleDelete}>
                    Confirm
                  </button>
                  <button type="button" className={styles.cancelBtn} onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" className={styles.deleteBtn} onClick={() => setConfirmDelete(true)}>
                  Delete
                </button>
              )}
            </div>
          )}
          {localMode === 'edit' && (
            <button type="button" className={styles.cancelBtn} onClick={handleCancelEdit}>
              Cancel
            </button>
          )}
          <button type="button" className={styles.saveBtn} onClick={handleSave} disabled={!title.trim()}>
            Save
          </button>
        </div>
        {/* Fix 3: focus trap sentinel */}
        <div tabIndex={0} onFocus={() => firstFocusRef.current?.focus()} aria-hidden="true" />
      </div>
    </div>
  );
}
