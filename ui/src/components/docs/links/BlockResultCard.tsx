/**
 * The search page's result card for a block (RichDocsLinks B 7): a picture, video, table, code block, file or
 * diagram that matched gets a card of its own, with a 30 px kind tile, the block's name, its kind and what matched
 * ("caption", "line 2", "name"), the page it is in, and the block as it looks: the picture with its caption and
 * description, the code lines, the table row, the file name.
 */

import type { CSSProperties, ReactNode } from 'react';
import type { DocsSearchMatch, DocsSearchPage } from '../../../types/docsFx';
import { Avatar, Snip, highlight, timeAgo } from '../searchShared';
import { TableRowSnip, matchAnchor } from './MatchMarker';

/** The kinds whose matches get a card of their own. */
const CARD_KINDS = new Set(['image', 'video', 'table', 'code', 'file', 'diagram', 'sketch', 'canvas']);

/** Whether a match is shown as a block card (it sits in a picture, table, code block, file or diagram). */
export function isBlockMatch(m: DocsSearchMatch): boolean {
  return CARD_KINDS.has(m.kind ?? '') && (!!m.card || (m.kind === 'table' && !!m.cells?.length));
}

const TILE: Record<string, { bg: string; fg: string; svg: ReactNode; word: string }> = {
  image: {
    bg: '#F0E8FA',
    fg: '#6B3FA8',
    word: 'Image',
    svg: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="9" cy="10" r="1.8" />
        <path d="M4 18l5-5 4 4 3-3 4 4" />
      </>
    ),
  },
  table: {
    bg: '#E3EFFA',
    fg: '#2F6FB0',
    word: 'Table',
    svg: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 10h18M3 15h18M9 5v14" />
      </>
    ),
  },
  code: { bg: '#1E2A22', fg: '#9FE0B2', word: 'Code', svg: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 5l-4 14" /> },
  diagram: {
    bg: '#FDEEDC',
    fg: '#B4571F',
    word: 'Diagram',
    svg: (
      <>
        <rect x="3" y="3" width="8" height="6" rx="1.2" />
        <rect x="13" y="15" width="8" height="6" rx="1.2" />
        <path d="M7 9v3.5h10V15" />
      </>
    ),
  },
  file: {
    bg: '#EEF0EF',
    fg: '#5B6B60',
    word: 'File',
    svg: <path d="M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L14 7.5" />,
  },
};
TILE.video = { ...TILE.image, word: 'Video' };
TILE.sketch = { ...TILE.diagram, word: 'Sketch' };
TILE.canvas = { ...TILE.diagram, word: 'Canvas' };

const PAGE_CHIP: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  height: 22,
  padding: '0 8px',
  borderRadius: 6,
  background: '#F1F8F3',
  color: '#2E6F40',
  border: '1px solid #CFE6D6',
  fontSize: 12.5,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
  boxSizing: 'border-box',
};

const LABEL: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: '.04em', color: '#5B6B60' };

/** "240 KB" */
function size(bytes: number | null | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What matched, on the right of the head: "caption", "line 2", "row 3", "name", "label". */
function matchedOn(m: DocsSearchMatch): string | null {
  const c = m.card;
  switch (m.kind) {
    case 'image':
    case 'video':
      return m.field === 'alt' ? 'description' : (m.field ?? null);
    case 'code':
      return c?.lines?.[0] ? `line ${c.lines[0].n}` : null;
    case 'table':
      return m.row ? `row ${m.row}` : null;
    case 'file':
      return 'name';
    case 'diagram':
    case 'sketch':
    case 'canvas':
      return 'label';
    default:
      return null;
  }
}

/**
 * One block result.
 * @param props.page - The page the block is in.
 * @param props.match - The match (with its `card`).
 * @param props.q - The search words (marked in the card).
 * @param props.onOpen - Opens the page at the block.
 */
export function BlockResultCard({
  page,
  match: m,
  q,
  onOpen,
}: {
  page: DocsSearchPage;
  match: DocsSearchMatch;
  q: string;
  onOpen: (pageId: string, anchor?: string) => void;
}) {
  const kind = m.kind ?? 'text';
  const tile = TILE[kind] ?? TILE.file;
  const c = m.card ?? {};
  const name =
    (kind === 'file' ? c.name : null) ||
    c.label ||
    (kind === 'image' || kind === 'video' ? c.title || c.caption : null) ||
    tile.word;
  const terms = q.split(/\s+/).filter((w) => w && !w.startsWith('-'));
  const on = matchedOn(m);
  const detail = kind === 'code' ? c.language : kind === 'file' ? size(c.size) : null;
  const open = () => onOpen(page.pageId, matchAnchor(m));
  let body: ReactNode = null;
  if ((kind === 'image' || kind === 'video') && (c.src || c.poster)) {
    const words = m.field === 'alt' ? c.alt || c.description : c.caption || c.title;
    body = (
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div
          data-testid="search-card-thumb"
          style={{ width: 120, height: 76, borderRadius: 7, overflow: 'hidden', flex: 'none', background: '#F6FAF7' }}
        >
          <img
            src={(kind === 'video' ? c.poster : c.src) || ''}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.55, color: '#3A4A3E', minWidth: 0 }}>
          <b style={LABEL}>{m.field === 'alt' ? 'DESCRIPTION' : 'CAPTION'}</b>
          <br />
          {words ? highlight(words, q) : <Snip html={m.snippet} />}
          {m.field !== 'alt' && (c.alt || c.description) && (
            <div style={{ fontSize: 12, color: '#5B6B60', marginTop: 3 }}>Alt text: {c.alt || c.description}</div>
          )}
        </div>
      </div>
    );
  } else if (kind === 'code' && c.lines?.length) {
    body = (
      <div
        data-testid="search-card-code"
        style={{
          background: '#1E2A22',
          borderRadius: 8,
          padding: '9px 12px',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11.5,
          lineHeight: 1.7,
          color: '#E8F1EA',
          maxWidth: 420,
          overflow: 'hidden',
        }}
      >
        {c.lines.map((l) => (
          <div key={l.n} style={{ whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ color: '#7E9487', marginRight: 12 }}>{l.n}</span>
            {highlight(l.text, q)}
          </div>
        ))}
      </div>
    );
  } else if (kind === 'table' && m.cells?.length) {
    body = (
      <>
        {c.detail && <div style={{ fontSize: 11.5, color: '#5B6B60', marginBottom: 5 }}>{c.detail}</div>}
        <TableRowSnip cells={m.cells} terms={terms} />
      </>
    );
  } else if (kind === 'file') {
    body = (
      <div style={{ fontSize: 13, color: '#3A4A3E' }}>Matched on the file name. Text inside files is not searched.</div>
    );
  } else {
    body = (
      <div style={{ fontSize: 13, lineHeight: 1.55, color: '#3A4A3E' }}>
        {(kind === 'diagram' || kind === 'sketch' || kind === 'canvas') && (
          <>
            <b style={LABEL}>LABELS IN THE {tile.word.toUpperCase()}</b>
            <br />
          </>
        )}
        <Snip html={m.snippet} />
      </div>
    );
  }
  return (
    <div
      data-testid="search-block-card"
      data-kind={kind}
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
      style={{ display: 'flex', gap: 13, padding: '15px 0', borderBottom: '1px solid #EEF3EF', cursor: 'pointer' }}
    >
      <span
        data-testid="search-card-tile"
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          background: tile.bg,
          color: tile.fg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
        }}
      >
        <svg
          width={15}
          height={15}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.9}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {tile.svg}
        </svg>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span data-testid="search-card-name" style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>
            {name}
          </span>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '.04em',
              textTransform: 'uppercase',
              color: '#5B6B60',
            }}
          >
            {tile.word}
          </span>
          <span style={{ flex: 1 }} />
          {on && (
            <span
              style={{ fontSize: 11.5, fontWeight: 600, color: '#5B6B60', fontFamily: "'JetBrains Mono', monospace" }}
            >
              {on}
            </span>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: '#5B6B60',
            marginTop: 2,
            flexWrap: 'wrap',
          }}
        >
          <span>{kind === 'file' ? 'attached to' : 'in'}</span>
          <span style={PAGE_CHIP}>{page.title}</span>
          {detail && <span>· {detail}</span>}
        </div>
        <div style={{ marginTop: 8 }}>{body}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: '#5B6B60', marginTop: 6 }}>
          {page.updatedBy && <Avatar name={page.updatedBy} size={18} />}
          <span>
            {page.updatedBy || 'someone'} · {timeAgo(page.updatedAt)}
          </span>
        </div>
      </div>
    </div>
  );
}
