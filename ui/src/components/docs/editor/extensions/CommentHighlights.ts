import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { slugify } from '../../../../utils/docsMarkdown';
import type { CommentAnchorInput } from '../../../../types/docs';

export const commentHighlightKey = new PluginKey<HighlightState>('commentHighlights');

export interface HighlightThread {
  id: string;
  number: number;
  quote: string;
  prefix: string;
  suffix: string;
  section: string | null;
}

interface HighlightState {
  threads: HighlightThread[];
  activeId: string | null;
  decos: DecorationSet;
}

export interface CommentHighlightOptions {
  /** Called with a thread id when its highlight is clicked. */
  onSelect: (id: string) => void;
}

const CONTEXT = 32;
const norm = (s: string) => s.replace(/\s+/g, ' ');

interface TextBlock {
  text: string;
  /** Document range of each character of `text`. */
  at: { from: number; to: number }[];
  section: string | null;
  /** Start of the textblock's content in the document. */
  start: number;
}

/** Plain text of every textblock with a position for each character (chips count as their label). */
export function textBlocks(doc: PMNode): TextBlock[] {
  const out: TextBlock[] = [];
  const seen = new Map<string, number>();
  let section: string | null = null;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.name === 'heading') {
      const label = node.textBetween(0, node.content.size, '', (leaf) =>
        String(leaf.attrs.label || leaf.attrs.page || leaf.attrs.key || ''),
      );
      const base = slugify(label) || 'section';
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      section = n === 1 ? base : `${base}-${n}`;
    }
    let text = '';
    const at: TextBlock['at'] = [];
    let lastSpace = true;
    node.descendants((child, off) => {
      const from = pos + 1 + off;
      const raw = child.isText
        ? (child.text ?? '')
        : child.isLeaf
          ? String(child.attrs.label || child.attrs.page || child.attrs.key || '')
          : '';
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        const range = child.isText ? { from: from + i, to: from + i + 1 } : { from, to: from + child.nodeSize };
        if (/\s/.test(ch)) {
          if (lastSpace) continue;
          text += ' ';
          lastSpace = true;
        } else {
          text += ch;
          lastSpace = false;
        }
        at.push(range);
      }
      return true;
    });
    if (text.endsWith(' ')) {
      text = text.slice(0, -1);
      at.pop();
    }
    if (text) out.push({ text, at, section, start: pos + 1 });
    return false;
  });
  return out;
}

const commonSuffix = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};
const commonPrefix = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

function build(doc: PMNode, threads: HighlightThread[], activeId: string | null, prev: DecorationSet): DecorationSet {
  const blocks = textBlocks(doc);
  const decos: Decoration[] = [];
  for (const t of threads) {
    const quote = norm(t.quote);
    let best: { score: number; b: TextBlock; at: number } | null = null;
    for (const b of blocks) {
      let at = b.text.indexOf(quote);
      while (at !== -1) {
        const end = at + quote.length;
        let score = commonSuffix(b.text.slice(Math.max(0, at - CONTEXT), at), t.prefix);
        score += commonPrefix(b.text.slice(end, end + CONTEXT), t.suffix);
        if (t.section && b.section === t.section) score += 0.5;
        if (!best || score > best.score) best = { score, b, at };
        at = b.text.indexOf(quote, at + 1);
      }
    }
    if (!best) {
      // text typed inside a highlight no longer equals the stored quote: keep following the old range
      const old = prev.find().filter((d) => (d.spec as { threadId?: string }).threadId === t.id);
      if (old.length)
        decos.push(
          ...highlight(doc, Math.min(...old.map((d) => d.from)), Math.max(...old.map((d) => d.to)), t, activeId),
        );
      continue;
    }
    const from = best.b.at[best.at].from;
    const to = best.b.at[best.at + quote.length - 1].to;
    decos.push(...highlight(doc, from, to, t, activeId));
  }
  return DecorationSet.create(doc, decos);
}

/**
 * Decorations for one thread's range, one per text node so the number badge shows once, after the
 * last piece (a range across a code span or a link would otherwise get a badge per piece).
 */
function highlight(
  doc: PMNode,
  from: number,
  to: number,
  t: { id: string; number: number },
  activeId: string | null,
): Decoration[] {
  const pieces: [number, number][] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const a = Math.max(from, pos);
    const b = Math.min(to, pos + node.nodeSize);
    if (a < b) pieces.push([a, b]);
    return false;
  });
  if (!pieces.length) pieces.push([from, to]);
  return pieces.map(([a, b], i) =>
    Decoration.inline(
      a,
      b,
      {
        class: 'dk-cmt-hl' + (t.id === activeId ? ' is-active' : ''),
        'data-thread': t.id,
        ...(i === pieces.length - 1 ? { 'data-num': String(t.number) } : {}),
      },
      { threadId: t.id },
    ),
  );
}

/**
 * Selection of the editor as a comment anchor: a selection inside one text block.
 * @param state - Editor state.
 * @returns The anchor and the document range, or null when the selection is empty or spans blocks.
 */
export function anchorFromState(state: EditorState): { anchor: CommentAnchorInput; from: number; to: number } | null {
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);
  if (!$from.parent.isTextblock || !$from.sameParent($to)) return null;
  const blocks = textBlocks(state.doc);
  const start = $from.start();
  const block = blocks.find((b) => b.start === start);
  if (!block) return null;
  let s = block.at.findIndex((r) => r.to > from);
  let e = block.at.findIndex((r) => r.from >= to);
  if (s === -1) return null;
  if (e === -1) e = block.text.length;
  while (s < e && block.text[s] === ' ') s++;
  while (e > s && block.text[e - 1] === ' ') e--;
  if (e <= s || e - s > 500) return null;
  return {
    anchor: {
      quote: block.text.slice(s, e),
      prefix: block.text.slice(Math.max(0, s - CONTEXT), s),
      suffix: block.text.slice(e, e + CONTEXT),
      section: block.section,
    },
    from,
    to,
  };
}

/**
 * Highlights commented text in the editor with decorations: they follow the text while editing, so typing
 * inside a highlight keeps the comment attached. The Markdown is never changed.
 */
export const CommentHighlights = Extension.create<CommentHighlightOptions>({
  name: 'commentHighlights',
  addOptions() {
    return { onSelect: () => undefined };
  },
  addProseMirrorPlugins() {
    const { onSelect } = this.options;
    return [
      new Plugin<HighlightState>({
        key: commentHighlightKey,
        state: {
          init: () => ({ threads: [], activeId: null, decos: DecorationSet.empty }),
          apply(tr, value) {
            const meta = tr.getMeta(commentHighlightKey) as
              { threads: HighlightThread[]; activeId: string | null } | undefined;
            if (meta)
              return {
                ...meta,
                decos: build(tr.doc, meta.threads, meta.activeId, value.decos.map(tr.mapping, tr.doc)),
              };
            if (tr.docChanged) return { ...value, decos: value.decos.map(tr.mapping, tr.doc) };
            return value;
          },
        },
        props: {
          decorations: (state) => commentHighlightKey.getState(state)?.decos ?? DecorationSet.empty,
          handleClick: (_view, _pos, event) => {
            const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-thread]');
            if (el?.dataset.thread) onSelect(el.dataset.thread);
            return false;
          },
        },
      }),
    ];
  },
});
