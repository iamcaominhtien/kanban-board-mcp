import { useState, useMemo, useRef, useEffect } from 'react';
import type { RelationType, Status, Ticket } from '../types';
import { TicketTypeIcon } from './icons';
import styles from './RelationsSection.module.css';

const STATUS_CONFIG: Record<Status, { label: string; dot: string }> = {
  backlog: { label: 'Backlog', dot: '#C7D2CB' },
  todo: { label: 'To Do', dot: '#9AA8A0' },
  'in-progress': { label: 'In Progress', dot: '#2F6FB0' },
  review: { label: 'Review', dot: '#6D5DD3' },
  testing: { label: 'Testing', dot: '#B4571F' },
  done: { label: 'Done', dot: '#2E6F40' },
  wont_do: { label: "Won't Do", dot: '#C4432A' },
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
  onOpenTicket?: (ticket: Ticket) => void;
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
  onOpenTicket,
}: RelationsSectionProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedType, setSelectedType] = useState<RelationTypeKey>('blocks');
  const [search, setSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showAddForm) {
      searchInputRef.current?.focus();
    }
  }, [showAddForm]);

  // Build unified relation rows
  const relations: RelationRow[] = useMemo(() => {
    const rows: RelationRow[] = [];

    (ticket.blocks ?? []).forEach((targetId) => {
      const t = allTickets.find((item) => item.id === targetId);
      if (t) rows.push({ type: 'blocks', targetId, ticket: t });
    });

    (ticket.blockedBy ?? []).forEach((targetId) => {
      const t = allTickets.find((item) => item.id === targetId);
      if (t) rows.push({ type: 'blockedBy', targetId, ticket: t });
    });

    (ticket.links ?? []).forEach((link) => {
      const t = allTickets.find((item) => item.id === link.targetId);
      if (t)
        rows.push({
          type: link.relationType,
          targetId: link.targetId,
          ticket: t,
          linkId: link.id,
        });
    });

    return rows;
  }, [ticket.blocks, ticket.blockedBy, ticket.links, allTickets]);

  const grouped = useMemo(() => {
    const map = new Map<RelationTypeKey, RelationRow[]>();
    relations.forEach((row) => {
      const existing = map.get(row.type) ?? [];
      existing.push(row);
      map.set(row.type, existing);
    });
    return map;
  }, [relations]);

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

  function handleRemove(rel: RelationRow) {
    if (rel.type === 'blocks') {
      onUnlinkBlock(ticket.id, rel.targetId);
    } else if (rel.type === 'blockedBy') {
      onUnlinkBlock(rel.targetId, ticket.id);
    } else if (rel.linkId && onRemoveLink) {
      onRemoveLink(ticket.id, rel.linkId);
    }
  }

  function handleSelectTarget(targetId: string) {
    if (selectedType === 'blocks') {
      onLinkBlock(ticket.id, targetId);
    } else if (selectedType === 'blockedBy') {
      onLinkBlock(targetId, ticket.id);
    } else if (onAddLink) {
      onAddLink(ticket.id, targetId, selectedType as RelationType);
    }
    setShowAddForm(false);
    setSearch('');
  }

  return (
    <div className={styles.section}>
      <div className={styles.label}>RELATIONS</div>

      {relations.length > 0 && (
        <div className={styles.groups}>
          {Array.from(grouped.entries()).map(([relType, rows]) => (
            <div key={relType} className={styles.group}>
              <div className={styles.groupLabel}>
                {RELATION_TYPE_LABELS[relType] ?? relType}
              </div>
              <div className={styles.cardContainer}>
                {rows.map((row) => {
                  const statusInfo =
                    STATUS_CONFIG[row.ticket.status] ?? STATUS_CONFIG.backlog;
                  return (
                    <div key={`${row.type}-${row.targetId}`} className={styles.row}>
                      <span className={styles.ticketId}>{row.targetId}</span>
                      <span
                        className={styles.ticketTitle}
                        onClick={() => onOpenTicket?.(row.ticket)}
                      >
                        {row.ticket.title}
                      </span>
                      <div className={styles.statusBadge}>
                        {row.ticket.status === 'done' ? (
                          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                            <circle cx="7" cy="7" r="6" stroke="#2E6F40" strokeWidth="1.4" />
                            <path
                              d="M4.3 7.2L6.1 9L9.8 5"
                              stroke="#2E6F40"
                              strokeWidth="1.4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        ) : (
                          <span
                            className={styles.statusDot}
                            style={{ backgroundColor: statusInfo.dot }}
                          />
                        )}
                        <span className={styles.statusText}>{statusInfo.label}</span>
                      </div>
                      <button
                        type="button"
                        className={styles.removeBtn}
                        onClick={() => handleRemove(row)}
                        title="Remove relation"
                        aria-label="Remove relation"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M6 6L18 18" />
                          <path d="M18 6L6 18" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {showAddForm ? (
        <div className={styles.addFormBox}>
          <div className={styles.formTopRow}>
            <select
              className={styles.typeSelect}
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value as RelationTypeKey)}
            >
              <option value="blocks">Blocks</option>
              <option value="blockedBy">Blocked by</option>
              <option value="relates_to">Relates to</option>
              <option value="duplicates">Duplicates</option>
              <option value="duplicated_by">Duplicated by</option>
              <option value="causes">Causes</option>
              <option value="caused_by">Caused by</option>
            </select>

            <input
              ref={searchInputRef}
              className={styles.searchInput}
              placeholder="Search tickets to link…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setShowAddForm(false);
              }}
            />

            <button
              type="button"
              className={styles.cancelBtn}
              onClick={() => setShowAddForm(false)}
              aria-label="Cancel"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6L18 18" />
                <path d="M18 6L6 18" />
              </svg>
            </button>
          </div>

          <div className={styles.resultsList}>
            {eligible.length === 0 ? (
              <div style={{ padding: '8px 10px', fontSize: 12, color: '#9AA8A0', fontStyle: 'italic' }}>
                No matching tickets
              </div>
            ) : (
              eligible.slice(0, 6).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={styles.resultItem}
                  onClick={() => handleSelectTarget(item.id)}
                >
                  <TicketTypeIcon type={item.type} size={14} />
                  <span className={styles.resultTitle}>{item.title}</span>
                  <span className={styles.resultId}>{item.id}</span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={styles.addDashedBtn}
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
  );
}
