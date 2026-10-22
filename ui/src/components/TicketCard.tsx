import { useState, useRef, useEffect } from 'react';
import type { IssueType, Member, Ticket } from '../types';
import { MemberAvatar } from './MemberAvatar';
import { TagPill } from './TagPill';
import { TicketTypeIcon, PriorityMark } from './icons';
import styles from './TicketCard.module.css';
import { createPortal } from 'react-dom';
import { HoverTip } from './HoverTip';
import { STATUS_NAMES } from '../hooks/useMarkerActions';

const TYPE_LABELS: Record<IssueType, string> = {
  bug: 'Bug',
  feature: 'Feature',
  task: 'Task',
  chore: 'Chore',
};

function getDueDateDisplay(dueDate: string | null): { label: string; overdue: boolean } | null {
  if (!dueDate) return null;
  const due = new Date(dueDate);
  if (isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const overdue = due < today;
  const label = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return { label, overdue };
}

interface TicketCardProps {
  ticket: Ticket;
  allTickets?: Ticket[];
  memberMap?: Map<string, Member>;
  isDragging?: boolean;
  className?: string;
  onClick?: () => void;
  subtaskStats?: { total: number; completed: number };
  onReopen?: (ticket: Ticket) => void;
  onPending?: (ticket: Ticket) => void;
  onResume?: (ticket: Ticket) => void;
  onDelete?: (ticket: Ticket) => void;
}

/**
 * Pixel-perfect TicketCard strictly matching TicketPending.dc.html (C1, C2) and TicketReopen.dc.html (C1, C2).
 */
export function TicketCard({
  ticket,
  allTickets = [],
  memberMap,
  isDragging,
  className,
  onClick,
  subtaskStats,
  onReopen,
  onPending,
  onResume,
  onDelete,
}: TicketCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [dismissPrompt, setDismissPrompt] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [menuOpen]);

  const typeLabel = TYPE_LABELS[ticket.type] ?? 'Task';
  const due = getDueDateDisplay(ticket.dueDate);
  const assigneeMember = ticket.assignee && memberMap ? memberMap.get(ticket.assignee) : null;
  // A pending ticket shows one signal: the pending chip replaces the blocked lock (TicketPending I)
  const isBlocked = (ticket.blockedBy ?? []).length > 0 && !ticket.pending;
  const isClosed = ticket.status === 'done' || ticket.status === 'wont_do';
  const isDone = ticket.status === 'done';
  const isReopened = (ticket.reopenCount ?? 0) > 0 && !isClosed;
  const isPending = !!ticket.pending;
  const hasSubtasks = subtaskStats && subtaskStats.total > 0;

  // E1 Blocker Done prompt condition
  const blockerTicket =
    isPending && ticket.pendingReasonType === 'ticket' && ticket.pendingTicketId
      ? allTickets.find((t) => t.id === ticket.pendingTicketId)
      : null;
  const isBlockerDone = blockerTicket && blockerTicket.status === 'done' && !dismissPrompt;
  // E3: the blocker went to Won't Do / the Recycle Bin, or was deleted; the flag stays until a person acts
  const blockerGone =
    isPending &&
    ticket.pendingReasonType === 'ticket' &&
    !!ticket.pendingTicketId &&
    allTickets.length > 0 &&
    !dismissPrompt &&
    (blockerTicket ? blockerTicket.status === 'wont_do' : !allTickets.some((t) => t.id === ticket.pendingTicketId));
  const pendingChildren = allTickets.filter((t) => t.parentId === ticket.id && t.pending);

  const cardClasses = [
    styles.card,
    isDragging ? styles.cardDragging : '',
    isBlocked ? styles.cardBlocked : '',
    isPending ? styles.cardPending : '',
    isReopened ? styles.cardReopened : '',
    isDone ? styles.cardDone : '',
    hasSubtasks ? styles.cardParent : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const visibleTags = (ticket.tags ?? []).slice(0, 3);
  const overflowCount = (ticket.tags ?? []).length - visibleTags.length;

  const pendingTargetLabel =
    ticket.pendingReasonType === 'ticket'
      ? ticket.pendingTicketId
        ? ticket.pendingTicketId
        : 'Ticket'
      : ticket.pendingParty ||
        (ticket.pendingMemberId && memberMap?.get(ticket.pendingMemberId)?.name) ||
        ticket.pendingMemberId ||
        'Party';

  const fmtDay = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const who = (name?: string | null) => (name === 'user' ? 'You' : name === 'agent' ? 'AI agent' : (name ?? 'Someone'));

  // Hover tooltip of the Reopened badge (TicketReopen C1): who, when, why, and the reopen before
  const previousReopen = (ticket.reopenHistory ?? [])[1];
  const tipHead = { fontWeight: 700, fontSize: 12.5 } as const;
  const tipMuted = {
    color: '#A9B8AE',
    borderTop: '1px solid rgba(255,255,255,0.14)',
    paddingTop: 4,
    marginTop: 2,
  } as const;
  const reopenTip = (
    <>
      <span style={tipHead}>Reopened {ticket.reopenCount || 1}x</span>
      <span>
        {who(ticket.lastReopenedBy)}
        {ticket.lastReopenedAt ? `, ${fmtDay(ticket.lastReopenedAt)}` : ''}
      </span>
      {ticket.lastReopenReason && <span>&ldquo;{ticket.lastReopenReason}&rdquo;</span>}
      {previousReopen && (
        <span style={tipMuted}>
          Before: {who(previousReopen.actor)}, {fmtDay(previousReopen.at)}
        </span>
      )}
    </>
  );

  // Hover tooltip of the Pending strip (TicketPending C1/C2), with the live status of a ticket blocker
  const pendingTip = (
    <>
      <span style={tipHead}>Pending</span>
      <span>
        Waiting on{' '}
        <b style={ticket.pendingReasonType === 'ticket' ? { fontFamily: "'JetBrains Mono', monospace" } : undefined}>
          {pendingTargetLabel}
        </b>
        {blockerTicket ? <> - {blockerTicket.title}</> : null}
      </span>
      {ticket.pendingNote && <span>&ldquo;{ticket.pendingNote}&rdquo;</span>}
      <span style={tipMuted}>
        Set by {who(ticket.pendingBy)}
        {ticket.pendingSince ? ` on ${fmtDay(ticket.pendingSince)}` : ''}
      </span>
      {blockerTicket && (
        <span style={tipMuted}>
          {STATUS_NAMES[blockerTicket.status] ?? blockerTicket.status} - live status of {blockerTicket.id}
        </span>
      )}
    </>
  );

  function handleMenuClick(e: React.MouseEvent) {
    e.stopPropagation();
    // The menu is portalled to the page, so a narrow column never clips it; right edge aligned to the button
    const r = e.currentTarget.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.right - 224, window.innerWidth - 232)) });
    setMenuOpen((prev) => !prev);
  }

  function copyTicketLink(e: React.MouseEvent) {
    e.stopPropagation();
    const url = `${window.location.origin}/#ticket-${ticket.id}`;
    navigator.clipboard.writeText(url);
    setMenuOpen(false);
  }

  return (
    <div className={cardClasses} onClick={onClick} data-ticket-id={ticket.id}>
      {/* Striped rail for pending cards matching TicketPending.dc.html C1 */}
      {isPending && <div className={styles.pendingRail} />}

      {/* Floating Blocked Badge */}
      {isBlocked && (
        <div className={styles.blockedBadge} title={`Blocked by ${ticket.blockedBy.join(', ')}`} aria-label="Blocked">
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
            <rect x="3" y="6.5" width="8" height="6" rx="1.3" stroke="#C4432A" strokeWidth="1.4" />
            <path d="M4.6 6.5V4.8A2.4 2.4 0 0 1 9.4 4.8V6.5" stroke="#C4432A" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </div>
      )}

      {/* Card ... Context Menu button matching TicketPending.dc.html A1 */}
      <div className={styles.menuButton} onClick={handleMenuClick} title="Card options">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="#5B6B60" style={{ flexShrink: 0 }}>
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>

        {/* Dropdown Menu */}
        {menuOpen &&
          menuPos &&
          createPortal(
            <div
              ref={menuRef}
              className={styles.menuDropdown}
              style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, right: 'auto' }}
              onClick={(e) => e.stopPropagation()}
            >
              {isClosed ? (
                /* A2 · Card menu in closed column (Reopen ticket) */
                <>
                  <button
                    type="button"
                    className={`${styles.menuItem} ${styles.menuItemReopen}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                      onReopen?.(ticket);
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#C77700"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flexShrink: 0 }}
                    >
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                    <span>Reopen ticket</span>
                    <span className={styles.menuShortcut}>R</span>
                  </button>
                  <div className={styles.menuDivider} />
                </>
              ) : isPending ? (
                /* A1 · Card menu, pending ticket (Resume ticket, Change reason...) */
                <>
                  <button
                    type="button"
                    className={`${styles.menuItem} ${styles.menuItemResume}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                      onResume?.(ticket);
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#2E6F40"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flexShrink: 0 }}
                    >
                      <path d="M7.5 4.8V19.2L19 12Z" />
                    </svg>
                    <span>Resume ticket</span>
                    <span className={styles.menuShortcut}>P</span>
                  </button>
                  <button
                    type="button"
                    className={styles.menuItem}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                      onPending?.(ticket);
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#3A4A3E"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flexShrink: 0 }}
                    >
                      <path d="M4 20H8L19 9L15 5L4 16Z" />
                    </svg>
                    <span>Change reason...</span>
                  </button>
                  <div className={styles.menuDivider} />
                </>
              ) : (
                /* A1 · Card menu, open ticket (Mark as pending...) */
                <>
                  <button
                    type="button"
                    className={`${styles.menuItem} ${styles.menuItemPending}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                      onPending?.(ticket);
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#5B6F86"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flexShrink: 0 }}
                    >
                      <path d="M8.5 5.5V18.5" />
                      <path d="M15.5 5.5V18.5" />
                    </svg>
                    <span>Mark as pending...</span>
                    <span className={styles.menuShortcut}>P</span>
                  </button>
                  <div className={styles.menuDivider} />
                </>
              )}

              <button
                type="button"
                className={styles.menuItem}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onClick?.();
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#3A4A3E"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M14 3H21V10" />
                  <path d="M21 3L11 13" />
                  <path d="M19 14V19A2 2 0 0 1 17 21H5A2 2 0 0 1 3 19V7A2 2 0 0 1 5 5H10" />
                </svg>
                <span>Open ticket</span>
              </button>
              <button type="button" className={styles.menuItem} onClick={copyTicketLink}>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#3A4A3E"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
                  <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
                </svg>
                <span>Copy link</span>
              </button>
              <div className={styles.menuDivider} />
              <button
                type="button"
                className={styles.menuItem}
                style={{ color: '#C4432A' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onDelete?.(ticket);
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#C4432A"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M3 6H21" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <path d="M19 6L18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                </svg>
                <span>Move to Recycle Bin</span>
              </button>
            </div>,
            document.body,
          )}
      </div>

      <div className={styles.cardContent}>
        {/* Header: Type icon + label, Reopened badge, Pending chip, ID */}
        <div className={styles.cardHeader}>
          <div className={styles.typeContainer}>
            <TicketTypeIcon type={ticket.type} size={15} />
            <span className={styles.typeLabel}>{typeLabel}</span>

            {/* Reopened badge matching TicketReopen.dc.html C1 */}
            {isReopened && (
              <HoverTip className={styles.reopenedBadge} tip={reopenTip}>
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#C77700"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
                <span className={styles.badgeLabel}>Reopened</span>
                {(ticket.reopenCount ?? 0) > 1 && <span className={styles.reopenedCount}>x{ticket.reopenCount}</span>}
              </HoverTip>
            )}

            {/* Pending chip matching TicketPending.dc.html C1/C2 */}
            {isPending && (
              <HoverTip className={styles.pendingChip} tip={pendingTip}>
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#5B6F86"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M8.5 5.5V18.5" />
                  <path d="M15.5 5.5V18.5" />
                </svg>
                <span className={styles.badgeLabel}>Pending</span>
              </HoverTip>
            )}
          </div>

          <div className={styles.headerRight}>
            <span className={styles.cardId}>{ticket.id}</span>
            <span className={styles.dragHandle} aria-hidden="true">
              <svg width="10" height="14" viewBox="0 0 10 16" fill="#B7C4BC">
                <circle cx="2" cy="2" r="1.3" />
                <circle cx="8" cy="2" r="1.3" />
                <circle cx="2" cy="8" r="1.3" />
                <circle cx="8" cy="8" r="1.3" />
                <circle cx="2" cy="14" r="1.3" />
                <circle cx="8" cy="14" r="1.3" />
              </svg>
            </span>
          </div>
        </div>

        {/* Title: 2-line clamped */}
        <div className={styles.cardTitle}>{ticket.title}</div>

        {/* Parent chip & Tags row */}
        {(ticket.parentId || visibleTags.length > 0) && (
          <div className={styles.tagsRow}>
            {ticket.parentId && (
              <span className={styles.parentChip} title={`Sub-ticket of ${ticket.parentId}`}>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="#9AA8A0"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3.5 2.5V8A2.5 2.5 0 0 0 6 10.5H9.5" />
                  <path d="M7.5 8.5L10 11L7.5 13.5" />
                </svg>
                {ticket.parentId}
              </span>
            )}
            {visibleTags.map((tag, idx) => (
              <TagPill key={`${tag}-${idx}`} tag={tag} size="small" />
            ))}
            {overflowCount > 0 && <span className={styles.tagOverflow}>+{overflowCount}</span>}
          </div>
        )}

        {/* Sub-tasks progress bar for parent tickets */}
        {hasSubtasks && subtaskStats && (
          <div className={styles.subtaskProgressBar}>
            <div className={styles.subtaskTrack}>
              <div
                className={styles.subtaskFill}
                style={{
                  width: `${Math.round((subtaskStats.completed / subtaskStats.total) * 100)}%`,
                }}
              />
            </div>
            <span className={styles.subtaskText}>
              {subtaskStats.completed}/{subtaskStats.total} sub-tasks
            </span>
          </div>
        )}

        {/* Pending reason strip matching TicketPending.dc.html C1 */}
        {isPending && (
          <HoverTip as="div" className={styles.pendingStrip} tip={pendingTip}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#5B6F86"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <path d="M8.5 5.5V18.5" />
              <path d="M15.5 5.5V18.5" />
            </svg>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
              Waiting on{' '}
              <span
                style={{
                  fontFamily: ticket.pendingReasonType === 'ticket' ? "'JetBrains Mono', monospace" : 'inherit',
                  fontWeight: 700,
                }}
              >
                {pendingTargetLabel}
              </span>
            </span>
          </HoverTip>
        )}

        {/* A parent shows a count of its pending sub-tasks, never the flag itself (TicketPending E5) */}
        {pendingChildren.length > 0 && !isPending && (
          <div className={styles.pendingStrip}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#5B6F86"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <path d="M8.5 5.5V18.5" />
              <path d="M15.5 5.5V18.5" />
            </svg>
            <span>
              {pendingChildren.length} pending sub-{pendingChildren.length === 1 ? 'task' : 'tasks'}
            </span>
          </div>
        )}

        {/* E3 Blocker Won't Do or deleted: amber prompt */}
        {blockerGone && (
          <div className={styles.blockerGonePrompt} onClick={(e) => e.stopPropagation()}>
            <span className={styles.blockerDoneText}>
              <strong>Blocker removed</strong>
              <br />
              <strong style={{ fontFamily: "'JetBrains Mono', monospace" }}>{ticket.pendingTicketId}</strong> was{' '}
              {blockerTicket ? "moved to Won't Do" : 'deleted'}. This ticket is still pending on it.
            </span>
            <div className={styles.blockerDoneButtons}>
              <button
                type="button"
                className={styles.blockerGoneBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onResume?.(ticket);
                }}
              >
                Resume
              </button>
              <button
                type="button"
                className={styles.blockerGoneBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onPending?.(ticket);
                }}
              >
                Change reason
              </button>
            </div>
          </div>
        )}

        {/* E1 Auto behaviour: Blocker Done prompt on card */}
        {isBlockerDone && (
          <div className={styles.blockerDonePrompt} onClick={(e) => e.stopPropagation()}>
            <span className={styles.blockerDoneText}>
              <strong style={{ fontFamily: "'JetBrains Mono', monospace" }}>{ticket.pendingTicketId}</strong> is done.
              Resume <strong style={{ fontFamily: "'JetBrains Mono', monospace" }}>{ticket.id}</strong>?
            </span>
            <div className={styles.blockerDoneButtons}>
              <button
                type="button"
                className={styles.blockerDoneBtnResume}
                onClick={(e) => {
                  e.stopPropagation();
                  onResume?.(ticket);
                }}
              >
                Resume
              </button>
              <button
                type="button"
                className={styles.blockerDoneBtnKeep}
                onClick={(e) => {
                  e.stopPropagation();
                  setDismissPrompt(true);
                }}
              >
                Keep pending
              </button>
            </div>
          </div>
        )}

        {/* Footer: Assignee, Priority, Estimate, AC count, Due date */}
        <div className={styles.cardFooter}>
          {assigneeMember ? (
            <MemberAvatar member={assigneeMember} size={20} />
          ) : (
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: '#EEF3EF',
                border: '1px dashed #C7D2CB',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 10,
                color: '#9AA8A0',
              }}
            >
              ?
            </div>
          )}

          <PriorityMark priority={ticket.priority} />

          <div className={styles.footerSpacer} />

          {ticket.estimate && <span className={styles.estimate}>{ticket.estimate} pt</span>}

          {due && (
            <span className={due.overdue ? styles.dueDateOverdue : styles.dueDate}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3.5" y="5.5" width="17" height="15" rx="2.5" />
                <path d="M3.5 10H20.5" />
                <path d="M8 3V6.5" />
                <path d="M16 3V6.5" />
              </svg>
              {due.label}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
