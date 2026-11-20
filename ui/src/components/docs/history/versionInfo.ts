/**
 * What a version row says (design "History and comments on rich pages", A 1–3): how many blocks the version changed
 * against the one before it, whether it is the conversion from Markdown or an old Markdown version, whether it is a
 * restore, and what a restore would change (block counts against today's page).
 */

import type { DocsVersionDetail, DocsVersionSummary, RichDoc } from '../../../types/docs';
import { countChanges, countsPhrase, diffBlocks, type ChangeCounts } from './blockDiff';

/** The note of the version the conversion to the rich format made. */
export const CONVERSION_NOTE = 'Converted from Markdown';
/** Who the conversion version is by. */
export const BOARD_AUTHOR = 'Kanban Board';

/** Whether a version is the conversion of the page from Markdown to the rich format. */
export function isConversion(v: Pick<DocsVersionSummary, 'note' | 'author'>): boolean {
  return v.note === CONVERSION_NOTE;
}

/** The version a restore came from ("Restored from v8" → 8), or null. */
export function restoredFrom(v: Pick<DocsVersionSummary, 'note'>): number | null {
  const m = /^Restored from v(\d+)/.exec(v.note ?? '');
  return m ? Number(m[1]) : null;
}

/** Whether a version is stored in the rich format (`md` and a missing format are Markdown). */
export const isRich = (d: DocsVersionDetail | null | undefined): d is DocsVersionDetail & { content: RichDoc } =>
  d?.format === 'rich' && !!d.content;

/** What a row says it changed. */
export type RowChange =
  /** Blocks changed against the version before. */
  | { kind: 'blocks'; counts: ChangeCounts; text: string }
  /** The conversion: how many blocks the page has now. */
  | { kind: 'converted'; blocks: number; text: string }
  /** A Markdown version from before the conversion: no block count. */
  | { kind: 'markdown'; text: string };

/**
 * What a version row says it changed.
 * @param v - The version.
 * @param detail - Its content (undefined while it loads: null is returned).
 * @param prev - The content of the version before it (undefined while it loads; null for v1).
 */
export function rowChange(
  v: DocsVersionSummary,
  detail: DocsVersionDetail | undefined,
  prev: DocsVersionDetail | null | undefined,
): RowChange | null {
  if (!detail) return null;
  if (!isRich(detail)) return { kind: 'markdown', text: 'Markdown' };
  const blocks = detail.content.content?.length ?? 0;
  if (isConversion(v) || (prev && !isRich(prev))) {
    return { kind: 'converted', blocks, text: `${blocks} ${blocks === 1 ? 'block' : 'blocks'}` };
  }
  if (prev === undefined) return null;
  const counts = countChanges(diffBlocks(prev?.content ?? null, detail.content));
  return { kind: 'blocks', counts, text: countsPhrase(counts) };
}

/**
 * What a restore changes, said against today's page: blocks changed, blocks added back (the version has them, the
 * page does not) and blocks removed.
 * @param current - The page now.
 * @param target - The version being restored.
 */
export function restoreCounts(
  current: RichDoc,
  target: RichDoc,
): { changed: number; addedBack: number; removed: number } {
  const c = countChanges(diffBlocks(current, target));
  return { changed: c.changed + c.moved, addedBack: c.added, removed: c.removed };
}

/**
 * The sentence the restore confirm says about comments: "2 comments are on blocks that v12 does not have. They stay
 * in the Comments panel as orphaned threads; nothing is deleted." Null when no comment is affected.
 * @param orphans - From `orphanedByRestore`.
 * @param version - The version being restored.
 */
export function orphanSentence(orphans: number, version: number): string | null {
  if (!orphans) return null;
  const n = orphans === 1 ? '1 comment is' : `${orphans} comments are`;
  return `${n} on blocks that v${version} does not have. They stay in the Comments panel as orphaned threads; nothing is deleted.`;
}
