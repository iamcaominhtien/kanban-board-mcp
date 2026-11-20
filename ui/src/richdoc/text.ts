/**
 * The plain-text projection of a rich document (README.md, "Projections"): what search, snippets, word counts and
 * Docs health read. Pure, no editor needed; the server's `kb-richdoc` reproduces it byte for byte (fixtures/*.txt).
 *
 * Rules:
 * - one entry per text block (paragraph, heading, pull quote, code block), skipped when it holds only white space;
 *   a hard break is a new line, a soft line break in the text stays one;
 * - inline: text as is (marks dropped), docRef its label or `Page` / `Page › Section`, ticketRef its key, math its
 *   LaTeX;
 * - list items start with `- `, task items with `- [ ] ` or `- [x] ` (on the item's first line; nested lists are not
 *   indented);
 * - a table row is one line, its cells joined by ` | ` (a cell's blocks joined by a space, its line breaks made
 *   spaces); a row whose cells are all empty is skipped;
 * - embeds give one line per non-empty value: image alt, caption; video title, caption, description; HTML embed
 *   title; link card title, description; file card name; page card page; ticket card key; diagram, sketch, canvas
 *   label; math block LaTeX;
 * - callout title, then its blocks; quote and pull quote source after their text; a rule gives nothing.
 */

import type { JSONContent } from '@tiptap/core';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The text of a node's inline content. */
export function inlineText(node: JSONContent): string {
  return (node.content ?? [])
    .map((n) => {
      const a = n.attrs ?? {};
      switch (n.type) {
        case 'text':
          return n.text ?? '';
        case 'hardBreak':
          return '\n';
        case 'docRef':
          return str(a.label) || (str(a.section) ? `${str(a.page)} › ${str(a.section)}` : str(a.page));
        case 'ticketRef':
          return str(a.key);
        case 'mathInline':
          return str(a.latex);
        default:
          return n.content ? inlineText(n) : '';
      }
    })
    .join('');
}

const nonEmpty = (...values: unknown[]) => values.map(str).filter((v) => v.trim() !== '');

/** The text of one table cell: its blocks on one line. */
export function cellText(cell: JSONContent): string {
  return blocks(cell.content ?? [])
    .map((l) => l.replace(/\n/g, ' '))
    .join(' ');
}

function blocks(nodes: JSONContent[]): string[] {
  return nodes.flatMap(block);
}

function item(node: JSONContent, prefix: string): string[] {
  const lines = blocks(node.content ?? []);
  if (lines.length) lines[0] = prefix + lines[0];
  return lines;
}

function block(node: JSONContent): string[] {
  const a = node.attrs ?? {};
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'codeBlock':
      return nonEmpty(inlineText(node));
    case 'pullQuote':
      return [...nonEmpty(inlineText(node)), ...nonEmpty(a.source)];
    case 'blockquote':
      return [...blocks(node.content ?? []), ...nonEmpty(a.source)];
    case 'callout':
      return [...nonEmpty(a.title), ...blocks(node.content ?? [])];
    case 'bulletList':
    case 'orderedList':
      return (node.content ?? []).flatMap((li) => item(li, '- '));
    case 'taskList':
      return (node.content ?? []).flatMap((li) => item(li, li.attrs?.checked ? '- [x] ' : '- [ ] '));
    case 'table':
      return (node.content ?? [])
        .map((row) => (row.content ?? []).map(cellText))
        .filter((cells) => cells.some((c) => c !== ''))
        .map((cells) => cells.join(' | '));
    case 'image':
      return nonEmpty(a.alt, a.caption);
    case 'video':
      return nonEmpty(a.title, a.caption, a.description);
    case 'htmlEmbed':
      return nonEmpty(a.title);
    case 'linkEmbed':
      return nonEmpty(a.title, a.description);
    case 'fileCard':
      return nonEmpty(a.name);
    case 'pageCard':
      return nonEmpty(a.page);
    case 'ticketCard':
      return nonEmpty(a.key);
    case 'diagram':
    case 'sketch':
    case 'canvas':
      return nonEmpty(a.label);
    case 'mathBlock':
      return nonEmpty(a.latex);
    case 'horizontalRule':
      return [];
    default:
      return blocks(node.content ?? []);
  }
}

/**
 * The plain text of a page: its lines joined by `\n`, without a final newline (`''` for an empty page).
 * @param doc - A TipTap JSON document.
 */
export function docToText(doc: JSONContent): string {
  return blocks(doc.content ?? []).join('\n');
}
