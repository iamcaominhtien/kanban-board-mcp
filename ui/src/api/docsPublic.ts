/**
 * Public links of Docs pages ("Anyone with the link can read", design board "Rich Docs — reading", E): the link of a
 * page as its owner manages it, the project's Docs settings that allow it, and the public page itself, which is read
 * without signing in.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { resolveOrigin } from './resolveOrigin';
import type { RichDoc } from '../types/docs';

/** How long a public link lives. */
export type PublicLinkExpiry = 'never' | '7d' | '30d' | '90d';

/** A live public link. */
export interface PublicLink {
  token: string;
  /** `/?public=<token>`: where the public page opens on this server. */
  path: string;
  expiresAt: string | null;
  showNames: boolean;
  allowIndex: boolean;
  createdBy?: string;
  createdAt?: string;
}

/** A page's public link state: whether the project allows public links, and the live link (null when off). */
export interface PublicLinkState {
  allowed: boolean;
  link: PublicLink | null;
}

/** A change of a page's public link. */
export interface PublicLinkChange {
  on: boolean;
  showNames?: boolean;
  allowIndex?: boolean;
  expires?: PublicLinkExpiry;
}

/** The query key of a page's public link. */
export const publicLinkKey = (pageId: string) => ['docs', 'public-link', pageId] as const;

/**
 * A page's public link (GET /docs/pages/:id/public-link).
 * @param pageId - The page; null disables the query.
 */
export function usePublicLink(pageId: string | null) {
  return useQuery({
    queryKey: publicLinkKey(pageId ?? ''),
    queryFn: async () => (await client.get<PublicLinkState>(`/docs/pages/${pageId}/public-link`)).data,
    enabled: !!pageId,
    retry: false,
  });
}

/**
 * Turns a page's public link on or off, or changes its options (PUT /docs/pages/:id/public-link).
 * @param pageId - The page.
 */
export function useSetPublicLink(pageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (change: PublicLinkChange) =>
      (await client.put<PublicLinkState>(`/docs/pages/${pageId}/public-link`, change)).data,
    onSuccess: (state) => qc.setQueryData(publicLinkKey(pageId), state),
  });
}

/**
 * The full address of a public link on this server.
 * @param link - The link.
 */
export function publicLinkUrl(link: Pick<PublicLink, 'path'>): string {
  return `${resolveOrigin()}${link.path}`;
}

/** What a public link shows (GET /docs/public/:token). */
export interface PublicPage {
  title: string;
  format: 'rich' | 'md';
  content: RichDoc | null;
  markdown: string;
  settings: Record<string, unknown>;
  version: number;
  updatedAt: string;
  /** Who wrote it, when the owner shows names. */
  author: string | null;
  /** The project's name, when the owner shows names. */
  project: string | null;
  /** Search engines may index it. */
  allowIndex: boolean;
}

/** The answer for a link that is off, expired, or whose page is gone. */
export const PUBLIC_GONE = 'gone' as const;

/**
 * Reads a public page. It sends no credentials and no board headers: the public view asks nothing else of the
 * server.
 * @param token - The link's token.
 * @returns The page, or {@link PUBLIC_GONE} when the link is not public (404).
 * @throws When the server cannot be reached or answers with another error.
 */
export async function fetchPublicPage(token: string): Promise<PublicPage | typeof PUBLIC_GONE> {
  const res = await fetch(`${resolveOrigin()}/docs/public/${encodeURIComponent(token)}`, {
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return PUBLIC_GONE;
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  const b = (await res.json()) as Record<string, unknown>;
  return {
    title: typeof b.title === 'string' ? b.title : '',
    format: b.format === 'rich' ? 'rich' : 'md',
    content: (b.content as RichDoc | null) ?? null,
    markdown: typeof b.markdown === 'string' ? b.markdown : '',
    settings: b.settings && typeof b.settings === 'object' ? (b.settings as Record<string, unknown>) : {},
    version: typeof b.version === 'number' ? b.version : 0,
    updatedAt: typeof b.updated_at === 'string' ? b.updated_at : '',
    author: typeof b.author === 'string' ? b.author : null,
    project: typeof b.project === 'string' ? b.project : null,
    allowIndex: b.allow_index === true,
  };
}
