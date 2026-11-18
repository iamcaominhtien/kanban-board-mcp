import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useDocsLinkTargets, useDocsPage } from '../../../api/docs';
import type { DocsTreeNode } from '../../../types/docs';
import { relativeTime } from '../../../utils/relativeTime';
import { Icon } from '../Icon';
import { openRefCheatSheet } from '../RefCheatSheet';
import { TICKET_DOT, TICKET_STATUS_LABEL } from './constants';
import type { MenuHost, MenuState } from './menuHost';
import { Hint, MenuFooter, useMenuPosition } from './SlashMenu';
import type { TicketLite } from './context';
import { KindTile } from '../links/BlockKind';
import { useDocsLayout, useKeyboardInset } from '../../../hooks/useDocsLayout';
import '../links/links.css';

const HEAD: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '8px 10px 3px',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: '#5B6B60',
};
const SUBHEAD: React.CSSProperties = {
  marginLeft: 'auto',
  fontSize: 11,
  color: '#9AA8A0',
  fontWeight: 500,
  textTransform: 'none',
  letterSpacing: 0,
};
const KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,5}-\d*$/;
/* `[[Page#` on a rich page (RichDocsLinks C 17): the page above, then headings and blocks */
const PICK_HEAD: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '3px 8px 6px',
  margin: '0 -6px 4px',
  borderBottom: '1px solid #E3E8E5',
  fontSize: 12,
  color: '#5B6B60',
  fontWeight: 600,
};
const ROW_TITLE: React.CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  color: '#1E2A22',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const ROW_SUB: React.CSSProperties = {
  fontSize: 11.5,
  color: '#5B6B60',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const LEVEL: React.CSSProperties = {
  width: 22,
  flex: 'none',
  textAlign: 'center',
  fontSize: 10.5,
  fontWeight: 800,
  color: '#2E6F40',
  fontFamily: "'JetBrains Mono', monospace",
};

export type RefPayload =
  | {
      kind: 'page';
      page: string;
      section: string | null;
      label: string | null;
      /** The page's id: the link follows the page when it is renamed. */
      pageId?: string;
      /** A heading's or block's id (`[[Page#` → a heading or a block): the link follows it. */
      targetBlockId?: string;
      /** The heading's or block's name when the link is made: a chip whose block is gone still names it. */
      targetLabel?: string;
    }
  | { kind: 'ticket'; key: string }
  | { kind: 'create'; title: string; label: string | null }
  | { kind: 'text'; text: string };

type Row =
  | { id: string; type: 'head'; label: string; sub?: string }
  | { id: string; type: 'page'; node: DocsTreeNode; recent: boolean }
  | {
      id: string;
      type: 'section';
      text: string;
      level: number;
      sub: string;
      whole?: boolean;
      indent: boolean;
      /** Page the section belongs to when it is listed under the page matches (not after a `#`). */
      node?: DocsTreeNode;
      /** The heading's block id (a rich page). */
      blockId?: string;
    }
  | { id: string; type: 'block'; blockId: string; kind: string; label: string; detail: string }
  | { id: string; type: 'ticket'; ticket: TicketLite }
  | { id: string; type: 'create'; title: string }
  | { id: string; type: 'note'; text: string };

interface Props {
  host: MenuHost;
  state: MenuState;
  nodes: DocsTreeNode[];
  tickets: TicketLite[];
  currentPageId: string;
  onClose: () => void;
  /** Opened by a bare ticket key (`KAN-1`, no `[[`): Tab completes the key as text and Enter inserts the chip. */
  bare?: boolean;
}

function pathOf(node: DocsTreeNode, byId: Map<string, DocsTreeNode>): string[] {
  const out = [node.title];
  let p = node.parentId ? byId.get(node.parentId) : undefined;
  while (p) {
    out.unshift(p.title);
    p = p.parentId ? byId.get(p.parentId) : undefined;
  }
  return out;
}

function Highlight({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <b style={{ color: '#2E6F40' }}>{text.slice(i, i + q.length)}</b>
      {text.slice(i + q.length)}
    </>
  );
}

/**
 * The "[[" suggester (DocsEditor board H, DocsRefs board A): pages, then #sections, then KAN- tickets.
 * @param props.host - Menu host that routes keyboard events to the menu.
 * @param props.state - Current suggester state (query, position).
 * @param props.nodes - Page tree, source of page and section suggestions.
 * @param props.tickets - Tickets offered after the `KAN-` trigger.
 * @param props.currentPageId - Page being edited, to offer its own sections.
 * @param props.onClose - Called to dismiss the menu.
 * @param props.bare - Opened by a bare ticket key with no `[[`.
 */
export function RefSuggester({ host, state, nodes, tickets, currentPageId, onClose, bare }: Props) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { ref, pos } = useMenuPosition(state.rect, 436);
  const layout = useDocsLayout(null);
  const keyboard = useKeyboardInset(layout === 'phone');

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const currentNode = byId.get(currentPageId);

  const bar = state.query.indexOf('|');
  const main = bar >= 0 ? state.query.slice(0, bar) : state.query;
  const label = bar >= 0 ? state.query.slice(bar + 1).trim() || null : null;
  const hash = main.indexOf('#');
  const mode: 'pages' | 'sections' | 'tickets' = KEY_RE.test(main.trim())
    ? 'tickets'
    : hash >= 0
      ? 'sections'
      : 'pages';
  const pageQuery = (hash >= 0 ? main.slice(0, hash) : main).trim();
  const sectionQuery = hash >= 0 ? main.slice(hash + 1).trim() : '';

  const targetNode = useMemo(() => {
    if (mode !== 'sections') return undefined;
    const q = pageQuery.toLowerCase();
    if (!q) return currentNode;
    return nodes.find((n) => n.title.toLowerCase() === q) ?? nodes.find((n) => n.title.toLowerCase().startsWith(q));
  }, [mode, pageQuery, nodes, currentNode]);
  // typing "[[Req" also lists the sections of the best page match (DocsEditor board H)
  const topNode = useMemo(() => {
    if (mode !== 'pages' || !pageQuery) return undefined;
    const q = pageQuery.toLowerCase();
    return (
      nodes.find((n) => n.title.toLowerCase() === q) ??
      nodes.find((n) => n.title.toLowerCase().startsWith(q)) ??
      nodes.find((n) => n.title.toLowerCase().includes(q))
    );
  }, [mode, pageQuery, nodes]);
  const targetPage = useDocsPage(
    mode === 'sections' && targetNode ? targetNode.id : mode === 'pages' && topNode ? topNode.id : null,
  );
  // a rich page lists its headings and the blocks worth linking, by id (RichDocsLinks C 17)
  const targets = useDocsLinkTargets(mode === 'sections' && targetNode ? targetNode.id : null);
  const rich = !!targets.data && (targets.data.headings.length > 0 || targets.data.blocks.length > 0);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (mode === 'tickets') {
      const k = main.trim().toLowerCase();
      const list = tickets.filter((t) => t.id.toLowerCase().startsWith(k)).slice(0, 8);
      out.push({ id: 'h-t', type: 'head', label: 'Tickets', sub: 'recent first, then by key' });
      if (!list.length) out.push({ id: 'none', type: 'note', text: `No ticket matches ${main.trim().toUpperCase()}.` });
      list.forEach((t) => out.push({ id: `t-${t.id}`, type: 'ticket', ticket: t }));
      return out;
    }
    if (mode === 'sections') {
      if (!targetNode) {
        out.push({ id: 'none', type: 'note', text: `No page named "${pageQuery}".` });
        return out;
      }
      if (rich && targets.data) {
        const q = sectionQuery.toLowerCase();
        out.push({
          id: 'whole',
          type: 'section',
          text: 'Whole page',
          level: 0,
          sub: 'No heading, no block',
          whole: true,
          indent: false,
        });
        const hs = targets.data.headings.filter((h) => !q || h.text.toLowerCase().includes(q));
        if (hs.length) out.push({ id: 'h-h', type: 'head', label: 'Headings' });
        hs.forEach((h) =>
          out.push({
            id: `s-${h.blockId}`,
            type: 'section',
            text: h.text,
            level: h.level,
            sub: h.level > 2 && h.under ? `under ${h.under}` : '',
            indent: h.level > 2,
            blockId: h.blockId,
          }),
        );
        const bs = targets.data.blocks.filter(
          (b) => !q || b.label.toLowerCase().includes(q) || b.detail.toLowerCase().includes(q),
        );
        if (bs.length) out.push({ id: 'h-b', type: 'head', label: 'Blocks' });
        bs.forEach((b) =>
          out.push({
            id: `b-${b.blockId}`,
            type: 'block',
            blockId: b.blockId,
            kind: b.kind,
            label: b.label,
            detail: b.detail,
          }),
        );
        if (!hs.length && !bs.length && q)
          out.push({ id: 'none', type: 'note', text: `No heading or block matches "${sectionQuery}".` });
        return out;
      }
      out.push({ id: 'h-s', type: 'head', label: `Sections in ${targetNode.title}`, sub: 'headings, in page order' });
      out.push({
        id: 'whole',
        type: 'section',
        text: 'Whole page',
        level: 0,
        sub: 'No section',
        whole: true,
        indent: false,
      });
      const hs = (targetPage.data?.headings ?? []).filter(
        (h) => !sectionQuery || h.text.toLowerCase().includes(sectionQuery.toLowerCase()),
      );
      let parent = '';
      hs.forEach((h, i) => {
        if (h.level <= 2) parent = h.text;
        out.push({
          id: `s-${i}`,
          type: 'section',
          text: h.text,
          level: h.level,
          sub: h.level <= 2 ? `H${h.level}` : `H${h.level}${parent ? ` under ${parent}` : ''}`,
          indent: h.level > 2,
        });
      });
      if (targetPage.isLoading) out.push({ id: 'load', type: 'note', text: 'Loading sections…' });
      return out;
    }
    const q = pageQuery.toLowerCase();
    const matches = nodes
      .filter((n) => !q || n.title.toLowerCase().includes(q))
      .sort((a, b) => {
        const ap = a.title.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.title.toLowerCase().startsWith(q) ? 0 : 1;
        return ap - bp || b.updatedAt.localeCompare(a.updatedAt);
      });
    const week = Date.now() - 7 * 86400000;
    const recent = matches.filter((n) => new Date(n.updatedAt).getTime() > week).slice(0, q ? 4 : 5);
    const rest = matches.filter((n) => !recent.includes(n)).slice(0, 6);
    if (recent.length) {
      out.push({ id: 'h-r', type: 'head', label: 'Recent' });
      recent.forEach((n) => out.push({ id: `p-${n.id}`, type: 'page', node: n, recent: true }));
    }
    if (rest.length) {
      out.push({ id: 'h-o', type: 'head', label: recent.length ? 'Other pages' : 'Pages' });
      rest.forEach((n) => out.push({ id: `p-${n.id}`, type: 'page', node: n, recent: false }));
    }
    if (topNode) {
      const hs = (targetPage.data?.headings ?? []).slice(0, 4);
      if (hs.length) {
        out.push({ id: 'h-s', type: 'head', label: `Sections in ${topNode.title}` });
        hs.forEach((h, i) =>
          out.push({
            id: `ps-${i}`,
            type: 'section',
            text: h.text,
            level: h.level,
            sub: `${topNode.title} › ${h.text}`,
            indent: false,
            node: topNode,
          }),
        );
      }
    }
    if (pageQuery && !nodes.some((n) => n.title.toLowerCase() === q)) {
      out.push({ id: 'h-c', type: 'head', label: 'Create' });
      out.push({ id: 'create', type: 'create', title: pageQuery });
    }
    return out;
  }, [
    mode,
    main,
    tickets,
    nodes,
    pageQuery,
    sectionQuery,
    targetNode,
    topNode,
    targetPage.data,
    targetPage.isLoading,
    rich,
    targets.data,
  ]);

  const selectable = useMemo(() => rows.filter((r) => r.type !== 'head' && r.type !== 'note'), [rows]);
  useEffect(() => setActive(0), [state.query]);
  const act = Math.min(active, Math.max(0, selectable.length - 1));
  const sel = selectable[act];

  const payloadOf = (r: Row | undefined): RefPayload | null => {
    if (!r) return null;
    if (r.type === 'page') return { kind: 'page', page: r.node.title, section: null, label, pageId: r.node.id };
    if (r.type === 'ticket') return { kind: 'ticket', key: r.ticket.id };
    if (r.type === 'create') return { kind: 'create', title: r.title, label };
    if (r.type === 'block' && targetNode)
      return {
        kind: 'page',
        page: targetNode.title,
        section: null,
        label,
        pageId: targetNode.id,
        targetBlockId: r.blockId,
        targetLabel: r.label,
      };
    if (r.type === 'section' && (r.node ?? targetNode)) {
      const n = (r.node ?? targetNode)!;
      return {
        kind: 'page',
        page: n.title,
        section: r.whole ? null : r.text,
        label,
        pageId: n.id,
        ...(r.blockId && !r.whole ? { targetBlockId: r.blockId, targetLabel: r.text } : {}),
      };
    }
    return null;
  };

  const stateRef = useRef({ selectable, act, mode, sel, payloadOf, state, bare });
  stateRef.current = { selectable, act, mode, sel, payloadOf, state, bare };
  useEffect(() => {
    host.keyHandler = (e) => {
      const s = stateRef.current;
      const n = s.selectable.length;
      if (e.key === 'ArrowDown') {
        if (n) setActive((a) => (Math.min(a, n - 1) + 1) % n);
        return true;
      }
      if (e.key === 'ArrowUp') {
        if (n) setActive((a) => (Math.min(a, n - 1) - 1 + n) % n);
        return true;
      }
      if (e.key === 'Enter') {
        const p = s.payloadOf(s.sel);
        if (!p) return false;
        s.state.run(p);
        return true;
      }
      if (e.key === 'Tab') {
        const r = s.sel;
        if (!r) return false;
        if (s.mode === 'pages' && r.type === 'page') {
          s.state.run({ kind: 'text', text: `[[${r.node.title}#` } satisfies RefPayload);
          return true;
        }
        if (s.mode === 'tickets' && r.type === 'ticket') {
          s.state.run({ kind: 'text', text: s.bare ? r.ticket.id : `[[${r.ticket.id}` } satisfies RefPayload);
          return true;
        }
        const p = s.payloadOf(r);
        if (p) {
          s.state.run(p);
          return true;
        }
        return false;
      }
      return false;
    };
    return () => {
      host.keyHandler = null;
    };
  }, [host]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [act]);

  // keep the menu out of the way when the query is closed by typing "]]"
  useEffect(() => {
    if (state.query.includes(']]')) onClose();
  }, [state.query, onClose]);

  const preview = (() => {
    const p = payloadOf(sel);
    if (!p || p.kind === 'text') return null;
    const token =
      p.kind === 'ticket'
        ? p.key
        : `[[${p.kind === 'create' ? p.title : p.page}${p.kind === 'page' && p.section ? `#${p.section}` : ''}${p.label ? `|${p.label}` : ''}]]`;
    return { token, ticket: p.kind === 'ticket' };
  })();

  return (
    <div
      ref={ref}
      data-testid="ref-menu"
      className={`rs-menu rs-${layout}`}
      onMouseDown={(e) => e.preventDefault()}
      style={
        layout === 'phone'
          ? // RichDocsLinks C 20: on a phone the list docks above the keyboard, full width, 56 px rows
            { position: 'fixed', zIndex: 60, left: 0, right: 0, bottom: keyboard }
          : {
              position: 'fixed',
              zIndex: 60,
              width: 436,
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              visibility: pos ? 'visible' : 'hidden',
            }
      }
    >
      <div className="dk-menu" style={{ width: '100%', padding: 6 }} role="listbox" aria-label="Link a page or ticket">
        {mode === 'sections' && rich && targetNode && (
          <div style={PICK_HEAD} data-testid="ref-pick-head">
            <span className="dk-chip dk-chip-page" style={{ height: 22, fontSize: 12.5 }}>
              <Icon name="i00" size={12} />
              {targetNode.title}
            </span>
            <span>› choose a heading or a block</span>
          </div>
        )}
        <div ref={listRef} style={{ maxHeight: 360, overflowY: 'auto' }}>
          {rows.map((r) => {
            if (r.type === 'head')
              return (
                <div key={r.id} style={HEAD}>
                  {r.label}
                  {r.sub && <span style={SUBHEAD}>{r.sub}</span>}
                </div>
              );
            if (r.type === 'note')
              return (
                <div key={r.id} style={{ padding: '8px 10px', fontSize: 12.5, color: '#5B6B60' }}>
                  {r.text}
                </div>
              );
            const on = r === sel;
            const common = {
              role: 'option' as const,
              'aria-selected': on,
              'data-active': on,
              className: `dk-mi${on ? ' dk-mi-on' : ''}`,
              style: { gap: 10, padding: '6px 10px' },
              onMouseEnter: () => setActive(selectable.indexOf(r)),
              onClick: () => {
                const p = payloadOf(r);
                if (p) state.run(p);
              },
            };
            if (r.type === 'ticket') {
              const t = r.ticket;
              const ic =
                t.status === 'in-progress'
                  ? ['i58', '#B4791E']
                  : t.status === 'wont_do'
                    ? ['i66', '#C4432A']
                    : ['i13', '#5B6B60'];
              return (
                <div key={r.id} {...common}>
                  <span style={{ display: 'flex', color: ic[1] }}>
                    <Icon name={ic[0]} size={16} />
                  </span>
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                      fontWeight: 700,
                      color: '#5B6B60',
                      width: 48,
                      flexShrink: 0,
                    }}
                  >
                    {t.id}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: '#1E2A22',
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t.title}
                  </span>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 11.5,
                      color: '#5B6B60',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: TICKET_DOT[t.status] ?? '#9AA8A0',
                        flexShrink: 0,
                        display: 'inline-block',
                      }}
                    />
                    {TICKET_STATUS_LABEL[t.status] ?? t.status}
                  </span>
                </div>
              );
            }
            if (r.type === 'create')
              return (
                <div key={r.id} {...common}>
                  <span style={{ display: 'flex', color: '#5B6B60' }}>
                    <Icon name="i23" size={16} />
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>
                      Create page &quot;{r.title}&quot;
                    </span>
                    <span style={{ fontSize: 11.5, color: '#5B6B60', whiteSpace: 'nowrap' }}>
                      {currentNode?.parentId
                        ? `Under ${byId.get(currentNode.parentId)?.title ?? 'its parent'}`
                        : 'At the top level'}
                    </span>
                  </span>
                </div>
              );
            const enterKey = on && (
              <span style={{ marginLeft: 'auto', paddingLeft: 6, display: 'inline-flex' }}>
                <span className="dk-kbd">Enter</span>
              </span>
            );
            const two = (title: ReactNode, sub: string) => (
              <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                <span style={ROW_TITLE}>{title}</span>
                {sub && <span style={ROW_SUB}>{sub}</span>}
              </span>
            );
            if (r.type === 'block')
              return (
                <div
                  key={r.id}
                  {...common}
                  data-testid="ref-block-row"
                  style={{ ...common.style, minHeight: 38, padding: '3px 10px', boxSizing: 'border-box' }}
                >
                  <KindTile kind={r.kind} />
                  {two(<Highlight text={r.label} q={sectionQuery} />, r.detail)}
                  {enterKey}
                </div>
              );
            if (r.type === 'section' && rich)
              return (
                <div
                  key={r.id}
                  {...common}
                  data-testid={r.whole ? 'ref-whole-row' : 'ref-heading-row'}
                  style={{
                    ...common.style,
                    minHeight: r.whole ? 34 : 32,
                    padding: `3px 10px 3px ${r.indent ? 24 : 10}px`,
                    boxSizing: 'border-box',
                  }}
                >
                  {r.whole ? (
                    <span style={{ display: 'flex', color: '#2E6F40' }}>
                      <Icon name="i00" size={16} strokeWidth={2} />
                    </span>
                  ) : (
                    <span style={LEVEL}>H{r.level}</span>
                  )}
                  {two(r.whole ? r.text : <Highlight text={r.text} q={sectionQuery} />, r.sub)}
                  {enterKey}
                </div>
              );
            if (r.type === 'section')
              return (
                <div key={r.id} {...common}>
                  {r.indent && <span style={{ width: 18, flexShrink: 0 }} />}
                  <span style={{ display: 'flex', color: r.whole ? '#9AA8A0' : on ? '#2E6F40' : '#9AA8A0' }}>
                    <Icon name={r.whole ? 'i00' : 'i04'} size={r.whole ? 16 : 15} />
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>{r.text}</span>
                    <span style={{ fontSize: 11.5, color: '#5B6B60', whiteSpace: 'nowrap' }}>{r.sub}</span>
                  </span>
                  {(r.whole || on) && (
                    <span
                      style={{
                        marginLeft: 'auto',
                        paddingLeft: 8,
                        fontSize: 11.5,
                        color: '#9AA8A0',
                        whiteSpace: 'nowrap',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      {r.whole ? 'Backspace' : <span className="dk-kbd">Tab</span>}
                    </span>
                  )}
                </div>
              );
            const n = r.node;
            const path = pathOf(n, byId);
            return (
              <div key={r.id} {...common}>
                <span style={{ display: 'flex', color: r.recent ? '#2E6F40' : '#9AA8A0' }}>
                  <Icon name="i00" size={16} />
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>
                    <Highlight text={n.title} q={pageQuery} />
                  </span>
                  <span
                    style={{
                      fontSize: 11.5,
                      color: '#5B6B60',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {path.length > 1 ? path.join(' › ') : 'Top level'}
                  </span>
                </span>
                <span
                  style={{ marginLeft: 'auto', paddingLeft: 8, fontSize: 11.5, color: '#9AA8A0', whiteSpace: 'nowrap' }}
                >
                  {on
                    ? 'Enter'
                    : r.recent
                      ? `edited ${relativeTime(n.updatedAt).replace(/ ago$/, '')} ago`.replace(
                          'edited just now ago',
                          'edited just now',
                        )
                      : new Date(n.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </div>
            );
          })}
        </div>
        {/* ED-8: what Enter inserts is part of the card (above its footer), not a strip over the page below */}
        {preview && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
              padding: '8px 12px',
              borderTop: '1px solid #E3E8E5',
              background: '#FFFFFF',
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: '#5B6B60',
              }}
            >
              Enter inserts
            </div>
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                lineHeight: 1.6,
                padding: '7px 10px',
                borderRadius: 7,
                background: '#F6FAF7',
                border: '1px solid #E3E8E5',
                color: '#3A4A3E',
                overflowWrap: 'anywhere',
              }}
            >
              {state.lineBefore.slice(-60)}
              <span
                style={{
                  color: preview.ticket ? '#6D5DD3' : '#2F6FB0',
                  background: preview.ticket ? 'rgba(109,93,211,0.10)' : 'rgba(47,111,176,0.10)',
                  borderRadius: 3,
                }}
              >
                {preview.token}
              </span>
            </div>
          </div>
        )}
        <MenuFooter>
          <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <span className="dk-kbd">&uarr; &darr;</span>move
          </span>
          <Hint k="Enter">insert</Hint>
          {mode === 'pages' && <Hint k="Tab">complete</Hint>}
          {mode === 'tickets' && <Hint k="Tab">complete key</Hint>}
          {mode === 'sections' && <Hint k="|">display text</Hint>}
          {mode === 'sections' && rich && <Hint k="Backspace">back to pages</Hint>}
          {mode === 'pages' && <Hint k="#">section</Hint>}
          {mode === 'pages' && <Hint k={`${tickets[0]?.id.split('-')[0] ?? 'KAN'}-`}>ticket</Hint>}
          <Hint k="Esc">{mode === 'pages' ? 'cancel' : 'close'}</Hint>
          <button
            type="button"
            onClick={openRefCheatSheet}
            style={{
              marginLeft: 'auto',
              border: 'none',
              background: 'none',
              padding: 0,
              fontFamily: 'inherit',
              fontSize: 11.5,
              fontWeight: 600,
              color: '#2E6F40',
              cursor: 'pointer',
            }}
          >
            Syntax help
          </button>
        </MenuFooter>
      </div>
    </div>
  );
}
