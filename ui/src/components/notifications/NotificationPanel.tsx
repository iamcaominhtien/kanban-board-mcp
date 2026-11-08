import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  notificationKeys,
  notificationsApi,
  useNotificationCounts,
  useNotificationList,
} from '../../api/notifications';
import { useProjects } from '../../api/projects';
import type { NotificationRow as Row } from '../../types/notifications';
import { DayCard } from './DayCard';
import { NotificationRow, type RowActionHandler } from './NotificationRow';
import { EmptyState, LoadingRows, OfflineNotice } from './NotificationStates';
import { Icon, dayLabel, groupByDay, rowKeyAction } from './notificationUi';
import { useReadWhenVisible } from './useReadWhenVisible';
import { isTyping, useRowKeys } from './useRowKeys';
import styles from './NotificationPanel.module.css';

export type PanelTab = 'needs' | 'updates';

/** The layout the rows are shown in: Needs you open rows by when they began, done rows under their own header. */
function panelGroups(rows: Row[], tab: PanelTab) {
  if (tab === 'updates') return groupByDay(rows, Date.now(), (r) => r.updatedAt);
  const openRows = rows.filter((r) => !r.done);
  const doneRows = rows.filter((r) => r.done);
  const out = groupByDay(openRows, Date.now(), (r) => r.createdAt);
  if (doneRows.length > 0) out.push({ key: `done:${out.length}`, label: 'Done today', rows: doneRows });
  return out;
}

/** A click that closes the panel: outside it, and not on the bell (which toggles) or on a notice (an alert). */
function closesPanel(target: EventTarget | null, panel: HTMLElement | null): boolean {
  const t = target as HTMLElement | null;
  if (!t) return false;
  return !panel?.contains(t) && !t.closest('[data-notification-bell]') && !t.closest('[role="alert"]');
}

/**
 * The empty state of the panel: nothing needs you (with updates in the other tab), no updates (while things wait
 * in Needs you), or nothing at all ("No notifications yet" is only for an empty feed).
 */
function PanelEmpty({
  tab,
  needs,
  updates,
  todayUpdates,
}: Readonly<{ tab: PanelTab; needs: number; updates: number; todayUpdates: number }>) {
  if (tab === 'updates' && needs > 0)
    return (
      <EmptyState
        icon="check"
        title="No updates"
        text={`Nothing new to read. ${needs} ${needs === 1 ? 'item needs' : 'items need'} you in the other tab.`}
      />
    );
  if (tab !== 'needs' || updates <= 0)
    return (
      <EmptyState
        icon="bell"
        title="No notifications yet"
        text="When an AI team needs an answer, a run fails or a page is published, it shows up here."
      />
    );
  const one = todayUpdates === 1;
  let text = 'Earlier updates are in the other tab.';
  if (todayUpdates > 0)
    text = `${todayUpdates} update${one ? '' : 's'} from today ${one ? 'is' : 'are'} in the other tab.`;
  return <EmptyState icon="check" title="Nothing needs you" text={text} />;
}

/**
 * The bell's panel (design C1, C2): it opens over the right side and does not move the page. Needs you first
 * (open rows, oldest waiting first, then today's done rows), Updates second (the day card, then rows).
 */
export function NotificationPanel({
  tab,
  onTab,
  onClose,
  onOpenPage,
  onOpenSettings,
  onAction,
}: Readonly<{
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  onOpenPage: () => void;
  onOpenSettings: () => void;
  onAction: RowActionHandler;
}>) {
  const qc = useQueryClient();
  const counts = useNotificationCounts();
  const list = useNotificationList({ view: 'panel', tab });
  const projects = useProjects().data;
  const projectMap = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p])), [projects]);
  // while the other tab's rows are still on screen as placeholder data, show the grey rows instead
  const placeholder = list.isPlaceholderData;
  const rows = useMemo(() => (placeholder ? [] : (list.data?.items ?? [])), [placeholder, list.data]);
  const dayCard = tab === 'updates' && !placeholder ? (list.data?.dayCard ?? null) : null;
  // the layout the rows are shown in: Needs you open rows by when they began, done rows under their own header
  const groups = useMemo(() => panelGroups(rows, tab), [rows, tab]);
  const ordered = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const scroller = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc closes; a click outside closes (the bell toggles on its own)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isTyping(e.target)) onClose();
    };
    const down = (e: MouseEvent) => {
      if (closesPanel(e.target, panelRef.current)) onClose();
    };
    window.addEventListener('keydown', key);
    document.addEventListener('mousedown', down);
    return () => {
      window.removeEventListener('keydown', key);
      document.removeEventListener('mousedown', down);
    };
  }, [onClose]);

  const refresh = () => void qc.invalidateQueries({ queryKey: notificationKeys.all });
  const sendRead = (ids: string[]) => void notificationsApi.read({ ids }).then(refresh, () => undefined);
  const signature = [dayCard?.id, ...rows.map((r) => `${r.id}:${r.read ? 1 : 0}:${r.lastEventId}`)].join('|');
  useReadWhenVisible(scroller, !list.isError && !placeholder, signature, sendRead);

  const selected = useRowKeys(true, ordered, rowKeyAction(onAction));

  const markAll = async () => {
    await notificationsApi.read({ all: true, tab }).catch(() => undefined);
    refresh();
  };

  const needs = counts.data?.needs ?? 0;
  const updates = counts.data?.updates ?? 0;
  const offline = list.isError || (counts.isError && !list.data);
  const loading = list.isLoading || placeholder;
  // "N updates from today" counts today's rows of the Updates list, not the 30-day total of the tab
  const needsEmpty = tab === 'needs' && !loading && !offline && rows.length === 0;
  const todayList = useNotificationList({ view: 'panel', tab: 'updates' }, needsEmpty);
  const todayUpdates = (todayList.data?.items ?? []).filter((r) => dayLabel(r.updatedAt) === 'Today').length;
  const nothing = !loading && !offline && rows.length === 0 && !dayCard;
  const showNeeds = () => onTab('needs');

  return (
    <aside ref={panelRef} className={styles.panel} aria-label="Notifications" role="dialog">
      <div className={styles.header}>
        <b className={styles.heading}>Notifications</b>
        <span className={styles.spacer} />
        <button type="button" className={styles.btn} onClick={() => void markAll()}>
          <Icon name="tick" />
          Mark all read
        </button>
        <button
          type="button"
          className={styles.icoBtn}
          aria-label="Notification settings"
          title="Notification settings"
          onClick={onOpenSettings}
        >
          <Icon name="gear" size={15} />
        </button>
        <button type="button" className={styles.icoBtn} aria-label="Close" onClick={onClose}>
          <Icon name="x" size={15} />
        </button>
      </div>
      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'needs'}
          className={`${styles.tab} ${tab === 'needs' ? styles.tabOn : ''}`}
          onClick={() => onTab('needs')}
        >
          Needs you<b className={`${styles.tabCount} ${styles.tabCountNeeds}`}> {needs}</b>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'updates'}
          className={`${styles.tab} ${tab === 'updates' ? styles.tabOn : ''}`}
          onClick={() => onTab('updates')}
        >
          Updates<b className={styles.tabCount}> {updates}</b>
        </button>
      </div>
      <div className={styles.list} ref={scroller}>
        {offline && <OfflineNotice at={list.dataUpdatedAt || null} onRetry={() => void list.refetch()} />}
        {loading && !offline && <LoadingRows />}
        {dayCard && <DayCard row={dayCard} onAction={onAction} onShowNeeds={showNeeds} />}
        {nothing && <PanelEmpty tab={tab} needs={needs} updates={updates} todayUpdates={todayUpdates} />}
        {groups.map((g) => (
          <div key={g.key} style={{ display: 'contents' }}>
            <div className={styles.dayHead}>
              <span className={styles.dayName}>{g.label}</span>
              <span className={styles.rule} />
            </div>
            {g.rows.map((r: Row) => (
              <NotificationRow
                key={r.id}
                row={r}
                projects={projectMap}
                onAction={onAction}
                selected={selected === r.id}
              />
            ))}
          </div>
        ))}
      </div>
      <div className={styles.footer}>
        <button type="button" className={styles.btn} onClick={onOpenPage}>
          <Icon name="list" />
          All notifications
        </button>
        <span className={styles.spacer} />
        <span className={styles.live}>{offline ? 'Offline' : 'Live'}</span>
        <span className={`${styles.liveDot} ${offline ? styles.liveOff : ''}`} />
      </div>
    </aside>
  );
}
