import { useState, useMemo } from 'react';
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

type RelationTypeKey = 'blocks' | 'blockedBy' | RelationType;

const RELATION_TYPE_LABELS: Record<RelationTypeKey, string> = {
  blocks: 'Blocks',
  blockedBy: 'Blocked by',
  relates_to: 'Relates to',
  causes: 'Causes',
  caused_by: 'Caused by',
  duplicates: 'Duplicates',
  duplicated_by: 'Duplicated by',
};

interface RelationsSectionProps {
  ticket: Ticket;
  allTickets: Ticket[];
  onLinkBlock: (blockerId: string, blockedId: string) => void;
  onUnlinkBlock: (blockerId: string, blockedId: string) => void;
  onAddLink?: (ticketId: string, targetId: string, relationType: RelationType) => void;
  onRemoveLink?: (ticketId: string, linkId: string) => void;
}

interface RelationRow {
  type: RelationTypeKey;
  targetId: string;
  ticket: Ticket;
  linkId?: string;
}

export function RelationsSection({
  ticket,
  allTickets,
  onLinkBlock,
  onUnlinkBlock,
  onAddLink,
  onRemoveLink,
}: RelationsSectionProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedType, setSelectedType] = useState<RelationTypeKey>('blocks');
  const [search, setSearch] = useState('');

  const blocks = ticket.blocks ?? [];
  const blockedBy = ticket.blockedBy ?? [];
  const links = ticket.links ?? [];

  // Build unified relation rows
  const relations: RelationRow[] = useMemo(() => {
    const rows: RelationRow[] = [];
    
    (ticket.blocks ?? []).forEach((targetId) => {
      const t = allTickets.find((t) => t.id === targetId);
      if (t) rows.push({ type: 'blocks', targetId, ticket: t });
    });

    (ticket.blockedBy ?? []).forEach((targetId) => {
      const t = allTickets.find((t) => t.id === targetId);
      if (t) rows.push({ type: 'blockedBy', targetId, ticket: t });
    });

    (ticket.links ?? []).forEach((link) => {
      const t = allTickets.find((t) => t.id === link.targetId);
      if (t) rows.push({ type: link.relationType, targetId: link.targetId, ticket: t, linkId: link.id });
    });

    return rows;
  }, [ticket.blocks, ticket.blockedBy, ticket.links, allTickets]);

  const excludeIds = useMemo(() => {
    const ids = new Set([ticket.id]);
    relations.forEach((rel) => ids.add(rel.targetId));
    return ids;
  }, [ticket.id, relations]);

  const eligible = useMemo(() => {
    const searchLower = search.toLowerCase();
    return allTickets.filter((t) => {
      if (excludeIds.has(t.id)) return false;
      if (t.parentId !== null) return false;
      if (!searchLower) return true;
      return (
        t.id.toLowerCase().includes(searchLower) ||
        t.title.toLowerCase().includes(searchLower)
      );
    });
  }, [allTickets, excludeIds, search]);

  const handleRemove = (rel: RelationRow) => {
    if (rel.type === 'blocks') {
      onUnlinkBlock(ticket.id, rel.targetId);
    } else if (rel.type === 'blockedBy') {
      onUnlinkBlock(rel.targetId, ticket.id);
    } else {
      onRemoveLink?.(ticket.id, rel.linkId!);
    }
  };

  const handleAdd = (targetId: string) => {
    if (selectedType === 'blocks') {
      onLinkBlock(ticket.id, targetId);
    } else if (selectedType === 'blockedBy') {
      onLinkBlock(targetId, ticket.id);
    } else {
      onAddLink?.(ticket.id, targetId, selectedType as RelationType);
    }
    setShowAddForm(false);
    setSearch('');
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>RELATIONS</div>

      {relations.length === 0 && !showAddForm && (
        <span className={styles.empty}>No relations</span>
      )}

      {relations.length > 0 && (
        <div className={styles.list}>
          {relations.map((rel, idx) => {
            const sc = STATUS_COLORS[rel.ticket.status as Status] ?? STATUS_COLORS.backlog;
            return (
              <div key={`${rel.type}-${rel.targetId}-${idx}`} className={styles.row}>
                <span className={styles.typeBadge}>{RELATION_TYPE_LABELS[rel.type]}</span>
                <span className={styles.ticketId}>#{rel.targetId}</span>
                <span className={styles.ticketTitle}>{rel.ticket.title}</span>
                <span
                  className={styles.statusChip}
                  style={{ background: sc.bg, color: sc.color }}
                >
                  {STATUS_LABELS[rel.ticket.status as Status] ?? rel.ticket.status}
                </span>
                <button
                  type="button"
                  className={styles.removeBtn}
                  onClick={() => handleRemove(rel)}
                  title="Remove relation"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      {!showAddForm ? (
        <button
          type="button"
          className={styles.addBtn}
          onClick={() => setShowAddForm(true)}
        >
          ＋ Add relation
        </button>
      ) : (
        <div className={styles.addForm}>
          <div className={styles.formRow}>
            <select
              className={styles.typeSelect}
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value as RelationTypeKey)}
            >
              <option value="blocks">Blocks</option>
              <option value="blockedBy">Blocked by</option>
              <option value="relates_to">Relates to</option>
              <option value="causes">Causes</option>
              <option value="caused_by">Caused by</option>
              <option value="duplicates">Duplicates</option>
              <option value="duplicated_by">Duplicated by</option>
            </select>
            <input
              autoFocus
              className={styles.searchInput}
              placeholder="Search tickets…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              type="button"
              className={styles.closeBtn}
              onClick={() => {
                setShowAddForm(false);
                setSearch('');
              }}
              title="Close"
            >
              ✕
            </button>
          </div>
          <div className={styles.dropdownList}>
            {eligible.length === 0 && (
              <span className={styles.dropdownEmpty}>No tickets found</span>
            )}
            {eligible.map((t) => (
              <button
                key={t.id}
                type="button"
                className={styles.dropdownItem}
                onClick={() => handleAdd(t.id)}
              >
                <span className={styles.ticketId}>#{t.id}</span>
                <span className={styles.dropdownTitle}>{t.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
