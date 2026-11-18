/**
 * The callout while editing (board H 41–43): five fixed kinds (Info, Note, Success, Warning, Danger) and a custom one
 * with its own colour (a palette name or #rrggbb) and icon; three styles (soft box, left bar, outline) and an optional
 * title line. Drawn as RichDocView draws it. The kind button above a focused callout lists the kinds (menu items),
 * then the colour, icon, style and title.
 */

import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../../Icon';
import { CALLOUT_STYLE, type CalloutKind } from '../constants';
import { CALLOUT_ICON_NAMES, CALLOUT_ICON_PATHS, CalloutGlyph, calloutIconLabel } from './calloutIcons';
import { colorCss, colorLabel, isHex, swatchHex } from './palette';
import { Panel, Row, Seg, Toggle } from './ui';

/** The kinds in the order of the picker. */
export const CALLOUT_KINDS: CalloutKind[] = ['info', 'note', 'success', 'warning', 'danger', 'custom'];

/** The colours of the Colour row (Blocks board, H 42), from the text palette. */
export const CALLOUT_COLORS = ['violet', 'blue', 'green', 'amber', 'orange', 'red', 'pink', 'slate'] as const;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * The look of a callout from its attributes, as the reader draws it.
 * @returns The box style, the icon colour and the emoji (null for the kind's own icon).
 */
export function calloutLook(attrs: Record<string, unknown>) {
  const kind = ((str(attrs.kind) || 'info') in CALLOUT_STYLE ? str(attrs.kind) || 'info' : 'info') as CalloutKind;
  const pal = CALLOUT_STYLE[kind];
  const fg = colorCss('c', attrs.color) ?? pal.fg;
  const bg = colorCss('hl', attrs.color) ?? (isHex(attrs.color) ? `${attrs.color}1f` : pal.bg);
  const look = str(attrs.style) || 'soft';
  const box: CSSProperties =
    look === 'bar'
      ? { background: bg, border: 'none', borderLeft: `4px solid ${fg}`, borderRadius: '4px 8px 8px 4px' }
      : look === 'outline'
        ? { background: '#FFFFFF', border: `1.5px solid ${fg}` }
        : { background: bg, border: `1px solid ${attrs.color ? 'transparent' : pal.border}` };
  const icon = str(attrs.icon);
  return {
    kind,
    pal,
    fg,
    box,
    look,
    emoji: icon && !/^[\w:-]+$/.test(icon) ? icon : null,
    glyph: icon in CALLOUT_ICON_PATHS ? icon : null,
  };
}

/** The icon a callout shows: its own (a named icon or an emoji), else its kind's. */
export function CalloutIcon({ attrs, size = 16 }: { attrs: Record<string, unknown>; size?: number }) {
  const { pal, emoji, glyph } = calloutLook(attrs);
  if (glyph) return <CalloutGlyph name={glyph} size={size} strokeWidth={2.2} />;
  if (emoji) return <span aria-hidden="true">{emoji}</span>;
  return <Icon name={pal.icon} size={size} strokeWidth={2.2} />;
}

/**
 * Callout properties (Blocks board, H 42): the kind as coloured chips, the colour of a custom callout (eight
 * swatches or a hex), twelve icons, the style and the title line.
 */
function CalloutProps({
  attrs,
  anchor,
  update,
  onClose,
  onTitle,
}: {
  attrs: Record<string, unknown>;
  anchor: DOMRect | null;
  update: (a: Record<string, unknown>) => void;
  onClose: () => void;
  onTitle: () => void;
}) {
  const { kind, look, glyph } = calloutLook(attrs);
  const [hex, setHex] = useState(isHex(attrs.color) ? String(attrs.color).toUpperCase() : '');
  const title = attrs.title;
  const color = typeof attrs.color === 'string' ? attrs.color : null;
  return (
    <Panel
      title="Callout"
      anchor={anchor}
      onClose={onClose}
      testId="callout-props"
      width={340}
      footer={
        <button type="button" className="dk-btn-primary" style={{ marginLeft: 'auto' }} onClick={onClose}>
          Done
        </button>
      }
    >
      <Row label="Kind">
        <div className="dk-kinds" role="radiogroup" aria-label="Kind">
          {CALLOUT_KINDS.map((k) => {
            const st = k === 'custom' ? { bg: '#F2EEFB', border: '#D8CFF3', fg: '#5B4BB5' } : CALLOUT_STYLE[k];
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={k === kind}
                className={k === kind ? 'on' : undefined}
                style={{ background: st.bg, borderColor: st.border, color: st.fg }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  update(k === 'custom' ? { kind: k, color: attrs.color ?? 'violet' } : { kind: k, color: null })
                }
              >
                {CALLOUT_STYLE[k].label}
              </button>
            );
          })}
        </div>
      </Row>
      {kind === 'custom' && (
        <Row label="Colour">
          <div className="dk-swatches dk-swatches-24" role="radiogroup" aria-label="Colour">
            {CALLOUT_COLORS.map((n) => {
              const on = color === n || (isHex(color) && color.toUpperCase() === swatchHex('c', n).toUpperCase());
              return (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={colorLabel(n)}
                  title={colorLabel(n)}
                  className={`dk-swatch${on ? ' on' : ''}`}
                  style={{ background: swatchHex('c', n) }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    update({ color: n });
                    setHex(swatchHex('c', n).toUpperCase());
                  }}
                />
              );
            })}
          </div>
          <label className="dk-bp-fields-one">
            <span>Custom</span>
            <input
              className="dk-bp-field dk-bp-mono"
              aria-label="Custom colour"
              placeholder="#5B4BB5"
              value={hex || (color ? swatchHex('c', color).toUpperCase() : '')}
              onChange={(e) => {
                setHex(e.target.value);
                if (isHex(e.target.value)) update({ color: e.target.value });
              }}
            />
          </label>
        </Row>
      )}
      <Row label="Icon">
        <div className="dk-icon-grid" role="radiogroup" aria-label="Icon">
          {CALLOUT_ICON_NAMES.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={glyph === n}
              aria-label={calloutIconLabel(n)}
              title={calloutIconLabel(n)}
              className={glyph === n ? 'on' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => update({ icon: glyph === n ? null : n })}
            >
              <CalloutGlyph name={n} size={16} />
            </button>
          ))}
        </div>
      </Row>
      <Row label="Style">
        <Seg
          label="Style"
          value={look}
          onChange={(v) => update({ style: v })}
          options={[
            { value: 'soft', label: 'Soft box' },
            { value: 'bar', label: 'Left bar' },
            { value: 'outline', label: 'Outline' },
          ]}
        />
        <Toggle
          label="Title line"
          checked={title !== null && title !== undefined}
          onChange={(v) => {
            update({ title: v ? '' : null });
            if (v) onTitle();
          }}
        />
      </Row>
    </Panel>
  );
}

/** The callout node view. */
export function CalloutView({ node, decorations, updateAttributes, editor }: NodeViewProps) {
  const attrs = node.attrs as Record<string, unknown>;
  const { kind, pal, fg, box, look } = calloutLook(attrs);
  const focused = decorations.some((d) =>
    (d.type as unknown as { attrs?: { class?: string } }).attrs?.class?.includes('is-focused'),
  );
  const [open, setOpen] = useState<DOMRect | null>(null);
  const [hover, setHover] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const editable = editor.isEditable;
  const title = attrs.title;

  return (
    <NodeViewWrapper
      className="dk-callout-wrap"
      data-callout={kind}
      data-callout-style={look}
      style={{ position: 'relative', margin: '0 0 14px' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {editable && (focused || open || hover) && (
        <div contentEditable={false} className="dk-callout-ctl" data-block-ui="">
          <button
            type="button"
            aria-label="Callout type"
            data-testid="callout-type"
            aria-expanded={!!open}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setOpen((o) => (o ? null : r));
            }}
            className="dk-callout-btn"
          >
            <CalloutIcon attrs={attrs} size={12} /> {pal.label}
            <Icon name="chevronDown" size={10} />
          </button>
          {open && (
            <CalloutProps
              attrs={attrs}
              anchor={open}
              update={updateAttributes}
              onClose={() => setOpen(null)}
              onTitle={() => window.setTimeout(() => titleRef.current?.focus(), 0)}
            />
          )}
        </div>
      )}
      <div
        className="dk-callout"
        style={{
          ...box,
          boxShadow: focused
            ? `0 0 0 3px ${typeof fg === 'string' && fg.startsWith('#') ? `${fg}26` : 'rgba(46,111,64,0.15)'}`
            : undefined,
          margin: 0,
        }}
      >
        <span contentEditable={false} style={{ color: fg, marginTop: 2, display: 'flex' }}>
          <CalloutIcon attrs={attrs} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {title !== null && title !== undefined && (
            <input
              ref={titleRef}
              className="dk-callout-title-input"
              style={{ color: fg }}
              aria-label="Callout title"
              placeholder="Title"
              value={str(title)}
              readOnly={!editable}
              onChange={(e) => updateAttributes({ title: e.target.value })}
            />
          )}
          <NodeViewContent style={{ minWidth: 0 }} />
        </div>
      </div>
    </NodeViewWrapper>
  );
}
