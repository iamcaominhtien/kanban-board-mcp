/**
 * Words for the blocks of a rich page in the Docs states (RichDocsStates D, E): "Block 4 · paragraph", the kind of
 * change a queued edit is, and the plain labels for a changed picture position or width ("Picture: left → centre").
 */

import type { JSONContent } from '@tiptap/core';
import type { RichDoc } from '../../../types/docs';
import { blockText, formatChanges } from '../suggestions/describe';

const KIND: Record<string, string> = {
  paragraph: 'paragraph',
  heading: 'heading',
  blockquote: 'quote',
  pullQuote: 'pull quote',
  bulletList: 'list',
  orderedList: 'list',
  taskList: 'checklist',
  codeBlock: 'code',
  table: 'table',
  image: 'picture',
  video: 'video',
  callout: 'callout',
  horizontalRule: 'rule',
  htmlEmbed: 'HTML embed',
  linkEmbed: 'link',
  fileCard: 'file',
  diagram: 'diagram',
  math: 'formula',
  columns: 'columns',
};

/**
 * The plain name of a block's type ("paragraph", "picture", "table").
 * @param node - The block.
 */
export function blockKind(node: JSONContent | null | undefined): string {
  const t = node?.type ?? '';
  return KIND[t] ?? t.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * "Block 4 · paragraph": the 1-based place of a block in a page, and its kind.
 * @param doc - The page the number is counted in.
 * @param id - The block id.
 * @param node - The block (for its kind) when it is not in `doc`.
 */
export function blockLabel(doc: JSONContent | null | undefined, id: string, node?: JSONContent | null): string {
  const blocks = doc?.content ?? [];
  const i = blocks.findIndex((b) => b.attrs?.blockId === id);
  const kind = blockKind(i >= 0 ? blocks[i] : node);
  return i >= 0 ? `Block ${i + 1} · ${kind}` : `A ${kind}`;
}

/** The groups of the "changes waiting" list (frame 24). */
export type ChangeGroup = 'text' | 'table' | 'picture' | 'other';

/**
 * Which group of the changes-waiting list a block belongs to.
 * @param node - The block.
 */
export function changeGroup(node: JSONContent): ChangeGroup {
  if (node.type === 'table') return 'table';
  if (node.type === 'image') return 'picture';
  if (
    ['paragraph', 'heading', 'blockquote', 'pullQuote', 'bulletList', 'orderedList', 'taskList', 'callout'].includes(
      node.type ?? '',
    )
  )
    return 'text';
  return 'other';
}

/** A label for a change, and its tone: green (a setting), amber (a picture moved by the other person), blue (text). */
export interface ChangeChip {
  text: string;
  tone: 'green' | 'amber' | 'blue';
}

/**
 * What one side changed in a block against the version both started from, as plain labels (frames 31, 32):
 * "Text changed", "Picture: left → float right", "Width: 100 % → 40 %", in the words History uses.
 * @param base - The block both started from (null: added).
 * @param side - The block on this side (null: removed).
 * @param theirs - True for the other person's side (a picture move is amber there).
 */
export function changeChips(base: JSONContent | null, side: JSONContent | null, theirs = false): ChangeChip[] {
  if (!side) return [{ text: 'Removed', tone: 'amber' }];
  if (!base) return [{ text: 'Added', tone: 'green' }];
  const out: ChangeChip[] = formatChanges(base as RichDoc, side as RichDoc)
    .filter((c) => c.what !== 'Caption')
    .map((c) => ({
      text: `${c.what}: ${c.from} → ${c.to}`,
      tone: theirs && side.type === 'image' ? 'amber' : 'green',
    }));
  if (side.type === 'image' && (base.attrs?.caption ?? null) !== (side.attrs?.caption ?? null))
    out.push({ text: 'Caption changed', tone: 'blue' });
  else if (blockText(base as RichDoc) !== blockText(side as RichDoc)) out.push({ text: 'Text changed', tone: 'blue' });
  return out.length ? out : [{ text: 'Changed', tone: 'blue' }];
}
