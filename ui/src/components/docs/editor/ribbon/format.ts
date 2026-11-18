/**
 * The formatting commands of the ribbon, the selection toolbar, the phone sheets and the shortcuts, and the state they
 * show. Every command writes the format 1 marks and attributes of server/contract/richdoc/schema.json: colours as
 * palette names (or `#rrggbb` for a custom colour), fonts as schema font keys, sizes and spacing in px.
 *
 * Commands dispatch one transaction each (one undo step) and do not move the focus; callers that want the caret back
 * in the page call `editor.commands.focus()` (a phone sheet does not, so the keyboard stays down).
 */

import type { Editor } from '@tiptap/core';
import type { Mark, MarkType, Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { FONT_LABEL, type PageFont } from '../../pageSettings';
import { colorLabel } from './palette';

/** A control's state over the selection: on everywhere, on for part of it, or off. */
export type Tri = 'on' | 'mixed' | 'off';

/** The marks a toggle button shows. */
export const TOGGLE_MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'superscript', 'subscript'] as const;
export type ToggleMark = (typeof TOGGLE_MARKS)[number];

/** The paragraph styles of the Styles menu, in its order. */
export const STYLE_IDS = ['body', 'lead', 'h1', 'h2', 'h3', 'h4', 'quote', 'code', 'small'] as const;
export type StyleId = (typeof STYLE_IDS)[number];

/** Label, size note and shortcut of each style (Editor board 19). */
export const STYLE_INFO: Record<StyleId, { label: string; keys?: string }> = {
  body: { label: 'Body', keys: 'Mod+Alt+0' },
  lead: { label: 'Lead' },
  h1: { label: 'Heading 1', keys: 'Mod+Alt+1' },
  h2: { label: 'Heading 2', keys: 'Mod+Alt+2' },
  h3: { label: 'Heading 3', keys: 'Mod+Alt+3' },
  h4: { label: 'Heading 4', keys: 'Mod+Alt+4' },
  quote: { label: 'Quote', keys: 'Mod+Shift+B' },
  code: { label: 'Code' },
  small: { label: 'Small' },
};

/** The text alignments, with their shortcuts. */
export const ALIGNS = [
  { value: 'left', label: 'Left', keys: 'Mod+Shift+L' },
  { value: 'center', label: 'Centre', keys: 'Mod+Shift+E' },
  { value: 'right', label: 'Right', keys: 'Mod+Shift+R' },
  { value: 'justify', label: 'Justify', keys: 'Mod+Shift+J' },
] as const;
export type Align = (typeof ALIGNS)[number]['value'];

/** Line heights of the spacing menu (1.75 is the book setting). */
export const LINE_HEIGHTS = [
  { value: 1, label: '1.0', note: 'Tight' },
  { value: 1.25, label: '1.25' },
  { value: 1.5, label: '1.5' },
  { value: 1.75, label: '1.75', note: 'Book' },
  { value: 2, label: '2.0', note: 'Double' },
] as const;

/** Sizes offered in the size menu (px); a typed size goes from 8 to 160. */
export const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64] as const;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 160;
/** The deepest indent of a paragraph (schema.json `indent` max). */
export const MAX_INDENT = 8;
/** The drop cap heights a paragraph can have (schema.json `dropCap`). */
export const DROP_CAPS = [0, 2, 3, 4, 5] as const;

/** The attributes "Clear paragraph formatting" puts back, with their defaults. */
const BLOCK_DEFAULTS: Record<string, unknown> = {
  textAlign: null,
  indent: 0,
  lineHeight: null,
  spaceBefore: null,
  spaceAfter: null,
  dropCap: 0,
  variant: null,
};

/** The text blocks the paragraph commands act on. */
const TEXT_BLOCKS = new Set(['paragraph', 'heading']);

/** Dispatches `tr` when it changed something; returns whether it did. */
function send(editor: Editor, tr: Transaction): boolean {
  if (!tr.docChanged && !tr.storedMarksSet) return false;
  editor.view.dispatch(tr);
  return true;
}

/** The text nodes of the selection with the part of each that is selected. */
function selectedText(state: EditorState): { node: PMNode; from: number; to: number }[] {
  const out: { node: PMNode; from: number; to: number }[] = [];
  for (const { $from, $to } of state.selection.ranges) {
    state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (!node.isText) return;
      const from = Math.max(pos, $from.pos);
      const to = Math.min(pos + node.nodeSize, $to.pos);
      if (to > from) out.push({ node, from, to });
    });
  }
  return out;
}

/** The marks typing would use at an empty selection. */
function caretMarks(state: EditorState): readonly Mark[] {
  return state.storedMarks ?? state.selection.$from.marks();
}

/** The text blocks the selection touches, with their positions. */
export function selectedBlocks(state: EditorState, types?: Set<string>): { node: PMNode; pos: number }[] {
  const out: { node: PMNode; pos: number }[] = [];
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, Math.max(to, from), (node, pos) => {
    if (node.isTextblock) {
      if (!types || types.has(node.type.name)) out.push({ node, pos });
      return false;
    }
    return true;
  });
  if (!out.length) {
    const $from = state.selection.$from;
    const parent = $from.parent;
    if (parent.isTextblock && (!types || types.has(parent.type.name))) out.push({ node: parent, pos: $from.before() });
  }
  return out;
}

/**
 * Whether a mark is on the whole selection, on part of it, or off (at a caret: whether typing would use it).
 * @param state - The editor state.
 * @param name - The mark name.
 */
export function markState(state: EditorState, name: string): Tri {
  const type = state.schema.marks[name];
  if (!type) return 'off';
  if (state.selection.empty) return type.isInSet(caretMarks(state)) ? 'on' : 'off';
  const parts = selectedText(state);
  if (!parts.length) return 'off';
  const on = parts.filter((p) => type.isInSet(p.node.marks)).length;
  return on === 0 ? 'off' : on === parts.length ? 'on' : 'mixed';
}

/**
 * The value of a mark attribute over the selection: the one value when every part has the same (null when unset),
 * or `'mixed'`.
 * @param state - The editor state.
 * @param mark - `textStyle` or `highlight`.
 * @param attr - The attribute name.
 */
export function markAttr(state: EditorState, mark: string, attr: string): unknown {
  const type = state.schema.marks[mark];
  if (!type) return null;
  const read = (marks: readonly Mark[]) => (type.isInSet(marks)?.attrs[attr] as unknown) ?? null;
  if (state.selection.empty) return read(caretMarks(state));
  const values = new Set(selectedText(state).map((p) => JSON.stringify(read(p.node.marks))));
  if (values.size > 1) return 'mixed';
  return values.size ? (JSON.parse([...values][0]) as unknown) : null;
}

/**
 * Sets attributes of a mark on the selection, keeping its other attributes: a mark left with every attribute
 * empty is removed. At a caret it changes what typing will use.
 */
function patchMark(state: EditorState, tr: Transaction, type: MarkType, patch: Record<string, unknown>): void {
  const merge = (cur: Mark | undefined) => ({ ...(cur?.attrs ?? {}), ...patch });
  const empty = (attrs: Record<string, unknown>) => Object.values(attrs).every((v) => v == null);
  if (state.selection.empty) {
    const marks = caretMarks(state);
    const attrs = merge(type.isInSet(marks));
    const rest = type.removeFromSet(marks);
    tr.setStoredMarks(empty(attrs) ? rest : type.create(attrs).addToSet(rest));
    return;
  }
  for (const p of selectedText(state)) {
    const attrs = merge(type.isInSet(p.node.marks));
    if (empty(attrs)) tr.removeMark(p.from, p.to, type);
    else tr.addMark(p.from, p.to, type.create(attrs));
  }
}

/**
 * Sets the text colour: a palette name, `#rrggbb`, or `null` for Automatic (the page's own colour).
 * @param editor - The editor.
 * @param color - The colour to store.
 */
export function setTextColor(editor: Editor, color: string | null): boolean {
  const { state } = editor;
  const tr = state.tr;
  patchMark(state, tr, state.schema.marks.textStyle, { color });
  return send(editor, tr);
}

/**
 * Highlights the selection in a colour (a palette name or `#rrggbb`), or removes the highlight (`null`).
 * @param editor - The editor.
 * @param color - The highlight to store, `null` for No highlight.
 */
export function setHighlight(editor: Editor, color: string | null): boolean {
  const { state } = editor;
  const type = state.schema.marks.highlight;
  const tr = state.tr;
  if (state.selection.empty) {
    const marks = type.removeFromSet(caretMarks(state));
    tr.setStoredMarks(color === null ? marks : type.create({ color }).addToSet(marks));
  } else {
    for (const { $from, $to } of state.selection.ranges) {
      if (color === null) tr.removeMark($from.pos, $to.pos, type);
      else tr.addMark($from.pos, $to.pos, type.create({ color }));
    }
  }
  return send(editor, tr);
}

/**
 * Sets the font of the selection: a schema.json font key, or `null` for the page font.
 * @param editor - The editor.
 * @param font - The font key.
 */
export function setFontFamily(editor: Editor, font: PageFont | null): boolean {
  const { state } = editor;
  const tr = state.tr;
  patchMark(state, tr, state.schema.marks.textStyle, { fontFamily: font });
  return send(editor, tr);
}

/**
 * Clamps a typed size to 8 to 160 px (one decimal), or `null` when it is not a number.
 * @param v - The typed value.
 */
export function clampFontSize(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, n)) * 10) / 10;
}

/**
 * Sets the size of the selection in px (8 to 160), or `null` for the style's size.
 * @param editor - The editor.
 * @param size - The size in CSS pixels.
 */
export function setFontSize(editor: Editor, size: number | null): boolean {
  const { state } = editor;
  const tr = state.tr;
  patchMark(state, tr, state.schema.marks.textStyle, { fontSize: size === null ? null : clampFontSize(size) });
  return send(editor, tr);
}

/**
 * The size one step up or down the size list from `current`.
 * @param current - The size now (px).
 * @param dir - `1` for bigger, `-1` for smaller.
 */
export function stepFontSize(current: number, dir: 1 | -1): number {
  if (dir > 0) return FONT_SIZES.find((s) => s > current) ?? MAX_FONT_SIZE;
  return [...FONT_SIZES].reverse().find((s) => s < current) ?? MIN_FONT_SIZE;
}

/**
 * Turns a mark on or off for the selection; a mixed selection becomes all on.
 * @param editor - The editor.
 * @param name - The mark name (`underline`, `superscript`…).
 */
export function toggleMark(editor: Editor, name: ToggleMark | 'highlight'): boolean {
  const { state } = editor;
  const type = state.schema.marks[name];
  if (!type) return false;
  const tr = state.tr;
  const on = markState(state, name) === 'on';
  if (state.selection.empty) {
    const marks = caretMarks(state);
    tr.setStoredMarks(on ? type.removeFromSet(marks) : type.create().addToSet(marks));
  } else {
    for (const { $from, $to } of state.selection.ranges) {
      if (on) tr.removeMark($from.pos, $to.pos, type);
      else tr.addMark($from.pos, $to.pos, type.create());
    }
  }
  return send(editor, tr);
}

/**
 * Sets attributes on every text block the selection touches that has them (paragraphs, headings and any block with
 * that attribute, such as a pull quote's alignment).
 * @param editor - The editor.
 * @param patch - The attributes to set.
 * @param only - Restrict to these node types.
 */
export function setBlockAttrs(editor: Editor, patch: Record<string, unknown>, only?: Set<string>): boolean {
  const { state } = editor;
  const tr = state.tr;
  for (const { node, pos } of selectedBlocks(state, only)) {
    const keys = Object.keys(patch).filter((k) => k in node.attrs);
    if (!keys.length) continue;
    const next = { ...node.attrs };
    for (const k of keys) next[k] = patch[k];
    if (JSON.stringify(next) !== JSON.stringify(node.attrs)) tr.setNodeMarkup(pos, undefined, next);
  }
  return send(editor, tr);
}

/**
 * Aligns the blocks of the selection (`null` puts the page default back).
 * @param editor - The editor.
 * @param align - Left, centre, right or justify.
 */
export function setAlign(editor: Editor, align: Align | null): boolean {
  return setBlockAttrs(editor, { textAlign: align === 'left' ? null : align });
}

/**
 * Indents or outdents: a list item moves one level in or out, other paragraphs and headings step their `indent`
 * (0 to 8, 24 px a step).
 * @param editor - The editor.
 * @param dir - `1` to indent, `-1` to outdent.
 */
export function changeIndent(editor: Editor, dir: 1 | -1): boolean {
  const item = editor.isActive('taskItem') ? 'taskItem' : editor.isActive('listItem') ? 'listItem' : null;
  if (item) return dir > 0 ? editor.commands.sinkListItem(item) : editor.commands.liftListItem(item);
  const { state } = editor;
  const tr = state.tr;
  for (const { node, pos } of selectedBlocks(state, TEXT_BLOCKS)) {
    const cur = typeof node.attrs.indent === 'number' ? node.attrs.indent : 0;
    const next = Math.max(0, Math.min(MAX_INDENT, cur + dir));
    if (next !== cur) tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
  }
  return send(editor, tr);
}

/**
 * Sets the drop cap of the paragraphs of the selection (headings have none).
 * @param editor - The editor.
 * @param lines - 0 (off), 3 or 5 lines tall.
 */
export function setDropCap(editor: Editor, lines: (typeof DROP_CAPS)[number]): boolean {
  return setBlockAttrs(editor, { dropCap: lines }, new Set(['paragraph']));
}

/**
 * Sets how the drop cap of the selection's paragraphs looks (Editor board, frame 25).
 * @param attrs - `dropCapStyle` (null dropped, `raised`), `dropCapColor` (null the text colour, a palette name or
 *   `#rrggbb`), `dropCapFont` (null the heading font, `body`).
 */
export function setDropCapLook(
  editor: Editor,
  attrs: { dropCapStyle?: string | null; dropCapColor?: string | null; dropCapFont?: string | null },
): boolean {
  return setBlockAttrs(editor, attrs, new Set(['paragraph']));
}

/**
 * The style of the selection's blocks: one style id, `'mixed'` when they differ, or `null` where no style applies.
 * @param state - The editor state.
 */
export function styleOf(state: EditorState): StyleId | 'mixed' | null {
  const ids = new Set<StyleId>();
  for (const { node, pos } of selectedBlocks(state)) ids.add(blockStyle(state, node, pos));
  if (ids.size > 1) return 'mixed';
  return ids.size ? [...ids][0] : null;
}

function blockStyle(state: EditorState, node: PMNode, pos: number): StyleId {
  if (node.type.name === 'codeBlock') return 'code';
  if (node.type.name === 'heading') {
    const level = Math.min(4, Math.max(1, Number(node.attrs.level) || 1));
    return `h${level}` as StyleId;
  }
  const $pos = state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === 'blockquote') return 'quote';
  if (node.attrs.variant === 'lead') return 'lead';
  if (node.attrs.variant === 'small') return 'small';
  return 'body';
}

/**
 * Gives the selection's blocks a style: Body, Lead and Small are paragraphs (a lead and a small one are paragraph
 * variants), Heading 1 to 4 headings, Quote wraps them in a quote, Code makes a code block.
 * @param editor - The editor.
 * @param id - The style.
 */
export function applyStyle(editor: Editor, id: StyleId): boolean {
  const chain = editor.chain();
  const inQuote = editor.isActive('blockquote');
  if (id === 'quote') return inQuote ? true : chain.setParagraph().wrapIn('blockquote').run();
  if (id === 'code') return chain.setCodeBlock().run();
  if (inQuote) chain.lift('blockquote');
  if (id.startsWith('h')) return chain.setHeading({ level: Number(id.slice(1)) as 1 | 2 | 3 | 4 }).run();
  return chain
    .setParagraph()
    .command(({ tr, state }) => {
      const variant = id === 'body' ? null : id;
      for (const { node, pos } of selectedBlocks(state, new Set(['paragraph'])))
        if (node.attrs.variant !== variant) tr.setNodeMarkup(pos, undefined, { ...node.attrs, variant });
      return true;
    })
    .run();
}

/** Which "Clear formatting" level: the text's marks, the paragraph's attributes, or both (back to page style). */
export type ClearLevel = 'text' | 'paragraph' | 'all';

/**
 * Clears formatting. `text` removes every mark but links (bold, colour, font, size, highlight…), `paragraph` puts
 * alignment, indent, spacing, drop cap and variant back to their defaults, `all` does both.
 * @param editor - The editor.
 * @param level - What to clear.
 */
export function clearFormatting(editor: Editor, level: ClearLevel = 'text'): boolean {
  const { state } = editor;
  const tr = state.tr;
  if (level !== 'paragraph') {
    if (state.selection.empty) {
      tr.setStoredMarks(caretMarks(state).filter((m) => m.type.name === 'link'));
    } else {
      for (const { $from, $to } of state.selection.ranges)
        for (const type of Object.values(state.schema.marks))
          if (type.name !== 'link') tr.removeMark($from.pos, $to.pos, type);
    }
  }
  if (level !== 'text') {
    for (const { node, pos } of selectedBlocks(state)) {
      const next = { ...node.attrs };
      for (const [k, v] of Object.entries(BLOCK_DEFAULTS)) if (k in node.attrs) next[k] = v;
      if (JSON.stringify(next) !== JSON.stringify(node.attrs)) tr.setNodeMarkup(pos, undefined, next);
    }
  }
  return send(editor, tr);
}

/**
 * Sets the number an ordered list starts at (1 or more).
 * @param editor - The editor.
 * @param start - The first number.
 */
export function setListStart(editor: Editor, start: number): boolean {
  const n = Math.max(1, Math.round(start) || 1);
  return editor.commands.updateAttributes('orderedList', { start: n });
}

/** Where the caret is, for the ribbon: the values its controls show. */
export interface FormatState {
  marks: Record<ToggleMark | 'highlight' | 'link', Tri>;
  /** Text colour: a name, `#rrggbb`, `null` (Automatic) or `'mixed'`. */
  color: unknown;
  /** Highlight colour of the highlighted text (`null` = yellow) or `'mixed'`. */
  highlightColor: unknown;
  fontFamily: unknown;
  fontSize: unknown;
  style: StyleId | 'mixed' | null;
  /** Alignment of the selection's blocks (`left` for the default), or `'mixed'`. */
  align: Align | 'mixed';
  lineHeight: number | null;
  spaceBefore: number | null;
  spaceAfter: number | null;
  dropCap: number;
  /** The drop cap's look: position (null = dropped), colour (null = the text's), font (null = heading). */
  dropCapStyle: string | null;
  dropCapColor: string | null;
  dropCapFont: string | null;
  indent: number;
  list: 'bullet' | 'ordered' | 'task' | null;
  listStart: number;
  /** The caret is in a code block (or inline code): text formatting does not apply. */
  inCode: boolean;
  inTable: boolean;
  inCallout: boolean;
  inQuote: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Reads what the ribbon shows for the selection.
 * @param editor - The editor.
 */
export function formatState(editor: Editor): FormatState {
  const { state } = editor;
  const marks = Object.fromEntries(
    [...TOGGLE_MARKS, 'highlight', 'link'].map((m) => [m, markState(state, m)]),
  ) as FormatState['marks'];
  const blocks = selectedBlocks(state);
  const first = blocks[0]?.node;
  const aligns = new Set(blocks.map((b) => (b.node.attrs.textAlign as Align | null) ?? 'left'));
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const list = editor.isActive('taskList')
    ? 'task'
    : editor.isActive('orderedList')
      ? 'ordered'
      : editor.isActive('bulletList')
        ? 'bullet'
        : null;
  let canUndo = false;
  let canRedo = false;
  try {
    canUndo = editor.can().undo();
    canRedo = editor.can().redo();
  } catch {
    /* no history in this editor */
  }
  return {
    marks,
    color: markAttr(state, 'textStyle', 'color'),
    highlightColor: markAttr(state, 'highlight', 'color'),
    fontFamily: markAttr(state, 'textStyle', 'fontFamily'),
    fontSize: markAttr(state, 'textStyle', 'fontSize'),
    style: styleOf(state),
    align: aligns.size > 1 ? 'mixed' : ([...aligns][0] ?? 'left'),
    lineHeight: num(first?.attrs.lineHeight),
    spaceBefore: num(first?.attrs.spaceBefore),
    spaceAfter: num(first?.attrs.spaceAfter),
    dropCap: num(first?.attrs.dropCap) ?? 0,
    dropCapStyle: typeof first?.attrs.dropCapStyle === 'string' ? first.attrs.dropCapStyle : null,
    dropCapColor: typeof first?.attrs.dropCapColor === 'string' ? first.attrs.dropCapColor : null,
    dropCapFont: typeof first?.attrs.dropCapFont === 'string' ? first.attrs.dropCapFont : null,
    indent: num(first?.attrs.indent) ?? 0,
    list,
    listStart: list === 'ordered' ? (num(editor.getAttributes('orderedList').start) ?? 1) : 1,
    inCode: editor.isActive('codeBlock'),
    inTable: editor.isActive('table'),
    inCallout: editor.isActive('callout'),
    inQuote: editor.isActive('blockquote'),
    canUndo,
    canRedo,
  };
}

/* ---------- format painter ---------- */

/** What the format painter copied: the text's marks (links left out) and its paragraph style. */
export interface CopiedFormat {
  marks: { type: string; attrs: Record<string, unknown> }[];
  style: StyleId | null;
}

/**
 * Copies the format of the selection's start (or of the caret): font, size, bold, italic, underline, colour,
 * highlight… and the paragraph style. Links, images and text are not copied.
 * @param editor - The editor.
 */
export function copyFormat(editor: Editor): CopiedFormat {
  const { state } = editor;
  const parts = selectedText(state);
  const marks = state.selection.empty || !parts.length ? caretMarks(state) : parts[0].node.marks;
  const style = styleOf(state);
  return {
    marks: marks.filter((m) => m.type.name !== 'link').map((m) => ({ type: m.type.name, attrs: { ...m.attrs } })),
    style: style === 'mixed' ? null : style,
  };
}

/**
 * Paints a copied format onto the selection: its marks replace the text's own (links stay). The paragraph style is
 * painted too when the selection covers whole blocks or is a caret.
 * @param editor - The editor.
 * @param format - What `copyFormat` returned.
 */
export function pasteFormat(editor: Editor, format: CopiedFormat): boolean {
  const { state } = editor;
  const tr = state.tr;
  const marks = format.marks.map((m) => state.schema.marks[m.type]?.create(m.attrs)).filter((m): m is Mark => !!m);
  if (state.selection.empty) {
    const link = caretMarks(state).filter((m) => m.type.name === 'link');
    tr.setStoredMarks([...link, ...marks]);
  } else {
    for (const { $from, $to } of state.selection.ranges) {
      for (const type of Object.values(state.schema.marks))
        if (type.name !== 'link') tr.removeMark($from.pos, $to.pos, type);
      for (const m of marks) tr.addMark($from.pos, $to.pos, m);
    }
  }
  const changed = send(editor, tr);
  const { from, to, $from, $to, empty } = editor.state.selection;
  const whole = empty || (from === $from.start() && to === $to.end());
  if (format.style && format.style !== 'code' && whole && styleOf(editor.state) !== format.style) {
    applyStyle(editor, format.style);
    return true;
  }
  return changed;
}

/**
 * What the painter bar says was copied: "Lora 18 · bold · Green".
 * @param format - The copied format.
 */
export function describeFormat(format: CopiedFormat): string {
  const ts = format.marks.find((m) => m.type === 'textStyle')?.attrs ?? {};
  const parts: string[] = [];
  const font = typeof ts.fontFamily === 'string' ? (FONT_LABEL[ts.fontFamily as PageFont] ?? '') : '';
  const size = typeof ts.fontSize === 'number' ? String(ts.fontSize) : '';
  if (font || size) parts.push([font, size].filter(Boolean).join(' '));
  for (const m of format.marks) if (m.type !== 'textStyle' && m.type !== 'highlight') parts.push(m.type);
  if (typeof ts.color === 'string') parts.push(colorLabel(ts.color));
  const hl = format.marks.find((m) => m.type === 'highlight');
  if (hl) parts.push(`${colorLabel(typeof hl.attrs.color === 'string' ? hl.attrs.color : 'yellow')} highlight`);
  if (!parts.length) parts.push(format.style ? STYLE_INFO[format.style].label : 'Body');
  return parts.join(' · ');
}

/* ---------- words ---------- */

/**
 * Number of words in a text (a word holds a letter or a digit).
 * @param text - Plain text.
 */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * Opens the insert menu ("/") at the caret: on an empty line the "/" is typed there, otherwise a new line is added
 * after the block that holds the caret. It is the same entry point as typing "/" and the block handle's "+".
 * @param editor - The editor.
 */
export function openInsertMenu(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  const parent = $from.parent;
  if (empty && parent.type.name === 'paragraph' && parent.content.size === 0)
    return editor.chain().focus().insertContent('/').run();
  const depth = Math.min($from.depth, 1);
  const after = depth === 0 ? editor.state.doc.content.size : $from.after(1);
  return editor
    .chain()
    .focus()
    .insertContentAt(after, { type: 'paragraph', content: [{ type: 'text', text: '/' }] })
    .run();
}
