import { useState, useMemo } from 'react';
import type { RelationType, Status, Ticket } from '../types';
import { STATUS_DOT_COLORS } from './StatusMenu';
import styles from './RelationsSection.module.css';

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

// Wraps the substring of `text` matching `query` (case-insensitive) in <mark>,
// mirroring the mockup's highlighted-match example in the add-link dropdown.
function highlightMatch(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className={styles.highlight}>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
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
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedType, setSelectedType] = useState<RelationTypeKey>('blocks');
  const [search, setSearch] = useState('');

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
      if (rel.linkId) {
        onRemoveLink?.(ticket.id, rel.linkId);
      } else {
        console.warn('RelationsSection: tried to remove a link with no linkId', rel);
      }
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

  // Group relations by type for display
  const grouped = useMemo(() => {
    const map = new Map<RelationTypeKey, RelationRow[]>();
    relations.forEach((rel) => {
      if (!map.has(rel.type)) map.set(rel.type, []);
      map.get(rel.type)!.push(rel);
    });
    return map;
  }, [relations]);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>RELATIONS</span>
      </div>

      {relations.length === 0 && !showAddForm && (
        <span className={styles.empty}>No links</span>
      )}

      {grouped.size > 0 && (
        <div className={styles.groups}>
          {Array.from(grouped.entries()).map(([type, rows]) => (
            <div key={type} className={styles.group}>
              <div className={styles.groupHeader}>
                {RELATION_TYPE_LABELS[type]}
              </div>
              {rows.map((rel) => {
                const status = rel.ticket.status as Status;
                const canRemove = rel.type === 'blocks' || rel.type === 'blockedBy' || !!onRemoveLink;
                return (
                  <div key={`${rel.type}-${rel.targetId}`} className={styles.row}>
                    <span className={styles.ticketId}>{rel.ticket.id}</span>
                    <span className={styles.ticketTitle}>{rel.ticket.title}</span>
                    <span className={styles.statusChip}>
                      {status === 'done' ? (
                        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                          <circle cx="7" cy="7" r="6" stroke="var(--color-primary)" strokeWidth="1.4" />
                          <path d="M4.3 7.2L6.1 9L9.8 5" stroke="var(--color-primary)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <span className={styles.statusDot} style={{ background: STATUS_DOT_COLORS[status] }} aria-hidden="true" />
                      )}
                      <span className={styles.statusChipLabel}>{STATUS_LABELS[status] ?? status}</span>
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={styles.statusChipChevron}>
                        <path d="M6 9L12 15L18 9" />
                      </svg>
                    </span>
                    {canRemove && (
                      <button
                        type="button"
                        className={styles.removeBtn}
                        onClick={() => handleRemove(rel)}
                        aria-label="Remove relation"
                        title="Remove relation"
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {!showAddForm && (
            <button
              type="button"
              className={styles.addBtn}
              onClick={() => setShowAddForm(true)}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 5V19" />
                <path d="M5 12H19" />
              </svg>
              Add link
            </button>
          )}
        </div>
      )}

      {relations.length === 0 && !showAddForm && (
        <button
          type="button"
          className={styles.addBtn}
          onClick={() => setShowAddForm(true)}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5V19" />
            <path d="M5 12H19" />
          </svg>
          Add link
        </button>
      )}

      {showAddForm && (
        <div className={styles.addForm}>
          <div className={styles.formRow}>
            <select
              className={styles.typeSelect}
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value as RelationTypeKey)}
              aria-label="Relation type"
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
              aria-label="Search tickets"
            />
            <button
              type="button"
              className={styles.closeBtn}
              onClick={() => {
                setShowAddForm(false);
                setSearch('');
              }}
              aria-label="Close"
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
                <span className={styles.dropdownTitle}>{highlightMatch(t.title, search)}</span>
              </button>
            ))}
          </div>
          <span className={styles.helperText}>
            Search excludes the ticket itself and anything already linked to it (any relation type).
          </span>
        </div>
      )}
    </div>
  );
}
