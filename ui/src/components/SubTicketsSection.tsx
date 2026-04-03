import { useState } from 'react';
import type { Status, Ticket } from '../types';
import styles from './SubTicketsSection.module.css';

const STATUS_LABELS: Record<Status, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  done: 'Done',
};

interface SubTicketsSectionProps {
  childTickets: Ticket[];
  allTickets: Ticket[];
  currentTicketId: string;
  onOpenTicket: (ticket: Ticket) => void;
  onLinkChild: (childId: string) => void;
  onUnlinkChild: (childId: string) => void;
}

export function SubTicketsSection({
  childTickets,
  allTickets,
  currentTicketId,
  onOpenTicket,
  onLinkChild,
  onUnlinkChild,
}: SubTicketsSectionProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [search, setSearch] = useState('');

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
    setShowDropdown(false);
    setSearch('');
  }

  function handleOpenDropdown() {
    setShowDropdown(true);
    setSearch('');
  }

  return (
    <div className={styles.section}>
      <span className={styles.sectionHeader}>
        Sub-tickets{childTickets.length > 0 ? ` (${childTickets.length})` : ''}
      </span>

      {childTickets.length === 0 && !showDropdown && (
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
        {!showDropdown && (
          <button type="button" className={styles.addBtn} onClick={handleOpenDropdown}>
            ＋ Link ticket as child
          </button>
        )}

        {showDropdown && (
          <div className={styles.dropdown}>
            <input
              className={styles.searchInput}
              placeholder="Search by title or ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
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
            <button
              type="button"
              className={styles.cancelLink}
              onClick={() => { setShowDropdown(false); setSearch(''); }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
