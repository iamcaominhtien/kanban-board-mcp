/**
 * What the server removed from HTML embeds when a draft was saved (design "Embeds", frame 73). The edit screen
 * reports the page it sent and the page the server kept; each embed's editing view reads, by its block id, what was
 * removed and says so ("Saved. 3 things were removed…"), with the lines that held them crossed out.
 */

import { useSyncExternalStore } from 'react';
import type { RichDoc } from '../../../types/docs';
import { removedThings, type Removed } from './htmlSandbox';

const removed = new Map<string, Removed>();
const listeners = new Set<() => void>();
let version = 0;

function embedsOf(doc: RichDoc | null | undefined, out = new Map<string, string>()): Map<string, string> {
  if (!doc) return out;
  if (doc.type === 'htmlEmbed') {
    const id = doc.attrs?.blockId;
    if (typeof id === 'string') out.set(id, typeof doc.attrs?.html === 'string' ? doc.attrs.html : '');
  }
  for (const c of doc.content ?? []) embedsOf(c, out);
  return out;
}

/**
 * Compares the HTML embeds of a saved page with what the server kept and remembers what it removed.
 * @param sent - The page as it was sent.
 * @param kept - The page in the server's answer (the draft's `content`); nothing is reported without it.
 */
export function reportSavedEmbeds(sent: RichDoc | null | undefined, kept: RichDoc | null | undefined): void {
  if (!sent || !kept) return;
  const after = embedsOf(kept);
  let changed = false;
  for (const [id, html] of embedsOf(sent)) {
    if (!after.has(id)) continue;
    const r = removedThings(html, after.get(id) ?? '');
    if (r.things.length) {
      removed.set(id, r);
      changed = true;
    } else if (removed.delete(id)) changed = true;
  }
  if (!changed) return;
  version += 1;
  listeners.forEach((l) => l());
}

/** Forgets what was removed from the embed `blockId` (the note was closed, or the lines deleted). */
export function clearRemoved(blockId: string): void {
  if (!removed.delete(blockId)) return;
  version += 1;
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** What the last save removed from the embed `blockId`, or null. */
export function useRemoved(blockId: string | null | undefined): Removed | null {
  useSyncExternalStore(subscribe, () => version);
  return blockId ? (removed.get(blockId) ?? null) : null;
}
