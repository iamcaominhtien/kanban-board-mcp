/**
 * The editor half of rich text editing (Editor boards A to N): the keyboard shortcuts of the new formats, the
 * drawing of the paragraph attributes in the editor (alignment, indent, line height, spacing, drop cap, lead and
 * small), the format painter, the paste chip, and the paragraph under the caret for focus mode.
 *
 * Its state lives in two stores on `editor.storage.richFormatting` that the ribbon, the painter bar and the paste
 * chip read.
 */

import { cssColor } from './palette';
import { Extension, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  applyStyle,
  changeIndent,
  clearFormatting,
  copyFormat,
  pasteFormat,
  setAlign,
  toggleMark,
  type CopiedFormat,
} from './format';
import {
  cleanPastedHtml,
  isForeignRich,
  pasteSource,
  plainParagraphs,
  readPasteDefault,
  type PasteCleanup,
  type PasteMode,
  type PasteSource,
} from './pasteMode';
import { Store } from './store';

/** The format painter: what was copied and whether the brush is on (once, or until Done). */
export interface PainterState {
  format: CopiedFormat | null;
  mode: 'off' | 'once' | 'sticky';
}

/** The paste chip after a paste of rich text from outside: where the paste landed and how it was taken. */
export interface PasteChipState {
  from: number;
  to: number;
  html: string;
  text: string;
  mode: PasteMode;
  source: PasteSource;
  removed: PasteCleanup;
  /** The setting is "Ask me each time": the chip opens its options by itself. */
  ask: boolean;
}

export interface RichFormattingStorage {
  painter: Store<PainterState>;
  paste: Store<PasteChipState | null>;
}

export interface RichFormattingOptions {
  /** Ctrl+Shift+F: focus mode on or off. */
  onFocusMode: () => void;
  /** Ctrl+/: the shortcut sheet. */
  onShortcuts: () => void;
}

/** Transactions of the paste chip itself (they do not close it). */
export const PASTE_META = 'richPasteChip';
const decoKey = new PluginKey<DecorationSet>('richFormattingDecos');
const pasteKey = new PluginKey('richFormattingPaste');

declare module '@tiptap/core' {
  interface Storage {
    richFormatting: RichFormattingStorage;
  }
}

/**
 * The stores of an editor (made when it has no RichFormatting extension, so callers never check).
 * @param editor - The editor.
 */
export function richStorage(editor: Editor | null): RichFormattingStorage | null {
  const s = (editor?.storage as unknown as Record<string, unknown> | undefined)?.richFormatting;
  return (s as RichFormattingStorage | undefined) ?? null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The inline style and classes that draw a text block's format 1 attributes in the editor. */
export function blockDecoAttrs(node: PMNode): { style?: string; class?: string } | null {
  const a = node.attrs;
  const css: string[] = [];
  const cls: string[] = [];
  if (typeof a.textAlign === 'string' && a.textAlign) css.push(`text-align: ${a.textAlign}`);
  const indent = num(a.indent);
  if (indent) css.push(`margin-left: ${indent * 24}px`);
  const lh = num(a.lineHeight);
  if (lh) css.push(`line-height: ${lh}`);
  const before = num(a.spaceBefore);
  if (before != null) css.push(`margin-top: ${before}px`);
  const after = num(a.spaceAfter);
  if (after != null) css.push(`margin-bottom: ${after}px`);
  const drop = num(a.dropCap);
  if (drop) {
    cls.push('dk-dropcap', `dk-dropcap-${drop}`);
    if (a.dropCapStyle === 'raised') cls.push('dk-dropcap-raised');
    if (a.dropCapFont === 'body') cls.push('dk-dropcap-body');
    const dc = cssColor('text', a.dropCapColor);
    if (dc) css.push(`--dk-dc: ${dc}`);
  }
  if (a.variant === 'lead' || a.variant === 'small') cls.push(`dk-p-${a.variant}`);
  if (!css.length && !cls.length) return null;
  return { ...(css.length ? { style: css.join('; ') } : null), ...(cls.length ? { class: cls.join(' ') } : null) };
}

function buildDecos(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const attrs = blockDecoAttrs(node);
    if (attrs) decos.push(Decoration.node(pos, pos + node.nodeSize, attrs));
    return false;
  });
  return DecorationSet.create(doc, decos);
}

/** Starts the painter: copies the selection's format; `sticky` keeps the brush on until Done or Esc. */
export function startPainter(editor: Editor, sticky: boolean): void {
  richStorage(editor)?.painter.set({ format: copyFormat(editor), mode: sticky ? 'sticky' : 'once' });
}

/** Turns the brush off (the copied format stays for Ctrl+Alt+V). */
export function stopPainter(editor: Editor | null): void {
  const st = richStorage(editor);
  if (st && st.painter.get().mode !== 'off') st.painter.set((p) => ({ ...p, mode: 'off' }));
}

/**
 * Takes the paste shown by the chip again in another mode, in place of what it inserted (one step, which Undo
 * reverses); the chip stays, with the new mode.
 * @param editor - The editor.
 * @param mode - The mode to switch to.
 */
export function repaste(editor: Editor, mode: PasteMode): boolean {
  const st = richStorage(editor);
  const chip = st?.paste.get();
  if (!st || !chip || chip.mode === mode) return false;
  const content =
    mode === 'plain' ? plainParagraphs(chip.text) : cleanPastedHtml(chip.html, mode === 'keep' ? 'keep' : 'match').html;
  let to = chip.to;
  const ok = editor
    .chain()
    .command(({ tr }) => {
      tr.setMeta(PASTE_META, true);
      return true;
    })
    .insertContentAt({ from: chip.from, to: chip.to }, content as never, { updateSelection: true })
    .command(({ tr }) => {
      to = tr.selection.to;
      return true;
    })
    .run();
  if (ok) st.paste.set({ ...chip, mode, to, ask: false });
  return ok;
}

/** Closes the paste chip. */
export function closePasteChip(editor: Editor | null): void {
  richStorage(editor)?.paste.set(null);
}

/** Set before Ctrl+Shift+V so that paste is left to the browser as plain text. */
let plainNext = false;

/**
 * Shortcuts (Ctrl+U, Ctrl+. and Ctrl+, , Ctrl+Shift+L/E/R/J, Ctrl+\ and Ctrl+Space, Ctrl+Alt+0 and 4, Ctrl+Alt+C/V,
 * Ctrl+Shift+F, Ctrl+/), the drawing of paragraph attributes, the format painter and the paste chip.
 */
export const RichFormatting = Extension.create<RichFormattingOptions, RichFormattingStorage>({
  name: 'richFormatting',
  priority: 210,

  addOptions() {
    return { onFocusMode: () => {}, onShortcuts: () => {} };
  },

  addStorage() {
    return {
      painter: new Store<PainterState>({ format: null, mode: 'off' }),
      paste: new Store<PasteChipState | null>(null),
    };
  },

  addKeyboardShortcuts() {
    const ed = () => this.editor;
    return {
      'Mod-u': () => toggleMark(ed(), 'underline'),
      'Mod-.': () => toggleMark(ed(), 'superscript'),
      'Mod-,': () => toggleMark(ed(), 'subscript'),
      'Mod-Shift-l': () => setAlign(ed(), 'left') || true,
      'Mod-Shift-e': () => setAlign(ed(), 'center') || true,
      'Mod-Shift-r': () => setAlign(ed(), 'right') || true,
      'Mod-Shift-j': () => setAlign(ed(), 'justify') || true,
      'Mod-\\': () => clearFormatting(ed(), 'text') || true,
      'Mod-Space': () => clearFormatting(ed(), 'text') || true,
      'Mod-Alt-0': () => applyStyle(ed(), 'body'),
      'Mod-Alt-4': () => applyStyle(ed(), 'h4'),
      'Mod-Alt-c': () => {
        this.storage.painter.set((p) => ({ ...p, format: copyFormat(ed()) }));
        return true;
      },
      'Mod-Alt-v': () => {
        const f = this.storage.painter.get().format;
        if (f) pasteFormat(ed(), f);
        return true;
      },
      'Mod-Shift-f': () => {
        this.options.onFocusMode();
        return true;
      },
      'Mod-/': () => {
        this.options.onShortcuts();
        return true;
      },
      'Mod-]': () => changeIndent(ed(), 1) || true,
      'Mod-[': () => changeIndent(ed(), -1) || true,
    };
  },

  onTransaction({ transaction }) {
    // the chip stays until the next edit
    if (transaction.docChanged && !transaction.getMeta(PASTE_META) && !transaction.getMeta('paste'))
      this.storage.paste.set(null);
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const storage = this.storage;
    const decos = new Plugin<DecorationSet>({
      key: decoKey,
      state: {
        init: (_, state) => buildDecos(state.doc),
        apply: (tr, old) => (tr.docChanged ? buildDecos(tr.doc) : old),
      },
      props: {
        decorations(state) {
          const set = decoKey.getState(state) ?? DecorationSet.empty;
          // the top-level block holding the caret, which focus mode keeps at full strength
          const { $head } = state.selection;
          if ($head.depth < 1) return set;
          const from = $head.before(1);
          const node = state.doc.nodeAt(from);
          if (!node) return set;
          return set.add(state.doc, [Decoration.node(from, from + node.nodeSize, { 'data-caret-block': 'true' })]);
        },
      },
    });

    // the brush paints the selection made with the mouse or a finger, once it is set
    const paintSoon = () => {
      if (storage.painter.get().mode === 'off') return false;
      window.setTimeout(() => {
        const p = storage.painter.get();
        if (p.mode === 'off' || !p.format || editor.isDestroyed || editor.state.selection.empty) return;
        pasteFormat(editor, p.format);
        if (p.mode === 'once') storage.painter.set({ ...p, mode: 'off' });
      }, 0);
      return false;
    };

    const paste = new Plugin({
      key: pasteKey,
      props: {
        handleKeyDown(_view, event) {
          if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') plainNext = true;
          if (event.key === 'Escape') {
            if (storage.paste.get()) storage.paste.set(null);
            if (storage.painter.get().mode !== 'off') {
              storage.painter.set((p) => ({ ...p, mode: 'off' }));
              return true;
            }
          }
          return false;
        },
        handleDOMEvents: {
          mouseup: () => paintSoon(),
          touchend: () => paintSoon(),
        },
        handlePaste(view, event) {
          const plain = plainNext;
          plainNext = false;
          const html = event.clipboardData?.getData('text/html') ?? '';
          const text = event.clipboardData?.getData('text/plain') ?? '';
          if (plain || !isForeignRich(html) || view.state.selection.$from.parent.type.spec.code) return false;
          if (event.clipboardData?.files.length) return false;
          const setting = readPasteDefault();
          const mode: PasteMode = setting === 'ask' ? 'match' : setting;
          const removed = cleanPastedHtml(html, 'match').removed;
          const content =
            mode === 'plain' ? plainParagraphs(text) : cleanPastedHtml(html, mode === 'keep' ? 'keep' : 'match').html;
          const from = view.state.selection.from;
          let to = from;
          const ok = editor
            .chain()
            .command(({ tr }) => {
              tr.setMeta(PASTE_META, true);
              tr.setMeta('paste', true);
              tr.setMeta('uiEvent', 'paste');
              return true;
            })
            .insertContent(content as never)
            .command(({ tr }) => {
              to = tr.selection.to;
              return true;
            })
            .run();
          if (!ok) return false;
          storage.paste.set({ from, to, html, text, mode, source: pasteSource(html), removed, ask: setting === 'ask' });
          return true;
        },
      },
    });
    return [decos, paste];
  },
});
