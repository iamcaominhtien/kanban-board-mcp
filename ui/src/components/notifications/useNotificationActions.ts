import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { aiApi } from '../../api/ai';
import { safetyApi } from '../../api/aiSafety';
import { extractError } from '../../api/extractError';
import { notificationKeys, notificationsApi } from '../../api/notifications';
import type { DayCardData, NotificationRow } from '../../types/notifications';
import { useToast } from '../Toast';
import type { RowActionHandler } from './NotificationRow';

/** Where the app goes for an action that opens something. `extra.ticketId` names the ticket of a line inside a group. */
export type NavigateHandler = (row: NotificationRow, actionId: string, extra?: { ticketId?: string | null }) => void;

/**
 * What a row's buttons do. The ones that change something call the API that already owns it (answer a run, decide
 * an approval, retry a run, snooze, mute, clear, dismiss); the rest go to `navigate`, and opening marks the row read.
 */
export function useNotificationActions(navigate: NavigateHandler): RowActionHandler {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useRef(navigate);
  nav.current = navigate;

  return useCallback(
    async (row, actionId, extra) => {
      const refresh = () => {
        void qc.invalidateQueries({ queryKey: notificationKeys.all });
        void qc.invalidateQueries({ queryKey: ['ai'] });
      };
      try {
        switch (actionId) {
          case 'answer':
            if (extra?.text && row.targetId) {
              await aiApi.answer(row.targetId, extra.text);
              refresh();
            } else nav.current(row, 'open_ticket');
            return;
          case 'approve':
            if (row.targetId) await safetyApi.approve(row.targetId);
            refresh();
            return;
          case 'deny':
            if (row.targetId) await safetyApi.deny(row.targetId);
            refresh();
            return;
          case 'retry':
            if (row.targetKind === 'run' && row.targetId) await aiApi.retry(row.targetId);
            refresh();
            return;
          case 'retry_failed': {
            const ids = (row.data as DayCardData).failedRuns ?? [];
            await Promise.allSettled(ids.map((id) => aiApi.retry(id)));
            refresh();
            return;
          }
          case 'dismiss':
            await notificationsApi.dismiss(row.id);
            refresh();
            return;
          case 'snooze':
            await notificationsApi.snooze(row.id, extra?.until ?? null);
            refresh();
            return;
          case 'unsnooze':
            await notificationsApi.snooze(row.id, null);
            refresh();
            return;
          case 'clear':
            await notificationsApi.clear(row.id, true);
            refresh();
            return;
          case 'read':
            await notificationsApi.read({ ids: [row.id] });
            refresh();
            return;
          case 'mute':
            if (row.ticketId) {
              await notificationsApi.setFollow({
                scope: 'ticket',
                scopeId: row.ticketId,
                level: 'mute',
                projectId: row.projectId,
                label: row.ticketId,
              });
              toast.info(`${row.ticketId} is muted`, 'Questions and approvals still reach you.', 5000);
            }
            refresh();
            return;
          default:
            if (!row.read) void notificationsApi.read({ ids: [row.id] }).then(refresh, () => undefined);
            nav.current(row, actionId, extra);
        }
      } catch (err) {
        toast.error('Could not do that', extractError(err));
      }
    },
    [qc, toast],
  );
}
