/**
 * Wide content on a small screen (design board "Rich Docs — reading", I, frames 61-64): a table wider than the text
 * column scrolls in its own box; this marks it so the style sheet (reader.css) fades its right edge while there is
 * more to the right (`data-more-right`) and says "Scroll sideways for more" (`data-wide`). On a tablet a marked table
 * may use the pane's width past the column.
 */

import { useEffect } from 'react';

/**
 * Marks the wide tables of a rendered page, again when the page or its width changes and as each one scrolls.
 * @param body - The element holding the rendered page.
 * @param revision - Changes when the page's content does (a new version, the rest of a long page arriving).
 */
export function useWideBlocks(body: HTMLElement | null, revision: unknown): void {
  useEffect(() => {
    if (!body) return;
    const wraps = Array.from(body.querySelectorAll<HTMLElement>('.dk-table-wrap'));
    if (!wraps.length) return;
    const mark = () => {
      const col = body.clientWidth;
      for (const w of wraps) {
        const table = w.querySelector('table');
        const wide = !!table && col > 0 && table.offsetWidth > col + 1;
        w.toggleAttribute('data-wide', wide);
        w.toggleAttribute('data-more-right', w.scrollWidth - w.clientWidth - w.scrollLeft > 1);
      }
    };
    mark();
    wraps.forEach((w) => w.addEventListener('scroll', mark, { passive: true }));
    const obs = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(mark) : null;
    obs?.observe(body);
    return () => {
      wraps.forEach((w) => w.removeEventListener('scroll', mark));
      obs?.disconnect();
    };
  }, [body, revision]);
}
