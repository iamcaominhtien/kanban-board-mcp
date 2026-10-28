import { CloseButton, DOCS_SCRIM, useEscape } from '../docsShared';
import { Icon } from '../Icon';

/**
 * "Publish with N orphaned comments?" warning (design F): the edits removed the text open comments were attached to.
 * @param props.count - Number of open comments that lose their text.
 * @param props.quotes - Their quoted text (first few are listed).
 * @param props.onReview - Close the warning and open the Comments panel.
 * @param props.onPublish - Go on to the publish dialog.
 * @param props.onClose - Dismiss the warning.
 */
export function OrphanWarning({
  count,
  quotes,
  onReview,
  onPublish,
  onClose,
}: {
  count: number;
  quotes: string[];
  onReview: () => void;
  onPublish: () => void;
  onClose: () => void;
}) {
  useEscape(onClose);
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
        role="alertdialog"
        aria-modal="true"
        aria-label="Publish with orphaned comments"
        data-testid="orphan-warning"
        style={{
          width: 460,
          maxWidth: '100%',
          borderRadius: 12,
          border: '1px solid #E3E8E5',
          boxShadow: '0 24px 64px rgba(30,42,34,0.28)',
          background: '#FFFFFF',
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{ color: '#B4791E', marginTop: 2, display: 'flex' }}>
            <Icon name="i14" size={20} strokeWidth={1.9} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>
              Publish with {count} orphaned comment{count === 1 ? '' : 's'}?
            </div>
            <p style={{ margin: '6px 0 0', fontSize: 13.5, lineHeight: 1.5, color: '#5B6B60' }}>
              Your edits removed the text that {count} open comment{count === 1 ? ' was' : 's were'} attached to.{' '}
              {count === 1 ? 'It stays' : 'They stay'} in the Comments panel and can be re-attached or resolved later.
            </p>
          </div>
          <CloseButton onClick={onClose} />
        </div>
        {quotes.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 36, fontSize: 13, color: '#3A4A3E', fontStyle: 'italic' }}>
            {quotes.slice(0, 4).map((q, i) => (
              <li key={i}>“{q}”</li>
            ))}
          </ul>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" className="st-btn" onClick={onReview} data-testid="orphan-review">
            Review comments
          </button>
          <button type="button" className="st-btn st-btn-primary" onClick={onPublish} data-testid="orphan-publish">
            Publish anyway
          </button>
        </div>
      </div>
    </div>
  );
}
