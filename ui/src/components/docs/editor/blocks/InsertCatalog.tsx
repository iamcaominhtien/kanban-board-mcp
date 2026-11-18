/**
 * The Insert catalog (board K 56–59, L 63): everything a page can hold, in one searchable list grouped by what it is
 * for. "/" on a line, the plus beside a block, Ctrl+/ and the ribbon's Insert open it. A palette with a group rail
 * under the cursor on a desktop (a narrow list once you type), a centred dialog with a chip row on a tablet, a bottom
 * sheet four tiles across on a phone. Typing narrows it in place; the first match is selected; Enter inserts.
 */

import { exitSuggestion } from '@tiptap/suggestion';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../Icon';
import type { MenuHost, MenuState } from '../menuHost';
import {
  SLASH_GROUPS,
  filterSlash,
  recentSlashIds,
  rememberSlash,
  type SlashCtx,
  type SlashGroup,
  type SlashItem,
} from '../slashItems';
import { askBlockUi, blockKitOf } from './bus';
import type { TableSize } from './commands';
import { TableSizePicker } from './TableSizePicker';
import { useBlockLayout } from './ui';
import './blocks.css';

/** The rows the phone sheet shows first, before "Show all". */
const POPULAR = ['image', 'table', 'task', 'callout-info', 'columns', 'code', 'file', 'diagram'];

/**
 * An item's tile: its text (H1…) or its icon.
 * @param props.size - The tile's side in px.
 * @param props.iconSize - The icon's size in px (default: about half the tile).
 */
export function ItemTile({ item, size = 32, iconSize }: { item: SlashItem; size?: number; iconSize?: number }) {
  const text = 'text' in item.tile ? item.tile.text : null;
  return (
    <span
      className="dk-cat-tile"
      style={{
        width: size,
        height: size,
        color: 'color' in item.tile && item.tile.color ? item.tile.color : '#2E6F40',
        fontSize: text && text.length > 2 ? 10.5 : 11.5,
      }}
    >
      {text ?? ('icon' in item.tile ? <Icon name={item.tile.icon} size={iconSize ?? Math.round(size * 0.53)} /> : null)}
    </span>
  );
}

/** The label with the first match of the typed words marked (Blocks board, frame 57). */
function marked(label: string, q: string): ReactNode {
  const i = q ? label.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return label;
  return (
    <>
      {label.slice(0, i)}
      <b className="dk-cat-hit">{label.slice(i, i + q.length)}</b>
      {label.slice(i + q.length)}
    </>
  );
}

interface Props {
  host: MenuHost;
  state: MenuState;
  ctx: SlashCtx;
  /** Positions the desktop palette by the cursor (the hook useMenuPosition of SlashMenu). */
  usePosition: (
    rect: DOMRect | null,
    width: number,
  ) => { ref: React.RefObject<HTMLDivElement>; pos: { top: number; left: number } | null };
}

/**
 * The catalog. The suggestion plugin keeps it open while the "/" and the query are there; picking a row runs it in
 * place of them.
 */
export function InsertCatalog({ host, state, ctx, usePosition }: Props) {
  const layout = useBlockLayout();
  const desktop = layout === 'desktop';
  const [typed, setTyped] = useState<string | null>(null);
  const query = desktop || typed === null ? state.query : typed;
  const filtering = query.trim().length > 0;
  const opts = useMemo(
    () => ({ ai: ctx.ai, withAi: !!ctx.openAi, rich: ctx.rich !== false }),
    [ctx.ai, ctx.openAi, ctx.rich],
  );
  const everything = useMemo(() => filterSlash('', opts), [opts]);
  const matches = useMemo(() => filterSlash(query, opts), [query, opts]);
  const groups = useMemo(() => SLASH_GROUPS.filter((g) => everything.some((i) => i.group === g)), [everything]);
  const [group, setGroup] = useState<'All' | SlashGroup>('All');
  const [showAll, setShowAll] = useState(false);
  const visible = useMemo(() => {
    if (filtering || group === 'All') {
      if (layout === 'phone' && !filtering && !showAll && group === 'All') {
        const pop = POPULAR.map((id) => everything.find((i) => i.id === id)).filter((i): i is SlashItem => !!i);
        return pop;
      }
      return matches;
    }
    return matches.filter((i) => i.group === group);
  }, [filtering, group, matches, layout, showAll, everything]);
  const recent = useMemo(
    () =>
      filtering
        ? []
        : recentSlashIds()
            .map((id) => everything.find((i) => i.id === id))
            .filter((i): i is SlashItem => !!i),
    [filtering, everything],
  );
  const [active, setActive] = useState(0);
  const [step, setStep] = useState<SlashItem | null>(null);
  const [size, setSize] = useState<TableSize>({
    rows: 3,
    cols: 3,
    headerRow: true,
    headerColumn: false,
    fullWidth: false,
  });
  const listRef = useRef<HTMLDivElement>(null);
  const width = desktop ? (filtering || step ? 380 : 900) : 0;
  const { ref, pos } = usePosition(desktop ? state.rect : null, width || 380);

  useEffect(() => setActive(0), [query, group]);

  const insert = (item: SlashItem, table?: TableSize) => {
    rememberSlash(item.id);
    state.run({
      ...item,
      run: (e, r, c) =>
        item.run(e, r, {
          ...c,
          pickFile: c.pickFile ?? ctx.pickFile,
          insertImage: blockKitOf(e) ? () => askBlockUi(e, { type: 'insertImage' }) : c.insertImage,
          table,
        }),
    } satisfies SlashItem);
  };
  const choose = (item: SlashItem | undefined) => {
    if (!item) return;
    if (item.step === 'table') {
      setStep(item);
      return;
    }
    insert(item);
  };
  const close = () => {
    if (host.pluginKey) exitSuggestion(state.editor.view, host.pluginKey);
    state.editor.commands.focus();
  };

  const live = useRef({ visible, active, step, size, choose, insert });
  live.current = { visible, active, step, size, choose, insert };
  const onKey = (e: KeyboardEvent | React.KeyboardEvent): boolean => {
    const L = live.current;
    if (L.step) {
      const d = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] }[e.key];
      if (d) {
        setSize((s) => ({
          ...s,
          rows: Math.max(1, Math.min(20, s.rows + d[0])),
          cols: Math.max(1, Math.min(10, s.cols + d[1])),
        }));
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        L.insert(L.step, L.size);
        return true;
      }
      return false;
    }
    const n = L.visible.length;
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
      L.choose(L.visible[L.active]);
      return true;
    }
    return false;
  };
  useEffect(() => {
    host.keyHandler = (e) => onKey(e);
    return () => {
      host.keyHandler = null;
    };
  }, [host, state]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const footer = (
    <div className="dk-cat-foot">
      <span>
        <span className="dk-kbd">&uarr;</span>
        <span className="dk-kbd">&darr;</span> navigate
      </span>
      <span>
        <span className="dk-kbd">Enter</span> insert
      </span>
      <span>
        <span className="dk-kbd">Esc</span> dismiss
      </span>
      {!filtering && <span style={{ marginLeft: 'auto' }}>{everything.length} blocks</span>}
    </div>
  );

  const empty = (
    <div className="dk-cat-empty">
      No blocks match &quot;{query}&quot;. Keep typing, or press <span className="dk-kbd">Esc</span> to keep it as text.
    </div>
  );

  const rows = (big: boolean) => {
    let last = '';
    return visible.map((it, i) => {
      const head = !filtering && group === 'All' && it.group !== last ? it.group : null;
      last = it.group;
      return (
        <Fragment key={it.id}>
          {head && <div className="dk-cat-head">{head}</div>}
          <div
            role="option"
            aria-selected={i === active}
            data-active={i === active}
            className={`dk-mi dk-cat-row${i === active ? ' dk-mi-on' : ''}${big ? ' dk-cat-row-big' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(it)}
          >
            <ItemTile item={it} size={32} />
            <span className="dk-cat-text">
              <span className="dk-cat-label">{filtering ? marked(it.label, query.trim()) : it.label}</span>
              <span className="dk-cat-desc">{it.desc}</span>
            </span>
            {it.kbd && <span className="dk-cat-kbd">{it.kbd}</span>}
          </div>
        </Fragment>
      );
    });
  };

  const tableStep = step && (
    <TableSizePicker
      size={size}
      onChange={setSize}
      onInsert={(picked) => insert(step, picked ?? size)}
      onBack={() => setStep(null)}
      steppers={layout === 'phone'}
    />
  );

  const chips = (
    <div className="dk-cat-chips" role="tablist" aria-label="Groups">
      {(['All', ...groups] as const).map((g) => (
        <button
          key={g}
          type="button"
          role="tab"
          aria-selected={group === g}
          className={group === g ? 'on' : undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setGroup(g)}
        >
          {g}
        </button>
      ))}
    </div>
  );

  const search = (
    <div className="dk-cat-search">
      <Icon name="search" size={16} strokeWidth={2} />
      {desktop ? (
        <span className={query ? 'dk-cat-q' : 'dk-cat-ph'}>{query || 'Search blocks'}</span>
      ) : (
        <input
          type="search"
          aria-label="Search blocks"
          placeholder="Search blocks"
          value={query}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
              return;
            }
            if (onKey(e)) e.preventDefault();
          }}
        />
      )}
      {layout === 'tablet' ? (
        <button
          type="button"
          className="dk-cat-x"
          aria-label="Close"
          onMouseDown={(e) => e.preventDefault()}
          onClick={close}
        >
          <Icon name="close" size={20} strokeWidth={2} />
        </button>
      ) : layout === 'phone' ? null : (
        <span className="dk-kbd">Esc</span>
      )}
    </div>
  );

  let content: ReactNode;
  if (layout === 'phone') {
    content = (
      <div className="dk-bp-overlay" data-block-ui="">
        <div className="dk-bp-scrim" onMouseDown={close} />
        <div
          ref={ref}
          className="dk-bp dk-bp-sheet dk-cat dk-cat-phone"
          role="listbox"
          aria-label="Insert block"
          data-testid="slash-menu"
          onMouseDown={(e) => {
            if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
          }}
        >
          <div className="dk-bp-grab" aria-hidden="true" />
          <div className="dk-bp-head">
            <span>Insert</span>
          </div>
          {step ? (
            tableStep
          ) : (
            <>
              {search}
              {chips}
              {!filtering && group === 'All' && !showAll && <div className="dk-cat-head">Popular</div>}
              <div ref={listRef} className="dk-cat-grid">
                {visible.length === 0
                  ? empty
                  : visible.map((it, i) => (
                      <button
                        key={it.id}
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        data-active={i === active}
                        className={`dk-cat-cell${i === active ? ' on' : ''}`}
                        onClick={() => choose(it)}
                      >
                        <ItemTile item={it} size={24} iconSize={24} />
                        <span>{it.label}</span>
                      </button>
                    ))}
              </div>
              {!filtering && group === 'All' && !showAll && (
                <button type="button" className="dk-cat-more" onClick={() => setShowAll(true)}>
                  Show all {everything.length} blocks
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  } else if (layout === 'tablet') {
    content = (
      <div className="dk-bp-overlay dk-bp-overlay-center" data-block-ui="">
        <div className="dk-bp-scrim" onMouseDown={close} />
        <div
          ref={ref}
          className="dk-bp dk-bp-dialog dk-cat dk-cat-tablet"
          role="listbox"
          aria-label="Insert block"
          data-testid="slash-menu"
          onMouseDown={(e) => {
            if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
          }}
        >
          {step ? (
            tableStep
          ) : (
            <>
              {search}
              {!filtering && chips}
              <div ref={listRef} className="dk-cat-list dk-cat-two">
                {visible.length === 0 ? empty : rows(true)}
              </div>
            </>
          )}
        </div>
      </div>
    );
  } else {
    content = (
      <div
        ref={ref}
        className={`dk-menu dk-cat dk-cat-desk${filtering || step ? ' dk-cat-narrow' : ''}`}
        role="listbox"
        aria-label="Insert block"
        data-testid="slash-menu"
        onMouseDown={(e) => e.preventDefault()}
        style={{
          width,
          top: pos?.top ?? -9999,
          left: pos?.left ?? -9999,
          visibility: pos ? 'visible' : 'hidden',
        }}
      >
        {step ? (
          tableStep
        ) : filtering ? (
          <>
            {visible.length > 0 && <div className="dk-cat-match">Blocks matching &quot;{query}&quot;</div>}
            <div ref={listRef} className="dk-cat-list" style={{ maxHeight: 360 }}>
              {visible.length === 0 ? empty : rows(false)}
            </div>
            {visible.length > 0 && <div className="dk-cat-rule" />}
            {visible.length > 0 && footer}
          </>
        ) : (
          <>
            {search}
            <div className="dk-cat-body">
              <div className="dk-cat-rail" role="tablist" aria-label="Groups">
                {(['All', ...groups] as const).map((g) => (
                  <button
                    key={g}
                    type="button"
                    role="tab"
                    aria-selected={group === g}
                    className={group === g ? 'on' : undefined}
                    onClick={() => setGroup(g)}
                  >
                    {g}
                  </button>
                ))}
              </div>
              <div ref={listRef} className="dk-cat-list dk-cat-two">
                {recent.length > 0 && group === 'All' && (
                  <>
                    <div className="dk-cat-head">Recent</div>
                    <div className="dk-cat-recent">
                      {recent.map((it) => (
                        <button key={it.id} type="button" className="dk-cat-chip" onClick={() => choose(it)}>
                          {it.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {rows(false)}
              </div>
            </div>
            {footer}
          </>
        )}
      </div>
    );
  }
  return content;
}
