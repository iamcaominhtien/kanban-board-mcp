import { useEffect, useMemo, useState } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { Notice } from './StatePanel';
import { AsyncBody, TEXT_LIMIT, TextBody } from './TextReader';
import { decodeText, useFileData } from './useFileData';
import { formatFileSize } from '../../utils/fileIcons';
import type { ReaderProps } from './readerTypes';
import styles from './PreviewViewer.module.css';

/** Markdown file: rendered like Docs, with a switch to the source. */
export default function MarkdownReader({ item, onFacts, actions }: ReaderProps) {
  const [state, retry] = useFileData(item.src, TEXT_LIMIT);
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');
  const text = useMemo(() => (state.status === 'ready' ? decodeText(state.bytes) : ''), [state]);

  useEffect(() => {
    if (state.status === 'ready') onFacts({ Lines: text.split('\n').length.toLocaleString() });
  }, [state, text, onFacts]);

  return (
    <AsyncBody state={state} retry={retry} actions={actions} name={item.name}>
      {state.status === 'ready' && (
        <div className={styles.markdownReader}>
          <div className={styles.readerBar}>
            <div className={styles.segmented} role="tablist" aria-label="Markdown view">
              <button type="button" role="tab" aria-selected={mode === 'rendered'} onClick={() => setMode('rendered')}>
                Rendered
              </button>
              <button type="button" role="tab" aria-selected={mode === 'source'} onClick={() => setMode('source')}>
                Source
              </button>
            </div>
            <span className={styles.readerLabel}>
              {item.name}
              {item.size ? ` · ${formatFileSize(item.size)}` : ''}
            </span>
          </div>
          {state.truncated && (
            <Notice actions={actions}>
              Showing the first {formatFileSize(TEXT_LIMIT)}. Only the beginning is shown.
            </Notice>
          )}
          {mode === 'rendered' ? (
            <div className={styles.markdownPage}>
              <MarkdownRenderer plain>{text}</MarkdownRenderer>
            </div>
          ) : (
            <TextBody text={text} lang="Markdown" label="Markdown source" />
          )}
        </div>
      )}
    </AsyncBody>
  );
}
