import { Fragment, useState, type ReactNode } from 'react';
import { useDocsPage } from '../../api/docs';
import { useBacklinksEx } from '../../api/docsActions';
import { useToast } from '../Toast';
import { Icon } from './Icon';
import { plural } from './docsShared';
import { pageUrl } from './SharePopover';

interface ReferencedByProps {
  pageId: string;
  onOpenPage: (id: string, anchor?: string) => void;
  onOpenTicket: (id: string) => void;
}

function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[`'"“”‘’.,:;!?()[\]{}<>*_~]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
}

const REF = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

/** A sentence with `[[Page#Section|label]]` references turned into chips. */
function Sentence({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  REF.lastIndex = 0;
  while ((m = REF.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const [, title, section, label] = m;
    parts.push(
      <span key={m.index} className="dk-chip dk-chip-page">
        <Icon name="i00" size={13} />
        {label ? <span style={{ borderBottom: '1px dotted #68BA7F' }}>{label}</span> : title.trim()}
        {!label && section && (
          <>
            <span style={{ color: '#68BA7F', fontWeight: 500 }}>›</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <Icon name="i04" size={11} strokeWidth={2.2} />
              {section.trim()}
            </span>
          </>
        )}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
}

function statusDot(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('done')) return '#2E6F40';
  if (s.includes('progress') || s.includes('review') || s.includes('testing')) return '#2F6FB0';
  return '#9AA8A0';
}

const groupLabel: React.CSSProperties = {
  padding: '0 10px 4px',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: '#5B6B60',
};
const rowBox: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, padding: '9px 10px', borderRadius: 8 };
const rowHead: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: '#1E2A22' };
const goLink: React.CSSProperties = {
  marginLeft: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
  fontWeight: 600,
  color: '#2E6F40',
  whiteSpace: 'nowrap',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  padding: 0,
};
const ctxBox: React.CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.6,
  color: '#5B6B60',
  padding: '4px 10px',
  borderLeft: '2px solid #DCE6DF',
  marginLeft: 2,
};

export function ReferencedBy({ pageId, onOpenPage, onOpenTicket }: ReferencedByProps) {
  const toast = useToast();
  const backlinks = useBacklinksEx(pageId);
  const page = useDocsPage(pageId);
  const [open, setOpen] = useState(true);
  const pages = backlinks.data?.pages ?? [];
  const tickets = backlinks.data?.tickets ?? [];
  const total = pages.length + tickets.length;

  async function copy(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(message);
    } catch {
      toast.error("Couldn't copy to the clipboard");
    }
  }

  const summary =
    total === 0
      ? '0 references'
      : `${plural(total, 'reference')} from ${[pages.length ? plural(pages.length, 'page') : '', tickets.length ? plural(tickets.length, 'ticket') : ''].filter(Boolean).join(' and ')}`;

  return (
    <section
      className="docs-root"
      aria-label="Referenced by"
      data-testid="referenced-by"
      style={{
        boxSizing: 'border-box',
        border: '1px solid #E3E8E5',
        borderRadius: 12,
        background: '#FFFFFF',
        padding: total === 0 ? '20px 22px' : '20px 22px 14px',
        boxShadow: '0 10px 28px rgba(30,42,34,0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: total === 0 ? 12 : 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>
        <Icon name="i11" size={15} />
        Referenced by
        <span style={{ fontSize: 12, fontWeight: 500, color: '#9AA8A0' }}>{backlinks.isLoading ? '' : summary}</span>
        {total > 0 && (
          <button
            type="button"
            className="dk-icobtn"
            aria-label={open ? 'Collapse' : 'Expand'}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            style={{ marginLeft: 'auto' }}
          >
            <Icon name={open ? 'i34' : 'i06'} size={14} strokeWidth={2.2} />
          </button>
        )}
      </div>

      {total === 0 && !backlinks.isLoading && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            padding: '26px 20px 24px',
            border: '1px dashed #C7D2CB',
            borderRadius: 10,
            background: '#FBFCFB',
            textAlign: 'center',
          }}
        >
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#EEF3EF', color: '#7A8A80', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="i11" size={18} strokeWidth={1.8} />
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>Nothing links here yet</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: '#5B6B60', maxWidth: 360 }}>
            Link this page from another page with{' '}
            <span style={{ whiteSpace: 'nowrap' }}>
              <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5, background: '#F6FAF7', padding: '1px 5px', borderRadius: 3, color: '#2E6F40' }}>
                [[{page.data?.title ?? 'Meeting notes'}]]
              </code>
            </span>
            , or from a ticket description, and it will show up here.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button type="button" className="st-btn st-btn-sm" onClick={() => void copy(pageUrl(pageId), 'Link copied')}>
              <Icon name="i24" size={14} />
              Copy link
            </button>
            <button
              type="button"
              className="st-btn st-btn-sm"
              onClick={() => void copy(`[[${page.data?.title ?? ''}]]`, 'Reference copied')}
            >
              <Icon name="i11" size={14} />
              Copy [[reference]]
            </button>
          </div>
        </div>
      )}

      {total > 0 && open && (
        <>
          {pages.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={groupLabel}>Pages · {pages.length}</div>
              {pages.map((p, i) => {
                const section = p.section ?? p.in;
                const anchor = p.anchor ?? (section ? slugify(section) : undefined);
                return (
                  <div key={`${p.pageId}-${i}`} style={rowBox}>
                    <div style={rowHead}>
                      <span style={{ display: 'flex', color: '#2E6F40' }}>
                        <Icon name="i00" size={16} strokeWidth={1.8} />
                      </span>
                      {p.title}
                      {p.in && <span style={{ fontSize: 11.5, fontWeight: 500, color: '#9AA8A0' }}>{p.in}</span>}
                      <button type="button" style={goLink} onClick={() => onOpenPage(p.pageId, anchor)}>
                        {anchor ? 'Go to section' : 'Open page'}
                        <Icon name="i29" size={12} strokeWidth={2.2} />
                      </button>
                    </div>
                    <div style={ctxBox}>
                      <Sentence text={p.context ?? p.snippet} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {tickets.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={groupLabel}>Tickets · {tickets.length}</div>
              {tickets.map((t) => {
                const text = t.context ?? t.snippet ?? '';
                const where = t.origin === 'comment' ? 'in comment' : t.origin === 'description' ? 'in description' : '';
                return (
                  <div key={t.ticketId} style={rowBox}>
                    <div style={rowHead}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusDot(t.status), flexShrink: 0, display: 'inline-block' }} />
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#5B6B60' }}>{t.ticketId}</span>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                      {where && (
                        <span style={{ fontSize: 11.5, fontWeight: 500, color: '#5B6B60', padding: '1px 7px', borderRadius: 999, background: '#F1F3F1', whiteSpace: 'nowrap' }}>
                          {where}
                        </span>
                      )}
                      <button type="button" style={goLink} onClick={() => onOpenTicket(t.ticketId)}>
                        Open ticket
                        <Icon name="i29" size={12} strokeWidth={2.2} />
                      </button>
                    </div>
                    {text && (
                      <div style={ctxBox}>
                        <Sentence text={text} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
