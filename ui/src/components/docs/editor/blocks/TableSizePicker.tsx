/**
 * Insert table: the size (board F 25, 26). A hover grid on a desktop or tablet, steppers on a phone (or after
 * "Custom size…"); header row, header column and full width; Insert table. The arrow keys change the size while the catalog has the keyboard.
 */

import { useState } from 'react';
import type { TableSize } from './commands';
import { Toggle } from './ui';

const GRID_COLS = 8;
const GRID_ROWS = 8;

/** One stepper: label, value, minus and plus (44 px on a phone). */
function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="dk-stepper">
      <span>{label}</span>
      <button
        type="button"
        aria-label={`Fewer ${label.toLowerCase()}`}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <output aria-label={label}>{value}</output>
      <button
        type="button"
        aria-label={`More ${label.toLowerCase()}`}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  );
}

/**
 * The size picker (Blocks board, F 25): "Insert table", an 8 x 8 hover grid of 22 px cells, the size in green under
 * it, the three switches, then "Custom size…" and Insert table. Custom size (and a phone) shows steppers instead of
 * the grid, for tables larger than the grid.
 * @param props.steppers - Steppers instead of the hover grid (a phone).
 */
export function TableSizePicker({
  size,
  onChange,
  onInsert,
  steppers,
}: {
  size: TableSize;
  onChange: (s: TableSize) => void;
  /** Inserts the table: `picked` when a grid cell was clicked, else the size shown. */
  onInsert: (picked?: TableSize) => void;
  steppers?: boolean;
}) {
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const [custom, setCustom] = useState(false);
  const shown = hover ? { rows: hover.r, cols: hover.c } : size;
  const withSteppers = steppers || custom || size.cols > GRID_COLS || size.rows > GRID_ROWS;
  return (
    <div className="dk-tsize" data-testid="table-size">
      <div className="dk-tsize-head">Insert table</div>
      {withSteppers ? (
        <div className="dk-tsize-steppers">
          <Stepper
            label="Columns"
            value={size.cols}
            min={1}
            max={10}
            onChange={(cols) => onChange({ ...size, cols })}
          />
          <Stepper label="Rows" value={size.rows} min={1} max={20} onChange={(rows) => onChange({ ...size, rows })} />
        </div>
      ) : (
        <div
          className="dk-tsize-grid"
          role="grid"
          aria-label="Table size"
          onMouseLeave={() => setHover(null)}
          style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 22px)` }}
        >
          {Array.from({ length: GRID_ROWS * GRID_COLS }, (_, i) => {
            const r = Math.floor(i / GRID_COLS) + 1;
            const c = (i % GRID_COLS) + 1;
            const on = r <= shown.rows && c <= shown.cols;
            return (
              <button
                key={i}
                type="button"
                tabIndex={-1}
                aria-label={`${c} by ${r}`}
                className={on ? 'on' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHover({ r, c })}
                onClick={() => onInsert({ ...size, rows: r, cols: c })}
              />
            );
          })}
        </div>
      )}
      {!steppers && (
        <div className="dk-tsize-n" aria-live="polite">
          {shown.cols} columns x {shown.rows} rows
        </div>
      )}
      <div className="dk-tsize-opts">
        <Toggle label="Header row" checked={!!size.headerRow} onChange={(v) => onChange({ ...size, headerRow: v })} />
        <Toggle
          label="Header column"
          checked={!!size.headerColumn}
          onChange={(v) => onChange({ ...size, headerColumn: v })}
        />
        {!steppers && (
          <Toggle label="Full width" checked={!!size.fullWidth} onChange={(v) => onChange({ ...size, fullWidth: v })} />
        )}
      </div>
      <div className="dk-tsize-foot">
        {!steppers && (
          <button
            type="button"
            className="dk-tsize-custom"
            aria-pressed={withSteppers}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setCustom((v) => !v)}
          >
            {withSteppers ? 'Pick on the grid' : 'Custom size…'}
          </button>
        )}
        <button
          type="button"
          className="dk-btn-primary"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onInsert()}
        >
          Insert table
        </button>
      </div>
    </div>
  );
}
