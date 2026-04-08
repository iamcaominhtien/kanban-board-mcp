import { useState } from 'react';
import type { Status, Ticket } from '../types';
import styles from './RelationsSection.module.css';

const STATUS_COLORS: Record<Status, { bg: string; color: string }> = {
  backlog: { bg: '#FEF9C3', color: '#854D0E' },
  todo: { bg: '#FED7AA', color: '#9A3412' },
  'in-progress': { bg: '#D9F99D', color: '#3F6212' },
  done: { bg: '#FCE7F3', color: '#9D174D' },
  wont_do: { bg: '#F3F4F6', color: '#6B7280' },
};

const STATUS_LABELS: Record<Status, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  done: 'Done',
  wont_do: "Won't Do",
};

interface RelationsSectionProps {
  ticket: Ticket;
  allTickets: Ticket[];
  onLinkBlock: (blockerId: string, blockedId: string) => void;
  onUnlinkBlock: (blockerId: string, blockedId: string) => void;
}

function RelationList({
  label,
  ids,
  allTickets,
  onRemove,
  onAdd,
  excludeIds,
}: {
  label: string;
  ids: string[];
  allTickets: Ticket[];
  onRemove: (id: string) => void;
  onAdd: (id: string) => void;
  excludeIds: Set<string>;
}) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [search, setSearch] = useState('');

  const related = ids
    .map((id) => allTickets.find((t) => t.id === id))
    .filter((t): t is Ticket => !!t);

  const eligible = allTickets.filter((t) => {
    if (excludeIds.has(t.id)) return false;
    if (t.parentId !== null) return false;  // sub-tickets not selectable
    if (!search) return true;
    return (
      t.id.toLowerCase().includes(search.toLowerCase()) ||
      t.title.toLowerCase().includes(search.toLowerCase())
    );
  });

  function handleSelect(id: string) {
    onAdd(id);
    setShowDropdown(false);
    setSearch('');
  }

  return (
    <div className={styles.group}>
      <div className={styles.groupHeader}>{label}</div>
      {related.length === 0 && (
        <span className={styles.empty}>None</span>
      )}
      {related.length > 0 && (
        <div className={styles.list}>
          {related.map((t) => {
            const sc = STATUS_COLORS[t.status as Status] ?? STATUS_COLORS.backlog;
            return (
              <div key={t.id} className={styles.row}>
                <span className={styles.ticketId}>{t.id}</span>
                <span className={styles.ticketTitle}>{t.title}</span>
                <span
                  className={styles.statusChip}
                  style={{ background: sc.bg, color: sc.color }}
                >
                  {STATUS_LABELS[t.status as Status] ?? t.status}
                </span>
                <button
                  type="button"
                  className={styles.removeBtn}
                  onClick={() => onRemove(t.id)}
                  title="Remove relation"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className={styles.addArea}>
        {!showDropdown ? (
          <button
            type="button"
            className={styles.addBtn}
            onClick={() => setShowDropdown(true)}
          >
            ＋ Add
          </button>
        ) : (
          <div className={styles.dropdown}>
            <input
              autoFocus
              className={styles.searchInput}
              placeholder="Search tickets…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className={styles.dropdownList}>
              {eligible.length === 0 && (
                <span className={styles.dropdownEmpty}>No tickets found</span>
              )}
              {eligible.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => handleSelect(t.id)}
                >
                  <span className={styles.ticketId}>{t.id}</span>
                  <span className={styles.dropdownTitle}>{t.title}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className={styles.cancelBtn}
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

export function RelationsSection({
  ticket,
  allTickets,
  onLinkBlock,
  onUnlinkBlock,
}: RelationsSectionProps) {
  const blocks = ticket.blocks ?? [];
  const blockedBy = ticket.blockedBy ?? [];

  // Tickets eligible for dropdown: exclude self, exclude already-related
  const allRelatedIds = new Set([ticket.id, ...blocks, ...blockedBy]);

  function handleAddBlocks(targetId: string) {
    onLinkBlock(ticket.id, targetId);
  }

  function handleRemoveBlocks(targetId: string) {
    onUnlinkBlock(ticket.id, targetId);
  }

  function handleAddBlockedBy(blockerId: string) {
    onLinkBlock(blockerId, ticket.id);
  }

  function handleRemoveBlockedBy(blockerId: string) {
    onUnlinkBlock(blockerId, ticket.id);
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>Relations</div>
      <RelationList
        label="Blocks"
        ids={blocks}
        allTickets={allTickets}
        onRemove={handleRemoveBlocks}
        onAdd={handleAddBlocks}
        excludeIds={allRelatedIds}
      />
      <RelationList
        label="Blocked by"
        ids={blockedBy}
        allTickets={allTickets}
        onRemove={handleRemoveBlockedBy}
        onAdd={handleAddBlockedBy}
        excludeIds={allRelatedIds}
      />
    </div>
  );
}
