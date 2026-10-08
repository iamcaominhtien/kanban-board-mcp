import type { Comment, Member } from '../../types/ticket';
import { getAvatarColors } from '../MemberAvatar';

export const MAX_COMMENT_CHARS = 10_000;
export const COUNTER_FROM = 9_000;
export const UNDO_MS = 10_000;

/** "19h ago", "yesterday", "Sep 18". */
export function relative(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "Mon, Oct 5 · 4:10 PM" for the hover tooltip. */
export function exactTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

/** Return up to two initials of a name. */
export function initials(name?: string | null): string {
  if (!name || !name.trim()) return 'AN';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export interface Person {
  name: string;
  initials: string;
  bg: string;
  color: string;
  id?: string;
}

/**
 * Display info for a comment author (members by id or name; "user" is the GUI's anonymous author).
 * @param author - Author id or name; `user`, empty or null show as "You".
 * @param members - Project members matched by id or case-insensitive name.
 * @returns Name, initials and avatar colors; unknown authors get neutral colors.
 */
export function personFor(author: string | null | undefined, members: Member[]): Person {
  const a = author ?? '';
  const found = members.find((m) => m.id === a || m.name.toLowerCase() === a.toLowerCase());
  if (found) return { id: found.id, name: found.name, initials: initials(found.name), ...getAvatarColors(found.color) };
  const display = !a || a.toLowerCase() === 'user' ? 'You' : a;
  return { name: display, initials: display === 'You' ? 'ME' : initials(display), bg: '#E6E9F5', color: '#5B5FA8' };
}

/** Local-storage key for a ticket's comment draft. */
export const draftKey = (ticketId: string) => `kanban.commentDraft.${ticketId}`;
/** Local-storage key for a ticket's offline comment queue. */
export const queueKey = (ticketId: string) => `kanban.commentQueue.${ticketId}`;

/**
 * Read JSON from local storage, falling back on any error.
 * @param key - localStorage key.
 * @param fallback - Returned when the key is missing, unparsable or storage is blocked.
 */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Write JSON to local storage, or remove the key when `value` is null.
 * @param key - localStorage key.
 * @param value - Value to store; `null`, `undefined`, an empty array or an empty string removes the key.
 */
export function writeJson(key: string, value: unknown | null): void {
  try {
    if (value == null || (Array.isArray(value) && value.length === 0) || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked: the draft just is not kept */
  }
}

export interface QueuedComment {
  id: string;
  text: string;
  author: string;
  at: string;
}

export type { Comment };
