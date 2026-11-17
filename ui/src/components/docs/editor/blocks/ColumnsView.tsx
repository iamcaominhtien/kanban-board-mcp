/**
 * Columns while editing (board G 36–40, L 70): the columns side by side as the reader draws them (ratio, gap, line;
 * one column below 640 px), and with the cursor inside, a bar between each pair that you drag to change the ratio
 * (it snaps to a quarter, a third or a half), a small toolbar of ratios and the Columns properties.
 */

import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../Icon';
import { dragRatio, ratioFromWeights, setColumnCount, setNodeAttrs, weightsOf } from './commands';
import { Panel, Row, Seg, Toggle } from './ui';
import { useEditorTick, useInside } from './useInside';

/** Ratio presets by number of columns, as weights. */
export const RATIO_PRESETS: Record<number, number[][]> = {
  2: [
    [1, 1],
    [1, 2],
    [2, 1],
    [3, 1],
    [1, 3],
  ],
  3: [
    [1, 1, 1],
    [1, 2, 1],
    [2, 1, 1],
    [1, 1, 2],
  ],
  4: [[1, 1, 1, 1]],
};

/** "33 / 67" for weights [1, 2]. */
export function ratioLabel(weights: number[]): string {
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.round((w / total) * 100)).join(' / ');
}

const GAPS = [
  { value: 16, label: 'Small' },
  { value: 24, label: 'Medium' },
  { value: 40, label: 'Large' },
];

/**
 * The Columns properties panel for the block at `pos`.
 * @param props.anchor - The block's rect (the popover points at it).
 */
export function ColumnsProps({
  editor,
  pos,
  anchor,
  onClose,
}: {
  editor: Editor;
  pos: number;
  anchor: DOMRect | null;
  onClose: () => void;
}) {
  const node = editor.state.doc.nodeAt(pos);
  useEditorTick(editor);
  if (!node || node.type.name !== 'columns') return null;
  const n = node.childCount;
  const weights = weightsOf(node.attrs.ratio, n);
  const set = (a: Record<string, unknown>) => setNodeAttrs(editor, pos, a);
  return (
    <Panel
      title="Columns"
      anchor={anchor}
      onClose={onClose}
      testId="columns-props"
      width={320}
      footer={
        <button type="button" className="dk-btn-primary" style={{ marginLeft: 'auto' }} onClick={onClose}>
          Done
        </button>
      }
    >
      <Row label="Number">
        <Seg
          label="Number"
          value={n}
          onChange={(v) => setColumnCount(editor, pos, v)}
          options={[
            { value: 2, label: '2 columns' },
            { value: 3, label: '3 columns' },
          ]}
        />
      </Row>
      <Row label="Ratio">
        <Seg
          label="Ratio"
          wrap
          value={ratioFromWeights(weights)}
          onChange={(v) => set({ ratio: v })}
          options={(RATIO_PRESETS[n] ?? [weights]).map((w) => ({ value: ratioFromWeights(w), label: ratioLabel(w) }))}
        />
      </Row>
      <Row label="Gap">
        <Seg
          label="Gap"
          value={typeof node.attrs.gap === 'number' ? node.attrs.gap : 24}
          onChange={(v) => set({ gap: v })}
          options={GAPS}
        />
      </Row>
      <Toggle label="Line between columns" checked={!!node.attrs.line} onChange={(v) => set({ line: v })} />
      <p className="dk-bp-note">On phones the columns stack in reading order, left one first.</p>
    </Panel>
  );
}

/** The columns node view. */
export function ColumnsView({ node, editor, getPos, updateAttributes }: NodeViewProps) {
  const inside = useInside(editor, getPos, node.nodeSize);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [bars, setBars] = useState<{ left: number; top: number; height: number }[]>([]);
  const [live, setLive] = useState<number[] | null>(null);
  const [props, setProps] = useState(false);
  const n = node.childCount;
  const weights = live ?? weightsOf(node.attrs.ratio, n);
  const gap = typeof node.attrs.gap === 'number' ? node.attrs.gap : 24;

  useLayoutEffect(() => {
    if (!inside) {
      setBars([]);
      return;
    }
    const wrap = wrapRef.current;
    if (!wrap) return;
    const box = wrap.getBoundingClientRect();
    const cols = Array.from(wrap.querySelectorAll<HTMLElement>(':scope [data-rd-node="column"]')).filter(
      (c) => c.parentElement?.closest('.dk-colsv') === wrap,
    );
    const next: { left: number; top: number; height: number }[] = [];
    for (let i = 0; i < cols.length - 1; i += 1) {
      const a = cols[i].getBoundingClientRect();
      const b = cols[i + 1].getBoundingClientRect();
      // stacked on a narrow page: no bars
      if (b.top >= a.bottom - 1) continue;
      next.push({
        left: (a.right + b.left) / 2 - box.left,
        top: a.top - box.top,
        height: Math.max(a.height, b.height),
      });
    }
    setBars(next);
  }, [inside, node, live, gap]);

  const startDrag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const cols = Array.from(wrap.querySelectorAll<HTMLElement>('[data-rd-node="column"]')).filter(
      (c) => c.parentElement?.closest('.dk-colsv') === wrap,
    );
    const a = cols[i]?.getBoundingClientRect();
    const b = cols[i + 1]?.getBoundingClientRect();
    if (!a || !b) return;
    const base = weightsOf(node.attrs.ratio, n);
    let current = base;
    const move = (ev: PointerEvent) => {
      const fraction = (ev.clientX - a.left) / Math.max(1, b.right - a.left);
      current = dragRatio(base, i, Math.min(0.9, Math.max(0.1, fraction)));
      setLive(current);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLive(null);
      updateAttributes({ ratio: ratioFromWeights(current) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const style = {
    '--dk-cols': weights.map((w) => `minmax(0, ${w}fr)`).join(' '),
    '--dk-gap': `${gap}px`,
  } as CSSProperties;
  const pos = typeof getPos === 'function' ? getPos() : undefined;

  return (
    <NodeViewWrapper
      ref={wrapRef}
      className={`dk-colsv${node.attrs.line ? ' dk-colsv-line' : ''}${inside ? ' is-inside' : ''}`}
      style={style}
      data-testid="docs-columns"
    >
      {inside && (
        <div
          className="dk-btoolbar dk-cols-toolbar"
          contentEditable={false}
          role="toolbar"
          aria-label="Columns"
          data-block-ui=""
        >
          {(RATIO_PRESETS[n] ?? []).slice(0, 4).map((w) => {
            const r = ratioFromWeights(w);
            return (
              <button
                key={ratioLabel(w)}
                type="button"
                className={`dk-btb wide${r === (node.attrs.ratio ?? null) ? ' on' : ''}`}
                aria-pressed={r === (node.attrs.ratio ?? null)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => updateAttributes({ ratio: r })}
              >
                {ratioLabel(w)}
              </button>
            );
          })}
          <span className="dk-btb-sep" />
          <button
            type="button"
            className="dk-btb wide"
            aria-label="Columns properties"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setProps(true)}
          >
            <Icon name="more" size={15} /> Properties
          </button>
        </div>
      )}
      <NodeViewContent className="dk-colsv-content" />
      {bars.map((b, i) => (
        <span
          key={i}
          className="dk-colsv-bar"
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize columns ${i + 1} and ${i + 2}`}
          contentEditable={false}
          style={{ left: b.left - 6, top: b.top, height: b.height }}
          onPointerDown={startDrag(i)}
        >
          {live && i === 0 && <span className="dk-colsv-ratio">{ratioLabel(weights)}</span>}
        </span>
      ))}
      {props &&
        pos != null &&
        createPortal(
          <ColumnsProps
            editor={editor}
            pos={pos}
            anchor={wrapRef.current?.getBoundingClientRect() ?? null}
            onClose={() => setProps(false)}
          />,
          document.body,
        )}
    </NodeViewWrapper>
  );
}
