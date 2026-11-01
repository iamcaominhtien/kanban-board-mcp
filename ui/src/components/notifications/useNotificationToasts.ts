import { useEffect, useRef } from 'react';
import { notificationsApi } from '../../api/notifications';
import type { NotificationRow } from '../../types/notifications';
import { useToast, type ToastVariant } from '../Toast';
import type { RowActionHandler } from './NotificationRow';

const POLL_MS = 30_000;
const ERROR_KINDS = new Set(['run_failed', 'run_stopped_memory', 'offline', 'auto_trip', 'account_signed_out']);

/** Failures toast as errors; a question, an approval, a block or a mention as warnings. */
export function toastVariantFor(kind: string): ToastVariant {
  return ERROR_KINDS.has(kind) ? 'error' : 'warning';
}

/** Whether a row from the feed earns a toast: Needs you, loud, unread, still open. Information never does. */
export function earnsToast(row: NotificationRow): boolean {
  return row.needs && row.inapp && !row.read && !row.done && !row.snoozed && !row.gone && !row.cleared;
}

/**
 * Toasts for Needs you (design G): follows `GET /notifications/feed?since=`. The first call only stores `head`, so
 * opening the app never replays old news. Each new open row gets one toast with its action; when the row closes
 * anywhere, its toast goes. Only the window being looked at shows toasts. `headHint` (the bell's `head`) asks
 * again at once when the server announced something; every 30 s is the fallback.
 */
export function useNotificationToasts(onAction: RowActionHandler, headHint: number | undefined) {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const actionRef = useRef(onAction);
  actionRef.current = onAction;

  const since = useRef<number | null>(null);
  const running = useRef(false);
  const again = useRef(false);
  const toasts = useRef(new Map<string, { toastId: string; event: number }>());
  const poll = useRef<() => Promise<void>>(async () => undefined);

  poll.current = async () => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        again.current = false;
        const cursor = since.current;
        const feed = await notificationsApi.feed(cursor ?? undefined);
        if (cursor === null || feed.cursorTooOld) {
          since.current = feed.head;
          continue;
        }
        since.current = feed.head;
        const t = toastRef.current;
        const drop = (rowId: string) => {
          const shown = toasts.current.get(rowId);
          if (shown) {
            t.removeToast(shown.toastId);
            toasts.current.delete(rowId);
          }
        };
        for (const id of feed.resolved ?? []) drop(id);
        for (const row of feed.items ?? []) {
          if (row.done || row.snoozed || row.gone || row.read) {
            drop(row.id);
            continue;
          }
          if (!earnsToast(row) || feed.dnd) continue;
          if (document.visibilityState !== 'visible') continue;
          if (toasts.current.has(row.id)) continue;
          const [first, second] = row.actions;
          const mk = (a?: { id: string; label: string }) =>
            a ? { label: a.label, onClick: () => void actionRef.current(row, a.id) } : undefined;
          const toastId = t.showToast({
            variant: toastVariantFor(row.kind),
            title: row.title,
            message: row.body || undefined,
            duration: 12000,
            action: mk(first),
            secondaryAction: mk(second),
          });
          toasts.current.set(row.id, { toastId, event: row.lastEventId });
        }
      } while (again.current);
    } catch {
      /* offline: the next poll tries again */
    } finally {
      running.current = false;
    }
  };

  useEffect(() => {
    void poll.current();
    const timer = setInterval(() => void poll.current(), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (headHint !== undefined && since.current !== null && headHint !== since.current) void poll.current();
  }, [headHint]);
}
