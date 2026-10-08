import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useDocsPage, useDocsTree } from '../../api/docs';
import { useTickets } from '../../api/tickets';
import type { DocsTreeNode } from '../../types/docs';
import { relativeTime } from '../../utils/relativeTime';
import { boldMatch } from './DocsSuggest';
import { useDocsRefs } from './DocsRefsContext';
import { ticketStatus } from './docsUi';
import { Icon } from './Icon';

type Field = HTMLElement | HTMLTextAreaElement | HTMLInputElement;

/** A person offered after `@`; `group` / `note` read "On this ticket · Assignee". */
export interface SuggestMember {
  id: string;
  name: string;
  group?: string;
  note?: string;
  bg?: string;
  color?: string;
}
type Mode = 'page' | 'section' | 'ticket' | 'member';

interface Open {
  mode: Mode;
  query: string;
  /** Text typed so far that the pick replaces (from the trigger to the caret). */
  typed: number;
  x: number;
  y: number;
  top: number;
  pageTitle?: string;
}

interface Item {
  key: string;
  icon: ReactNode;
  title: string;
  sub?: string;
  tag?: string;
  hint?: string;
  group?: string;
  bg?: string;
  color?: string;
  insert: string;
}

const isText = (el: Field): el is HTMLTextAreaElement | HTMLInputElement =>
  el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;

/** Pixel position of the caret in a textarea / input (mirror element technique). */
function textCaretRect(
  el: HTMLTextAreaElement | HTMLInputElement,
  pos: number,
): { left: number; top: number; bottom: number } {
  const cs = window.getComputedStyle(el);
  const mirror = document.createElement('div');
  const props = [
    'boxSizing',
    'width',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'letterSpacing',
    'lineHeight',
    'textTransform',
    'wordSpacing',
    'textIndent',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'tabSize',
  ] as const;
  for (const p of props) (mirror.style as unknown as Record<string, string>)[p] = cs[p];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = el instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre';
  mirror.style.wordWrap = 'break-word';
  mirror.textContent = el.value.slice(0, pos);
  const marker = document.createElement('span');
  marker.textContent = el.value.slice(pos) || '.';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const box = el.getBoundingClientRect();
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
  const left = box.left + marker.offsetLeft - el.scrollLeft;
  const top = box.top + marker.offsetTop - el.scrollTop;
  document.body.removeChild(mirror);
  return { left, top, bottom: top + line };
}

function setNativeValue(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

interface Props {
  /** The field the suggester listens to: a contentEditable editor, a textarea or a single-line input. */
  targetRef: RefObject<Field | null>;
  projectId: string;
  /** Ticket prefix (KAN): typing `KAN-` offers tickets. */
  keyPrefix?: string;
  /** Offered after `@` (comment composer). */
  members?: SuggestMember[];
  /** Called after the pick rewrote the field. */
  onChanged?: () => void;
}

/**
 * One suggester for every text field: `[[` pages, `#` sections of the chosen page, `KAN-` tickets and
 * `@` members. The menu opens under the caret, or above it when there is no room (design: TicketDocRefs D).
 */
export function RefSuggester({ targetRef, projectId, keyPrefix, members, onChanged }: Props) {
  const [state, setState] = useState<Open | null>(null);
  const [active, setActive] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const activeRef = useRef(0);
  activeRef.current = active;
  const itemsRef = useRef<Item[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);

  const tree = useDocsTree(state?.mode === 'page' || state?.mode === 'section' ? projectId : '');
  const tickets = useTickets(state?.mode === 'ticket' ? projectId : '');
  const byId = useMemo(() => new Map((tree.data ?? []).map((n) => [n.id, n])), [tree.data]);
  const pathOf = (n: DocsTreeNode): string[] => {
    const out: string[] = [];
    for (let p = n.parentId ? byId.get(n.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined)
      out.unshift(p.title);
    return out;
  };
  const sectionPage =
    state?.mode === 'section'
      ? (tree.data ?? []).find((n) => n.title.toLowerCase() === (state.pageTitle ?? '').toLowerCase())
      : undefined;
  const page = useDocsPage(sectionPage?.id ?? null);

  const items: Item[] = useMemo(() => {
    if (!state) return [];
    const q = state.query.toLowerCase();
    if (state.mode === 'page') {
      const nodes = (tree.data ?? []).filter((n) => !q || n.title.toLowerCase().includes(q));
      if (!q) nodes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return nodes.slice(0, 8).map((n) => ({
        key: n.id,
        icon: <Icon name="i00" size={16} strokeWidth={1.8} />,
        title: n.title,
        sub: [...pathOf(n), n.title].join(' › '),
        hint: relativeTime(n.updatedAt),
        insert: `[[${n.title}]]`,
      }));
    }
    if (state.mode === 'section') {
      const heads = (page.data?.headings ?? []).filter((h) => !q || h.text.toLowerCase().includes(q));
      const title = sectionPage?.title ?? state.pageTitle ?? '';
      const rows: Item[] = [];
      if (!q)
        rows.push({
          key: '__whole',
          icon: <Icon name="i00" size={15} strokeWidth={1.8} />,
          title: 'Whole page',
          hint: 'Backspace',
          insert: `[[${title}]]`,
        });
      for (const h of heads.slice(0, 8)) {
        rows.push({
          key: h.slug,
          icon: <Icon name="i04" size={15} strokeWidth={2} />,
          title: h.text,
          tag: `H${h.level}`,
          insert: `[[${title}#${h.text}]]`,
        });
      }
      return rows;
    }
    if (state.mode === 'ticket') {
      const list = [...(tickets.data ?? [])].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      return list
        .filter((t) => !q || t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q))
        .slice(0, 6)
        .map((t) => ({
          key: t.id,
          icon: (
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: ticketStatus(t.status).color,
                display: 'inline-block',
              }}
            />
          ),
          title: t.id,
          sub: t.title,
          insert: t.id,
        }));
    }
    const mem = (members ?? []).filter((m) => !q || m.name.toLowerCase().includes(q));
    return mem.slice(0, 8).map((m) => ({
      key: m.id,
      icon: (
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: m.bg ?? '#DCEEE1',
            color: m.color ?? '#2E6F40',
            fontSize: 10,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {m.name
            .split(/\s+/)
            .map((w) => w[0])
            .join('')
            .slice(0, 2)
            .toUpperCase()}
        </span>
      ),
      title: m.name,
      hint: m.note,
      group: m.group,
      insert: `@[${m.name}](member:${m.id})`,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, tree.data, tickets.data, page.data, members]);
  itemsRef.current = items;
  useEffect(() => setActive(0), [state?.query, state?.mode]);

  function detect() {
    const el = targetRef.current;
    if (!el) return;
    let before = '';
    let rect: { left: number; top: number; bottom: number } | null = null;
    if (isText(el)) {
      if (document.activeElement !== el || el.selectionStart !== el.selectionEnd) return setState(null);
      const pos = el.selectionStart ?? 0;
      before = el.value.slice(0, pos);
      rect = textCaretRect(el, pos);
    } else {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return setState(null);
      const node = sel.anchorNode;
      if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return setState(null);
      before = (node.textContent ?? '').slice(0, sel.anchorOffset);
      const r = sel.getRangeAt(0).cloneRange();
      const cr = r.getClientRects()[0] ?? r.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      rect = {
        left: Math.max(box.left, cr.left || box.left),
        top: cr.top || box.top,
        bottom: cr.bottom || box.top + 24,
      };
    }
    let m = /\[\[([^[\]\n|]{0,60})$/.exec(before);
    if (m) {
      const hash = m[1].indexOf('#');
      if (hash >= 0)
        return setState({
          mode: 'section',
          query: m[1].slice(hash + 1),
          pageTitle: m[1].slice(0, hash),
          typed: m[0].length,
          x: rect.left,
          y: rect.bottom + 6,
          top: rect.top,
        });
      return setState({
        mode: 'page',
        query: m[1],
        typed: m[0].length,
        x: rect.left,
        y: rect.bottom + 6,
        top: rect.top,
      });
    }
    if (members) {
      m = /(?:^|\s)@([\p{L}\p{N} ._-]{0,30})$/u.exec(before);
      if (m)
        return setState({
          mode: 'member',
          query: m[1],
          typed: m[1].length + 1,
          x: rect.left,
          y: rect.bottom + 6,
          top: rect.top,
        });
    }
    if (keyPrefix) {
      m = new RegExp(`(?:^|[^\\w-])(${keyPrefix}-\\d*)$`).exec(before);
      if (m)
        return setState({
          mode: 'ticket',
          query: m[1].slice(keyPrefix.length + 1),
          typed: m[1].length,
          x: rect.left,
          y: rect.bottom + 6,
          top: rect.top,
        });
    }
    setState(null);
  }

  function pick(item: Item) {
    const el = targetRef.current;
    const st = stateRef.current;
    if (!el || !st) return;
    if (isText(el)) {
      const pos = el.selectionStart ?? 0;
      const start = pos - st.typed;
      setNativeValue(el, el.value.slice(0, start) + item.insert + el.value.slice(pos));
      const caret = start + item.insert.length;
      el.setSelectionRange(caret, caret);
    } else {
      const sel = window.getSelection();
      const node = sel?.anchorNode;
      if (!sel || !node || node.nodeType !== Node.TEXT_NODE) return;
      const text = node.textContent ?? '';
      const offset = sel.anchorOffset;
      const start = offset - st.typed;
      node.textContent = text.slice(0, start) + item.insert + text.slice(offset);
      const range = document.createRange();
      range.setStart(node, start + item.insert.length);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    setState(null);
    onChanged?.();
  }
  const pickRef = useRef(pick);
  pickRef.current = pick;

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;
    const onInput = () => detect();
    const onKey = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (!stateRef.current) return;
      const list = itemsRef.current;
      if (ke.key === 'Escape') {
        ke.preventDefault();
        ke.stopPropagation();
        setState(null);
      } else if (list.length && (ke.key === 'ArrowDown' || ke.key === 'ArrowUp')) {
        ke.preventDefault();
        ke.stopPropagation();
        setActive((a) => (ke.key === 'ArrowDown' ? (a + 1) % list.length : (a - 1 + list.length) % list.length));
      } else if (list.length && (ke.key === 'Enter' || ke.key === 'Tab')) {
        ke.preventDefault();
        ke.stopPropagation();
        pickRef.current(list[Math.min(activeRef.current, list.length - 1)]);
      }
    };
    const onClose = () => setState(null);
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKey, true);
    el.addEventListener('blur', onClose);
    el.addEventListener('click', onInput);
    return () => {
      el.removeEventListener('input', onInput);
      el.removeEventListener('keydown', onKey, true);
      el.removeEventListener('blur', onClose);
      el.removeEventListener('click', onInput);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRef.current, keyPrefix, members]);

  // open under the caret; above it when there is no room (design D case 2)
  useLayoutEffect(() => {
    const b = boxRef.current;
    if (!b || !state) return setFlip(false);
    const h = b.getBoundingClientRect().height;
    setFlip(state.y + h > window.innerHeight - 8 && state.top - 6 - h > 8);
  }, [state, items.length]);

  if (!state) return null;
  const heading =
    state.mode === 'page'
      ? state.query
        ? 'Pages'
        : 'Recent pages'
      : state.mode === 'section'
        ? `Sections in ${sectionPage?.title ?? state.pageTitle}`
        : state.mode === 'ticket'
          ? 'Tickets'
          : 'Members';
  const aria =
    state.mode === 'page'
      ? 'Link a page'
      : state.mode === 'section'
        ? 'Link a section'
        : state.mode === 'ticket'
          ? 'Link a ticket'
          : 'Mention a member';
  const empty =
    state.mode === 'section' && !sectionPage
      ? `No page named “${state.pageTitle}”`
      : state.query
        ? `Nothing matches “${state.query}”`
        : 'Nothing to show';
  const left = Math.max(8, Math.min(state.x, window.innerWidth - 338));
  return (
    <div
      ref={boxRef}
      className="dk-menu docs-root"
      role="listbox"
      aria-label={aria}
      data-testid="ref-suggester"
      style={{
        position: 'fixed',
        left,
        top: flip ? undefined : state.y,
        bottom: flip ? window.innerHeight - state.top + 6 : undefined,
        width: 330,
        zIndex: 2000,
        padding: 5,
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {state.mode !== 'member' && (
        <div
          style={{
            padding: '6px 10px 4px',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: '#5B6B60',
          }}
        >
          {heading}
          {state.mode === 'ticket' && (
            <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500, color: '#9AA8A0', marginLeft: 6 }}>
              recent first
            </span>
          )}
        </div>
      )}
      {items.length === 0 ? (
        <div style={{ padding: '8px 10px', fontSize: 12.5, color: '#5B6B60' }}>{empty}</div>
      ) : (
        items.map((it, i) => {
          const on = i === active;
          const newGroup = it.group && it.group !== items[i - 1]?.group;
          return (
            <div key={it.key}>
              {newGroup && (
                <div
                  style={{
                    padding: '8px 10px 3px',
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: '#5B6B60',
                  }}
                >
                  {it.group}
                </div>
              )}
              <div
                role="option"
                aria-selected={on}
                data-testid="doc-suggest-item"
                className={`dk-mi ${on ? 'dk-mi-on' : ''}`}
                style={{ gap: 10, padding: '6px 10px' }}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(it);
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 18,
                    color: on ? '#2E6F40' : '#9AA8A0',
                  }}
                >
                  {it.icon}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: '#1E2A22',
                      fontFamily: state.mode === 'ticket' ? 'var(--font-mono)' : undefined,
                    }}
                  >
                    {boldMatch(it.title, state.mode === 'section' ? state.query : state.query)}
                  </span>
                  {it.sub && (
                    <span
                      style={{
                        fontSize: 11.5,
                        color: '#5B6B60',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {it.sub}
                    </span>
                  )}
                </span>
                {it.tag && <span className="dk-kbd">{it.tag}</span>}
                {(on || it.hint) && !it.tag && (
                  <span style={{ fontSize: 11.5, color: '#9AA8A0', whiteSpace: 'nowrap' }}>
                    {on && state.mode === 'section' && i === 0 ? <span className="dk-kbd">Tab</span> : it.hint}
                  </span>
                )}
                {it.tag && on && <span className="dk-kbd">Tab</span>}
              </div>
            </div>
          );
        })
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '4px 12px',
          padding: '7px 10px 3px',
          marginTop: 3,
          borderTop: '1px solid #EEF3EF',
          fontSize: 11.5,
          color: '#5B6B60',
        }}
      >
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <span className="dk-kbd">↑↓</span> move
        </span>
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <span className="dk-kbd">Enter</span> insert
        </span>
        {state.mode === 'section' ? (
          <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <span className="dk-kbd">|</span> display text
          </span>
        ) : (
          <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <span className="dk-kbd">Esc</span> close
          </span>
        )}
      </div>
    </div>
  );
}

/** The suggester wired to the surrounding ticket (project and ticket prefix come from the context). */
export function TicketRefSuggester({
  targetRef,
  onChanged,
}: {
  targetRef: RefObject<Field | null>;
  onChanged?: () => void;
}) {
  const refs = useDocsRefs();
  if (!refs) return null;
  return (
    <RefSuggester
      targetRef={targetRef}
      projectId={refs.projectId}
      keyPrefix={refs.ticketId?.split('-')[0]}
      onChanged={onChanged}
    />
  );
}
