import { useState, useMemo, useEffect, useRef } from 'react';
import type { Priority, Status, Ticket } from '../types';
import styles from './ListView.module.css';

type GroupBy = 'status' | 'priority' | 'tag';
type SortBy = 'dueDate' | 'createdAt';

interface ListViewProps {
  tickets: Ticket[];
  onCardClick: (ticket: Ticket) => void;
}

const STATUS_ORDER: Status[] = ['backlog', 'todo', 'in-progress', 'review', 'testing', 'done'];
const STATUS_LABELS: Record<Status, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
  wont_do: "Won't Do",
};

const STATUS_COLORS: Record<Status, string> = {
  backlog: '#9AA8A0',
  todo: '#2F6FB0',
  'in-progress': '#E2793D',
  review: '#6D5DD3',
  testing: '#B4571F',
  done: '#2E6F40',
  wont_do: '#C4432A',
};

const STATUS_CHIP_CLASS: Record<Status, string> = {
  backlog: 'chipBacklog',
  todo: 'chipTodo',
  'in-progress': 'chipInProgress',
  review: 'chipReview',
  testing: 'chipTesting',
  done: 'chipDone',
  wont_do: 'chipDone',
};

const PRIORITY_ORDER: Priority[] = ['critical', 'high', 'medium', 'low'];
const PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
const PRIORITY_COLORS: Record<Priority, string> = {
  critical: '#C4432A',
  high: '#E2793D',
  medium: '#E8B93A',
  low: '#9BB3A4',
};
const PRIORITY_CHIP_CLASS: Record<Priority, string> = {
  critical: 'chipCritical',
  high: 'chipHigh',
  medium: 'chipMedium',
  low: 'chipLow',
};

function sortTickets(tickets: Ticket[], sortBy: SortBy): Ticket[] {
  return [...tickets].sort((a, b) => {
    if (sortBy === 'dueDate') {
      if (a.dueDate == null && b.dueDate == null) return 0;
      if (a.dueDate == null) return 1;
      if (b.dueDate == null) return -1;
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    }
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return aTime - bTime;
  });
}

interface GroupData {
  key: string;
  label: string;
  dotColor: string;
  tickets: Ticket[];
}

function buildGroups(tickets: Ticket[], groupBy: GroupBy, sortBy: SortBy): GroupData[] {
  if (groupBy === 'status') {
    return STATUS_ORDER.map((status) => ({
      key: status,
      label: STATUS_LABELS[status],
      dotColor: STATUS_COLORS[status],
      tickets: sortTickets(
        tickets.filter((t) => t.status === status),
        sortBy,
      ),
    })).filter((g) => g.tickets.length > 0);
  }

  if (groupBy === 'priority') {
    return PRIORITY_ORDER.map((priority) => ({
      key: priority,
      label: PRIORITY_LABELS[priority],
      dotColor: PRIORITY_COLORS[priority],
      tickets: sortTickets(
        tickets.filter((t) => t.priority === priority),
        sortBy,
      ),
    })).filter((g) => g.tickets.length > 0);
  }

  // By Tag
  const tagMap = new Map<string, Ticket[]>();
  const untagged: Ticket[] = [];
  for (const ticket of tickets) {
    if (!ticket.tags || ticket.tags.length === 0) {
      untagged.push(ticket);
    } else {
      const firstTag = ticket.tags[0];
      if (!tagMap.has(firstTag)) tagMap.set(firstTag, []);
      tagMap.get(firstTag)!.push(ticket);
    }
  }
  const tagGroups: GroupData[] = Array.from(tagMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, tagTickets]) => ({
      key: tag,
      label: tag,
      dotColor: '#68BA7F',
      tickets: sortTickets(tagTickets, sortBy),
    }));
  if (untagged.length > 0) {
    tagGroups.push({
      key: '\x00untagged',
      label: 'Untagged',
      dotColor: '#9AA8A0',
      tickets: sortTickets(untagged, sortBy),
    });
  }
  return tagGroups;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function isOverdue(dateStr: string | null, status: Status): boolean {
  if (!dateStr || status === 'done' || status === 'wont_do') return false;
  return new Date(dateStr).getTime() < Date.now();
}

interface GroupRowProps {
  group: GroupData;
  collapsed: boolean;
  onToggle: () => void;
  onCardClick: (ticket: Ticket) => void;
}

function GroupSection({ group, collapsed, onToggle, onCardClick }: GroupRowProps) {
  return (
    <div className={styles.group}>
      <button type="button" className={styles.groupHeader} onClick={onToggle}>
        <span className={styles.groupDot} style={{ backgroundColor: group.dotColor }} />
        <svg
          className={`${styles.groupChevron} ${collapsed ? styles.groupChevronCollapsed : ''}`}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9L12 15L18 9" />
        </svg>
        <span className={styles.groupLabel}>{group.label}</span>
        <span className={styles.groupBadge}>{group.tickets.length}</span>
      </button>

      {!collapsed && (
        <div className={styles.groupRows}>
          {group.tickets.map((ticket) => {
            const isDone = ticket.status === 'done';
            const overdue = isOverdue(ticket.dueDate, ticket.status);
            return (
              <button key={ticket.id} type="button" className={styles.row} onClick={() => onCardClick(ticket)}>
                <span className={`${styles.rowId} ${isDone ? styles.rowIdDone : ''}`}>{ticket.id}</span>
                <span className={`${styles.rowTitle} ${isDone ? styles.rowTitleDone : ''}`}>{ticket.title}</span>

                {/* Priority Chip */}
                {ticket.priority ? (
                  <span className={`${styles.chip} ${styles[PRIORITY_CHIP_CLASS[ticket.priority]]}`}>
                    {PRIORITY_LABELS[ticket.priority]}
                  </span>
                ) : (
                  <span className={`${styles.chip} ${styles.chipNeutral}`}>—</span>
                )}

                {/* Due Date */}
                <span className={`${styles.rowDue} ${overdue ? styles.rowDueOverdue : ''}`}>
                  {formatDate(ticket.dueDate)}
                </span>

                {/* Status Chip */}
                <span className={`${styles.chip} ${styles.statusChip} ${styles[STATUS_CHIP_CLASS[ticket.status]]}`}>
                  {STATUS_LABELS[ticket.status]}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Sortable table of tickets.
 * @param props.onCardClick - Called with the ticket whose row is clicked.
 */
export function ListView({ tickets, onCardClick }: ListViewProps) {
  const [groupBy, setGroupBy] = useState<GroupBy>('status');
  const [sortBy, setSortBy] = useState<SortBy>('dueDate');
  const [activeStatuses, setActiveStatuses] = useState<Set<Status>>(new Set());
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());
  const [openDropdown, setOpenDropdown] = useState<'groupBy' | 'status' | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    setCollapsedKeys(new Set());
  }, [groupBy]);

  // Filter tickets by selected statuses (if any selected, otherwise all)
  const filteredTickets = useMemo(() => {
    if (activeStatuses.size === 0) return tickets;
    return tickets.filter((t) => activeStatuses.has(t.status));
  }, [tickets, activeStatuses]);

  const groups = useMemo(() => buildGroups(filteredTickets, groupBy, sortBy), [filteredTickets, groupBy, sortBy]);

  const allCollapsed = groups.length > 0 && groups.every((g) => collapsedKeys.has(g.key));

  function toggleGroup(key: string) {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    if (allCollapsed) {
      setCollapsedKeys(new Set());
    } else {
      setCollapsedKeys(new Set(groups.map((g) => g.key)));
    }
  }

  function toggleStatusFilter(status: Status) {
    setActiveStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  const groupByLabels: Record<GroupBy, string> = {
    status: 'Status',
    priority: 'Priority',
    tag: 'Tag',
  };

  const statusFilterText = activeStatuses.size === 0 ? 'All' : `${activeStatuses.size} selected`;

  return (
    <div className={styles.listView} ref={containerRef}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <span className={styles.toolbarLabel}>Group by</span>

          {/* Group By Dropdown */}
          <div className={styles.dropdownContainer}>
            <button
              type="button"
              className={`${styles.dropdownBtn} ${openDropdown === 'groupBy' ? styles.dropdownBtnActive : ''}`}
              onClick={() => setOpenDropdown(openDropdown === 'groupBy' ? null : 'groupBy')}
            >
              {groupByLabels[groupBy]}
              <svg
                className={`${styles.chevronIcon} ${openDropdown === 'groupBy' ? styles.chevronRotated : ''}`}
                width="9"
                height="9"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9L12 15L18 9" />
              </svg>
            </button>

            {openDropdown === 'groupBy' && (
              <div className={styles.dropdownMenu}>
                {(['status', 'priority', 'tag'] as GroupBy[]).map((g) => (
                  <button
                    key={g}
                    type="button"
                    className={`${styles.dropdownItem} ${groupBy === g ? styles.dropdownItemActive : ''}`}
                    onClick={() => {
                      setGroupBy(g);
                      setOpenDropdown(null);
                    }}
                  >
                    <span>By {groupByLabels[g]}</span>
                    {groupBy === g && (
                      <svg className={styles.checkIcon} width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path
                          d="M3.5 7.2L5.7 9.5L10.5 4.3"
                          stroke="#2E6F40"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <span className={styles.divider} />

          {/* Status Multi-select Filter Dropdown */}
          <div className={styles.dropdownContainer}>
            <button
              type="button"
              className={`${styles.dropdownBtn} ${openDropdown === 'status' ? styles.dropdownBtnActive : ''}`}
              onClick={() => setOpenDropdown(openDropdown === 'status' ? null : 'status')}
            >
              <span className={styles.labelMuted}>Status:</span> {statusFilterText}
              <svg
                className={`${styles.chevronIcon} ${openDropdown === 'status' ? styles.chevronRotated : ''}`}
                width="9"
                height="9"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9L12 15L18 9" />
              </svg>
            </button>

            {openDropdown === 'status' && (
              <div className={styles.dropdownMenu}>
                {STATUS_ORDER.map((status) => {
                  const isChecked = activeStatuses.has(status);
                  return (
                    <button
                      key={status}
                      type="button"
                      className={`${styles.dropdownItem} ${isChecked ? styles.dropdownItemActive : ''}`}
                      onClick={() => toggleStatusFilter(status)}
                    >
                      <span className={`${styles.checkSquare} ${isChecked ? styles.checkSquareChecked : ''}`}>
                        {isChecked && (
                          <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
                            <path
                              d="M3.5 7.2L5.7 9.5L10.5 4.3"
                              stroke="#FFFFFF"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </span>
                      <span className={styles.statusDot} style={{ backgroundColor: STATUS_COLORS[status] }} />
                      <span style={{ flexGrow: 1 }}>{STATUS_LABELS[status]}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className={styles.toolbarRight}>
          <span className={styles.toolbarLabel}>Sort</span>
          <div className={styles.toggleGroup}>
            <button
              type="button"
              className={`${styles.toggleBtn} ${sortBy === 'dueDate' ? styles.toggleBtnActive : ''}`}
              onClick={() => setSortBy('dueDate')}
            >
              Due Date
            </button>
            <button
              type="button"
              className={`${styles.toggleBtn} ${sortBy === 'createdAt' ? styles.toggleBtnActive : ''}`}
              onClick={() => setSortBy('createdAt')}
            >
              Created
            </button>
          </div>

          <span className={styles.divider} />

          <button type="button" className={styles.collapseAllBtn} onClick={toggleAll}>
            {allCollapsed ? 'Expand All' : 'Collapse All'}
          </button>
        </div>
      </div>

      <div className={styles.groups}>
        {groups.length === 0 ? (
          <p className={styles.empty}>No tickets match the current filters.</p>
        ) : (
          groups.map((group) => (
            <GroupSection
              key={group.key}
              group={group}
              collapsed={collapsedKeys.has(group.key)}
              onToggle={() => toggleGroup(group.key)}
              onCardClick={onCardClick}
            />
          ))
        )}
      </div>
    </div>
  );
}
