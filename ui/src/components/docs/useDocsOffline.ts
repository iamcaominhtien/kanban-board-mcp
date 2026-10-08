import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DocsHeading, DocsPage, DocsTreeNode } from '../../types/docs';
import type { DocsSearchMatch, DocsSearchPage, DocsSearchResponse } from '../../types/docsFx';

/** Max number of pages kept in the offline cache per project (most recent first). */
export const DOCS_CACHE_MAX_PAGES = 20;

export interface CachedDocsPage {
  id: string;
  title: string;
  markdown: string;
  version: number;
  savedAt: string;
  headings: DocsHeading[];
  status: 'draft' | 'published';
  parentId: string | null;
  updatedAt: string;
  updatedBy: string;
}

interface DocsCache {
  tree: { nodes: DocsTreeNode[]; savedAt: string } | null;
  pages: CachedDocsPage[];
}

const key = (projectId: string) => `docsCache:${projectId}`;

function read(projectId: string): DocsCache {
  try {
    const raw = localStorage.getItem(key(projectId));
    if (raw) {
      const v = JSON.parse(raw) as DocsCache;
      return { tree: v.tree ?? null, pages: Array.isArray(v.pages) ? v.pages : [] };
    }
  } catch {
    /* corrupt or unavailable */
  }
  return { tree: null, pages: [] };
}

function write(projectId: string, cache: DocsCache) {
  try {
    localStorage.setItem(key(projectId), JSON.stringify(cache));
  } catch {
    // quota: drop the oldest half of the pages and retry once
    try {
      const trimmed = { ...cache, pages: cache.pages.slice(0, Math.ceil(cache.pages.length / 2)) };
      localStorage.setItem(key(projectId), JSON.stringify(trimmed));
    } catch {
      /* give up */
    }
  }
}

export function cacheDocsTree(projectId: string, nodes: DocsTreeNode[]) {
  const c = read(projectId);
  c.tree = { nodes, savedAt: new Date().toISOString() };
  write(projectId, c);
  emit();
}

export function cacheDocsPage(projectId: string, page: DocsPage) {
  const c = read(projectId);
  const entry: CachedDocsPage = {
    id: page.id,
    title: page.title,
    markdown: page.markdown,
    version: page.version,
    savedAt: new Date().toISOString(),
    headings: page.headings ?? [],
    status: page.status,
    parentId: page.parentId,
    updatedAt: page.updatedAt,
    updatedBy: page.updatedBy,
  };
  c.pages = [entry, ...c.pages.filter((p) => p.id !== page.id)].slice(0, DOCS_CACHE_MAX_PAGES);
  write(projectId, c);
  emit();
}

export function getCachedDocsPage(projectId: string, pageId: string): CachedDocsPage | null {
  return read(projectId).pages.find((p) => p.id === pageId) ?? null;
}

export function getDocsCacheStats(projectId: string): { saved: number; total: number | null } {
  const c = read(projectId);
  return { saved: c.pages.length, total: c.tree ? c.tree.nodes.length : null };
}

// ─── online / failed-request detection (module level so every consumer agrees) ──

let failed = false;
const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  window.addEventListener('online', l);
  window.addEventListener('offline', l);
  return () => {
    listeners.delete(l);
    window.removeEventListener('online', l);
    window.removeEventListener('offline', l);
  };
}
const onlineSnapshot = () => (typeof navigator === 'undefined' ? true : navigator.onLine) && !failed;

/** Call when a docs request fails without a server response (network error); a later success clears it. */
export function markDocsRequestFailed(networkError: boolean) {
  if (failed !== networkError) {
    failed = networkError;
    emit();
  }
}

/** navigator.onLine combined with "the last docs request could not reach the server". */
export function useDocsOnline(): boolean {
  return useSyncExternalStore(subscribe, onlineSnapshot, () => true);
}

// ─── offline search over the cache (palette state E4) ─────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface ParsedQuery {
  terms: string[];
  phrases: string[];
  excludes: string[];
}

export function parseSearchQuery(q: string): ParsedQuery {
  const phrases: string[] = [];
  const rest = q.replace(/"([^"]+)"/g, (_, p: string) => {
    phrases.push(p.toLowerCase());
    return ' ';
  });
  const terms: string[] = [];
  const excludes: string[] = [];
  for (const w of rest.split(/\s+/).filter(Boolean)) {
    if (w.startsWith('-') && w.length > 1) excludes.push(w.slice(1).toLowerCase());
    else terms.push(w.toLowerCase());
  }
  return { terms, phrases, excludes };
}

function markAll(text: string, needles: string[]): string {
  const sorted = [...needles].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!sorted.length) return esc(text);
  const re = new RegExp(sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    out += esc(text.slice(last, i)) + '<mark>' + esc(m[0]) + '</mark>';
    last = i + m[0].length;
  }
  return out + esc(text.slice(last));
}

function pathOf(nodes: DocsTreeNode[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  let cur = byId.get(id)?.parentId ?? null;
  while (cur) {
    const n = byId.get(cur);
    if (!n) break;
    out.unshift(n.title);
    cur = n.parentId;
  }
  return out;
}

/** Search titles and saved text of the cached pages of one project. Returns the same shape as the server. */
export function searchDocsCache(
  projectId: string,
  q: string,
  opts: { pageId?: string | null; projectName?: string; headingsOnly?: boolean } = {},
): DocsSearchResponse {
  const t0 = performance.now();
  const cache = read(projectId);
  const { terms, phrases, excludes } = parseSearchQuery(q);
  const needles = [...terms, ...phrases];
  const pages: DocsSearchPage[] = [];
  if (needles.length) {
    for (const p of cache.pages) {
      if (opts.pageId && p.id !== opts.pageId) continue;
      const hay = (p.title + '\n' + p.markdown).toLowerCase();
      if (excludes.some((x) => hay.includes(x))) continue;
      if (!terms.every((t) => hay.includes(t)) || !phrases.every((t) => hay.includes(t))) continue;
      const matches: DocsSearchMatch[] = [];
      const lines = p.markdown.split('\n');
      let section = '';
      let slug = '';
      let hi = -1;
      for (const line of lines) {
        const h = /^#{1,6}\s+(.*)$/.exec(line);
        if (h) {
          hi += 1;
          section = h[1].trim();
          slug =
            p.headings[hi]?.slug ??
            section
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '');
          if (opts.headingsOnly && needles.some((n) => section.toLowerCase().includes(n))) {
            matches.push({ section, slug, snippet: markAll(section, needles) });
          }
          continue;
        }
        if (opts.headingsOnly) continue;
        const low = line.toLowerCase();
        if (needles.some((n) => low.includes(n)) && matches.length < 3) {
          const idx = Math.max(0, Math.min(...needles.map((n) => (low.indexOf(n) < 0 ? 1e9 : low.indexOf(n)))) - 40);
          const text = (idx > 0 ? '…' : '') + line.slice(idx, idx + 200);
          matches.push({ section, slug, snippet: markAll(text, needles) });
        }
      }
      const titleHit = needles.some((n) => p.title.toLowerCase().includes(n));
      if (opts.headingsOnly && !matches.length) continue;
      if (!titleHit && !matches.length) continue;
      pages.push({
        pageId: p.id,
        projectId,
        projectName: opts.projectName ?? '',
        title: p.title,
        path: cache.tree ? pathOf(cache.tree.nodes, p.id) : [],
        status: p.status,
        version: p.version,
        updatedAt: p.updatedAt,
        updatedBy: p.updatedBy,
        matches,
      });
    }
    pages.sort((a, b) => {
      const at = needles.some((n) => a.title.toLowerCase().includes(n)) ? 0 : 1;
      const bt = needles.some((n) => b.title.toLowerCase().includes(n)) ? 0 : 1;
      return at - bt;
    });
  }
  return {
    total: pages.length,
    tookMs: Math.max(1, Math.round(performance.now() - t0)),
    pages,
    tickets: [],
    suggestion: null,
  };
}

// ─── the hook ─────────────────────────────────────────────────────────────────

export interface DocsOffline {
  online: boolean;
  /** Stores the tree (call from a react-query success handler; the hook also does it automatically). */
  cacheTree: (nodes: DocsTreeNode[]) => void;
  cachePage: (page: DocsPage) => void;
  getCachedPage: (pageId: string) => CachedDocsPage | null;
  getCachedTree: () => DocsTreeNode[] | null;
  /** Number of pages saved on this device. */
  cachedCount: number;
  /** For DocsView's offline view: `{savedAt, version}` of a page when offline and it is cached, else undefined. */
  offlineFor: (pageId: string) => { savedAt: string; version: number } | undefined;
  search: (
    q: string,
    opts?: { pageId?: string | null; projectName?: string; headingsOnly?: boolean },
  ) => DocsSearchResponse;
}

/**
 * localStorage LRU cache of the docs tree and the 20 most recent pages, fed automatically by react-query results
 * (`['docs','tree',projectId]` and `['docs','page',id]`). Also tracks connectivity.
 */
export function useDocsOffline(projectId: string): DocsOffline {
  const qc = useQueryClient();
  const online = useDocsOnline();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    listeners.add(bump);
    const cache = qc.getQueryCache();
    const consume = (q: {
      queryKey: readonly unknown[];
      state: { data?: unknown; status: string; error: unknown };
    }) => {
      const k = q.queryKey;
      if (k[0] !== 'docs') return;
      if (q.state.status === 'error') {
        const err = q.state.error as { response?: unknown; code?: string } | null;
        if (err && !err.response && err.code !== 'ERR_CANCELED') markDocsRequestFailed(true);
        return;
      }
      if (q.state.status !== 'success' || q.state.data == null) return;
      markDocsRequestFailed(false);
      if (k[1] === 'tree' && k[2] === projectId && Array.isArray(q.state.data)) {
        cacheDocsTree(projectId, q.state.data as DocsTreeNode[]);
      } else if (k[1] === 'page') {
        const page = q.state.data as DocsPage;
        if (page && page.projectId === projectId && typeof page.markdown === 'string') cacheDocsPage(projectId, page);
      }
    };
    // pick up what is already loaded
    cache.findAll({ queryKey: ['docs'] }).forEach((q) => consume(q as never));
    const unsub = cache.subscribe((e) => {
      if (e.type === 'updated' && (e.action.type === 'success' || e.action.type === 'error')) consume(e.query as never);
    });
    return () => {
      unsub();
      listeners.delete(bump);
    };
  }, [qc, projectId]);

  const cacheTree = useCallback((nodes: DocsTreeNode[]) => cacheDocsTree(projectId, nodes), [projectId]);
  const cachePage = useCallback((page: DocsPage) => cacheDocsPage(projectId, page), [projectId]);
  const getCachedPage = useCallback((id: string) => getCachedDocsPage(projectId, id), [projectId]);
  const getCachedTree = useCallback(() => read(projectId).tree?.nodes ?? null, [projectId]);
  const cachedCount = useMemo(() => read(projectId).pages.length, [projectId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const offlineFor = useCallback(
    (id: string) => {
      if (online) return undefined;
      const p = getCachedDocsPage(projectId, id);
      return p ? { savedAt: p.savedAt, version: p.version } : undefined;
    },
    [online, projectId],
  );
  const search = useCallback(
    (q: string, opts?: { pageId?: string | null; projectName?: string; headingsOnly?: boolean }) =>
      searchDocsCache(projectId, q, opts),
    [projectId],
  );

  return { online, cacheTree, cachePage, getCachedPage, getCachedTree, cachedCount, offlineFor, search };
}
