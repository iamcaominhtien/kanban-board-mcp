import { useCallback, useEffect, useRef, useState } from 'react';
import {
  boardUrl,
  focusDocsWindow,
  onDocsWindow,
  openDocsWindow,
  sendDocsWindow,
  WINDOW_ID,
  type DocsWindowMessage,
} from './docsWindow';

/** How often a Docs window says it is still open, and how long the board waits before it stops believing it. */
export const HEARTBEAT_MS = 4000;
export const GONE_AFTER_MS = 11000;
/** How long a Docs window waits for the board to take it back before it becomes the whole app itself. */
export const DOCK_WAIT_MS = 700;

function currentPage(projectId: string): string | null {
  try {
    return localStorage.getItem(`docsPage:${projectId}`);
  } catch {
    return null;
  }
}

export interface DocsWindowHost {
  /** The Docs window open for this project, with the page it shows; null when Docs is here. */
  popped: { windowId: string; pageId: string | null } | null;
  /** Pop Docs out into its own window, on this page. False when the browser blocked the window. */
  popOut: (pageId: string | null) => boolean;
  /** Bring the Docs window to the front. */
  focus: () => void;
  /** Take Docs back into the board: the Docs window closes and the board opens Docs on its page. */
  dockBack: () => void;
  /** Show a page in the Docs window (a link opened on the board while Docs is in its own window). */
  openPage: (pageId: string) => void;
}

/**
 * The board's side: knows whether this project's Docs is open in its own window, opens one, and takes it back.
 * @param projectId - The project shown on the board.
 * @param onDock - Called with the page to open when Docs comes back into the board.
 * @param onOpenTicket - Called when the Docs window asks the board to open a ticket.
 */
export function useDocsWindowHost(
  projectId: string,
  onDock: (pageId: string | null) => void,
  onOpenTicket?: (ticketId: string) => void,
): DocsWindowHost {
  const [popped, setPopped] = useState<DocsWindowHost['popped']>(null);
  const seen = useRef(0);
  const dockRef = useRef(onDock);
  const ticketRef = useRef(onOpenTicket);
  useEffect(() => {
    dockRef.current = onDock;
    ticketRef.current = onOpenTicket;
  });

  useEffect(() => {
    setPopped(null);
    if (!projectId) return;
    const off = onDocsWindow((msg: DocsWindowMessage) => {
      if (!('projectId' in msg) || msg.projectId !== projectId) return;
      if (msg.type === 'here') {
        if (msg.windowId === WINDOW_ID) return;
        seen.current = Date.now();
        setPopped((p) =>
          p && p.windowId === msg.windowId && p.pageId === msg.pageId
            ? p
            : { windowId: msg.windowId, pageId: msg.pageId },
        );
      } else if (msg.type === 'bye') {
        setPopped((p) => (p && p.windowId === msg.windowId ? null : p));
      } else if (msg.type === 'dock') {
        if (msg.windowId === WINDOW_ID) return;
        sendDocsWindow({ type: 'docked', projectId, windowId: msg.windowId });
        setPopped((p) => (p && p.windowId === msg.windowId ? null : p));
        dockRef.current(msg.pageId);
      } else if (msg.type === 'open-ticket') {
        ticketRef.current?.(msg.ticketId);
        sendDocsWindow({ type: 'ticket-opened', projectId, ticketId: msg.ticketId });
      }
    });
    // a Docs window opened before this board was (re)loaded answers the ping
    sendDocsWindow({ type: 'ping', projectId });
    const t = window.setInterval(() => {
      if (seen.current && Date.now() - seen.current > GONE_AFTER_MS) {
        seen.current = 0;
        setPopped(null); // closed without saying so (a crash, the app quit)
      }
    }, 1000);
    return () => {
      off();
      window.clearInterval(t);
    };
  }, [projectId]);

  const popOut = useCallback(
    (pageId: string | null) => {
      const ok = openDocsWindow(projectId, pageId);
      if (ok) setPopped({ windowId: 'opening', pageId });
      seen.current = Date.now();
      return ok;
    },
    [projectId],
  );
  const focus = useCallback(() => focusDocsWindow(projectId), [projectId]);
  const dockBack = useCallback(() => sendDocsWindow({ type: 'dock-request', projectId }), [projectId]);
  const openPage = useCallback(
    (pageId: string) => {
      sendDocsWindow({ type: 'open-page', projectId, pageId });
      focusDocsWindow(projectId);
    },
    [projectId],
  );
  return { popped, popOut, focus, dockBack, openPage };
}

/**
 * The Docs window's side: tells the board it is open and on which page, and docks back into it.
 * @param projectId - The project whose Docs this window shows.
 * @param onOpenPage - Called when the board asks this window to show a page.
 * @returns dock() (back into the board; this window closes) and openTicket() (shown on the board).
 */
export function useDocsWindowGuest(
  projectId: string,
  onOpenPage?: (pageId: string) => void,
): {
  dock: () => void;
  openTicket: (ticketId: string) => void;
} {
  const docking = useRef(false);
  const pageRef = useRef(onOpenPage);
  useEffect(() => {
    pageRef.current = onOpenPage;
  });

  const dock = useCallback(() => {
    if (docking.current) return;
    docking.current = true;
    const pageId = currentPage(projectId);
    let taken = false;
    const off = onDocsWindow((msg) => {
      if (msg.type === 'docked' && msg.windowId === WINDOW_ID) taken = true;
    });
    sendDocsWindow({ type: 'dock', projectId, pageId, windowId: WINDOW_ID });
    window.setTimeout(() => {
      off();
      if (taken) {
        sendDocsWindow({ type: 'bye', projectId, windowId: WINDOW_ID });
        window.close();
        // a window the person opened by hand cannot close itself: it becomes the board instead
        window.setTimeout(() => window.location.replace(boardUrl(projectId, pageId)), 250);
      } else {
        // no board window to dock into: this window becomes the whole app, on the same page
        window.location.replace(boardUrl(projectId, pageId));
      }
    }, DOCK_WAIT_MS);
  }, [projectId]);

  const openTicket = useCallback(
    (ticketId: string) => {
      let opened = false;
      const off = onDocsWindow((msg) => {
        if (msg.type === 'ticket-opened' && msg.ticketId === ticketId) opened = true;
      });
      sendDocsWindow({ type: 'open-ticket', projectId, ticketId });
      window.setTimeout(() => {
        off();
        if (opened) {
          try {
            (window.opener as Window | null)?.focus();
          } catch {
            /* focus is a hint */
          }
          return;
        }
        // no board open: show the ticket in a new board window
        const url = new URL(boardUrl(projectId, null));
        url.searchParams.delete('docs');
        url.searchParams.set('ticket', ticketId);
        window.open(url.toString(), '_blank');
      }, DOCK_WAIT_MS);
    },
    [projectId],
  );

  useEffect(() => {
    let last: string | null | undefined;
    const say = () => {
      const pageId = currentPage(projectId);
      last = pageId;
      sendDocsWindow({ type: 'here', projectId, pageId, windowId: WINDOW_ID });
    };
    say();
    const beat = window.setInterval(say, HEARTBEAT_MS);
    // a page change is told at once, so the board's "open in its own window" card names the right page
    const watch = window.setInterval(() => {
      if (currentPage(projectId) !== last) say();
    }, 800);
    const off = onDocsWindow((msg) => {
      if (msg.type === 'ping' && (!msg.projectId || msg.projectId === projectId)) say();
      else if (msg.type === 'dock-request' && msg.projectId === projectId) dock();
      else if (msg.type === 'focus' && msg.projectId === projectId) window.focus();
      else if (msg.type === 'open-page' && msg.projectId === projectId) {
        pageRef.current?.(msg.pageId);
        window.focus();
      }
    });
    const bye = () => sendDocsWindow({ type: 'bye', projectId, windowId: WINDOW_ID });
    window.addEventListener('pagehide', bye);
    return () => {
      window.clearInterval(beat);
      window.clearInterval(watch);
      off();
      window.removeEventListener('pagehide', bye);
      bye();
    };
  }, [projectId, dock]);

  return { dock, openTicket };
}
