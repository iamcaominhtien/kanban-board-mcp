/**
 * Image properties (board B 6–8, 10, L 62): one panel, three tabs. Layout (position, size, width, wrap distance),
 * Style (border, corners, shadow), Text and link (caption, alt text, decorative, link). Changes apply as they are
 * made; Done only closes it. A popover on a desktop, a side panel on a tablet, a sheet on a phone (Panel).
 */

import type { Editor } from '@tiptap/core';
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { ImageTab } from './bus';
import { IMAGE_SIZE_RESET, IMAGE_STYLE_RESET, SNAP_STEPS, setNodeAttrs, type Placement } from './commands';
import { PlacementGlyph } from './ImageView';
import { Panel, Row, Seg, Tabs, Toggle } from './ui';
import './imageProps.css';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Corner choices: the radius stored for each (999 draws a circle). */
const CORNERS = [
  { value: 0, label: 'Square' },
  { value: 6, label: 'Soft' },
  { value: 16, label: 'Round' },
  { value: 999, label: 'Circle' },
] as const;

/** The border colours (Blocks 7): ink, grey, green, blue, orange, red, violet and pink. */
const BORDER_COLORS = ['#1E2A22', '#5B6B60', '#2E6F40', '#2F6FB0', '#B4571F', '#C4432A', '#5B4BB5', '#A83E7A'] as const;

/** The four looks in one click (Blocks 7): a thin line, soft corners, a circle, lifted off the page. */
const PRESETS = [
  { label: 'Thin', attrs: { border: 'thin', radius: 0, shadow: false, shadowStyle: null } },
  { label: 'Soft', attrs: { border: null, radius: 6, shadow: false, shadowStyle: null } },
  { label: 'Circle', attrs: { border: null, radius: 999, shadow: false, shadowStyle: null } },
  { label: 'Lifted', attrs: { border: null, radius: 0, shadow: true, shadowStyle: null } },
] as const;

/** Follows the editor so the panel shows the node's current attributes. */
function useNodeAttrs(editor: Editor, pos: number): Record<string, unknown> | null {
  const subscribe = (fn: () => void) => {
    editor.on('transaction', fn);
    return () => {
      editor.off('transaction', fn);
    };
  };
  const doc = useSyncExternalStore(subscribe, () => editor.state.doc);
  const node = doc.nodeAt(pos);
  return node?.type.name === 'image' ? (node.attrs as Record<string, unknown>) : null;
}

/**
 * The panel for the image at `pos`.
 * @param props.tab - The tab it opens on.
 */
export function ImageProps({
  editor,
  pos,
  tab: firstTab,
  onClose,
}: {
  editor: Editor;
  pos: number;
  tab?: ImageTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ImageTab>(firstTab ?? 'layout');
  useEffect(() => setTab(firstTab ?? 'layout'), [firstTab, pos]);
  const attrs = useNodeAttrs(editor, pos);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  useEffect(() => {
    const dom = editor.view.nodeDOM(pos);
    setAnchor(dom instanceof HTMLElement ? dom.getBoundingClientRect() : null);
  }, [editor, pos]);
  useEffect(() => {
    if (!attrs) onClose();
  }, [attrs, onClose]);
  if (!attrs) return null;
  const set = (a: Record<string, unknown>) => setNodeAttrs(editor, pos, a);
  const placement = (str(attrs.placement) || 'block') as Placement;
  const widthPct = num(attrs.widthPct);
  const alt = str(attrs.alt);
  const decorative = attrs.alt === '';
  const float = placement === 'floatLeft' || placement === 'floatRight';
  const blockFamily = !float;

  return (
    <Panel
      title="Image properties"
      anchor={anchor}
      onClose={onClose}
      testId="image-props"
      footer={
        <>
          {tab === 'layout' && (
            <button type="button" className="dk-btn-ghost" onClick={() => set(IMAGE_SIZE_RESET)}>
              Reset size
            </button>
          )}
          {tab === 'style' && (
            <button type="button" className="dk-btn-ghost" onClick={() => set(IMAGE_STYLE_RESET)}>
              Reset style
            </button>
          )}
          {tab === 'text' && str(attrs.href) && (
            <button type="button" className="dk-btn-ghost" onClick={() => set({ href: null })}>
              Remove link
            </button>
          )}
          <button type="button" className="dk-btn-primary" style={{ marginLeft: 'auto' }} onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <Tabs
        tabs={[
          ['layout', 'Layout'],
          ['style', 'Style'],
          ['text', 'Text and link'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'layout' && (
        <>
          <Row label="Position">
            <div className="dk-ip-tiles" role="radiogroup" aria-label="Position">
              {(
                [
                  ['block', 'Block'],
                  ['floatLeft', 'Float left'],
                  ['floatRight', 'Float right'],
                ] as const
              ).map(([v, label]) => {
                const on = v === 'block' ? blockFamily : placement === v;
                return (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={on ? 'on' : undefined}
                    onClick={() => set({ placement: v, ...(v !== 'block' && !widthPct ? { widthPct: 40 } : {}) })}
                  >
                    <PlacementGlyph p={v} />
                    {label}
                  </button>
                );
              })}
            </div>
            {blockFamily && (
              <Seg
                label="Align"
                value={placement === 'block' ? 'left' : placement}
                onChange={(v) => set({ placement: v })}
                options={[
                  { value: 'left', label: 'Left' },
                  { value: 'center', label: 'Centre' },
                  { value: 'right', label: 'Right' },
                ]}
              />
            )}
          </Row>
          <Row label="Size">
            <Seg
              label="Size"
              value={widthPct}
              onChange={(v) => set({ widthPct: v, width: null })}
              options={SNAP_STEPS.map((s) => ({ value: s as number | null, label: `${s} %` }))}
            />
          </Row>
          <div className="dk-ip-dims">
            <label className="dk-ip-dim">
              <span>Width</span>
              <span className="dk-ip-box">
                <input
                  type="number"
                  aria-label="Width in percent"
                  min={10}
                  max={100}
                  value={widthPct ?? 100}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (v >= 10 && v <= 100) set({ widthPct: Math.round(v), width: null });
                  }}
                />
                <i>%</i>
              </span>
            </label>
            <div className="dk-ip-dim">
              <span>Height</span>
              <span className="dk-ip-box dk-ip-box-muted">Auto</span>
            </div>
            <span className="dk-ip-keep" title="The height follows the width, so the picture keeps its shape">
              <span className="dk-ip-keep-ico" aria-hidden="true">
                <svg
                  width={16}
                  height={16}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
                  <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
                </svg>
              </span>
              Keep shape
            </span>
          </div>
          {float && (
            <Row label="Wrap distance" hint="Space between the image and the text that flows beside it.">
              <span className="dk-ip-range">
                <input
                  type="range"
                  aria-label="Wrap distance"
                  min={0}
                  max={48}
                  step={4}
                  value={num(attrs.wrapGap) ?? 16}
                  style={{ '--dk-ip-fill': `${((num(attrs.wrapGap) ?? 16) / 48) * 100}%` } as CSSProperties}
                  onChange={(e) => set({ wrapGap: Number(e.target.value) })}
                />
                <b>{num(attrs.wrapGap) ?? 16} px</b>
              </span>
            </Row>
          )}
          <p className="dk-ip-info">
            <svg
              aria-hidden="true"
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5M12 8v.01" />
            </svg>
            <span>On phones, a floated image shows full width on its own row, in the same place.</span>
          </p>
        </>
      )}
      {tab === 'style' && (
        <>
          <Row label="Border">
            <Seg
              label="Border"
              value={(attrs.border as string | null) ?? null}
              onChange={(v) => set({ border: v })}
              options={[
                { value: null, label: 'None' },
                { value: 'thin', label: 'Thin' },
                { value: 'medium', label: 'Medium' },
                { value: 'thick', label: 'Thick' },
              ]}
            />
            <div className="dk-ip-colors" role="radiogroup" aria-label="Border colour">
              {BORDER_COLORS.map((c) => {
                const on = (str(attrs.borderColor) || BORDER_COLORS[0]) === c;
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={`Border colour ${c}`}
                    className={on ? 'on' : undefined}
                    style={{ background: c }}
                    onClick={() => set({ borderColor: c, ...(attrs.border ? {} : { border: 'thin' }) })}
                  />
                );
              })}
            </div>
          </Row>
          <Row label="Corners">
            <Seg
              label="Corners"
              value={num(attrs.radius) ?? 0}
              onChange={(v) => set({ radius: v })}
              options={CORNERS.map((c) => ({ value: c.value as number, label: c.label }))}
            />
          </Row>
          <Row label="Shadow">
            <Seg
              label="Shadow"
              value={!attrs.shadow ? 'none' : str(attrs.shadowStyle) === 'soft' ? 'soft' : 'lifted'}
              onChange={(v) => set({ shadow: v !== 'none', shadowStyle: v === 'soft' ? 'soft' : null })}
              options={[
                { value: 'none', label: 'None' },
                { value: 'soft', label: 'Soft' },
                { value: 'lifted', label: 'Lifted' },
              ]}
            />
          </Row>
          <div className="dk-ip-presets" role="group" aria-label="Looks">
            {PRESETS.map((p) => {
              const on =
                (attrs.border ?? null) === p.attrs.border &&
                (num(attrs.radius) ?? 0) === p.attrs.radius &&
                !!attrs.shadow === p.attrs.shadow;
              return (
                <button
                  key={p.label}
                  type="button"
                  className={on ? 'on' : undefined}
                  aria-pressed={on}
                  onClick={() => set({ ...p.attrs })}
                >
                  <span className={`dk-ip-thumb dk-ip-thumb-${p.label.toLowerCase()}`} aria-hidden="true" />
                  {p.label}
                </button>
              );
            })}
          </div>
        </>
      )}
      {tab === 'text' && (
        <>
          <Row label="Caption">
            <input
              className="dk-bp-input"
              aria-label="Caption"
              value={str(attrs.caption)}
              placeholder="A line under the image"
              onChange={(e) => set({ caption: e.target.value || null })}
            />
          </Row>
          <Row
            label={`Alt text${decorative ? '' : ` · ${alt.length} / 150`}`}
            hint="Describe what the picture shows. Screen readers read it, and it shows if the image cannot load."
          >
            <textarea
              className="dk-bp-input"
              aria-label="Alt text"
              rows={3}
              maxLength={150}
              disabled={decorative}
              value={alt}
              onChange={(e) => set({ alt: e.target.value || null })}
            />
          </Row>
          <Toggle
            label="Decorative image"
            hint="No alt text needed"
            checked={decorative}
            onChange={(v) => set({ alt: v ? '' : null })}
          />
          <Row label="Link">
            <input
              className="dk-bp-input"
              aria-label="Link"
              type="url"
              placeholder="https://"
              value={str(attrs.href)}
              onChange={(e) => set({ href: e.target.value.trim() || null })}
            />
          </Row>
        </>
      )}
    </Panel>
  );
}
