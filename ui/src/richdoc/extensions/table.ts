/**
 * The editor's table with the plain Markdown rule of format 1: a table with a merged cell (colspan or rowspan above
 * 1) has no GFM form, so it is written as one placeholder line, `[embed: table with merged cells · <first row>]`.
 * Its node view is drawn again when the table's own attributes change (style, width…), so they reach the DOM.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import { Table, TableView } from '@tiptap/extension-table';
import { embedLine, hasMergedCells, mergedCellsTitle } from '../plain';

/**
 * TipTap's table view keeps the attributes it was made with; a change of the table's attributes (a new style from
 * Table properties) makes ProseMirror draw a new view, so its `data-*` attributes follow.
 */
export class RichTableView extends TableView {
  private dots: HTMLDivElement | null = null;
  private scroller: HTMLElement;
  private observer: ResizeObserver | null = null;

  constructor(...args: ConstructorParameters<typeof TableView>) {
    super(...args);
    // an outer box holds the scrolling wrapper, the scroll dots and the caption, so neither scrolls with the table
    this.scroller = this.dom;
    const outer = document.createElement('div');
    outer.className = 'dk-table-outer';
    outer.appendChild(this.scroller);
    this.dom = outer;
    const caption = (args[0] as PMNode).attrs.caption as unknown;
    if (typeof caption === 'string') {
      // the caption under the table (Table properties); edited in the panel, not in the page
      const el = document.createElement('div');
      el.className = 'dk-table-caption';
      el.contentEditable = 'false';
      el.textContent = caption || 'Caption';
      if (!caption) el.dataset.empty = 'true';
      outer.appendChild(el);
    }
    // a wide table scrolls sideways (Blocks board, F 33): dots under it say where in the table the view is
    this.dots = document.createElement('div');
    this.dots.className = 'dk-table-dots';
    this.dots.contentEditable = 'false';
    this.dots.setAttribute('aria-hidden', 'true');
    outer.insertBefore(this.dots, this.scroller.nextSibling);
    this.scroller.addEventListener('scroll', this.drawDots, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.drawDots);
      this.observer.observe(this.scroller);
      this.observer.observe(this.table);
    }
  }

  /** One dot per screenful of the table, the one in view green; none when the table fits. */
  private drawDots = () => {
    const dots = this.dots;
    if (!dots) return;
    const { scrollWidth, clientWidth, scrollLeft } = this.scroller;
    const pages =
      clientWidth > 0 && scrollWidth > clientWidth + 1 ? Math.min(6, Math.ceil(scrollWidth / clientWidth)) : 0;
    const at = pages > 1 ? Math.round((scrollLeft / (scrollWidth - clientWidth)) * (pages - 1)) : 0;
    this.scroller.toggleAttribute('data-scrolls', pages > 1);
    this.scroller.toggleAttribute('data-at-end', pages > 1 && scrollLeft >= scrollWidth - clientWidth - 1);
    if (dots.childElementCount !== pages)
      dots.replaceChildren(...Array.from({ length: pages }, () => document.createElement('span')));
    Array.from(dots.children).forEach((d, i) => d.classList.toggle('on', i === at));
  };

  destroy() {
    this.observer?.disconnect();
    this.scroller.removeEventListener('scroll', this.drawDots);
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type || JSON.stringify(node.attrs) !== JSON.stringify(this.node.attrs)) return false;
    return super.update(node);
  }
}

/** `Table` whose Markdown is a placeholder line when a cell is merged, GFM otherwise (as before). */
export const RichTable = Table.extend({
  addOptions() {
    return { ...(this.parent?.() ?? {}), View: RichTableView } as ReturnType<NonNullable<typeof this.parent>>;
  },
  renderMarkdown(node, h, ctx) {
    if (hasMergedCells(node)) return embedLine('table with merged cells', mergedCellsTitle(node));
    return this.parent?.(node, h, ctx) ?? '';
  },
});
