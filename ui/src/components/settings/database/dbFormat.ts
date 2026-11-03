import type { Engine, NamedTarget } from '../../../api/database';
import { formatBytes } from '../../../utils/workspaceTree';

/** Words and numbers of the Database card and the move wizard (design/screens/ai-databases.md). */

export { formatBytes };

/** The two letters of an engine's badge. */
export const ENGINE_ABBR: Record<Engine, string> = { sqlite: 'SQ', postgresql: 'PG', mysql: 'MY' };

/** An engine's name for people. */
export const ENGINE_NAME: Record<Engine, string> = {
  sqlite: 'SQLite',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
};

/** The port a server engine listens on unless told otherwise. */
export const DEFAULT_PORT: Record<Exclude<Engine, 'sqlite'>, number> = { postgresql: 5432, mysql: 3306 };

/** 61402 → "61,402". */
export function fmtInt(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('en-US');
}

/** Seconds as a clock: 134 → "2:14". */
export function fmtClock(s: number | null | undefined): string {
  const t = Math.max(0, Math.round(s ?? 0));
  const m = Math.floor(t / 60);
  const sec = t % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Seconds as a duration: 221 → "3 min 41 s". */
export function fmtDuration(s: number | null | undefined): string {
  const t = Math.max(0, Math.round(s ?? 0));
  if (t < 60) return `${t} s`;
  const m = Math.floor(t / 60);
  return t % 60 ? `${m} min ${t % 60} s` : `${m} min`;
}

/** What is left of a copy: "about 3 minutes left". */
export function fmtLeft(s: number | null | undefined): string | null {
  if (s == null) return null;
  if (s < 60) return 'less than a minute left';
  const m = Math.round(s / 60);
  return m === 1 ? 'about a minute left' : `about ${m} minutes left`;
}

/** A test line's title, split on its first " · ": the first part is drawn bold. */
export function splitTitle(title: string): [string, string] {
  const i = title.indexOf(' · ');
  return i < 0 ? [title, ''] : [title.slice(0, i), title.slice(i + 3)];
}

/** Where a server database is, in short: "db.internal" (or the file's name). */
export function shortWhere(t: Partial<NamedTarget> | null | undefined): string {
  if (!t) return '';
  if (t.engine === 'sqlite') return t.path?.split(/[\\/]/).pop() ?? 'local file';
  return t.host ?? '';
}

/** A target as a URL without a password, for the script's `--to`. */
export function targetUrl(t: Partial<NamedTarget> | null | undefined): string | null {
  if (!t?.engine) return null;
  if (t.engine === 'sqlite') return t.path ? `sqlite:///${t.path}` : null;
  const user = t.user ? `${t.user}@` : '';
  return `${t.engine}://${user}${t.host ?? 'HOST'}:${t.port ?? DEFAULT_PORT[t.engine]}/${t.name ?? 'DATABASE'}`;
}

/** The name a person types to empty a database: its name, or the file's name. */
export function confirmName(t: Partial<NamedTarget> | null | undefined): string {
  if (!t) return '';
  if (t.engine === 'sqlite') return t.path?.split(/[\\/]/).pop() ?? '';
  return t.name ?? '';
}

/** Epoch seconds as "12 Nov" (with the year when it is not this one). */
export function fmtDay(epochS: number | null | undefined): string {
  if (!epochS) return '';
  const d = new Date(epochS * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}
