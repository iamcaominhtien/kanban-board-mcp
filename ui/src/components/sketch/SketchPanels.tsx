import { useEffect, useState } from 'react';
import { SWATCHES, normaliseHex } from './engine/colour';
import { MAX_LAYERS, MAX_SIDE } from './engine/limits';
import { SketchIcon } from './SketchIcon';
import type { Sketcher, SketchState, ToolId } from './sketcher';
import styles from './Sketch.module.css';

/** The tools: name, one-key shortcut and what they do, in tool bar order. */
export const TOOLS: { id: ToolId; name: string; key: string; icon: string; hint: string }[] = [
  {
    id: 'select',
    name: 'Select and move',
    key: 'V',
    icon: 'select',
    hint: 'Drag a box, then move, resize or delete what is inside.',
  },
  { id: 'pencil', name: 'Pencil', key: 'P', icon: 'pencil', hint: 'Thin hard line. Best for writing and outlines.' },
  {
    id: 'brush',
    name: 'Brush',
    key: 'B',
    icon: 'brush',
    hint: 'Soft line with size, softness and opacity. Responds to pen pressure.',
  },
  { id: 'eraser', name: 'Eraser', key: 'E', icon: 'eraser', hint: 'Rubs out on the current layer.' },
  { id: 'fill', name: 'Fill', key: 'G', icon: 'fill', hint: 'Fills a closed area with the colour.' },
  {
    id: 'picker',
    name: 'Pick colour',
    key: 'I',
    icon: 'picker',
    hint: 'Click any pixel to use its colour. Hold Alt while drawing for a quick pick.',
  },
  {
    id: 'line',
    name: 'Line and arrow',
    key: 'L',
    icon: 'line',
    hint: 'Straight lines and arrows. Hold Shift to snap to 15 degrees.',
  },
  {
    id: 'shape',
    name: 'Rectangle and ellipse',
    key: 'R',
    icon: 'shape',
    hint: 'Outline or filled. Hold Shift for a square or circle.',
  },
  { id: 'text', name: 'Text', key: 'T', icon: 'text', hint: 'Click and type. Stays editable until you merge layers.' },
  {
    id: 'crop',
    name: 'Crop and resize',
    key: 'C',
    icon: 'crop',
    hint: 'Change the canvas size, crop to a box, or trim to the content.',
  },
];

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (v: number) => void;
  testId?: string;
}

function Slider({ label, value, min, max, unit, onChange, testId }: SliderProps) {
  return (
    <label className={styles.opt}>
      <span className={styles.optLabel}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        data-testid={testId}
      />
      <span className={styles.optValue}>
        {value}
        {unit}
      </span>
    </label>
  );
}

interface ToggleProps {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}

function Toggle({ label, on, onChange, testId }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`${styles.toggle} ${on ? styles.toggleOn : ''}`}
      onClick={() => onChange(!on)}
      data-testid={testId}
    >
      <span className={styles.toggleKnob} />
      <span>{label}</span>
    </button>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string; icon?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <span className={styles.segmented} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={`${styles.seg} ${value === o.id ? styles.segOn : ''}`}
          onClick={() => onChange(o.id)}
        >
          {o.icon && <SketchIcon name={o.icon} size={15} />} {o.label}
        </button>
      ))}
    </span>
  );
}

interface OptionsProps {
  sketcher: Sketcher;
  state: SketchState;
}

/**
 * The bar of options for the current tool: size, softness, opacity and so on.
 * @param props.sketcher - The drawing engine.
 * @param props.state - Its state.
 */
export function OptionsBar({ sketcher, state }: OptionsProps) {
  const tool = TOOLS.find((t) => t.id === state.tool) ?? TOOLS[2];
  const o = state.options;
  const [w, setW] = useState(String(state.width));
  const [h, setH] = useState(String(state.height));
  useEffect(() => {
    setW(String(state.width));
    setH(String(state.height));
  }, [state.width, state.height]);
  const size = (min: number, max: number) => (
    <Slider
      label={state.tool === 'text' ? 'Font' : 'Size'}
      value={o.sizes[state.tool as keyof typeof o.sizes]}
      min={min}
      max={max}
      unit=" px"
      onChange={(v) => sketcher.setSize(v)}
      testId="sketch-size"
    />
  );
  const opacity = (
    <Slider
      label="Opacity"
      value={o.opacity}
      min={1}
      max={100}
      unit="%"
      onChange={(v) => sketcher.setOptions({ opacity: v })}
    />
  );
  const nw = Number(w);
  const nh = Number(h);
  const sizeOk = Number.isFinite(nw) && Number.isFinite(nh) && nw >= 1 && nh >= 1;
  const tooBig = nw > MAX_SIDE || nh > MAX_SIDE;

  return (
    <div className={styles.options} role="toolbar" aria-label={`${tool.name} options`}>
      <span className={styles.optTool}>
        <SketchIcon name={tool.icon} size={16} /> {tool.name}
      </span>
      {state.tool === 'brush' && (
        <>
          {size(1, 200)}
          <Slider
            label="Softness"
            value={o.softness}
            min={0}
            max={100}
            unit="%"
            onChange={(v) => sketcher.setOptions({ softness: v })}
          />
          {opacity}
          <Toggle
            label="Pen pressure"
            on={o.pressure}
            onChange={(v) => sketcher.setOptions({ pressure: v })}
            testId="sketch-pressure"
          />
          {o.pressure && (
            <Segmented
              label="Pressure changes"
              value={o.pressureTarget}
              options={[
                { id: 'size', label: 'Size' },
                { id: 'opacity', label: 'Opacity' },
              ]}
              onChange={(v) => sketcher.setOptions({ pressureTarget: v })}
            />
          )}
          <Slider
            label="Smoothing"
            value={o.smoothing}
            min={0}
            max={100}
            unit="%"
            onChange={(v) => sketcher.setOptions({ smoothing: v })}
          />
        </>
      )}
      {state.tool === 'pencil' && (
        <>
          {size(1, 40)}
          {opacity}
        </>
      )}
      {state.tool === 'eraser' && (
        <>
          {size(1, 200)}
          <Slider
            label="Softness"
            value={o.softness}
            min={0}
            max={100}
            unit="%"
            onChange={(v) => sketcher.setOptions({ softness: v })}
          />
          {opacity}
          <Toggle label="Pen pressure" on={o.pressure} onChange={(v) => sketcher.setOptions({ pressure: v })} />
        </>
      )}
      {state.tool === 'fill' && (
        <>
          <Slider
            label="Tolerance"
            value={o.tolerance}
            min={0}
            max={100}
            unit="%"
            onChange={(v) => sketcher.setOptions({ tolerance: v })}
            testId="sketch-tolerance"
          />
          {opacity}
        </>
      )}
      {state.tool === 'line' && (
        <>
          {size(1, 60)}
          <Toggle
            label="Arrow head"
            on={o.arrow}
            onChange={(v) => sketcher.setOptions({ arrow: v })}
            testId="sketch-arrow"
          />
          {opacity}
        </>
      )}
      {state.tool === 'shape' && (
        <>
          <Segmented
            label="Shape"
            value={o.shape}
            options={[
              { id: 'rect', label: 'Rectangle', icon: 'rect' },
              { id: 'ellipse', label: 'Ellipse', icon: 'ellipse' },
            ]}
            onChange={(v) => sketcher.setOptions({ shape: v })}
          />
          <Segmented
            label="Style"
            value={o.filled ? 'filled' : 'outline'}
            options={[
              { id: 'outline', label: 'Outline' },
              { id: 'filled', label: 'Filled' },
            ]}
            onChange={(v) => sketcher.setOptions({ filled: v === 'filled' })}
          />
          {!o.filled && size(1, 60)}
          {opacity}
        </>
      )}
      {state.tool === 'text' && (
        <>
          {size(8, 200)}
          <Toggle label="Bold" on={o.bold} onChange={(v) => sketcher.setOptions({ bold: v })} />
          <span className={styles.optHint}>Click to type. Ctrl+Enter or click away to finish, Esc to cancel.</span>
        </>
      )}
      {state.tool === 'picker' && <span className={styles.optHint}>{tool.hint}</span>}
      {state.tool === 'select' && (
        <>
          <span className={styles.optHint}>{tool.hint}</span>
          {(state.hasSelection || state.selectedText) && (
            <>
              <button
                type="button"
                className={styles.btn}
                onClick={() => sketcher.deleteSelection()}
                data-testid="sketch-delete-selection"
              >
                <SketchIcon name="trash" size={14} /> Delete
              </button>
              {state.hasSelection && (
                <button type="button" className={styles.btn} onClick={() => sketcher.commitSelection()}>
                  Put down (Enter)
                </button>
              )}
            </>
          )}
        </>
      )}
      {state.tool === 'crop' && (
        <>
          <label className={styles.opt}>
            <span className={styles.optLabel}>Canvas</span>
            <input
              className={styles.num}
              inputMode="numeric"
              aria-label="Width"
              value={w}
              onChange={(e) => setW(e.target.value.replace(/\D/g, ''))}
              data-testid="sketch-canvas-w"
            />
            ×
            <input
              className={styles.num}
              inputMode="numeric"
              aria-label="Height"
              value={h}
              onChange={(e) => setH(e.target.value.replace(/\D/g, ''))}
              data-testid="sketch-canvas-h"
            />
            px
          </label>
          <button
            type="button"
            className={styles.btn}
            disabled={!sizeOk}
            onClick={() => sketcher.resizeCanvas(nw, nh)}
            data-testid="sketch-resize-canvas"
          >
            Resize canvas
          </button>
          <button type="button" className={styles.btn} disabled={!sizeOk} onClick={() => sketcher.scaleDrawing(nw, nh)}>
            Scale drawing
          </button>
          <button type="button" className={styles.btn} onClick={() => sketcher.trimToContent()}>
            Trim to content
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={!state.hasCropBox}
            onClick={() => sketcher.cropToBox()}
            data-testid="sketch-crop-box"
          >
            Crop to box
          </button>
          <span className={tooBig ? styles.optWarn : styles.optHint}>
            {tooBig
              ? `Too large. The limit is ${MAX_SIDE} × ${MAX_SIDE} px.`
              : 'Or drag a box on the drawing, then Crop to box.'}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * The colour field, swatches and recent colours.
 * @param props.sketcher - The drawing engine.
 * @param props.state - Its state.
 */
export function ColourPanel({ sketcher, state }: OptionsProps) {
  const [text, setText] = useState(state.colour);
  useEffect(() => setText(state.colour), [state.colour]);
  return (
    <section className={styles.panel} aria-label="Colour">
      <div className={styles.panelHead}>COLOUR</div>
      <div className={styles.colourRow}>
        <label className={styles.colourWell} style={{ background: state.colour }} title="Pick a colour">
          <input
            type="color"
            value={state.colour}
            onChange={(e) => sketcher.setColour(e.target.value, false)}
            onBlur={(e) => sketcher.setColour(e.target.value)}
            aria-label="Colour picker"
          />
        </label>
        <input
          className={styles.hex}
          value={text}
          aria-label="Colour as hex"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            const c = normaliseHex(e.target.value);
            if (c) sketcher.setColour(c, false);
          }}
          onBlur={() => {
            const c = normaliseHex(text);
            if (c) sketcher.setColour(c);
            else setText(state.colour);
          }}
          data-testid="sketch-hex"
        />
      </div>
      <div className={styles.swatches}>
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            className={`${styles.swatch} ${state.colour === c ? styles.swatchOn : ''}`}
            style={{ background: c }}
            aria-label={`Colour ${c}`}
            aria-pressed={state.colour === c}
            onClick={() => sketcher.setColour(c)}
          />
        ))}
      </div>
      {state.recent.length > 0 && (
        <>
          <div className={styles.recentLabel}>Recent</div>
          <div className={styles.swatches}>
            {state.recent.map((c) => (
              <button
                key={c}
                type="button"
                className={styles.swatch}
                style={{ background: c }}
                aria-label={`Recent colour ${c}`}
                onClick={() => sketcher.setColour(c)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The layers list: show, lock, select, reorder, merge, delete and the opacity of the selected one.
 * @param props.sketcher - The drawing engine.
 * @param props.state - Its state.
 */
export function LayersPanel({ sketcher, state }: OptionsProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const active = state.layers.find((l) => l.id === state.activeId);
  const full = state.layers.length >= MAX_LAYERS;
  const top = [...state.layers].reverse();
  return (
    <section className={styles.panel} aria-label="Layers">
      <div className={styles.panelHead}>
        <span>
          LAYERS{' '}
          <span className={styles.count}>
            {state.layers.length}/{MAX_LAYERS}
          </span>
        </span>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => sketcher.addLayer()}
          aria-label="Add layer"
          title={full ? `Up to ${MAX_LAYERS} layers. Merge or delete one first.` : 'Add layer'}
          aria-disabled={full}
          data-testid="sketch-add-layer"
        >
          <SketchIcon name="plus" size={16} />
        </button>
      </div>
      <ul className={styles.layerList}>
        {top.map((l) => (
          <li
            key={l.id}
            className={`${styles.layerRow} ${l.id === state.activeId ? styles.layerOn : ''}`}
            data-testid="sketch-layer"
          >
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => sketcher.setVisible(l.id, !l.visible)}
              aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
              aria-pressed={l.visible}
            >
              <SketchIcon name={l.visible ? 'eye' : 'eyeOff'} size={16} />
            </button>
            {renaming === l.id ? (
              <input
                className={styles.layerName}
                autoFocus
                defaultValue={l.name}
                aria-label="Layer name"
                onBlur={(e) => {
                  sketcher.renameLayer(l.id, e.target.value);
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setRenaming(null);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className={styles.layerSelect}
                onClick={() => sketcher.setActive(l.id)}
                onDoubleClick={() => setRenaming(l.id)}
                aria-pressed={l.id === state.activeId}
                title="Double-click to rename"
              >
                {l.name}
              </button>
            )}
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => sketcher.setLocked(l.id, !l.locked)}
              aria-label={l.locked ? `Unlock ${l.name}` : `Lock ${l.name}`}
              aria-pressed={l.locked}
            >
              <SketchIcon name={l.locked ? 'lock' : 'unlock'} size={15} />
            </button>
          </li>
        ))}
      </ul>
      {active && (
        <>
          <div className={styles.layerActions}>
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Move layer up"
              title="Move up"
              onClick={() => sketcher.shiftLayer(active.id, 1)}
            >
              <SketchIcon name="up" size={16} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Move layer down"
              title="Move down"
              onClick={() => sketcher.shiftLayer(active.id, -1)}
            >
              <SketchIcon name="down" size={16} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Merge down"
              title="Merge into the layer below"
              onClick={() => sketcher.mergeDown(active.id)}
              data-testid="sketch-merge"
            >
              <SketchIcon name="merge" size={16} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Delete layer"
              title="Delete layer"
              onClick={() => sketcher.removeLayer(active.id)}
              data-testid="sketch-delete-layer"
            >
              <SketchIcon name="trash" size={16} />
            </button>
          </div>
          <label className={styles.layerOpacity}>
            <span>Opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(active.opacity * 100)}
              onChange={(e) => sketcher.setLayerOpacity(active.id, Number(e.target.value) / 100)}
              aria-label="Layer opacity"
            />
            <span className={styles.optValue}>{Math.round(active.opacity * 100)}%</span>
          </label>
        </>
      )}
    </section>
  );
}
