/**
 * The marker of a search match that says what kind of thing matched (RichDocsStates4 I 62, RichDocsLinks B 7):
 * "Heading", "Table", "Picture · caption", "Code"… Plain text has none.
 */

import type { DocsSearchMatch } from '../../../types/docsFx';
import { KindGlyph } from './BlockKind';

const WORDS: Record<string, string> = {
  heading: 'Heading',
  table: 'Table',
  image: 'Picture',
  video: 'Video',
  code: 'Code',
  callout: 'Callout',
  list: 'List',
  quote: 'Quote',
  diagram: 'Diagram',
  sketch: 'Sketch',
  canvas: 'Canvas',
  embed: 'Embed',
  link: 'Link',
  file: 'File',
  formula: 'Formula',
};

const FIELDS: Record<string, string> = { caption: 'caption', alt: 'description', title: 'title' };

/** The marker's words for a match, or null for plain text. */
export function markerWords(m: Pick<DocsSearchMatch, 'kind' | 'field' | 'row'>): string | null {
  const word = WORDS[m.kind ?? ''];
  if (!word) return null;
  const field = m.field ? FIELDS[m.field] : m.kind === 'table' && m.row ? `row ${m.row}` : null;
  return field ? `${word} · ${field}` : word;
}

/**
 * The marker pill of a match: height 20, radius 5, #EEF3EF, 10.5 px bold, with the kind's 11 px icon.
 * @param props.match - The match (its `kind` and `field`).
 */
export function MatchMarker({ match }: { match: Pick<DocsSearchMatch, 'kind' | 'field' | 'row'> }) {
  const words = markerWords(match);
  if (!words) return null;
  return (
    <span
      data-testid="match-marker"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 20,
        padding: '0 7px',
        borderRadius: 5,
        background: '#EEF3EF',
        color: '#3A4A3E',
        fontSize: 10.5,
        fontWeight: 700,
        whiteSpace: 'nowrap',
        flex: 'none',
        boxSizing: 'border-box',
      }}
    >
      <KindGlyph kind={match.kind ?? 'text'} size={11} style={{ strokeWidth: 2 }} />
      {words}
    </span>
  );
}

/** Where a match opens its page: at its block when the page is rich, else at its section. */
export function matchAnchor(m: Pick<DocsSearchMatch, 'blockId' | 'slug'>): string | undefined {
  return m.blockId || m.slug || undefined;
}

/**
 * A table match drawn as its row (States4 I 62): cells side by side in a 1 px #E3E8E5 frame, radius 6, 12 px; the
 * cell that holds a search word on #FFF6D6, bold, the word marked.
 * @param props.cells - The row's cells.
 * @param props.terms - The words searched for (marked in the cells).
 */
export function TableRowSnip({ cells, terms }: { cells: string[]; terms: string[] }) {
  const words = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
  const mark = (text: string) => {
    const low = text.toLowerCase();
    const hit = words.map((w) => ({ w, at: low.indexOf(w) })).find((x) => x.at >= 0);
    if (!hit) return text;
    return (
      <>
        {text.slice(0, hit.at)}
        <mark style={{ background: '#FFE9A8', color: 'inherit', borderRadius: 3, padding: '0 1px' }}>
          {text.slice(hit.at, hit.at + hit.w.length)}
        </mark>
        {text.slice(hit.at + hit.w.length)}
      </>
    );
  };
  return (
    <div
      data-testid="match-row"
      style={{
        display: 'flex',
        border: '1px solid #E3E8E5',
        borderRadius: 6,
        overflow: 'hidden',
        marginTop: 3,
        fontSize: 12,
        color: '#3A4A3E',
      }}
    >
      {cells.map((c, i) => {
        const on = words.some((w) => c.toLowerCase().includes(w));
        return (
          <span
            key={i}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '3px 8px',
              borderRight: i < cells.length - 1 ? '1px solid #E3E8E5' : 'none',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              ...(on ? { background: '#FFF6D6', fontWeight: 700 } : {}),
            }}
          >
            {mark(c)}
          </span>
        );
      })}
    </div>
  );
}
