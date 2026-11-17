/**
 * The editor's table with the plain Markdown rule of format 1: a table with a merged cell (colspan or rowspan above
 * 1) has no GFM form, so it is written as one placeholder line, `[embed: table with merged cells · <first row>]`.
 */

import { Table } from '@tiptap/extension-table';
import { embedLine, hasMergedCells, mergedCellsTitle } from '../plain';

/** `Table` whose Markdown is a placeholder line when a cell is merged, GFM otherwise (as before). */
export const RichTable = Table.extend({
  renderMarkdown(node, h, ctx) {
    if (hasMergedCells(node)) return embedLine('table with merged cells', mergedCellsTitle(node));
    return this.parent?.(node, h, ctx) ?? '';
  },
});
