import { useEffect, useRef } from 'react';
import { useDocsCommentEvents } from '../../../api/docsComments';
import { useToast } from '../../Toast';

const seenKey = (projectId: string, me: string) => `docsCommentSeen:${projectId}:${me}`;

/** The actor the board acts as: a member name chosen for this browser, or the board's own user. */
export function currentActor(): string {
  try {
    return localStorage.getItem('kanbanActor') || 'user';
  } catch {
    return 'user';
  }
}

/**
 * Show a toast when someone @mentions you or replies in a thread you started or joined.
 * Events that arrived before this browser first looked are not announced.
 * @param options.projectId - Project to watch.
 * @param options.onOpenPage - Called with a page id by the toast's Open action.
 */
export function useCommentNotifications({
  projectId,
  onOpenPage,
}: {
  projectId: string;
  onOpenPage: (pageId: string) => void;
}) {
  const me = currentActor();
  const events = useDocsCommentEvents(projectId, me);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const openRef = useRef(onOpenPage);
  openRef.current = onOpenPage;

  useEffect(() => {
    const list = events.data;
    if (!list || !projectId) return;
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(seenKey(projectId, me));
    } catch {
      /* storage unavailable: announce nothing twice in this session */
    }
    const newest = list[0]?.createdAt;
    if (seen === null) {
      try {
        localStorage.setItem(seenKey(projectId, me), newest ?? new Date().toISOString());
      } catch {
        /* ignore */
      }
      return;
    }
    const fresh = list.filter((e) => e.createdAt > seen!).reverse();
    for (const e of fresh) {
      const who = e.actor === 'user' ? 'Someone' : e.actor;
      const mentioned = e.mentioned.some((n) => n.toLowerCase() === me.toLowerCase());
      const title =
        e.kind === 'resolved'
          ? `${who} resolved a thread on ${e.pageTitle}`
          : e.kind === 'reopened'
            ? `${who} reopened a thread on ${e.pageTitle}`
            : mentioned
              ? `${who} mentioned you in a comment on ${e.pageTitle}`
              : `${who} replied to your thread on ${e.pageTitle}`;
      toastRef.current.showToast({
        variant: 'info',
        title,
        message: e.snippet || undefined,
        duration: 10_000,
        action: { label: 'Open', onClick: () => openRef.current(e.pageId) },
      });
    }
    if (newest && newest > seen) {
      try {
        localStorage.setItem(seenKey(projectId, me), newest);
      } catch {
        /* ignore */
      }
    }
  }, [events.data, projectId, me]);
}
