import { useMemo, useState } from 'react';
import type { ActivityEntry, Member } from '../types';
import { getAvatarColors } from './MemberAvatar';
import styles from './ActivitySection.module.css';

interface ActivitySectionProps {
  ticketId: string;
  entries: ActivityEntry[];
  members?: Member[];
  isLoading?: boolean;
}

type FilterGroup = 'all' | 'status' | 'assignee' | 'priority' | 'comments' | 'branch' | 'other';

interface DiffRow {
  type: 'added' | 'removed' | 'normal';
  sign: string;
  text: string;
  highlightedText?: string;
}

interface DiffResult {
  addedCount: number;
  removedCount: number;
  rows: DiffRow[];
}

function computeLineDiff(fromStr: string | null | undefined, toStr: string | null | undefined): DiffResult {
  const fromLines = (fromStr || '').split('\n');
  const toLines = (toStr || '').split('\n');

  if (!fromStr && toStr) {
    return {
      addedCount: toLines.length,
      removedCount: 0,
      rows: toLines.map((line) => ({
        type: 'added',
        sign: '+',
        text: line,
      })),
    };
  }

  if (fromStr && !toStr) {
    return {
      addedCount: 0,
      removedCount: fromLines.length,
      rows: fromLines.map((line) => ({
        type: 'removed',
        sign: '−',
        text: line,
      })),
    };
  }

  // Simple diff: find common prefix and suffix, mark middle as removed then added
  let start = 0;
  while (start < fromLines.length && start < toLines.length && fromLines[start] === toLines[start]) {
    start++;
  }

  let endFrom = fromLines.length - 1;
  let endTo = toLines.length - 1;
  while (endFrom >= start && endTo >= start && fromLines[endFrom] === toLines[endTo]) {
    endFrom--;
    endTo--;
  }

  const rows: DiffRow[] = [];
  let addedCount = 0;
  let removedCount = 0;

  // Unchanged prefix (up to 1 context line)
  if (start > 0) {
    rows.push({
      type: 'normal',
      sign: '',
      text: fromLines[start - 1],
    });
  }

  // Removed lines
  for (let i = start; i <= endFrom; i++) {
    removedCount++;
    rows.push({
      type: 'removed',
      sign: '−',
      text: fromLines[i],
    });
  }

  // Added lines
  for (let j = start; j <= endTo; j++) {
    addedCount++;
    rows.push({
      type: 'added',
      sign: '+',
      text: toLines[j],
    });
  }

  // Unchanged suffix (up to 1 context line)
  if (endFrom + 1 < fromLines.length) {
    rows.push({
      type: 'normal',
      sign: '',
      text: fromLines[endFrom + 1],
    });
  }

  return {
    addedCount,
    removedCount,
    rows: rows.length > 0 ? rows : [{ type: 'normal', sign: '', text: toLines[0] || '' }],
  };
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatClockTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return iso;
  }
}

function formatFullTooltip(iso: string): { fullDate: string; age: string } {
  try {
    const d = new Date(iso);
    const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
    const month = d.toLocaleDateString('en-US', { month: 'short' });
    const day = d.getDate();
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const fullDate = `${dayName}, ${month} ${day} · ${time}`;

    const diff = Date.now() - d.getTime();
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));
    let age = 'just now';
    if (days === 1) age = '1 day ago';
    else if (days > 1) age = `${days} days ago`;
    else {
      const hrs = Math.floor(diff / (60 * 60 * 1000));
      if (hrs >= 1) age = `${hrs} hour${hrs > 1 ? 's' : ''} ago`;
      else {
        const mins = Math.floor(diff / 60000);
        age = mins > 0 ? `${mins} min${mins > 1 ? 's' : ''} ago` : 'just now';
      }
    }

    return { fullDate, age };
  } catch {
    return { fullDate: iso, age: '' };
  }
}

function getDayLabel(iso: string): string {
  try {
    const date = new Date(iso);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    if (
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate()
    ) {
      return 'Today';
    }

    if (
      date.getFullYear() === yesterday.getFullYear() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getDate() === yesterday.getDate()
    ) {
      return 'Yesterday';
    }

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return 'Earlier';
  }
}

function getStatusInfo(status: string | null | undefined): { label: string; dotColor: string } {
  switch ((status || '').toLowerCase().replace('-', '_')) {
    case 'todo':
    case 'to_do':
    case 'backlog':
      return { label: status === 'backlog' ? 'Backlog' : 'To Do', dotColor: '#9AA8A0' };
    case 'in_progress':
      return { label: 'In Progress', dotColor: '#2F6FB0' };
    case 'review':
      return { label: 'Review', dotColor: '#6D5DD3' };
    case 'testing':
      return { label: 'Testing', dotColor: '#E2793D' };
    case 'done':
      return { label: 'Done', dotColor: '#2E6F40' };
    case 'wont_do':
      return { label: "Won't Do", dotColor: '#8C9BAE' };
    default:
      return { label: status || 'none', dotColor: '#9AA8A0' };
  }
}

function getPriorityInfo(priority: string | null | undefined): { label: string; dotColor: string } {
  switch ((priority || '').toLowerCase()) {
    case 'low':
      return { label: 'Low', dotColor: '#2E6F40' };
    case 'medium':
      return { label: 'Medium', dotColor: '#B4791E' };
    case 'high':
      return { label: 'High', dotColor: '#E2793D' };
    case 'critical':
      return { label: 'Critical', dotColor: '#C4432A' };
    default:
      return { label: priority || 'none', dotColor: '#9AA8A0' };
  }
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const FIELD_DISPLAY_NAMES: Record<string, string> = {
  status: 'Status',
  assignee: 'Assignee',
  priority: 'Priority',
  description: 'Description',
  title: 'Title',
  tags: 'Tags',
  branch: 'Branch',
  due_date: 'Due date',
  dueDate: 'Due date',
  start_date: 'Start date',
  startDate: 'Start date',
  estimate: 'Estimate',
  type: 'Type',
  created: 'Created',
  comment: 'Comment',
  acceptance_criterion: 'Acceptance criterion',
  sub_task: 'Sub-task',
  work_log: 'Work log',
  test_case: 'Test case',
  test_case_status: 'Test case',
  blocks: 'Blocks',
  blocked_by: 'Blocked by',
  link: 'Link',
  parent_id: 'Parent',
  wont_do_reason: "Won't do reason",
  repo_path: 'Repository',
  workspace_retention: 'Workspace retention',
  branch_status: 'Branch status',
  branch_checkout: 'Checkout',
  branch_worktree: 'Worktree',
};

const COMMENT_FIELDS = new Set(['comment', 'work_log']);
const isBranchField = (field: string) => field === 'branch' || field.startsWith('branch_');

/** Fields whose entries read as "added / removed" rather than "old → new". */
const EVENT_FIELDS = new Set([
  'comment',
  'work_log',
  'acceptance_criterion',
  'sub_task',
  'test_case',
  'blocks',
  'blocked_by',
  'link',
  'branch',
  'branch_checkout',
  'branch_worktree',
]);

const MONO_FIELDS = new Set(['branch', 'branch_status', 'branch_checkout', 'branch_worktree', 'repo_path', 'blocks', 'blocked_by', 'parent_id']);

function actorLabel(actor: string | undefined, members: Member[]): string | null {
  if (!actor) return null;
  if (actor === 'user') return 'You';
  if (actor === 'agent') return 'AI agent';
  return members.find((m) => m.id === actor)?.name ?? actor;
}

export function ActivitySection({ ticketId, entries, members = [], isLoading = false }: ActivitySectionProps) {
  const [filter, setFilter] = useState<FilterGroup>('all');
  const [expandedDiffs, setExpandedDiffs] = useState<Record<string, boolean>>({});
  const [visibleCount, setVisibleCount] = useState<number>(20);

  const toggleDiff = (key: string) => {
    setExpandedDiffs((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Counts for filters
  const counts = useMemo(() => {
    let status = 0;
    let assignee = 0;
    let priority = 0;
    let comments = 0;
    let branch = 0;
    let other = 0;

    for (const e of entries) {
      if (e.field === 'status') status++;
      else if (e.field === 'assignee') assignee++;
      else if (e.field === 'priority') priority++;
      else if (COMMENT_FIELDS.has(e.field)) comments++;
      else if (isBranchField(e.field)) branch++;
      else other++;
    }

    return {
      all: entries.length,
      status,
      assignee,
      priority,
      comments,
      branch,
      other,
    };
  }, [entries]);

  // Filter and sort entries newest first
  const filteredEntries = useMemo(() => {
    const list = entries.filter((e) => {
      if (filter === 'all') return true;
      if (filter === 'status') return e.field === 'status';
      if (filter === 'assignee') return e.field === 'assignee';
      if (filter === 'priority') return e.field === 'priority';
      if (filter === 'comments') return COMMENT_FIELDS.has(e.field);
      if (filter === 'branch') return isBranchField(e.field);
      if (filter === 'other') {
        return !['status', 'assignee', 'priority'].includes(e.field) && !COMMENT_FIELDS.has(e.field) && !isBranchField(e.field);
      }
      return true;
    });

    return [...list].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [entries, filter]);

  // Paged entries
  const pagedEntries = useMemo(() => {
    return filteredEntries.slice(0, visibleCount);
  }, [filteredEntries, visibleCount]);

  // Group paged entries by day
  const groupedByDay = useMemo(() => {
    const groups: { dayLabel: string; items: ActivityEntry[] }[] = [];
    const map = new Map<string, ActivityEntry[]>();

    for (const entry of pagedEntries) {
      const label = getDayLabel(entry.at);
      if (!map.has(label)) {
        map.set(label, []);
        groups.push({ dayLabel: label, items: map.get(label)! });
      }
      map.get(label)!.push(entry);
    }

    return groups;
  }, [pagedEntries]);

  // Bubble Icon and styling
  const renderBubble = (field: string) => {
    switch (field) {
      case 'status':
        return (
          <div className={styles.acBubble} style={{ background: '#E1EEFB', color: '#2F6FB0' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 3A9 9 0 0 1 12 21Z" fill="currentColor" />
            </svg>
          </div>
        );
      case 'assignee':
        return (
          <div className={styles.acBubble} style={{ background: '#E6E9F5', color: '#5B5FA8' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21C4 17 7.5 14.5 12 14.5S20 17 20 21" />
            </svg>
          </div>
        );
      case 'priority':
        return (
          <div className={styles.acBubble} style={{ background: '#FDECE0', color: '#E2793D' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 20V15" />
              <path d="M10 20V11" />
              <path d="M15 20V7" />
              <path d="M20 20V3" />
            </svg>
          </div>
        );
      case 'description':
      case 'title':
        return (
          <div className={styles.acBubble} style={{ background: '#F1F3F1', color: '#5B6B60' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20H21" />
              <path d="M16.5 3.5A2.1 2.1 0 0 1 19.5 6.5L7 19L3 20L4 16Z" />
            </svg>
          </div>
        );
      case 'tags':
        return (
          <div className={styles.acBubble} style={{ background: '#DCEEE1', color: '#2E6F40' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.6 13.4L13.4 20.6A2 2 0 0 1 10.6 20.6L3 13V3H13L20.6 10.6A2 2 0 0 1 20.6 13.4Z" />
              <circle cx="7.5" cy="7.5" r="1" fill="currentColor" />
            </svg>
          </div>
        );
      case 'branch':
      case 'branch_status':
      case 'branch_checkout':
      case 'branch_worktree':
      case 'repo_path':
        return (
          <div className={styles.acBubble} style={{ background: '#ECE9FA', color: '#6D5DD3' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="2.5" />
              <circle cx="6" cy="18" r="2.5" />
              <circle cx="18" cy="6" r="2.5" />
              <path d="M6 8.5V15.5" />
              <path d="M8.5 6H13A5 5 0 0 1 18 11V15.5" />
            </svg>
          </div>
        );
      case 'due_date':
      case 'dueDate':
      case 'start_date':
      case 'startDate':
        return (
          <div className={styles.acBubble} style={{ background: '#FBF1DC', color: '#B4791E' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="5.5" width="17" height="15" rx="2.5" />
              <path d="M3.5 10H20.5" />
              <path d="M8 3V6.5" />
              <path d="M16 3V6.5" />
            </svg>
          </div>
        );
      case 'comment':
        return iconBubble('#E1EEFB', '#2F6FB0', ['M4 5H20V16H9L5 20V16H4Z']);
      case 'work_log':
        return iconBubble('#ECE9FA', '#6D5DD3', ['M4 5H20V19H4Z', 'M8 10L11 12L8 14', 'M13 14H16']);
      case 'acceptance_criterion':
      case 'sub_task':
      case 'test_case':
      case 'test_case_status':
        return iconBubble('#DCEEE1', '#2E6F40', ['M4 12L9 17L20 6']);
      case 'blocks':
      case 'blocked_by':
      case 'link':
        return iconBubble('#FBF1DC', '#B4791E', ['M10 14A4 4 0 0 0 15.7 14.3L18.7 11.3A4 4 0 0 0 13 5.7L12 6.7', 'M14 10A4 4 0 0 0 8.3 9.7L5.3 12.7A4 4 0 0 0 11 18.3L12 17.3']);
      case 'parent_id':
        return iconBubble('#F1F3F1', '#5B6B60', ['M6 4V14A4 4 0 0 0 10 18H18', 'M14 14L18 18L14 22']);
      case 'workspace_retention':
        return iconBubble('#F1F3F1', '#5B6B60', ['M3 7C3 5.9 3.9 5 5 5H9.2L11.2 7.5H19C20.1 7.5 21 8.4 21 9.5V17C21 18.1 20.1 19 19 19H5C3.9 19 3 18.1 3 17V7Z']);
      case 'wont_do_reason':
        return iconBubble('#F1F3F1', '#8C9BAE', ['M5 5L19 19', 'M12 3A9 9 0 1 0 12 21A9 9 0 0 0 12 3Z']);
      case 'created':
        return iconBubble('#DCEEE1', '#2E6F40', ['M12 5V19', 'M5 12H19']);
      default:
        return (
          <div className={styles.acBubble} style={{ background: '#F1F3F1', color: '#5B6B60' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7V12L15 14" />
            </svg>
          </div>
        );
    }
  };

  const iconBubble = (bg: string, color: string, paths: string[]) => (
    <div className={styles.acBubble} style={{ background: bg, color }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {paths.map((d) => <path key={d} d={d} />)}
      </svg>
    </div>
  );

  // Render chip value
  const renderValueChip = (field: string, val: any, isOldTitle = false) => {
    if (val === null || val === undefined || val === '' || (Array.isArray(val) && val.length === 0)) {
      if (field === 'assignee') {
        return <span className={styles.acChip} style={{ color: '#9AA8A0' }}>Unassigned</span>;
      }
      return <span className={styles.acChip} style={{ color: '#9AA8A0' }}>none</span>;
    }

    if (field === 'status') {
      const { label, dotColor } = getStatusInfo(String(val));
      return (
        <span className={styles.acChip}>
          <span className={styles.statusDot} style={{ background: dotColor }} />
          {label}
        </span>
      );
    }

    if (field === 'priority') {
      const { label, dotColor } = getPriorityInfo(String(val));
      return (
        <span className={styles.acChip}>
          <span className={styles.statusDot} style={{ background: dotColor }} />
          {label}
        </span>
      );
    }

    if (field === 'assignee') {
      const member = members.find((m) => m.id === val || m.name === val);
      const name = member?.name || String(val);
      const initials = getInitials(name);
      const { bg, color } = getAvatarColors(member?.color || '#6D5DD3');

      return (
        <span className={styles.acChip}>
          <span className={styles.assigneeAvatar} style={{ background: bg, color }}>
            {initials}
          </span>
          {name}
        </span>
      );
    }

    if (field === 'tags') {
      const tagsList: string[] = Array.isArray(val)
        ? val
        : typeof val === 'string'
          ? (() => {
              try {
                const parsed = JSON.parse(val);
                return Array.isArray(parsed) ? parsed : [val];
              } catch {
                return [val];
              }
            })()
          : [String(val)];

      if (tagsList.length === 0) {
        return <span className={styles.acChip} style={{ color: '#9AA8A0' }}>none</span>;
      }

      return (
        <>
          {tagsList.map((tag) => (
            <span
              key={tag}
              className={styles.tagPill}
              style={{ background: 'rgba(46,111,64,0.12)', color: '#2E6F40' }}
            >
              {tag}
            </span>
          ))}
        </>
      );
    }

    if (MONO_FIELDS.has(field)) {
      return (
        <span className={styles.acChip} style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 500 }} title={String(val)}>
          {String(val)}
        </span>
      );
    }

    if ((field === 'title' || EVENT_FIELDS.has(field)) && isOldTitle) {
      return (
        <span
          className={styles.acChip}
          style={{
            color: '#9AA8A0',
            textDecoration: 'line-through',
            textDecorationColor: '#C7D2CB',
          }}
        >
          {String(val)}
        </span>
      );
    }

    if (field === 'due_date' || field === 'dueDate' || field === 'start_date' || field === 'startDate') {
      try {
        const d = new Date(val);
        if (!isNaN(d.getTime())) {
          return (
            <span className={styles.acChip}>
              {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          );
        }
      } catch {
        // Fallback
      }
    }

    return <span className={styles.acChip} title={String(val)}>{String(val)}</span>;
  };

  if (isLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.topBar}>
          <span className={styles.acLabel}>Loading changes · {ticketId}</span>
        </div>
        <div className={styles.acList}>
          {[1, 2, 3].map((n) => (
            <div key={n} className={styles.acRow}>
              <div className={`${styles.acBubble} ${styles.acSk}`} />
              <div className={styles.acMain} style={{ gap: '8px' }}>
                <span className={styles.acSk} style={{ height: '9px', width: '54px', borderRadius: '5px' }} />
                <span className={styles.acSk} style={{ height: '20px', width: `${140 + n * 30}px`, borderRadius: '999px' }} />
              </div>
              <span className={styles.acSk} style={{ height: '9px', width: '48px', borderRadius: '5px' }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* Top Bar */}
      <div className={styles.topBar}>
        <span className={styles.acLabel}>
          {counts.all} changes · {ticketId}
        </span>
        <div className={styles.filterList}>
          {([
            ['all', 'All'],
            ['status', 'Status'],
            ['assignee', 'Assignee'],
            ['priority', 'Priority'],
            ['comments', 'Comments'],
            ['branch', 'Branch'],
            ['other', 'Other'],
          ] as [FilterGroup, string][]).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`${styles.acFilter} ${filter === key ? styles.acFilterActive : ''}`}
              onClick={() => setFilter(key)}
            >
              {label} ({counts[key]})
            </button>
          ))}
        </div>
      </div>

      {/* Empty State */}
      {filteredEntries.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7V12L15 14" />
            </svg>
          </div>
          <div className={styles.emptyTitle}>No activity yet</div>
          <div className={styles.emptyDesc}>
            Changes to fields, comments, test cases, links and branches will show up here.
          </div>
        </div>
      ) : (
        <>
          {groupedByDay.map((group) => {
            const isToday = group.dayLabel === 'Today';

            return (
              <div key={group.dayLabel} className={styles.acGroup}>
                <div className={styles.acDay}>
                  <span>{group.dayLabel}</span>
                  <span className={styles.acDayCount}>
                    {group.items.length} {group.items.length === 1 ? 'change' : 'changes'}
                  </span>
                </div>

                <div className={styles.acList}>
                  <div className={styles.acLine} />

                  {group.items.map((entry, idx) => {
                    const rowKey = `${entry.at}-${entry.field}-${idx}`;
                    const fieldName = FIELD_DISPLAY_NAMES[entry.field] || entry.field.toUpperCase();
                    const isDescription = entry.field === 'description';
                    const diffData = isDescription ? computeLineDiff(entry.from, entry.to) : null;
                    const isDiffExpanded = expandedDiffs[rowKey] ?? false;
                    const { fullDate, age } = formatFullTooltip(entry.at);

                    return (
                      <div
                        key={rowKey}
                        className={`${styles.acRow} ${isDescription ? styles.acRowTop : ''}`}
                      >
                        {renderBubble(entry.field)}

                        <div className={styles.acMain}>
                          <span className={styles.acField}>
                            {fieldName}
                            {entry.ref && <span className={styles.acRef}> · {entry.ref}</span>}
                          </span>

                          {isDescription && diffData ? (
                            <>
                              <div className={styles.acChange}>
                                <span style={{ fontSize: '12.5px', color: '#3A4A3E' }}>edited</span>
                                <span
                                  className={styles.acChip}
                                  style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 500 }}
                                >
                                  <span style={{ color: '#2E6F40' }}>+{diffData.addedCount}</span>
                                  <span style={{ color: '#C4432A' }}>−{diffData.removedCount}</span>
                                  <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: '#5B6B60', fontWeight: 600 }}>
                                    lines
                                  </span>
                                </span>
                                <button
                                  type="button"
                                  className={styles.acToggle}
                                  onClick={() => toggleDiff(rowKey)}
                                >
                                  {isDiffExpanded ? 'Hide changes' : 'Show changes'}
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                    <path d={isDiffExpanded ? 'M18 15L12 9L6 15' : 'M6 9L12 15L18 9'} />
                                  </svg>
                                </button>
                              </div>

                              {isDiffExpanded && (
                                <div className={styles.diffContainer}>
                                  {diffData.rows.map((row, rIdx) => {
                                    const rowStyle =
                                      row.type === 'removed'
                                        ? styles.diffRemoved
                                        : row.type === 'added'
                                          ? styles.diffAdded
                                          : styles.diffNormal;

                                    const signColor =
                                      row.type === 'removed'
                                        ? '#C4432A'
                                        : row.type === 'added'
                                          ? '#2E6F40'
                                          : '#9AA8A0';

                                    const highlightStyle =
                                      row.type === 'removed'
                                        ? styles.diffHighlightRemoved
                                        : styles.diffHighlightAdded;

                                    return (
                                      <div key={rIdx} className={`${styles.diffRow} ${rowStyle}`}>
                                        <span className={styles.diffSign} style={{ color: signColor }}>
                                          {row.sign}
                                        </span>
                                        <span className={styles.diffContent}>
                                          {row.type !== 'normal' && row.text.trim() ? (
                                            <span className={highlightStyle}>{row.text}</span>
                                          ) : (
                                            row.text || '\u00A0'
                                          )}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </>
                          ) : entry.field === 'created' ? (
                            <div className={styles.acChange}>
                              <span style={{ fontSize: '12.5px', color: '#3A4A3E' }}>Ticket created</span>
                            </div>
                          ) : EVENT_FIELDS.has(entry.field) && (entry.from == null || entry.to == null) ? (
                            <div className={styles.acChange}>
                              <span style={{ fontSize: '12.5px', color: '#3A4A3E' }}>
                                {entry.to == null ? 'removed' : entry.field === 'branch_checkout' ? 'checked out' : 'added'}
                              </span>
                              {entry.to == null
                                ? renderValueChip(entry.field, entry.from, true)
                                : renderValueChip(entry.field, entry.to, false)}
                            </div>
                          ) : (
                            <div className={styles.acChange}>
                              {renderValueChip(entry.field, entry.from, entry.field === 'title')}

                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9AA8A0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M5 12H19" />
                                <path d="M13 6L19 12L13 18" />
                              </svg>

                              {renderValueChip(entry.field, entry.to, false)}
                            </div>
                          )}
                        </div>

                        <span
                          className={styles.acTime}
                          style={isDescription ? { paddingTop: '2px' } : undefined}
                        >
                          {actorLabel(entry.actor, members) && (
                            <span className={styles.acActor}>{actorLabel(entry.actor, members)} · </span>
                          )}
                          {isToday ? formatRelative(entry.at) : formatClockTime(entry.at)}
                          <span className={styles.acTt}>
                            {fullDate}
                            {age && (
                              <>
                                <br />
                                <span style={{ opacity: 0.7 }}>{age}</span>
                              </>
                            )}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {filteredEntries.length > visibleCount && (
            <button
              type="button"
              className={styles.acMore}
              onClick={() => setVisibleCount((prev) => prev + 20)}
            >
              Show {filteredEntries.length - visibleCount} earlier changes
            </button>
          )}
        </>
      )}
    </div>
  );
}
