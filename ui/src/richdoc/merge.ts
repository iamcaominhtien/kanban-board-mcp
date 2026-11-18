/**
 * Three-way merge of a rich page by top-level block (design "Docs states", E 29–37): the version an edit started
 * from (`base`), the edit (`mine`) and the version someone published meanwhile (`theirs`) are matched by `blockId`.
 * A block only one side changed takes that side; a block both changed the same way is taken once; a text block both
 * changed in different parts of its text is joined; any other block both changed is a conflict the person chooses
 * (mine, theirs, or for text both). Pure: the caller passes documents in one form (canonical JSON compares well).
 */

import type { JSONContent } from '@tiptap/core';
import { randomBlockId } from './ids';

/** Who changed a block that was joined without a question. */
export type JoinedBy = 'mine' | 'theirs' | 'both';

/** What happened to a block that was joined. */
export type JoinedKind = 'changed' | 'added' | 'removed';

/** A block the merge joined by itself. */
export interface JoinedBlock {
  id: string;
  by: JoinedBy;
  kind: JoinedKind;
  /** The block as it ends up (the removed block for `removed`). */
  node: JSONContent;
}

/** A block both sides changed differently: the person chooses. */
export interface BlockConflict {
  id: string;
  /** The block in the version the edit started from (null: both added a block with this id). */
  base: JSONContent | null;
  /** The block in the edit (null: removed there). */
  mine: JSONContent | null;
  /** The block in the newer version (null: removed there). */
  theirs: JSONContent | null;
}

/** The choice for one conflict: one side, or (two text blocks) mine followed by theirs. */
export type BlockChoice = 'mine' | 'theirs' | 'both';

/** What {@link mergeBlocks} found. */
export interface BlockMerge {
  joined: JoinedBlock[];
  conflicts: BlockConflict[];
  /** The block ids of the merged page in reading order (each conflict once, where it goes). */
  order: string[];
  /** The merged value of every block that is not a conflict (null: removed). */
  resolved: Map<string, JSONContent | null>;
}

/** Text blocks: "Keep both" puts their paragraph after yours, and changes to different parts are joined. */
export const TEXT_BLOCK_TYPES: ReadonlySet<string> = new Set(['paragraph', 'heading', 'blockquote', 'pullQuote']);

const json = (v: unknown) => JSON.stringify(v ?? null);
const idOf = (node: JSONContent, index: number) => {
  const id = node.attrs?.blockId;
  return typeof id === 'string' && id ? id : `@${index}`;
};

function index(doc: JSONContent | null | undefined): { ids: string[]; map: Map<string, JSONContent> } {
  const blocks = doc?.content ?? [];
  const ids = blocks.map(idOf);
  return { ids, map: new Map(ids.map((id, i) => [id, blocks[i]])) };
}

/** One character (or one inline atom) of a text block with its marks, for joining text changes. */
interface Unit {
  key: string;
  node: JSONContent;
}

function unitsOf(node: JSONContent): Unit[] | null {
  const out: Unit[] = [];
  for (const child of node.content ?? []) {
    if (child.type === 'text' && typeof child.text === 'string') {
      const marks = json(child.marks);
      for (const ch of Array.from(child.text)) out.push({ key: `${ch}\u0000${marks}`, node: { ...child, text: ch } });
    } else if (!child.content) out.push({ key: json(child), node: child });
    else return null;
  }
  return out;
}

function rebuild(units: Unit[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const u of units) {
    const last = out[out.length - 1];
    if (
      u.node.type === 'text' &&
      last?.type === 'text' &&
      json(last.marks) === json(u.node.marks) &&
      typeof last.text === 'string'
    ) {
      out[out.length - 1] = { ...last, text: last.text + (u.node.text ?? '') };
    } else out.push({ ...u.node });
  }
  return out;
}

/** The part of `base` that `next` replaced: [start, end) in base, and what stands there in next. */
function changedRange(base: Unit[], next: Unit[]): { start: number; end: number; with: Unit[] } {
  let start = 0;
  while (start < base.length && start < next.length && base[start].key === next[start].key) start++;
  let tail = 0;
  while (
    tail < base.length - start &&
    tail < next.length - start &&
    base[base.length - 1 - tail].key === next[next.length - 1 - tail].key
  )
    tail++;
  return { start, end: base.length - tail, with: next.slice(start, next.length - tail) };
}

/**
 * Join two edits of one text block that touch different parts of its text, or null when they cannot be joined (other
 * block attributes changed, not a text block, or the changed parts meet).
 * @param base - The block as both started.
 * @param mine - One edit.
 * @param theirs - The other edit.
 */
export function joinText(base: JSONContent, mine: JSONContent, theirs: JSONContent): JSONContent | null {
  if (!base.type || !TEXT_BLOCK_TYPES.has(base.type)) return null;
  if (mine.type !== base.type || theirs.type !== base.type) return null;
  const attrs = (n: JSONContent) => json(n.attrs);
  // a block whose own settings changed on one side keeps them only when the other side left them alone
  const baseAttrs = attrs(base);
  if (attrs(mine) !== baseAttrs && attrs(theirs) !== baseAttrs && attrs(mine) !== attrs(theirs)) return null;
  const b = unitsOf(base);
  const m = unitsOf(mine);
  const t = unitsOf(theirs);
  if (!b || !m || !t) return null;
  const rm = changedRange(b, m);
  const rt = changedRange(b, t);
  const [first, second] = rm.start <= rt.start ? [rm, rt] : [rt, rm];
  if (first.end >= second.start) return null;
  const units = [
    ...b.slice(0, first.start),
    ...first.with,
    ...b.slice(first.end, second.start),
    ...second.with,
    ...b.slice(second.end),
  ];
  const content = rebuild(units);
  const out: JSONContent = { ...base, attrs: attrs(mine) !== baseAttrs ? mine.attrs : theirs.attrs };
  if (!out.attrs) delete out.attrs;
  if (content.length) out.content = content;
  else delete out.content;
  return out;
}

/**
 * Merge an edit with a version published meanwhile, block by block.
 * @param base - The version the edit started from.
 * @param mine - The edit.
 * @param theirs - The newer version.
 */
export function mergeBlocks(
  base: JSONContent | null | undefined,
  mine: JSONContent | null | undefined,
  theirs: JSONContent | null | undefined,
): BlockMerge {
  const B = index(base);
  const M = index(mine);
  const T = index(theirs);
  const joined: JoinedBlock[] = [];
  const conflicts: BlockConflict[] = [];
  const resolved = new Map<string, JSONContent | null>();
  const all = [...new Set([...T.ids, ...M.ids, ...B.ids])];
  for (const id of all) {
    const b = B.map.get(id) ?? null;
    const m = M.map.get(id) ?? null;
    const t = T.map.get(id) ?? null;
    const mc = json(m) !== json(b);
    const tc = json(t) !== json(b);
    const kind = (from: JSONContent | null, to: JSONContent | null): JoinedKind =>
      !from ? 'added' : !to ? 'removed' : 'changed';
    if (!mc && !tc) resolved.set(id, t);
    else if (mc && !tc) {
      resolved.set(id, m);
      joined.push({ id, by: 'mine', kind: kind(b, m), node: (m ?? b) as JSONContent });
    } else if (!mc && tc) {
      resolved.set(id, t);
      joined.push({ id, by: 'theirs', kind: kind(b, t), node: (t ?? b) as JSONContent });
    } else if (json(m) === json(t)) resolved.set(id, t);
    else {
      const text = b && m && t ? joinText(b, m, t) : null;
      if (text) {
        resolved.set(id, text);
        joined.push({ id, by: 'both', kind: 'changed', node: text });
      } else conflicts.push({ id, base: b, mine: m, theirs: t });
    }
  }
  // reading order: the newer version's, with the blocks only the edit has placed after the block they followed there
  const order = [...T.ids];
  const placed = new Set(order);
  let after: string | null = null;
  for (const id of M.ids) {
    if (!placed.has(id)) {
      const at: number = after === null ? 0 : order.indexOf(after) + 1;
      order.splice(at, 0, id);
      placed.add(id);
    }
    after = id;
  }
  return { joined, conflicts, order, resolved };
}

/**
 * The merged page for the choices made: each conflict takes its choice (`mine` when none is given).
 * @param merge - From {@link mergeBlocks}.
 * @param choices - Block id → choice.
 * @param newId - Makes the id of "their" copy when both are kept (random by default).
 */
export function applyChoices(
  merge: BlockMerge,
  choices: Readonly<Record<string, BlockChoice>>,
  newId: () => string = randomBlockId,
): JSONContent {
  const byId = new Map(merge.conflicts.map((c) => [c.id, c]));
  const content: JSONContent[] = [];
  for (const id of merge.order) {
    const c = byId.get(id);
    if (!c) {
      const v = merge.resolved.get(id);
      if (v) content.push(v);
      continue;
    }
    const choice = choices[id] ?? 'mine';
    if (choice === 'theirs') {
      if (c.theirs) content.push(c.theirs);
    } else if (choice === 'both') {
      if (c.mine) content.push(c.mine);
      if (c.theirs) content.push(c.mine ? { ...c.theirs, attrs: { ...c.theirs.attrs, blockId: newId() } } : c.theirs);
    } else if (c.mine) content.push(c.mine);
  }
  return { type: 'doc', content };
}

/**
 * The ids of the blocks of a page that differ from another version of it (added, removed or changed), for the
 * "changes waiting" list.
 * @param from - The version as last saved.
 * @param to - The page now.
 */
export function changedBlocks(
  from: JSONContent | null | undefined,
  to: JSONContent | null | undefined,
): { id: string; node: JSONContent }[] {
  const A = index(from);
  const Z = index(to);
  const out: { id: string; node: JSONContent }[] = [];
  for (const id of new Set([...Z.ids, ...A.ids])) {
    const a = A.map.get(id) ?? null;
    const z = Z.map.get(id) ?? null;
    if (json(a) !== json(z)) out.push({ id, node: (z ?? a) as JSONContent });
  }
  return out;
}
