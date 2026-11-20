/**
 * Pieces of the plain Markdown flavour (README.md) for the blocks format 1 adds: the one-line placeholder of an
 * embed, and the escaping the editor applies to text.
 */

import type { JSONContent } from '@tiptap/core';
import { cellText } from './text';

/** A value on one line: `[`, `]` and line breaks become spaces, runs of white space one space, trimmed. */
export function plainLine(value: string): string {
  return value
    .replace(/[[\]\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The placeholder line of a block plain Markdown cannot hold: `[embed: <kind> · <title>]`, or `[embed: <kind>]` when
 * the title is empty (after {@link plainLine}).
 * @param kind - `video`, `HTML embed`, `link` or `table with merged cells`.
 * @param title - The block's title (see the node for which attribute).
 */
export function embedLine(kind: string, title: string): string {
  const t = plainLine(title);
  return t ? `[embed: ${kind} · ${t}]` : `[embed: ${kind}]`;
}

/** Backslash-escape the characters the editor's serializer escapes in text (`\ ` * _ [ ] ~`). */
export function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*_[\]~])/g, '\\$1');
}

/** Whether a table has a cell spanning more than one column or row. */
export function hasMergedCells(table: JSONContent): boolean {
  return (table.content ?? []).some((row) =>
    (row.content ?? []).some((c) => Number(c.attrs?.colspan ?? 1) > 1 || Number(c.attrs?.rowspan ?? 1) > 1),
  );
}

/** The title of a merged table's placeholder: its first row, cells joined by ` | ` as in the text projection. */
export function mergedCellsTitle(table: JSONContent): string {
  const first = table.content?.[0];
  return (first?.content ?? []).map(cellText).join(' | ');
}
