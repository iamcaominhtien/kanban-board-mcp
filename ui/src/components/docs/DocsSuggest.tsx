import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useDocsSuggest } from '../../api/docsActions';
import type { DocsSuggestItem } from '../../types/docsActions';
import { Icon } from './Icon';

/** Query text in bold green inside a title. */
export function boldMatch(text: string, query: string): ReactNode {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <b style={{ color: '#2E6F40' }}>{text.slice(at, at + q.length)}</b>
      {text.slice(at + q.length)}
    </>
  );
}

function subLine(item: DocsSuggestItem): string {
  if (item.kind === 'section') return item.path.join(' › ');
  return item.path.length > 1 ? item.path.join(' › ') : item.path[0] ?? '';
}

/** The pages-and-sections rows shared by the `[[` suggester and the "Link a doc" popover. */
export function SuggestRows({
  items,
  active,
  query,
  onPick,
  onHover,
  loading,
}: {
  items: DocsSuggestItem[];
  active: number;
  query: string;
  onPick: (item: DocsSuggestItem) => void;
  onHover?: (i: number) => void;
  loading?: boolean;
}) {
  if (!items.length) {
    return (
      <div style={{ padding: '10px', fontSize: 12.5, color: '#5B6B60' }}>{loading ? 'Searching…' : query.trim() ? `No pages match “${query.trim()}”` : 'Type to search pages'}</div>
    );
  }
  return (
    <>
      {items.map((it, i) => {
        const on = i === active;
        return (
          <div
            key={`${it.kind}-${it.pageId}-${it.slug ?? ''}-${i}`}
            role="option"
            aria-selected={on}
            data-testid="doc-suggest-item"
            className={`dk-mi ${on ? 'dk-mi-on' : ''}`}
            style={{ gap: 10, padding: '6px 10px' }}
            onMouseEnter={() => onHover?.(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(it);
            }}
          >
            <span style={{ display: 'flex', color: it.kind === 'section' || on ? '#2E6F40' : '#9AA8A0' }}>
              {it.kind === 'section' ? <Icon name="i04" size={15} strokeWidth={2} /> : <Icon name="i00" size={16} strokeWidth={1.8} />}
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>{boldMatch(it.title, query)}</span>
              <span style={{ fontSize: 11.5, color: '#5B6B60', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subLine(it)}</span>
            </span>
            {on && (
              <span style={{ marginLeft: 'auto', paddingLeft: 8, fontSize: 11.5, color: '#9AA8A0', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className="dk-kbd">Enter</span>
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

interface DocLinkSuggesterProps {
  /** The editable element of the host editor. */
  editorRef: RefObject<HTMLElement | null>;
  projectId: string;
  /** Called after the suggester rewrote text in the editor, so the host can sync its value. */
  onChanged: () => void;
}

const OPEN = /\[\[([^[\]\n|]{0,60})$/;

/**
 * Typing `[[` in a contentEditable editor opens a popover of pages and sections; picking one
 * replaces the typed text with `[[Page]]` or `[[Page#Section]]`.
 */
export function DocLinkSuggester({ editorRef, projectId, onChanged }: DocLinkSuggesterProps) {
  const [state, setState] = useState<{ query: string; x: number; y: number } | null>(null);
  const [active, setActive] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const itemsRef = useRef<DocsSuggestItem[]>([]);
  const activeRef = useRef(0);
  activeRef.current = active;

  const suggest = useDocsSuggest(projectId, state?.query ?? '', !!state);
  const items = state ? (suggest.data ?? []) : [];
  itemsRef.current = items;
  useEffect(() => setActive(0), [state?.query]);

  function detect() {
    const el = editorRef.current;
    const sel = window.getSelection();
    if (!el || !sel || !sel.rangeCount || !sel.isCollapsed) return setState(null);
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return setState(null);
    const before = (node.textContent ?? '').slice(0, sel.anchorOffset);
    const m = OPEN.exec(before);
    if (!m) return setState(null);
    const range = sel.getRangeAt(0).cloneRange();
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    setState({ query: m[1], x: Math.max(box.left, rect.left || box.left), y: (rect.bottom || box.top + 24) + 6 });
  }

  function pick(item: DocsSuggestItem) {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (!sel || !node || node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? '';
    const offset = sel.anchorOffset;
    const m = OPEN.exec(text.slice(0, offset));
    if (!m) return;
    const insert = item.kind === 'section' ? `[[${item.pageTitle}#${item.title}]]` : `[[${item.title}]]`;
    const start = offset - m[0].length;
    node.textContent = text.slice(0, start) + insert + text.slice(offset);
    const range = document.createRange();
    range.setStart(node, start + insert.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    setState(null);
    onChanged();
  }
  const pickRef = useRef(pick);
  pickRef.current = pick;

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const onInput = () => detect();
    const onKey = (e: KeyboardEvent) => {
      if (!stateRef.current) return;
      const list = itemsRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setState(null);
      } else if (list.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % list.length : (a - 1 + list.length) % list.length));
      } else if (list.length && (e.key === 'Enter' || e.key === 'Tab')) {
        e.preventDefault();
        e.stopPropagation();
        pickRef.current(list[Math.min(activeRef.current, list.length - 1)]);
      }
    };
    const onClose = () => setState(null);
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKey);
    el.addEventListener('blur', onClose);
    return () => {
      el.removeEventListener('input', onInput);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('blur', onClose);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorRef]);

  // keep the popover inside the viewport
  const boxRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const b = boxRef.current;
    if (!b || !state) return setShift(0);
    const r = b.getBoundingClientRect();
    setShift(r.bottom > window.innerHeight - 8 ? -(r.height + 36) : 0);
  }, [state, items.length]);

  if (!state) return null;
  return (
    <div
      ref={boxRef}
      className="dk-menu docs-root"
      role="listbox"
      aria-label="Link a page"
      style={{ position: 'fixed', left: state.x, top: state.y + shift, width: 330, zIndex: 2000, padding: 5 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <SuggestRows items={items} active={active} query={state.query} onPick={pick} onHover={setActive} loading={suggest.isFetching} />
    </div>
  );
}
