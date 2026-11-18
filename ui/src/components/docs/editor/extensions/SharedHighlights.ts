/**
 * Shared highlights in Edit mode (design board "Rich Docs — reading", K 101): the readers' highlights stay visible
 * while the page is edited, as a 2 px dotted line in the colour's ink with the marker after the words. They are
 * decorations, never part of the text: typing, saving and the Markdown are untouched, and a highlight follows its
 * words while they are edited (the decorations are mapped through each change). Fed by the page through
 * {@link sharedHighlightKey}.
 */

import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** One shared highlight as the editor draws it. */
export interface EditHighlight {
  id: string;
  /** The block it starts in (`blockId` attribute). */
  blockId: string;
  /** The block it ends in, when it runs across blocks. */
  endBlockId: string | null;
  /** Character offsets in the block's text (the reader's text: text and the labels of chips). */
  start: number;
  end: number;
  quote: string;
  /** The colour's ink: the dotted line and the marker. */
  ink: string;
  /** The marker's inside: the colour's shape as SVG markup made by the page (colors.tsx), never user text. */
  shapeSvg: string;
  /** The person's dot colour. */
  dot: string;
  /** "Highlighted Yellow by Hoa Mai" (the marker's name for a screen reader). */
  label: string;
}

interface HlState {
  items: EditHighlight[];
  decos: DecorationSet;
}

/** The plugin key: dispatch `tr.setMeta(sharedHighlightKey, items)` (an empty list hides them). */
export const sharedHighlightKey = new PluginKey<HlState>('sharedHighlights');

/** The text of a block with the document range of each character (a chip counts as its label). */
function blockText(node: PMNode, pos: number): { text: string; at: { from: number; to: number }[] } {
  let text = '';
  const at: { from: number; to: number }[] = [];
  node.descendants((child, off) => {
    const from = pos + 1 + off;
    if (child.isText) {
      const t = child.text ?? '';
      for (let i = 0; i < t.length; i += 1) at.push({ from: from + i, to: from + i + 1 });
      text += t;
    } else if (child.isLeaf) {
      const label = String(child.attrs.label || child.attrs.page || child.attrs.key || '');
      for (let i = 0; i < label.length; i += 1) at.push({ from, to: from + child.nodeSize });
      text += label;
    }
    return true;
  });
  return { text, at };
}

/** Every block with a `blockId`, by id (the innermost wins, as `closest('[data-block-id]')` does in the reader). */
function blocksById(doc: PMNode): Map<string, { node: PMNode; pos: number }> {
  const out = new Map<string, { node: PMNode; pos: number }>();
  doc.descendants((node, pos) => {
    const id = node.attrs?.blockId;
    if (typeof id === 'string' && id) out.set(id, { node, pos });
    return true;
  });
  return out;
}

/**
 * Where a highlight's words are in the document: the quote at its offsets, else the same words nearest to them in
 * its block; across blocks, from its start offset to its end offset.
 * @returns The document range, or null when the words are not there.
 */
export function findHighlight(doc: PMNode, h: EditHighlight): { from: number; to: number } | null {
  const blocks = blocksById(doc);
  const sb = blocks.get(h.blockId);
  if (!sb) return null;
  const st = blockText(sb.node, sb.pos);
  if (h.endBlockId) {
    const eb = blocks.get(h.endBlockId);
    if (!eb) return null;
    const et = blockText(eb.node, eb.pos);
    const a = st.at[h.start];
    const b = et.at[h.end - 1];
    return a && b && a.from < b.to ? { from: a.from, to: b.to } : null;
  }
  let s = st.text.slice(h.start, h.end) === h.quote ? h.start : -1;
  if (s < 0 && h.quote) {
    let best = -1;
    for (let i = st.text.indexOf(h.quote); i >= 0; i = st.text.indexOf(h.quote, i + 1)) {
      if (best < 0 || Math.abs(i - h.start) < Math.abs(best - h.start)) best = i;
    }
    s = best;
  }
  if (s < 0) return null;
  const a = st.at[s];
  const b = st.at[s + h.quote.length - 1];
  return a && b ? { from: a.from, to: b.to } : null;
}

function marker(h: EditHighlight): HTMLElement {
  const m = document.createElement('span');
  m.className = 'dk-hl-edit-mark';
  m.contentEditable = 'false';
  m.dataset.testid = 'hl-edit-marker';
  m.dataset.hl = h.id;
  m.setAttribute('role', 'img');
  m.setAttribute('aria-label', h.label);
  m.title = h.label;
  m.style.color = h.ink;
  // the shape is fixed markup of colors.tsx, never page or user text
  m.innerHTML = h.shapeSvg;
  const dot = document.createElement('span');
  dot.className = 'dk-hl-dot';
  dot.style.background = h.dot;
  m.appendChild(dot);
  return m;
}

function build(doc: PMNode, items: EditHighlight[]): DecorationSet {
  const decos: Decoration[] = [];
  for (const h of items) {
    const r = findHighlight(doc, h);
    if (!r) continue;
    doc.nodesBetween(r.from, r.to, (node, pos) => {
      if (!node.isText) return true;
      const a = Math.max(r.from, pos);
      const b = Math.min(r.to, pos + node.nodeSize);
      if (a < b)
        decos.push(
          Decoration.inline(a, b, { class: 'dk-hl-edit', style: `--hl-ink:${h.ink}`, 'data-hl': h.id }, { hl: h.id }),
        );
      return false;
    });
    decos.push(
      Decoration.widget(r.to, () => marker(h), { side: 1, ignoreSelection: true, key: `hl-${h.id}-${h.ink}` }),
    );
  }
  return DecorationSet.create(doc, decos);
}

/** Draws the page's shared highlights in the editor as dotted lines with their markers (K 101). */
export const SharedHighlights = Extension.create({
  name: 'sharedHighlights',
  addProseMirrorPlugins() {
    return [
      new Plugin<HlState>({
        key: sharedHighlightKey,
        state: {
          init: () => ({ items: [], decos: DecorationSet.empty }),
          apply(tr, value) {
            const meta = tr.getMeta(sharedHighlightKey) as EditHighlight[] | undefined;
            if (meta) return { items: meta, decos: build(tr.doc, meta) };
            if (tr.docChanged) return { ...value, decos: value.decos.map(tr.mapping, tr.doc) };
            return value;
          },
        },
        props: {
          decorations: (state) => sharedHighlightKey.getState(state)?.decos ?? DecorationSet.empty,
        },
      }),
    ];
  },
});
