/**
 * The callout while editing (board H 41–43): five fixed kinds (Info, Note, Success, Warning, Danger) and a custom one
 * with its own colour (a palette name or #rrggbb) and icon; three styles (soft box, left bar, outline) and an optional
 * title line. Drawn as RichDocView draws it. The kind button above a focused callout lists the kinds (menu items),
 * then the colour, icon, style and title.
 */

import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../../Icon';
import { CALLOUT_STYLE, type CalloutKind } from '../constants';
import { TEXT_COLOR_NAMES, colorCss, isHex } from './palette';
import { Row, Seg, Swatches, Toggle } from './ui';

/** The kinds in the order of the picker. */
export const CALLOUT_KINDS: CalloutKind[] = ['info', 'note', 'success', 'warning', 'danger', 'custom'];

/** Icons a callout can carry instead of its kind's own. */
export const CALLOUT_ICONS = ['💡', '📌', '⚠️', '✅', '❗', '🔥', '⭐', '📝', '❓', '🚀', '🔒', '🧪'];

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
  return { kind, pal, fg, box, look, emoji: icon && !/^[\w:-]+$/.test(icon) ? icon : null };
}

/** The callout node view. */
export function CalloutView({ node, decorations, updateAttributes, editor }: NodeViewProps) {
  const attrs = node.attrs as Record<string, unknown>;
  const { kind, pal, fg, box, look, emoji } = calloutLook(attrs);
  const focused = decorations.some((d) =>
    (d.type as unknown as { attrs?: { class?: string } }).attrs?.class?.includes('is-focused'),
  );
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [hex, setHex] = useState(isHex(attrs.color) ? String(attrs.color) : '');
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Element)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
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
        <div ref={ref} contentEditable={false} className="dk-callout-ctl" data-block-ui="">
          <button
            type="button"
            aria-label="Callout type"
            data-testid="callout-type"
            aria-expanded={open}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((o) => !o)}
            className="dk-callout-btn"
          >
            {emoji ? <span aria-hidden="true">{emoji}</span> : <Icon name={pal.icon} size={12} />} {pal.label}
            <Icon name="chevronDown" size={10} />
          </button>
          {open && (
            <div className="dk-menu dk-callout-menu" role="menu" aria-label="Callout">
              <div className="dk-bp-label" style={{ padding: '4px 10px 2px' }}>
                Kind
              </div>
              {CALLOUT_KINDS.map((k) => (
                <div
                  key={k}
                  role="menuitem"
                  className={`dk-mi${k === kind ? ' dk-mi-on' : ''}`}
                  style={{ gap: 9, padding: '6px 10px' }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    updateAttributes(
                      k === 'custom' ? { kind: k, color: attrs.color ?? 'violet' } : { kind: k, color: null },
                    );
                    if (k !== 'custom') setOpen(false);
                  }}
                >
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 3,
                      background: CALLOUT_STYLE[k].bg,
                      border: `1px solid ${CALLOUT_STYLE[k].border}`,
                    }}
                  />
                  <span>{CALLOUT_STYLE[k].label}</span>
                  {k === kind && (
                    <span style={{ marginLeft: 'auto', color: '#2E6F40', display: 'flex' }}>
                      <Icon name="i10" size={14} />
                    </span>
                  )}
                </div>
              ))}
              <div
                className="dk-callout-props"
                onMouseDown={(e) => {
                  if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
                }}
              >
                {kind === 'custom' && (
                  <Row label="Colour">
                    <Swatches
                      kind="c"
                      label="Colour"
                      names={TEXT_COLOR_NAMES}
                      value={isHex(attrs.color) ? null : (attrs.color as string | null)}
                      onChange={(v) => updateAttributes({ color: v })}
                    />
                    <input
                      className="dk-bp-input dk-bp-hex"
                      aria-label="Custom colour"
                      placeholder="#5B4BB5"
                      value={hex}
                      onChange={(e) => {
                        setHex(e.target.value);
                        if (isHex(e.target.value)) updateAttributes({ color: e.target.value });
                      }}
                    />
                  </Row>
                )}
                <Row label="Icon">
                  <div className="dk-emoji-grid" role="radiogroup" aria-label="Icon">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!emoji}
                      className={!emoji ? 'on' : undefined}
                      title="The kind's own icon"
                      onClick={() => updateAttributes({ icon: null })}
                    >
                      <Icon name={pal.icon} size={14} />
                    </button>
                    {CALLOUT_ICONS.map((e) => (
                      <button
                        key={e}
                        type="button"
                        role="radio"
                        aria-checked={emoji === e}
                        className={emoji === e ? 'on' : undefined}
                        onClick={() => updateAttributes({ icon: e })}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row label="Style">
                  <Seg
                    label="Style"
                    value={look}
                    onChange={(v) => updateAttributes({ style: v })}
                    options={[
                      { value: 'soft', label: 'Soft box' },
                      { value: 'bar', label: 'Left bar' },
                      { value: 'outline', label: 'Outline' },
                    ]}
                  />
                </Row>
                <Toggle
                  label="Title line"
                  checked={title !== null && title !== undefined}
                  onChange={(v) => {
                    updateAttributes({ title: v ? '' : null });
                    if (v) window.setTimeout(() => titleRef.current?.focus(), 0);
                  }}
                />
              </div>
            </div>
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
          {emoji ? <span aria-hidden="true">{emoji}</span> : <Icon name={pal.icon} size={16} strokeWidth={2.2} />}
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
