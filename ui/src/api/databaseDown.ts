/**
 * "The board cannot reach its database" (design/screens/ai-databases.md E3): while the server database does not
 * answer, every API call gets a 503 with `detail.code === "database_unreachable"`. The axios client reports those
 * here, and the reconnect screen mounted at the app root listens.
 */

/** Where the board was trying to read, as the server says it (no password). */
export interface UnreachableTarget {
  engine?: string;
  host?: string;
  port?: number;
  name?: string;
  label?: string;
  display?: string;
}

/** What the server says while the database does not answer. */
export interface DatabaseUnreachable {
  /** Epoch seconds since the database stopped answering. */
  since: number;
  error: string;
  target: UnreachableTarget;
}

type Listener = (state: DatabaseUnreachable | null) => void;

let current: DatabaseUnreachable | null = null;
const listeners = new Set<Listener>();

/** The `detail` of a 503 "database_unreachable" answer, or null for any other error. */
export function unreachableOf(err: unknown): DatabaseUnreachable | null {
  const res = (err as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response;
  if (!res || res.status !== 503) return null;
  const detail = res.data?.detail as Record<string, unknown> | undefined;
  if (!detail || typeof detail !== 'object' || detail.code !== 'database_unreachable') return null;
  return {
    since: typeof detail.since === 'number' ? detail.since : Date.now() / 1000,
    error: typeof detail.error === 'string' ? detail.error : '',
    target: (detail.target as UnreachableTarget) ?? {},
  };
}

/** Say the database does not answer (the client does this on each 503 of that kind). */
export function reportDatabaseUnreachable(state: DatabaseUnreachable): void {
  current = state;
  listeners.forEach((fn) => fn(current));
}

/** Say the database answers again. */
export function clearDatabaseUnreachable(): void {
  if (current === null) return;
  current = null;
  listeners.forEach((fn) => fn(null));
}

/** The last state reported, or null while the database answers. */
export function databaseUnreachableNow(): DatabaseUnreachable | null {
  return current;
}

/** Listen for changes; returns the function that stops listening. */
export function subscribeDatabaseUnreachable(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
