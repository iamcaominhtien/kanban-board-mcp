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

/** The detail line under the title: "KAN-215 · Should the export include archived tickets?". */
export function toastDetail(row: NotificationRow): string {
  const id = row.ticketId;
  if (!id || row.body.includes(id) || row.title.includes(id)) return row.body;
  return row.body ? `${id} · ${row.body}` : id;
}

type Feed = Awaited<ReturnType<typeof notificationsApi.feed>>;
type ToastApi = ReturnType<typeof useToast>;
type Shown = Map<string, { toastId: string; event: number }>;

/** Everything a poll needs to show and drop toasts. */
interface ToastContext {
  toast: ToastApi;
  shown: Shown;
  onAction: RowActionHandler;
}

function dropToast(c: ToastContext, rowId: string) {
  const shown = c.shown.get(rowId);
  if (shown) {
    c.toast.removeToast(shown.toastId);
    c.shown.delete(rowId);
  }
}

/** Whether a row of the feed gets a toast now: quiet hours and a hidden window never do (design L). */
function mayToast(row: NotificationRow, feed: Feed): boolean {
  // `dnd` is the setting "follow the system Do not disturb", for the OS notifier; it never silences a toast
  if (!earnsToast(row)) return false;
  // quiet hours (design L): nothing interrupts; the panel still fills
  if (feed.quiet) return false;
  // only the window being looked at toasts: several windows (the desktop app and a tab) would all show the same row
  return document.visibilityState === 'visible' && document.hasFocus();
}

function showRowToast(c: ToastContext, row: NotificationRow) {
  const shown = c.shown.get(row.id);
  // a reminder (the row's newest event moved on) toasts again; the same event never twice
  if (shown && row.lastEventId <= shown.event) return;
  if (shown) dropToast(c, row.id);
  const first = toastAction(row);
  const toastId: string = c.toast.showToast({
    variant: toastVariantFor(row.kind),
    title: row.title,
    message: toastDetail(row) || undefined,
    duration: 12000,
    action: first ? { label: first.label, onClick: () => void c.onAction(row, first.id) } : undefined,
    // closed, timed out or collapsed: forget it, so a later reminder may toast again
    onClose: () => {
      if (c.shown.get(row.id)?.toastId === toastId) c.shown.delete(row.id);
    },
  });
  c.shown.set(row.id, { toastId, event: row.lastEventId });
}

/** Decisions a toast under the cursor must never offer as its one button: they act at once on something unread. */
const NOT_FROM_A_TOAST = new Set(['approve', 'deny', 'retry', 'dismiss']);
/** The toast's one action per kind: the safe way in (read first, then decide), never the decision itself. */
const TOAST_ACTION: Record<string, string> = {
  approval: 'review',
  run_failed: 'open_run_log',
  run_stopped_memory: 'open_run_log',
  blocked: 'change_permission',
};

/** The one action a Needs you toast offers for this row, or none when every action is a decision. */
export function toastAction(row: NotificationRow) {
  const wanted = TOAST_ACTION[row.kind];
  return row.actions.find((a) => a.id === wanted) ?? row.actions.find((a) => !NOT_FROM_A_TOAST.has(a.id));
}

function applyFeed(c: ToastContext, feed: Feed) {
  for (const id of feed.resolved ?? []) dropToast(c, id);
  for (const row of feed.items ?? []) {
    if (row.done || row.snoozed || row.gone || row.read) dropToast(c, row.id);
    else if (mayToast(row, feed)) showRowToast(c, row);
  }
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
  const toasts = useRef<Shown>(new Map());
  const poll = useRef<() => Promise<void>>(() => Promise.resolve());

  const pollOnce = async () => {
    const cursor = since.current;
    const feed = await notificationsApi.feed(cursor ?? undefined);
    since.current = feed.head;
    if (cursor === null || feed.cursorTooOld) return;
    applyFeed(
      { toast: toastRef.current, shown: toasts.current, onAction: (...args) => actionRef.current(...args) },
      feed,
    );
  };

  poll.current = async () => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    again.current = false;
    let failed = false;
    try {
      await pollOnce();
    } catch {
      /* offline: the next poll tries again */
      failed = true;
    } finally {
      running.current = false;
    }
    // something was announced while this poll ran: ask again
    if (!failed && again.current) await poll.current();
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
