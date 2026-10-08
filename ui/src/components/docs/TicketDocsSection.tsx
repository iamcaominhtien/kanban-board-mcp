import { useEffect, useMemo, useRef, useState } from 'react';
import { useTicketDocs } from '../../api/docs';
import { useDocsSuggest, useLinkTicketDoc } from '../../api/docsActions';
import { extractError } from '../../api/extractError';
import type { DocsSuggestItem, TicketDocOrigin, TicketDocRow } from '../../types/docsActions';
import { useToast } from '../Toast';
import { SuggestRows } from './DocsSuggest';
import { Icon } from './Icon';

interface TicketDocsSectionProps {
  ticketId: string;
  /** Project whose pages the "Link a doc" search offers. */
  projectId?: string;
  onOpenPage: (pageId: string, projectId: string) => void;
}

const WHERE: Record<string, string> = {
  description: 'Mentioned in description',
  comment: 'Mentioned in comment',
  acceptance_criterion: 'Mentioned in acceptance criterion',
  test_case: 'Mentioned in test case',
  debug_note: 'Mentioned in debug note',
};

/** "Mentioned in test case TC-3", "Manual link", "From docs". */
function originLabel(d: { origin?: TicketDocOrigin; detail?: string }): string {
  const o = d.origin ?? 'page';
  if (o === 'manual') return 'Manual link';
  if (o === 'page') return 'From docs';
  return `${WHERE[o] ?? `Mentioned in ${o}`}${o === 'test_case' && d.detail ? ` ${d.detail}` : ''}`;
}

type Grouped = TicketDocRow & { labels: string[] };

/** One row per page+section, however many places mention it. */
function groupByPage(list: TicketDocRow[]): Grouped[] {
  const out = new Map<string, Grouped>();
  for (const d of list) {
    const key = `${d.pageId}#${d.section ?? ''}`;
    const row = out.get(key) ?? { ...d, labels: [] };
    const label = originLabel(d);
    if (!row.labels.includes(label)) row.labels.push(label);
    out.set(key, row);
  }
  return [...out.values()];
}

const groupLabel: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#9AA8A0' };
const card: React.CSSProperties = { border: '1px solid #E3E8E5', borderRadius: 8, overflow: 'hidden' };

function Row({
  doc,
  origin,
  last,
  onOpen,
  onRemove,
}: {
  doc: Grouped;
  origin: TicketDocOrigin;
  last: boolean;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  const path = doc.path ?? [];
  const endsWithTitle = path[path.length - 1] === doc.title;
  const sub = doc.section
    ? (endsWithTitle ? path : [...path, doc.title]).join(' › ')
    : (endsWithTitle ? path.slice(0, -1) : path).join(' › ');
  return (
    <div
      className={`tdoc-row ${onRemove ? 'tdoc-manual' : ''}`}
      data-testid={`ticket-doc-${origin}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 12px',
        background: '#FFFFFF',
        borderBottom: last ? undefined : '1px solid #EEF3EF',
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flex: 1,
          minWidth: 0,
          background: 'none',
          border: 'none',
          padding: 0,
          textAlign: 'left',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        <span style={{ display: 'flex', color: '#2E6F40' }}>
          {doc.section ? (
            <Icon name="i04" size={16} strokeWidth={1.8} />
          ) : (
            <Icon name="i00" size={16} strokeWidth={1.8} />
          )}
        </span>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>
            {doc.section ? `${doc.title} › ${doc.section}` : doc.title}
          </span>
          {sub && <span style={{ fontSize: 11.5, color: '#9AA8A0' }}>{sub}</span>}
        </span>
      </button>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
        {doc.labels.map((l) => (
          <span
            key={l}
            data-testid="ticket-doc-origin"
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: '#5B6B60',
              padding: '2px 8px',
              borderRadius: 999,
              background: origin === 'page' ? '#E8F1FB' : '#F1F3F1',
              whiteSpace: 'nowrap',
            }}
          >
            {l}
          </span>
        ))}
      </span>
      {onRemove ? (
        <button
          type="button"
          className="tdoc-remove"
          aria-label="Remove link"
          onClick={onRemove}
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            border: 'none',
            background: '#FBE7E4',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#C4432A',
            flexShrink: 0,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <Icon name="i08" size={12} strokeWidth={2} />
        </button>
      ) : (
        <span
          title="Remove the mention to unlink"
          style={{
            width: 22,
            height: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#C7D2CB',
            flexShrink: 0,
          }}
        >
          <Icon name="lock" size={13} strokeWidth={1.9} />
        </span>
      )}
    </div>
  );
}

function LinkPopover({
  projectId,
  linked,
  onPick,
  onClose,
}: {
  projectId?: string;
  linked: Set<string>;
  onPick: (item: DocsSuggestItem) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const suggest = useDocsSuggest(projectId, q, true);
  const items = (suggest.data ?? []).filter((i) => !linked.has(i.pageId));

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      onPick(items[active]);
    }
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Link a doc"
      onKeyDown={onKey}
      style={{
        position: 'absolute',
        left: 0,
        top: 'calc(100% + 6px)',
        zIndex: 70,
        width: 420,
        maxWidth: '100%',
        boxSizing: 'border-box',
        border: '1px solid #E3E8E5',
        borderRadius: 12,
        background: '#FFFFFF',
        boxShadow: '0 14px 36px rgba(30,42,34,0.18)',
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 10px',
          borderRadius: 8,
          border: '1px solid #2E6F40',
          boxShadow: '0 0 0 3px rgba(46,111,64,0.14)',
          fontSize: 13,
          color: '#1E2A22',
        }}
      >
        <span style={{ display: 'flex', color: '#9AA8A0' }}>
          <Icon name="i09" size={14} strokeWidth={2} />
        </span>
        <input
          autoFocus
          aria-label="Search pages and sections"
          placeholder="Search pages…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            font: 'inherit',
            color: '#1E2A22',
            padding: 0,
          }}
        />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px 10px 3px',
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: '#5B6B60',
        }}
      >
        Pages and sections in this space
      </div>
      <SuggestRows
        items={items}
        active={active}
        query={q}
        onPick={onPick}
        onHover={setActive}
        loading={suggest.isFetching}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '6px 12px',
          padding: '8px 10px 4px',
          marginTop: 4,
          borderTop: '1px solid #EEF3EF',
          fontSize: 11.5,
          color: '#5B6B60',
        }}
      >
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <span className="dk-kbd">↑ ↓</span> move
        </span>
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <span className="dk-kbd">Enter</span> link
        </span>
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <span className="dk-kbd">Esc</span> close
        </span>
      </div>
    </div>
  );
}

/**
 * "Linked docs" on a ticket: mentioned / linked manually / pages that mention it, plus "+ Link a doc".
 * @param props.ticketId - Ticket whose linked docs are shown.
 * @param props.projectId - Project whose pages the "Link a doc" search offers.
 * @param props.onOpenPage - Called with page id and project id when a doc is opened.
 */
export function TicketDocsSection({ ticketId, projectId, onOpenPage }: TicketDocsSectionProps) {
  const toast = useToast();
  const { data } = useTicketDocs(ticketId);
  const { link, unlink } = useLinkTicketDoc(ticketId);
  const [adding, setAdding] = useState(false);
  const docs = (data ?? []) as unknown as TicketDocRow[];

  const groups = useMemo(() => {
    const originOf = (d: TicketDocRow): TicketDocOrigin => d.origin ?? 'page';
    return {
      mentioned: groupByPage(docs.filter((d) => originOf(d) !== 'manual' && originOf(d) !== 'page')),
      manual: groupByPage(docs.filter((d) => originOf(d) === 'manual')),
      pages: groupByPage(docs.filter((d) => originOf(d) === 'page')),
      originOf,
    };
  }, [docs]);
  const linked = useMemo(() => new Set(docs.map((d) => d.pageId)), [docs]);

  async function add(item: DocsSuggestItem) {
    setAdding(false);
    try {
      await link.mutateAsync(item.pageId);
    } catch (err) {
      toast.error("Couldn't link the doc", extractError(err));
    }
  }

  async function remove(d: TicketDocRow) {
    try {
      await unlink.mutateAsync(d.pageId);
    } catch (err) {
      toast.error("Couldn't remove the link", extractError(err));
    }
  }

  const section = (label: string, list: Grouped[]) =>
    list.length > 0 && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={groupLabel}>{label}</div>
        <div style={card}>
          {list.map((d, i) => (
            <Row
              key={`${d.pageId}-${d.section ?? ''}-${i}`}
              doc={d}
              origin={groups.originOf(d)}
              last={i === list.length - 1}
              onOpen={() => onOpenPage(d.pageId, d.projectId)}
              onRemove={groups.originOf(d) === 'manual' ? () => void remove(d) : undefined}
            />
          ))}
        </div>
      </div>
    );

  return (
    <div
      className="docs-root"
      data-testid="ticket-docs"
      style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4, borderTop: '1px solid #EEF3EF' }}
    >
      <style>{`
        .tdoc-manual .tdoc-remove { opacity: 0; transition: opacity .12s; }
        .tdoc-manual:hover, .tdoc-manual:focus-within { background: #F6FAF7 !important; }
        .tdoc-manual:hover .tdoc-remove, .tdoc-manual:focus-within .tdoc-remove { opacity: 1; }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color: '#5B6B60',
            textTransform: 'uppercase',
          }}
        >
          Linked docs
        </span>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: '#9AA8A0' }} data-testid="ticket-docs-count">
          {groups.mentioned.length + groups.manual.length + groups.pages.length}
        </span>
      </div>
      {section('Mentioned in this ticket', groups.mentioned)}
      {section('Linked manually', groups.manual)}
      {section('Pages that mention this ticket', groups.pages)}
      <div style={{ position: 'relative', alignSelf: 'flex-start' }}>
        <button
          type="button"
          onClick={() => setAdding((a) => !a)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px dashed #2E6F40',
            background: '#F1F8F3',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
            color: '#2E6F40',
            fontFamily: 'inherit',
          }}
        >
          <Icon name="i01" size={12} strokeWidth={2.6} />
          Link a doc
        </button>
        {adding && (
          <LinkPopover
            projectId={projectId}
            linked={linked}
            onPick={(i) => void add(i)}
            onClose={() => setAdding(false)}
          />
        )}
      </div>
    </div>
  );
}
