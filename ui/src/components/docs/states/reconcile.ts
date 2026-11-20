/**
 * Joining a draft with a version someone published meanwhile (RichDocsStates D 23-26, E 29-37): the version the draft
 * started from, the draft and the newer version are read in canonical form and merged block by block
 * (`richdoc/merge`). Changes to different blocks are joined; what both changed is left for the person to choose.
 */

import type { JSONContent } from '@tiptap/core';
import { client } from '../../../api/client';
import { canonicalDoc } from '../../../richdoc';
import { mergeBlocks, type BlockMerge } from '../../../richdoc/merge';
import type { DocsVersionDetail, RichDoc } from '../../../types/docs';

/** What a reconcile found: the merge, and the two versions it was made against. */
export interface Reconciled {
  merge: BlockMerge;
  /** The version the draft started from. */
  base: { version: number; content: RichDoc };
  /** The newer version. */
  theirs: { version: number; content: RichDoc; author: string; at: string; note: string | null };
}

async function version(pageId: string, v: number): Promise<DocsVersionDetail> {
  return (await client.get<DocsVersionDetail>(`/docs/pages/${pageId}/versions/${v}`)).data;
}

/**
 * Merge a draft with the newest version of its page.
 * @param pageId - The page.
 * @param baseVersion - The version the draft started from (0 for a page never published: an empty page).
 * @param latestVersion - The newer version.
 * @param mine - The draft as it is now.
 * @returns The merge, or null when a version is not in the rich format (the caller falls back to Keep mine / Reload).
 * @throws When a version cannot be read (offline, gone).
 */
export async function reconcile(
  pageId: string,
  baseVersion: number,
  latestVersion: number,
  mine: RichDoc,
): Promise<Reconciled | null> {
  const [b, t] = await Promise.all([
    baseVersion > 0 ? version(pageId, baseVersion) : Promise.resolve(null),
    version(pageId, latestVersion),
  ]);
  const baseContent: RichDoc | null = b ? (b.format === 'rich' && b.content ? b.content : null) : { type: 'doc' };
  const theirContent = t.format === 'rich' && t.content ? t.content : null;
  if (!baseContent || !theirContent) return null;
  const c = (d: JSONContent) => canonicalDoc(d) as RichDoc;
  const base = c(baseContent);
  const theirs = c(theirContent);
  return {
    merge: mergeBlocks(base, c(mine), theirs),
    base: { version: baseVersion, content: base },
    theirs: { version: t.version, content: theirs, author: t.author, at: t.createdAt, note: t.note },
  };
}
