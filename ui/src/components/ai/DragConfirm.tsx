import { useEffect } from 'react';
import type { AiRun } from '../../types/ai';
import { STATUS_NAMES, useAiBoardState, AiAvatar } from './aiUi';
import './ticketWork.css';

/**
 * Dragging a card an AI holds asks first (A4): “Move anyway and cancel the run?”, as a dialog of its own. The move
 * ends the run; its files stay on the branch.
 */
export function DragConfirm({
  run,
  to,
  onCancel,
  onConfirm,
}: {
  run: AiRun;
  to: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { members } = useAiBoardState();
  const ai = members.get(run.memberId);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onCancel]);
  const stateWords =
    run.state === 'queued'
      ? 'has it queued'
      : run.state === 'needs_input'
        ? 'is waiting for an answer on it'
        : 'is working on it';
  return (
    <div className="ai-overlay" onClick={onCancel} data-testid="drag-confirm-overlay">
      <div
        className="ai-modal ai-root"
        style={{ width: 440 }}
        role="alertdialog"
        aria-label={`Move ${run.ticketId} anyway`}
        data-testid="drag-confirm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ai-modal-head" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {ai && <AiAvatar provider={ai.provider} color={ai.color} glyph={ai.glyph} size={34} />}
          <div>
            <h2 className="ai-modal-title" style={{ fontSize: 16 }}>
              Move {run.ticketId} anyway?
            </h2>
            <div className="ai-hint">
              {run.memberName} {stateWords} (run #{run.number}).
            </div>
          </div>
        </div>
        <div className="ai-modal-body">
          <div className="ai-notice ai-notice-warn">
            <div>
              Moving it to <b>{STATUS_NAMES[to] ?? to}</b> cancels the run and releases the hold. Files stay on the
              branch; the status the run set is not restored.
            </div>
          </div>
        </div>
        <div className="ai-modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onCancel} data-testid="drag-confirm-keep">
            Keep it with the AI
          </button>
          <button type="button" className="ai-btn ai-btn-danger" onClick={onConfirm} data-testid="drag-confirm-move">
            Move and cancel run
          </button>
        </div>
      </div>
    </div>
  );
}
