import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import type { MenuHost, MenuState } from './menuHost';
import { filterSlash, type SlashCtx, type SlashItem } from './slashItems';

const GROUP_LABEL = { Text: 'Text', Blocks: 'Blocks', 'Link to': 'Link to' } as const;
const HEAD: React.CSSProperties = {
  padding: '8px 10px 3px',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: '#5B6B60',
};

export function useMenuPosition(rect: DOMRect | null, width: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!rect) return;
    const h = ref.current?.offsetHeight ?? 300;
    const below = rect.bottom + 6;
    const top = below + h > window.innerHeight - 8 && rect.top - 6 - h > 8 ? rect.top - 6 - h : below;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    // runs after every render (the menu height can change), so only update when the spot moved
    setPos((p) => (p && p.top === top && p.left === left ? p : { top, left }));
  });
  return { ref, pos };
}

export function MenuFooter({ children }: { children: React.ReactNode }) {
  return (
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
      {children}
    </div>
  );
}

export const Hint = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
    <span className="dk-kbd">{k}</span>
    {children}
  </span>
);

interface Props {
  host: MenuHost;
  state: MenuState;
  ctx: SlashCtx;
}

/** The "/" block menu (DocsEditor board C). */
export function SlashMenu({ host, state, ctx }: Props) {
  const items = useMemo(() => filterSlash(state.query), [state.query]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { ref, pos } = useMenuPosition(state.rect, 380);

  useEffect(() => setActive(0), [state.query]);

  const choose = (item: SlashItem | undefined) => {
    if (item) state.run(item);
  };
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    host.keyHandler = (e) => {
      const n = itemsRef.current.length;
      if (e.key === 'ArrowDown') {
        if (n) setActive((a) => (a + 1) % n);
        return true;
      }
      if (e.key === 'ArrowUp') {
        if (n) setActive((a) => (a - 1 + n) % n);
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (!n) return false;
        choose(itemsRef.current[activeRef.current]);
        return true;
      }
      return false;
    };
    return () => {
      host.keyHandler = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, state]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  void ctx;
  const filtered = state.query.trim().length > 0;
  let lastGroup = '';
  return (
    <div
      ref={ref}
      className="dk-menu"
      role="listbox"
      aria-label="Insert block"
      data-testid="slash-menu"
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        zIndex: 60,
        width: 380,
        padding: 6,
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {items.length === 0 ? (
        <div style={{ padding: '14px 12px 10px', fontSize: 12.5, color: '#5B6B60', lineHeight: 1.5 }}>
          No blocks match &quot;{state.query}&quot;. Keep typing, or press <span className="dk-kbd">Esc</span> to keep
          it as text.
        </div>
      ) : (
        <div ref={listRef} style={{ maxHeight: 400, overflowY: 'auto' }}>
          {filtered && <div style={HEAD}>Blocks matching &quot;{state.query}&quot;</div>}
          {items.map((it, i) => {
            const head = !filtered && it.group !== lastGroup ? GROUP_LABEL[it.group] : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {head && <div style={HEAD}>{head}</div>}
                <div
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active}
                  className={`dk-mi${i === active ? ' dk-mi-on' : ''}`}
                  style={{ gap: 11, padding: '6px 10px' }}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(it)}
                >
                  <span
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 7,
                      border: '1px solid #E3E8E5',
                      background: '#FFFFFF',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      color: 'text' in it.tile ? '#1E2A22' : (it.tile.color ?? '#5B6B60'),
                      ...('text' in it.tile ? { fontSize: 12, fontWeight: 800 } : null),
                    }}
                  >
                    {'text' in it.tile ? it.tile.text : <Icon name={it.tile.icon} size={16} />}
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>{it.label}</span>
                    <span style={{ fontSize: 11.5, color: '#5B6B60', fontWeight: 400 }}>{it.desc}</span>
                  </span>
                  {it.kbd && (
                    <span className="dk-kbd" style={{ marginLeft: 'auto', whiteSpace: 'pre' }}>
                      {it.kbd}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {items.length > 0 && (
        <MenuFooter>
          <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <span className="dk-kbd">&uarr;</span>
            <span className="dk-kbd">&darr;</span>navigate
          </span>
          <Hint k="Enter">insert</Hint>
          <Hint k="Esc">dismiss</Hint>
        </MenuFooter>
      )}
    </div>
  );
}
