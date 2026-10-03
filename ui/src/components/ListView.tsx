import { useState, useMemo, useEffect } from 'react';
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
  wont_do: 'Không làm',
};
const STATUS_CHIP_CLASS: Record<Status, string> = {
  backlog: 'chipBacklog',
  todo: 'chipTodo',
  'in-progress': 'chipInProgress',
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
      if (a.dueDate == null) return 1;   // nulls last
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
  chipClass: string;
  tickets: Ticket[];
}

function buildGroups(tickets: Ticket[], groupBy: GroupBy, sortBy: SortBy): GroupData[] {
  if (groupBy === 'status') {
    return STATUS_ORDER.map((status) => ({
      key: status,
      label: STATUS_LABELS[status],
      chipClass: STATUS_CHIP_CLASS[status],
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
      chipClass: PRIORITY_CHIP_CLASS[priority],
      tickets: sortTickets(
        tickets.filter((t) => t.priority === priority),
        sortBy,
      ),
    })).filter((g) => g.tickets.length > 0);
  }

  // By Tag — each ticket placed in first-tag group only to avoid duplication
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
      chipClass: 'chipTag',
      tickets: sortTickets(tagTickets, sortBy),
    }));
  if (untagged.length > 0) {
    tagGroups.push({
      key: '\x00untagged', // '\x00' prefix ensures this key cannot collide with any real user-entered tag
      label: 'Untagged',
      chipClass: 'chipUntagged',
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
        <span className={`${styles.groupDot} ${styles[group.chipClass]}`} />
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
              <span className={`${styles.chip} ${styles[PRIORITY_CHIP_CLASS[ticket.priority]]}`}>
                {PRIORITY_LABELS[ticket.priority]}
              </span>
              <span className={styles.rowDue}>{formatDate(ticket.dueDate)}</span>
              <span className={`${styles.chip} ${styles[STATUS_CHIP_CLASS[ticket.status]]}`}>
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

  useEffect(() => { setCollapsedKeys(new Set()); }, [groupBy]);

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
