import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDocsPage } from '../../api/docs';
import { useRestorePage, useTicketDocs } from '../../api/docs';
import type { TicketDocRow } from '../../types/docsActions';
import { slugify } from '../../utils/docsMarkdown';
import { actorInitials, actorName, relativeTime } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { avatarColors } from './docsUi';
import { DocsMarkdown } from './DocsMarkdown';
import { closestHeading, RefChip } from './RefChip';
import { Icon } from './Icon';
import type { PeekHint } from './DocsRefsContext';

export interface PeekTarget {
  pageId: string;
  anchor: string | null;
  hint?: PeekHint;
}

interface Props {
  target: PeekTarget;
  projectId: string;
  ticketId?: string;
  onSwitch: (t: PeekTarget) => void;
  onClose: () => void;
  onOpenInDocs: (pageId: string, anchor?: string | null) => void;
  onOpenTicket: (ticketId: string) => void;
}

const ORIGIN_WORDS: Record<string, string> = {
  description: 'description',
  comment: 'comment',
  acceptance_criterion: 'criterion',
  test_case: 'test case',
  debug_note: 'debug note',
  manual: 'manual link',
};

/** The 480px read-only preview that slides over the ticket modal when a pill is clicked. */
export function DocPeekPanel({ target, projectId, ticketId, onSwitch, onClose, onOpenInDocs, onOpenTicket }: Props) {
  const toast = useToast();
  const { data: page, isLoading, isError, refetch } = useDocsPage(target.hint?.deleted ? null : target.pageId);
  const strip = useTicketDocs(ticketId ?? '');
  const restore = useRestorePage(projectId);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Esc closes the panel first (a second Esc closes the ticket): capture before the modal sees it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  useEffect(() => closeRef.current?.focus(), [target.pageId]);

  const slug = target.anchor ? slugify(target.anchor) : null;
  const heading = page && slug ? page.headings.find((h) => h.slug === slug) : null;
  const sectionMissing = !!(page && slug && !heading);
  const closest = page && sectionMissing ? closestHeading(page.headings, target.anchor ?? '') : null;
  const [forcedTop, setForcedTop] = useState(false);
  useEffect(() => setForcedTop(false), [target.pageId, target.anchor]);

  // Scroll to the referenced section and tint it: wrap the heading and what follows up to the next heading.
  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !page || !heading || forcedTop) return;
    const h = root.querySelector<HTMLElement>(`#docs-${CSS.escape(heading.slug)}`);
    if (!h) return;
    const wrap = document.createElement('div');
    wrap.dataset.testid = 'peek-highlight';
    wrap.setAttribute('data-testid', 'peek-highlight');
    wrap.style.cssText =
      'position:relative;margin:0 -10px;padding:2px 10px 6px;border-radius:8px;background:rgba(232,185,58,0.16);box-shadow:inset 3px 0 0 #E8B93A;';
    const level = heading.level;
    h.parentNode?.insertBefore(wrap, h);
    let n: ChildNode | null = h;
    while (n) {
      const next: ChildNode | null = n.nextSibling;
      if (n !== h && n instanceof HTMLElement && /^H[1-6]$/.test(n.tagName) && Number(n.tagName[1]) <= level) break;
      wrap.appendChild(n);
      n = next;
    }
    wrap.scrollIntoView({ block: 'start' });
    return () => {
      // React owns these nodes: put them back before it re-renders or unmounts.
      while (wrap.firstChild) wrap.parentNode?.insertBefore(wrap.firstChild, wrap);
      wrap.remove();
    };
  }, [page, heading, forcedTop]);

  const rows = useMemo(() => {
    const out = new Map<string, { pageId: string; title: string; section: string | null; origins: string[] }>();
    for (const d of (strip.data ?? []) as unknown as TicketDocRow[]) {
      if (d.origin === 'page' || d.origin === 'manual') continue;
      const key = `${d.pageId}#${d.section ?? ''}`;
      const row = out.get(key) ?? { pageId: d.pageId, title: d.title, section: d.section ?? null, origins: [] };
      const word = d.origin === 'test_case' && d.detail ? d.detail : (ORIGIN_WORDS[d.origin ?? ''] ?? String(d.origin));
      if (!row.origins.includes(word)) row.origins.push(word);
      out.set(key, row);
    }
    return [...out.values()];
  }, [strip.data]);

  const author = page ? actorName(page.updatedBy) : '';
  const av = avatarColors(author);
  const crumbs = page ? page.path.map((p) => p.title) : [];
  const deleted = !!target.hint?.deleted;
  const failed = !deleted && isError;
  const title = page?.title ?? target.hint?.title ?? 'Doc';
  const shareLink = () => {
    const url = `${window.location.origin}${window.location.pathname}?docs=${target.pageId}${slug ? `#${slug}` : ''}`;
    void navigator.clipboard?.writeText(url);
    toast.success('Link copied');
  };

  return createPortal(
    <div className="docs-root" data-testid="peek-root">
      <div
        data-testid="peek-scrim"
        onMouseDown={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{ position: 'fixed', inset: 0, background: 'rgba(30,42,34,0.28)', zIndex: 1400 }}
      />
      <aside
        role="complementary"
        aria-label="Doc preview"
        data-testid="peek-panel"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(480px, 100vw)',
          zIndex: 1401,
          boxSizing: 'border-box',
          background: '#FFFFFF',
          border: '1px solid #E3E8E5',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '-18px 0 44px rgba(30,42,34,0.22)',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: '14px 18px',
            borderBottom: '1px solid #E3E8E5',
            background: '#FFFFFF',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
              {loadingHeader(
                isLoading && !deleted,
                crumbs,
                title,
                heading?.text ?? (sectionMissing ? target.anchor : null),
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <button
                type="button"
                className="st-btn st-btn-primary st-btn-sm"
                disabled={!page && !deleted}
                data-testid="peek-open-docs"
                onClick={() => onOpenInDocs(target.pageId, heading ? heading.slug : null)}
              >
                <Icon name="i38" size={14} strokeWidth={1.9} />
                Open in Docs
              </button>
              <button type="button" className="dk-icobtn" aria-label="Copy link" title="Copy link" onClick={shareLink}>
                <Icon name="link" size={15} strokeWidth={1.9} />
              </button>
              <button
                ref={closeRef}
                type="button"
                className="dk-icobtn"
                aria-label="Close panel"
                title="Close (Esc)"
                data-testid="peek-close"
                onClick={onClose}
              >
                <Icon name="close" size={15} strokeWidth={2} />
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: 21,
                fontWeight: 800,
                color: '#1E2A22',
                textDecoration: deleted ? 'line-through' : undefined,
              }}
            >
              {isLoading && !deleted ? (
                <span className="skel" style={{ display: 'inline-block', width: 180, height: 22 }} />
              ) : (
                title
              )}
            </span>
            {page && (
              <span
                className="mc-chip"
                style={
                  page.status === 'published'
                    ? { background: '#DCEEE1', color: '#1F5A31' }
                    : { background: '#FEF6E7', color: '#7A4F08' }
                }
              >
                <span className="mc-dot" style={{ background: page.status === 'published' ? '#2E6F40' : '#B4791E' }} />
                {page.status === 'published' ? `Published · v${page.version}` : 'Draft'}
              </span>
            )}
            {deleted && (
              <span className="mc-chip" style={{ background: '#F1F3F1', color: '#5B6B60' }}>
                Deleted
              </span>
            )}
          </div>
          {page && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5B6B60' }}>
              <span
                title={author}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  ...av,
                  fontSize: 11,
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {actorInitials(page.updatedBy).slice(0, 2)}
              </span>
              Edited by {author}
              <span style={{ color: '#C7D2CB' }}>|</span>
              {relativeTime(page.updatedAt)}
              <span style={{ color: '#C7D2CB' }}>|</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#7A4F08' }}>
                <Icon name="eye" size={13} strokeWidth={1.8} />
                Read-only
              </span>
            </div>
          )}
        </div>

        <div
          ref={bodyRef}
          data-testid="peek-body"
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 18px 24px', position: 'relative' }}
        >
          {deleted ? (
            <div
              data-testid="peek-deleted"
              style={{
                border: '1px solid #E3E8E5',
                borderRadius: 10,
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                background: '#FBFCFB',
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 800, color: '#1E2A22' }}>This page is in the Recycle Bin</div>
              <div style={{ fontSize: 13, lineHeight: 1.55, color: '#5B6B60' }}>
                Deleted pages are kept for 30 days. Restoring it brings back every reference to it, including this one.
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  className="st-btn st-btn-primary st-btn-sm"
                  disabled={restore.isPending}
                  onClick={() =>
                    restore.mutate(target.pageId, {
                      onSuccess: () => {
                        toast.success('Page restored');
                        onSwitch({ pageId: target.pageId, anchor: target.anchor });
                      },
                    })
                  }
                >
                  Restore page
                </button>
              </div>
            </div>
          ) : failed ? (
            <div data-testid="peek-failed" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: '#1E2A22' }}>Couldn’t load this page</div>
              <div style={{ fontSize: 13, color: '#5B6B60' }}>The link is fine, the request failed.</div>
              <div>
                <button type="button" className="st-btn st-btn-sm" onClick={() => void refetch()}>
                  <Icon name="refresh" size={13} />
                  Retry
                </button>
              </div>
            </div>
          ) : isLoading || !page ? (
            <div data-testid="peek-loading" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="skel" style={{ width: '60%', height: 20 }} />
              <div className="skel" style={{ width: '100%', height: 12 }} />
              <div className="skel" style={{ width: '92%', height: 12 }} />
              <div className="skel" style={{ width: '80%', height: 12 }} />
            </div>
          ) : (
            <>
              {sectionMissing && !forcedTop && (
                <div
                  data-testid="peek-section-missing"
                  style={{
                    background: '#FEF6E7',
                    border: '1px solid #F0DBA8',
                    borderRadius: 8,
                    padding: '10px 12px',
                    marginBottom: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    color: '#7A4F08',
                  }}
                >
                  <div>
                    Section <b>{target.anchor}</b> was renamed or removed.
                    {closest ? (
                      <>
                        {' '}
                        Closest match: <b>{closest.text}</b>.
                      </>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {closest && (
                      <button
                        type="button"
                        className="st-btn st-btn-primary st-btn-sm"
                        onClick={() => onSwitch({ pageId: target.pageId, anchor: closest.text })}
                      >
                        Go to “{closest.text}”
                      </button>
                    )}
                    <button type="button" className="st-btn st-btn-sm" onClick={() => setForcedTop(true)}>
                      Show page top
                    </button>
                  </div>
                </div>
              )}
              <div className="dk-md" style={{ fontSize: 13.5 }}>
                <DocsMarkdown
                  projectId={projectId}
                  onOpenPage={(id, a) => onSwitch({ pageId: id, anchor: a ?? null })}
                  onOpenTicket={onOpenTicket}
                >
                  {page.markdown}
                </DocsMarkdown>
              </div>
            </>
          )}
        </div>

        {rows.length > 0 && (
          <div
            data-testid="peek-strip"
            style={{
              borderTop: '1px solid #E3E8E5',
              background: '#FBFCFB',
              padding: '10px 12px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              maxHeight: 220,
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 6px 4px' }}>
              <Icon name="link" size={13} strokeWidth={1.8} style={{ color: '#9AA8A0' }} />
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: '#5B6B60',
                }}
              >
                Referenced from this ticket
              </span>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: '#9AA8A0' }}>{rows.length}</span>
            </div>
            {rows.map((r) => {
              const on = r.pageId === target.pageId && (r.section ? slugify(r.section) === (slug ?? '') : !slug);
              return (
                <div
                  key={`${r.pageId}#${r.section}`}
                  role="button"
                  tabIndex={0}
                  data-testid="peek-strip-row"
                  onClick={() => onSwitch({ pageId: r.pageId, anchor: r.section })}
                  onKeyDown={(e) => e.key === 'Enter' && onSwitch({ pageId: r.pageId, anchor: r.section })}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '5px 10px',
                    borderRadius: 7,
                    cursor: 'pointer',
                    background: on ? '#F1F8F3' : undefined,
                    boxShadow: on ? 'inset 0 0 1px 1px #D7E8DC' : undefined,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
                    <RefChip
                      kind="page"
                      label={r.section ? `${r.title} › ${r.section}` : r.title}
                      pageTitle={r.title}
                      anchor={r.section}
                      projectId={projectId}
                      result={
                        {
                          status: 'ok',
                          pageId: r.pageId,
                          anchor: r.section ?? undefined,
                          section: r.section ?? undefined,
                        } as never
                      }
                      staticPill
                    />
                  </div>
                  <span
                    style={{ fontSize: 11.5, color: '#5B6B60', whiteSpace: 'nowrap', width: 130, textAlign: 'right' }}
                  >
                    {r.origins.join(', ')}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#2E6F40', width: 52, textAlign: 'right' }}>
                    {on ? 'Viewing' : ''}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </aside>
    </div>,
    document.body,
  );
}

function loadingHeader(loading: boolean, crumbs: string[], title: string, section: string | null | undefined) {
  if (loading) return <span className="skel" style={{ display: 'inline-block', width: 180, height: 14 }} />;
  const all = crumbs.length ? crumbs : [title];
  return (
    <>
      <Icon name="folder" size={13} strokeWidth={1.8} style={{ color: '#9AA8A0' }} />
      {all.map((c, i) => {
        const last = i === all.length - 1 && !section;
        return (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span
              style={{
                fontSize: 12.5,
                fontWeight: last ? 700 : 500,
                color: last ? '#1E2A22' : '#5B6B60',
                whiteSpace: 'nowrap',
              }}
            >
              {c}
            </span>
            {(i < all.length - 1 || section) && (
              <Icon name="chevronRight" size={10} strokeWidth={2.4} style={{ color: '#C7D2CB' }} />
            )}
          </span>
        );
      })}
      {section && (
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: '#2E6F40',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            whiteSpace: 'nowrap',
          }}
        >
          <Icon name="hash" size={12} strokeWidth={2.2} /> {section}
        </span>
      )}
    </>
  );
}
