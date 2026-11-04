import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { aiApi } from '../../api/ai';
import { extractError } from '../../api/extractError';
import { notificationKeys, notificationsApi } from '../../api/notifications';
import type { DayCardData, NotificationRow } from '../../types/notifications';
import { useToast } from '../Toast';
import { openRun } from '../aiteam/runLink';
import type { RowActionHandler } from './NotificationRow';

/** Where the app goes for an action that opens something. `extra.ticketId` names the ticket of a line inside a group. */
export type NavigateHandler = (row: NotificationRow, actionId: string, extra?: { ticketId?: string | null }) => void;

type Toast = ReturnType<typeof useToast>;
type Extra = Parameters<RowActionHandler>[2];

/** What an action handler gets: the row, the facts of the click and the ways out (refresh, toasts, navigate). */
interface ActionContext {
  row: NotificationRow;
  extra: Extra;
  refresh: () => void;
  toast: Toast;
  navigate: NavigateHandler;
}

type ActionHandler = (c: ActionContext) => Promise<void>;

/** A handler that calls the API when the row has the thing it needs, then refreshes the lists. */
const withRefresh =
  (run: (c: ActionContext) => Promise<unknown> | void): ActionHandler =>
  async (c) => {
    await run(c);
    c.refresh();
  };

const muteFollow = (c: ActionContext, scope: 'ticket' | 'project' | 'kind') => {
  const { row, extra } = c;
  const base = { level: 'mute' as const, projectId: row.projectId };
  if (scope === 'ticket' && row.ticketId) {
    return notificationsApi
      .setFollow({ ...base, scope, scopeId: row.ticketId, label: row.ticketId })
      .then(() => c.toast.info(`${row.ticketId} is muted`, 'Questions still reach you.', 5000));
  }
  if (scope === 'project' && row.projectId) {
    return notificationsApi
      .setFollow({ ...base, scope, scopeId: row.projectId, label: extra?.label })
      .then(() =>
        c.toast.info(
          `${extra?.label ?? 'The project'} is muted`,
          'Needs you items addressed to you still reach you.',
          5000,
        ),
      );
  }
  if (scope === 'kind') {
    return notificationsApi
      .setFollow({ ...base, scope, scopeId: row.kind, label: row.kindLabel })
      .then(() => c.toast.info(`${row.kindLabel} is off`, 'You can turn it back on in Settings.', 5000));
  }
  return undefined;
};

async function retryFailed(c: ActionContext) {
  const ids = (c.row.data as DayCardData).failedRuns ?? [];
  const results = await Promise.allSettled(ids.map((id) => aiApi.retry(id)));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  if (ok > 0) c.toast.info(`Retried ${ok} failed run${ok === 1 ? '' : 's'}`);
  if (ok < ids.length) c.toast.error('Could not retry every run', `${ids.length - ok} did not start.`);
}

/** The run a row is about, for the actions that act on a run. */
function runIdOf(c: ActionContext): string | null {
  return c.row.targetKind === 'run' && c.row.targetId ? c.row.targetId : null;
}

const HANDLERS = new Map<string, ActionHandler>(
  Object.entries<ActionHandler>({
    async answer(c) {
      if (c.extra?.text && c.row.targetId) {
        await aiApi.answer(c.row.targetId, c.extra.text);
        c.refresh();
      } else c.navigate(c.row, 'open_ticket');
    },
    retry: withRefresh(async (c) => {
      if (c.row.targetKind === 'run' && c.row.targetId) await aiApi.retry(c.row.targetId);
    }),
    retry_failed: withRefresh(retryFailed),
    cancel: withRefresh(async (c) => {
      const id = runIdOf(c);
      if (id) await aiApi.cancel(id);
    }),
    open_run_log(c) {
      const id = runIdOf(c);
      if (!id) {
        openInApp(c, 'open_run_log');
        return Promise.resolve();
      }
      if (!c.row.read) void notificationsApi.read({ ids: [c.row.id] }).then(c.refresh, () => undefined);
      openRun(id);
      c.navigate(c.row, 'open_run');
      return Promise.resolve();
    },
    dismiss: withRefresh((c) => notificationsApi.dismiss(c.row.id)),
    snooze: withRefresh((c) => notificationsApi.snooze(c.row.id, c.extra?.until ?? null)),
    unsnooze: withRefresh((c) => notificationsApi.snooze(c.row.id, null)),
    clear: withRefresh((c) => notificationsApi.clear(c.row.id, true)),
    read: withRefresh((c) => notificationsApi.read({ ids: [c.row.id] })),
    mute: withRefresh((c) => muteFollow(c, 'ticket')),
    mute_project: withRefresh((c) => muteFollow(c, 'project')),
    mute_kind: withRefresh((c) => muteFollow(c, 'kind')),
  }),
);

/** Anything else goes to the app: opening it marks the row read. */
function openInApp(c: ActionContext, actionId: string) {
  if (!c.row.read) void notificationsApi.read({ ids: [c.row.id] }).then(c.refresh, () => undefined);
  c.navigate(c.row, actionId, c.extra);
}

/**
 * What a row's buttons do. The ones that change something call the API that already owns it (answer a run, decide
 * a run, retry a run, snooze, mute, clear, dismiss); the rest go to `navigate`, and opening marks the row read.
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
      const c: ActionContext = { row, extra, refresh, toast, navigate: (...args) => nav.current(...args) };
      try {
        const handler = HANDLERS.get(actionId);
        if (handler) await handler(c);
        else openInApp(c, actionId);
        return true;
      } catch (err) {
        toast.error('Could not do that', extractError(err));
        return false;
      }
    },
    [qc, toast],
  );
}
