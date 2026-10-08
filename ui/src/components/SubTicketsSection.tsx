import { useEffect, useRef, useState } from 'react';
import type { Member, Ticket } from '../types';
import { useCreateTicket } from '../api/tickets';
import { TicketTypeIcon } from './icons';
import { MemberAvatar } from './MemberAvatar';
import styles from './SubTicketsSection.module.css';

interface SubTicketRow {
  ticket: Ticket;
  /** Execution wave: 1 + the deepest chain of sibling blockers. */
  wave: number;
  /** First sibling that blocks this one and is not done yet. */
  openBlocker: Ticket | null;
}

/**
 * Orders sub-tickets by execution wave, derived from their `blockedBy` links to
 * each other: tickets with no sibling blockers are wave 1, everything else waits
 * one wave after its latest blocker. Ties keep their original order.
 */
function buildRows(children: Ticket[]): SubTicketRow[] {
  const byId = new Map(children.map((t) => [t.id, t]));
  const waves = new Map<string, number>();

  function waveOf(ticket: Ticket, trail: Set<string>): number {
    const known = waves.get(ticket.id);
    if (known !== undefined) return known;
    if (trail.has(ticket.id)) return 1; // circular blockers: stop descending
    trail.add(ticket.id);
    let wave = 1;
    for (const blockerId of ticket.blockedBy ?? []) {
      const blocker = byId.get(blockerId);
      if (blocker) wave = Math.max(wave, waveOf(blocker, trail) + 1);
    }
    trail.delete(ticket.id);
    waves.set(ticket.id, wave);
    return wave;
  }

  return children
    .map((ticket, index) => ({
      index,
      ticket,
      wave: waveOf(ticket, new Set()),
      openBlocker:
        (ticket.blockedBy ?? [])
          .map((id) => byId.get(id))
          .find((blocker): blocker is Ticket => !!blocker && blocker.status !== 'done') ?? null,
    }))
    .sort((a, b) => a.wave - b.wave || a.index - b.index)
    .map(({ ticket, wave, openBlocker }) => ({ ticket, wave, openBlocker }));
}

interface SubTicketsSectionProps {
  childTickets: Ticket[];
  allTickets: Ticket[];
  currentTicketId: string;
  projectId: string;
  members?: Member[];
  onOpenTicket: (ticket: Ticket) => void;
  onLinkChild: (childId: string) => void;
  onUnlinkChild: (childId: string) => void;
}

/**
 * Ticket's sub-tickets and sub-tasks.
 * @param props.childTickets - Tickets already linked as children.
 * @param props.allTickets - All project tickets, offered as link candidates.
 * @param props.currentTicketId - Parent ticket, excluded from the candidates.
 * @param props.onOpenTicket - Called with a child ticket when it is opened.
 * @param props.onLinkChild - Called with the id of a ticket to attach as a child.
 * @param props.onUnlinkChild - Called with the id of a child to detach.
 */
export function SubTicketsSection({
  childTickets,
  allTickets,
  currentTicketId,
  projectId,
  members = [],
  onOpenTicket,
  onLinkChild,
  onUnlinkChild,
}: SubTicketsSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<'new' | 'existing'>('new');
  const [newTitle, setNewTitle] = useState('');
  const [search, setSearch] = useState('');

  const createTicketMutation = useCreateTicket(projectId);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const doneCount = childTickets.filter((t) => t.status === 'done').length;
  const totalCount = childTickets.length;
  const progressPercent = totalCount > 0 ? (doneCount / totalCount) * 100 : 0;

  const rows = buildRows(childTickets);
  const childIds = new Set(childTickets.map((t) => t.id));

  // Eligible for linking: same project, not current, not already a child, has no parent, and has no children of its own
  const eligible = allTickets.filter((t) => {
    if (t.id === currentTicketId) return false;
    if (childIds.has(t.id)) return false;
    if (t.parentId != null) return false;
    const hasChildren = allTickets.some((other) => other.parentId === t.id);
    if (hasChildren) return false;
    return true;
  });

  const q = search.toLowerCase();
  const filtered = eligible.filter((t) => !q || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));

  useEffect(() => {
    if (isExpanded) {
      if (activeTab === 'new') {
        titleInputRef.current?.focus();
      } else {
        searchInputRef.current?.focus();
      }
    }
  }, [isExpanded, activeTab]);

  function handleCreate(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    createTicketMutation.mutate(
      {
        title: trimmed,
        type: 'task',
        priority: 'medium',
        status: 'backlog',
        parentId: currentTicketId,
      },
      {
        onSuccess: () => {
          setNewTitle('');
          titleInputRef.current?.focus();
        },
      },
    );
  }

  function handleLink(id: string) {
    onLinkChild(id);
    setSearch('');
    setIsExpanded(false);
  }

  function handleCancel() {
    setIsExpanded(false);
    setNewTitle('');
    setSearch('');
  }

  return (
    <div className={styles.section}>
      <div className={styles.headerRow}>
        <span className={styles.label}>SUB-TICKETS{totalCount > 0 ? ` · ${totalCount}` : ''}</span>
        {totalCount > 0 && (
          <>
            <div className={styles.progressBarTrack}>
              <div className={styles.progressBarFill} style={{ width: `${progressPercent}%` }} />
            </div>
            <span className={styles.progressCount}>
              {doneCount}/{totalCount} done
            </span>
          </>
        )}
      </div>

      {totalCount > 0 && (
        <>
          <div className={styles.cardContainer}>
            {rows.map(({ ticket, wave, openBlocker }) => {
              const isDone = ticket.status === 'done';
              const isInProgress = ticket.status === 'in-progress';
              const assignee = members.find((m) => m.id === ticket.assignee);
              const waveClass = isDone ? styles.waveDone : openBlocker ? styles.waveBlocked : styles.waveReady;

              return (
                <div key={ticket.id} className={`${styles.row} ${isInProgress ? styles.rowActive : ''}`}>
                  <span className={`${styles.waveBadge} ${waveClass}`} title={`Execution wave ${wave}`}>
                    {wave}
                  </span>

                  {isDone ? (
                    <svg className={styles.statusIconDone} viewBox="0 0 14 14" fill="none">
                      <circle cx="7" cy="7" r="6" stroke="#2E6F40" strokeWidth="1.6" />
                      <path
                        d="M4.3 7.2L6.1 9L9.8 5"
                        stroke="#2E6F40"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : isInProgress ? (
                    <div className={styles.statusIconInProgress} />
                  ) : (
                    <div className={styles.statusIconOpen} />
                  )}

                  <TicketTypeIcon type={ticket.type} size={14} />

                  <div className={styles.titleCol}>
                    <span
                      className={
                        isDone
                          ? styles.ticketTitleDone
                          : isInProgress
                            ? styles.ticketTitleInProgress
                            : styles.ticketTitleOpen
                      }
                      onClick={() => onOpenTicket(ticket)}
                    >
                      {ticket.title}
                    </span>
                    {openBlocker && !isDone && (
                      <span className={styles.blockedChip}>
                        <svg
                          width="9"
                          height="9"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#C4432A"
                          strokeWidth="2.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect x="5" y="11" width="14" height="9" rx="2" />
                          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                        </svg>
                        Blocked by {openBlocker.id}
                      </span>
                    )}
                  </div>

                  {assignee && <MemberAvatar member={assignee} size={18} />}

                  <span className={`${styles.ticketId} ${isDone ? styles.ticketIdDone : ''}`}>{ticket.id}</span>

                  <button
                    type="button"
                    className={styles.unlinkBtn}
                    onClick={() => onUnlinkChild(ticket.id)}
                    title="Remove from sub-tickets"
                    aria-label="Remove sub-ticket"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    >
                      <path d="M6 6L18 18" />
                      <path d="M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
          <div className={styles.captionText}>
            Circled number = execution wave, read top to bottom — same number can be worked in parallel, the next number
            waits on that wave&apos;s blockers to clear. The red chip flags a sub-ticket that can&apos;t start yet
            because another one isn&apos;t done.
          </div>
        </>
      )}

      {isExpanded ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className={styles.expandedBox}>
            <div className={styles.tabsRow}>
              <button
                type="button"
                className={`${styles.tab} ${activeTab === 'new' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('new')}
              >
                New
              </button>
              <button
                type="button"
                className={`${styles.tab} ${activeTab === 'existing' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('existing')}
              >
                Existing
              </button>
            </div>

            {activeTab === 'new' ? (
              <form onSubmit={handleCreate} className={styles.inputRow}>
                <div
                  style={{
                    width: 15,
                    height: 15,
                    borderRadius: '50%',
                    border: '1.6px solid #C7D2CB',
                    boxSizing: 'border-box',
                    flexShrink: 0,
                  }}
                />
                <input
                  ref={titleInputRef}
                  className={styles.newInput}
                  placeholder="Sub-ticket title…"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') handleCancel();
                  }}
                />
                <button type="button" className={styles.actionBtnCancel} onClick={handleCancel} aria-label="Cancel">
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M6 6L18 18" />
                    <path d="M18 6L6 18" />
                  </svg>
                </button>
                <button type="submit" className={styles.actionBtnCreate} aria-label="Create sub-ticket">
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#FFFFFF"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 13L10 18L19 6" />
                  </svg>
                </button>
              </form>
            ) : (
              <div>
                <div className={styles.searchRow}>
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#9AA8A0"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="M21 21L16.5 16.5" />
                  </svg>
                  <input
                    ref={searchInputRef}
                    className={styles.searchInput}
                    placeholder="Search tickets…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') handleCancel();
                    }}
                  />
                  <button type="button" className={styles.actionBtnCancel} onClick={handleCancel} aria-label="Cancel">
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    >
                      <path d="M6 6L18 18" />
                      <path d="M18 6L6 18" />
                    </svg>
                  </button>
                </div>

                <div className={styles.resultsList}>
                  {filtered.length === 0 ? (
                    <div style={{ padding: '8px 10px', fontSize: 12, color: '#9AA8A0', fontStyle: 'italic' }}>
                      No matching tickets
                    </div>
                  ) : (
                    filtered.slice(0, 6).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={styles.resultItem}
                        onClick={() => handleLink(item.id)}
                      >
                        <TicketTypeIcon type={item.type} size={14} />
                        <span className={styles.resultTitle}>{item.title}</span>
                        <span className={styles.resultId}>{item.id}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          <div className={styles.helperText}>
            {activeTab === 'new'
              ? 'Enter to create and add another · Esc to cancel'
              : 'Already-linked tickets are filtered out'}
          </div>
        </div>
      ) : (
        <button type="button" className={styles.addDashedBtn} onClick={() => setIsExpanded(true)}>
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M12 5V19" />
            <path d="M5 12H19" />
          </svg>
          Add sub-ticket
        </button>
      )}
    </div>
  );
}
