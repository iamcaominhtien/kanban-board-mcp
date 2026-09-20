import { useEffect, useMemo, useRef, useState } from 'react';
import type { IssueType, Member, Priority, Status, Ticket, WorkLogEntry } from '../types';
import {
  useUpdateTicket,
  useAddComment, useUpdateComment, useDeleteComment,
  useAddAcceptanceCriterion, useToggleAcceptanceCriterion, useDeleteAcceptanceCriterion,
  useAddWorkLog,
  useAddTestCase, useUpdateTestCase, useDeleteTestCase,
  uploadDescriptionImage,
  useLinkBlock, useUnlinkBlock,
  useAddTicketLink, useRemoveTicketLink,
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
import { TypeIcon, PriorityBars, CalendarIcon } from './ticketVisuals';
import styles from './TicketModal.module.css';

const ESTIMATE_OPTIONS = [null, 1, 2, 3, 5, 8, 13] as const;

// Mirrors TicketCard.tsx's TYPE_CONFIG so type colors stay consistent across the app.
const TYPE_CONFIG: Record<IssueType, { label: string; icon: string; bg: string; color: string }> = {
  bug:     { label: 'Bug',     icon: '🐛', bg: 'rgba(196, 67, 42, 0.12)',  color: 'var(--color-danger)' },
  feature: { label: 'Feature', icon: '✨', bg: 'rgba(109, 93, 211, 0.12)', color: 'var(--color-purple)' },
  task:    { label: 'Task',    icon: '📋', bg: 'rgba(47, 111, 176, 0.12)', color: 'var(--color-blue)' },
  chore:   { label: 'Chore',   icon: '🔧', bg: 'rgba(91, 107, 96, 0.12)',  color: 'var(--color-text-secondary)' },
};

// Small fixed palette used to deterministically color tag pills (hash by tag string).
const TAG_PALETTE = [
  'var(--color-blue)',
  'var(--color-purple)',
  'var(--color-primary)',
  'var(--color-orange)',
  'var(--color-danger)',
  'var(--color-teal)',
];

function tagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash + tag.charCodeAt(i)) % TAG_PALETTE.length;
  return TAG_PALETTE[hash];
}

function tagChipStyle(tag: string): { backgroundColor: string; color: string } {
  const color = tagColor(tag);
  return { backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`, color };
}

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

function capitalize(s: string) {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

// Regex for the exact markdown image syntax MarkdownEditor.tsx's upload flow inserts
// (`![alt](url)` — see its insertTextAtCursor/upload handler). Used to build a
// client-side-only Attachments list from the description + comments; nothing is
// persisted or fetched from a backend attachments endpoint (there is none).
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

interface Attachment {
  url: string;
  alt: string;
  sourceLabel: string;
}

function extractAttachments(ticket: Ticket): Attachment[] {
  const results: Attachment[] = [];
  const pushMatches = (text: string, sourceLabel: string) => {
    const re = new RegExp(MARKDOWN_IMAGE_RE);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const url = m[2];
      // Skip the transient "uploading…" placeholder MarkdownEditor inserts while an
      // upload is in flight — it isn't a real, resolvable attachment.
      if (url.startsWith('uploading:')) continue;
      results.push({ url, alt: m[1], sourceLabel });
    }
  };
  pushMatches(ticket.description ?? '', 'in Description');
  for (const c of ticket.comments ?? []) {
    pushMatches(c.text ?? '', `in comment · ${c.author}`);
  }
  return results;
}

// ─── Detail-view panel-swap (header icon buttons) ──────────────────────────
// Details and Test Cases are real, backed by existing data. Debug Space and
// Workspace are new-concept panels with no backend/data-model support yet
// (confirmed: no per-ticket filesystem workspace exists anywhere in ui/src or
// the backend) — per product decision they render as styled placeholder
// panels only, no fake data or functionality, until that backend work lands.
// Branches was removed from this panel-swap system entirely — the mockup
// moves branch info to a plain (also-placeholder) sidebar field instead; see
// its TODO(backend) comment near the sidebar "Branch" row below.
type DetailTab = 'details' | 'testcases' | 'debug' | 'workspace';

function PlaceholderPanel({ icon, title, description }: { icon: string; title: string; description: string }) {
  return (
    <div className={styles.placeholderPanel}>
      <span className={styles.placeholderIcon}>{icon}</span>
      <h3 className={styles.placeholderTitle}>{title}</h3>
      <p className={styles.placeholderText}>{description}</p>
    </div>
  );
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
  const [tags, setTags] = useState<string[]>(ticket?.tags ?? []);
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const tagPopoverRef = useRef<HTMLDivElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
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
  const [activeTab, setActiveTab] = useState<DetailTab>('details');
  const [branchNoteOpen, setBranchNoteOpen] = useState(false);

  const updateTicketMutation = useUpdateTicket();
  const addCommentMutation = useAddComment();
  const updateCommentMutation = useUpdateComment();
  const deleteCommentMutation = useDeleteComment();
  const addACMutation = useAddAcceptanceCriterion();
  const toggleACMutation = useToggleAcceptanceCriterion();
  const deleteACMutation = useDeleteAcceptanceCriterion();
  const addWorkLogMutation = useAddWorkLog();
  const addTestCaseMutation = useAddTestCase();
  const updateTestCaseMutation = useUpdateTestCase();
  const deleteTestCaseMutation = useDeleteTestCase();
  const linkBlockMutation = useLinkBlock();
  const unlinkBlockMutation = useUnlinkBlock();
  const addTicketLinkMutation = useAddTicketLink(ticket?.projectId ?? '');
  const removeTicketLinkMutation = useRemoveTicketLink(ticket?.projectId ?? '');
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
    if (localMode === 'create') {
      titleInputRef.current?.focus();
    } else {
      firstFocusRef.current?.focus();
    }
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

  // Client-derived list of the project's existing tags (no backend "all tags" endpoint),
  // flattened from allTickets, deduped, excluding tags already on this ticket.
  const existingProjectTags = useMemo(() => {
    const seen = new Set<string>();
    for (const t of allTickets) {
      for (const tag of t.tags ?? []) {
        if (!tags.includes(tag)) seen.add(tag);
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [allTickets, tags]);

  const filteredExistingTags = useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    if (!q) return existingProjectTags;
    return existingProjectTags.filter((t) => t.toLowerCase().includes(q));
  }, [existingProjectTags, tagQuery]);

  const canCreateTag =
    tagQuery.trim().length > 0 &&
    !existingProjectTags.some((t) => t.toLowerCase() === tagQuery.trim().toLowerCase()) &&
    !tags.some((t) => t.toLowerCase() === tagQuery.trim().toLowerCase());

  function handleAddExistingTag(tag: string) {
    setTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
    setTagQuery('');
    tagInputRef.current?.focus();
  }

  function handleCreateTag() {
    const text = tagQuery.trim();
    if (!text) return;
    setTags((prev) => (prev.includes(text) ? prev : [...prev, text]));
    setTagQuery('');
    tagInputRef.current?.focus();
  }

  function handleRemoveTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag));
  }

  // Close the "add tag" popover on outside click or Escape.
  useEffect(() => {
    if (!tagPopoverOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (tagPopoverRef.current && !tagPopoverRef.current.contains(e.target as Node)) {
        setTagPopoverOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setTagPopoverOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [tagPopoverOpen]);

  function handleClose() {
    setVisible(false);
    setSaveError(null);
    setViewError(null);
    setTimeout(onClose, 200);
  }

  async function handleSave() {
    if (!title.trim()) return;
    const finalTags = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    setSaveError(null);

    if (localMode === 'create') {
      try {
        if (onSave) await onSave({
          title: title.trim(),
          description,
          type,
          status,
          priority,
          tags: finalTags,
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
            tags: finalTags,
            dueDate: dueDate || null,
            startDate: startDate || null,
            estimate,
            assignee,
            ...(status === 'wont_do' ? { wontDoReason: wontDoReason.trim() } : {}),
          },
        },
        {
          onSuccess: () => handleClose(),
          onError: (err) => { console.error('Failed to save ticket:', err); setSaveError(extractError(err) || 'Failed to save ticket. Please try again.'); },
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

  function handleEditComment(commentId: string, text: string) {
    if (!ticket) return;
    updateCommentMutation.mutate(
      { ticketId: ticket.id, commentId, text },
      { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to update comment:', err); setViewError('Failed to update comment. Please try again.'); } },
    );
  }

  function handleDeleteComment(commentId: string) {
    if (!ticket) return;
    deleteCommentMutation.mutate(
      { ticketId: ticket.id, commentId },
      { onSuccess: () => setViewError(null), onError: (err) => { console.error('Failed to delete comment:', err); setViewError('Failed to delete comment. Please try again.'); } },
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
    setTags(ticket?.tags ?? []);
    setTagPopoverOpen(false);
    setTagQuery('');
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

    function handleToggleBlockGuard(field: 'blockDoneIfAcsIncomplete' | 'blockDoneIfTcsIncomplete') {
      updateTicketMutation.mutate(
        { ticketId: currentTicket.id, data: { [field]: !currentTicket[field] } },
        {
          onSuccess: () => setViewError(null),
          onError: (err) => {
            console.error('Failed to update block guard:', err);
            setViewError('Failed to update setting. Please try again.');
          },
        },
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

    // Gate for showing the sub-tickets section; SubTicketsSection computes its
    // own done/total counts and progress bar internally from childTickets.
    const subTaskTotal = childTickets.length;

    const testCases = ticket.testCases ?? [];
    const tcPass = testCases.filter((tc) => tc.status === 'pass').length;
    const tcFail = testCases.filter((tc) => tc.status === 'fail').length;
    const tcPending = testCases.filter((tc) => tc.status === 'pending').length;
    const testCasesDotColor = testCases.length === 0
      ? 'var(--color-border)'
      : tcFail > 0
        ? 'var(--color-danger)'
        : tcPending > 0
          ? 'var(--color-text-secondary)'
          : 'var(--color-blue)';
    const testCasesTooltip = testCases.length === 0
      ? 'Test Cases — none yet'
      : `Test — ${tcPass} pass · ${tcFail} fail · ${tcPending} pending`;

    const attachments = extractAttachments(ticket);

    const assigneeMember = ticket.assignee ? members.find((m) => m.id === ticket.assignee) : null;
    const creatorMember = ticket.createdBy ? members.find((m) => m.id === ticket.createdBy) : null;
    const memberMap = new Map(members.map((m) => [m.id, m]));
    const dueInfo = ticket.dueDate ? (() => {
      const due = new Date(ticket.dueDate as string);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return { overdue: due < today, label: formatDate(ticket.dueDate as string) };
    })() : null;

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
          <div className={styles.dtHeader}>
            <div className={styles.dtHeaderIdentity}>
              <div className={styles.dtTypeGroup}>
                <TypeIcon type={ticket.type} color={TYPE_CONFIG[ticket.type].color} />
                <span className={styles.dtTypeLabel}>{TYPE_CONFIG[ticket.type].label}</span>
              </div>
              <span className={styles.dtHeaderDivider} />
              {isChildTicket && parentTicket ? (
                <div className={styles.headerBreadcrumb}>
                  <button type="button" className={styles.dtParentBtn} onClick={() => onOpenTicket?.(parentTicket)}>
                    <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3.5 2.5V8A2.5 2.5 0 0 0 6 10.5H9.5" />
                      <path d="M7.5 8.5L10 11L7.5 13.5" />
                    </svg>
                    {parentTicket.id}
                  </button>
                  <span className={styles.headerSep}>/</span>
                  <button
                    type="button"
                    id="modal-heading"
                    className={styles.dtIdBtn}
                    onClick={() => setActiveTab('details')}
                    title="Back to Details"
                  >
                    {ticket.id}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  id="modal-heading"
                  className={styles.dtIdBtn}
                  onClick={() => setActiveTab('details')}
                  title="Back to Details"
                >
                  {ticket.id}
                </button>
              )}
            </div>

            <div className={styles.dtViewRow}>
              <button
                type="button"
                aria-label="Test Cases"
                className={`${styles.dtViewBtn} ${activeTab === 'testcases' ? styles.dtViewBtnActive : ''}`}
                onClick={() => setActiveTab('testcases')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 11L12 14L22 4" />
                  <path d="M21 12V19A2 2 0 0 1 19 21H5A2 2 0 0 1 3 19V5A2 2 0 0 1 5 3H16" />
                </svg>
                <span className={styles.dtViewDot} style={{ background: testCasesDotColor }} />
                <span className={styles.dtViewTooltip}>{testCasesTooltip}</span>
              </button>
              <button
                type="button"
                aria-label="Debug Space"
                className={`${styles.dtViewBtn} ${activeTab === 'debug' ? styles.dtViewBtnActive : ''}`}
                onClick={() => setActiveTab('debug')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="M7 9L10 12L7 15" />
                  <path d="M12 15H17" />
                </svg>
                {/* Static neutral dot — Debug Space has no real data yet (TODO(backend) below). */}
                <span className={styles.dtViewDot} style={{ background: 'var(--color-primary)' }} />
                <span className={styles.dtViewTooltip}>Debug — coming soon</span>
              </button>
              <button
                type="button"
                aria-label="Workspace"
                className={`${styles.dtViewBtn} ${activeTab === 'workspace' ? styles.dtViewBtnActive : ''}`}
                onClick={() => setActiveTab('workspace')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7C3 5.9 3.9 5 5 5H9.2L11.2 7.5H19C20.1 7.5 21 8.4 21 9.5V17C21 18.1 20.1 19 19 19H5C3.9 19 3 18.1 3 17V7Z" />
                </svg>
                <span className={styles.dtViewTooltip}>Workspace — coming soon</span>
              </button>
            </div>

            <button type="button" aria-label="Close modal" className={styles.dtCloseBtn} onClick={handleClose} ref={firstFocusRef}>
              ×
            </button>
          </div>

          <div className={styles.body}>
            <div className={styles.twoColLayout}>
              {/* ── Left column: content ── */}
              <div className={styles.mainCol}>
              {activeTab === 'details' && (
                <>
                <div className={styles.dtTitleBlock}>
                  <h2 className={styles.viewTitle}>{ticket.title}</h2>
                  {ticket.tags.length > 0 && (
                    <div className={styles.tagChips}>
                      {ticket.tags.map((tag, i) => (
                        <span key={`${tag}-${i}`} className={styles.tagPill} style={tagChipStyle(tag)}>{tag}</span>
                      ))}
                    </div>
                  )}
                </div>

                <div className={styles.dtSectionBlock}>
                  <div className={styles.dtLabel}>Description</div>
                  <MarkdownEditor
                    value={description}
                    onChange={setDescription}
                    readOnly={true}
                  />
                </div>

                {isRootTicket && subTaskTotal > 0 && (
                  <div className={styles.dtSectionBlock}>
                    {/* SubTicketsSection renders its own "SUB-TICKETS · N" header
                        + progress bar internally, so no extra label wrapper here
                        (this block used to duplicate it under a "SUB-TASKS" label,
                        which mislabeled sub-tickets as sub-tasks). */}
                    <SubTicketsSection
                      childTickets={childTickets}
                      allTickets={allTickets}
                      currentTicketId={ticket.id}
                      projectId={ticket.projectId}
                      memberMap={memberMap}
                      onOpenTicket={(t) => onOpenTicket && onOpenTicket(t)}
                      onLinkChild={handleLinkChild}
                      onUnlinkChild={handleUnlinkChild}
                    />
                  </div>
                )}

                <div className={styles.dtSectionBlock}>
                  {/* AcceptanceCriteriaSection renders its own "ACCEPTANCE CRITERIA" header
                      internally, so no extra label wrapper is added here (would duplicate it). */}
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
                        onChange={() => handleToggleBlockGuard('blockDoneIfAcsIncomplete')}
                        className={styles.blockGuardCheckbox}
                      />
                      Block Done if ACs not all passed
                    </label>
                  </div>
                </div>

                {isRootTicket && (
                  <div className={styles.dtSectionBlock}>
                    {/* RelationsSection renders its own "RELATIONS" header internally. */}
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
                      onAddLink={(ticketId, targetId, relationType) =>
                        addTicketLinkMutation.mutate(
                          { ticketId, targetId, relationType },
                          {
                            onSuccess: () => setViewError(null),
                            onError: (err) => { console.error('Failed to add link:', err); setViewError('Failed to add link. Please try again.'); },
                          },
                        )
                      }
                      onRemoveLink={(ticketId, linkId) =>
                        removeTicketLinkMutation.mutate(
                          { ticketId, linkId },
                          {
                            onSuccess: () => setViewError(null),
                            onError: (err) => { console.error('Failed to remove link:', err); setViewError('Failed to remove link. Please try again.'); },
                          },
                        )
                      }
                    />
                  </div>
                )}

                {attachments.length > 0 && (
                  <div className={styles.dtSectionBlock}>
                    <div className={styles.dtLabelInline}>ATTACHMENTS · {attachments.length}</div>
                    {/* TODO(backend): only image attachments (parsed from markdown `![alt](url)` syntax
                        already produced by MarkdownEditor's upload flow) can be shown here — there is no
                        file-upload capability in the app today for non-image attachments (e.g. PDFs), so
                        that case is not represented until a real upload/attachment data model lands. */}
                    <div className={styles.dtAttachmentsRow}>
                      {attachments.map((a, i) => (
                        <div key={`${a.url}-${i}`} className={styles.dtAttachment}>
                          <div className={styles.dtAttachmentThumb}>
                            <img src={a.url} alt={a.alt || 'attachment'} />
                          </div>
                          <span className={styles.dtAttachmentCaption}>{a.sourceLabel}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className={styles.dtSectionBlock}>
                  {/* CommentsSection renders its own "Comments (N)" header internally. */}
                  <CommentsSection
                    comments={ticket.comments ?? []}
                    onAdd={handleAddComment}
                    onEdit={handleEditComment}
                    onDelete={handleDeleteComment}
                  />
                </div>

                {/* Activity Log and Work Log aren't part of the Details layout in the mockup,
                    but are existing, working features not being dropped by this task — kept
                    here, below Comments, so nothing already shipped is lost. */}
                <hr className={styles.divider} />
                <ActivityLog entries={ticket.activityLog ?? []} />

                <hr className={styles.divider} />
                <WorkLogSection
                  entries={ticket.workLog ?? []}
                  onAdd={handleAddWorkLog}
                />
                </>
              )}

              {activeTab === 'testcases' && (
                <>
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
                      onChange={() => handleToggleBlockGuard('blockDoneIfTcsIncomplete')}
                      className={styles.blockGuardCheckbox}
                    />
                    Block Done if TCs missing or not all passed
                  </label>
                </div>
                </>
              )}

              {activeTab === 'debug' && (
                // TODO(backend): Debug Space needs a new typed-entry data model (kind: investigation/fix-attempt/root-cause/blocked/resolved, pinning, cross-links to branches/test cases) — see design/ mockups for the full spec. This tab is a placeholder until that backend work lands.
                <PlaceholderPanel
                  icon="🐞"
                  title="Debug Space"
                  description="Debug Space is coming soon — a dedicated timeline for investigation notes, fix attempts, and links to branches & test cases."
                />
              )}

              {activeTab === 'workspace' && (
                // TODO(backend): per-ticket Workspace needs real filesystem integration (a {workspaceRoot}/{TICKET-KEY}/ folder, file listing, retention). This tab is a placeholder until that backend work lands. (Distinct from the Settings → Workspace section already shipped, which is a different, simpler per-project setting.)
                <PlaceholderPanel
                  icon="🗂"
                  title="Workspace"
                  description="Workspace is coming soon — a dedicated scratch folder for this ticket's files."
                />
              )}

              </div>

              {/* ── Right sidebar: metadata ──
                  Each field is a static, read-only rendering of the ticket's current
                  data in this (view-mode) panel — the existing Edit/Save/Cancel toggle
                  is unchanged, and switching to edit mode still opens the separate
                  form (below) where these same fields are actually editable. See the
                  final report for the full rationale on this view/edit split. */}
              <aside className={styles.sidebarCol}>
                <div className={styles.sidebarCard}>
                  <div className={styles.dtSidebarRow}>
                    <span className={styles.dtLabel}>Status</span>
                    <span className={styles.statusBadge}>{STATUS_LABELS[ticket.status]}</span>
                  </div>

                  {/* TODO(backend): Branches is an entirely new feature (branch/merge graph,
                      baseline/branch/merged/stale states, per-ticket branch metadata) with no
                      existing data model or backend support — this was previously a whole
                      placeholder tab; it's now a single, clearly-disabled sidebar field until
                      that work is scoped. No fake branch names/state are shown. */}
                  <div className={styles.dtSidebarRow}>
                    <span className={styles.dtLabel}>Branch</span>
                    <button
                      type="button"
                      className={styles.dtBranchBtn}
                      onClick={() => setBranchNoteOpen((o) => !o)}
                      aria-expanded={branchNoteOpen}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-purple)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="6" cy="6" r="2.5" />
                        <circle cx="6" cy="18" r="2.5" />
                        <circle cx="18" cy="6" r="2.5" />
                        <path d="M6 8.5V15.5" />
                        <path d="M8.5 6H13A5 5 0 0 1 18 11V15.5" />
                      </svg>
                      Not connected
                    </button>
                    {branchNoteOpen && (
                      <span className={styles.dtBranchNote}>Branch tracking is coming soon.</span>
                    )}
                  </div>

                  <div className={styles.dtSidebarRow}>
                    <span className={styles.dtLabel}>Assignee</span>
                    {assigneeMember ? (
                      <span className={styles.memberChip}>
                        <MemberAvatar member={assigneeMember} size={22} />
                        <span>{assigneeMember.name}</span>
                      </span>
                    ) : (
                      <span className={styles.unassignedBadge}>Unassigned</span>
                    )}
                  </div>

                  <div className={styles.dtSidebarRow}>
                    <span className={styles.dtLabel}>Priority</span>
                    <span className={styles.dtPriorityValue}>
                      <PriorityBars priority={ticket.priority} />
                      {capitalize(ticket.priority)}
                    </span>
                  </div>

                  {dueInfo && (
                    <div className={styles.dtSidebarRow}>
                      <span className={styles.dtLabel}>Due date</span>
                      <span className={dueInfo.overdue ? styles.dueDateOverdue : styles.dtDueValue}>
                        <CalendarIcon overdue={dueInfo.overdue} />
                        {dueInfo.label}
                      </span>
                    </div>
                  )}

                  {ticket.estimate !== null && ticket.estimate !== undefined && (
                    <div className={styles.dtSidebarRow}>
                      <span className={styles.dtLabel}>Estimate</span>
                      <span className={styles.dtPlainValue}>{ticket.estimate} pt</span>
                    </div>
                  )}

                  {ticket.startDate && (
                    <div className={styles.dtSidebarRow}>
                      <span className={styles.dtLabel}>Start date</span>
                      <span className={styles.dtPlainValue}>{formatDate(ticket.startDate)}</span>
                    </div>
                  )}

                  {/* Set parent — only for root tickets with no children */}
                  {isRootTicket && childTickets.length === 0 && (
                    <div className={styles.sidebarSection}>
                      <span className={styles.dtLabel}>Parent ticket</span>
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
                      <span className={styles.dtLabel}>Parent ticket</span>
                      <button
                        type="button"
                        className={styles.chip}
                        style={{ cursor: 'pointer', background: 'rgba(196, 67, 42, 0.12)', color: 'var(--color-danger)' }}
                        onClick={handleRemoveParent}
                        title="Click to remove parent"
                      >
                        ✕ Remove parent
                      </button>
                    </div>
                  )}

                  <hr className={styles.dtSidebarDivider} />

                  <div className={styles.dtMetaText}>
                    <div>
                      Created {formatDate(ticket.createdAt)}
                      {creatorMember && <> by <span className={styles.dtMetaStrong}>{creatorMember.name}</span></>}
                    </div>
                    <div>Updated {formatDate(ticket.updatedAt)}</div>
                  </div>
                </div>
              </aside>
            </div>
          </div>

          <div className={styles.footer}>
            <div className={styles.deleteArea}>
              {confirmDelete ? (
                <div className={styles.confirmArea}>
                  <span className={styles.confirmText}>Delete this ticket?</span>
                  <button type="button" className={styles.cancelBtn} onClick={() => setConfirmDelete(false)}>Cancel</button>
                  <button type="button" className={styles.confirmBtn} onClick={handleDelete}>Delete</button>
                </div>
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
          {/* Group 1 — Basic Info */}
          <div className={styles.fieldGroup}>
            <div className={styles.fieldGroupLabel}>Basic info</div>

            <div className={styles.field}>
              <label className={styles.label}>Title</label>
              <input
                ref={titleInputRef}
                className={styles.input}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Ticket title..."
                required
                aria-required="true"
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
          </div>

          {/* Group 2 — Metadata */}
          <div className={styles.fieldGroup}>
            <div className={styles.fieldGroupLabel}>Metadata</div>

            <div className={styles.row} style={localMode === 'create' ? { gridTemplateColumns: '1fr' } : undefined}>
              {localMode !== 'create' && (
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
                    {/* TODO(backend): "Review" and "Testing" statuses are part of the target design but need a backend Status enum/migration change first — see server/models.py's Status definition and Board.tsx's COLUMNS. Do not add them as selectable options until that lands. */}
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
              )}

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
              <div className={styles.tagEditRow}>
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className={`${styles.tagPill} ${styles.tagPillRemovable}`}
                    style={tagChipStyle(tag)}
                  >
                    {tag}
                    <button
                      type="button"
                      className={styles.tagRemoveBtn}
                      aria-label={`Remove tag ${tag}`}
                      onClick={() => handleRemoveTag(tag)}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12">
                        <path d="M3 3L9 9M9 3L3 9" stroke={tagColor(tag)} strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    </button>
                  </span>
                ))}

                <div className={styles.tagPopoverAnchor} ref={tagPopoverRef}>
                  <button
                    type="button"
                    className={styles.addTagBtn}
                    onClick={() => {
                      setTagPopoverOpen((open) => !open);
                      setTagQuery('');
                      setTimeout(() => tagInputRef.current?.focus(), 0);
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12">
                      <path d="M6 2V10M2 6H10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                    Add tag
                  </button>

                  {tagPopoverOpen && (
                    <div className={styles.tagPopover}>
                      <input
                        ref={tagInputRef}
                        className={styles.tagPopoverInput}
                        value={tagQuery}
                        onChange={(e) => setTagQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            if (filteredExistingTags.length > 0) {
                              handleAddExistingTag(filteredExistingTags[0]);
                            } else if (canCreateTag) {
                              handleCreateTag();
                            }
                          }
                        }}
                        placeholder="Type to filter or create..."
                        autoFocus
                      />
                      <div className={styles.tagPopoverList}>
                        {filteredExistingTags.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            className={styles.tagPopoverRow}
                            onClick={() => handleAddExistingTag(tag)}
                          >
                            <span className={styles.tagPill} style={tagChipStyle(tag)}>{tag}</span>
                            <span className={styles.tagExistingLabel}>existing tag</span>
                          </button>
                        ))}
                        {canCreateTag && (
                          <button type="button" className={styles.tagCreateRow} onClick={handleCreateTag}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                              <path d="M12 5V19" />
                              <path d="M5 12H19" />
                            </svg>
                            Create &quot;{tagQuery.trim()}&quot;
                          </button>
                        )}
                        {filteredExistingTags.length === 0 && !canCreateTag && (
                          <div className={styles.tagEmpty}>No matching tags</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
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

          {/* Group 3 — Dates */}
          <div className={styles.fieldGroup}>
            <div className={styles.fieldGroupLabel}>Dates</div>

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
          </div>
        </div>

        <div className={styles.footer}>
          {localMode === 'edit' && onDelete && (
            <div className={styles.deleteArea}>
              {confirmDelete ? (
                <div className={styles.confirmArea}>
                  <span className={styles.confirmText}>Delete this ticket?</span>
                  <button type="button" className={styles.cancelBtn} onClick={() => setConfirmDelete(false)}>Cancel</button>
                  <button type="button" className={styles.confirmBtn} onClick={handleDelete}>Delete</button>
                </div>
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
