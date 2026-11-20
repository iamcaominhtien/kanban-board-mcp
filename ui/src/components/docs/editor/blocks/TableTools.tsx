/**
 * Table settings (board F 28–35, L 61, 65, 66): Merge cells / Split cell for the selection toolbar, Cell properties
 * (shading from the highlight palette, alignment, vertical alignment), Table properties (header row and column,
 * style, width) and, on a phone, the bar under a selected cell. Colours are palette names, so they survive export
 * and AI edits.
 */

import type { Editor } from '@tiptap/core';
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  canMergeCells,
  canSplitCell,
  cellAt,
  clearCellFormatting,
  currentBorderMode,
  hasHeader,
  mergeSelectedCells,
  selectedCellCount,
  setCellBorders,
  setCellsAttr,
  setCellsWidth,
  setTableAttrs,
  splitSelectedCell,
  tableAt,
  type BorderMode,
} from './commands';
import { colorLabel, swatchHex } from './palette';
import { Panel, Row, Seg, Toggle } from './ui';
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

/** A 24 px line icon (the board's table icons). */
export function TIcon({ children, size = 15, sw = 2 }: { children: ReactNode; size?: number; sw?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** The board's table icons (Blocks board, F 28). */
export const T_ICONS = {
  merge: (
    <>
      <rect height="14" rx="2" width="18" x="3" y="5" />
      <path d="M12 5v3M12 16v3M7 12h10M10 9.5L7.5 12 10 14.5M14 9.5l2.5 2.5-2.5 2.5" />
    </>
  ),
  split: (
    <>
      <rect height="14" rx="2" width="18" x="3" y="5" />
      <path d="M12 5v14M6 12h3M15 12h3" />
    </>
  ),
  shade: (
    <>
      <path d="M5 12l7-7 7 7-6 6a2 2 0 0 1-3 0z" />
      <path d="M20 15c1 1.5 1.5 2.5 1.5 3.3a1.5 1.5 0 0 1-3 0c0-.8.5-1.8 1.5-3.3z" />
    </>
  ),
  borders: (
    <>
      <rect height="16" width="16" x="4" y="4" />
      <path d="M12 4v16M4 12h16" strokeDasharray="2 2" />
    </>
  ),
  left: <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />,
  center: <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />,
  right: <path d="M4 6h16M10 10h10M4 14h16M10 18h10" />,
  top: (
    <>
      <path d="M4 4h16" />
      <rect height="8" rx="1" width="8" x="8" y="7" />
    </>
  ),
  middle: (
    <>
      <path d="M4 12h16" strokeDasharray="2 2" />
      <rect height="10" rx="1" width="8" x="8" y="7" />
    </>
  ),
  bottom: (
    <>
      <path d="M4 20h16" />
      <rect height="8" rx="1" width="8" x="8" y="9" />
    </>
  ),
  row: <path d="M4 5h16v6H4zM12 14v6M9 17h6" />,
  col: <path d="M5 4v16h6V4zM14 12h6M17 9v6" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  style: (
    <>
      <rect height="16" rx="2" width="18" x="3" y="4" />
      <path d="M3 9h18M9 9v11" />
    </>
  ),
} as const;

/** Cell shading (Blocks board, F 30): none, six light tints from the highlight palette, dark green and ink. */
export const CELL_SHADES = ['green', 'blue', 'orange', 'pink', 'violet', 'grey', '#2E6F40', '#1E2A22'] as const;
const SHADE_LABEL: Record<string, string> = { '#2E6F40': 'Dark green', '#1E2A22': 'Ink' };
/** The border colours of Cell properties: the table's own line first (stored as null), then ink, green, blue. */
const BORDER_COLORS = [
  { value: null, hex: '#D5DDD8', label: 'Grey' },
  { value: '#1E2A22', hex: '#1E2A22', label: 'Ink' },
  { value: '#2E6F40', hex: '#2E6F40', label: 'Green' },
  { value: '#2F6FB0', hex: '#2F6FB0', label: 'Blue' },
] as const;
const BORDER_MODES: { value: BorderMode; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'outer', label: 'Outer' },
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'none', label: 'None' },
];

/** A row of 22 px colour squares; `null` is drawn as "None" (a red slash). */
function ColorSquares({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: string | null; hex: string | null; label: string }[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="dk-swatches" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o.label}
          title={o.label}
          className={`dk-swatch${o.hex === null ? ' dk-swatch-none' : ''}${o.value === value ? ' on' : ''}`}
          style={o.hex ? { background: o.hex } : undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange(o.value)}
        />
      ))}
    </div>
  );
}

/** Cell properties for the selected cells (or the cell with the caret): Blocks board, F 30. */
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
  const mode = currentBorderMode(editor.state);
  const width =
    Array.isArray(a.colwidth) && typeof a.colwidth[0] === 'number' && a.colwidth[0] > 0 ? a.colwidth[0] : null;
  const shades = [
    { value: null, hex: null, label: 'None' },
    ...CELL_SHADES.map((v) => ({
      value: v as string,
      hex: swatchHex('hl', v),
      label: SHADE_LABEL[v] ?? colorLabel(v),
    })),
  ];
  return (
    <Panel
      title="Cell properties"
      badge={n === 1 ? '1 cell' : `${n} cells`}
      anchor={anchor}
      onClose={onClose}
      testId="cell-props"
      width={330}
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
      <Row label="Shading">
        <ColorSquares
          label="Shading"
          options={shades}
          value={(a.background as string | null) ?? null}
          onChange={(v) => setCellsAttr(editor, 'background', v)}
        />
      </Row>
      <div className="dk-bp-row dk-cellp-borders">
        <div className="dk-bp-label">Borders</div>
        <div className="dk-chips" role="radiogroup" aria-label="Borders">
          {BORDER_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              className={mode === m.value ? 'on' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setCellBorders(editor, m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="dk-cellp-line">
          <select
            className="dk-bp-select"
            aria-label="Line"
            value={(a.borderStyle as string | null) ?? ''}
            onChange={(e) => setCellsAttr(editor, 'borderStyle', e.target.value || null)}
          >
            <option value="">1 px, solid</option>
            <option value="thick">2 px, solid</option>
            <option value="dashed">1 px, dashed</option>
          </select>
          <ColorSquares
            label="Line colour"
            options={BORDER_COLORS}
            value={(a.borderColor as string | null) ?? null}
            onChange={(v) => setCellsAttr(editor, 'borderColor', v)}
          />
        </div>
      </div>
      <Row label="Align text">
        <div className="dk-cellp-align">
          <Seg
            label="Align text"
            value={(a.align as string | null) ?? 'left'}
            onChange={(v) => setCellsAttr(editor, 'align', v === 'left' ? null : v)}
            options={(['left', 'center', 'right'] as const).map((v) => ({
              value: v as string,
              title: v === 'center' ? 'Centre' : colorLabel(v),
              label: <TIcon size={14}>{T_ICONS[v]}</TIcon>,
            }))}
          />
          <Seg
            label="Vertical alignment"
            value={(a.verticalAlign as string | null) ?? 'middle'}
            onChange={(v) => setCellsAttr(editor, 'verticalAlign', v === 'middle' ? null : v)}
            options={(['top', 'middle', 'bottom'] as const).map((v) => ({
              value: v as string,
              title: colorLabel(v),
              label: <TIcon size={14}>{T_ICONS[v]}</TIcon>,
            }))}
          />
        </div>
      </Row>
      <Row label="Size">
        <div className="dk-bp-fields">
          <label>
            <span>Width</span>
            <input
              className="dk-bp-field"
              type="number"
              min={40}
              max={1200}
              placeholder="Auto"
              aria-label="Width in px"
              defaultValue={width ?? ''}
              key={`w${cell.pos}-${width ?? ''}`}
              onBlur={(e) => {
                const v = Number(e.target.value);
                setCellsWidth(editor, e.target.value && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
            />
          </label>
          <label>
            <span>Padding</span>
            <select
              className="dk-bp-select"
              value={(a.padding as string | null) ?? ''}
              onChange={(e) => setCellsAttr(editor, 'padding', e.target.value || null)}
            >
              <option value="tight">Tight</option>
              <option value="">Normal</option>
              <option value="roomy">Roomy</option>
            </select>
          </label>
        </div>
      </Row>
    </Panel>
  );
}

/** Every column of the table in hand back to the same width ("Columns: Equal"). */
function equalColumns(editor: Editor): void {
  const t = tableAt(editor.state);
  if (!t) return;
  const tr = editor.state.tr;
  t.node.descendants((n, pos) => {
    if (n.type.spec.tableRole === 'cell' || n.type.spec.tableRole === 'header_cell') {
      if (n.attrs.colwidth) tr.setNodeMarkup(t.pos + 1 + pos, undefined, { ...n.attrs, colwidth: null });
      return false;
    }
    return true;
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}

/** True when some column of the table has a width of its own. */
function hasColumnWidths(table: PMNode): boolean {
  let found = false;
  table.descendants((n) => {
    if (found) return false;
    if (Array.isArray(n.attrs.colwidth) && (n.attrs.colwidth as number[]).some((w) => w > 0)) found = true;
    return !found;
  });
  return found;
}

/** Table properties for the table with the caret (its top-left corner handle): Blocks board, F 31. */
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
  const a = t.node.attrs as Record<string, unknown>;
  const caption = typeof a.caption === 'string' ? a.caption : null;
  return (
    <Panel
      title="Table properties"
      anchor={anchor}
      onClose={onClose}
      testId="table-props"
      width={330}
      footer={
        <>
          <button
            type="button"
            className="dk-btn-ghost dk-btn-danger-outline"
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
      <div className="dk-bp-col">
        <Toggle label="Header row" checked={hasHeader(t.node, 'row')} onChange={() => c().toggleHeaderRow().run()} />
        <Toggle
          label="Header column"
          checked={hasHeader(t.node, 'column')}
          onChange={() => c().toggleHeaderColumn().run()}
        />
        <Toggle
          label="Banded rows"
          hint="Every second row is lightly shaded"
          checked={a.banded === true}
          onChange={(v) => setTableAttrs(editor, { banded: v })}
        />
      </div>
      <Row label="Borders">
        <Seg
          label="Borders"
          value={(a.borders as string | null) ?? null}
          onChange={(v) => setTableAttrs(editor, { borders: v })}
          options={[
            { value: null, label: 'Grid' },
            { value: 'rows', label: 'Rows' },
            { value: 'outer', label: 'Outer' },
            { value: 'none', label: 'None' },
          ]}
        />
      </Row>
      <Row label="Cell spacing">
        <Seg
          label="Cell spacing"
          value={(a.spacing as string | null) ?? null}
          onChange={(v) => setTableAttrs(editor, { spacing: v })}
          options={[
            { value: 'tight', label: 'Tight' },
            { value: null, label: 'Normal' },
            { value: 'roomy', label: 'Roomy' },
          ]}
        />
      </Row>
      <Row label="Width">
        <Seg
          label="Table width"
          value={(a.width as string | null) ?? null}
          onChange={(v) => setTableAttrs(editor, { width: v })}
          options={[
            { value: 'fit', label: 'Fit text' },
            { value: 'full', label: 'Full width' },
            { value: null, label: 'Fixed' },
          ]}
        />
        <div className="dk-bp-fields">
          <label>
            <span>Columns</span>
            <select
              className="dk-bp-select"
              value={hasColumnWidths(t.node) ? 'set' : 'equal'}
              onChange={(e) => {
                if (e.target.value === 'equal') equalColumns(editor);
              }}
            >
              <option value="equal">Equal</option>
              <option value="set" disabled={!hasColumnWidths(t.node)}>
                As drawn
              </option>
            </select>
          </label>
          <label>
            <span>Align</span>
            <select
              className="dk-bp-select"
              value={(a.align as string | null) ?? ''}
              onChange={(e) => setTableAttrs(editor, { align: e.target.value || null })}
            >
              <option value="">Full</option>
              <option value="left">Left</option>
              <option value="center">Centre</option>
              <option value="right">Right</option>
            </select>
          </label>
        </div>
      </Row>
      <div className="dk-bp-row">
        <label className="dk-bp-toggle dk-bp-toggle-label">
          <span className="dk-bp-label">Caption</span>
          <input
            type="checkbox"
            role="switch"
            aria-label="Caption"
            checked={caption !== null}
            onChange={(e) => setTableAttrs(editor, { caption: e.target.checked ? '' : null })}
          />
        </label>
        {caption !== null && (
          <input
            className="dk-bp-field"
            aria-label="Caption text"
            placeholder="Say what the table shows"
            defaultValue={caption}
            key={`cap${t.pos}`}
            onBlur={(e) => setTableAttrs(editor, { caption: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        )}
      </div>
    </Panel>
  );
}

/** The four one-tap looks (Blocks board, F 32): what each sets on the table. */
const LOOKS = [
  { id: 'plain', label: 'Plain grid', attrs: { style: 'plain', banded: false, borders: null }, headerColumn: false },
  {
    id: 'striped',
    label: 'Banded rows',
    attrs: { style: 'striped', banded: false, borders: null },
    headerColumn: false,
  },
  {
    id: 'boxed',
    label: 'Header row and column',
    attrs: { style: 'boxed', banded: false, borders: null },
    headerColumn: true,
  },
  {
    id: 'minimal',
    label: 'Minimal lines',
    attrs: { style: 'minimal', banded: false, borders: null },
    headerColumn: false,
  },
] as const;
const LOOK_ROWS = [
  ['Area', 'Owner', 'Status'],
  ['Board', 'An', 'Done'],
  ['Docs', 'Hoa', 'Open'],
  ['AI', 'Tuan', 'Open'],
];

/** Table styles: four previews, one tap restyles the table (every part stays editable after). */
export function TableStyles({
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
  const current = (t.node.attrs.style as string | null) ?? 'plain';
  return (
    <Panel title="Table style" anchor={anchor} onClose={onClose} testId="table-styles" width={400}>
      <div className="dk-looks" role="radiogroup" aria-label="Table style">
        {LOOKS.map((l) => (
          <button
            key={l.id}
            type="button"
            role="radio"
            aria-checked={current === l.id}
            className={`dk-look${current === l.id ? ' on' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setTableAttrs(editor, { ...l.attrs });
              if (hasHeader(t.node, 'column') !== l.headerColumn) editor.chain().focus().toggleHeaderColumn().run();
            }}
          >
            <table className={`dk-look-t dk-look-${l.id}`} aria-hidden="true">
              <tbody>
                {LOOK_ROWS.map((r, i) => (
                  <tr key={i}>
                    {r.map((x, j) => (
                      <td key={j} className={i === 0 ? 'h' : l.headerColumn && j === 0 ? 'hc' : undefined}>
                        {x}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <span>{l.label}</span>
          </button>
        ))}
      </div>
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
