/**
 * Links to a heading or a block of a rich page: the page is opened with the block's id as its anchor (a copied
 * link carries `#block-<id>`), and the reader scrolls to the block and marks it for a few seconds (RichDocsLinks D 25).
 */

import { useSyncExternalStore } from 'react';

/** A block id (`b-` and 6 lower-case hex digits). */
export const BLOCK_ID_RE = /^b-[0-9a-f]{6}$/;

/** How long the arrival mark stays, in ms (it fades out over its last second). */
export const ARRIVE_MS = 4000;

/**
 * The block an anchor names, or null for a heading slug.
 * @param anchor - What follows `#` in a link, or the anchor a chip opens: `b-3f2a9c` or `block-b-3f2a9c`.
 */
export function blockOfAnchor(anchor: string | null | undefined): string | null {
  if (!anchor) return null;
  const id = anchor.startsWith('block-') ? anchor.slice(6) : anchor;
  return BLOCK_ID_RE.test(id) ? id : null;
}

/** The element of a block in the page (`data-block-id`), inside `root`. */
function findBlock(root: ParentNode, blockId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
}

/**
 * Scrolls to a block and marks it (`dk-link-arrive`) for {@link ARRIVE_MS}. A long page comes in piece by piece, so
 * the block is looked for again every 100 ms for about 8 s (a busy machine renders a long page slowly).
 * @param blockId - The block's id.
 * @param root - Where to look (the page; the side panel passes its own body).
 * @returns A function that stops looking and takes the mark away.
 */
export function revealBlock(blockId: string, root: ParentNode = document): () => void {
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let marked: HTMLElement | null = null;
  // the page the link was followed from (the banner names it): the open page when the link is opened
  const from = root === document ? openTitle : null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    marked?.classList.remove('dk-link-arrive');
    marked = null;
    if (arrival?.blockId === blockId) setArrival(null);
  };
  const tick = () => {
    const el = findBlock(root, blockId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('dk-link-arrive');
      // restart the fade when the same block is opened again
      void el.offsetWidth;
      el.classList.add('dk-link-arrive');
      marked = el;
      timer = setTimeout(clear, ARRIVE_MS);
      if (root === document) {
        // the same block revealed again once its page has loaded keeps the page the link came from
        const known = arrival?.blockId === blockId ? arrival.from : null;
        setArrival({ blockId, from: from !== openTitle ? from : known, clear });
      }
    } else if (++tries < 80) {
      timer = setTimeout(tick, 100);
    }
  };
  timer = setTimeout(tick, 60);
  return clear;
}

// ---- the arrival banner (D 25): "Showing the linked block from Decision log · Clear highlight"

/** A block just opened from a link, while it is marked. */
export interface Arrival {
  blockId: string;
  /** The title of the page the link was followed from, when known. */
  from: string | null;
  /** Takes the mark away. */
  clear: () => void;
}

let openTitle: string | null = null;
let arrival: Arrival | null = null;
const listeners = new Set<() => void>();

function setArrival(next: Arrival | null) {
  arrival = next;
  listeners.forEach((fn) => fn());
}

/** Tells which page is open (its title): a link followed from it names it in the arrival banner. */
export function noteOpenPage(title: string | null) {
  openTitle = title;
}

/** The block just opened from a link, while it is marked (null otherwise). */
export function useArrival(): Arrival | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => arrival,
  );
}
