import { useEffect, useState } from 'react';
import { countPageRefs, lineDiffCounts } from '../../utils/lineDiff';
import { avatarColors } from './docsUi';
import { CloseButton, DOCS_SCRIM, useEscape } from './docsShared';
import { Icon } from './Icon';
import './docs.css';

const MAX_NOTE = 200;

interface Props {
  pageTitle: string;
  fromVersion: number;
  baseMarkdown: string;
  draftMarkdown: string;
  publishing: boolean;
  error?: string | null;
  onClose: () => void;
  onReview: () => void;
  onPublish: (note: string, notify: boolean) => void;
}

/** "Publish changes" dialog (DocsEditor board E): diff summary, version note and Notify members. */
export function PublishDialog({
  pageTitle,
  fromVersion,
  baseMarkdown,
  draftMarkdown,
  publishing,
  error,
  onClose,
  onReview,
  onPublish,
}: Props) {
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  useEscape(onClose);
  const { added, removed } = lineDiffCounts(baseMarkdown, draftMarkdown);
  const refsAdded = Math.max(0, countPageRefs(draftMarkdown) - countPageRefs(baseMarkdown));
  const next = fromVersion + 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !publishing) {
        e.preventDefault();
        onPublish(note, notify);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [note, notify, publishing, onPublish]);

  return (
    <div
      className="docs-root"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: DOCS_SCRIM,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Publish page"
        style={{
          width: 520,
          maxWidth: '100%',
          borderRadius: 12,
          border: '1px solid #E3E8E5',
          boxShadow: '0 24px 64px rgba(30,42,34,0.28)',
          background: '#FFFFFF',
          overflow: 'hidden',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            padding: '18px 24px',
            borderBottom: '1px solid #E3E8E5',
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>Publish changes</div>
            <div style={{ fontSize: 12, color: '#5B6B60', marginTop: 2 }}>
              {pageTitle} · v{fromVersion} → v{next}
            </div>
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 8,
              background: '#F6FAF7',
              border: '1px solid #E3E8E5',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                gap: 8,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              <span style={{ color: '#2E6F40' }}>+{added}</span>
              <span style={{ color: '#C4432A' }}>−{removed}</span>
            </span>
            <span style={{ fontSize: 12.5, color: '#5B6B60', flex: 1 }}>
              lines changed
              {refsAdded > 0 && (
                <>
                  {' '}
                  · {refsAdded} reference{refsAdded === 1 ? '' : 's'} added
                </>
              )}
            </span>
            {fromVersion > 0 && (
              <button
                type="button"
                onClick={onReview}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#2E6F40',
                  textDecoration: 'underline',
                  textUnderlineOffset: 2,
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Review changes
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label htmlFor="docs-version-note" className="st-field-label">
                Version note
              </label>
              <span style={{ fontSize: 11, color: '#9AA8A0', fontFamily: "'JetBrains Mono', monospace" }}>
                {note.length} / {MAX_NOTE}
              </span>
            </div>
            <textarea
              id="docs-version-note"
              aria-label="Version note"
              autoFocus
              className="st-input"
              value={note}
              maxLength={MAX_NOTE}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What changed? e.g. Added the rate limiting section and linked KAN-12."
              style={{ minHeight: 72, lineHeight: 1.5, resize: 'vertical' }}
            />
            <div className="st-hint">Shown in version history next to v{next}. Optional.</div>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 14px',
              border: '1px solid #E3E8E5',
              borderRadius: 8,
            }}
          >
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>Notify members</span>
              <span className="st-hint">Everyone who follows this space gets a notification.</span>
            </div>
            <div style={{ display: 'flex', marginRight: 6 }}>
              {['Hoa Mai', 'Tuan Vo', 'Linh Pham'].map((n) => (
                <span
                  key={n}
                  style={{ marginLeft: -6, border: '2px solid #FFFFFF', borderRadius: '50%', display: 'flex' }}
                >
                  <span
                    title={n}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      ...avatarColors(n),
                      fontSize: 11,
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {n
                      .split(' ')
                      .map((p) => p[0])
                      .join('')}
                  </span>
                </span>
              ))}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={notify}
              aria-label="Notify members"
              className="st-toggle-track"
              onClick={() => setNotify((v) => !v)}
              style={{ background: notify ? '#2E6F40' : '#C7D2CB', border: 'none', padding: 0 }}
            >
              <span className="st-toggle-dot" style={{ left: notify ? 17 : 2 }} />
            </button>
          </div>
          {error && (
            <div
              role="alert"
              style={{ padding: '8px 12px', borderRadius: 8, background: '#FBE7E4', color: '#A5321E', fontSize: 12.5 }}
            >
              {error}
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '14px 24px',
            borderTop: '1px solid #E3E8E5',
            background: '#FBFCFB',
          }}
        >
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary"
            disabled={publishing}
            onClick={() => onPublish(note, notify)}
            data-testid="confirm-publish"
          >
            {publishing ? <span className="mc-spin mc-spin-w" /> : <Icon name="i46" size={14} />}
            Publish v{next}
          </button>
        </div>
      </div>
    </div>
  );
}
