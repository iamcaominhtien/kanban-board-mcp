/**
 * References as a chip or a card (design "Embeds", frame 54): a page or ticket chip on a line of its own becomes a
 * page or ticket card in its place; a chip inside a sentence keeps its place and the card goes on a new line under
 * the paragraph. A card turns back into a chip on its own line.
 */

import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

/** A reference chip found in a paragraph. */
export interface ChipRef {
  kind: 'page' | 'ticket';
  /** The chip's attributes. */
  attrs: Record<string, unknown>;
  /** What the chip says ("Requirements", "KAN-12"). */
  label: string;
}

/** The reference chips of a paragraph, in order. */
export function chipsIn(node: PMNode): ChipRef[] {
  if (node.type.name !== 'paragraph') return [];
  const out: ChipRef[] = [];
  node.forEach((child) => {
    if (child.type.name === 'docRef')
      out.push({
        kind: 'page',
        attrs: child.attrs,
        label: String(child.attrs.label || child.attrs.page || ''),
      });
    else if (child.type.name === 'ticketRef')
      out.push({ kind: 'ticket', attrs: child.attrs, label: String(child.attrs.key || '') });
  });
  return out;
}

/** True when the paragraph holds nothing but one chip (and spaces). */
export function onlyChip(node: PMNode): boolean {
  if (node.type.name !== 'paragraph') return false;
  let chips = 0;
  let other = false;
  node.forEach((child) => {
    if (child.type.name === 'docRef' || child.type.name === 'ticketRef') chips += 1;
    else if (!(child.isText && !(child.text ?? '').trim())) other = true;
  });
  return chips === 1 && !other;
}

/** The card node for a chip. */
function cardFor(editor: Editor, chip: ChipRef): PMNode | null {
  const { schema } = editor;
  if (chip.kind === 'page') {
    const page = String(chip.attrs.page || '');
    if (!page) return null;
    return schema.nodes.pageCard.create({ page, pageId: chip.attrs.pageId ?? null });
  }
  const key = String(chip.attrs.key || '');
  return key ? schema.nodes.ticketCard.create({ key }) : null;
}

/**
 * Show as card: the chip number `index` of the paragraph at `pos` becomes a card.
 * @returns Whether anything changed.
 */
export function chipToCard(editor: Editor, pos: number, index = 0): boolean {
  const para = editor.state.doc.nodeAt(pos);
  if (!para) return false;
  const chip = chipsIn(para)[index];
  if (!chip) return false;
  const card = cardFor(editor, chip);
  if (!card) return false;
  const tr = editor.state.tr;
  if (onlyChip(para)) tr.replaceWith(pos, pos + para.nodeSize, card);
  else tr.insert(pos + para.nodeSize, card);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Show as chip: the card at `pos` becomes a chip on a line of its own.
 * @returns Whether anything changed.
 */
export function cardToChip(editor: Editor, pos: number): boolean {
  const card = editor.state.doc.nodeAt(pos);
  if (!card) return false;
  const { schema } = editor;
  let chip: PMNode | null = null;
  if (card.type.name === 'pageCard' && card.attrs.page)
    chip = schema.nodes.docRef.create({ page: card.attrs.page, pageId: card.attrs.pageId ?? null });
  else if (card.type.name === 'ticketCard' && card.attrs.key)
    chip = schema.nodes.ticketRef.create({ key: card.attrs.key });
  if (!chip) return false;
  const para = schema.nodes.paragraph.create(null, [chip]);
  editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + card.nodeSize, para).scrollIntoView());
  return true;
}
