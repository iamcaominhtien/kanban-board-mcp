/**
 * Edit-mode pills for the contentEditable editors: `[[Page#Section]]` and ticket keys render as
 * non-editable pills; the token under the caret is plain text so it can be edited, and snaps back
 * to a pill when the caret leaves (design: TicketDocRefs A.1 / A.2).
 */

const PAGE_ICON =
  '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M6 3H14L19 8V20A1 1 0 0 1 18 21H6A1 1 0 0 1 5 20V4A1 1 0 0 1 6 3Z"/><path d="M14 3V8H19"/><path d="M8.5 13H15.5"/><path d="M8.5 16.5H13"/></svg>';
const HASH_ICON =
  '<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M9 3L7 21"/><path d="M17 3L15 21"/><path d="M4.5 9H20"/><path d="M4 15H19.5"/></svg>';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `Page#Section|label` (the inside of `[[ ]]`) as pill markup. */
export function refChipHtml(inner: string): string {
  const [target, label] = inner.split('|');
  const [title, anchor] = target.split('#');
  const body = label
    ? `<span style="border-bottom:1px dotted #68BA7F">${esc(label)}</span>`
    : `${esc(title.trim())}${anchor ? `<span style="color:#68BA7F;font-weight:500">›</span><span style="display:inline-flex;align-items:center;gap:2px">${HASH_ICON}${esc(anchor.trim())}</span>` : ''}`;
  return `<span class="dk-chip dk-chip-page docRef" data-ref="${esc(inner)}" contenteditable="false">${PAGE_ICON}${body}</span>`;
}

/** HTML for a ticket-key pill in the contentEditable editor. */
export function keyChipHtml(key: string): string {
  return `<span class="dk-chip dk-chip-ticket docRef" data-key="${esc(key)}" contenteditable="false"><span style="width:7px;height:7px;border-radius:50%;background:#9AA8A0;display:inline-block;flex-shrink:0"></span><span style="font-family:var(--font-mono);font-size:12px;font-weight:600">${esc(key)}</span></span>`;
}

let keyPrefix: string | null = null;

/** The ticket prefix of the project being edited (KAN): only these keys become pills. */
export function setKeyPrefix(prefix: string | null): void {
  keyPrefix = prefix && /^[A-Z][A-Z0-9]{0,9}$/i.test(prefix) ? prefix : null;
}

/** Regex matching ticket keys of the current project, or null. */
export function keyPattern(): RegExp | null {
  return keyPrefix ? new RegExp(`\\b${keyPrefix}-\\d+\\b`, 'g') : null;
}

function tokenRegex(): RegExp {
  return new RegExp(`\\[\\[([^\\][\\n]+?)\\]\\]${keyPrefix ? `|\\b(${keyPrefix}-\\d+)\\b` : ''}`, 'g');
}

function inCode(node: Node, root: HTMLElement): boolean {
  for (let n: Node | null = node.parentNode; n && n !== root; n = n.parentNode) {
    if (n instanceof HTMLElement && (n.tagName === 'CODE' || n.tagName === 'PRE' || n.classList.contains('docRef')))
      return true;
  }
  return false;
}

/**
 * Turn every complete token that does not hold the caret into a pill. Returns true when something changed.
 * @param root - Editable element to scan; text inside code blocks and existing pills is skipped.
 * @param keepCaret - Leave a token as text while the collapsed caret is inside or at the end of it.
 */
export function snapRefTokens(root: HTMLElement, keepCaret = true): boolean {
  const sel = window.getSelection();
  const caretNode =
    keepCaret && sel && sel.rangeCount && sel.isCollapsed && root.contains(sel.anchorNode) ? sel.anchorNode : null;
  const caretOffset = caretNode ? (sel as Selection).anchorOffset : -1;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!inCode(n, root) && /\[\[|-\d/.test(n.textContent ?? '')) nodes.push(n as Text);
  }
  let changed = false;
  for (const node of nodes) {
    const text = node.textContent ?? '';
    const found = [...text.matchAll(tokenRegex())];
    for (const m of found.reverse()) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const isKey = !m[1];
      if (node === caretNode) {
        // a half-typed key (KAN-3 → KAN-31) or a token the caret sits in stays text
        if (isKey ? caretOffset >= start && caretOffset <= end : caretOffset > start && caretOffset < end) continue;
      }
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const holder = document.createElement('span');
      holder.innerHTML = isKey ? keyChipHtml(m[0]) : refChipHtml(m[1]);
      const chip = holder.firstElementChild as HTMLElement;
      const caretAtEnd = node === caretNode && caretOffset === end;
      range.deleteContents();
      range.insertNode(chip);
      if (caretAtEnd && sel) {
        const after = document.createRange();
        after.setStartAfter(chip);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);
      }
      changed = true;
    }
  }
  return changed;
}

/** Click on a pill: swap it for its raw markdown with the caret inside, so it can be edited. */
export function expandRefChip(chip: HTMLElement): void {
  const inner = chip.getAttribute('data-ref');
  const raw = inner != null ? `[[${inner}]]` : (chip.getAttribute('data-key') ?? '');
  const text = document.createTextNode(raw);
  chip.replaceWith(text);
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.setStart(text, inner != null ? Math.max(2, raw.length - 2) : raw.length);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** The raw token holding the caret, if any (Esc / → leave it). */
export function tokenAtCaret(root: HTMLElement): { node: Text; end: number } | null {
  const sel = window.getSelection();
  if (
    !sel ||
    !sel.rangeCount ||
    !sel.isCollapsed ||
    !root.contains(sel.anchorNode) ||
    sel.anchorNode?.nodeType !== Node.TEXT_NODE
  )
    return null;
  const node = sel.anchorNode as Text;
  for (const m of (node.textContent ?? '').matchAll(tokenRegex())) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (sel.anchorOffset >= start && sel.anchorOffset <= end) return { node, end };
  }
  return null;
}
