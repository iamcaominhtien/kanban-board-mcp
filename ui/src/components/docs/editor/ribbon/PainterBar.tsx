/**
 * The bar of the format painter (Editor board N): what was copied, and Keep on (after one click) or Done (when the
 * brush stays on). Esc or Done ends it.
 */

import type { Editor } from '@tiptap/core';
import { describeFormat } from './format';
import { richStorage, stopPainter } from './RichFormatting';
import { useStore } from './store';

/**
 * The painter bar, shown while the brush is on.
 * @param props.editor - The editor.
 * @param props.touch - Phone wording ("Painting · tap or drag over text").
 */
export function PainterBar({ editor, touch }: { editor: Editor | null; touch?: boolean }) {
  const store = richStorage(editor)?.painter;
  const p = useStore(store, { format: null, mode: 'off' as const });
  if (!editor || p.mode === 'off' || !p.format) return null;
  return (
    <div className={`dk-painter${touch ? ' dk-painter-touch' : ''}`} role="status" data-testid="painter-bar">
      <span className="dk-painter-dot" aria-hidden="true" />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {touch ? 'Painting · tap or drag over text' : `Format copied · ${describeFormat(p.format)}`}
      </span>
      {p.mode === 'once' && !touch ? (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => store?.set({ ...p, mode: 'sticky' })}
        >
          Keep on
        </button>
      ) : (
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => stopPainter(editor)}>
          Done
        </button>
      )}
    </div>
  );
}
