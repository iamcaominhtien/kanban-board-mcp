/**
 * Suggestions said in words (design "AI teams on rich pages", B 7 and D): the label of each kind of change ("Text
 * edited", "Format", "New block · Callout", "Removed block", "Table replaced"), the formatting a team changed named
 * one by one ("Alignment: left → centre", "Colour: none → green"), the name of a block ("Paragraph 2", "Heading 2
 * “What changed”", "After paragraph 4"), how a suggestion is drawn (a word diff, the block as it would read, the old
 * block struck through, or a whole object with a Before / After switch) and the line of the header chip.
 */

import type { RichDoc } from '../../../types/docs';
import { docToText } from '../../../richdoc';
import { wordDiff, type DiffSeg } from '../../ai/editor/diff';
import type { DocsSuggestion } from './api';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The words for each block type, as the block menu and the design name them. */
const TYPE_NAMES: Record<string, string> = {
  paragraph: 'Paragraph',
  blockquote: 'Quote',
  pullQuote: 'Pull quote',
  bulletList: 'Bulleted list',
  orderedList: 'Numbered list',
  taskList: 'Task list',
  codeBlock: 'Code block',
  table: 'Table',
  image: 'Image',
  callout: 'Callout',
  mathBlock: 'Maths',
  diagram: 'draw.io diagram',
  sketch: 'Sketch',
  canvas: 'Canvas',
  columns: 'Columns',
  video: 'Video',
  htmlEmbed: 'HTML embed',
  linkEmbed: 'Link card',
  fileCard: 'File',
  pageCard: 'Page card',
  ticketCard: 'Ticket card',
  horizontalRule: 'Divider',
};

/** Blocks whose text a team rewrites: a suggestion on one shows the words that changed. */
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

/**
 * Blocks a team never edits inside (a table, an HTML embed, a video, a diagram, a file…): a change to one replaces
 * it whole, and the suggestion shows it as it was and as it would be.
 */
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

/** The word for a block type ("Heading 2" for a heading of level 2). */
export function typeName(node: RichDoc | null | undefined): string {
  if (!node?.type) return 'Block';
  if (node.type === 'heading') return `Heading ${typeof node.attrs?.level === 'number' ? node.attrs.level : 1}`;
  return TYPE_NAMES[node.type] ?? node.type.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/** The plain text of one block (lists one line per item), as search and snippets read it. */
export function blockText(node: RichDoc | null | undefined): string {
  return node ? docToText({ type: 'doc', content: [node] }) : '';
}

const short = (s: string, n = 32) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * The name of a top-level block in words: "Paragraph 2" (its place among the blocks of its kind), "Heading 2 “What
 * changed”" and "Image “Planning night”" (with their text).
 * @param node - The block.
 * @param doc - The page it is on (for the number); without it, the type alone.
 */
export function blockName(node: RichDoc | null | undefined, doc?: RichDoc | null): string {
  if (!node) return 'A block';
  const name = typeName(node);
  if (node.type === 'heading') {
    const t = blockText(node).trim();
    return t ? `${name} “${short(t)}”` : name;
  }
  if (node.type === 'image' || node.type === 'video' || node.type === 'diagram' || node.type === 'fileCard') {
    const a = node.attrs ?? {};
    const t = str(a.caption) || str(a.alt) || str(a.title) || str(a.label) || str(a.name);
    if (t) return `${name} “${short(t)}”`;
  }
  const blocks = doc?.content ?? [];
  const id = str(node.attrs?.blockId);
  const same = blocks.filter((b) => b.type === node.type);
  const at = id ? same.findIndex((b) => str(b.attrs?.blockId) === id) : -1;
  return at >= 0 && same.length > 1 ? `${name} ${at + 1}` : name;
}

/** Where a suggestion sits on the page, in words ("Paragraph 2", "After paragraph 4", "At the start"). */
export function placeName(s: DocsSuggestion, doc: RichDoc | null | undefined): string {
  if (s.kind === 'insert') {
    if (!s.afterBlockId) return 'At the start';
    const prev = doc?.content?.find((b) => str(b.attrs?.blockId) === s.afterBlockId);
    if (!prev) return 'New block';
    const n = blockName(prev, doc);
    return `After ${n.charAt(0).toLowerCase()}${n.slice(1)}`;
  }
  const cur = s.blockId ? doc?.content?.find((b) => str(b.attrs?.blockId) === s.blockId) : null;
  return blockName(cur ?? s.before, doc);
}

/* ---------- formatting named in words ---------- */

/** One formatting change: what changed, from what, to what ("Alignment", "left", "centre"). */
export interface FormatChange {
  what: string;
  from: string;
  to: string;
}

const ALIGN: Record<string, string> = { left: 'left', center: 'centre', right: 'right', justify: 'justified' };
const PLACEMENT: Record<string, string> = {
  block: 'centre',
  center: 'centre',
  left: 'left',
  right: 'right',
  floatLeft: 'float left',
  floatRight: 'float right',
};
const ATTR_NAMES: Record<string, string> = {
  textAlign: 'Alignment',
  placement: 'Image',
  widthPct: 'Width',
  width: 'Width',
  alt: 'Alt text',
  caption: 'Caption',
  level: 'Heading',
  listStyle: 'Marker',
  color: 'Colour',
  kind: 'Callout',
  variant: 'Style',
  style: 'Style',
  indent: 'Indent',
  lineHeight: 'Line height',
  spaceBefore: 'Space before',
  spaceAfter: 'Space after',
  dropCap: 'Drop cap',
  title: 'Title',
  source: 'Source',
  start: 'Starts at',
  language: 'Language',
  icon: 'Icon',
  border: 'Border',
  radius: 'Corners',
  shadow: 'Shadow',
  ratio: 'Columns',
};
/** Attributes that are not formatting (ids, addresses, sizes the editor keeps). */
const SKIP_ATTRS = new Set(['blockId', 'src', 'height', 'id', 'version', 'crop', 'wrapGap', 'poster', 'html', 'href']);
/** What an attribute is when a block does not set it. */
const DEFAULTS: Record<string, unknown> = {
  indent: 0,
  dropCap: 0,
  placement: 'block',
  variant: 'plain',
  start: 1,
  shadow: false,
  textAlign: 'left',
};

function attrWord(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '' || v === false) return 'none';
  if (key === 'textAlign') return ALIGN[str(v)] ?? str(v);
  if (key === 'placement') return PLACEMENT[str(v)] ?? str(v);
  if (key === 'widthPct') return `${String(v)} %`;
  if (key === 'width' && typeof v === 'number') return `${v} px`;
  if (v === true) return 'on';
  if (typeof v === 'string') return short(v, 24);
  return short(JSON.stringify(v), 24);
}

const norm = (key: string, v: unknown) => (v === undefined || v === null || v === '' ? (DEFAULTS[key] ?? null) : v);

/**
 * The formatting changes between two attribute sets, each named in words.
 * @param before - The block's attrs as the team saw them.
 * @param after - Its new attrs.
 */
export function attrChanges(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): FormatChange[] {
  const a = before ?? {};
  const b = after ?? {};
  const out: FormatChange[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (SKIP_ATTRS.has(key)) continue;
    const x = norm(key, a[key]);
    const y = norm(key, b[key]);
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    if (key === 'caption' && x && y) {
      out.push({ what: 'Caption', from: 'old', to: 'changed' });
      continue;
    }
    if (key === 'caption') {
      out.push({ what: 'Caption', from: x ? 'shown' : 'none', to: y ? 'added' : 'removed' });
      continue;
    }
    out.push({
      what: ATTR_NAMES[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()),
      from: attrWord(key, x),
      to: attrWord(key, y),
    });
  }
  return out;
}

/** The text colours and highlights used in a block (marks), in the order they come. */
function markColours(node: RichDoc | null | undefined): { colour: string[]; highlight: string[] } {
  const colour: string[] = [];
  const highlight: string[] = [];
  const walk = (n: RichDoc) => {
    for (const m of n.marks ?? []) {
      const c = str(m.attrs?.color);
      if (m.type === 'textStyle' && c && !colour.includes(c)) colour.push(c);
      if (m.type === 'highlight' && !highlight.includes(c || 'yellow')) highlight.push(c || 'yellow');
    }
    n.content?.forEach(walk);
  };
  if (node) walk(node);
  return { colour, highlight };
}

const colourWord = (list: string[]) =>
  list.length ? list.map((c) => (c.startsWith('#') ? 'custom' : c)).join(', ') : 'none';

/** List type changes in words ("bullets", "numbered", "tasks"). */
const LIST_WORDS: Record<string, string> = { bulletList: 'bullets', orderedList: 'numbered', taskList: 'tasks' };

/**
 * Everything a suggestion changes in the look of its block, in words: the type ("Style: Paragraph → Quote", "List:
 * bullets → numbered"), the attributes and the colours of its text.
 * @param before - The block as the team saw it.
 * @param after - The block as it would be.
 */
export function formatChanges(before: RichDoc | null | undefined, after: RichDoc | null | undefined): FormatChange[] {
  if (!before || !after) return [];
  const out: FormatChange[] = [];
  if (before.type !== after.type) {
    if (LIST_WORDS[before.type ?? ''] && LIST_WORDS[after.type ?? '']) {
      out.push({ what: 'List', from: LIST_WORDS[before.type!], to: LIST_WORDS[after.type!] });
    } else {
      out.push({ what: 'Style', from: typeName(before), to: typeName(after) });
    }
  } else {
    out.push(...attrChanges(before.attrs, after.attrs));
  }
  const x = markColours(before);
  const y = markColours(after);
  if (colourWord(x.colour) !== colourWord(y.colour))
    out.push({ what: 'Colour', from: colourWord(x.colour), to: colourWord(y.colour) });
  if (colourWord(x.highlight) !== colourWord(y.highlight))
    out.push({ what: 'Highlight', from: colourWord(x.highlight), to: colourWord(y.highlight) });
  return out;
}

/* ---------- what a suggestion is, and how it is drawn ---------- */

/**
 * How a suggestion is drawn: `diff` the words that changed (a text block), `after` the block as it would read (new
 * formatting, a new block), `removed` the block struck through, `whole` an object as it was and as it would be.
 */
export type DrawMode = 'diff' | 'after' | 'removed' | 'whole';

/** A suggestion in words, and how to draw it. */
export interface SuggestionView {
  /** "Text edited", "Format", "New block", "Removed block", "Table replaced"… */
  label: string;
  /** Beside the label: the new block's type ("Callout"), or a short size of a table ("4 × 4, 2 merged cells"). */
  detail: string | null;
  /** The formatting it changes, each in words. */
  changes: FormatChange[];
  mode: DrawMode;
  /** The block before the change (null for a new block). */
  before: RichDoc | null;
  /** The block after the change (null for a removed block). */
  after: RichDoc | null;
}

function tableSize(node: RichDoc): string | null {
  if (node.type !== 'table') return null;
  const rows = node.content ?? [];
  const cols = Math.max(0, ...rows.map((r) => (r.content ?? []).length));
  let merged = 0;
  rows.forEach((r) =>
    (r.content ?? []).forEach((c) => {
      if ((Number(c.attrs?.colspan) || 1) > 1 || (Number(c.attrs?.rowspan) || 1) > 1) merged += 1;
    }),
  );
  const size = `${rows.length} × ${cols}`;
  return merged ? `${size}, ${merged} merged cell${merged === 1 ? '' : 's'}` : size;
}

const REPLACED: Record<string, string> = {
  table: 'Table replaced',
  htmlEmbed: 'Embed replaced',
  video: 'Video replaced',
  diagram: 'Diagram replaced',
  sketch: 'Sketch replaced',
  canvas: 'Canvas replaced',
  fileCard: 'File replaced',
  linkEmbed: 'Link card replaced',
  mathBlock: 'Maths replaced',
  columns: 'Columns replaced',
  image: 'Image replaced',
  pageCard: 'Card replaced',
  ticketCard: 'Card replaced',
};

/**
 * What a suggestion does, in words, and how it is drawn.
 * @param s - The suggestion.
 */
export function describeSuggestion(s: DocsSuggestion): SuggestionView {
  const before = (s.before as RichDoc | null) ?? null;
  if (s.kind === 'insert') {
    const after = (s.after as RichDoc | null) ?? null;
    return { label: 'New block', detail: typeName(after), changes: [], mode: 'after', before: null, after };
  }
  if (s.kind === 'delete') {
    return { label: 'Removed block', detail: null, changes: [], mode: 'removed', before, after: null };
  }
  if (s.kind === 'attrs') {
    const attrs = (s.after as Record<string, unknown> | null) ?? {};
    const after = before ? { ...before, attrs } : null;
    return { label: 'Format', detail: null, changes: formatChanges(before, after), mode: 'after', before, after };
  }
  const after = (s.after as RichDoc | null) ?? null;
  const changes = formatChanges(before, after);
  const type = after?.type ?? before?.type ?? '';
  if (WHOLE_BLOCKS.has(type) && before?.type === after?.type) {
    const textSame = blockText(before) === blockText(after);
    // only its look changed (a video's width and caption): a format change of the object
    const lookOnly = textSame && changes.length > 0 && type !== 'table';
    return {
      label: lookOnly ? 'Format' : (REPLACED[type] ?? 'Replaced'),
      detail: after ? tableSize(after) : null,
      changes: lookOnly ? changes : [],
      mode: 'whole',
      before,
      after,
    };
  }
  if (TEXT_BLOCKS.has(before?.type ?? '') && TEXT_BLOCKS.has(after?.type ?? '')) {
    const edited = blockText(before) !== blockText(after);
    return {
      label: edited ? 'Text edited' : 'Format',
      detail: null,
      changes,
      mode: edited ? 'diff' : 'after',
      before,
      after,
    };
  }
  return { label: REPLACED[type] ?? 'Block replaced', detail: null, changes, mode: 'whole', before, after };
}

/** The words that changed between the block as the team saw it and as it would be. */
export function textDiff(view: SuggestionView): DiffSeg[] {
  return wordDiff(blockText(view.before), blockText(view.after));
}

/* ---------- the header chip ---------- */

/** "3 edits", "1 new block" and "1 removed" from a list, joined in words ("3 edits and 1 new block"). */
export function changesPhrase(list: DocsSuggestion[]): string {
  const edits = list.filter((s) => s.kind === 'replace' || s.kind === 'attrs').length;
  const added = list.filter((s) => s.kind === 'insert').length;
  const removed = list.filter((s) => s.kind === 'delete').length;
  const parts = [
    edits ? `${edits} edit${edits === 1 ? '' : 's'}` : '',
    added ? `${added} new block${added === 1 ? '' : 's'}` : '',
    removed ? `${removed} removed block${removed === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? 'no changes';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Who suggested the changes: the team's name, or "2 teams". */
export function authorsOf(list: DocsSuggestion[]): string {
  const names = [...new Set(list.map((s) => s.author))];
  return names.length === 1 ? names[0] : `${names.length} teams`;
}

/** The chip's line: "Docs team suggested 3 edits and 1 new block". */
export function chipLine(list: DocsSuggestion[]): string {
  return `${authorsOf(list)} suggested ${changesPhrase(list)}`;
}

/** "4 suggestions" / "1 suggestion". */
export const suggestionsWord = (n: number) => `${n} suggestion${n === 1 ? '' : 's'}`;
