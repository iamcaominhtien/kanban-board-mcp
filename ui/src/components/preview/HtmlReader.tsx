import { useEffect, useMemo, useState } from 'react';
import { Notice } from './StatePanel';
import { AsyncBody, TextBody } from './TextReader';
import { decodeText, useFileData } from './useFileData';
import { formatFileSize } from '../../utils/fileIcons';
import type { ReaderProps } from './readerTypes';
import styles from './PreviewViewer.module.css';

const HTML_LIMIT = 2 * 1024 * 1024;
type Width = 'desktop' | 'tablet' | 'phone';
const WIDTHS: Record<Width, string> = { desktop: '100%', tablet: '768px', phone: '390px' };

/**
 * HTML reader: the real page in an open frame, or the source.
 * The page is shown as written, like the file opened in a browser tab: scripts, forms, pop-ups, CDN links and fonts
 * all work. The server keeps serving HTML as plain text; the app reads that text and puts it in the frame.
 */
export function HtmlReader({ item, onFacts, actions }: ReaderProps) {
  const [state, retry] = useFileData(item.src, HTML_LIMIT);
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [width, setWidth] = useState<Width>('desktop');
  const [reload, setReload] = useState(0);
  const source = useMemo(() => (state.status === 'ready' ? decodeText(state.bytes) : ''), [state]);

  useEffect(() => {
    if (state.status === 'ready') onFacts({ Type: 'HTML page' });
  }, [state, onFacts]);

  return (
    <AsyncBody state={state} retry={retry} actions={actions} name={item.name}>
      {state.status === 'ready' && (
        <div className={styles.htmlReader}>
          <div className={styles.readerBar}>
            <div className={styles.segmented} role="tablist" aria-label="HTML view">
              <button type="button" role="tab" aria-selected={mode === 'preview'} onClick={() => setMode('preview')}>
                Preview
              </button>
              <button type="button" role="tab" aria-selected={mode === 'source'} onClick={() => setMode('source')}>
                Source
              </button>
            </div>
            <span className={styles.safeBadge} title="Runs like the file opened in a browser">
              Live page
            </span>
            <span className={styles.readerBarSpacer} />
            {mode === 'preview' && (
              <>
                <div className={styles.segmented} role="group" aria-label="Page width">
                  {(['desktop', 'tablet', 'phone'] as Width[]).map((w) => (
                    <button key={w} type="button" aria-pressed={width === w} onClick={() => setWidth(w)}>
                      {w[0].toUpperCase() + w.slice(1)}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => setReload((n) => n + 1)}>
                  Reload
                </button>
              </>
            )}
          </div>
          {state.status === 'ready' && state.truncated && (
            <Notice actions={actions}>
              Showing the first {formatFileSize(HTML_LIMIT)}
              {state.total ? ` of ${formatFileSize(state.total)}` : ''}; the page may look incomplete.
            </Notice>
          )}
          {mode === 'preview' ? (
            <div className={styles.frameStage}>
              <iframe
                key={`${item.src}:${reload}`}
                title={`${item.name} (page)`}
                className={styles.htmlFrame}
                style={{ width: WIDTHS[width] }}
                srcDoc={source}
              />
            </div>
          ) : (
            <TextBody text={source} lang="HTML" label={`HTML · ${source.split('\n').length.toLocaleString()} lines`} />
          )}
        </div>
      )}
    </AsyncBody>
  );
}
