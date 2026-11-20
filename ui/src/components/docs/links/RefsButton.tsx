/**
 * What links to a page, seen without scrolling (RichDocsLinks F 34-35): the "6 references" button in the page header
 * with its quick list, and the small count on each block of the page that other pages link to.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useBacklinksEx } from '../../../api/docsActions';
import type { BacklinkPageRow } from '../../../types/docsActions';
import { plural } from '../docsShared';
import { usePageSettled } from '../pageSettled';
import { kindWord } from './BlockKind';
import { useDocsLayout } from '../../../hooks/useDocsLayout';

const POP: CSSProperties = {
  position: 'absolute',
  zIndex: 30,
  background: '#FFFFFF',
  border: '1px solid #DCE3DE',
  borderRadius: 12,
  boxShadow: '0 16px 40px rgba(30,42,34,.2)',
  overflow: 'hidden',
  textAlign: 'left',
};

const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 14px',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  color: '#1E2A22',
  textAlign: 'left',
};

const TILE: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 7,
  background: '#F1F6F2',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 14,
  flex: 'none',
  color: '#5B6B60',
};

const PAGE_SVG = (
  <svg
    aria-hidden="true"
    width={12}
    height={12}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.9}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v5h5" />
  </svg>
);

const TICKET_SVG = (
  <svg
    aria-hidden="true"
    width={12}
    height={12}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.9}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="4" y="4" width="16" height="16" rx="3.5" />
    <path d="M8 12l3 3 5-6" />
  </svg>
);

/** "to Limits": where a link lands, when it names a heading or a block. */
function toWhere(p: Pick<BacklinkPageRow, 'targetBlock' | 'targetAnchor'>): string | null {
  if (p.targetBlock?.label) return `to ${p.targetBlock.label}`;
  return p.targetAnchor ? `to ${p.targetAnchor}` : null;
}

/** Scrolls to the Referenced by panel at the end of the page. */
function showAtEnd() {
  document.querySelector('[data-testid="referenced-by"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * The page header's "N references" button and its quick list (F 34). Nothing is shown while nothing links here.
 * @param props.pageId - The page.
 * @param props.onOpenPage - Opens a page that links here, at the block the link sits in.
 * @param props.onOpenTicket - Opens a ticket that links here.
 */
export function RefsButton({
  pageId,
  onOpenPage,
  onOpenTicket,
}: {
  pageId: string;
  onOpenPage: (id: string, anchor?: string) => void;
  onOpenTicket: (id: string) => void;
}) {
  const settled = usePageSettled();
  const q = useBacklinksEx(settled ? pageId : null);
  const [open, setOpen] = useState(false);
  // F 32-33: 44 px on a tablet and a phone; on a phone the list is a bottom sheet
  const layout = useDocsLayout(null);
  const pages = q.data?.pages ?? [];
  const tickets = q.data?.tickets ?? [];
  const total = pages.length + tickets.length;
  useEffect(() => setOpen(false), [pageId]);
  if (!total) return null;
  const pageSources = new Set(pages.map((p) => p.pageId)).size;
  const ticketSources = new Set(tickets.map((t) => t.ticketId)).size;
  const by = [pageSources ? plural(pageSources, 'page') : '', ticketSources ? plural(ticketSources, 'ticket') : '']
    .filter(Boolean)
    .join(' and ');
  return (
    <div data-popover style={{ position: 'relative' }}>
      <button
        type="button"
        data-testid="refs-button"
        className="refs-btn"
        data-layout={layout}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 32,
          padding: '0 11px',
          border: '1px solid #2E6F40',
          background: '#E3F1E7',
          borderRadius: 8,
          fontSize: 12.5,
          fontWeight: 700,
          color: '#1F5A31',
          cursor: 'pointer',
          fontFamily: 'inherit',
          whiteSpace: 'nowrap',
          boxSizing: 'border-box',
        }}
      >
        {plural(total, 'reference')}
      </button>
      {open && layout === 'phone' && (
        <div className="refs-sheet-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
      )}
      {open && (
        <div
          data-testid="refs-popover"
          className={layout === 'phone' ? 'refs-sheet' : undefined}
          role={layout === 'phone' ? 'dialog' : undefined}
          aria-label={layout === 'phone' ? 'Referenced by' : undefined}
          style={layout === 'phone' ? undefined : { ...POP, right: 0, top: 'calc(100% + 4px)', width: 340 }}
        >
          {layout === 'phone' ? (
            <>
              <div className="refs-sheet-grab" aria-hidden="true" />
              <div className="refs-sheet-head">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="refs-sheet-title">Referenced by</div>
                  <div className="refs-sheet-sub">
                    {plural(total, 'reference')} from {by}
                  </div>
                </div>
                <button type="button" className="qo-back" aria-label="Close" onClick={() => setOpen(false)}>
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            </>
          ) : (
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #E3E8E5', fontSize: 13, fontWeight: 700 }}>
              Referenced by {by}
            </div>
          )}
          <div style={layout === 'phone' ? undefined : { maxHeight: 320, overflowY: 'auto' }}>
            {pages.map((p, i) => (
              <button
                key={`p${i}`}
                type="button"
                className="refs-row"
                style={ROW}
                data-testid="refs-row"
                onClick={() => {
                  setOpen(false);
                  onOpenPage(p.pageId, p.sourceBlockId ?? p.anchor ?? undefined);
                }}
              >
                <span style={TILE}>{PAGE_SVG}</span>
                <span style={{ flex: 1, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.title}
                </span>
                {toWhere(p) && <span style={{ fontSize: 11.5, color: '#5B6B60', flex: 'none' }}>{toWhere(p)}</span>}
              </button>
            ))}
            {tickets.map((t, i) => (
              <button
                key={`t${i}`}
                type="button"
                className="refs-row"
                style={ROW}
                data-testid="refs-row"
                onClick={() => {
                  setOpen(false);
                  onOpenTicket(t.ticketId);
                }}
              >
                <span style={{ ...TILE, background: '#E3EFFA', color: '#2F6FB0' }}>{TICKET_SVG}</span>
                <span style={{ flex: 1, fontWeight: 600 }}>{t.ticketId}</span>
                {t.targetAnchor && (
                  <span style={{ fontSize: 11.5, color: '#5B6B60', flex: 'none' }}>to {t.targetAnchor}</span>
                )}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              showAtEnd();
            }}
            style={{
              ...ROW,
              display: 'block',
              padding: '10px 14px',
              borderTop: '1px solid #E3E8E5',
              fontSize: 12.5,
              fontWeight: 700,
              color: '#2E6F40',
              background: '#FBFCFB',
            }}
          >
            Show with sentences at the end of the page
          </button>
        </div>
      )}
    </div>
  );
}

interface Badge {
  blockId: string;
  top: number;
  left: number;
  rows: BacklinkPageRow[];
  kind: string;
}

/**
 * The count on each block of the page that other pages link to (F 35): a 24 px dark green pill over the block's top
 * right corner; clicking it lists the places, with the sentence, and opens one.
 * @param props.root - The page body the blocks are in (positioned; the pills are placed in it).
 * @param props.pageId - The page.
 * @param props.revision - Changes when the page's content does (the pills are placed again).
 * @param props.onOpenPage - Opens a page that links here, at the block the link sits in.
 */
export function BlockRefBadges({
  root,
  pageId,
  revision,
  onOpenPage,
}: {
  root: HTMLElement | null;
  pageId: string;
  revision: string;
  onOpenPage: (id: string, anchor?: string) => void;
}) {
  const settled = usePageSettled();
  const q = useBacklinksEx(settled ? pageId : null);
  const [badges, setBadges] = useState<Badge[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const frame = useRef(0);

  const measure = useCallback(() => {
    if (!root) return;
    const byBlock = new Map<string, BacklinkPageRow[]>();
    for (const p of q.data?.pages ?? []) {
      const id = p.targetBlock?.blockId;
      if (!id || p.targetBlock?.kind === 'heading') continue;
      byBlock.set(id, [...(byBlock.get(id) ?? []), p]);
    }
    const base = root.getBoundingClientRect();
    const next: Badge[] = [];
    byBlock.forEach((rows, blockId) => {
      const el = root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      next.push({
        blockId,
        rows,
        kind: rows[0].targetBlock?.kind ?? 'text',
        top: Math.round(r.top - base.top) - 12,
        left: Math.round(r.right - base.left) - 12,
      });
    });
    setBadges(next);
  }, [root, q.data]);

  useLayoutEffect(() => {
    measure();
  }, [measure, revision]);
  useEffect(() => {
    if (!root) return;
    const schedule = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(measure);
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(root);
    const mo = new MutationObserver(schedule);
    mo.observe(root, { attributes: true, subtree: true, attributeFilter: ['data-rendering'] });
    return () => {
      ro?.disconnect();
      mo.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [root, measure]);

  if (!badges.length) return null;
  return (
    <>
      {badges.map((b) => {
        const sources = new Set(b.rows.map((r) => r.pageId)).size;
        return (
          <div key={b.blockId} style={{ position: 'absolute', top: b.top, left: b.left, zIndex: 3 }} data-popover>
            <button
              type="button"
              className="dk-block-refs"
              style={{ position: 'static', transform: 'translateX(-100%)' }}
              data-testid="block-refs"
              aria-label={`${plural(b.rows.length, 'place')} link to this ${kindWord(b.kind)}`}
              aria-expanded={openId === b.blockId}
              onClick={() => setOpenId((v) => (v === b.blockId ? null : b.blockId))}
            >
              <svg
                aria-hidden="true"
                width={11}
                height={11}
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fff"
                strokeWidth={2.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 5l-5 5 5 5" />
                <path d="M4 10h9a6 6 0 0 1 6 6v3" />
              </svg>
              {sources}
            </button>
            {openId === b.blockId && (
              <div data-testid="block-refs-popover" style={{ ...POP, right: -12, top: 34, width: 300 }}>
                <div
                  style={{ padding: '9px 14px', borderBottom: '1px solid #E3E8E5', fontSize: 12.5, fontWeight: 700 }}
                >
                  {sources === 1 ? '1 place links' : `${sources} places link`} to this {kindWord(b.kind)}
                </div>
                {b.rows.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      setOpenId(null);
                      onOpenPage(r.pageId, r.sourceBlockId ?? undefined);
                    }}
                    style={{ ...ROW, display: 'block', padding: '9px 14px', borderBottom: '1px solid #EEF3EF' }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{r.title}</div>
                    {(r.excerpt || r.context) && (
                      <div style={{ fontSize: 12, color: '#5B6B60', marginTop: 2, fontWeight: 400 }}>
                        “
                        {(r.excerpt || r.context || '').replace(
                          /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g,
                          (_m, t, s, l) => l ?? s ?? t,
                        )}
                        ”
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
