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
import { Icon, groupByDay, openActionOf, snoozeChoices } from './notificationUi';
import { useReadWhenVisible } from './useReadWhenVisible';
import { isTyping, useRowKeys } from './useRowKeys';
import styles from './NotificationPanel.module.css';

export type PanelTab = 'needs' | 'updates';

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
}: {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  onOpenPage: () => void;
  onOpenSettings: () => void;
  onAction: RowActionHandler;
}) {
  const qc = useQueryClient();
  const counts = useNotificationCounts();
  const list = useNotificationList({ view: 'panel', tab });
  const projects = useProjects().data;
  const projectMap = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p])), [projects]);
  const rows = list.data?.items ?? [];
  const dayCard = tab === 'updates' ? (list.data?.dayCard ?? null) : null;
  const scroller = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc closes; a click outside closes (the bell toggles on its own)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isTyping(e.target)) onClose();
    };
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || panelRef.current?.contains(t) || t.closest('[data-notification-bell]') || t.closest('[role="alert"]'))
        return;
      onClose();
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
  useReadWhenVisible(scroller, !list.isError, signature, sendRead);

  const selected = useRowKeys(true, rows, (row, what) => {
    if (what === 'read') void onAction(row, 'read');
    else if (what === 'snooze') {
      if (row.needs && !row.done) void onAction(row, 'snooze', { until: snoozeChoices()[0].until });
    } else {
      const id = openActionOf(row);
      if (id) void onAction(row, id);
    }
  });

  const markAll = async () => {
    await notificationsApi.read({ all: true, tab }).catch(() => undefined);
    refresh();
  };

  const needs = counts.data?.needs ?? 0;
  const updates = counts.data?.updates ?? 0;
  const offline = list.isError || (counts.isError && !list.data);
  const loading = list.isLoading || (list.isPlaceholderData && !list.data);
  const groups = groupByDay(rows);
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
        {nothing &&
          (tab === 'needs' && updates > 0 ? (
            <EmptyState
              icon="check"
              title="Nothing needs you"
              text={`${updates} update${updates === 1 ? '' : 's'} from today are in the other tab.`}
            />
          ) : (
            <EmptyState
              icon="bell"
              title="No notifications yet"
              text="When an AI member needs an answer, a run fails or a page is published, it shows up here."
            />
          ))}
        {groups.map((g) => (
          <div key={g.label} style={{ display: 'contents' }}>
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
