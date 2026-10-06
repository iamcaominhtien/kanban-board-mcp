import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useDocsPage } from '../../api/docs';
import type { DocsPage } from '../../types/docs';
import { actorInitials, actorName, relativeTime } from '../../utils/relativeTime';
import { slugify } from '../../utils/docsMarkdown';
import { avatarColors } from './docsUi';
import { excerptOf } from './RefChip';
import { Icon } from './Icon';

const footerStyle = { display: 'flex', gap: 8, padding: '10px 16px', borderTop: '1px solid #EEF3EF', background: '#FBFCFB', borderRadius: '0 0 11px 11px', position: 'relative' } as const;
const Bar = () => <span style={{ color: '#C7D2CB' }}>|</span>;

/** The blocks (paragraphs, lists, code) under a heading, as separate strings. */
function sectionBlocks(markdown: string, anchor: string): string[] {
  const lines = markdown.split('\n');
  const want = slugify(anchor);
  let at = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m && slugify(m[2].replace(/[*_`~]/g, '')) === want) {
      at = i;
      level = m[1].length;
      break;
    }
  }
  if (at < 0) return [];
  const body: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) break;
    body.push(lines[i]);
  }
  return body.join('\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
}

function Shell({ children, arrowLeft, flipped }: { children: ReactNode; arrowLeft: number; flipped: boolean }) {
  return (
    <div
      className="docs-root"
      style={{ position: 'relative', boxSizing: 'border-box', border: '1px solid #E3E8E5', borderRadius: 12, background: '#FFFFFF', boxShadow: '0 14px 36px rgba(30,42,34,0.18)', textAlign: 'left', fontWeight: 400 }}
    >
      <div
        style={{
          position: 'absolute', left: arrowLeft, width: 13, height: 13, background: '#FFFFFF', transform: 'rotate(45deg)',
          ...(flipped
            ? { bottom: -8, borderBottom: '1px solid #E3E8E5', borderRight: '1px solid #E3E8E5' }
            : { top: -8, borderTop: '1px solid #E3E8E5', borderLeft: '1px solid #E3E8E5' }),
        }}
      />
      <div style={{ overflow: 'hidden', borderRadius: 12 }}>{children}</div>
    </div>
  );
}

interface CardProps {
  pageId: string;
  anchor: string | null;
  arrowLeft: number;
  flipped: boolean;
  onPeek: () => void;
  onOpenDocs: () => void;
}

/** Page or section hover card on a pill inside a ticket (design: TicketDocRefs B). */
export function TicketPageCard({ pageId, anchor, arrowLeft, flipped, onPeek, onOpenDocs }: CardProps) {
  const { data: page, isError, refetch, isFetching } = useDocsPage(pageId);
  // a card never stays on a spinner: after 4 s the loading card turns into the failed card
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (page) return;
    const t = setTimeout(() => setLate(true), 4000);
    return () => clearTimeout(t);
  }, [page]);
  const footer = (
    <div style={footerStyle}>
      <button type="button" className="st-btn st-btn-primary st-btn-sm" data-testid="card-open-panel" onClick={onPeek}>
        <Icon name="sidePanel" size={14} strokeWidth={1.9} />Open in side panel
      </button>
      <button type="button" className="st-btn st-btn-sm" data-testid="card-open-docs" onClick={onOpenDocs}>
        <Icon name="i38" size={14} strokeWidth={1.9} />Open in Docs
      </button>
    </div>
  );

  if (isError || (!page && late)) {
    return (
      <Shell arrowLeft={arrowLeft} flipped={flipped}>
        <div data-testid="card-failed" style={{ padding: '14px 16px 12px', display: 'flex', gap: 11, alignItems: 'flex-start' }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: '#FEF6E7', color: '#B4791E', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="i14" size={17} strokeWidth={1.8} />
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: '#1E2A22' }}>Couldn't load the preview</span>
            <span style={{ fontSize: 12.5, lineHeight: 1.5, color: '#5B6B60' }}>The link is fine, the preview request failed. Nothing about the page is lost.</span>
          </div>
        </div>
        <div style={footerStyle}>
          <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => { setLate(false); void refetch(); }} disabled={isFetching}>
            <Icon name="refresh" size={14} strokeWidth={1.9} />Retry
          </button>
          <button type="button" className="st-btn st-btn-sm" onClick={onPeek}><Icon name="sidePanel" size={14} strokeWidth={1.9} />Open in side panel</button>
        </div>
      </Shell>
    );
  }
  if (!page) {
    return (
      <Shell arrowLeft={arrowLeft} flipped={flipped}>
        <div data-testid="card-loading" style={{ padding: '14px 16px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="skel" style={{ width: 180, height: 16 }} />
          <div className="skel" style={{ width: 120, height: 11 }} />
          <div className="skel" style={{ width: '100%', height: 11 }} />
          <div className="skel" style={{ width: '85%', height: 11 }} />
          <span style={{ fontSize: 11.5, color: '#9AA8A0' }}>Loading</span>
        </div>
        {footer}
      </Shell>
    );
  }
  return <Loaded page={page} anchor={anchor} arrowLeft={arrowLeft} flipped={flipped} footer={footer} />;
}

function Loaded({ page, anchor, arrowLeft, flipped, footer }: { page: DocsPage; anchor: string | null; arrowLeft: number; flipped: boolean; footer: ReactNode }) {
  const heading = anchor ? page.headings.find((h) => h.slug === slugify(anchor)) : null;
  const blocks = useMemo(() => (heading ? sectionBlocks(page.markdown, heading.text) : []), [page.markdown, heading]);
  const text = useMemo(() => excerptOf(page.markdown, heading ? heading.text : null), [page.markdown, heading]);
  const author = actorName(page.updatedBy);
  const av = avatarColors(author);
  const crumbs = page.path.map((p) => p.title);
  const shownCrumbs = heading ? crumbs : crumbs.length > 1 ? crumbs : crumbs;
  const published = page.status === 'published';
  const when = relativeTime(page.updatedAt);
  const full = new Date(page.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const more = Math.max(0, blocks.length - 1);
  return (
    <Shell arrowLeft={arrowLeft} flipped={flipped}>
      <div data-testid={heading ? 'card-section' : 'card-page'} style={{ padding: '14px 16px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: '#E4F1E8', color: '#2E6F40', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name={heading ? 'hash' : 'page'} size={17} strokeWidth={1.8} />
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span title={heading ? heading.text : page.title} style={{ fontSize: 15, fontWeight: 800, color: '#1E2A22', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{heading ? heading.text : page.title}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#5B6B60', minWidth: 0, flexWrap: 'wrap' }}>
              {(heading ? shownCrumbs : ['Docs', ...shownCrumbs]).map((c, i, a) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: i === a.length - 1 ? 150 : undefined }}>{c}</span>
                  {i < a.length - 1 && <Icon name="chevronRight" size={9} strokeWidth={2.4} style={{ color: '#C7D2CB' }} />}
                </span>
              ))}
            </div>
          </div>
          <span className="mc-chip" style={published ? { background: '#DCEEE1', color: '#1F5A31' } : { background: '#FEF6E7', color: '#7A4F08' }}>
            <span className="mc-dot" style={{ background: published ? '#2E6F40' : '#B4791E' }} />
            {published ? `Published · v${page.version}` : 'Draft'}
          </span>
        </div>
        {heading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '9px 11px', borderLeft: '3px solid #68BA7F', background: '#F6FAF7', borderRadius: '0 8px 8px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: '#2E6F40' }}>
              <Icon name="page" size={12} strokeWidth={1.9} />from {page.title}<span style={{ color: '#68BA7F' }}>›</span><Icon name="hash" size={12} strokeWidth={2} />{heading.text}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: '#3A4A3E', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{text || 'This section is empty.'}</div>
          </div>
        ) : (
          <div style={{ fontSize: 13, lineHeight: 1.55, color: '#3A4A3E', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{text || 'This page has no content yet.'}</div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5B6B60' }}>
          <span title={author} style={{ width: 20, height: 20, borderRadius: '50%', ...av, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{actorInitials(page.updatedBy).slice(0, 2)}</span>
          {author}
          <Bar />
          {heading ? `section edited ${when}` : <>edited {when} <span style={{ color: '#9AA8A0' }}>({full})</span></>}
          {heading && more > 0 && (
            <>
              <Bar />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: '#9AA8A0' }}>+{more} more blocks</span>
            </>
          )}
        </div>
      </div>
      {footer}
    </Shell>
  );
}

/** Card for a pill whose page sits in the Recycle Bin. */
export function TicketDeletedCard({ arrowLeft, flipped, canRestore, onRestore, onOpenBin }: { arrowLeft: number; flipped: boolean; canRestore: boolean; onRestore: () => void; onOpenBin: () => void }) {
  return (
    <Shell arrowLeft={arrowLeft} flipped={flipped}>
      <div data-testid="card-deleted" style={{ padding: '14px 16px 12px', display: 'flex', gap: 11, alignItems: 'flex-start' }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: '#F1F3F1', color: '#5B6B60', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name="i12" size={17} strokeWidth={1.8} />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: '#1E2A22' }}>In Recycle Bin</span>
          <span style={{ fontSize: 12.5, lineHeight: 1.5, color: '#5B6B60' }}>
            The title is kept for 30 days. <b style={{ color: '#1E2A22' }}>Restore</b> brings the page back at the same place and this pill works again.
          </span>
        </div>
      </div>
      <div style={footerStyle}>
        {canRestore && <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={onRestore}><Icon name="refresh" size={14} strokeWidth={1.9} />Restore</button>}
        <button type="button" className="st-btn st-btn-sm" onClick={onOpenBin}><Icon name="i12" size={14} strokeWidth={1.9} />Open Recycle Bin</button>
      </div>
    </Shell>
  );
}
