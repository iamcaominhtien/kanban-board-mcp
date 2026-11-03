/**
 * Docs in a window of its own (#268): the Docs space can be popped out of the board into a separate window, and docked
 * back into the board when it is wanted there again.
 *
 * The popped-out window is the same app opened at `?proj=<id>&docs=<page>&docsWindow=1`: App renders only the Docs
 * space for that project (no board, no project sidebar). The two windows talk over a BroadcastChannel (and
 * `postMessage` to the opener, for a browser or an Electron build where the channel is not shared):
 *
 * - the Docs window says `here` when it opens, when its page changes and in answer to a `ping`, and `bye` when it
 *   closes; the board shows "Docs is open in its own window" for that project instead of a second copy of the space;
 * - Dock back (in either window) sends `dock` with the page that is open: the board opens Docs on that page and
 *   answers `docked`, and the Docs window closes. With no board window left to dock into, the Docs window becomes the
 *   whole app on the same page instead.
 */

export const DOCS_WINDOW_PARAM = 'docsWindow';
const CHANNEL = 'kanban-docs-window';
const MARK = 'kanbanDocsWindow';

export type DocsWindowMessage =
  | { type: 'ping'; projectId?: string }
  | { type: 'here'; projectId: string; pageId: string | null; windowId: string }
  | { type: 'bye'; projectId: string; windowId: string }
  | { type: 'dock'; projectId: string; pageId: string | null; windowId: string }
  | { type: 'docked'; projectId: string; windowId: string }
  | { type: 'dock-request'; projectId: string }
  | { type: 'focus'; projectId: string }
  | { type: 'open-page'; projectId: string; pageId: string }
  | { type: 'open-ticket'; projectId: string; ticketId: string }
  | { type: 'ticket-opened'; projectId: string; ticketId: string };

type Listener = (msg: DocsWindowMessage) => void;

/** Whether this window is a popped-out Docs window. */
export function isDocsWindow(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get(DOCS_WINDOW_PARAM) === '1';
}

/** The address of a Docs window for a project, opened on a page. */
export function docsWindowUrl(projectId: string, pageId: string | null, base: string = window.location.href): string {
  const url = new URL(base);
  url.hash = '';
  url.search = '';
  url.searchParams.set('proj', projectId);
  url.searchParams.set('docs', pageId ?? '');
  url.searchParams.set(DOCS_WINDOW_PARAM, '1');
  return url.toString();
}

/** The board's address for the same project and page (what a Docs window turns into when nothing can take it back). */
export function boardUrl(projectId: string, pageId: string | null, base: string = window.location.href): string {
  const url = new URL(base);
  url.hash = '';
  url.search = '';
  url.searchParams.set('proj', projectId);
  url.searchParams.set('docs', pageId ?? '');
  return url.toString();
}

/** A window name per project: opening Docs again for the same project focuses the window that is already open. */
export function docsWindowName(projectId: string): string {
  return `kanban-docs-${projectId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

let channel: BroadcastChannel | null | undefined;
const listeners = new Set<Listener>();
const opened = new Map<string, Window>();

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
  } catch {
    channel = null;
  }
  channel?.addEventListener('message', (e: MessageEvent) => deliver(e.data));
  if (typeof window !== 'undefined') {
    window.addEventListener('message', (e: MessageEvent) => {
      // only a window of this app (the same origin, or file:// in the desktop app, whose origin reads "null")
      if (e.origin !== window.location.origin && !(e.origin === 'null' && window.location.protocol === 'file:')) return;
      if (e.data && typeof e.data === 'object' && e.data[MARK]) deliver(e.data.msg);
    });
  }
  return channel;
}

function deliver(raw: unknown) {
  if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') return;
  for (const fn of [...listeners]) fn(raw as DocsWindowMessage);
}

/** Send a message to the other windows of the app (the channel, the opener and the windows this one opened). */
export function sendDocsWindow(msg: DocsWindowMessage): void {
  const ch = getChannel();
  try {
    ch?.postMessage(msg);
  } catch {
    /* a closed channel: the postMessage paths below still carry it */
  }
  const target = window.location.protocol === 'file:' ? '*' : window.location.origin;
  const peers: Window[] = [];
  if (window.opener && !window.opener.closed) peers.push(window.opener as Window);
  for (const w of opened.values()) if (!w.closed) peers.push(w);
  for (const w of peers) {
    try {
      w.postMessage({ [MARK]: true, msg }, target);
    } catch {
      /* the other window went away */
    }
  }
}

/** Listen to the other windows; returns the unsubscribe function. */
export function onDocsWindow(fn: Listener): () => void {
  getChannel();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Open (or focus) the Docs window of a project on a page. Returns false when the browser blocked the window. */
export function openDocsWindow(projectId: string, pageId: string | null): boolean {
  getChannel();
  const name = docsWindowName(projectId);
  const known = opened.get(projectId);
  if (known && !known.closed) {
    known.focus();
    return true;
  }
  const w = window.open(
    docsWindowUrl(projectId, pageId),
    name,
    'popup=yes,width=1180,height=860,menubar=no,toolbar=no,location=no,status=no',
  );
  if (!w) return false;
  opened.set(projectId, w);
  try {
    w.focus();
  } catch {
    /* focus is a hint */
  }
  return true;
}

/** Bring the Docs window of a project to the front (a window this one opened; else ask it over the channel). */
export function focusDocsWindow(projectId: string): void {
  const known = opened.get(projectId);
  if (known && !known.closed) {
    known.focus();
    return;
  }
  sendDocsWindow({ type: 'focus', projectId });
}

/** A short random id for this window, so a window ignores its own messages. */
export const WINDOW_ID = Math.random().toString(36).slice(2, 10);

/** For tests: forget the windows this one opened and the channel. */
export function resetDocsWindowForTests(): void {
  opened.clear();
  listeners.clear();
  try {
    channel?.close();
  } catch {
    /* already closed */
  }
  channel = undefined;
}
