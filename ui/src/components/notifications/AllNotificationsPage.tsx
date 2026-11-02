import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  notificationKeys,
  notificationsApi,
  useNotificationCounts,
  useNotificationList,
} from '../../api/notifications';
import { useProjects } from '../../api/projects';
import type { NotificationFamily, NotificationFilter } from '../../types/notifications';
import { NeedsFilterBar } from './NeedsFilterBar';
import { applyNeedsFilter, type NeedsFilter } from './needsFilters';
import { NotificationRow, type RowActionHandler } from './NotificationRow';
import { EmptyState, LoadingRows, OfflineNotice } from './NotificationStates';
import { Icon, groupByDay, rowKeyAction } from './notificationUi';
import { useRowKeys } from './useRowKeys';
import panel from './NotificationPanel.module.css';
import styles from './AllNotificationsPage.module.css';

const KINDS: { id: NotificationFamily; label: string }[] = [
  { id: 'info', label: 'For information' },
  { id: 'ai', label: 'From AI members' },
  { id: 'people', label: 'From people' },
  { id: 'schedules', label: 'Schedules' },
];

function Check({ on, onClick, children }: Readonly<{ on: boolean; onClick: () => void; children: ReactNode }>) {
  return (
    <label className={styles.check}>
      <input type="checkbox" className={styles.checkInput} checked={on} onChange={onClick} />
      <span className={`${styles.box} ${on ? styles.boxOn : ''}`}>
        {on && <Icon name="tick" size={11} stroke={2.4} />}
      </span>
      {children}
    </label>
  );
}

/** All notifications (design H): every project, everything still kept, with search, filters and days. */
export function AllNotificationsPage({
  onBack,
  onOpenSettings,
  onAction,
  bell,
  panelOpen,
  focusRowId,
}: Readonly<{
  onBack: () => void;
  onOpenSettings: () => void;
  onAction: RowActionHandler;
  /** The bell of the top bar (design C1: on every screen). */
  bell?: ReactNode;
  /** The panel is open over the page: its keys win, the page's stay quiet. */
  panelOpen?: boolean;
  /** A grouped row to open expanded, from "Open the list" in the panel. */
  focusRowId?: string | null;
}>) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const [needsFilter, setNeedsFilter] = useState<NeedsFilter>('all');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [days, setDays] = useState(7);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [family, setFamily] = useState<NotificationFamily | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const counts = useNotificationCounts().data;
  // Needs you and Snoozed are about what is open now, however old: the days select does not cut them
  const byDays = filter !== 'needs' && filter !== 'snoozed';
  const list = useNotificationList({
    view: 'page',
    filter,
    q,
    days: byDays ? days : undefined,
    family: family ?? undefined,
    limit: 500,
  });
  const projectsData = useProjects().data;
  const projects = useMemo(() => projectsData ?? [], [projectsData]);
  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const listItems = list.data?.items;
  const all = useMemo(() => listItems ?? [], [listItems]);
  const perProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of all) if (r.projectId) m.set(r.projectId, (m.get(r.projectId) ?? 0) + 1);
    return m;
  }, [all]);
  const inProject = projectId ? all.filter((r) => r.projectId === projectId) : all;
  const rows = filter === 'needs' ? applyNeedsFilter(inProject, needsFilter) : inProject;
  // grouped by the time the page is sorted by: the last activity
  const groups = useMemo(() => groupByDay(rows, Date.now(), (r) => r.updatedAt), [rows]);
  const ordered = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const selected = useRowKeys(!panelOpen, ordered, rowKeyAction(onAction));
  const markAll = async () => {
    await notificationsApi
      .read({
        all: true,
        filter,
        q,
        projectId: projectId ?? undefined,
        family: family ?? undefined,
        days: byDays ? days : undefined,
      })
      .catch(() => undefined);
    void qc.invalidateQueries({ queryKey: notificationKeys.all });
  };
  const scroller = useRef<HTMLDivElement>(null);

  const tabs: { id: NotificationFilter; label: string; n?: number }[] = [
    { id: 'all', label: 'All' },
    { id: 'unread', label: 'Unread', n: counts?.unread },
    { id: 'needs', label: 'Needs you', n: counts?.needs },
    { id: 'snoozed', label: 'Snoozed', n: counts?.snoozed },
    { id: 'done', label: 'Done' },
    { id: 'cleared', label: 'Cleared' },
  ];
  const offline = list.isError;
  const loading = list.isLoading;

  return (
    <div className={styles.page}>
      <div className={styles.titleRow}>
        <button type="button" className={styles.back} aria-label="Back" title="Back" onClick={onBack}>
          <Icon name="back" size={16} />
        </button>
        <h1 className={styles.title}>All notifications</h1>
        <span className={styles.total}>
          {byDays ? `${list.data?.total ?? 0} in the last ${days} days` : `${list.data?.total ?? 0} in all`}
        </span>
        <span className={styles.spacer} />
        <button type="button" className={styles.btn} onClick={() => void markAll()}>
          <Icon name="tick" />
          Mark all read
        </button>
        <button type="button" className={styles.btn} onClick={onOpenSettings}>
          <Icon name="gear" />
          Notification settings
        </button>
        {bell}
      </div>
      <div className={styles.filters}>
        <label className={styles.search}>
          <Icon name="search" size={14} color="#6B7A70" />
          <input
            className={styles.searchInput}
            type="search"
            value={search}
            placeholder="Search notifications…"
            aria-label="Search notifications"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`${styles.pill} ${filter === t.id ? styles.pillOn : ''}`}
            aria-pressed={filter === t.id}
            onClick={() => setFilter(t.id)}
          >
            {t.label}
            {t.n ? <b> {t.n}</b> : null}
          </button>
        ))}
        <span className={styles.spacer} />
        <select
          className={styles.days}
          aria-label="Days"
          value={days}
          disabled={!byDays}
          title={byDays ? undefined : 'This list is not cut by days'}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      {filter === 'needs' && <NeedsFilterBar rows={inProject} value={needsFilter} onChange={setNeedsFilter} />}
      <div className={styles.content}>
        <div className={styles.list} ref={scroller}>
          {offline && <OfflineNotice at={list.dataUpdatedAt || null} onRetry={() => void list.refetch()} />}
          {loading && !offline && <LoadingRows rows={5} />}
          {!loading && !offline && rows.length === 0 && (
            <EmptyState
              icon="bell"
              title={filter === 'all' && !q && !family && !projectId ? 'No notifications yet' : 'Nothing matches'}
              text={
                filter === 'all' && !q && !family && !projectId
                  ? 'When an AI member needs an answer, a run fails or a page is published, it shows up here.'
                  : 'Try another filter or a longer period.'
              }
            />
          )}
          {groups.map((g) => (
            <div key={g.key} style={{ display: 'contents' }}>
              <div className={panel.dayHead}>
                <span className={panel.dayName}>{g.label}</span>
                <span className={panel.rule} />
                <span className={panel.dayCount}>{g.rows.length}</span>
              </div>
              {g.rows.map((r) => (
                <NotificationRow
                  key={r.id}
                  row={r}
                  projects={projectMap}
                  onAction={onAction}
                  selected={selected === r.id}
                  onPage
                  focused={focusRowId === r.id}
                />
              ))}
            </div>
          ))}
        </div>
        <div className={styles.side}>
          <div>
            <div className={styles.sideHead}>Projects</div>
            <div className={styles.checks}>
              <Check on={projectId === null} onClick={() => setProjectId(null)}>
                <span className={styles.pdot} style={{ background: '#9AA8A0' }} />
                <span className={styles.grow}>All projects</span>
                <span className={styles.num}>{all.length}</span>
              </Check>
              {projects.map((p) => (
                <Check
                  key={p.id}
                  on={projectId === p.id}
                  onClick={() => setProjectId(projectId === p.id ? null : p.id)}
                >
                  <span className={styles.pdot} style={{ background: p.color }} />
                  <span className={styles.grow}>{p.name}</span>
                  <span className={styles.num}>{perProject.get(p.id) ?? 0}</span>
                </Check>
              ))}
            </div>
          </div>
          <div>
            <div className={styles.sideHead}>Kind</div>
            <div className={styles.checks}>
              {KINDS.map((k) => (
                <Check key={k.id} on={family === k.id} onClick={() => setFamily(family === k.id ? null : k.id)}>
                  {k.label}
                </Check>
              ))}
            </div>
          </div>
          <div className={styles.kbd}>
            <div className={styles.kbdTitle}>Keyboard</div>
            <ul>
              <li>
                <b>N</b> opens the panel, <b>Esc</b> closes it.
              </li>
              <li>
                <b>J</b> and <b>K</b> move, <b>Enter</b> opens, <b>E</b> marks read, <b>S</b> snoozes.
              </li>
              <li>
                <b>Shift N</b> opens this page.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
