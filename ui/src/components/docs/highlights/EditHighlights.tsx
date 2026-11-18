/**
 * Shared highlights while the page is edited (design board "Rich Docs — reading", K 101): they stay on the page as
 * a dotted line with their markers (editor/extensions/SharedHighlights.ts), are not part of the text, and a one-line
 * strip says so with Hide (remembered on this device) and a toolbar-style count.
 */

import { useMemo, useState } from 'react';
import { useDocsHighlights, type HighlightColor } from '../../../api/docsHighlights';
import type { DocsCommentsResult } from '../../../types/docs';
import type { EditHighlight } from '../editor/extensions/SharedHighlights';
import { personOf as commentPerson } from '../comments/people';
import { HL_INK, colorName, shapeSvg } from './colors';
import { HlIcon } from './hlIcons';
import { personInk } from './useHighlightLayer';
import './highlights.css';

const HIDE_KEY = 'kb.docs.highlightsHiddenInEdit';

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The shared highlights of a page for its editor.
 * @param pageId - The page.
 * @param enabled - A published rich page, online: there are highlights to show.
 * @param comments - The page's comments (its members and the reader's name, for the dots).
 * @returns `items` for DocsEditor's `sharedHighlights` (empty when hidden) and the `strip` to show above the text.
 */
export function useEditHighlights(pageId: string, enabled: boolean, comments: DocsCommentsResult | undefined) {
  const q = useDocsHighlights(pageId, enabled);
  const [hidden, setHidden] = useState(readHidden);
  const toggle = () => {
    setHidden((v) => {
      try {
        window.localStorage.setItem(HIDE_KEY, v ? '0' : '1');
      } catch {
        // storage blocked: Hide lasts for this visit
      }
      return !v;
    });
  };
  const list = useMemo(() => (q.data?.enabled ? q.data.highlights : []), [q.data]);
  const me = comments?.me ?? '';
  const items: EditHighlight[] = useMemo(
    () =>
      hidden
        ? []
        : list.map((h) => {
            const p = commentPerson(h.author, comments?.members ?? [], me);
            const color = h.color as HighlightColor;
            return {
              id: h.id,
              blockId: h.blockId,
              endBlockId: h.endBlockId,
              start: h.start,
              end: h.end,
              quote: h.quote,
              ink: HL_INK[color] ?? '#8A5A00',
              shapeSvg: shapeSvg(color, 10),
              dot: personInk(p),
              label: `Highlighted ${colorName(color)} by ${h.mine ? 'you' : p.name}`,
            };
          }),
    [list, hidden, comments, me],
  );
  const strip =
    enabled && list.length > 0 ? (
      <div className="hl-edit-strip" data-testid="hl-edit-strip">
        <span className="hl-edit-count" aria-label={`Highlights, ${list.length}`}>
          <HlIcon name="marker" size={14} stroke={2} />
          <span className="hl-edit-badge">{list.length}</span>
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          {hidden ? (
            <>
              <b>Highlights are hidden while you edit.</b> They are still on the page for readers.
            </>
          ) : (
            <>
              <b>Highlights stay on the page while you edit.</b> They show as a dotted line, are not part of the text,
              and never get in the way of typing.
            </>
          )}
        </span>
        <button type="button" className="hl-btn hl-btn-28" onClick={toggle} data-testid="hl-edit-hide">
          <HlIcon name={hidden ? 'marker' : 'close'} size={14} stroke={2} />
          {hidden ? 'Show' : 'Hide'}
        </button>
      </div>
    ) : null;
  return { items, strip, hidden };
}
