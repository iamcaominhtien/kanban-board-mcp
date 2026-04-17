import { useState } from 'react';
import type { RelationType, Status, Ticket } from '../types';
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

const RELATION_LABELS: Record<RelationType, string> = {
  relates_to: 'Relates to',
  causes: 'Causes',
  caused_by: 'Caused by',
  duplicates: 'Duplicates',
  duplicated_by: 'Duplicated by',
};

const ALL_RELATION_TYPES: RelationType[] = [
  'relates_to',
  'causes',
  'caused_by',
  'duplicates',
  'duplicated_by',
];

interface RelationsSectionProps {
  ticket: Ticket;
  allTickets: Ticket[];
  onLinkBlock: (blockerId: string, blockedId: string) => void;
  onUnlinkBlock: (blockerId: string, blockedId: string) => void;
  onAddLink?: (ticketId: string, targetId: string, relationType: RelationType) => void;
  onRemoveLink?: (ticketId: string, linkId: string) => void;
}

interface RelationListProps {
  label: string;
  items: { id: string; ticket: Ticket }[];
  allTickets: Ticket[];
  onRemove: (id: string) => void;
  onAdd: (id: string) => void;
  excludeIds: Set<string>;
}

function RelationList({
  label,
  items,
  allTickets,
  onRemove,
  onAdd,
  excludeIds,
}: RelationListProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [search, setSearch] = useState('');

  const eligible = allTickets.filter((t) => {
    if (excludeIds.has(t.id)) return false;
    if (t.parentId !== null) return false;
    if (!search) return true;
    return (
      t.id.toLowerCase().includes(search.toLowerCase()) ||
      t.title.toLowerCase().includes(search.toLowerCase())
    );
  });

  return (
    <div className={styles.group}>
      <div className={styles.groupHeader}>{label}</div>
      {items.length === 0 && <span className={styles.empty}>None</span>}
      {items.length > 0 && (
        <div className={styles.list}>
          {items.map(({ id, ticket }) => {
            const sc = STATUS_COLORS[ticket.status as Status] ?? STATUS_COLORS.backlog;
            return (
              <div key={id} className={styles.row}>
                <span className={styles.ticketId}>{ticket.id}</span>
                <span className={styles.ticketTitle}>{ticket.title}</span>
                <span
                  className={styles.statusChip}
                  style={{ background: sc.bg, color: sc.color }}
                >
                  {STATUS_LABELS[ticket.status as Status] ?? ticket.status}
                </span>
                <button
                  type="button"
                  className={styles.removeBtn}
                  onClick={() => onRemove(id)}
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
          <button type="button" className={styles.addBtn} onClick={() => setShowDropdown(true)}>
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
                  onClick={() => { onAdd(t.id); setShowDropdown(false); setSearch(''); }}
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
  onAddLink,
  onRemoveLink,
}: RelationsSectionProps) {
  const blocks = ticket.blocks ?? [];
  const blockedBy = ticket.blockedBy ?? [];
  const links = ticket.links ?? [];

  const blockRelatedIds = new Set([ticket.id, ...blocks, ...blockedBy]);

  function getRelationItems(ids: string[]) {
    return ids
      .map((id) => ({ id, ticket: allTickets.find((t) => t.id === id) }))
      .filter((item): item is { id: string; ticket: Ticket } => !!item.ticket);
  }

  function getLinkItems(type: RelationType) {
    return links
      .filter((lk) => lk.relationType === type)
      .map((lk) => ({ id: lk.id, ticket: allTickets.find((t) => t.id === lk.targetId) }))
      .filter((item): item is { id: string; ticket: Ticket } => !!item.ticket);
  }

  return (
    <div className={styles.content}>
      <RelationList
        label="Blocks"
        items={getRelationItems(blocks)}
        allTickets={allTickets}
        onRemove={(id) => onUnlinkBlock(ticket.id, id)}
        onAdd={(id) => onLinkBlock(ticket.id, id)}
        excludeIds={blockRelatedIds}
      />
      <RelationList
        label="Blocked by"
        items={getRelationItems(blockedBy)}
        allTickets={allTickets}
        onRemove={(id) => onUnlinkBlock(id, ticket.id)}
        onAdd={(id) => onLinkBlock(id, ticket.id)}
        excludeIds={blockRelatedIds}
      />
      {ALL_RELATION_TYPES.map((type) => {
        const items = getLinkItems(type);
        const excludeIds = new Set([ticket.id, ...items.map((i) => i.ticket.id)]);
        return (
          <RelationList
            key={type}
            label={RELATION_LABELS[type]}
            items={items}
            allTickets={allTickets}
            onRemove={(id) => onRemoveLink?.(ticket.id, id)}
            onAdd={(id) => onAddLink?.(ticket.id, id, type)}
            excludeIds={excludeIds}
          />
        );
      })}
    </div>
  );
}
