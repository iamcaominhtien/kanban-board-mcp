import { lineDiffCounts } from '../../utils/lineDiff';
import { DOCS_SCRIM, useEscape } from './docsShared';
import { Icon } from './Icon';
import './docs.css';

interface Props {
  pageTitle: string;
  version: number;
  baseMarkdown: string;
  draftMarkdown: string;
  savedAt: Date | null;
  onClose: () => void;
  onDiscard: () => void;
}

/** "Discard your changes?" confirm (DocsEditor board E). Esc = Keep editing. */
export function DiscardDialog({ pageTitle, version, baseMarkdown, draftMarkdown, savedAt, onClose, onDiscard }: Props) {
  useEscape(onClose);
  const { added, removed } = lineDiffCounts(baseMarkdown, draftMarkdown);
  const changes = added + removed;
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
        aria-label="Discard draft"
        style={{
          width: 420,
          maxWidth: '100%',
          borderRadius: 12,
          border: '1px solid #E3E8E5',
          boxShadow: '0 24px 64px rgba(30,42,34,0.28)',
          background: '#FFFFFF',
          overflow: 'hidden',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ padding: '22px 24px 18px', display: 'flex', gap: 14 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: '#FBE7E4',
              color: '#C4432A',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Icon name="i12" size={16} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>Discard your changes?</div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: '#5B6B60' }}>
              Your draft of <b style={{ color: '#1E2A22' }}>{pageTitle}</b> ({changes} change{changes === 1 ? '' : 's'}
              {version > 0 ? ` since v${version}` : ''}
              {savedAt
                ? `, autosaved ${savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
                : ''}
              ) will be deleted.{' '}
              {version > 0
                ? `The published version v${version} stays as it is.`
                : 'The page has no published version yet, so it will be empty.'}
            </div>
          </div>
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
          <button type="button" className="st-btn" onClick={onClose} autoFocus>
            Keep editing
          </button>
          <button type="button" className="st-btn st-btn-danger" onClick={onDiscard} data-testid="confirm-discard">
            <Icon name="i12" size={14} />
            Discard draft
          </button>
        </div>
      </div>
    </div>
  );
}
