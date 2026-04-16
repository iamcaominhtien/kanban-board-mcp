import { useEffect, useRef, useState } from 'react';
import type { IssueType, Member, Priority, Status, Ticket, WorkLogEntry } from '../types';
import {
  useUpdateTicket,
  useAddComment,
  useAddAcceptanceCriterion, useToggleAcceptanceCriterion, useDeleteAcceptanceCriterion,
  useAddWorkLog,
  useAddTestCase, useUpdateTestCase, useDeleteTestCase,
  uploadDescriptionImage,
  useLinkBlock, useUnlinkBlock,
} from '../api/tickets';
import { extractError } from '../api/extractError';
import { ActivityLog } from './ActivityLog';
import { CommentsSection } from './CommentsSection';
import { MarkdownEditor } from './MarkdownEditor';
import { AcceptanceCriteriaSection } from './AcceptanceCriteriaSection';
import { MemberAvatar } from './MemberAvatar';
import { RelationsSection } from './RelationsSection';
import { TestCasesSection } from './TestCasesSection';
import { WorkLogSection } from './WorkLogSection';
import { SubTicketsSection } from './SubTicketsSection';
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
  wont_do:     'Không làm',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

type CreateTicketData = {
  title: string;
  description: string;
  type: IssueType;
  priority: Priority;
  status: Status;
  tags: string[];
  dueDate: string | null;
  startDate: string | null;
  estimate: number | null;
  parentId: string | null;
  wontDoReason?: string | null;
  assignee: string | null;
  createdBy: string | null;
};

type TicketModalProps =
  | {
      mode: 'create';
      ticket?: undefined;
      onSave: (data: CreateTicketData) => Promise<void> | void;
      onDelete?: undefined;
      onClose: () => void;
      allTickets?: Ticket[];
      onOpenTicket?: (t: Ticket) => void;
      members?: Member[];
    }
  | {
      mode: 'view' | 'edit';
      ticket: Ticket;
      onSave?: undefined;
      onDelete?: (id: string) => void;
      onClose: () => void;
      allTickets?: Ticket[];
      onOpenTicket?: (t: Ticket) => void;
      members?: Member[];
    };

export function TicketModal({ mode: initialMode, ticket, onSave, onDelete, onClose, allTickets = [], onOpenTicket, members = [] }: TicketModalProps) {
  const [localMode, setLocalMode] = useState<'create' | 'view' | 'edit'>(initialMode);
  const [title, setTitle] = useState(ticket?.title ?? '');
  const [description, setDescription] = useState(ticket?.description ?? '');
  const [status, setStatus] = useState<Status>(ticket?.status ?? 'backlog');
  const [priority, setPriority] = useState<Priority>(ticket?.priority ?? 'medium');
  const [tagsInput, setTagsInput] = useState(ticket?.tags.join(', ') ?? '');
  const [type, setType] = useState<IssueType>(ticket?.type ?? 'task');
  const [dueDate, setDueDate] = useState<string | null>(ticket?.dueDate ?? null);
  const [startDate, setStartDate] = useState<string | null>(ticket?.startDate ?? null);
  const [estimate, setEstimate] = useState<number | null>(ticket?.estimate ?? null);
  const [assignee, setAssignee] = useState<string | null>(ticket?.assignee ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [wontDoDialogPending, setWontDoDialogPending] = useState(false);
  const [wontDoReason, setWontDoReason] = useState('');

  const updateTicketMutation = useUpdateTicket();
  const addCommentMutation = useAddComment();
  const addACMutation = useAddAcceptanceCriterion();
  const toggleACMutation = useToggleAcceptanceCriterion();
  const deleteACMutation = useDeleteAcceptanceCriterion();
  const addWorkLogMutation = useAddWorkLog();
  const addTestCaseMutation = useAddTestCase();
  const updateTestCaseMutation = useUpdateTestCase();
  const deleteTestCaseMutation = useDeleteTestCase();
  const linkBlockMutation = useLinkBlock();
  const unlinkBlockMutation = useUnlinkBlock();
  const [visible, setVisible] = useState(false);
  const persistedDescriptionRef = useRef(ticket?.description ?? '');
  const queuedDescriptionRef = useRef<string | null>(null);
  const descriptionSavePromiseRef = useRef<Promise<void> | null>(null);

  // Fix 1: keep onClose ref fresh to avoid stale closure in Escape handler
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    persistedDescriptionRef.current = ticket?.description ?? '';
  }, [ticket?.description, ticket?.id]);

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
    setSaveError(null);
    setViewError(null);
    setTimeout(onClose, 200);
  }

  async function handleSave() {
    if (!title.trim()) return;
    const tags = [...new Set(tagsInput.split(',').map((t) => t.trim()).filter(Boolean))];
    setSaveError(null);

    if (localMode === 'create') {
      try {
        if (onSave) await onSave({
          title: title.trim(),
          description,
          type,
          status,
          priority,
          tags,
          dueDate: dueDate || null,
          startDate: startDate || null,
          estimate,
          parentId: null,
          assignee,
          createdBy: null,
        });
        // parent closes the modal after successful creation
      } catch {
        setSaveError('Failed to create ticket. Please try again.');
      }
    } else if (ticket) {
      if (status === 'wont_do' && !wontDoDialogPending) {
        setWontDoDialogPending(true);
        return;
      }
      if (status === 'wont_do' && !wontDoReason.trim()) {
        setSaveError('Please provide a reason for marking this ticket as "Không làm".');
        return;
      }
      updateTicketMutation.mutate(
        {
          ticketId: ticket.id,
          data: {
            title: title.trim(),
            description,
            type,
            status,
            priority,
            tags,
            dueDate: dueDate || null,
            startDate: startDate || null,
            estimate,
            assignee,
            ...(status === 'wont_do' ? { wontDoReason: wontDoReason.trim() } : {}),
          },
        },
        {
          onSuccess: () => handleClose(),
          onError: (err) => { console.error('Failed to save ticket:', err); setSaveError('Failed to save ticket. Please try again.'); },
        },
      );
    }
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
    setViewError(null);
    setTimeout(() => titleInputRef.current?.focus(), 0);
  }

  function handleAddComment(text: string) {
    if (!ticket) return;
    addCommentMutation.mutate(
      { ticketId: ticket.id, text, author: 'user' },
      { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to add comment:', err); setViewError('Failed to add comment. Please try again.'); } },
    );
  }

  function handleAddAC(text: string) {
    if (!ticket) return;
    addACMutation.mutate(
      { ticketId: ticket.id, text },
      { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to add acceptance criterion:', err); setViewError('Failed to add acceptance criterion. Please try again.'); } },
    );
  }

  function handleToggleAC(id: string) {
    if (!ticket) return;
    toggleACMutation.mutate(
      { ticketId: ticket.id, criterionId: id },
      { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to toggle acceptance criterion:', err); setViewError('Failed to toggle acceptance criterion. Please try again.'); } },
    );
  }

  function handleDeleteAC(id: string) {
    if (!ticket) return;
    deleteACMutation.mutate(
      { ticketId: ticket.id, criterionId: id },
      { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to delete acceptance criterion:', err); setViewError('Failed to delete acceptance criterion. Please try again.'); } },
    );
  }

  function handleAddWorkLog(entry: Omit<WorkLogEntry, 'id'>) {
    if (!ticket) return;
    addWorkLogMutation.mutate(
      { ticketId: ticket.id, data: { author: entry.author, role: entry.role, note: entry.note } },
      { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to add work log:', err); setViewError('Failed to add work log entry. Please try again.'); } },
    );
  }

  async function persistDescription(nextDescription: string) {
    if (!ticket || nextDescription === persistedDescriptionRef.current) {
      return;
    }

    if (descriptionSavePromiseRef.current) {
      queuedDescriptionRef.current = nextDescription;
      return;
    }

    const savePromise = updateTicketMutation
      .mutateAsync({ ticketId: ticket.id, data: { description: nextDescription } })
      .then((updatedTicket) => {
        persistedDescriptionRef.current = updatedTicket.description;
        setSaveError(null);
      })
      .catch(() => {
        setSaveError('Failed to save description. Please try again.');
      })
      .finally(async () => {
        descriptionSavePromiseRef.current = null;
        const queuedDescription = queuedDescriptionRef.current;
        if (queuedDescription && queuedDescription !== persistedDescriptionRef.current) {
          queuedDescriptionRef.current = null;
          await persistDescription(queuedDescription);
        }
      });

    descriptionSavePromiseRef.current = savePromise;
    await savePromise;
  }

  async function handleDescriptionImageUpload(file: File) {
    try {
      const result = await uploadDescriptionImage(file);
      setSaveError(null);
      return result;
    } catch (err) {
      const message = extractError(err);
      setSaveError(`Failed to upload image: ${message}`);
      throw err;
    }
  }

  function handleCancelEdit() {
    setTitle(ticket?.title ?? '');
    setDescription(ticket?.description ?? '');
    setStatus(ticket?.status ?? 'backlog');
    setPriority(ticket?.priority ?? 'medium');
    setTagsInput(ticket?.tags.join(', ') ?? '');
    setType(ticket?.type ?? 'task');
    setDueDate(ticket?.dueDate ?? null);
    setStartDate(ticket?.startDate ?? null);
    setEstimate(ticket?.estimate ?? null);
    setAssignee(ticket?.assignee ?? null);
    setConfirmDelete(false);
    setSaveError(null);
    setWontDoDialogPending(false);
    setWontDoReason('');
    setLocalMode('view');
  }

  if (localMode === 'view' && ticket) {
    const currentTicket = ticket;
    const pc = PRIORITY_COLORS[currentTicket.priority];
    const childTickets = allTickets.filter((t) => t.parentId === currentTicket.id);
    const parentTicket = currentTicket.parentId ? allTickets.find((t) => t.id === currentTicket.parentId) : undefined;
    const isChildTicket = !!currentTicket.parentId;
    const isRootTicket = !isChildTicket;

    function handleLinkChild(childId: string) {
      updateTicketMutation.mutate(
        { ticketId: childId, data: { parentId: currentTicket.id } },
        { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to link child ticket:', err); setViewError('Failed to link child ticket. Please try again.'); } },
      );
    }

    function handleUnlinkChild(childId: string) {
      updateTicketMutation.mutate(
        { ticketId: childId, data: { parentId: null } },
        { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to unlink child ticket:', err); setViewError('Failed to unlink child ticket. Please try again.'); } },
      );
    }

    function handleSetParent(parentId: string) {
      updateTicketMutation.mutate(
        { ticketId: currentTicket.id, data: { parentId } },
        { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to set parent:', err); setViewError('Failed to set parent ticket. Please try again.'); } },
      );
    }

    function handleRemoveParent() {
      updateTicketMutation.mutate(
        { ticketId: currentTicket.id, data: { parentId: null } },
        { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to remove parent:', err); setViewError('Failed to remove parent ticket. Please try again.'); } },
      );
    }

    function handleToggleBlockDoneAcs() {
      updateTicketMutation.mutate(
        { ticketId: currentTicket.id, data: { blockDoneIfAcsIncomplete: !currentTicket.blockDoneIfAcsIncomplete } },
        { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to update block guard:', err); setViewError('Failed to update setting. Please try again.'); } },
      );
    }

    function handleToggleBlockDoneTcs() {
      updateTicketMutation.mutate(
        { ticketId: currentTicket.id, data: { blockDoneIfTcsIncomplete: !currentTicket.blockDoneIfTcsIncomplete } },
        { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to update block guard:', err); setViewError('Failed to update setting. Please try again.'); } },
      );
    }

    // Eligible parents: not current ticket, parentId===null, no children of their own
    const eligibleParents = allTickets.filter((t) => {
      if (t.id === currentTicket.id) return false;
      if (t.parentId != null) return false;
      const hasChildren = allTickets.some((other) => other.parentId === t.id);
      if (hasChildren) return false;
      return true;
    });

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
            {isChildTicket && parentTicket ? (
              <div className={styles.headerBreadcrumb}>
                <button type="button" className={styles.headerParentId} onClick={() => onOpenTicket?.(parentTicket)}>
                  {parentTicket.id}
                </button>
                <span className={styles.headerSep}>/</span>
                <span id="modal-heading" className={styles.headerChildId}>{ticket.id}</span>
              </div>
            ) : (
              <span id="modal-heading" className={styles.headerTitle}>{ticket.id}</span>
            )}
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

                <AcceptanceCriteriaSection
                  acceptanceCriteria={ticket.acceptanceCriteria ?? []}
                  onAdd={handleAddAC}
                  onToggle={handleToggleAC}
                  onDelete={handleDeleteAC}
                />

                <div className={styles.blockGuardRow}>
                  <label className={styles.blockGuardLabel}>
                    <input
                      type="checkbox"
                      checked={ticket.blockDoneIfAcsIncomplete}
                      onChange={handleToggleBlockDoneAcs}
                      className={styles.blockGuardCheckbox}
                    />
                    Block Done if ACs not all passed
                  </label>
                </div>

                {isRootTicket && (
                  <>
                    <hr className={styles.divider} />
                    <SubTicketsSection
                      childTickets={childTickets}
                      allTickets={allTickets}
                      currentTicketId={ticket.id}
                      projectId={ticket.projectId}
                      onOpenTicket={(t) => onOpenTicket && onOpenTicket(t)}
                      onLinkChild={handleLinkChild}
                      onUnlinkChild={handleUnlinkChild}
                    />
                    <hr className={styles.divider} />
                    <RelationsSection
                      ticket={ticket}
                      allTickets={allTickets}
                      onLinkBlock={(blockerId, blockedId) =>
                        linkBlockMutation.mutate(
                          { blockerId, blockedId },
                          {
                            onSuccess: () => setViewError(null),
                            onError: (err) => { console.error('Failed to link block:', err); setViewError('Failed to add relation. Please try again.'); },
                          },
                        )
                      }
                      onUnlinkBlock={(blockerId, blockedId) =>
                        unlinkBlockMutation.mutate(
                          { blockerId, blockedId },
                          {
                            onSuccess: () => setViewError(null),
                            onError: (err) => { console.error('Failed to unlink block:', err); setViewError('Failed to remove relation. Please try again.'); },
                          },
                        )
                      }
                    />
                  </>
                )}

                <hr className={styles.divider} />

                <CommentsSection
                  comments={ticket.comments ?? []}
                  onAdd={handleAddComment}
                />

                <hr className={styles.divider} />

                <ActivityLog entries={ticket.activityLog ?? []} />

                <hr className={styles.divider} />

                <WorkLogSection
                  entries={ticket.workLog ?? []}
                  onAdd={handleAddWorkLog}
                />

                <hr className={styles.divider} />

                <TestCasesSection
                  testCases={ticket.testCases ?? []}
                  disabled={addTestCaseMutation.isPending || updateTestCaseMutation.isPending || deleteTestCaseMutation.isPending}
                  onAdd={(title) =>
                    new Promise<void>((resolve, reject) =>
                      addTestCaseMutation.mutate(
                        { ticketId: ticket.id, title },
                        {
                          onSuccess: () => { setViewError(null); resolve(); },
                          onError: (err) => { console.error('Failed to add test case:', err); reject(err); },
                        },
                      ),
                    )
                  }
                  onChange={(updated) => {
                    const old = ticket.testCases ?? [];
                    // Detect deleted
                    const deletedIds = old
                      .filter((o) => !updated.some((u) => u.id === o.id))
                      .map((o) => o.id);
                    // Detect updated (matching server ID but content changed)
                    const changedItems = updated.filter((u) => {
                      const o = old.find((o) => o.id === u.id);
                      return o && JSON.stringify(o) !== JSON.stringify(u);
                    });
                    deletedIds.forEach((id) =>
                      deleteTestCaseMutation.mutate(
                        { ticketId: ticket.id, testCaseId: id },
                        { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to delete test case:', err); setViewError('Failed to delete test case. Please try again.'); } },
                      ),
                    );
                    changedItems.forEach((tc) =>
                      updateTestCaseMutation.mutate(
                        {
                          ticketId: ticket.id,
                          testCaseId: tc.id,
                          data: { title: tc.title, status: tc.status, proof: tc.proof ?? null, note: tc.note ?? null },
                        },
                        { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to update test case:', err); setViewError('Failed to update test case. Please try again.'); } },
                      ),
                    );
                  }}
                  childTestCaseSources={
                    isRootTicket
                      ? allTickets
                          .filter((t) => t.parentId === ticket.id)
                          .map((t) => ({ ticketId: t.id, ticketTitle: t.title, testCases: t.testCases ?? [] }))
                          .filter((s) => s.testCases.length > 0)
                      : undefined
                  }
                />

                <div className={styles.blockGuardRow}>
                  <label className={styles.blockGuardLabel}>
                    <input
                      type="checkbox"
                      checked={ticket.blockDoneIfTcsIncomplete}
                      onChange={handleToggleBlockDoneTcs}
                      className={styles.blockGuardCheckbox}
                    />
                    Block Done if TCs missing or not all passed
                  </label>
                </div>
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

                  {ticket.startDate && (
                    <div className={styles.sidebarRow}>
                      <span className={styles.sidebarLabel}>Start Date</span>
                      <span className={styles.dueDateBadge}>
                        🗓 {new Date(ticket.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                    </div>
                  )}

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

                  {/* Set parent — only for root tickets with no children */}
                  {isRootTicket && childTickets.length === 0 && (
                    <div className={styles.sidebarSection}>
                      <span className={styles.sidebarLabel}>Parent ticket</span>
                      <select
                        className={styles.select}
                        defaultValue=""
                        onChange={(e) => { if (e.target.value) handleSetParent(e.target.value); }}
                      >
                        <option value="">— set parent —</option>
                        {eligibleParents.map((p) => (
                          <option key={p.id} value={p.id}>{p.id}: {p.title}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Remove parent — only for child tickets (parentId is set) */}
                  {ticket.parentId && (
                    <div className={styles.sidebarSection}>
                      <span className={styles.sidebarLabel}>Parent ticket</span>
                      <button
                        type="button"
                        className={styles.chip}
                        style={{ cursor: 'pointer', background: '#FEE2E2', color: '#DC2626' }}
                        onClick={handleRemoveParent}
                        title="Click to remove parent"
                      >
                        ✕ Remove parent
                      </button>
                    </div>
                  )}

                  {/* Created by */}
                  {ticket.createdBy && (() => {
                    const creator = members.find((m) => m.id === ticket.createdBy);
                    return creator ? (
                      <div className={styles.sidebarRow}>
                        <span className={styles.sidebarLabel}>Created by</span>
                        <span className={styles.memberChip}>
                          <MemberAvatar member={creator} size={20} />
                          <span>{creator.name}</span>
                        </span>
                      </div>
                    ) : null;
                  })()}

                  {/* Assignee */}
                  {(() => {
                    const assigneeMember = ticket.assignee ? members.find((m) => m.id === ticket.assignee) : null;
                    return (
                      <div className={styles.sidebarRow}>
                        <span className={styles.sidebarLabel}>Assignee</span>
                        {assigneeMember ? (
                          <span className={styles.memberChip}>
                            <MemberAvatar member={assigneeMember} size={20} />
                            <span>{assigneeMember.name}</span>
                          </span>
                        ) : (
                          <span className={styles.unassignedBadge}>Unassigned</span>
                        )}
                      </div>
                    );
                  })()}
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
            {viewError && <p className={styles.errorText}>{viewError}</p>}
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
              onUploadImage={handleDescriptionImageUpload}
              onUploadComplete={(nextDescription) => {
                void persistDescription(nextDescription);
              }}
              onBlur={(newDesc) => {
                void persistDescription(newDesc);
              }}
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
                onChange={(e) => {
                  const val = e.target.value as Status;
                  if (val === 'wont_do') {
                    setStatus(val);
                    setWontDoDialogPending(true);
                  } else {
                    setStatus(val);
                    setWontDoDialogPending(false);
                    setWontDoReason('');
                  }
                }}
              >
                <option value="backlog">Backlog</option>
                <option value="todo">To Do</option>
                <option value="in-progress">In Progress</option>
                <option value="done">Done</option>
                {!ticket?.parentId && <option value="wont_do">Không làm</option>}
              </select>
              {wontDoDialogPending && (
                <div className={styles.wontDoDialog}>
                  <label className={styles.label}>Lý do không làm *</label>
                  <textarea
                    className={styles.wontDoTextarea}
                    value={wontDoReason}
                    onChange={(e) => setWontDoReason(e.target.value)}
                    placeholder="Nhập lý do..."
                    rows={3}
                    autoFocus
                  />
                </div>
              )}
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
            <label className={styles.label}>Start Date</label>
            <input
              type="date"
              className={styles.input}
              value={startDate ?? ''}
              onChange={(e) => setStartDate(e.target.value || null)}
            />
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

          {members.length > 0 && (
            <div className={styles.field}>
              <label className={styles.label}>Assignee</label>
              <select
                className={styles.select}
                value={assignee ?? ''}
                onChange={(e) => setAssignee(e.target.value || null)}
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          )}
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
          {saveError && <p className={styles.errorText}>{saveError}</p>}
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
