/**
 * A pasted address that points at a page of this app (RichDocsLinks D 24): `?docs=<page id>`, with `#block-<id>` for
 * a block. Pasted in the same space it becomes a chip; elsewhere it stays a plain link.
 */

import { blockOfAnchor } from './blockAnchor';

/** What a pasted link to a page names. */
export interface PastedPageLink {
  pageId: string;
  /** The block it points at (`#block-b-…`), if any. */
  blockId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads a pasted address: the page (by id) and block it points at, when it is an address of this app.
 * @param text - The pasted text.
 * @param origin - This app's origin (`window.location.origin`).
 * @returns null when it is not a link to a page of this app.
 */
export function parsePastedPageLink(text: string, origin: string): PastedPageLink | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const pageId = url.searchParams.get('docs');
  if (!pageId || !UUID.test(pageId)) return null;
  return { pageId, blockId: blockOfAnchor(url.hash.replace(/^#/, '')) };
}
