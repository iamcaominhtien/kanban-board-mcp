import type { Editor } from '@tiptap/react';
import { CellSelection } from '@tiptap/pm/tables';
import { useCallback, useEffect, useState, type RefObject } from 'react';
import { Icon } from '../Icon';

interface Geo {
  table: { left: number; top: number; width: number; height: number };
  cols: { left: number; width: number }[];
  rows: { top: number; height: number }[];
  /** selected column / row ranges, when a whole column or row is selected */
  selCols: [number, number] | null;
  selRows: [number, number] | null;
  anySel: boolean;
}

const GRIP = (on: boolean): React.CSSProperties => ({
  position: 'absolute',
  borderRadius: 3,
  background: on ? '#2E6F40' : '#C7D2CB',
  cursor: 'pointer',
  border: 'none',
  padding: 0,
  opacity: on ? 1 : 0.7,
});

function cellIndexOf(dom: HTMLElement | null): { col: number; row: number } | null {
  const cell = dom?.closest('td,th') as HTMLTableCellElement | null;
  if (!cell) return null;
  return { col: cell.cellIndex, row: (cell.parentElement as HTMLTableRowElement).rowIndex };
}

/** Column/row grips, insert handles and the cell toolbar for the table that holds the caret (board G). */
export function TableControls({ editor, hostRef }: { editor: Editor; hostRef: RefObject<HTMLDivElement> }) {
  const [geo, setGeo] = useState<Geo | null>(null);
  const [tip, setTip] = useState<string | null>(null);

  const compute = useCallback(() => {
    const host = hostRef.current;
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
    if (selection instanceof CellSelection) {
      const a = cellIndexOf(editor.view.nodeDOM(selection.$anchorCell.pos) as HTMLElement);
      const b = cellIndexOf(editor.view.nodeDOM(selection.$headCell.pos) as HTMLElement);
      if (a && b) {
        if (selection.isColSelection()) selCols = [Math.min(a.col, b.col), Math.max(a.col, b.col)];
        else if (selection.isRowSelection()) selRows = [Math.min(a.row, b.row), Math.max(a.row, b.row)];
        else {
          selCols = null;
        }
      }
    }
    setGeo({
      table: { left: t.left - h.left, top: t.top - h.top, width: t.width, height: t.height },
      cols,
      rows: rws,
      selCols,
      selRows,
      anySel: selection instanceof CellSelection,
    });
  }, [editor, hostRef]);

  useEffect(() => {
    compute();
    editor.on('transaction', compute);
    window.addEventListener('resize', compute);
    const ro = typeof ResizeObserver !== 'undefined' && hostRef.current ? new ResizeObserver(compute) : null;
    if (ro && hostRef.current) ro.observe(hostRef.current);
    return () => {
      editor.off('transaction', compute);
      window.removeEventListener('resize', compute);
      ro?.disconnect();
    };
  }, [editor, compute, hostRef]);

  if (!geo) return null;

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
  const toolbarLeft = geo.selCols ? geo.cols[geo.selCols[0]].left : geo.selRows ? geo.table.left + 8 : geo.table.left;
  const mini = (label: string, onClick: () => void, icon: string, flip?: 'x' | 'y', color?: string) => (
    <button
      key={label}
      type="button"
      className="dk-bubble-btn"
      aria-label={label}
      title={label}
      style={{ color: color ?? '#EEF3EF' }}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => setTip(label)}
      onMouseLeave={() => setTip(null)}
      onClick={onClick}
    >
      <span
        style={{ display: 'flex', transform: flip === 'y' ? 'scaleY(-1)' : flip === 'x' ? 'scaleX(-1)' : undefined }}
      >
        <Icon name={icon} size={15} />
      </span>
    </button>
  );
  const sep = <span style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.22)', margin: '0 4px' }} />;
  const c = () => editor.chain().focus();

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 8 }} data-testid="table-controls">
      {geo.cols.map((col, i) => {
        const on = !!geo.selCols && i >= geo.selCols[0] && i <= geo.selCols[1];
        return (
          <button
            key={`c${i}`}
            type="button"
            aria-label={`Select column ${i + 1}`}
            style={{
              ...GRIP(on),
              pointerEvents: 'auto',
              left: col.left + 2,
              width: col.width - 4,
              top: geo.table.top - 12,
              height: 6,
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => selectCol(i)}
          />
        );
      })}
      {geo.rows.map((row, i) => {
        const on = !!geo.selRows && i >= geo.selRows[0] && i <= geo.selRows[1];
        return (
          <button
            key={`r${i}`}
            type="button"
            aria-label={`Select row ${i + 1}`}
            style={{
              ...GRIP(on),
              pointerEvents: 'auto',
              top: row.top + 2,
              height: row.height - 4,
              left: geo.table.left - 14,
              width: 6,
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => selectRow(i)}
          />
        );
      })}
      <button
        type="button"
        aria-label="Add column"
        title="Add column"
        style={{
          position: 'absolute',
          pointerEvents: 'auto',
          left: geo.table.left + geo.table.width - 10,
          top: geo.table.top + 8,
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#2E6F40',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 2px 6px rgba(30,42,34,0.25)',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
        }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          caretIn(0, lastCol);
          c().addColumnAfter().run();
        }}
      >
        <Icon name="i01" size={12} />
      </button>
      <button
        type="button"
        aria-label="Add row"
        title="Add row"
        style={{
          position: 'absolute',
          pointerEvents: 'auto',
          left: geo.table.left - 10,
          top: geo.table.top + geo.table.height - 10,
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#fff',
          border: '1px solid #C7D2CB',
          color: '#5B6B60',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          cursor: 'pointer',
        }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          caretIn(lastRow, 0);
          c().addRowAfter().run();
        }}
      >
        <Icon name="i01" size={12} />
      </button>

      {geo.anySel && (
        <div
          data-testid="cell-toolbar"
          style={{
            position: 'absolute',
            pointerEvents: 'auto',
            left: toolbarLeft,
            top: geo.table.top - 52,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            padding: '4px 6px',
            borderRadius: 9,
            background: '#1E2A22',
            boxShadow: '0 10px 24px rgba(30,42,34,0.3)',
            zIndex: 3,
          }}
        >
          {tip && (
            <div className="dk-tt" style={{ position: 'absolute', left: 52, top: -36, zIndex: 4 }}>
              {tip}
            </div>
          )}
          {mini('Add row above', () => c().addRowBefore().run(), 'i55', 'y')}
          {mini('Add row below', () => c().addRowAfter().run(), 'i55')}
          {mini('Add column left', () => c().addColumnBefore().run(), 'i56', 'x')}
          {mini('Add column right', () => c().addColumnAfter().run(), 'i56')}
          {sep}
          <button
            type="button"
            className="dk-bubble-btn"
            style={{ width: 'auto', padding: '0 7px', fontSize: 12, color: '#EEF3EF' }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => c().toggleHeaderRow().run()}
          >
            Header row
          </button>
          {sep}
          {mini(
            geo.selRows ? 'Delete row' : 'Delete column',
            () => (geo.selRows ? c().deleteRow().run() : c().deleteColumn().run()),
            'i12',
          )}
          {mini('Delete table', () => c().deleteTable().run(), 'i12', undefined, '#C4432A')}
        </div>
      )}
    </div>
  );
}
