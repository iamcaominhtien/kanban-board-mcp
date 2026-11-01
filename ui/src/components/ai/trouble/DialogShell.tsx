import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { extractError } from '../../../api/extractError';
import '../ai.css';

/**
 * A small dialog with a title, a hint, a body, Cancel and one confirming button. `onConfirm` may reject: the message
 * shows inside the dialog and what the person typed stays.
 */
export function DialogShell({
  title,
  hint,
  confirm,
  canConfirm,
  onConfirm,
  onClose,
  children,
  width = 440,
}: Readonly<{
  title: string;
  hint?: string;
  confirm: string;
  canConfirm: boolean;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [onClose]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div
      className="ai-overlay"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="presentation"
    >
      <div className="ai-modal" role="dialog" aria-label={title} style={{ width }}>
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">{title}</h2>
          {hint && <div className="ai-hint">{hint}</div>}
        </div>
        <div className="ai-modal-body" style={{ gap: 8 }}>
          {children}
          {error && (
            <div className="ai-error-text" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="ai-modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!canConfirm || busy}
            onClick={() => void submit()}
          >
            {confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
