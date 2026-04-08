import { useState, useMemo } from 'react';
import type { Priority, Status, Ticket } from '../types';
import styles from './ListView.module.css';

type GroupBy = 'status' | 'priority' | 'tag';
type SortBy = 'dueDate' | 'createdAt';

interface ListViewProps {
  tickets: Ticket[];
  onCardClick: (ticket: Ticket) => void;
}

const STATUS_ORDER: Status[] = ['backlog', 'todo', 'in-progress', 'done'];
const STATUS_LABELS: Record<Status, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  done: 'Done',
};
const STATUS_COLORS: Record<Status, string> = {
  backlog: '#F5C518',
  todo: '#E8441A',
  'in-progress': '#AACC2E',
  done: '#F472B6',
};

const PRIORITY_ORDER: Priority[] = ['critical', 'high', 'medium', 'low'];
const PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
const PRIORITY_COLORS: Record<Priority, string> = {
  critical: '#E8441A',
  high: '#F5C518',
  medium: '#5BB8F5',
  low: '#AACC2E',
};

function sortTickets(tickets: Ticket[], sortBy: SortBy): Ticket[] {
  return [...tickets].sort((a, b) => {
    if (sortBy === 'dueDate') {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    }
    return a.createdAt.localeCompare(b.createdAt);
  });
}

interface GroupData {
  key: string;
  label: string;
  color: string;
  tickets: Ticket[];
}

function buildGroups(tickets: Ticket[], groupBy: GroupBy, sortBy: SortBy): GroupData[] {
  if (groupBy === 'status') {
    return STATUS_ORDER.map((status) => ({
      key: status,
      label: STATUS_LABELS[status],
      color: STATUS_COLORS[status],
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
      color: PRIORITY_COLORS[priority],
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
      for (const tag of ticket.tags) {
        if (!tagMap.has(tag)) tagMap.set(tag, []);
        tagMap.get(tag)!.push(ticket);
      }
    }
  }
  const tagGroups: GroupData[] = Array.from(tagMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, tagTickets]) => ({
      key: tag,
      label: tag,
      color: '#5BB8F5',
      tickets: sortTickets(tagTickets, sortBy),
    }));
  if (untagged.length > 0) {
    tagGroups.push({
      key: '__untagged__',
      label: 'Untagged',
      color: '#9CA3AF',
      tickets: sortTickets(untagged, sortBy),
    });
  }
  return tagGroups;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
        <span className={styles.groupDot} style={{ background: group.color }} />
        <span className={styles.groupChevron}>{collapsed ? '▶' : '▼'}</span>
        <span className={styles.groupLabel}>{group.label}</span>
        <span className={styles.groupBadge}>{group.tickets.length}</span>
      </button>
      {!collapsed && (
        <div className={styles.groupRows}>
          {group.tickets.map((ticket) => (
            <button
              key={ticket.id}
              type="button"
              className={styles.row}
              onClick={() => onCardClick(ticket)}
            >
              <span className={styles.rowId}>{ticket.id}</span>
              <span className={styles.rowTitle}>{ticket.title}</span>
              <span
                className={styles.chip}
                style={{ background: PRIORITY_COLORS[ticket.priority] }}
              >
                {PRIORITY_LABELS[ticket.priority]}
              </span>
              <span className={styles.rowDue}>{formatDate(ticket.dueDate)}</span>
              <span
                className={styles.chip}
                style={{ background: STATUS_COLORS[ticket.status] }}
              >
                {STATUS_LABELS[ticket.status]}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ListView({ tickets, onCardClick }: ListViewProps) {
  const [groupBy, setGroupBy] = useState<GroupBy>('status');
  const [sortBy, setSortBy] = useState<SortBy>('dueDate');
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());

  const groups = useMemo(
    () => buildGroups(tickets, groupBy, sortBy),
    [tickets, groupBy, sortBy],
  );

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

  return (
    <div className={styles.listView}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <label className={styles.toolbarLabel} htmlFor="lv-groupby">Group&nbsp;by</label>
          <select
            id="lv-groupby"
            className={styles.select}
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
          >
            <option value="status">By Status</option>
            <option value="priority">By Priority</option>
            <option value="tag">By Tag</option>
          </select>
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
          <button type="button" className={styles.expandBtn} onClick={toggleAll}>
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
