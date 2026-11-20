/**
 * Shared highlights in a print (design board "Rich Docs — reading", K 93): off by default; when "Include highlights"
 * is on, each prints as its tint with the dotted line and its marker, and a list at the foot says who made them.
 * With "Colours and background" off the print style sheet drops the tint and keeps the line and the marker. The
 * reader's live layer (CSS Custom Highlight API) does not reach a copy of the page, so the copy gets real elements.
 */

import { HL_INK, colorName, shapeSvg, tintOf } from './colors';
import { locate } from './hlAnchor';
import { personInk, type HlPerson } from './useHighlightLayer';
import type { HlItem } from './useHighlights';

/** Wraps the text nodes of a range in `.dk-hl-print` spans; returns the last one (null when nothing was wrapped). */
function wrapRange(range: Range, tint: string, ink: string): HTMLElement | null {
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
  if (!root) return null;
  const texts: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (range.intersectsNode(n) && !(n.parentElement?.closest('[data-hl-skip]') ?? null)) texts.push(n as Text);
  }
  let last: HTMLElement | null = null;
  for (let t of texts) {
    if (t === range.endContainer && range.endOffset < t.length) t.splitText(range.endOffset);
    if (t === range.startContainer && range.startOffset > 0) t = t.splitText(range.startOffset);
    if (!t.data.length || !t.parentNode) continue;
    const span = document.createElement('span');
    span.className = 'dk-hl-print';
    span.style.setProperty('--hl-tint', tint);
    span.style.setProperty('--hl-ink', ink);
    t.parentNode.insertBefore(span, t);
    span.appendChild(t);
    last = span;
  }
  return last;
}

/**
 * A copy of the page body for a print: the reader's markers taken out and, when asked, the highlights drawn in it
 * with their markers and the list at the foot.
 * @param body - The rendered page body (not changed).
 * @param include - "Include highlights" is on.
 * @param items - The highlights drawn for the reader.
 * @param personOf - How a person is named and coloured.
 * @param commentsOf - The number of comments on a highlight.
 * @returns The copy, or null without a body.
 */
export function printBody(
  body: HTMLElement | null,
  include: boolean,
  items: HlItem[],
  personOf: (author: string) => HlPerson,
  commentsOf: (h: HlItem) => number,
): HTMLElement | null {
  if (!body) return null;
  const copy = body.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.dk-hl-mark').forEach((m) => m.remove());
  const live = items.filter((h) => !h.local);
  if (!include || !live.length) return copy;
  const placed: { h: HlItem; person: HlPerson }[] = [];
  for (const h of [...live].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    let range: Range | null = null;
    try {
      range = locate(copy, h);
    } catch {
      range = null;
    }
    if (!range) continue;
    const last = wrapRange(range, tintOf(h.color), HL_INK[h.color]);
    if (!last) continue;
    const person = personOf(h.author);
    const mark = document.createElement('span');
    mark.className = 'dk-hl-pmark';
    mark.dataset.hlSkip = '';
    mark.innerHTML = shapeSvg(h.color, 10);
    const dot = document.createElement('span');
    dot.className = 'dk-hl-dot';
    dot.style.background = personInk(person);
    mark.appendChild(dot);
    last.after(mark);
    placed.push({ h, person });
  }
  if (!placed.length) return copy;
  const list = document.createElement('section');
  list.className = 'dk-hl-print-list';
  list.dataset.hlSkip = '';
  const title = document.createElement('h2');
  title.textContent = 'Highlights';
  list.appendChild(title);
  const ol = document.createElement('ol');
  for (const { h, person } of placed) {
    const li = document.createElement('li');
    li.innerHTML = shapeSvg(h.color, 10);
    const n = commentsOf(h);
    const who = h.mine ? 'You' : person.name;
    li.append(
      ` ${colorName(h.color)} · ${who}${n ? ` · ${n === 1 ? '1 comment' : `${n} comments`}` : ''}: “${h.quote}”`,
    );
    ol.appendChild(li);
  }
  list.appendChild(ol);
  copy.appendChild(list);
  return copy;
}
