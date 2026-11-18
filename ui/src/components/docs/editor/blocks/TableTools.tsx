/**
 * Table settings (board F 28–35, L 61, 65, 66): Merge cells / Split cell for the selection toolbar, Cell properties
 * (shading from the highlight palette, alignment, vertical alignment), Table properties (header row and column,
 * style, width) and, on a phone, the bar under a selected cell. Colours are palette names, so they survive export
 * and AI edits.
 */

import type { Editor } from '@tiptap/core';
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HIGHLIGHT_NAMES } from './palette';
import {
  canMergeCells,
  canSplitCell,
  cellAt,
  clearCellFormatting,
  hasHeader,
  mergeSelectedCells,
  selectedCellCount,
  setCellsAttr,
  setTableAttrs,
  splitSelectedCell,
  tableAt,
} from './commands';
import { Panel, Row, Seg, Swatches, Toggle } from './ui';
import { useEditorTick } from './useInside';

/** The table styles (schema.json `table.style`) as the picker names them. */
export const TABLE_STYLES = [
  { value: null, label: 'Default' },
  { value: 'plain', label: 'Plain grid' },
  { value: 'lined', label: 'Rows' },
  { value: 'striped', label: 'Banded rows' },
  { value: 'boxed', label: 'Boxed' },
  { value: 'minimal', label: 'Minimal lines' },
] as const;

/** Cell properties for the selected cells (or the cell with the caret). */
export function CellProps({
  editor,
  anchor,
  onClose,
}: {
  editor: Editor;
  anchor: DOMRect | null;
  onClose: () => void;
}) {
  useEditorTick(editor);
  const cell = cellAt(editor.state);
  if (!cell) return null;
  const n = Math.max(1, selectedCellCount(editor.state));
  const a = cell.node.attrs as Record<string, unknown>;
  return (
    <Panel
      title="Cell properties"
      anchor={anchor}
      onClose={onClose}
      testId="cell-props"
      width={300}
      footer={
        <>
          <button
            type="button"
            className="dk-btn-ghost"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => clearCellFormatting(editor)}
          >
            Clear formatting
          </button>
          <button type="button" className="dk-btn-primary" style={{ marginLeft: 'auto' }} onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="dk-bp-muted" style={{ marginTop: -4 }}>
        {n === 1 ? '1 cell' : `${n} cells`}
      </div>
      <Row label="Shading">
        <Swatches
          kind="hl"
          label="Shading"
          names={HIGHLIGHT_NAMES}
          value={(a.background as string | null) ?? null}
          onChange={(v) => setCellsAttr(editor, 'background', v)}
        />
      </Row>
      <Row label="Align text">
        <Seg
          label="Align text"
          value={(a.align as string | null) ?? null}
          onChange={(v) => setCellsAttr(editor, 'align', v)}
          options={[
            { value: null, label: 'Auto' },
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Centre' },
            { value: 'right', label: 'Right' },
          ]}
        />
      </Row>
      <Row label="Vertical">
        <Seg
          label="Vertical alignment"
          value={(a.verticalAlign as string | null) ?? null}
          onChange={(v) => setCellsAttr(editor, 'verticalAlign', v)}
          options={[
            { value: null, label: 'Auto' },
            { value: 'top', label: 'Top' },
            { value: 'middle', label: 'Middle' },
            { value: 'bottom', label: 'Bottom' },
          ]}
        />
      </Row>
    </Panel>
  );
}

/** Table properties for the table with the caret (its top-left corner handle). */
export function TableProps({
  editor,
  anchor,
  onClose,
}: {
  editor: Editor;
  anchor: DOMRect | null;
  onClose: () => void;
}) {
  useEditorTick(editor);
  const t = tableAt(editor.state);
  if (!t) return null;
  const c = () => editor.chain().focus();
  return (
    <Panel
      title="Table properties"
      anchor={anchor}
      onClose={onClose}
      testId="table-props"
      width={320}
      footer={
        <>
          <button
            type="button"
            className="dk-btn-ghost"
            style={{ color: '#C4432A' }}
            onClick={() => {
              c().deleteTable().run();
              onClose();
            }}
          >
            Delete table
          </button>
          <button type="button" className="dk-btn-primary" style={{ marginLeft: 'auto' }} onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <Toggle label="Header row" checked={hasHeader(t.node, 'row')} onChange={() => c().toggleHeaderRow().run()} />
      <Toggle
        label="Header column"
        checked={hasHeader(t.node, 'column')}
        onChange={() => c().toggleHeaderColumn().run()}
      />
      <Row label="Style">
        <Seg
          label="Table style"
          wrap
          value={(t.node.attrs.style as string | null) ?? null}
          onChange={(v) => setTableAttrs(editor, { style: v })}
          options={TABLE_STYLES.map((s) => ({ value: s.value as string | null, label: s.label }))}
        />
      </Row>
      <Row label="Width">
        <Seg
          label="Table width"
          value={(t.node.attrs.width as string | null) ?? null}
          onChange={(v) => setTableAttrs(editor, { width: v })}
          options={[
            { value: null, label: 'Default' },
            { value: 'fit', label: 'Fit text' },
            { value: 'full', label: 'Full width' },
          ]}
        />
      </Row>
    </Panel>
  );
}

/** Merge cells and Split cell for the cell toolbar; Merge is greyed out with a reason when it cannot run. */
export function MergeButtons({ editor, onTip }: { editor: Editor; onTip: (t: string | null) => void }) {
  const check = canMergeCells(editor);
  const split = canSplitCell(editor);
  const n = selectedCellCount(editor.state);
  const mergeTip = check === 'ok' ? `Merge cells · ${n} cells` : 'Select a rectangle of cells to merge';
  return (
    <>
      {n > 1 && (
        <button
          type="button"
          className="dk-bubble-btn"
          style={{ width: 'auto', padding: '0 8px', fontSize: 12, color: check === 'ok' ? '#EEF3EF' : '#8A9A90' }}
          aria-disabled={check !== 'ok'}
          aria-label="Merge cells"
          data-testid="merge-cells"
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onTip(mergeTip)}
          onMouseLeave={() => onTip(null)}
          onClick={() => {
            if (mergeSelectedCells(editor) !== 'ok')
              onTip('Merge not available · Select a rectangle of cells to merge');
          }}
        >
          Merge cells
        </button>
      )}
      {split && (
        <button
          type="button"
          className="dk-bubble-btn"
          style={{ width: 'auto', padding: '0 8px', fontSize: 12, color: '#EEF3EF' }}
          aria-label="Split cell"
          data-testid="split-cell"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => splitSelectedCell(editor)}
        >
          Split cell
        </button>
      )}
    </>
  );
}

/** The bar under a selected cell on a phone (board F 34): row, column, merge, shade, align, table, delete. */
export function PhoneTableBar({ editor }: { editor: Editor }) {
  useEditorTick(editor);
  const [sheet, setSheet] = useState<'shade' | 'table' | 'row' | 'col' | null>(null);
  const cell = cellAt(editor.state);
  const t = tableAt(editor.state);
  if (!cell || !t) return null;
  const dom = editor.view.nodeDOM(cell.pos);
  const td = dom instanceof HTMLTableCellElement ? dom : null;
  const where = td
    ? `Row ${(td.parentElement as HTMLTableRowElement).rowIndex + 1}, column ${td.cellIndex + 1}`
    : 'Cell';
  const c = () => editor.chain().focus();
  const merge = canMergeCells(editor);
  const btn = (label: string, fn: () => void, disabled = false) => (
    <button key={label} type="button" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={fn}>
      {label}
    </button>
  );
  // the bar's buttons: a 20 px icon over the word (Blocks board, frame 34)
  const barBtn = (label: string, icon: ReactNode, fn: () => void, disabled = false, danger = false) => (
    <button
      key={label}
      type="button"
      disabled={disabled}
      className={danger ? 'dk-table-phonebar-danger' : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={fn}
    >
      <svg
        aria-hidden="true"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {icon}
      </svg>
      <span>{label}</span>
    </button>
  );
  const mergeIcon = (
    <>
      <rect height="14" rx="2" width="18" x="3" y="5" />
      <path d="M12 5v3M12 16v3M7 12h10M10 9.5L7.5 12 10 14.5M14 9.5l2.5 2.5-2.5 2.5" />
    </>
  );
  return createPortal(
    <>
      <div className="dk-table-phonebar" role="toolbar" aria-label={where} data-block-ui="">
        <span className="dk-table-phonebar-where">{where}</span>
        <div className="dk-table-phonebar-btns">
          {barBtn('Row', <path d="M4 5h16v6H4zM12 14v6M9 17h6" />, () => setSheet('row'))}
          {barBtn('Column', <path d="M5 4v16h6V4zM14 12h6M17 9v6" />, () => setSheet('col'))}
          {canSplitCell(editor)
            ? barBtn('Split', mergeIcon, () => splitSelectedCell(editor))
            : barBtn('Merge', mergeIcon, () => mergeSelectedCells(editor), merge !== 'ok')}
          {barBtn(
            'Shade',
            <>
              <path d="M5 12l7-7 7 7-6 6a2 2 0 0 1-3 0z" />
              <path d="M20 15c1 1.5 1.5 2.5 1.5 3.3a1.5 1.5 0 0 1-3 0c0-.8.5-1.8 1.5-3.3z" />
            </>,
            () => setSheet('shade'),
          )}
          {barBtn(
            'Table',
            <>
              <rect height="16" rx="2" width="18" x="3" y="4" />
              <path d="M3 10h18M3 15h18M9 4v16M15 4v16" />
            </>,
            () => setSheet('table'),
          )}
          {barBtn(
            'Delete',
            <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
            () => c().deleteTable().run(),
            false,
            true,
          )}
        </div>
      </div>
      {sheet === 'shade' && <CellProps editor={editor} anchor={null} onClose={() => setSheet(null)} />}
      {sheet === 'table' && <TableProps editor={editor} anchor={null} onClose={() => setSheet(null)} />}
      {(sheet === 'row' || sheet === 'col') && (
        <Panel title={sheet === 'row' ? 'Row' : 'Column'} anchor={null} onClose={() => setSheet(null)}>
          <div className="dk-bp-stack">
            {sheet === 'row'
              ? [
                  btn('Add row above', () => c().addRowBefore().run()),
                  btn('Add row below', () => c().addRowAfter().run()),
                  btn('Delete row', () => {
                    c().deleteRow().run();
                    setSheet(null);
                  }),
                ]
              : [
                  btn('Add column left', () => c().addColumnBefore().run()),
                  btn('Add column right', () => c().addColumnAfter().run()),
                  btn('Delete column', () => {
                    c().deleteColumn().run();
                    setSheet(null);
                  }),
                ]}
          </div>
        </Panel>
      )}
    </>,
    document.body,
  );
}
