/**
 * The status line under the page (Editor board A): words, reading time and how many words are selected, with Focus
 * and the shortcut sheet at its right end. In focus mode only the count stays.
 */

import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { readingMinutes } from '../../pageSettings';
import { countWords } from './format';
import { Glyph, keyLabel } from './parts';

interface Props {
  editor: Editor | null;
  onFocusMode?: () => void;
  onShortcuts?: () => void;
  /** Focus mode: the count only. */
  quiet?: boolean;
}

/** Words and reading time of the whole page, counted a moment after typing stops. */
export function usePageCount(editor: Editor | null): { words: number; minutes: number } {
  const [count, setCount] = useState({ words: 0, minutes: 1 });
  useEffect(() => {
    if (!editor || editor.isDestroyed) return undefined;
    let t: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      if (editor.isDestroyed) return;
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', ' ');
      setCount({ words: countWords(text), minutes: readingMinutes(text) });
    };
    const later = () => {
      if (t) clearTimeout(t);
      t = setTimeout(measure, 300);
    };
    measure();
    editor.on('update', later);
    return () => {
      if (t) clearTimeout(t);
      editor.off('update', later);
    };
  }, [editor]);
  return count;
}

/**
 * The status line.
 * @param props.editor - The editor.
 * @param props.onFocusMode - Shows the Focus button.
 * @param props.onShortcuts - Shows the shortcut sheet button.
 * @param props.quiet - Focus mode: words and reading time only.
 */
export function StatusLine({ editor, onFocusMode, onShortcuts, quiet }: Props) {
  const { words, minutes } = usePageCount(editor);
  const selected = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e || e.state.selection.empty) return 0;
      const { from, to } = e.state.selection;
      return countWords(e.state.doc.textBetween(from, to, ' ', ' '));
    },
  });
  return (
    <div className="dk-status" data-testid="editor-status" role="status" aria-live="off">
      <span data-testid="status-words">
        {words.toLocaleString('en-GB')} {words === 1 ? 'word' : 'words'}
      </span>
      <span>{minutes} min read</span>
      {!!selected && (
        <span className="dk-status-sel" data-testid="status-selected">
          Selected: {selected} {selected === 1 ? 'word' : 'words'}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {!quiet && onShortcuts && (
        <button
          type="button"
          className="dk-status-btn"
          onClick={onShortcuts}
          title={`Keyboard shortcuts (${keyLabel('Mod+/')})`}
        >
          Shortcuts
        </button>
      )}
      {!quiet && onFocusMode && (
        <button type="button" className="dk-status-btn" onClick={onFocusMode} data-testid="status-focus">
          <Glyph name="focus" size={14} />
          Focus <span className="dk-kbd">{keyLabel('Mod+Shift+F')}</span>
        </button>
      )}
    </div>
  );
}
