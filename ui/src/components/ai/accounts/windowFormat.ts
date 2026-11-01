import type { AccountWindow, UsageWindow } from '../../../types/aiWindows';

/** How a window reads on the accounts page (design/screens/ai-operations.md, E). Pure, so it can be tested. */

export type WindowTone = 'unknown' | 'ok' | 'warn' | 'full';

/** Amber from 80% used, red when it is used up. */
export function windowTone(used: number | null | undefined): WindowTone {
  if (used == null || Number.isNaN(used)) return 'unknown';
  if (used >= 1) return 'full';
  return used >= 0.8 ? 'warn' : 'ok';
}

/** "92% used", or "not known" when the board has no reading (it never invents a number). */
export function usedText(used: number | null | undefined): string {
  if (used == null || Number.isNaN(used)) return 'not known';
  return `${Math.round(Math.min(1, Math.max(0, used)) * 100)}% used`;
}

/** The bar width, 0..100. */
export function usedPct(used: number | null | undefined): number {
  return used == null ? 0 : Math.round(Math.min(1, Math.max(0, used)) * 100);
}

/** "14:00", in local time. */
export function clock(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "in 1 h 12 min", "in 25 min", "in 2 d 3 h", "now" once the time has come. */
export function countdown(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '';
  const min = Math.ceil((new Date(iso).getTime() - nowMs) / 60_000);
  if (min <= 0) return 'now';
  if (min < 60) return `in ${min} min`;
  if (min < 24 * 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `in ${h} h ${m} min` : `in ${h} h`;
  }
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  return h ? `in ${d} d ${h} h` : `in ${d} d`;
}

/** "14:00", or "Mon 14:00" when the time is not today. */
export function resetClock(iso: string, nowMs: number): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date(nowMs).toDateString();
  return sameDay ? clock(iso) : `${d.toLocaleDateString([], { weekday: 'short' })} ${clock(iso)}`;
}

/** "Window reopens 14:00 · in 1 h 12 min"; empty when the CLI gave no reset time. */
export function reopensText(w: UsageWindow, nowMs: number): string {
  if (!w.resetsAt) return '';
  return `Window reopens ${resetClock(w.resetsAt, nowMs)} · ${countdown(w.resetsAt, nowMs)}`;
}

/** "Read from Claude Code at 09:58" (real readings, not an estimate), or "Not read yet". */
export function readText(readAt: string | null | undefined): string {
  return readAt ? `Read from Claude Code at ${clock(readAt)}` : 'Not read yet';
}

/** "Last read 09:58, before it signed out": the reading of an account that is signed out now. */
export function lastReadText(readAt: string | null | undefined, signedOut: boolean): string {
  if (!readAt || !signedOut) return readText(readAt);
  return `Last read ${clock(readAt)}, before it signed out`;
}

/** Is the account held (its window is used up, or it signed out) right now? */
export function isHeld(a: Pick<AccountWindow, 'heldUntil'>, nowMs: number): boolean {
  return !!a.heldUntil && new Date(a.heldUntil).getTime() > nowMs;
}

/** "2 runs held until 14:00", "Nothing running.", "Room for 1 more run". */
export function runsText(a: AccountWindow, nowMs: number): { running: string; waiting: string } {
  const held = isHeld(a, nowMs);
  const room = Math.max(0, a.maxParallel - a.running.length);
  const waiting =
    a.waiting > 0
      ? held
        ? `${a.waiting} run${a.waiting === 1 ? '' : 's'} held until ${clock(a.heldUntil)}`
        : `${a.waiting} waiting for a free slot`
      : held
        ? `Held until ${clock(a.heldUntil)}, nothing waiting`
        : room > 0
          ? `Room for ${room} more run${room === 1 ? '' : 's'}`
          : 'All slots in use';
  return { running: a.running.length ? '' : 'Nothing running.', waiting };
}

/** "Max 20× · signed in". */
export function planLine(a: Pick<AccountWindow, 'plan' | 'status'>): string {
  const status =
    a.status === 'signed_in' ? 'signed in' : a.status === 'needs_sign_in' ? 'signed out' : a.status.replace(/_/g, ' ');
  return [a.plan, status].filter(Boolean).join(' · ');
}
