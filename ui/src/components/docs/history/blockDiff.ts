/**
 * Two versions of a rich page compared block by block (design "History and comments on rich pages", B 7–13): the
 * top-level blocks are matched by their `blockId`, and each one is `same`, `added`, `removed`, `changed` (its text,
 * its formatting, or a whole object such as a table or an embed) or `moved`. Each change is named in words
 * ("Text edited", "Alignment: left → centre", "New block · Callout", "Up, from after “Pull quote” to after
 * “Heading”"), and a version row counts them ("3 blocks edited, 1 added"). Pure: no editor and no DOM.
 */

import type { RichDoc } from '../../../types/docs';
import { wordDiff, type DiffSeg } from '../../ai/editor/diff';
import { blockName, blockText, formatChanges, typeName, type FormatChange } from '../suggestions/describe';

/** What happened to one block between the two versions. */
export type ChangeKind = 'same' | 'added' | 'removed' | 'changed' | 'moved';

/**
 * How a changed block is drawn: `text` the words that changed, `format` the block as it is now with its formatting
 * named in words, `whole` the object as it was and as it is (a table, an embed, an image side by side).
 */
export type ChangeDraw = 'text' | 'format' | 'whole';

/** One top-level block of the comparison, in the order the page reads (removed blocks where they were). */
export interface BlockChange {
  kind: ChangeKind;
  /** The block id (or `@<index>` for a block without one, matched by its place). */
  id: string;
  /** The block in the older version (null for a new block). */
  before: RichDoc | null;
  /** The block in the newer version (null for a removed block). */
  after: RichDoc | null;
  /** How a `changed` block is drawn; `null` for the other kinds. */
  draw: ChangeDraw | null;
  /** A `changed` block that also moved. */
  moved: boolean;
  /** The formatting it changes, each in words ("Alignment: left → centre"). */
  changes: FormatChange[];
  /** For a move: where from and where to, in words ("Up, from after “Pull quote” to after “Heading”"). */
  moveText: string | null;
  /** Its index among the top-level blocks of the older / newer version (null where it is not). */
  oldIndex: number | null;
  newIndex: number | null;
}

/** How many blocks of each kind a comparison has. */
export interface ChangeCounts {
  /** Changed blocks (moved ones whose content also changed included). */
  changed: number;
  added: number;
  removed: number;
  /** Blocks that only moved. */
  moved: number;
  unchanged: number;
}

/** Blocks whose text a person edits: a change to one shows the words that changed. */
const TEXT_BLOCKS = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'pullQuote',
  'callout',
  'bulletList',
  'orderedList',
  'taskList',
  'codeBlock',
]);

/** Objects compared as a whole, before and after (an image too, side by side). */
const WHOLE_BLOCKS = new Set([
  'table',
  'htmlEmbed',
  'video',
  'diagram',
  'sketch',
  'canvas',
  'fileCard',
  'linkEmbed',
  'mathBlock',
  'columns',
  'image',
  'pageCard',
  'ticketCard',
]);

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const short = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const json = (v: unknown) => JSON.stringify(v ?? null);

/** A block with every block id left out (ids are not content: a block paired by its words compares by the rest). */
function withoutIds(node: RichDoc): RichDoc {
  const { blockId: _drop, ...attrs } = (node.attrs ?? {}) as Record<string, unknown>;
  void _drop;
  return {
    ...node,
    ...(node.attrs ? { attrs } : {}),
    ...(node.content ? { content: node.content.map(withoutIds) } : {}),
  };
}

/** The key a block is matched by: its block id, or its place when it has none. */
function keyOf(node: RichDoc, index: number): string {
  const id = str(node.attrs?.blockId);
  return id || `@${index}`;
}

/** Longest common subsequence of two key lists: the keys that kept their order (the rest moved). */
function stableKeys(a: string[], b: string[]): Set<string> {
  const n = a.length;
  const m = b.length;
  // a very long page: do not spend seconds on it; nothing is called moved
  if (n * m > 4_000_000) return new Set(a);
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.add(a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/** The caption or alt text of an image, said with its words ("Caption: Planning night → Planning night in Hanoi"). */
function textAttrChanges(before: RichDoc, after: RichDoc): FormatChange[] {
  const out: FormatChange[] = [];
  for (const [key, what] of [
    ['caption', 'Caption'],
    ['alt', 'Alt text'],
    ['title', 'Title'],
  ] as const) {
    const x = str(before.attrs?.[key]);
    const y = str(after.attrs?.[key]);
    if (x !== y) out.push({ what, from: x ? short(x) : 'none', to: y ? short(y) : 'none' });
  }
  return out;
}

/** The marks used in a block's text (bold, italic, links…), for a change no attribute explains. */
function markSet(node: RichDoc | null): string {
  const seen = new Set<string>();
  const walk = (n: RichDoc) => {
    for (const m of n.marks ?? []) seen.add(m.type);
    n.content?.forEach(walk);
  };
  if (node) walk(node);
  return [...seen].sort().join(',');
}

/** How a block changed (both versions have it and they differ). */
function classify(before: RichDoc, after: RichDoc): { draw: ChangeDraw; changes: FormatChange[] } {
  const type = after.type ?? '';
  if (before.type === after.type && WHOLE_BLOCKS.has(type)) {
    if (type === 'image') {
      // the same picture: its look and words changed; another picture: changed as a whole
      const changes = [
        ...formatChanges(before, after).filter((c) => !['Caption', 'Alt text', 'Title'].includes(c.what)),
        ...textAttrChanges(before, after),
      ];
      return { draw: 'whole', changes };
    }
    return { draw: 'whole', changes: [] };
  }
  if (TEXT_BLOCKS.has(before.type ?? '') && TEXT_BLOCKS.has(type)) {
    const changes = formatChanges(before, after);
    if (blockText(before) !== blockText(after)) return { draw: 'text', changes };
    if (!changes.length && markSet(before) !== markSet(after)) {
      changes.push({ what: 'Text style', from: 'before', to: 'changed' });
    }
    return { draw: 'format', changes };
  }
  return { draw: 'whole', changes: formatChanges(before, after) };
}

/** "the start" or the name of the block before `index` in `blocks`, in words. */
function afterWhat(blocks: RichDoc[], index: number, doc: RichDoc): string {
  if (index <= 0) return 'the start';
  const prev = blocks[index - 1];
  const name = shortName(prev, doc);
  return `after ${name}`;
}

/** A block's name, short: a heading or an image by its words, other blocks by their kind and number. */
export function shortName(node: RichDoc | null | undefined, doc?: RichDoc | null): string {
  if (!node) return 'a block';
  const t = blockText(node).trim();
  if (node.type === 'heading' && t) return `“${short(t)}”`;
  if (node.type === 'pullQuote' || node.type === 'callout') return `“${typeName(node)}”`;
  return blockName(node, doc);
}

/** The words of a block (its text nodes, any depth), for pairing blocks whose ids changed. */
function wordsOf(node: RichDoc): string[] {
  const out: string[] = [];
  const walk = (n: RichDoc) => {
    if (typeof n.text === 'string') out.push(n.text);
    (n.content ?? []).forEach(walk);
  };
  walk(node);
  return out.join(' ').toLowerCase().split(/\s+/).filter(Boolean);
}

/** How alike two word lists are (Dice coefficient on the words; two empty blocks are alike). */
function alike(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const count = new Map<string, number>();
  a.forEach((w) => count.set(w, (count.get(w) ?? 0) + 1));
  let both = 0;
  b.forEach((w) => {
    const n = count.get(w) ?? 0;
    if (n > 0) {
      both++;
      count.set(w, n - 1);
    }
  });
  return (2 * both) / (a.length + b.length);
}

/**
 * Pairs the blocks whose ids are not on the other side (a page written again as a whole, by an import or a team's
 * Markdown, gets new ids): in order, a new block of the same type whose words are alike enough (or which sits where
 * a block of its type was) takes the older block's key, so it reads as edited, not as removed and added.
 */
function pairByContent(olds: RichDoc[], news: RichDoc[], oldKeys: string[], newKeys: string[]): string[] {
  const oldSet = new Set(oldKeys);
  const newSet = new Set(newKeys);
  const freeOld = oldKeys.map((k, i) => (newSet.has(k) ? -1 : i)).filter((i) => i >= 0);
  const freeNew = newKeys.map((k, j) => (oldSet.has(k) ? -1 : j)).filter((j) => j >= 0);
  if (!freeOld.length || !freeNew.length || freeOld.length * freeNew.length > 1_000_000) return newKeys;
  const ow = freeOld.map((i) => wordsOf(olds[i]));
  const nw = freeNew.map((j) => wordsOf(news[j]));
  const ok = (a: number, b: number) => olds[freeOld[a]].type === news[freeNew[b]].type && alike(ow[a], nw[b]) >= 0.5;
  const n = freeOld.length;
  const m = freeNew.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let a = n - 1; a >= 0; a--)
    for (let b = m - 1; b >= 0; b--)
      lcs[a][b] = ok(a, b) ? lcs[a + 1][b + 1] + 1 : Math.max(lcs[a + 1][b], lcs[a][b + 1]);
  const out = [...newKeys];
  let a = 0;
  let b = 0;
  while (a < n && b < m) {
    if (ok(a, b)) {
      out[freeNew[b]] = oldKeys[freeOld[a]];
      a++;
      b++;
    } else if (lcs[a + 1][b] >= lcs[a][b + 1]) a++;
    else b++;
  }
  return out;
}

/**
 * Compare two versions of a rich page block by block.
 * @param oldDoc - The older version (null or missing: an empty page).
 * @param newDoc - The newer version.
 * @returns Every top-level block of either version once, in the order the newer page reads, each removed block right
 *   after the block it followed in the older version.
 */
export function diffBlocks(oldDoc: RichDoc | null | undefined, newDoc: RichDoc | null | undefined): BlockChange[] {
  const olds = oldDoc?.content ?? [];
  const news = newDoc?.content ?? [];
  const oldKeys = olds.map(keyOf);
  const newKeys = pairByContent(olds, news, oldKeys, news.map(keyOf));
  const oldAt = new Map(oldKeys.map((k, i) => [k, i]));
  const newAt = new Map(newKeys.map((k, i) => [k, i]));
  const common = (k: string) => oldAt.has(k) && newAt.has(k);
  const stable = stableKeys(oldKeys.filter(common), newKeys.filter(common));
  const oldD = oldDoc ?? { type: 'doc', content: [] };
  const newD = newDoc ?? { type: 'doc', content: [] };

  // removed blocks go after the block they followed in the older version that is still on the page
  const removedAfter = new Map<string | null, BlockChange[]>();
  olds.forEach((node, i) => {
    if (newAt.has(oldKeys[i])) return;
    let anchor: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (newAt.has(oldKeys[j])) {
        anchor = oldKeys[j];
        break;
      }
    }
    const list = removedAfter.get(anchor) ?? [];
    list.push({
      kind: 'removed',
      id: oldKeys[i],
      before: node,
      after: null,
      draw: null,
      moved: false,
      changes: [],
      moveText: null,
      oldIndex: i,
      newIndex: null,
    });
    removedAfter.set(anchor, list);
  });

  const out: BlockChange[] = [...(removedAfter.get(null) ?? [])];
  news.forEach((node, j) => {
    const key = newKeys[j];
    const i = oldAt.get(key);
    if (i === undefined) {
      out.push({
        kind: 'added',
        id: key,
        before: null,
        after: node,
        draw: null,
        moved: false,
        changes: [],
        moveText: null,
        oldIndex: null,
        newIndex: j,
      });
      return;
    }
    const before = olds[i];
    const moved = !stable.has(key);
    const moveText = moved
      ? `${moveDirection(oldKeys, newKeys, key, common)}, from ${afterWhat(olds, i, oldD)} to ${afterWhat(news, j, newD)}`
      : null;
    if (json(withoutIds(before)) === json(withoutIds(node))) {
      out.push({
        kind: moved ? 'moved' : 'same',
        id: key,
        before,
        after: node,
        draw: null,
        moved,
        changes: [],
        moveText,
        oldIndex: i,
        newIndex: j,
      });
    } else {
      const { draw, changes } = classify(before, node);
      out.push({
        kind: 'changed',
        id: key,
        before,
        after: node,
        draw,
        moved,
        changes,
        moveText,
        oldIndex: i,
        newIndex: j,
      });
    }
    out.push(...(removedAfter.get(key) ?? []));
  });
  return out;
}

/** "Up" or "Down": where a moved block went among the blocks both versions have. */
function moveDirection(oldKeys: string[], newKeys: string[], key: string, common: (k: string) => boolean): string {
  const a = oldKeys.filter(common).indexOf(key);
  const b = newKeys.filter(common).indexOf(key);
  return b < a ? 'Up' : 'Down';
}

/** How many blocks of each kind a comparison has. */
export function countChanges(changes: BlockChange[]): ChangeCounts {
  const out: ChangeCounts = { changed: 0, added: 0, removed: 0, moved: 0, unchanged: 0 };
  for (const c of changes) {
    if (c.kind === 'same') out.unchanged += 1;
    else out[c.kind] += 1;
  }
  return out;
}

/** Whether a comparison found no difference at all. */
export function noDifference(counts: ChangeCounts): boolean {
  return counts.changed + counts.added + counts.removed + counts.moved === 0;
}

/**
 * A version row's count of what changed, in words: "3 blocks edited, 1 added", "2 blocks removed", "1 block moved";
 * "No block changed" when only the title or nothing changed.
 * @param counts - From {@link countChanges}.
 */
export function countsPhrase(counts: ChangeCounts): string {
  const parts: [number, string][] = (
    [
      [counts.changed, 'edited'],
      [counts.added, 'added'],
      [counts.removed, 'removed'],
      [counts.moved, 'moved'],
    ] as [number, string][]
  ).filter(([n]) => n > 0);
  if (!parts.length) return 'No block changed';
  return parts
    .map(([n, verb], i) => (i === 0 ? `${n} ${n === 1 ? 'block' : 'blocks'} ${verb}` : `${n} ${verb}`))
    .join(', ');
}

/** A change's label in words: "Text edited", "Format", "New block", "Removed block", "Moved", "Changed as a whole". */
export function changeLabel(c: BlockChange): string {
  switch (c.kind) {
    case 'added':
      return 'New block';
    case 'removed':
      return 'Removed block';
    case 'moved':
      return 'Moved';
    case 'same':
      return 'Unchanged';
    default:
      if (c.draw === 'text') return 'Text edited';
      if (c.draw === 'format') return 'Format';
      return c.after?.type === 'image' && c.changes.length ? 'Format' : 'Changed as a whole';
  }
}

/**
 * Beside the label: the kind of a new or removed block ("Callout"), the size of a table ("Table · 4 × 4"), the kind
 * of an object changed as a whole ("HTML embed").
 */
export function changeDetail(c: BlockChange): string | null {
  const node = c.after ?? c.before;
  if (c.kind === 'added' || c.kind === 'removed') return typeName(node);
  if (c.kind === 'changed' && c.draw === 'whole') {
    if (node?.type === 'table') return `Table · ${tableSize(node)}`;
    return typeName(node);
  }
  return null;
}

/** "4 × 4" or "4 × 4, 2 merged cells". */
export function tableSize(node: RichDoc): string {
  const rows = node.content ?? [];
  const cols = Math.max(0, ...rows.map((r) => (r.content ?? []).length));
  let merged = 0;
  rows.forEach((r) =>
    (r.content ?? []).forEach((c) => {
      if ((Number(c.attrs?.colspan) || 1) > 1 || (Number(c.attrs?.rowspan) || 1) > 1) merged += 1;
    }),
  );
  return merged
    ? `${rows.length} × ${cols}, ${merged} merged cell${merged === 1 ? '' : 's'}`
    : `${rows.length} × ${cols}`;
}

/** What changed in a table, in words: "2 cells changed, 1 row added" (rows compared by place). */
export function tableChangeText(before: RichDoc | null, after: RichDoc | null): string | null {
  if (before?.type !== 'table' || after?.type !== 'table') return null;
  const cells = (t: RichDoc) => (t.content ?? []).map((r) => (r.content ?? []).map((c) => blockText(c)));
  const a = cells(before);
  const b = cells(after);
  let changed = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const n = Math.max(a[i].length, b[i].length);
    for (let k = 0; k < n; k++) if ((a[i][k] ?? '') !== (b[i][k] ?? '')) changed += 1;
  }
  const parts: string[] = [];
  if (changed) parts.push(`${changed} cell${changed === 1 ? '' : 's'} changed`);
  if (b.length > a.length) parts.push(`${b.length - a.length} row${b.length - a.length === 1 ? '' : 's'} added`);
  if (a.length > b.length) parts.push(`${a.length - b.length} row${a.length - b.length === 1 ? '' : 's'} removed`);
  return parts.length ? parts.join(', ') : null;
}

/** The words that changed in a block's text. */
export function changeWords(c: BlockChange): DiffSeg[] {
  return wordDiff(blockText(c.before), blockText(c.after));
}

/** A formatting change on one line: "Alignment: left → centre". */
export function formatWords(f: FormatChange): string {
  return `${f.what}: ${f.from} → ${f.to}`;
}

/**
 * A change's line in the jump list: the block's name, then what changed ("“What changed” · Heading · format",
 * "Paragraph 2 · Text", "Pull quote · Added").
 * @param c - The change.
 * @param doc - The version the block is named in (the newer one; the older one for a removed block).
 */
export function jumpLabel(c: BlockChange, doc?: RichDoc | null): { name: string; what: string } {
  const node = c.after ?? c.before;
  const name = shortName(node, doc);
  const what =
    c.kind === 'added'
      ? 'Added'
      : c.kind === 'removed'
        ? 'Removed'
        : c.kind === 'moved'
          ? 'Moved'
          : c.draw === 'text'
            ? 'Text'
            : c.draw === 'format'
              ? `${typeName(node)} · format`
              : `${typeName(node)} · whole`;
  return { name, what };
}

/** One item of the comparison as drawn: a change, or a run of unchanged blocks folded into one line. */
export type DiffItem =
  { type: 'change'; change: BlockChange; index: number } | { type: 'fold'; blocks: BlockChange[]; key: string };

/**
 * The comparison as drawn: each change on its own, each run of unchanged blocks folded into one line ("12 unchanged
 * blocks · Show"), and past `limit` changes the rest folded too (a very large change stays quick).
 * @param changes - From {@link diffBlocks}.
 * @param limit - How many changes to draw (Infinity: all of them).
 * @param open - Fold keys the reader opened (`fold-<first block id>`): their blocks are drawn.
 */
export function diffItems(changes: BlockChange[], limit = Infinity, open: ReadonlySet<string> = new Set()): DiffItem[] {
  const out: DiffItem[] = [];
  let run: BlockChange[] = [];
  let shown = 0;
  let index = 0;
  const flush = () => {
    if (!run.length) return;
    const key = `fold-${run[0].id}`;
    if (open.has(key)) run.forEach((c) => out.push({ type: 'change', change: c, index: -1 }));
    else out.push({ type: 'fold', blocks: run, key });
    run = [];
  };
  for (const c of changes) {
    if (c.kind === 'same' || shown >= limit) {
      if (c.kind !== 'same') index += 1;
      run.push(c);
      continue;
    }
    flush();
    out.push({ type: 'change', change: c, index });
    index += 1;
    shown += 1;
  }
  flush();
  return out;
}
