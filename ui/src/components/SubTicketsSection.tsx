import { useEffect, useRef, useState } from 'react';
import type { Status, Ticket } from '../types';
import { useCreateTicket } from '../api/tickets';
import styles from './SubTicketsSection.module.css';

const STATUS_LABELS: Record<Status, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  done: 'Done',
  wont_do: 'Không làm',
};

type AddTab = 'new' | 'existing';

interface SubTicketsSectionProps {
  childTickets: Ticket[];
  allTickets: Ticket[];
  currentTicketId: string;
  projectId: string;
  onOpenTicket: (ticket: Ticket) => void;
  onLinkChild: (childId: string) => void;
  onUnlinkChild: (childId: string) => void;
}

export function SubTicketsSection({
  childTickets,
  allTickets,
  currentTicketId,
  projectId,
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

  const childIds = new Set(childTickets.map((t) => t.id));

  // Eligible: same project implied by allTickets, not current, parentId is null, has no children of its own
  const eligible = allTickets.filter((t) => {
    if (t.id === currentTicketId) return false;
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
          closePanel();
        },
        onError: () => {
          setCreateError('Failed to create child ticket. Please try again.');
        },
      },
    );
  }

  return (
    <div className={styles.section}>
      <span className={styles.sectionHeader}>
        Sub-tickets{childTickets.length > 0 ? ` (${childTickets.length})` : ''}
      </span>

      {childTickets.length === 0 && !showAddPanel && (
        <span className={styles.empty}>No sub-tickets yet.</span>
      )}

      {childTickets.length > 0 && (
        <div className={styles.list}>
          {childTickets.map((child) => (
            <div key={child.id} className={styles.row}>
              <button
                type="button"
                className={styles.ticketLink}
                onClick={() => onOpenTicket(child)}
              >
                <span className={styles.ticketId}>{child.id}</span>
                <span className={styles.ticketTitle}>{child.title}</span>
                <span className={styles.statusBadge}>{STATUS_LABELS[child.status]}</span>
              </button>
              <button
                type="button"
                className={styles.unlinkBtn}
                onClick={() => onUnlinkChild(child.id)}
                title="Remove parent-child link"
              >
                × unlink
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={styles.addArea}>
        {!showAddPanel && (
          <button
            type="button"
            className={styles.addBtn}
            onClick={() => openPanel('new')}
          >
            ＋ Add sub-ticket
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
              <button
                type="button"
                className={styles.closeBtn}
                onClick={closePanel}
                aria-label="Close"
                title="Close"
              >
                ✕
              </button>
            </div>

            {activeTab === 'new' && (
              <form className={styles.tabContent} onSubmit={handleSubmitCreate}>
                <input
                  ref={titleInputRef}
                  className={styles.searchInput}
                  placeholder="Child ticket title…"
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
                {createError && <p className={styles.errorText}>{createError}</p>}
                <div className={styles.createFormActions}>
                  <button
                    type="submit"
                    className={styles.submitBtn}
                    disabled={!newTitle.trim() || createTicketMutation.isPending}
                  >
                    {createTicketMutation.isPending ? 'Creating…' : 'Create'}
                  </button>
                </div>
              </form>
            )}

            {activeTab === 'existing' && (
              <div className={styles.tabContent}>
                <input
                  ref={searchInputRef}
                  className={styles.searchInput}
                  placeholder="Search by title or ID…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      closePanel();
                    }
                  }}
                />
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
                        <span className={styles.ticketId}>{t.id}</span>
                        <span className={styles.ticketTitle}>{t.title}</span>
                        <span className={styles.statusBadge}>{STATUS_LABELS[t.status]}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
