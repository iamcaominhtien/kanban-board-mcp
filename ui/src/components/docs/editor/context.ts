import { createContext, useContext } from 'react';
import type { DocsRefRequest, DocsRefResult } from '../../../types/docs';
import { client } from '../../../api/client';

export interface TicketLite {
  id: string;
  title: string;
  status: string;
}

export interface EditorEnv {
  projectId: string;
  currentPageId: string;
  resolver: RefResolver;
  onOpenPage?: (pageId: string, anchor?: string | null) => void;
  onOpenTicket?: (ticketId: string) => void;
}

/** Editor environment: reference resolver and open callbacks. */
export const EditorEnvContext = createContext<EditorEnv | null>(null);
/** Return the editor environment, or null outside an editor. */
export const useEditorEnv = () => useContext(EditorEnvContext);

/** Return a stable cache key for a reference request. */
export const refKey = (r: DocsRefRequest) => (r.kind === 'page' ? `p:${r.title}#${r.anchor ?? ''}` : `t:${r.key}`);

/** Batches [[page]] / ticket-key resolution for all chips of one editor into single requests. */
export class RefResolver {
  private cache = new Map<string, DocsRefResult | null>();
  private pending = new Map<string, DocsRefRequest>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private version = 0;

  constructor(private projectId: string) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getVersion = () => this.version;

  get(ref: DocsRefRequest): DocsRefResult | null | undefined {
    const key = refKey(ref);
    if (this.cache.has(key)) return this.cache.get(key);
    if (!this.pending.has(key)) {
      this.pending.set(key, ref);
      if (!this.timer) this.timer = setTimeout(() => void this.flush(), 30);
    }
    return undefined;
  }

  /** Forget everything (e.g. after the page list changed) so chips resolve again. */
  invalidate() {
    this.cache.clear();
    this.version += 1;
    this.listeners.forEach((l) => l());
  }

  private async flush() {
    this.timer = null;
    const refs = [...this.pending.values()];
    this.pending.clear();
    if (!refs.length) return;
    try {
      const res = await client.post<DocsRefResult[]>(`/projects/${this.projectId}/docs/resolve`, { refs });
      refs.forEach((r, i) => this.cache.set(refKey(r), res.data[i] ?? null));
    } catch {
      refs.forEach((r) => this.cache.set(refKey(r), null));
    }
    this.version += 1;
    this.listeners.forEach((l) => l());
  }
}
