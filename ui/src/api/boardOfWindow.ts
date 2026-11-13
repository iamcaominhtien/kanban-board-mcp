/**
 * The board this window loaded, as the server names it (`board` of `GET /workspaces`). The axios client sends it with
 * every request (`X-Kanban-Board`); once another board is open (a switch in another window, the desktop menu or
 * `kanban-db`), the server refuses the changes of this window with 409 `board_switched`, because ticket keys such as
 * `KAN-12` exist on both boards and the change would land on another ticket.
 */

type Listener = () => void;

let loaded: string | null = null;
let refused = false;
const listeners = new Set<Listener>();

/** The board this window loaded, or null before the first answer of `GET /workspaces`. */
export function loadedBoard(): string | null {
  return loaded;
}

/** Note the board a `GET /workspaces` answer names; only the first one is the board of this window. */
export function noteBoard(board: unknown): void {
  if (loaded === null && typeof board === 'string' && board) loaded = board;
}

/** Whether the server refused a change of this window because another board is open. */
export function changeWasRefused(): boolean {
  return refused;
}

/** Whether `err` is the server's refusal of a change made for another board than the one open. */
export function isBoardSwitched(err: unknown): boolean {
  const res = (err as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response;
  const detail = res?.data?.detail as { code?: unknown } | undefined;
  return res?.status === 409 && detail?.code === 'board_switched';
}

/** Called by the client when the server refused a change of this window. */
export function reportRefused(): void {
  refused = true;
  listeners.forEach((l) => l());
}

/** Be told when a change of this window was refused; returns the unsubscribe function. */
export function onRefused(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * This window itself pointed the app at the board's new place (Settings › Data folder, the database wizard): the
 * next `GET /workspaces` names the board of this window again. Also used by the tests.
 */
export function forgetBoardOfWindow(): void {
  loaded = null;
  refused = false;
}
