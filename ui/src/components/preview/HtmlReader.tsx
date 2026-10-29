import { useEffect, useMemo, useState } from 'react';
import { Notice } from './StatePanel';
import { AsyncBody, TextBody } from './TextReader';
import { decodeText, useFileData } from './useFileData';
import { makeSafeHtml } from './htmlSafe';
import { formatFileSize } from '../../utils/fileIcons';
import type { ReaderProps } from './readerTypes';
import styles from './PreviewViewer.module.css';

const HTML_LIMIT = 2 * 1024 * 1024;
type Width = 'desktop' | 'tablet' | 'phone';
const WIDTHS: Record<Width, string> = { desktop: '100%', tablet: '768px', phone: '390px' };

/**
 * HTML reader: the real page in a locked frame, or the source.
 * The frame has an empty `sandbox` (no scripts, forms, pop-ups, top navigation or same-origin access) and its document
 * carries a CSP that blocks every outside request. The server keeps serving HTML as plain text; the app reads that text
 * and puts it in the frame, so an uploaded page never runs in the app's own origin.
 */
export function HtmlReader({ item, onFacts, actions }: ReaderProps) {
  const [state, retry] = useFileData(item.src, HTML_LIMIT);
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [width, setWidth] = useState<Width>('desktop');
  const [reload, setReload] = useState(0);
  const [whyOpen, setWhyOpen] = useState(false);
  const source = useMemo(() => (state.status === 'ready' ? decodeText(state.bytes) : ''), [state]);
  const safe = useMemo(() => (state.status === 'ready' ? makeSafeHtml(source) : null), [state, source]);

  useEffect(() => {
    if (state.status === 'ready') onFacts({ Type: 'HTML page' });
  }, [state, onFacts]);

  const blocked = safe ? safe.external.images + safe.external.styles + safe.external.other : 0;
  const parts = safe
    ? [
        safe.external.images && `${safe.external.images} image${safe.external.images === 1 ? '' : 's'}`,
        safe.external.styles && `${safe.external.styles} style${safe.external.styles === 1 ? '' : 's'}`,
        safe.external.other && `${safe.external.other} other file${safe.external.other === 1 ? '' : 's'}`,
      ].filter(Boolean)
    : [];

  return (
    <AsyncBody state={state} retry={retry} actions={actions} name={item.name}>
      {safe && (
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
            <span className={styles.safeBadge} title="Scripts, forms, pop-ups and outside requests are off">
              Safe preview
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
          {mode === 'preview' && blocked > 0 && (
            <Notice
              actions={
                <button type="button" className={styles.linkBtn} onClick={() => setWhyOpen((v) => !v)}>
                  Why?
                </button>
              }
            >
              <strong>Some content from the internet was not loaded.</strong> {parts.join(' and ')}{' '}
              {blocked === 1 ? 'is' : 'are'} fetched from other websites. The preview does not load them. Pictures and
              styles stored inside the file still show.
              {whyOpen && (
                <span className={styles.noticeWhy}>
                  {' '}
                  A page loading things from the internet could track you or read data, so the preview keeps every
                  outside request off.
                </span>
              )}
            </Notice>
          )}
          {mode === 'preview' && safe.scripts > 0 && (
            <Notice actions={actions}>
              <strong>This page uses scripts.</strong> Scripts are turned off in the preview, so interactive parts or
              content added by scripts may be missing. Open the file in an app to see it fully.
            </Notice>
          )}
          {mode === 'preview' ? (
            <div className={styles.frameStage}>
              <iframe
                key={`${item.src}:${reload}`}
                title={`${item.name} (safe preview)`}
                className={styles.htmlFrame}
                style={{ width: WIDTHS[width] }}
                sandbox=""
                referrerPolicy="no-referrer"
                srcDoc={safe.srcDoc}
              />
            </div>
          ) : (
            <TextBody text={source} lang="HTML" label={`HTML · ${source.split('\n').length.toLocaleString()} lines`} />
          )}
          {mode === 'preview' && (
            <div className={styles.frameHint}>
              Links inside the page do not open from the preview. Forms and pop-ups are off.
            </div>
          )}
        </div>
      )}
    </AsyncBody>
  );
}
