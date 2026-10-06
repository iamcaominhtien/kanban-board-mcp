import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { subscribeSSE } from '../../hooks/sseEvents';
import { useToast } from '../Toast';
import type { DocsPublishedEvent } from '../../types/docsFx';

// ─── own publishes (so this tab does not notify itself) ───────────────────────

const ownPublishes = new Map<string, number>();
let lastOwnPublish = 0;

/** Call right after this tab publishes a page (DocsEditScreen / lead) so its own `docs_published` event is ignored. */
export function markOwnPublish(pageId: string) {
  const now = Date.now();
  ownPublishes.set(pageId, now);
  lastOwnPublish = now;
}

// ─── follow-space preference (localStorage `docsFollow:<projectId>`, default off) ──

const followKey = (id: string) => `docsFollow:${id}`;
const followListeners = new Set<() => void>();

export function getDocsFollow(projectId: string): boolean {
  try {
    return localStorage.getItem(followKey(projectId)) === '1';
  } catch {
    return false;
  }
}

export function setDocsFollow(projectId: string, on: boolean) {
  try {
    localStorage.setItem(followKey(projectId), on ? '1' : '0');
  } catch {
    /* ignore */
  }
  followListeners.forEach((l) => l());
}

export function useDocsFollow(projectId: string): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (l) => {
      followListeners.add(l);
      window.addEventListener('storage', l);
      return () => {
        followListeners.delete(l);
        window.removeEventListener('storage', l);
      };
    },
    () => getDocsFollow(projectId),
    () => false,
  );
  const set = useCallback((v: boolean) => setDocsFollow(projectId, v), [projectId]);
  return [on, set];
}

// ─── the hook ─────────────────────────────────────────────────────────────────

function parseEvent(data: string): DocsPublishedEvent | null {
  if (!data || data[0] !== '{') return null;
  try {
    const j = JSON.parse(data) as Record<string, unknown>;
    if (j.type !== 'docs_published') return null;
    return {
      type: 'docs_published',
      projectId: String(j.project_id ?? j.projectId ?? ''),
      pageId: String(j.page_id ?? j.pageId ?? ''),
      title: String(j.title ?? ''),
      version: Number(j.version ?? 0),
      author: String(j.author ?? ''),
      note: (j.note as string | null | undefined) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * While the Follow-space toggle is on for the project, shows a toast
 * "<author> published v<N> of <title>" with an Open action when someone else publishes a page.
 */
export function useDocsNotifications({ projectId, onOpenPage }: { projectId: string; onOpenPage: (pageId: string) => void }) {
  const toast = useToast();
  const [follow] = useDocsFollow(projectId);
  const openRef = useRef(onOpenPage);
  openRef.current = onOpenPage;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    if (!follow || !projectId) return;
    return subscribeSSE((data) => {
      const ev = parseEvent(data);
      if (!ev || ev.projectId !== projectId) return;
      const now = Date.now();
      const own = ownPublishes.get(ev.pageId);
      if (own !== undefined && now - own < 15_000) return;
      if (ev.author === 'user' && now - lastOwnPublish < 5_000) return;
      toastRef.current.showToast({
        variant: 'info',
        title: `${ev.author || 'Someone'} published v${ev.version} of ${ev.title}`,
        message: ev.note || undefined,
        duration: 10_000,
        action: { label: 'Open', onClick: () => openRef.current(ev.pageId) },
      });
    });
  }, [follow, projectId]);
}
