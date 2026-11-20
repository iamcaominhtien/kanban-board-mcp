import type { Editor } from '@tiptap/react';
import { CellSelection } from '@tiptap/pm/tables';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  canMergeCells,
  canSplitCell,
  cellAt,
  mergeSelectedCells,
  selectedCellCount,
  setCellsAttr,
  splitSelectedCell,
} from './blocks/commands';
import { CellProps, PhoneTableBar, TIcon, T_ICONS, TableProps, TableStyles } from './blocks/TableTools';
import { useBlockLayout } from './blocks/ui';

interface Geo {
  table: { left: number; top: number; width: number; height: number };
  cols: { left: number; width: number }[];
  rows: { top: number; height: number }[];
  /** selected column / row ranges, when a whole column or row is selected */
  selCols: [number, number] | null;
  selRows: [number, number] | null;
  /** column / row of the cell that holds the caret (not a cell selection) */
  caret: { col: number; row: number } | null;
  /** column / row of the cell the cell selection started in */
  anchor: { col: number; row: number } | null;
  anySel: boolean;
}

function cellIndexOf(dom: HTMLElement | null): { col: number; row: number } | null {
  const cell = dom?.closest('td,th') as HTMLTableCellElement | null;
  if (!cell) return null;
  return { col: cell.cellIndex, row: (cell.parentElement as HTMLTableRowElement).rowIndex };
}

/**
 * Column/row grips, insert handles and the cell toolbar for the table that holds the caret (board G).
 * @param props.editor - Tiptap editor holding the table.
 * @param props.hostRef - Container the controls are positioned in.
 */
export function TableControls({ editor, hostRef }: { editor: Editor; hostRef: RefObject<HTMLDivElement> }) {
  const [geo, setGeo] = useState<Geo | null>(null);
  // Rich Docs phase 4: Cell properties / Table properties panels, and the phone's bar under a selected cell
  const [panel, setPanel] = useState<{ kind: 'cell' | 'table' | 'styles'; anchor: DOMRect } | null>(null);
  const layout = useBlockLayout();
  // a panel closed (Done, Esc): the caret goes back into the table, so typing carries on there
  const closePanel = useCallback(() => {
    setPanel(null);
    if (!editor.isDestroyed) editor.commands.focus();
  }, [editor]);
  // The overlay fills the editor column (inset 0), which sits below the page header inside the host; positions
  // are measured against it, not against the host.
  const layerRef = useRef<HTMLDivElement>(null);

  const compute = useCallback(() => {
    const host = layerRef.current;
    if (!host || !editor.isEditable || editor.isDestroyed) return setGeo(null);
    const { selection } = editor.state;
    const { $from } = selection;
    let depth = $from.depth;
    while (depth > 0 && $from.node(depth).type.name !== 'table') depth -= 1;
    if (depth === 0) return setGeo(null);
    const wrap = editor.view.nodeDOM($from.before(depth)) as HTMLElement | null;
    const table = wrap?.querySelector('table');
    if (!table) return setGeo(null);
    const h = host.getBoundingClientRect();
    const t = table.getBoundingClientRect();
    const rows = Array.from(table.rows);
    if (!rows.length) return setGeo(null);
    const cols = Array.from(rows[0].cells).map((c) => {
      const r = c.getBoundingClientRect();
      return { left: r.left - h.left, width: r.width };
    });
    const rws = rows.map((r) => {
      const b = r.getBoundingClientRect();
      return { top: b.top - h.top, height: b.height };
    });
    let selCols: [number, number] | null = null;
    let selRows: [number, number] | null = null;
    let anchor: Geo['anchor'] = null;
    if (selection instanceof CellSelection) {
      const a = cellIndexOf(editor.view.nodeDOM(selection.$anchorCell.pos) as HTMLElement);
      const b = cellIndexOf(editor.view.nodeDOM(selection.$headCell.pos) as HTMLElement);
      anchor = a;
      if (a && b) {
        if (selection.isColSelection()) selCols = [Math.min(a.col, b.col), Math.max(a.col, b.col)];
        else if (selection.isRowSelection()) selRows = [Math.min(a.row, b.row), Math.max(a.row, b.row)];
        else {
          selCols = null;
        }
      }
    }
    let caret: Geo['caret'] = null;
    if (!(selection instanceof CellSelection)) {
      const node = editor.view.domAtPos(selection.from).node;
      caret = cellIndexOf(node instanceof HTMLElement ? node : node.parentElement);
    }
    setGeo({
      table: { left: t.left - h.left, top: t.top - h.top, width: t.width, height: t.height },
      cols,
      rows: rws,
      selCols,
      selRows,
      caret,
      anchor,
      anySel: selection instanceof CellSelection,
    });
  }, [editor]);

  // while the table has its handles, the block handle steps aside (CSS: [data-table-controls] .dk-handle)
  const shown = !!geo;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    if (shown) host.setAttribute('data-table-controls', '');
    else host.removeAttribute('data-table-controls');
    return () => host.removeAttribute('data-table-controls');
  }, [shown, hostRef]);

  useEffect(() => {
    compute();
    editor.on('transaction', compute);
    window.addEventListener('resize', compute);
    // Chips, images and fonts resolve after the selection changes and move the table; follow the content, not just
    // the transactions, or the grips and "+" handles drift away from their rows.
    const ro = typeof ResizeObserver !== 'undefined' && hostRef.current ? new ResizeObserver(compute) : null;
    if (ro && hostRef.current) ro.observe(hostRef.current);
    if (ro) ro.observe(editor.view.dom);
    return () => {
      editor.off('transaction', compute);
      window.removeEventListener('resize', compute);
      ro?.disconnect();
    };
  }, [editor, compute, hostRef]);

  if (!geo) return <div ref={layerRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />;
  const splitable = canSplitCell(editor);
  const phone = layout === 'phone';

  const tableOf = () => {
    const { $from } = editor.state.selection;
    let depth = $from.depth;
    while (depth > 0 && $from.node(depth).type.name !== 'table') depth -= 1;
    return (editor.view.nodeDOM($from.before(depth)) as HTMLElement | null)?.querySelector('table') as
      HTMLTableElement | null | undefined;
  };
  const cellPos = (r: number, c: number) => {
    const cell = tableOf()?.rows[r]?.cells[c];
    if (!cell) return null;
    return editor.view.posAtDOM(cell, 0);
  };
  const cellStart = (r: number, c: number) => {
    const inside = cellPos(r, c);
    if (inside == null) return null;
    const $p = editor.state.doc.resolve(inside);
    for (let d = $p.depth; d > 0; d -= 1) {
      const n = $p.node(d).type.name;
      if (n === 'tableCell' || n === 'tableHeader') return $p.before(d);
    }
    return null;
  };
  const selectCol = (c: number) => {
    const start = cellStart(0, c);
    if (start == null) return;
    const $c = editor.state.doc.resolve(start);
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.colSelection($c)));
    editor.view.focus();
  };
  const selectRow = (r: number) => {
    const start = cellStart(r, 0);
    if (start == null) return;
    const $c = editor.state.doc.resolve(start);
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.rowSelection($c)));
    editor.view.focus();
  };
  const caretIn = (r: number, c: number) => {
    const p = cellPos(r, c);
    if (p != null) editor.chain().focus().setTextSelection(p).run();
  };

  const lastCol = geo.cols.length - 1;
  const lastRow = geo.rows.length - 1;
  const tablet = layout === 'tablet';
  // the handles (Blocks board, F 27 desktop: 10 px bars 17 px out; L 61 tablet: 14 px bars 20 px out)
  const bar = tablet ? 14 : 10;
  const out = tablet ? 20 : 17;
  const focus = geo.caret ?? geo.anchor;
  const colOn = (i: number) =>
    geo.selCols ? i >= geo.selCols[0] && i <= geo.selCols[1] : !geo.selRows && focus?.col === i;
  const rowOn = (i: number) =>
    geo.selRows ? i >= geo.selRows[0] && i <= geo.selRows[1] : !geo.selCols && focus?.row === i;
  const plusCol = geo.selCols ? geo.selCols[1] : (focus?.col ?? lastCol);
  const c = () => editor.chain().focus();
  const handle = (on: boolean): React.CSSProperties => ({
    position: 'absolute',
    pointerEvents: 'auto',
    borderRadius: bar / 2,
    background: on ? '#2E6F40' : '#C7D2CB',
    cursor: 'pointer',
    border: 'none',
    padding: 0,
  });
  const showBar = (geo.anySel || splitable) && !phone;

  return (
    <div
      ref={layerRef}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 8 }}
      data-testid="table-controls"
    >
      {!phone &&
        geo.cols.map((col, i) => (
          <button
            key={`c${i}`}
            type="button"
            aria-label={`Select column ${i + 1}`}
            className="dk-table-grip"
            style={{
              ...handle(colOn(i)),
              left: col.left + 3,
              width: col.width - 6,
              top: geo.table.top - out,
              height: bar,
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => selectCol(i)}
          />
        ))}
      {!phone &&
        geo.rows.map((row, i) => (
          <button
            key={`r${i}`}
            type="button"
            aria-label={`Select row ${i + 1}`}
            className="dk-table-grip"
            style={{
              ...handle(rowOn(i)),
              top: row.top + 3,
              height: row.height - 6,
              left: geo.table.left - out,
              width: bar,
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => selectRow(i)}
          />
        ))}
      <button
        type="button"
        aria-label="Table properties"
        title="Table properties"
        className="dk-table-corner"
        data-block-ui=""
        style={{ left: geo.table.left - out, top: geo.table.top - out, width: bar, height: bar }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => setPanel({ kind: 'table', anchor: e.currentTarget.getBoundingClientRect() })}
      />
      {panel?.kind === 'table' && <TableProps editor={editor} anchor={panel.anchor} onClose={closePanel} />}
      {panel?.kind === 'cell' && <CellProps editor={editor} anchor={panel.anchor} onClose={closePanel} />}
      {panel?.kind === 'styles' && <TableStyles editor={editor} anchor={panel.anchor} onClose={closePanel} />}
      {phone && <PhoneTableBar editor={editor} />}
      {!phone && (
        <button
          type="button"
          aria-label="Add column"
          title="Add column"
          className="dk-table-plus"
          style={{
            left: geo.cols[plusCol].left + geo.cols[plusCol].width - 9,
            top: geo.table.top - out - (18 - bar) / 2,
          }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            caretIn(0, plusCol);
            c().addColumnAfter().run();
          }}
        >
          <svg
            aria-hidden="true"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="3"
            strokeLinecap="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}
      <button
        type="button"
        aria-label="Add row"
        title="Add row"
        className="dk-table-plus dk-table-plus-row"
        style={{ left: geo.table.left - out - 9 + bar / 2, top: geo.table.top + geo.table.height + 2 }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          caretIn(lastRow, 0);
          c().addRowAfter().run();
        }}
      >
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="3"
          strokeLinecap="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

      {showBar && (
        <CellToolbar
          editor={editor}
          tablet={tablet}
          left={geo.selCols ? geo.cols[geo.selCols[0]].left : geo.table.left}
          bottom={geo.table.top - out - 10}
          selRows={!!geo.selRows}
          selCols={!!geo.selCols}
          onPanel={(kind, anchor) => setPanel({ kind, anchor })}
        />
      )}
    </div>
  );
}

/**
 * The bar over the selected cells (Blocks board, F 28; tablet L 61 with 44 px buttons): Merge cells, Split, Shading
 * and Borders (Cell properties), text alignment, vertical alignment, add a row or a column, delete, the cell count
 * and the table's style.
 */
function CellToolbar({
  editor,
  tablet,
  left,
  bottom,
  selRows,
  selCols,
  onPanel,
}: {
  editor: Editor;
  tablet: boolean;
  /** Left edge, in the overlay's px. */
  left: number;
  /** Where its bottom edge goes, in the overlay's px from the top. */
  bottom: number;
  selRows: boolean;
  selCols: boolean;
  onPanel: (kind: 'cell' | 'styles', anchor: DOMRect) => void;
}) {
  const [tip, setTip] = useState<string | null>(null);
  const merge = canMergeCells(editor);
  const split = canSplitCell(editor);
  const n = Math.max(1, selectedCellCount(editor.state));
  const cell = cellAt(editor.state);
  const a = (cell?.node.attrs ?? {}) as Record<string, unknown>;
  const align = (a.align as string | null) ?? 'left';
  const valign = (a.verticalAlign as string | null) ?? 'middle';
  const c = () => editor.chain().focus();
  const isz = tablet ? 19 : 15;
  const btn = (
    label: string,
    icon: ReactNode,
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void,
    opts: { on?: boolean; danger?: boolean; disabled?: boolean; testId?: string } = {},
  ) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={opts.on}
      aria-disabled={opts.disabled || undefined}
      data-testid={opts.testId}
      className={`dk-ctb-btn${opts.on ? ' on' : ''}${opts.danger ? ' danger' : ''}${opts.disabled ? ' off' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => setTip(label)}
      onMouseLeave={() => setTip(null)}
      onClick={opts.disabled ? undefined : onClick}
    >
      <TIcon size={isz}>{icon}</TIcon>
    </button>
  );
  const sep = <span className="dk-ctb-sep" />;
  return (
    <div
      data-block-ui=""
      data-testid="cell-toolbar"
      role="toolbar"
      aria-label="Cells"
      className={`dk-ctb${tablet ? ' dk-ctb-tablet' : ''}`}
      style={{ left, top: bottom, transform: 'translateY(-100%)' }}
    >
      {tip && <div className="dk-tt dk-ctb-tip">{tip}</div>}
      <button
        type="button"
        className={`dk-ctb-merge${merge === 'ok' ? '' : ' off'}`}
        aria-label="Merge cells"
        aria-disabled={merge !== 'ok' || undefined}
        data-testid="merge-cells"
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() =>
          setTip(merge === 'ok' ? `Merge cells · ${n} cells` : 'Select a rectangle of cells to merge')
        }
        onMouseLeave={() => setTip(null)}
        onClick={() => {
          if (mergeSelectedCells(editor) !== 'ok') setTip('Merge not available · Select a rectangle of cells to merge');
        }}
      >
        <TIcon size={tablet ? 18 : 15} sw={2.2}>
          {T_ICONS.merge}
        </TIcon>
        Merge cells
      </button>
      {btn('Split cell', T_ICONS.split, () => splitSelectedCell(editor), {
        disabled: !split,
        testId: split ? 'split-cell' : undefined,
      })}
      {sep}
      {btn('Shading', T_ICONS.shade, (e) => onPanel('cell', e.currentTarget.getBoundingClientRect()))}
      {btn('Cell properties', T_ICONS.borders, (e) => onPanel('cell', e.currentTarget.getBoundingClientRect()))}
      {sep}
      {(['left', 'center', 'right'] as const).map((v) => (
        <Fragment key={v}>
          {btn(
            v === 'left' ? 'Align left' : v === 'center' ? 'Align centre' : 'Align right',
            T_ICONS[v],
            () => setCellsAttr(editor, 'align', v === 'left' ? null : v),
            { on: align === v },
          )}
        </Fragment>
      ))}
      {!tablet && sep}
      {!tablet &&
        (['top', 'middle', 'bottom'] as const).map((v) => (
          <Fragment key={v}>
            {btn(`Align ${v}`, T_ICONS[v], () => setCellsAttr(editor, 'verticalAlign', v === 'middle' ? null : v), {
              on: valign === v,
            })}
          </Fragment>
        ))}
      {sep}
      {btn('Add row below', T_ICONS.row, () => c().addRowAfter().run())}
      {btn('Add column right', T_ICONS.col, () => c().addColumnAfter().run())}
      {btn(
        selCols ? 'Delete column' : selRows ? 'Delete row' : 'Delete row',
        T_ICONS.trash,
        () => (selCols ? c().deleteColumn().run() : c().deleteRow().run()),
        { danger: true },
      )}
      {!tablet && sep}
      {!tablet && (
        <button
          type="button"
          className="dk-ctb-count"
          aria-label="Table style"
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setTip('Table style')}
          onMouseLeave={() => setTip(null)}
          onClick={(e) => onPanel('styles', e.currentTarget.getBoundingClientRect())}
        >
          {n === 1 ? '1 cell' : `${n} cells`}
        </button>
      )}
    </div>
  );
}
