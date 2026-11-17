/**
 * Quotes and dividers while editing (board H 44–47): a block quote in three variants (bar, serif, card) with a
 * source line; a pull quote with its alignment and source; a divider in eight styles, a scene break among them.
 * Each has one small picker that shows with the cursor in it (a selected divider), drawn as the reader draws them.
 */

import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { RULE_STYLES } from './commands';
import { useInside } from './useInside';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A row of choices above a block. */
function Picker<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div
      className="dk-btoolbar dk-quote-picker"
      role="radiogroup"
      aria-label={label}
      contentEditable={false}
      data-block-ui=""
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`dk-btb wide${o.value === value ? ' on' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A source line ("— Hoa Mai, design review") under a quote. */
function SourceInput({
  value,
  onChange,
  editable,
  show,
}: {
  value: string;
  onChange: (v: string | null) => void;
  editable: boolean;
  show: boolean;
}) {
  if (!show && !value) return null;
  return (
    <span className="dk-quote-source dk-quote-source-edit" contentEditable={false}>
      —{' '}
      <input
        aria-label="Source"
        placeholder="Source"
        value={value}
        readOnly={!editable}
        onChange={(e) => onChange(e.target.value || null)}
      />
    </span>
  );
}

/** The block quote node view: Bar (plain), Serif, Card, and the source. */
export function BlockquoteView({ node, editor, getPos, updateAttributes }: NodeViewProps) {
  const inside = useInside(editor, getPos, node.nodeSize);
  const variant = (str(node.attrs.variant) || 'plain') as 'plain' | 'serif' | 'card';
  return (
    <NodeViewWrapper className="dk-quotev" data-variant={variant}>
      {inside && (
        <Picker
          label="Quote style"
          value={variant}
          onChange={(v) => updateAttributes({ variant: v })}
          options={[
            { value: 'plain', label: 'Bar' },
            { value: 'serif', label: 'Serif' },
            { value: 'card', label: 'Card' },
          ]}
        />
      )}
      <blockquote className={variant !== 'plain' ? `dk-quote-${variant}` : undefined}>
        <NodeViewContent />
        <SourceInput
          value={str(node.attrs.source)}
          onChange={(v) => updateAttributes({ source: v })}
          editable={editor.isEditable}
          show={inside}
        />
      </blockquote>
    </NodeViewWrapper>
  );
}

/** The pull quote node view: alignment and source. */
export function PullQuoteView({ node, editor, getPos, updateAttributes }: NodeViewProps) {
  const inside = useInside(editor, getPos, node.nodeSize);
  const align = (str(node.attrs.textAlign) || 'center') as 'left' | 'center' | 'right';
  return (
    <NodeViewWrapper className="dk-pullquotev">
      {inside && (
        <Picker
          label="Pull quote alignment"
          value={align}
          onChange={(v) => updateAttributes({ textAlign: v })}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Centre' },
            { value: 'right', label: 'Right' },
          ]}
        />
      )}
      <figure className="dk-pullquote" style={{ textAlign: align }}>
        <NodeViewContent className="dk-pq-text" />
        <figcaption>
          <SourceInput
            value={str(node.attrs.source)}
            onChange={(v) => updateAttributes({ source: v })}
            editable={editor.isEditable}
            show={inside}
          />
        </figcaption>
      </figure>
    </NodeViewWrapper>
  );
}

/** What a divider style draws: glyphs for the scene breaks, a rule for the rest. */
export const RULE_GLYPHS: Record<string, string> = { dots: '•  •  •', stars: '*  *  *', fleuron: '❦' };

/** The divider node view: the rule in its style and, when selected, the eight styles. */
export function RuleView({ node, selected, editor, updateAttributes }: NodeViewProps) {
  const style = str(node.attrs.style) || 'line';
  const glyphs = RULE_GLYPHS[style];
  return (
    <NodeViewWrapper className={`dk-rulev${selected ? ' is-selected' : ''}`} data-style={style} data-drag-handle="">
      {glyphs ? (
        <div role="separator" className={`dk-rule dk-rule-${style}`}>
          {glyphs}
        </div>
      ) : (
        <hr className={style !== 'line' ? `dk-rule dk-rule-${style}` : undefined} />
      )}
      {selected && editor.isEditable && (
        <div
          className="dk-menu dk-rule-menu"
          role="radiogroup"
          aria-label="Divider style"
          contentEditable={false}
          data-block-ui=""
        >
          {RULE_STYLES.map((r) => (
            <button
              key={r.value}
              type="button"
              role="radio"
              aria-checked={r.value === style}
              className={`dk-mi${r.value === style ? ' dk-mi-on' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => updateAttributes({ style: r.value })}
            >
              <span className={`dk-rule-sample dk-rule-sample-${r.value}`}>
                {RULE_GLYPHS[r.value] ?? (
                  <hr className={r.value !== 'line' ? `dk-rule dk-rule-${r.value}` : undefined} />
                )}
              </span>
              <span className="dk-cat-text">
                <span className="dk-cat-label">{r.label}</span>
                <span className="dk-cat-desc">{r.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </NodeViewWrapper>
  );
}
