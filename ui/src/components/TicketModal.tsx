import { useEffect, useRef, useState } from 'react';
import type { IssueType, Member, Priority, Status, Ticket, TicketBranch } from '../types';
import {
  useUpdateTicket,
  useAddComment, useUpdateComment, useDeleteComment,
  useAddAcceptanceCriterion, useToggleAcceptanceCriterion, useDeleteAcceptanceCriterion,
  useAddWorkLog, useUpdateWorkLog, useDeleteWorkLog,
  uploadDescriptionImage,
  useLinkBlock, useUnlinkBlock,
  useAddTicketLink, useRemoveTicketLink,
  useAddTestCase, useUpdateTestCase, useDeleteTestCase,
  useTicketBranches,
} from '../api/tickets';
import { extractError } from '../api/extractError';
import { resolveOrigin } from '../api/resolveOrigin';
import { ActivityLog } from './ActivityLog';
import { CommentsSection } from './CommentsSection';
import { MarkdownEditor } from './MarkdownEditor';
import { AcceptanceCriteriaSection } from './AcceptanceCriteriaSection';
import { MemberAvatar } from './MemberAvatar';
import { RelationsSection } from './RelationsSection';
import { TestCasesSection } from './TestCasesSection';
import { DebugSpaceSection } from './DebugSpaceSection';
import { WorkspaceSection } from './WorkspaceSection';
import { BranchesSection } from './BranchesSection';
import { CreateBranchModal } from './CreateBranchModal';
import { useProject } from '../api/projects';
import { SubTicketsSection } from './SubTicketsSection';
import { TicketTypeIcon, PriorityMark } from './icons';
import { StatusMenu } from './StatusMenu';
import { TagPill } from './TagPill';
import { useToast } from './Toast';
import styles from './TicketModal.module.css';

const ESTIMATE_NUMBERS = [1, 2, 3, 5, 8, 13] as const;

const TYPE_CONFIG: Record<IssueType, { label: string }> = {
  bug:     { label: 'Bug' },
  feature: { label: 'Feature' },
  task:    { label: 'Task' },
  chore:   { label: 'Chore' },
};

function formatDueDate(iso?: string | null): string {
  if (!iso) return 'Set date';
  try {
    const parts = iso.split('T')[0].split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      const d = new Date(year, month, day);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function formatRelativeTime(iso?: string | null): string {
  if (!iso) return 'recently';
  try {
    const now = Date.now();
    const then = new Date(iso).getTime();
    if (isNaN(then)) return 'recently';
    const diffMs = now - then;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffDay > 30) {
      return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    if (diffDay > 0) return `${diffDay} ${diffDay === 1 ? 'day' : 'days'} ago`;
    if (diffHour > 0) return `${diffHour} ${diffHour === 1 ? 'hour' : 'hours'} ago`;
    if (diffMin > 0) return `${diffMin} ${diffMin === 1 ? 'minute' : 'minutes'} ago`;
    return 'just now';
  } catch {
    return 'recently';
  }
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

export function TicketModal({
  mode: initialMode,
  ticket,
  onSave,
  onDelete,
  onClose,
  allTickets = [],
  onOpenTicket,
  members = [],
}: TicketModalProps) {
  const localMode = initialMode;
  const [activeTab, setActiveTab] = useState<'main' | 'test_cases' | 'debug_space' | 'workspace' | 'branches'>('main');

  const [title, setTitle] = useState(ticket?.title ?? '');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [description, setDescription] = useState(ticket?.description ?? '');
  const [status, setStatus] = useState<Status>(ticket?.status ?? 'backlog');
  const [priority, setPriority] = useState<Priority>(ticket?.priority ?? 'medium');
  const [tags, setTags] = useState<string[]>(ticket?.tags ?? []);
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [newTagText, setNewTagText] = useState('');
  const [type, setType] = useState<IssueType>(ticket?.type ?? 'task');
  const [dueDate, setDueDate] = useState<string | null>(ticket?.dueDate ?? null);
  const [startDate, setStartDate] = useState<string | null>(ticket?.startDate ?? null);
  const [estimate, setEstimate] = useState<number | null>(ticket?.estimate ?? null);
  const [assignee, setAssignee] = useState<string | null>(ticket?.assignee ?? null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const toast = useToast();
  const updateTicketMutation = useUpdateTicket();
  const addCommentMutation = useAddComment();
  const updateCommentMutation = useUpdateComment();
  const deleteCommentMutation = useDeleteComment();
  const addACMutation = useAddAcceptanceCriterion();
  const toggleACMutation = useToggleAcceptanceCriterion();
  const deleteACMutation = useDeleteAcceptanceCriterion();
  const addWorkLogMutation = useAddWorkLog();
  const updateWorkLogMutation = useUpdateWorkLog();
  const deleteWorkLogMutation = useDeleteWorkLog();
  const addTestCaseMutation = useAddTestCase();
  const updateTestCaseMutation = useUpdateTestCase();
  const deleteTestCaseMutation = useDeleteTestCase();
  const linkBlockMutation = useLinkBlock();
  const unlinkBlockMutation = useUnlinkBlock();
  const addTicketLinkMutation = useAddTicketLink(ticket?.projectId ?? '');
  const removeTicketLinkMutation = useRemoveTicketLink(ticket?.projectId ?? '');

  const { data: ticketBranches = [] } = useTicketBranches(ticket?.id ?? '');
  const { data: project } = useProject(ticket?.projectId ?? '');
  const [repoPathDraft, setRepoPathDraft] = useState('');
  const [isEditingRepo, setIsEditingRepo] = useState(false);
  const effectiveRepoPath = ticket?.repoPath || project?.repoPath || null;

  async function saveTicketRepo(path: string) {
    if (!ticket) return;
    try {
      await updateTicketMutation.mutateAsync({
        ticketId: ticket.id,
        data: { repoPath: path.trim() ? path : null },
      });
      setIsEditingRepo(false);
      toast.success(path.trim() ? 'Ticket repository set' : 'Using project repository');
    } catch (err) {
      toast.error("Couldn't set repository", extractError(err));
    }
  }

  const [isBranchPopoverOpen, setIsBranchPopoverOpen] = useState(false);
  const [selectedBranchName, setSelectedBranchName] = useState<string | null>(null);
  const [isCreateBranchModalOpen, setIsCreateBranchModalOpen] = useState(false);
  const branchContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (branchContainerRef.current && !branchContainerRef.current.contains(e.target as Node)) {
        setIsBranchPopoverOpen(false);
      }
    }
    if (isBranchPopoverOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isBranchPopoverOpen]);

  const [visible, setVisible] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  useEffect(() => {
    if (isAddingTag) {
      tagInputRef.current?.focus();
    }
  }, [isAddingTag]);

  // Keep in sync if ticket changes
  useEffect(() => {
    if (ticket) {
      setTitle(ticket.title);
      setDescription(ticket.description);
      setStatus(ticket.status);
      setPriority(ticket.priority);
      setTags(ticket.tags);
      setType(ticket.type);
      setDueDate(ticket.dueDate ?? null);
      setStartDate(ticket.startDate ?? null);
      setEstimate(ticket.estimate ?? null);
      setAssignee(ticket.assignee ?? null);
    }
  }, [ticket]);

  function handleClose() {
    setVisible(false);
    setTimeout(onClose, 150);
  }

  // Fast inline update for properties in View mode
  function autoSaveField<K extends keyof Ticket>(field: K, val: Ticket[K]) {
    if (!ticket) return;
    updateTicketMutation.mutate(
      { ticketId: ticket.id, data: { [field]: val } },
      {
        onError: (err) => {
          toast.error("Couldn't save changes", extractError(err));
        },
      }
    );
  }

  function handleTitleBlur() {
    setIsEditingTitle(false);
    if (title.trim() && title.trim() !== ticket?.title) {
      autoSaveField('title', title.trim());
    }
  }

  function handleStatusChange(newStatus: Status) {
    setStatus(newStatus);
    autoSaveField('status', newStatus);
    if (newStatus === 'done' && ticket) {
      toast.success('Moved to Done', `${ticket.id} · ${ticket.title}`);
    }
  }

  function handlePriorityChange(newPriority: Priority) {
    setPriority(newPriority);
    autoSaveField('priority', newPriority);
  }

  function handleTypeChange(newType: IssueType) {
    setType(newType);
    autoSaveField('type', newType);
  }

  function handleAssigneeChange(newAssignee: string | null) {
    setAssignee(newAssignee);
    autoSaveField('assignee', newAssignee);
  }

  function handleEstimateChange(newEst: number | null) {
    setEstimate(newEst);
    autoSaveField('estimate', newEst);
  }

  function handleRemoveTag(tagToRemove: string) {
    const nextTags = tags.filter((t) => t !== tagToRemove);
    setTags(nextTags);
    autoSaveField('tags', nextTags);
  }

  function handleAddTagSubmit() {
    const trimmed = newTagText.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      const nextTags = [...tags, trimmed];
      setTags(nextTags);
      autoSaveField('tags', nextTags);
    }
    setNewTagText('');
    setIsAddingTag(false);
  }

  function handleCopyId() {
    if (!ticket) return;
    navigator.clipboard.writeText(ticket.id);
    toast.info('Copied ticket ID', ticket.id);
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaveError(null);

    try {
      if (onSave) {
        await onSave({
          title: title.trim(),
          description,
          type,
          status: 'backlog',
          priority,
          tags,
          dueDate: dueDate || null,
          startDate: startDate || null,
          estimate,
          parentId: null,
          assignee,
          createdBy: null,
        });
      }
      handleClose();
    } catch (err) {
      setSaveError(extractError(err) || 'Failed to create ticket. Please try again.');
    }
  }

  const assigneeMember = members.find((m) => m.id === assignee);
  const childTickets = ticket ? allTickets.filter((t) => t.parentId === ticket.id) : [];
  const parentTicket = ticket?.parentId ? allTickets.find((t) => t.id === ticket.parentId) : undefined;

  // View switchers tooltips & status dots
  const tcList = ticket?.testCases ?? [];
  const passCount = tcList.filter((tc) => tc.status === 'pass').length;
  const failCount = tcList.filter((tc) => tc.status === 'fail').length;
  const runningCount = tcList.filter((tc) => tc.status === 'running').length;
  const pendingCount = tcList.filter((tc) => tc.status === 'pending').length;
  const tcDotColor = failCount > 0 ? '#C4432A' : runningCount > 0 ? '#2F6FB0' : passCount > 0 ? '#2E6F40' : undefined;
  const tcTooltip = tcList.length > 0
    ? `Test — ${passCount} pass · ${failCount} fail · ${runningCount} running · ${pendingCount} pending`
    : 'Test Cases';

  const wlList = ticket?.workLog ?? [];
  const blockedLog = wlList.some((w) => w.kind === 'blocked');
  const wlDotColor = blockedLog ? '#C4432A' : wlList.length > 0 ? '#2E6F40' : undefined;
  const wlTooltip = wlList.length > 0
    ? `Debug — ${wlList.length} entries${blockedLog ? ' · 1 blocked' : ''}`
    : 'Debug Space';

  // ══════════════════════════════════════════════════════════════
  // RENDER: CREATE MODE (New Ticket)
  // ══════════════════════════════════════════════════════════════
  if (localMode === 'create' || !ticket) {
    return (
      <div className={`${styles.overlay} ${visible ? styles.overlayVisible : ''}`} onClick={handleClose}>
        <div className={`${styles.panel} ${styles.panelNew} ${visible ? styles.panelVisible : ''}`} onClick={(e) => e.stopPropagation()}>
          <div className={styles.newModalHeader}>
            <span className={styles.newModalTitle}>New Ticket</span>
            <button type="button" aria-label="Close" className={styles.closeBtn} onClick={handleClose}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M6 6L18 18" />
                <path d="M18 6L6 18" />
              </svg>
            </button>
          </div>

          <form onSubmit={handleCreateSubmit}>
            <div className={styles.newModalBody}>
              {saveError && (
                <div style={{ color: '#C4432A', fontSize: 13, background: '#FBE7E4', padding: '8px 12px', borderRadius: 6 }}>
                  {saveError}
                </div>
              )}

              <div className={styles.ntField}>
                <span className={styles.ntLabel}>Title</span>
                <input
                  ref={titleInputRef}
                  className={styles.ntInput}
                  placeholder="Ticket title…"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  autoFocus
                />
              </div>

              <div className={styles.ntField}>
                <span className={styles.ntLabel}>Type</span>
                <div className={styles.typeButtonsGrid}>
                  {(['task', 'bug', 'feature', 'chore'] as IssueType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={`${styles.ntTypeBtn} ${type === t ? styles.ntTypeBtnActive : ''}`}
                      onClick={() => setType(t)}
                    >
                      <TicketTypeIcon type={t} size={14} />
                      {TYPE_CONFIG[t].label}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.ntField}>
                <span className={styles.ntLabel}>Description</span>
                <MarkdownEditor
                  value={description}
                  onChange={setDescription}
                  onUploadImage={async (f: File) => {
                    const res = await uploadDescriptionImage(f);
                    return { markdown: `![${f.name}](${res.url})` };
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: 20 }}>
                <div className={styles.ntField} style={{ flex: 1 }}>
                  <span className={styles.ntLabel}>Priority</span>
                  <div className={styles.priorityChips}>
                    {(['critical', 'high', 'medium', 'low'] as Priority[]).map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={`${styles.ntPriorityChip} ${priority === p ? styles.ntPriorityChipActive : ''}`}
                        onClick={() => setPriority(p)}
                      >
                        <PriorityMark priority={p} width={14} height={12} />
                        <span style={{ textTransform: 'capitalize' }}>{p}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.ntField}>
                  <span className={styles.ntLabel}>Estimate</span>
                  <div className={styles.estimateRow}>
                    {ESTIMATE_NUMBERS.map((sp) => (
                      <button
                        key={sp}
                        type="button"
                        className={`${styles.ntEstBtn} ${estimate === sp ? styles.ntEstBtnActive : ''}`}
                        onClick={() => setEstimate(estimate === sp ? null : sp)}
                      >
                        {sp}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 20 }}>
                <div className={styles.ntField} style={{ flex: 1 }}>
                  <span className={styles.ntLabel}>Assignee</span>
                  <select
                    className={styles.ntInput}
                    value={assignee ?? ''}
                    onChange={(e) => setAssignee(e.target.value || null)}
                  >
                    <option value="">Unassigned</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className={styles.ntField} style={{ flex: 1 }}>
                  <span className={styles.ntLabel}>Due Date</span>
                  <input
                    type="date"
                    className={styles.ntInput}
                    value={dueDate ?? ''}
                    onChange={(e) => setDueDate(e.target.value || null)}
                  />
                </div>
              </div>
            </div>

            <div className={styles.newModalFooter}>
              <button type="button" className={styles.btnCancel} onClick={handleClose}>
                Cancel
              </button>
              <button type="submit" className={styles.btnSubmit}>
                Create Ticket
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════
  // RENDER: VIEW MODE (Ticket Detail Panel)
  // ══════════════════════════════════════════════════════════════
  const rawBranches: TicketBranch[] = (ticketBranches.length > 0
    ? ticketBranches
    : (ticket?.branches && ticket.branches.length > 0)
      ? ticket.branches
      : []
  );

  const branchesList: TicketBranch[] = [
    ...(!rawBranches.some((b) => b.name === 'main' || b.status === 'baseline')
      ? [{
          id: 'baseline-main',
          name: 'main',
          status: 'baseline' as const,
          branchFrom: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }]
      : []),
    ...rawBranches,
  ];

  // Use the live list (git-refreshed) rather than ticket.branches, whose counts are stale
  const defaultBranch = branchesList.find(b => b.status !== 'baseline') || branchesList[0];
  const activeBranch = branchesList.find(b => b.name === selectedBranchName) || defaultBranch;
  const activeBranchName = activeBranch?.name ?? 'main';
  const activeBranchSubtext = activeBranch
    ? (activeBranch.status === 'baseline'
        ? 'baseline'
        : `from ${activeBranch.branchFrom || 'main'}${
            activeBranch.aheadCount !== undefined
              ? ` · ${activeBranch.aheadCount} ahead${activeBranch.behindCount ? `, ${activeBranch.behindCount} behind` : ''}`
              : ''
          }`)
    : 'from main';

  return (
    <div className={`${styles.overlay} ${visible ? styles.overlayVisible : ''}`} onClick={handleClose}>
      <div className={`${styles.panel} ${styles.panelDetail} ${visible ? styles.panelVisible : ''}`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.typeContainer} style={{ position: 'relative', cursor: 'pointer' }} title="Change ticket type">
              <TicketTypeIcon type={ticket.type} size={16} />
              <span>{TYPE_CONFIG[ticket.type].label}</span>
              <select
                className={styles.sidebarSelect}
                value={ticket.type}
                onChange={(e) => handleTypeChange(e.target.value as IssueType)}
              >
                <option value="task">Task</option>
                <option value="bug">Bug</option>
                <option value="feature">Feature</option>
                <option value="chore">Chore</option>
              </select>
            </div>

            <span className={styles.headerDivider} />

            {parentTicket && (
              <>
                <button
                  type="button"
                  className={styles.parentBtn}
                  onClick={() => onOpenTicket?.(parentTicket)}
                  title={`Parent: ${parentTicket.title}`}
                >
                  <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="#9AA8A0" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3.5 2.5V8A2.5 2.5 0 0 0 6 10.5H9.5" />
                    <path d="M7.5 8.5L10 11L7.5 13.5" />
                  </svg>
                  {parentTicket.id}
                </button>
                <span className={styles.slashSep}>/</span>
              </>
            )}

            {activeTab === 'branches' ? (
              <button
                type="button"
                className={styles.idBtn}
                onClick={() => setActiveTab('main')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#2E6F40', fontWeight: 600 }}
                title="Back to Details"
              >
                ← Back to {ticket.id}
              </button>
            ) : (
              <button
                type="button"
                className={styles.idBtn}
                onClick={activeTab !== 'main' ? () => setActiveTab('main') : handleCopyId}
                title={activeTab !== 'main' ? 'Back to Details' : 'Click to copy ID'}
              >
                {ticket.id}
              </button>
            )}
          </div>

          {/* View switcher tabs */}
          <div className={styles.headerViews}>
            <button
              type="button"
              className={`${styles.viewBtn} ${activeTab === 'test_cases' ? styles.viewBtnActive : ''}`}
              onClick={() => setActiveTab(activeTab === 'test_cases' ? 'main' : 'test_cases')}
              aria-label="Test Cases"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11L12 14L22 4" />
                <path d="M21 12V19A2 2 0 0 1 19 21H5A2 2 0 0 1 3 19V5A2 2 0 0 1 5 3H16" />
              </svg>
              {tcDotColor && <span className={styles.viewDot} style={{ background: tcDotColor }} />}
              <span className={styles.viewTooltip}>{tcTooltip}</span>
            </button>

            <button
              type="button"
              className={`${styles.viewBtn} ${activeTab === 'debug_space' ? styles.viewBtnActive : ''}`}
              onClick={() => setActiveTab(activeTab === 'debug_space' ? 'main' : 'debug_space')}
              aria-label="Debug Space"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M7 9L10 12L7 15" />
                <path d="M12 15H17" />
              </svg>
              {wlDotColor && <span className={styles.viewDot} style={{ background: wlDotColor }} />}
              <span className={styles.viewTooltip}>{wlTooltip}</span>
            </button>

            <button
              type="button"
              className={`${styles.viewBtn} ${activeTab === 'workspace' ? styles.viewBtnActive : ''}`}
              onClick={() => setActiveTab(activeTab === 'workspace' ? 'main' : 'workspace')}
              aria-label="Workspace"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7C3 5.9 3.9 5 5 5H9.2L11.2 7.5H19C20.1 7.5 21 8.4 21 9.5V17C21 18.1 20.1 19 19 19H5C3.9 19 3 18.1 3 17V7Z" />
              </svg>
              <span className={styles.viewTooltip}>Workspace</span>
            </button>

            <button
              type="button"
              className={`${styles.viewBtn} ${activeTab === 'branches' ? styles.viewBtnActive : ''}`}
              onClick={() => setActiveTab(activeTab === 'branches' ? 'main' : 'branches')}
              aria-label="Branches"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="6" r="2.5" />
                <circle cx="6" cy="18" r="2.5" />
                <circle cx="18" cy="6" r="2.5" />
                <path d="M6 8.5V15.5" />
                <path d="M8.5 6H13A5 5 0 0 1 18 11V15.5" />
              </svg>
              <span className={styles.viewTooltip}>Branches</span>
            </button>
          </div>

          <div className={styles.headerRight}>
            {onDelete && (
              <button
                type="button"
                className={styles.deleteHeaderBtn}
                aria-label="Delete ticket"
                title="Delete ticket"
                onClick={() => {
                  if (window.confirm(`Delete ${ticket.id}?`)) {
                    onDelete(ticket.id);
                    handleClose();
                  }
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                  <line x1="10" y1="11" x2="10" y2="17" />
                  <line x1="14" y1="11" x2="14" y2="17" />
                </svg>
              </button>
            )}

            <button type="button" aria-label="Close" className={styles.closeBtn} onClick={handleClose}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M6 6L18 18" />
                <path d="M18 6L6 18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        {activeTab === 'main' ? (
          <div className={styles.detailBody}>
            {/* Main Column */}
            <div className={styles.mainCol}>
              <>
                {/* Title & Tags */}
                <div className={styles.titleArea}>
                  {isEditingTitle ? (
                    <input
                      className={styles.titleInputEdit}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      onBlur={handleTitleBlur}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleTitleBlur();
                        if (e.key === 'Escape') {
                          setTitle(ticket.title);
                          setIsEditingTitle(false);
                        }
                      }}
                      autoFocus
                    />
                  ) : (
                    <h2 className={styles.titleText} onClick={() => setIsEditingTitle(true)} title="Click to edit">
                      {ticket.title}
                    </h2>
                  )}

                  <div className={styles.tagsRow}>
                    {tags.map((tag) => (
                      <TagPill
                        key={tag}
                        tag={tag}
                        onRemove={() => handleRemoveTag(tag)}
                      />
                    ))}

                    {isAddingTag ? (
                      <input
                        ref={tagInputRef}
                        className={styles.tagInput}
                        placeholder="Tag name…"
                        value={newTagText}
                        onChange={(e) => setNewTagText(e.target.value)}
                        onBlur={handleAddTagSubmit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleAddTagSubmit();
                          if (e.key === 'Escape') setIsAddingTag(false);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className={styles.tagAddBtn}
                        onClick={() => setIsAddingTag(true)}
                      >
                        <svg width="9" height="9" viewBox="0 0 12 12"><path d="M6 2V10M2 6H10" stroke="#9AA8A0" strokeWidth="1.6" strokeLinecap="round" /></svg>
                        Add tag
                      </button>
                    )}
                  </div>
                </div>

                {/* Description */}
                <div className={styles.descSection}>
                  <div className={styles.sectionLabel}>Description</div>
                  <MarkdownEditor
                    value={description}
                    onChange={(nextDesc) => {
                      setDescription(nextDesc);
                      autoSaveField('description', nextDesc);
                    }}
                    onUploadImage={async (f: File) => {
                      const res = await uploadDescriptionImage(f);
                      return { markdown: `![${f.name}](${res.url})` };
                    }}
                  />
                </div>

                {/* Sub-tasks */}
                <SubTicketsSection
                  childTickets={childTickets}
                  allTickets={allTickets}
                  currentTicketId={ticket.id}
                  projectId={ticket.projectId}
                  onOpenTicket={(child) => onOpenTicket?.(child)}
                  onLinkChild={(childId) => {
                    updateTicketMutation.mutate({
                      ticketId: childId,
                      data: { parentId: ticket.id },
                    });
                  }}
                  onUnlinkChild={(childId) => {
                    updateTicketMutation.mutate({
                      ticketId: childId,
                      data: { parentId: null },
                    });
                  }}
                />

                {/* Acceptance Criteria */}
                <AcceptanceCriteriaSection
                  acceptanceCriteria={ticket.acceptanceCriteria ?? []}
                  onAdd={(text) => {
                    addACMutation.mutate({ ticketId: ticket.id, text });
                  }}
                  onToggle={(id) => {
                    toggleACMutation.mutate({ ticketId: ticket.id, criterionId: id });
                  }}
                  onDelete={(id) => {
                    deleteACMutation.mutate({ ticketId: ticket.id, criterionId: id });
                  }}
                />

                {/* Relations */}
                <RelationsSection
                  ticket={ticket}
                  allTickets={allTickets}
                  onLinkBlock={(blockerId, blockedId) => {
                    linkBlockMutation.mutate({ blockerId, blockedId });
                  }}
                  onUnlinkBlock={(blockerId, blockedId) => {
                    unlinkBlockMutation.mutate({ blockerId, blockedId });
                  }}
                  onAddLink={(ticketId, targetId, relType) => {
                    addTicketLinkMutation.mutate({ ticketId, targetId, relationType: relType });
                  }}
                  onRemoveLink={(ticketId, linkId) => {
                    removeTicketLinkMutation.mutate({ ticketId, linkId });
                  }}
                  onOpenTicket={(relT) => onOpenTicket?.(relT)}
                />

                {/* Consolidated Attachments Zone */}
                {(() => {
                  const rawAttachments = (ticket.description?.match(/!\[(.*?)\]\((.*?)\)/g) ?? [])
                    .map((match) => {
                      const exec = /!\[(.*?)\]\((.*?)\)/.exec(match);
                      const alt = exec?.[1] || 'attachment';
                      const src = exec?.[2] || '';
                      return { alt, src };
                    })
                    .filter((att) => att.src && !att.src.startsWith('uploading:'));

                  return (
                    <div className={styles.attachmentsZone}>
                      <div className={styles.sectionLabel}>
                        ATTACHMENTS · {rawAttachments.length}
                      </div>
                      <div className={styles.attachmentsList}>
                        {rawAttachments.map((att, i) => {
                          const resolvedSrc = att.src.startsWith('/uploads/') ? `${resolveOrigin()}${att.src}` : att.src;
                          return (
                            <div key={i} className={styles.attThumbBox}>
                              <div
                                className={styles.attThumb}
                                onClick={() => window.open(resolvedSrc, '_blank')}
                                style={{ cursor: 'pointer' }}
                                title="Click to view full size"
                              >
                                <img src={resolvedSrc} alt={att.alt} />
                              </div>
                              <span className={styles.attMetaText}>in Description</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                <hr className={styles.sectionDivider} />

                {/* Comments */}
                <CommentsSection
                  comments={ticket.comments ?? []}
                  members={members}
                  currentMember={assigneeMember}
                  onAdd={(t) => addCommentMutation.mutate({ ticketId: ticket.id, text: t, author: assigneeMember?.name ?? 'An Nguyen' })}
                  onEdit={(cId, t) => updateCommentMutation.mutate({ ticketId: ticket.id, commentId: cId, text: t })}
                  onDelete={(cId) => deleteCommentMutation.mutate({ ticketId: ticket.id, commentId: cId })}
                />

                <hr className={styles.sectionDivider} />

                {/* Activity Log */}
                <ActivityLog entries={ticket.activityLog ?? []} />
              </>
          </div>

          {/* Right Meta Sidebar matching ticket-detail-4-sidebar.png */}
          <aside className={styles.sidebarCol}>
            {/* 1. Status */}
            <div className={styles.sidebarRow}>
              <span className={styles.sidebarLabel}>Status</span>
              <StatusMenu value={status} onChange={handleStatusChange} />
            </div>

            {/* 2. Branch */}
            <div className={styles.sidebarRow}>
              <span className={styles.sidebarLabel}>Branch</span>
              <div ref={branchContainerRef} style={{ position: 'relative', width: '100%' }}>
                <button
                  type="button"
                  className={`${styles.branchBtn} ${isBranchPopoverOpen ? styles.branchBtnActive : ''}`}
                  onClick={() => setIsBranchPopoverOpen((prev) => !prev)}
                  title={activeBranchName ? `Branch: ${activeBranchName}` : 'Branch: main'}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6D5DD3" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <circle cx="6" cy="6" r="2.5" />
                    <circle cx="6" cy="18" r="2.5" />
                    <circle cx="18" cy="6" r="2.5" />
                    <path d="M6 8.5V15.5" />
                    <path d="M8.5 6H13A5 5 0 0 1 18 11V15.5" />
                  </svg>
                  <span className={styles.branchText}>{activeBranchName}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#9AA8A0" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d={isBranchPopoverOpen ? "M6 15L12 9L18 15" : "M6 9L12 15L18 9"} />
                  </svg>
                </button>

              {/* Branch Switcher Popover */}
              {isBranchPopoverOpen && (
                <div className={styles.branchPopover}>
                  <div className={styles.branchPopoverHeader}>
                    Branches of {ticket.id}
                  </div>

                  <div className={styles.branchList}>
                    {branchesList.map((b) => {
                      const isActive = b.name === activeBranchName;
                      const dotColor =
                        b.status === 'baseline' ? '#2E6F40' :
                        b.status === 'merged' ? '#2F6FB0' :
                        b.status === 'stale' || b.status === 'archived' ? '#C4432A' : '#6D5DD3';
                      
                      const badgeClass =
                        b.status === 'baseline' ? styles.branchBadgeBaseline :
                        b.status === 'merged' ? styles.branchBadgeMerged :
                        b.status === 'stale' || b.status === 'archived' ? styles.branchBadgeStale : '';

                      return (
                        <button
                          key={b.id || b.name}
                          type="button"
                          className={`${styles.branchRow} ${isActive ? styles.branchRowActive : ''}`}
                          onClick={() => {
                            setSelectedBranchName(b.name);
                            setIsBranchPopoverOpen(false);
                            if (b.linkedTicketId && allTickets) {
                              const found = allTickets.find(t => t.id === b.linkedTicketId);
                              if (found) onOpenTicket?.(found);
                            }
                          }}
                        >
                          <span className={styles.branchDot} style={{ background: dotColor }} />
                          <span className={`${styles.branchRowName} ${isActive ? styles.branchRowNameActive : ''}`}>
                            {b.name}
                          </span>
                          {b.worktreePath && (
                            <span
                              className={styles.branchWorktreePill}
                              title={`Worktree: ${b.worktreePath}`}
                            >
                              🌳
                            </span>
                          )}
                          {isActive ? (
                            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
                              <circle cx="7" cy="7" r="6" stroke="#2E6F40" strokeWidth="1.4" />
                              <path d="M4.3 7.2L6.1 9L9.8 5" stroke="#2E6F40" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : (
                            b.status !== 'open' && (
                              <span className={`${styles.branchBadge} ${badgeClass}`}>
                                {b.status.charAt(0).toUpperCase() + b.status.slice(1)}
                              </span>
                            )
                          )}
                        </button>
                      );
                    })}
                  </div>

                  <div className={styles.branchCreateInline}>
                    <div style={{ fontSize: 11, color: '#9AA8A0', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span>
                        Git repo · {ticket.repoPath ? 'ticket override' : project?.repoPath ? 'from project' : 'not set'}
                      </span>
                      {!isEditingRepo && (
                        <button
                          type="button"
                          className={styles.branchCreateCancel}
                          onClick={() => {
                            setRepoPathDraft(ticket.repoPath ?? project?.repoPath ?? '');
                            setIsEditingRepo(true);
                          }}
                        >
                          {effectiveRepoPath ? 'Change' : 'Set'}
                        </button>
                      )}
                    </div>
                    {isEditingRepo ? (
                      <form
                        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                        onSubmit={(e) => {
                          e.preventDefault();
                          saveTicketRepo(repoPathDraft.trim() === (project?.repoPath ?? '') ? '' : repoPathDraft);
                        }}
                      >
                        <input
                          type="text"
                          className={styles.branchCreateInput}
                          placeholder="/path/to/repo"
                          value={repoPathDraft}
                          onChange={(e) => setRepoPathDraft(e.target.value)}
                          autoFocus
                        />
                        <div className={styles.branchCreateActions}>
                          {ticket.repoPath && (
                            <button
                              type="button"
                              className={styles.btnSec}
                              style={{ padding: '4px 8px', fontSize: 11 }}
                              onClick={() => saveTicketRepo('')}
                            >
                              Use project default
                            </button>
                          )}
                          <button
                            type="button"
                            className={styles.btnSec}
                            style={{ padding: '4px 8px', fontSize: 11 }}
                            onClick={() => setIsEditingRepo(false)}
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className={styles.btnPri}
                            style={{ padding: '4px 10px', fontSize: 11 }}
                            disabled={updateTicketMutation.isPending || !repoPathDraft.trim()}
                          >
                            Save
                          </button>
                        </div>
                      </form>
                    ) : (
                      <span className={styles.branchRowName} title={effectiveRepoPath ?? ''} style={{ fontSize: 11.5 }}>
                        {effectiveRepoPath ?? 'Branches are only stored on the board'}
                      </span>
                    )}
                  </div>

                  <div className={styles.branchPopoverFooter}>
                    <button
                      type="button"
                      className={styles.branchFooterBtn}
                      onClick={() => {
                        setIsBranchPopoverOpen(false);
                        setIsCreateBranchModalOpen(true);
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M12 5V19" />
                        <path d="M5 12H19" />
                      </svg>
                      Create branch
                    </button>
                    <button
                      type="button"
                      className={`${styles.branchFooterBtn} ${styles.branchFooterBtnGraph}`}
                      onClick={() => {
                        setIsBranchPopoverOpen(false);
                        setActiveTab('branches');
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="7" height="7" rx="1.5" />
                        <rect x="14" y="3" width="7" height="7" rx="1.5" />
                        <rect x="3" y="14" width="7" height="7" rx="1.5" />
                        <rect x="14" y="14" width="7" height="7" rx="1.5" />
                      </svg>
                      View full graph →
                    </button>
                  </div>
                </div>
              )}
            </div>
            <span className={styles.branchSubtext}>
              {activeBranchSubtext}
            </span>
          </div>

            {/* 3. Assignee */}
            <div className={styles.sidebarRow}>
              <span className={styles.sidebarLabel}>Assignee</span>
              <div className={styles.sidebarItemInteractive} title="Click to change assignee">
                {assigneeMember ? (
                  <>
                    <MemberAvatar member={assigneeMember} size={22} />
                    <span>{assigneeMember.name}</span>
                  </>
                ) : (
                  <span style={{ color: '#9AA8A0' }}>Unassigned</span>
                )}
                <select
                  className={styles.sidebarSelect}
                  value={assignee ?? ''}
                  onChange={(e) => handleAssigneeChange(e.target.value || null)}
                >
                  <option value="">Unassigned</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* 4. Priority */}
            <div className={styles.sidebarRow}>
              <span className={styles.sidebarLabel}>Priority</span>
              <div className={styles.sidebarItemInteractive} title="Click to change priority">
                <PriorityMark priority={priority} width={16} height={15} />
                <span style={{ textTransform: 'capitalize' }}>{priority}</span>
                <select
                  className={styles.sidebarSelect}
                  value={priority}
                  onChange={(e) => handlePriorityChange(e.target.value as Priority)}
                >
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>
            </div>

            {/* 5. Due Date */}
            <div className={styles.sidebarRow}>
              <span className={styles.sidebarLabel}>Due Date</span>
              <div
                className={styles.sidebarItemInteractive}
                title="Click to set due date"
                onClick={() => {
                  try {
                    dateInputRef.current?.showPicker?.();
                  } catch {
                    dateInputRef.current?.focus();
                  }
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B6B60" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3.5" y="5.5" width="17" height="15" rx="2.5" />
                  <path d="M3.5 10H20.5" />
                  <path d="M8 3V6.5" />
                  <path d="M16 3V6.5" />
                </svg>
                <span>{dueDate ? formatDueDate(dueDate) : 'Sep 24'}</span>
                <input
                  ref={dateInputRef}
                  type="date"
                  className={styles.invisibleDateInput}
                  value={dueDate ?? ''}
                  onChange={(e) => {
                    const next = e.target.value || null;
                    setDueDate(next);
                    autoSaveField('dueDate', next);
                  }}
                />
              </div>
            </div>

            {/* 6. Estimate */}
            <div className={styles.sidebarRow}>
              <span className={styles.sidebarLabel}>Estimate</span>
              <div className={styles.sidebarItemInteractive} title="Click to change estimate">
                <span>{estimate !== null ? `${estimate} pt` : '2 pt'}</span>
                <select
                  className={styles.sidebarSelect}
                  value={estimate ?? ''}
                  onChange={(e) => handleEstimateChange(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">–</option>
                  <option value="1">1 pt</option>
                  <option value="2">2 pt</option>
                  <option value="3">3 pt</option>
                  <option value="5">5 pt</option>
                  <option value="8">8 pt</option>
                  <option value="13">13 pt</option>
                </select>
              </div>
            </div>

            {/* 7. Divider */}
            <div className={styles.sidebarDivider} />

            {/* 8. Audit Metadata */}
            <div className={styles.auditMeta}>
              <div>
                Created {formatRelativeTime(ticket.createdAt)} by{' '}
                <span style={{ color: '#5B6B60', fontWeight: 500 }}>
                  {members.find((m) => m.id === ticket.createdBy)?.name || ticket.createdBy || 'Ha My'}
                </span>
              </div>
              <div>Updated {formatRelativeTime(ticket.updatedAt)}</div>
            </div>
          </aside>
        </div>
        ) : (
          <div className={styles.fullWidthBody}>
            {activeTab === 'test_cases' && (
              <TestCasesSection
                ticketId={ticket.id}
                testCases={ticket.testCases ?? []}
                childTestCaseSources={childTickets
                  .filter((st) => (st.testCases?.length ?? 0) > 0)
                  .map((st) => ({
                    ticketId: st.id,
                    ticketTitle: st.title,
                    testCases: st.testCases ?? [],
                  }))}
                disabled={addTestCaseMutation.isPending || updateTestCaseMutation.isPending || deleteTestCaseMutation.isPending}
                onAdd={(tCase) =>
                  new Promise<void>((resolve, reject) =>
                    addTestCaseMutation.mutate(
                      { ticketId: ticket.id, title: tCase },
                      {
                        onSuccess: () => resolve(),
                        onError: (err: unknown) => reject(err),
                      }
                    )
                  )
                }
                onChange={(updated) => {
                  const old = ticket.testCases ?? [];
                  const deletedIds = old
                    .filter((o) => !updated.some((u) => u.id === o.id))
                    .map((o) => o.id);
                  const changedItems = updated.filter((u) => {
                    const o = old.find((item) => item.id === u.id);
                    return o && JSON.stringify(o) !== JSON.stringify(u);
                  });
                  deletedIds.forEach((id) =>
                    deleteTestCaseMutation.mutate({ ticketId: ticket.id, testCaseId: id })
                  );
                  changedItems.forEach((tc) =>
                    updateTestCaseMutation.mutate({
                      ticketId: ticket.id,
                      testCaseId: tc.id,
                      data: {
                        title: tc.title,
                        status: tc.status,
                        description: tc.description,
                        expectedResult: tc.expectedResult,
                        notes: tc.notes,
                        startedAt: tc.startedAt,
                        assignee: tc.assignee,
                        testDataFiles: tc.testDataFiles,
                        proof: tc.proof ?? null,
                        note: tc.note ?? null,
                      },
                    })
                  );
                }}
              />
            )}
            {activeTab === 'debug_space' && (
              <DebugSpaceSection
                ticketId={ticket.id}
                entries={ticket.workLog ?? []}
                onAdd={async (entry) => {
                  await addWorkLogMutation.mutateAsync({
                    ticketId: ticket.id,
                    data: entry,
                  });
                }}
                onUpdate={(entryId, data) =>
                  updateWorkLogMutation.mutate({
                    ticketId: ticket.id,
                    entryId,
                    data,
                  })
                }
                onDelete={(entryId) =>
                  deleteWorkLogMutation.mutate({
                    ticketId: ticket.id,
                    entryId,
                  })
                }
              />
            )}
            {activeTab === 'workspace' && (
              <WorkspaceSection ticketId={ticket.id} />
            )}
            {activeTab === 'branches' && (
              <BranchesSection ticketId={ticket.id} />
            )}
          </div>
        )}

        <CreateBranchModal
          isOpen={isCreateBranchModalOpen}
          onClose={() => setIsCreateBranchModalOpen(false)}
          ticketId={ticket.id}
          branches={branchesList}
          initialBranchFrom={activeBranch?.inRepo === false ? 'main' : (activeBranchName || 'main')}
          defaultWorktreeTemplate={project?.worktreeTemplate}
          defaultWorktreeEnabled={project?.worktreeByDefault}
          projectPrefix={project?.prefix}
          hasRepoLinked={Boolean(effectiveRepoPath)}
          onSuccess={(newBranch) => {
            setSelectedBranchName(newBranch);
          }}
        />
      </div>
    </div>
  );
}
