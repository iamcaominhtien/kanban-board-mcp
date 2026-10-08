import { useEffect, useMemo, useRef, useState } from 'react';
import './docs.css';
import { Icon } from './Icon';
import { useDocsSearch } from '../../api/docsFx';
import { docsErrorDetail, useDocsTree } from '../../api/docs';
import { useDocsOnline, searchDocsCache } from './useDocsOffline';
import { Avatar, Snip, StatusDot, TICKET_KEY, ancestors, highlight, sectionLabelStyle, timeAgo } from './searchShared';
import type { DocsSearchPage, DocsSearchParams, DocsSearchResponse } from '../../types/docsFx';

export interface SearchResultsProps {
  projectId: string;
  projectName: string;
  initialQuery: string;
  onOpenPage: (id: string, anchor?: string) => void;
  onOpenTicket: (id: string) => void;
  onBack: () => void;
}

type Edited = 'any' | 'day' | 'week' | 'month' | 'custom';
const EDITED: { id: Edited; label: string }[] = [
  { id: 'any', label: 'Any time' },
  { id: 'day', label: 'Past 24 hours' },
  { id: 'week', label: 'Past 7 days' },
  { id: 'month', label: 'Past 30 days' },
  { id: 'custom', label: 'Custom range…' },
];
const DAYS: Record<string, number> = { day: 1, week: 7, month: 30 };
const PAGE_SIZE = 10;

const monoCount = (n: number | undefined) =>
  n === undefined ? null : (
    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#9AA8A0' }}>{n}</span>
  );

const filterSection = (title: string, children: React.ReactNode, last = false) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      paddingBottom: 14,
      marginBottom: 14,
      borderBottom: last ? 'none' : '1px solid #EEF3EF',
    }}
  >
    <div style={{ ...sectionLabelStyle, paddingBottom: 4 }}>{title}</div>
    {children}
  </div>
);

function Check({
  on,
  onChange,
  children,
  count,
}: {
  on: boolean;
  onChange: () => void;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <div
      role="checkbox"
      aria-checked={on}
      tabIndex={0}
      onClick={onChange}
      onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), onChange())}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '4px 0',
        fontSize: 13,
        color: '#1E2A22',
        fontWeight: 500,
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          border: on ? 'none' : '1.5px solid #C7D2CB',
          background: on ? '#2E6F40' : '#FFFFFF',
          boxSizing: 'border-box',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {on && <Icon name="i10" size={11} strokeWidth={2.6} style={{ color: '#FFFFFF' }} />}
      </span>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 8 }}>
        {children}
      </span>
      {monoCount(count)}
    </div>
  );
}

function Radio({
  on,
  onChange,
  children,
  count,
}: {
  on: boolean;
  onChange: () => void;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <div
      role="radio"
      aria-checked={on}
      tabIndex={0}
      onClick={onChange}
      onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), onChange())}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '4px 0',
        fontSize: 13,
        color: '#1E2A22',
        fontWeight: 500,
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          border: `1.5px solid ${on ? '#2E6F40' : '#C7D2CB'}`,
          background: '#FFFFFF',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          boxSizing: 'border-box',
        }}
      >
        {on && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#2E6F40' }} />}
      </span>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap' }}>{children}</span>
      {monoCount(count)}
    </div>
  );
}

/** Full-page results (design: DocsSearch.dc.html artboard C). Renders the content area next to the page tree. */
export function SearchResults({
  projectId,
  projectName,
  initialQuery,
  onOpenPage,
  onOpenTicket,
  onBack,
}: SearchResultsProps) {
  const online = useDocsOnline();
  const [input, setInput] = useState(initialQuery);
  const [q, setQ] = useState(initialQuery);
  const [scope, setScope] = useState<'space' | 'all' | 'tickets'>('space');
  const [sort, setSort] = useState<'relevance' | 'edited_at'>('relevance');
  const [authors, setAuthors] = useState<string[]>([]);
  const [edited, setEdited] = useState<Edited>('month');
  const [customFrom, setCustomFrom] = useState('');
  const [under, setUnder] = useState('');
  const [hasTickets, setHasTickets] = useState(false);
  const [status, setStatus] = useState<{ published: boolean; draft: boolean }>({ published: true, draft: true });
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [within, setWithin] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [ticketsOpen, setTicketsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tree = useDocsTree(projectId);
  const nodes = tree.data ?? [];

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.activeElement?.tagName !== 'SELECT') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);
  useEffect(() => setLimit(PAGE_SIZE), [q, scope, sort, authors, edited, customFrom, under, hasTickets, status]);

  const editedSince = useMemo(() => {
    if (edited === 'any') return null;
    if (edited === 'custom') return customFrom ? new Date(customFrom).toISOString() : null;
    return new Date(Date.now() - DAYS[edited] * 86400_000).toISOString();
  }, [edited, customFrom]);

  const params: DocsSearchParams = {
    q,
    scope: scope === 'tickets' ? 'tickets' : scope,
    mode: q.trim().startsWith('#') ? 'headings' : undefined,
    limit,
    sort,
    author: authors,
    editedSince,
    underPage: under || null,
    hasTickets,
    status: [status.published && 'published', status.draft && 'draft'].filter(
      (x): x is string => !!x && !(status.published && status.draft),
    ),
  };
  if (params.mode) params.q = q.trim().slice(1);
  const res = useDocsSearch(projectId, params, { enabled: online && q.trim().length > 0, keepPrevious: true });
  const netError = res.isError && !(res.error as { response?: unknown })?.response;
  const offlineData: DocsSearchResponse | null = useMemo(
    () => ((!online || netError) && q.trim() ? searchDocsCache(projectId, q, { projectName }) : null),
    [online, netError, projectId, q, projectName],
  );
  const data = offlineData ?? res.data;
  const loading = res.isFetching && !res.data;
  const failed = res.isError && !netError;

  const shown = useMemo(() => {
    const pages = data?.pages ?? [];
    const w = within.trim().toLowerCase();
    return w
      ? pages.filter((p) =>
          (p.title + ' ' + p.matches.map((m) => m.section + ' ' + m.snippet).join(' ')).toLowerCase().includes(w),
        )
      : pages;
  }, [data, within]);

  const total = data?.total ?? 0;
  const matchCount = data?.matchCount ?? (data?.pages ?? []).reduce((n, p) => n + Math.max(1, p.matches.length), 0);
  const submit = () => {
    setQ(input.trim());
  };
  const clearAll = () => {
    setAuthors([]);
    setEdited('any');
    setUnder('');
    setHasTickets(false);
    setStatus({ published: true, draft: true });
    setWithin('');
  };
  const f = data?.facets;
  const ticketMode = scope === 'tickets' || TICKET_KEY.test(q.trim());
  const underNode = nodes.find((n) => n.id === under);
  const depthOf = (id: string) => {
    let d = 0;
    let cur = nodes.find((n) => n.id === id);
    while (cur?.parentId) {
      d += 1;
      cur = nodes.find((n) => n.id === cur!.parentId);
    }
    return d;
  };

  const card = (p: DocsSearchPage) => {
    const secs = p.matches;
    const open = expanded[p.pageId];
    const visible = open ? secs : secs.slice(0, 3);
    const anc = ancestors(p);
    const crumb = [scope === 'all' ? p.projectName : projectName, ...anc];
    const nm = Math.max(secs.length, 1);
    return (
      <div
        key={p.pageId}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '16px 0',
          borderBottom: '1px solid #EEF3EF',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ display: 'flex', color: '#2E6F40' }}>
            <Icon name="i00" size={18} strokeWidth={1.8} />
          </span>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onOpenPage(p.pageId);
            }}
            style={{ fontSize: 16, fontWeight: 700, color: '#1E2A22', textDecoration: 'none' }}
          >
            {highlight(p.title, q)}
          </a>
          {p.status === 'draft' && (
            <span className="mc-chip" style={{ background: '#FCEFD9', color: '#7A4F08' }}>
              <span className="mc-dot" style={{ background: '#B4791E' }} />
              Draft
            </span>
          )}
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: '#9AA8A0' }}>
            {nm} {nm === 1 ? 'match' : 'matches'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 27 }}>
          <Icon name="i07" size={12} strokeWidth={1.9} style={{ color: '#9AA8A0' }} />
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
              color: '#5B6B60',
              flexWrap: 'nowrap',
            }}
          >
            {crumb.map((c, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {i > 0 && <Icon name="i05" size={10} strokeWidth={2.4} style={{ color: '#C7D2CB' }} />}
                <span style={{ whiteSpace: 'nowrap' }}>{c}</span>
              </span>
            ))}
          </span>
        </div>
        {visible.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9, paddingLeft: 27 }}>
            {visible.map((m, i) => (
              <div
                key={i}
                role="link"
                tabIndex={0}
                onClick={() => onOpenPage(p.pageId, m.slug || undefined)}
                onKeyDown={(e) => e.key === 'Enter' && onOpenPage(p.pageId, m.slug || undefined)}
                style={{
                  display: 'flex',
                  gap: 10,
                  paddingLeft: 12,
                  borderLeft: '2px solid #E3E8E5',
                  marginLeft: 3,
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                  {m.section && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: 12,
                        fontWeight: 700,
                        color: '#2E6F40',
                      }}
                    >
                      <Icon name="i04" size={11} strokeWidth={2.2} />
                      {m.section}
                    </div>
                  )}
                  <Snip
                    html={m.snippet}
                    style={{
                      fontSize: 13.5,
                      lineHeight: 1.5,
                      color: '#3A4A3E',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  />
                </div>
              </div>
            ))}
            {secs.length > 3 && !open && (
              <div
                role="button"
                tabIndex={0}
                onClick={() => setExpanded((e) => ({ ...e, [p.pageId]: true }))}
                style={{ paddingLeft: 15, fontSize: 12, fontWeight: 600, color: '#2E6F40', cursor: 'pointer' }}
              >
                Show {secs.length - 3} more {secs.length - 3 === 1 ? 'section' : 'sections'}
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 27, flexWrap: 'wrap' }}>
          {p.updatedBy && <Avatar name={p.updatedBy} />}
          <span style={{ fontSize: 12, color: '#5B6B60' }}>
            Edited by <b style={{ color: '#1E2A22', fontWeight: 600 }}>{p.updatedBy || 'someone'}</b> ·{' '}
            {timeAgo(p.updatedAt)}
          </span>
          <div style={{ flex: 1 }} />
          {p.tickets && p.tickets.length > 0 && (
            <div style={{ display: 'flex', gap: 6 }}>
              {p.tickets.map((t) => (
                <span key={t.ticketId} className="dk-chip dk-chip-ticket" onClick={() => onOpenTicket(t.ticketId)}>
                  <StatusDot status={t.status} size={7} />
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600 }}>
                    {t.ticketId}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  const ticketsStrip =
    data && data.tickets.length > 0 && scope !== 'tickets' ? (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '11px 14px',
          border: '1px solid #E3E8E5',
          borderRadius: 10,
          background: '#FBFCFB',
          marginTop: 14,
        }}
      >
        {(ticketsOpen ? data.tickets : data.tickets.slice(0, 1)).map((t, i) => (
          <div key={t.ticketId} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: i ? '4px 0' : 0 }}>
            <span style={{ display: 'flex', color: '#6D5DD3', visibility: i ? 'hidden' : 'visible' }}>
              <Icon name="i13" size={18} strokeWidth={1.9} />
            </span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
              {i === 0 && <span style={sectionLabelStyle}>Tickets · {data.tickets.length}</span>}
              <StatusDot status={t.status} />
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#5B6B60' }}>
                {t.ticketId}
              </span>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onOpenTicket(t.ticketId);
                }}
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: '#1E2A22',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  textDecoration: 'none',
                }}
              >
                {highlight(t.title, q)}
              </a>
              {t.assignee && <Avatar name={t.assignee} />}
            </div>
            {i === 0 && (
              <button
                type="button"
                onClick={() => setTicketsOpen((v) => !v)}
                style={{
                  border: 'none',
                  background: 'none',
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: '#2E6F40',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  fontFamily: 'inherit',
                }}
              >
                {ticketsOpen ? 'Show fewer tickets' : `Search tickets for “${q}”`}
              </button>
            )}
          </div>
        ))}
      </div>
    ) : null;

  return (
    <div
      className="docs-root"
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#FFFFFF',
        height: '100%',
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: '18px 28px 14px',
          borderBottom: '1px solid #E3E8E5',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="dk-icobtn" aria-label="Back" title="Back (Esc)" onClick={onBack}>
            <Icon name="i60" size={16} strokeWidth={1.9} />
          </button>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 14px',
              borderRadius: 10,
              border: '1px solid #C7D2CB',
              background: '#FFFFFF',
            }}
          >
            <Icon name="i09" size={18} strokeWidth={2} style={{ color: '#2E6F40' }} />
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder={`Search ${projectName} docs…`}
              aria-label="Search docs"
              style={{
                flex: 1,
                minWidth: 0,
                border: 'none',
                outline: 'none',
                fontSize: 15,
                fontWeight: 500,
                color: '#1E2A22',
                fontFamily: 'inherit',
                background: 'transparent',
              }}
            />
            {input && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setInput('');
                  setQ('');
                  inputRef.current?.focus();
                }}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  background: '#E3E8E5',
                  color: '#5B6B60',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <Icon name="i08" size={11} strokeWidth={2.2} />
              </button>
            )}
            <span className="dk-kbd">/</span>
          </div>
          <div style={{ width: 170, position: 'relative' }}>
            <div className="st-input" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ display: 'flex', color: '#2E6F40' }}>
                <Icon
                  name={scope === 'all' ? 'i21' : scope === 'tickets' ? 'i13' : 'i07'}
                  size={15}
                  strokeWidth={1.9}
                />
              </span>
              <span style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>
                {scope === 'all' ? 'All projects' : scope === 'tickets' ? 'Tickets' : 'This space'}
              </span>
              <Icon name="i06" size={12} strokeWidth={2} style={{ color: '#9AA8A0' }} />
            </div>
            <select
              aria-label="Search scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as typeof scope)}
              style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', cursor: 'pointer' }}
            >
              <option value="space">This space</option>
              <option value="all">All projects</option>
              <option value="tickets">Tickets</option>
            </select>
          </div>
          <button type="button" className="st-btn st-btn-primary" style={{ padding: '11px 18px' }} onClick={submit}>
            <Icon name="i09" size={14} strokeWidth={2} />
            Search
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ flex: 1, fontSize: 13.5, color: '#5B6B60' }}>
            {data && q ? (
              <>
                <b style={{ color: '#1E2A22', fontWeight: 700 }}>
                  {scope === 'tickets'
                    ? `${data.tickets.length} tickets`
                    : `${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`}
                </b>
                {scope !== 'tickets' && (
                  <>
                    {' '}
                    in{' '}
                    <b style={{ color: '#1E2A22', fontWeight: 700 }}>
                      {total} {total === 1 ? 'page' : 'pages'}
                    </b>
                  </>
                )}{' '}
                for “<b style={{ color: '#1E2A22', fontWeight: 700 }}>{q}</b>” ·{' '}
                <span style={{ color: '#9AA8A0' }}>{data.tookMs} ms</span>
              </>
            ) : (
              <span>{q ? 'Searching…' : 'Type to search pages, headings and tickets'}</span>
            )}
          </div>
          <div
            style={{
              width: 230,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '6px 10px',
              borderRadius: 8,
              border: '1px solid #E3E8E5',
              background: '#FFFFFF',
            }}
          >
            <Icon name="i09" size={13} strokeWidth={1.9} style={{ color: '#9AA8A0' }} />
            <input
              value={within}
              onChange={(e) => setWithin(e.target.value)}
              placeholder="Search within results…"
              aria-label="Search within results"
              style={{
                flex: 1,
                minWidth: 0,
                border: 'none',
                outline: 'none',
                fontSize: 12.5,
                color: '#1E2A22',
                fontFamily: 'inherit',
                background: 'transparent',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#5B6B60' }}>Sort by</span>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                padding: 3,
                borderRadius: 8,
                background: '#EEF3EF',
              }}
            >
              <button
                type="button"
                className={`mb-view-btn${sort === 'relevance' ? ' mb-view-btn-active' : ''}`}
                onClick={() => setSort('relevance')}
              >
                Relevance
              </button>
              <button
                type="button"
                className={`mb-view-btn${sort === 'edited_at' ? ' mb-view-btn-active' : ''}`}
                onClick={() => setSort('edited_at')}
              >
                Recently edited
              </button>
            </div>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div
          className="fx-scroll"
          style={{
            width: 236,
            flexShrink: 0,
            borderRight: '1px solid #E3E8E5',
            background: '#FBFCFB',
            padding: '18px 18px 12px',
            boxSizing: 'border-box',
            overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22', flex: 1 }}>Filters</span>
            <button
              type="button"
              onClick={clearAll}
              style={{
                border: 'none',
                background: 'none',
                fontSize: 12,
                fontWeight: 600,
                color: '#2E6F40',
                cursor: 'pointer',
                padding: 0,
                fontFamily: 'inherit',
              }}
            >
              Clear all
            </button>
          </div>
          {filterSection(
            'Author',
            f?.authors?.length ? (
              f.authors.map((a) => (
                <Check
                  key={a.name}
                  on={authors.includes(a.name)}
                  onChange={() =>
                    setAuthors((l) => (l.includes(a.name) ? l.filter((x) => x !== a.name) : [...l, a.name]))
                  }
                  count={a.count}
                >
                  <Avatar name={a.name} />
                  <span>{a.name}</span>
                </Check>
              ))
            ) : (
              <span className="st-hint">No authors in these results.</span>
            ),
          )}
          {filterSection(
            'Edited',
            <>
              {EDITED.map((e) => (
                <Radio
                  key={e.id}
                  on={edited === e.id}
                  onChange={() => setEdited(e.id)}
                  count={e.id === 'custom' ? undefined : f?.edited?.[e.id as 'any']}
                >
                  {e.label}
                </Radio>
              ))}
              {edited === 'custom' && (
                <input
                  type="date"
                  aria-label="Edited since"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="st-input"
                  style={{ marginTop: 4 }}
                />
              )}
            </>,
          )}
          {filterSection(
            'Page tree location',
            <>
              <div style={{ position: 'relative' }}>
                <div className="st-input" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ display: 'flex', color: '#2E6F40' }}>
                    <Icon name="i07" size={15} strokeWidth={1.9} />
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {underNode?.title ?? 'Anywhere in space'}
                  </span>
                  <Icon name="i06" size={12} strokeWidth={2} style={{ color: '#9AA8A0' }} />
                </div>
                <select
                  aria-label="Page tree location"
                  value={under}
                  onChange={(e) => setUnder(e.target.value)}
                  style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', cursor: 'pointer' }}
                >
                  <option value="">Anywhere in space</option>
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {' '.repeat(depthOf(n.id))}
                      {n.title}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.45, color: '#5B6B60', paddingTop: 4 }}>
                Pick a page to search it and everything below it.
              </div>
            </>,
          )}
          {filterSection(
            'Linked tickets',
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '4px 0',
                fontSize: 13,
                fontWeight: 500,
                color: '#1E2A22',
              }}
            >
              <span style={{ flex: 1 }}>Only pages that link a ticket</span>
              <button
                type="button"
                role="switch"
                aria-checked={hasTickets}
                aria-label="Only pages that link a ticket"
                className="st-toggle-track"
                onClick={() => setHasTickets((v) => !v)}
                style={{ background: hasTickets ? '#2E6F40' : '#C7D2CB', border: 'none', padding: 0 }}
              >
                <span className="st-toggle-dot" style={{ left: hasTickets ? 17 : 2 }} />
              </button>
            </div>,
          )}
          {filterSection(
            'Status',
            <>
              <Check
                on={status.published}
                onChange={() => setStatus((s) => ({ ...s, published: !s.published }))}
                count={f?.status?.published}
              >
                Published
              </Check>
              <Check
                on={status.draft}
                onChange={() => setStatus((s) => ({ ...s, draft: !s.draft }))}
                count={f?.status?.draft}
              >
                Draft
              </Check>
            </>,
            true,
          )}
        </div>
        <div className="fx-scroll" style={{ flex: 1, minWidth: 0, padding: '0 28px 12px', overflowY: 'auto' }}>
          {edited !== 'any' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
              <span
                className="mc-chip"
                style={{ background: '#F1F8F3', border: '1px solid #D7E8DC', color: '#1F5A31', height: 24 }}
              >
                Edited:{' '}
                {edited === 'custom'
                  ? `since ${customFrom || '…'}`
                  : EDITED.find((e) => e.id === edited)?.label.toLowerCase()}
                <button
                  type="button"
                  aria-label="Remove edited filter"
                  onClick={() => setEdited('any')}
                  style={{
                    display: 'flex',
                    border: 'none',
                    background: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  <Icon name="i08" size={11} strokeWidth={2.4} />
                </button>
              </span>
              <span style={{ fontSize: 12, color: '#5B6B60' }}>
                Showing pages edited{' '}
                {edited === 'day'
                  ? 'in the last 24 hours'
                  : edited === 'week'
                    ? 'in the last 7 days'
                    : edited === 'month'
                      ? 'in the last 30 days'
                      : 'since the chosen date'}
              </span>
            </div>
          )}
          {!online || netError ? (
            <div
              style={{
                margin: '14px 0 0',
                padding: '9px 11px',
                borderRadius: 8,
                background: '#FEF6E7',
                border: '1px solid #F0DBA8',
                fontSize: 12,
                color: '#3A4A3E',
              }}
            >
              <b style={{ color: '#1E2A22' }}>You’re offline.</b> Showing pages saved on this device only.
            </div>
          ) : null}
          {ticketsStrip}
          {failed && (
            <div style={{ padding: '40px 0', textAlign: 'center', color: '#5B6B60', fontSize: 13 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22', marginBottom: 6 }}>
                Search isn’t available right now
              </div>
              <div style={{ marginBottom: 12 }}>We couldn’t reach the search service. Your query is kept.</div>
              <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => res.refetch()}>
                <Icon name="i41" size={14} strokeWidth={1.9} />
                Try again
              </button>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#9AA8A0', marginTop: 8 }}>
                {docsErrorDetail(res.error)?.code ?? 'search_unavailable'}
              </div>
            </div>
          )}
          {loading && (
            <div style={{ paddingTop: 18 }}>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 9,
                    padding: '16px 0',
                    borderBottom: '1px solid #EEF3EF',
                  }}
                >
                  <div className="skel" style={{ width: 180, height: 16 }} />
                  <div className="skel" style={{ width: 120, height: 10 }} />
                  <div className="skel" style={{ width: '80%', height: 12 }} />
                </div>
              ))}
            </div>
          )}
          {!loading && !failed && data && scope !== 'tickets' && shown.length === 0 && q && (
            <div style={{ padding: '48px 0', textAlign: 'center', color: '#5B6B60', fontSize: 13, lineHeight: 1.6 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22', marginBottom: 4 }}>
                No pages match “{q}”
              </div>
              {data.suggestion && (
                <div>
                  Did you mean{' '}
                  <b
                    style={{ color: '#2E6F40', cursor: 'pointer' }}
                    onClick={() => (setInput(data.suggestion!), setQ(data.suggestion!))}
                  >
                    {data.suggestion}
                  </b>
                  ?
                </div>
              )}
              {edited !== 'any' && (
                <div>
                  Pages edited earlier are hidden by the date filter.{' '}
                  <b style={{ color: '#2E6F40', cursor: 'pointer' }} onClick={() => setEdited('any')}>
                    Search any time
                  </b>
                </div>
              )}
            </div>
          )}
          {scope === 'tickets' && data && (
            <div style={{ paddingTop: 14 }}>
              {data.tickets.map((t) => (
                <div
                  key={t.ticketId}
                  role="link"
                  tabIndex={0}
                  onClick={() => onOpenTicket(t.ticketId)}
                  className="fx-row"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 6px',
                    borderBottom: '1px solid #EEF3EF',
                  }}
                >
                  <StatusDot status={t.status} />
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#5B6B60' }}>
                    {t.ticketId}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#1E2A22' }}>{highlight(t.title, q)}</span>
                </div>
              ))}
            </div>
          )}
          {!ticketMode || scope !== 'tickets' ? shown.map(card) : null}
          {scope !== 'tickets' && shown.length > 0 && data && (
            <div
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '20px 0 10px' }}
            >
              {total > shown.length && !within && (
                <button
                  type="button"
                  className="st-btn st-btn-primary"
                  style={{ background: '#FFFFFF', color: '#2E6F40', borderColor: '#B7D9C0' }}
                  onClick={() => setLimit((l) => l + PAGE_SIZE)}
                  disabled={res.isFetching}
                >
                  Show {Math.min(PAGE_SIZE, total - shown.length)} more pages
                </button>
              )}
              <span style={{ fontSize: 12, color: '#9AA8A0' }}>
                Showing {shown.length} of {total} pages
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
