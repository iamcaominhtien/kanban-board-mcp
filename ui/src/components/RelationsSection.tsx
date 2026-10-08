import { useState, useMemo, useRef, useEffect } from 'react';
import type { RelationType, Status, Ticket } from '../types';
import { StatusMenu } from './StatusMenu';
import styles from './RelationsSection.module.css';

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

/** Wraps the part of `text` matching `query` in a <mark>, for the link search results. */
function highlightMatch(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className={styles.mark}>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

interface RelationsSectionProps {
  ticket: Ticket;
  allTickets: Ticket[];
  onLinkBlock: (blockerId: string, blockedId: string) => void;
  onUnlinkBlock: (blockerId: string, blockedId: string) => void;
  onAddLink?: (ticketId: string, targetId: string, relationType: RelationType) => void;
  onRemoveLink?: (ticketId: string, linkId: string) => void;
  onOpenTicket?: (ticket: Ticket) => void;
  onChangeStatus?: (ticketId: string, status: Status) => void;
}

interface RelationRow {
  type: RelationTypeKey;
  targetId: string;
  ticket: Ticket;
  linkId?: string;
}

/** Ticket's blocks, blocked-by and linked relations. */
export function RelationsSection({
  ticket,
  allTickets,
  onLinkBlock,
  onUnlinkBlock,
  onAddLink,
  onRemoveLink,
  onOpenTicket,
  onChangeStatus,
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
    const seen = new Set<string>();

    const addRow = (row: RelationRow) => {
      const key = `${row.type}-${row.targetId}`;
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(row);
      }
    };

    (ticket.blocks ?? []).forEach((targetId) => {
      const t = allTickets.find((item) => item.id === targetId);
      if (t) addRow({ type: 'blocks', targetId, ticket: t });
    });

    (ticket.blockedBy ?? []).forEach((targetId) => {
      const t = allTickets.find((item) => item.id === targetId);
      if (t) addRow({ type: 'blockedBy', targetId, ticket: t });
    });

    (ticket.links ?? []).forEach((link) => {
      const t = allTickets.find((item) => item.id === link.targetId);
      if (t)
        addRow({
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
      return t.id.toLowerCase().includes(searchLower) || t.title.toLowerCase().includes(searchLower);
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

      {relations.length === 0 && !showAddForm && <span className={styles.empty}>No links</span>}

      {relations.length > 0 && (
        <div className={styles.groups}>
          {Array.from(grouped.entries()).map(([relType, rows]) => (
            <div key={relType} className={styles.group}>
              <div className={styles.groupLabel}>{RELATION_TYPE_LABELS[relType] ?? relType}</div>
              <div className={styles.cardContainer}>
                {rows.map((row) => (
                  <div key={`${row.type}-${row.targetId}`} className={styles.row}>
                    <span className={styles.ticketId}>{row.targetId}</span>
                    <span
                      className={`${styles.ticketTitle} ${
                        row.ticket.status === 'wont_do' ? styles.ticketTitleMuted : ''
                      }`}
                      onClick={() => onOpenTicket?.(row.ticket)}
                    >
                      {row.ticket.title}
                    </span>
                    <StatusMenu
                      compact
                      value={row.ticket.status}
                      disabled={!onChangeStatus}
                      onChange={(next) => onChangeStatus?.(row.ticket.id, next)}
                    />
                    <button
                      type="button"
                      className={styles.removeBtn}
                      onClick={() => handleRemove(row)}
                      title="Remove relation"
                      aria-label="Remove relation"
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
                ))}
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
              <option value="causes">Causes</option>
              <option value="caused_by">Caused by</option>
              <option value="duplicates">Duplicates</option>
              <option value="duplicated_by">Duplicated by</option>
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
            {eligible.length === 0 ? (
              <div className={styles.noResults}>No matching tickets</div>
            ) : (
              eligible.slice(0, 6).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={styles.resultItem}
                  onClick={() => handleSelectTarget(item.id)}
                >
                  <span className={styles.resultId}>#{item.id}</span>
                  <span className={styles.resultTitle}>{highlightMatch(item.title, search)}</span>
                </button>
              ))
            )}
          </div>
          <div className={styles.helperText}>
            Search excludes the ticket itself and anything already linked to it (any relation type).
          </div>
        </div>
      ) : (
        <button type="button" className={styles.addDashedBtn} onClick={() => setShowAddForm(true)}>
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
          Add link
        </button>
      )}
    </div>
  );
}
