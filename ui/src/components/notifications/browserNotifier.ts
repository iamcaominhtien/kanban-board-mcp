import type { NotificationFeed, NotificationRow } from '../../types/notifications';

/**
 * The browser notifier (#270, design/screens/notifications.md section J): the state of what the tab that owns the
 * system notifications has told, without the browser objects, so it is tested with plain fakes. It mirrors the
 * desktop app's NotifierCore (desktop/notifier.js): what may notify, at most one notice every 20 s with the rest
 * grouped, one notice per change of a row, and a notice withdrawn when its row is closed.
 */

export const RATE_MS = 20_000;
const TOLD_MAX = 2000;
const LIVE_MAX = 50;

/** What a click on a notice hands back to the page. */
export type NoticeOpen = (NotificationRow & { action?: string }) | { group: true; ids: string[]; needs: boolean };

export interface Notice {
  title: string;
  body: string;
  /** One tag per row, so a newer notice for the same row replaces the older one. */
  tag: string;
  needs: boolean;
  open: NoticeOpen;
}

export interface NotifierContext {
  /** Some tab of this browser is being looked at: a toast is enough. */
  focused: boolean;
  /** Quiet hours hold every notice. */
  quiet: boolean;
}

/**
 * Whether a row of the feed may become a system notice: Needs you rows when their desktop switch is on (the server
 * writes it in `row.desktop`; information rows only when the person switched desktop on for that kind). Never a
 * closed or read row, never while a tab is being looked at (a toast is enough), never in quiet hours.
 */
export function shouldNotify(row: NotificationRow, ctx: NotifierContext): boolean {
  if (!row.desktop || row.done || row.read || row.gone || row.snoozed || row.cleared) return false;
  return !(ctx.focused || ctx.quiet);
}

/** The text of one notice for a row, or for a group that waited for the 20 s window. */
export function noticeFor(rows: NotificationRow[]): Notice {
  if (rows.length === 1) {
    const [row] = rows;
    const id = row.ticketId;
    const where = id && !row.body.includes(id) && !row.title.includes(id) ? `${id} · ` : '';
    return {
      title: row.reminded ? `Still waiting: ${row.title}` : row.title || 'Kanban Board',
      body: `${where}${row.body}`.trim(),
      tag: row.id,
      needs: row.needs,
      open: row,
    };
  }
  const needs = rows.filter((r) => r.needs).length;
  const titles = rows
    .slice(0, 3)
    .map((r) => r.title)
    .filter(Boolean);
  const more = rows.length > 3 ? ` and ${rows.length - 3} more` : '';
  return {
    title: needs > 0 ? `${rows.length} things need you` : `${rows.length} updates`,
    body: `${titles.join(' · ')}${more}`,
    tag: 'kanban-group',
    needs: needs > 0,
    open: { group: true, ids: rows.map((r) => r.id), needs: needs > 0 },
  };
}

export interface NotifierDeps<Handle> {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Shows a notice; returns what is needed to withdraw it, or null when it could not be shown. */
  show: (notice: Notice, sound: { on: boolean; name: string }) => Handle | null;
  close: (handle: Handle) => void;
  context: () => NotifierContext;
  rateMs?: number;
}

/** Decides what the tab that owns the system notifications shows, when, and what it withdraws. */
export class BrowserNotifierCore<Handle> {
  private readonly rateMs: number;
  private readonly told = new Map<string, number>(); // rowId -> last event already told
  private readonly pending = new Map<string, NotificationRow>(); // rowId -> row waiting for the rate window
  private readonly shown = new Map<string, Handle>();
  private readonly handleRows = new Map<Handle, Set<string>>();
  private timer: unknown = null;
  private lastShownAt = -Infinity;
  private quiet = false;
  private sound = { on: true, name: 'chime' };

  constructor(private readonly deps: NotifierDeps<Handle>) {
    this.rateMs = deps.rateMs ?? RATE_MS;
  }

  /** One response of the feed (never the first one, which only gives the cursor). */
  applyFeed(feed: NotificationFeed): void {
    if (typeof feed.quiet === 'boolean') this.quiet = feed.quiet;
    this.sound = { on: feed.sound !== false, name: feed.soundName ?? 'chime' };
    for (const id of feed.resolved ?? []) this.withdraw(id);
    const ctx = this.ctx();
    for (const row of feed.items ?? []) this.applyRow(row, ctx);
  }

  private ctx(): NotifierContext {
    return { ...this.deps.context(), quiet: this.quiet };
  }

  private applyRow(row: NotificationRow, ctx: NotifierContext): void {
    if (row.done || row.read || row.cleared) {
      this.withdraw(row.id);
      return;
    }
    if (this.told.get(row.id) === row.lastEventId) return;
    this.told.delete(row.id);
    this.told.set(row.id, row.lastEventId);
    // only the newest rows are remembered (insertion order: the oldest go first)
    while (this.told.size > TOLD_MAX) this.told.delete(this.told.keys().next().value as string);
    if (shouldNotify(row, ctx)) this.enqueue(row);
  }

  private enqueue(row: NotificationRow): void {
    const now = this.deps.now();
    if (this.timer === null && this.pending.size === 0 && now - this.lastShownAt >= this.rateMs) {
      this.present([row], now);
      return;
    }
    this.pending.delete(row.id); // a changed row moves to the end with its newest text
    this.pending.set(row.id, row);
    if (this.timer === null) {
      const wait = Math.max(0, this.lastShownAt + this.rateMs - now);
      this.timer = this.deps.setTimer(() => this.flush(), wait);
    }
  }

  /** The 20 s window ended: what waited becomes one notice (or nothing if it was resolved, focused or quiet). */
  private flush(): void {
    this.timer = null;
    const rows = [...this.pending.values()];
    this.pending.clear();
    const ctx = this.ctx();
    const still = rows.filter((r) => shouldNotify(r, ctx));
    if (still.length) this.present(still, this.deps.now());
  }

  private present(rows: NotificationRow[], now: number): void {
    this.lastShownAt = now;
    const handle = this.deps.show(noticeFor(rows), this.sound);
    if (handle === null) return;
    for (const r of rows) {
      const previous = this.shown.get(r.id);
      if (previous !== undefined) this.detach(r.id, previous);
      this.shown.set(r.id, handle);
    }
    this.handleRows.set(handle, new Set(rows.map((r) => r.id)));
    while (this.handleRows.size > LIVE_MAX) {
      const oldest = this.handleRows.keys().next().value as Handle;
      this.forget(oldest);
    }
  }

  /** A row was resolved or read: its notice is withdrawn (a grouped one once all its rows are); it leaves the queue. */
  withdraw(rowId: string): void {
    this.pending.delete(rowId);
    const handle = this.shown.get(rowId);
    if (handle === undefined) return;
    this.shown.delete(rowId);
    this.detach(rowId, handle);
  }

  private detach(rowId: string, handle: Handle): void {
    const ids = this.handleRows.get(handle);
    if (!ids) return;
    ids.delete(rowId);
    if (ids.size === 0) {
      this.handleRows.delete(handle);
      this.deps.close(handle);
    }
  }

  /** The browser removed a notice (clicked, closed): forget it. */
  forget(handle: Handle): void {
    const ids = this.handleRows.get(handle);
    if (!ids) return;
    for (const id of ids) if (this.shown.get(id) === handle) this.shown.delete(id);
    this.handleRows.delete(handle);
  }

  /** The tab stopped being the one that notifies: nothing queued is shown. */
  stop(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
