import type { Editor } from '@tiptap/react';
import { htmlToMarkdown, markdownToHtml } from '../../../utils/markdownWysiwyg';
import type { EditorAdapter, EditorCapture } from './types';

/** How much text around the selection is kept as context. */
const AROUND = 1800;

function rectOf(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

// ---------------------------------------------------------------------------
// A <textarea> or <input> (comment box, Debug notes, acceptance criteria)
// ---------------------------------------------------------------------------

const MIRRORED = [
  'boxSizing',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
] as const;

/**
 * Where a character of a textarea is on screen (a hidden copy of the box is measured; a textarea has no range API).
 * @param el - The textarea or input.
 * @param index - Character offset in its value.
 */
export function textareaRect(el: HTMLTextAreaElement | HTMLInputElement, index: number): DOMRect {
  const cs = getComputedStyle(el);
  const mirror = document.createElement('div');
  for (const k of MIRRORED) mirror.style[k] = cs[k];
  const area = el instanceof HTMLTextAreaElement;
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.left = '-9999px';
  mirror.style.top = '0';
  mirror.style.width = `${el.offsetWidth}px`;
  mirror.style.whiteSpace = area ? 'pre-wrap' : 'pre';
  mirror.style.overflowWrap = 'break-word';
  mirror.textContent = el.value.slice(0, index);
  const mark = document.createElement('span');
  mark.textContent = el.value.slice(index) || '.';
  mirror.appendChild(mark);
  document.body.appendChild(mirror);
  const box = el.getBoundingClientRect();
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 18;
  const top = box.top + mark.offsetTop - el.scrollTop;
  const left = box.left + mark.offsetLeft - el.scrollLeft;
  document.body.removeChild(mirror);
  return rectOf(left, top, 1, line);
}

/** The paragraph at the cursor, or the one just above when the cursor is on an empty line: [start, end). */
function paragraphAt(value: string, caret: number): [number, number] {
  let c = caret;
  while (c > 0 && /\s/.test(value[c - 1])) c--;
  if (c === 0) return [caret, caret];
  const gap = value.lastIndexOf('\n\n', c - 1);
  const start = gap < 0 ? 0 : gap + 2;
  const next = value.indexOf('\n\n', c);
  let stop = next < 0 ? value.length : next;
  while (stop > start && /\s/.test(value[stop - 1])) stop--;
  return [start, stop];
}

function insertText(el: HTMLTextAreaElement | HTMLInputElement, text: string): boolean {
  el.focus();
  // execCommand keeps the browser's own undo stack, so Ctrl+Z takes the AI text back
  if (document.execCommand('insertText', false, text)) return true;
  const a = el.selectionStart ?? 0;
  const b = el.selectionEnd ?? a;
  el.setRangeText(text, a, b, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/**
 * The adapter of a plain text box: the comment box, Debug notes, acceptance criteria.
 * @param get - The textarea or input, or null while it is not on screen.
 * @param root - The element that carries `data-ai-editor` (defaults to the box itself).
 */
export function textareaAdapter(
  get: () => HTMLTextAreaElement | HTMLInputElement | null,
  root?: () => HTMLElement | null,
): EditorAdapter {
  return {
    root: () => root?.() ?? get(),
    capture(mode) {
      const el = get();
      if (!el) return null;
      const value = el.value;
      let a = el.selectionStart ?? 0;
      let b = el.selectionEnd ?? a;
      if (a === b && mode === 'paragraph') [a, b] = paragraphAt(value, a);
      const selection = value.slice(a, b);
      const locate = (): [number, number] | null => {
        const now = el.value;
        if (now.slice(a, b) === selection) return [a, b];
        if (!selection) return null;
        const i = now.indexOf(selection);
        return i >= 0 && now.indexOf(selection, i + 1) < 0 ? [i, i + selection.length] : null;
      };
      const cap: EditorCapture = {
        selection,
        before: value.slice(Math.max(0, a - AROUND), a),
        after: value.slice(b, b + AROUND),
        where: () => {
          const at = (selection ? locate() : null) ?? [a, b];
          const top = textareaRect(el, at[0]);
          const bottom = selection ? textareaRect(el, at[1]) : top;
          return rectOf(top.left, top.top, Math.max(1, el.getBoundingClientRect().width - 24), bottom.bottom - top.top);
        },
        current: () => (selection ? (locate() ? selection : null) : selection),
        apply(text, how) {
          const at = selection ? locate() : ([a, b] as [number, number]);
          if (!at) return false;
          const [s, e] = at;
          el.focus();
          if (how.kind === 'replace') {
            el.setSelectionRange(s, e);
            return insertText(el, text);
          }
          el.setSelectionRange(e, e);
          const now = el.value;
          const lead = how.block && e > 0 && now[e - 1] !== '\n' ? '\n\n' : '';
          return insertText(el, lead + text);
        },
      };
      return cap;
    },
    slash() {
      const el = get();
      if (!el || document.activeElement !== el) return null;
      const caret = el.selectionStart ?? 0;
      if (caret !== el.selectionEnd) return null;
      const m = /(^|\s)\/ai$/.exec(el.value.slice(0, caret));
      if (!m) return null;
      return {
        rect: textareaRect(el, caret),
        remove: () => {
          el.focus();
          el.setSelectionRange(caret - 3, caret);
          insertText(el, '');
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The WYSIWYG field of tickets (contenteditable that reads and writes Markdown)
// ---------------------------------------------------------------------------

function markdownOf(fragment: DocumentFragment): string {
  const holder = document.createElement('div');
  holder.appendChild(fragment);
  return htmlToMarkdown(holder);
}

/** The block (paragraph, list item, heading…) of a node inside the field. */
function blockOf(root: HTMLElement, node: Node | null): HTMLElement | null {
  let n: Node | null = node;
  while (n && n !== root) {
    if (n instanceof HTMLElement && /^(P|LI|H[1-6]|BLOCKQUOTE|PRE|DIV)$/.test(n.tagName) && n.parentElement) {
      if (n.parentElement === root || /^(UL|OL|BLOCKQUOTE)$/.test(n.parentElement.tagName) || n.tagName === 'LI')
        return n;
    }
    n = n.parentNode;
  }
  return null;
}

/**
 * The adapter of the ticket WYSIWYG field (`MarkdownEditor`): text goes to and from Markdown, and an accepted draft is
 * inserted with `execCommand`, so the field's own undo takes it back.
 * @param get - The contenteditable element, or null while it is not on screen.
 */
export function contentEditableAdapter(get: () => HTMLElement | null): EditorAdapter {
  return {
    root: get,
    capture(mode) {
      const root = get();
      const sel = window.getSelection();
      if (!root || !sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) return null;
      let range = sel.getRangeAt(0).cloneRange();
      if (range.collapsed && mode === 'paragraph') {
        let block = blockOf(root, range.startContainer);
        // the cursor sits on an empty line: take the block just above
        if (block && !block.textContent?.trim()) block = block.previousElementSibling as HTMLElement | null;
        if (block) {
          range = document.createRange();
          range.selectNodeContents(block);
        }
      }
      const selection = range.collapsed ? '' : markdownOf(range.cloneContents()).trim();
      const pre = document.createRange();
      pre.selectNodeContents(root);
      pre.setEnd(range.startContainer, range.startOffset);
      const post = document.createRange();
      post.selectNodeContents(root);
      post.setStart(range.endContainer, range.endOffset);
      const before = markdownOf(pre.cloneContents());
      const after = markdownOf(post.cloneContents());
      const saved = range.cloneRange();
      const textNow = () => (saved.collapsed ? '' : markdownOf(saved.cloneContents()).trim());
      return {
        selection,
        before: before.slice(-AROUND),
        after: after.slice(0, AROUND),
        where: () => {
          const rects = saved.getClientRects();
          const first = rects[0] ?? saved.getBoundingClientRect();
          const last = rects[rects.length - 1] ?? first;
          return rectOf(
            first.left,
            first.top,
            Math.max(1, root.getBoundingClientRect().width - 24),
            last.bottom - first.top,
          );
        },

        // a live Range follows edits elsewhere in the field; if its own text changed, so did the thing the AI saw
        current: () => (selection ? (textNow() === selection ? selection : null) : selection),
        apply(text, how) {
          const r = saved.cloneRange();
          if (how.kind === 'insert') r.collapse(false);
          root.focus();
          const s = window.getSelection();
          s?.removeAllRanges();
          s?.addRange(r);
          let html = markdownToHtml(text);
          if (how.kind === 'replace' || !how.block) {
            // inline text goes into the paragraph it replaces rather than splitting it
            const single = /^<p[^>]*>([\s\S]*)<\/p>\s*$/.exec(html);
            if (single && !/<p[ >]/.test(single[1])) html = single[1];
          }
          if (how.kind === 'insert' && how.block) html = `<p><br></p>${html}`;
          const ok = document.execCommand('insertHTML', false, html);
          if (ok) root.dispatchEvent(new Event('input', { bubbles: true }));
          return ok;
        },
      };
    },
    slash() {
      const root = get();
      const sel = window.getSelection();
      if (!root || !sel || !sel.isCollapsed || !root.contains(sel.anchorNode) || sel.anchorNode?.nodeType !== 3)
        return null;
      const node = sel.anchorNode as Text;
      const off = sel.anchorOffset;
      const m = /(^|\s)\/ai$/.exec(node.data.slice(0, off));
      if (!m) return null;
      const r = document.createRange();
      r.setStart(node, off);
      r.collapse(true);
      return {
        rect: r.getBoundingClientRect(),
        remove: () => {
          const del = document.createRange();
          del.setStart(node, off - 3);
          del.setEnd(node, off);
          root.focus();
          const s = window.getSelection();
          s?.removeAllRanges();
          s?.addRange(del);
          document.execCommand('delete');
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The Docs editor (Tiptap): Docs pages and ideas
// ---------------------------------------------------------------------------

/** Markdown of a slice of the document when the editor can say it, else its plain text. */
function sliceText(editor: Editor, from: number, to: number): string {
  const plain = editor.state.doc.textBetween(from, to, '\n');
  try {
    const md = (editor as unknown as { markdown?: { serialize: (json: unknown) => string } }).markdown?.serialize({
      type: 'doc',
      content: editor.state.doc.slice(from, to).content.toJSON(),
    });
    return (md ?? plain).trim() || plain;
  } catch {
    return plain;
  }
}

/**
 * The adapter of the Docs editor (also the idea page, which uses it): positions follow edits through the document.
 * @param get - The Tiptap editor, or null while it is not mounted.
 */
export function tiptapAdapter(get: () => Editor | null): EditorAdapter {
  return {
    root: () => {
      const ed = get();
      return ed && !ed.isDestroyed ? (ed.view.dom as HTMLElement) : null;
    },
    capture(mode) {
      const ed = get();
      if (!ed || ed.isDestroyed) return null;
      const { doc, selection } = ed.state;
      let from = selection.from;
      let to = selection.to;
      if (from === to && mode === 'paragraph') {
        // the text block the cursor is in, or the last one with text above it
        const found: { at: [number, number] | null } = { at: null };
        doc.descendants((node, pos) => {
          if (!node.isTextblock) return true;
          if (pos + 1 <= from && node.textContent.trim()) found.at = [pos + 1, pos + node.nodeSize - 1];
          return false;
        });
        if (found.at) [from, to] = found.at;
      }
      const text = from === to ? '' : sliceText(ed, from, to);
      const plainNow = () => doc.textBetween(from, to, '\n');
      const original = plainNow();
      const before = doc.textBetween(Math.max(0, from - AROUND), from, '\n');
      const after = doc.textBetween(to, Math.min(doc.content.size, to + AROUND), '\n');
      // where the text is now: the same range while the document before it did not change, else found by its text
      const locate = (): [number, number] | null => {
        const cur = ed.state.doc;
        if (from === to) return [Math.min(from, cur.content.size), Math.min(to, cur.content.size)];
        if (to <= cur.content.size && cur.textBetween(from, to, '\n') === original) return [from, to];
        let found: [number, number] | null = null;
        let count = 0;
        cur.descendants((node, pos) => {
          if (!node.isTextblock) return true;
          const t = node.textContent;
          const flat = original.replace(/\n/g, '');
          const i = t.indexOf(flat);
          if (flat && i >= 0) {
            count++;
            found = [pos + 1 + i, pos + 1 + i + flat.length];
          }
          return false;
        });
        return count === 1 ? found : null;
      };
      return {
        selection: text,
        before,
        after,
        where: () => {
          const at = locate() ?? [from, to];
          const size = ed.state.doc.content.size;
          const c0 = ed.view.coordsAtPos(Math.min(at[0], size));
          const c1 = ed.view.coordsAtPos(Math.min(at[1], size));
          const host = ed.view.dom.getBoundingClientRect();
          return rectOf(host.left, c0.top, host.width, Math.max(1, c1.bottom - c0.top));
        },
        current: () => (from === to ? '' : locate() ? text : null),
        apply(md, how) {
          const at = locate();
          if (!at) return false;
          const opts = { contentType: 'markdown' } as never;
          const chain = ed.chain().focus();
          if (how.kind === 'replace') return chain.insertContentAt({ from: at[0], to: at[1] }, md, opts).run();
          const $to = ed.state.doc.resolve(at[1]);
          // a block goes after the paragraph it belongs to; text goes where the cursor is
          const pos = how.block && $to.depth ? $to.after(1) : at[1];
          return chain.insertContentAt(pos, md, opts).run();
        },
      };
    },
  };
}
