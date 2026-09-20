import { useEffect, useMemo, useRef, useState } from 'react';
import type { IssueType, Member, Ticket } from '../types';
import { useCreateTicket } from '../api/tickets';
import { StatusMark, TypeIcon } from './ticketVisuals';
import { STATUS_DOT_COLORS } from './StatusMenu';
import { MemberAvatar } from './MemberAvatar';
import styles from './SubTicketsSection.module.css';

// Mirrors TicketCard.tsx's TYPE_CONFIG color-only, so sub-ticket rows' type
// icons stay visually consistent with the rest of the app.
const TYPE_ICON_COLOR: Record<IssueType, string> = {
  bug: 'var(--color-danger)',
  feature: 'var(--color-purple)',
  task: 'var(--color-blue)',
  chore: 'var(--color-text-secondary)',
};

type AddTab = 'new' | 'existing';

// Execution wave (topological level) of each child ticket, computed purely
// client-side from the Blocked by graph restricted to this sibling group.
// Wave 1 = no in-group blockers; wave N = 1 + max wave of its in-group blockers.
// Ticket rows are NOT reordered by wave (only visually badged) — see WaveState below.
function computeWaves(childTickets: Ticket[]): Map<string, number> {
  const idSet = new Set(childTickets.map((t) => t.id));
  const waves = new Map<string, number>();

  function waveOf(id: string, guard: Set<string>): number {
    const cached = waves.get(id);
    if (cached != null) return cached;
    if (guard.has(id)) return 1; // cycle guard: treat as wave 1 rather than recursing forever
    guard.add(id);
    const ticket = childTickets.find((t) => t.id === id);
    const blockers = (ticket?.blockedBy ?? []).filter((b) => idSet.has(b) && b !== id);
    const wave = blockers.length === 0
      ? 1
      : 1 + Math.max(...blockers.map((b) => waveOf(b, guard)));
    waves.set(id, wave);
    return wave;
  }

  for (const t of childTickets) waveOf(t.id, new Set());
  return waves;
}

type WaveState = 'done' | 'current' | 'future';

// A wave is "done" once every ticket in it is done, "current" once it's the
// lowest-numbered wave that still has non-done work (the active front line),
// and "future" otherwise (blocked behind an earlier, unfinished wave).
function computeWaveStates(childTickets: Ticket[], waves: Map<string, number>): Map<number, WaveState> {
  const byWave = new Map<number, Ticket[]>();
  for (const t of childTickets) {
    const w = waves.get(t.id) ?? 1;
    if (!byWave.has(w)) byWave.set(w, []);
    byWave.get(w)!.push(t);
  }
  const states = new Map<number, WaveState>();
  const sortedWaveNums = [...byWave.keys()].sort((a, b) => a - b);
  let frontLineFound = false;
  for (const w of sortedWaveNums) {
    const tickets = byWave.get(w)!;
    const allDone = tickets.every((t) => t.status === 'done');
    if (allDone) {
      states.set(w, 'done');
    } else if (!frontLineFound) {
      states.set(w, 'current');
      frontLineFound = true;
    } else {
      states.set(w, 'future');
    }
  }
  return states;
}

interface SubTicketsSectionProps {
  childTickets: Ticket[];
  allTickets: Ticket[];
  currentTicketId: string;
  projectId: string;
  memberMap?: Map<string, Member>;
  onOpenTicket: (ticket: Ticket) => void;
  onLinkChild: (childId: string) => void;
  onUnlinkChild: (childId: string) => void;
}

export function SubTicketsSection({
  childTickets,
  allTickets,
  currentTicketId,
  projectId,
  memberMap,
  onOpenTicket,
  onLinkChild,
  onUnlinkChild,
}: SubTicketsSectionProps) {
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [activeTab, setActiveTab] = useState<AddTab>('new');
  const [search, setSearch] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const createTicketMutation = useCreateTicket(projectId);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Wave badges are read-only, computed client-side. There is no persisted
  // "wave" field on the ticket, so a manual override (as sketched in the
  // mockup's wave-badge click popover, with +/- steppers and an "Auto-set
  // from Blocked by" checkbox) can't be built here — that would need a new
  // persisted field. TODO(backend): add a nullable manual wave-override field
  // on Ticket so the popover can be built; until then waves are always
  // auto-computed and non-interactive.
  const waves = useMemo(() => computeWaves(childTickets), [childTickets]);
  const waveStates = useMemo(() => computeWaveStates(childTickets, waves), [childTickets, waves]);

  const doneCount = childTickets.filter((t) => t.status === 'done').length;
  const totalCount = childTickets.length;
  const donePct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const childIds = new Set(childTickets.map((t) => t.id));
  const currentTicketParentId = allTickets.find((t) => t.id === currentTicketId)?.parentId ?? null;

  // Eligible: same project implied by allTickets, not current, not the current
  // ticket's own parent, parentId is null, has no children of its own
  const eligible = allTickets.filter((t) => {
    if (t.id === currentTicketId) return false;
    if (t.id === currentTicketParentId) return false;
    if (childIds.has(t.id)) return false;
    if (t.parentId != null) return false;
    const hasChildren = allTickets.some((other) => other.parentId === t.id);
    if (hasChildren) return false;
    return true;
  });

  const q = search.toLowerCase();
  const filtered = eligible.filter(
    (t) => !q || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q),
  );

  function handleSelect(id: string) {
    onLinkChild(id);
    closePanel();
  }

  function closePanel() {
    setShowAddPanel(false);
    setSearch('');
    setNewTitle('');
    setCreateError(null);
  }

  function openPanel(tab: AddTab) {
    setShowAddPanel(true);
    setActiveTab(tab);
    setSearch('');
    setCreateError(null);
  }

  useEffect(() => {
    if (!showAddPanel) return;
    if (activeTab === 'new') {
      titleInputRef.current?.focus();
    } else {
      searchInputRef.current?.focus();
    }
  }, [showAddPanel, activeTab]);

  function handleSubmitCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    setCreateError(null);
    createTicketMutation.mutate(
      { title: trimmed, type: 'task', priority: 'medium', status: 'backlog', parentId: currentTicketId },
      {
        onSuccess: () => {
          // "Add another" flow: keep the panel open, clear + refocus the
          // title input so the user can immediately create the next one.
          setNewTitle('');
          titleInputRef.current?.focus();
        },
        onError: () => {
          setCreateError('Failed to create child ticket. Please try again.');
        },
      },
    );
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeaderRow}>
        <span className={styles.sectionHeader}>SUB-TICKETS · {totalCount}</span>
        {totalCount > 0 && (
          <>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${donePct}%` }} />
            </div>
            <span className={styles.progressCount}>{doneCount}/{totalCount} done</span>
          </>
        )}
      </div>

      {childTickets.length === 0 && !showAddPanel && (
        <span className={styles.empty}>No sub-tickets yet.</span>
      )}

      {childTickets.length > 0 && (
        <div className={styles.list}>
          {childTickets.map((child) => {
            const wave = waves.get(child.id) ?? 1;
            const waveState = waveStates.get(wave) ?? 'future';
            const isDone = child.status === 'done';
            // Blocked-by chip only for blockers that are siblings in this same
            // sub-ticket group (blockers outside the group aren't shown here —
            // they belong to the Relations section instead).
            const blockedBySiblings = (child.blockedBy ?? []).filter((id) => childIds.has(id));
            const member = child.assignee ? memberMap?.get(child.assignee) : undefined;

            return (
              <div key={child.id} className={styles.row}>
                <span
                  className={`${styles.waveBadge} ${styles[`wave-${waveState}`]}`}
                  title={`Execution wave ${wave}`}
                >
                  {wave}
                </span>
                <StatusMark status={child.status} />
                <TypeIcon type={child.type} color={TYPE_ICON_COLOR[child.type]} />
                <button
                  type="button"
                  className={styles.ticketLink}
                  onClick={() => onOpenTicket(child)}
                >
                  <span className={styles.titleCol}>
                    <span className={isDone ? styles.ticketTitleDone : styles.ticketTitle}>
                      {child.title}
                    </span>
                    {blockedBySiblings.length > 0 && (
                      <span className={styles.blockedChip}>
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="5" y="11" width="14" height="9" rx="2" />
                          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                        </svg>
                        Blocked by {blockedBySiblings.join(', ')}
                      </span>
                    )}
                  </span>
                </button>
                {member && <MemberAvatar member={member} size={18} />}
                <span className={isDone ? styles.ticketIdDone : styles.ticketId}>{child.id}</span>
                <button
                  type="button"
                  className={styles.unlinkBtn}
                  onClick={() => onUnlinkChild(child.id)}
                  title="Remove parent-child link"
                >
                  × unlink
                </button>
              </div>
            );
          })}
        </div>
      )}

      {childTickets.length > 0 && (
        <span className={styles.footnote}>
          Circled number = execution wave, read top to bottom — same number can be worked in
          parallel, the next number waits on that wave&apos;s blockers to clear. The red chip
          flags a sub-ticket that can&apos;t start yet because another one isn&apos;t done.
        </span>
      )}

      <div className={styles.addArea}>
        {!showAddPanel && (
          <button
            type="button"
            className={styles.addBtn}
            onClick={() => openPanel('new')}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5V19" />
              <path d="M5 12H19" />
            </svg>
            Add sub-ticket
          </button>
        )}

        {showAddPanel && (
          <div className={styles.addPanel}>
            <div className={styles.tabs}>
              <button
                type="button"
                className={activeTab === 'new' ? styles.tabActive : styles.tab}
                onClick={() => setActiveTab('new')}
              >
                New
              </button>
              <button
                type="button"
                className={activeTab === 'existing' ? styles.tabActive : styles.tab}
                onClick={() => setActiveTab('existing')}
              >
                Existing
              </button>
            </div>

            {activeTab === 'new' && (
              <form className={styles.newRow} onSubmit={handleSubmitCreate}>
                <span className={styles.radioPlaceholder} />
                <input
                  ref={titleInputRef}
                  className={styles.plainInput}
                  placeholder="Sub-ticket title…"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  disabled={createTicketMutation.isPending}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      closePanel();
                    }
                  }}
                />
                <button
                  type="button"
                  className={styles.iconBtnCancel}
                  onClick={closePanel}
                  aria-label="Cancel"
                  title="Cancel"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6L18 18" />
                    <path d="M18 6L6 18" />
                  </svg>
                </button>
                <button
                  type="submit"
                  className={styles.iconBtnCreate}
                  disabled={!newTitle.trim() || createTicketMutation.isPending}
                  aria-label="Create"
                  title="Create"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 13L10 18L19 6" />
                  </svg>
                </button>
              </form>
            )}

            {activeTab === 'new' && createError && (
              <p className={styles.errorText}>{createError}</p>
            )}

            {activeTab === 'new' && (
              <span className={styles.helperText}>Enter to create and add another · Esc to cancel</span>
            )}

            {activeTab === 'existing' && (
              <>
                <div className={styles.searchRow}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={styles.searchIcon}>
                    <circle cx="11" cy="11" r="7" />
                    <path d="M21 21L16.5 16.5" />
                  </svg>
                  <input
                    ref={searchInputRef}
                    className={styles.plainInput}
                    placeholder="Search tickets…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        closePanel();
                      }
                    }}
                  />
                </div>
                <div className={styles.dropdownList}>
                  {filtered.length === 0 ? (
                    <span className={styles.dropdownEmpty}>No eligible tickets found.</span>
                  ) : (
                    filtered.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={styles.dropdownItem}
                        onClick={() => handleSelect(t.id)}
                      >
                        <span className={styles.resultDot} style={{ background: STATUS_DOT_COLORS[t.status] }} />
                        <TypeIcon type={t.type} color={TYPE_ICON_COLOR[t.type]} />
                        <span className={styles.resultTitle}>{t.title}</span>
                        <span className={styles.resultId}>{t.id}</span>
                      </button>
                    ))
                  )}
                </div>
                <span className={styles.helperText}>
                  Already-linked tickets and the ticket&apos;s own parent are filtered out of results.
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
