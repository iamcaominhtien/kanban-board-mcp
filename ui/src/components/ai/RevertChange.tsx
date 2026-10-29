import { useEffect, useState } from 'react';
import { aiApi, useAiMutation, type RevertRow } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { ActivityEntry } from '../../types/ticket';
import { useToast } from '../Toast';
import { fieldLabel, fmtValue } from './RunActions';
import { hhmm } from './aiUi';
import './ticketWork.css';

/**
 * Revert one change an AI made (G2): “Revert Estimate to 3 pt?” says who changed it, for whom, and whether anyone
 * changed it since (then it is left as it is). The revert is recorded in Activity under the reverting person.
 */
export function RevertChangeDialog({
  entry,
  onClose,
}: {
  entry: ActivityEntry;
  projectId?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [row, setRow] = useState<RevertRow | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const revert = useAiMutation((id: string) => aiApi.revertEntries([id]));
  useEffect(() => {
    let live = true;
    aiApi
      .revertPreview(entry.runId as string)
      .then((rows) => live && setRow(rows.find((r) => r.kind === 'field' && r.field === entry.field) ?? null))
      .catch((e) => live && setError(extractError(e)));
    return () => {
      live = false;
    };
  }, [entry.runId, entry.field]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const field = fieldLabel(entry.field);
  const to = fmtValue(entry.field, entry.from);
  const blocked = !!row?.conflict;
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal ai-root"
        style={{ width: 460 }}
        role="dialog"
        aria-label={`Revert ${field}`}
        data-testid="revert-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title" style={{ fontSize: 16 }}>
            Revert {field} to {to}?
          </h2>
        </div>
        <div className="ai-modal-body">
          {row === undefined && !error && <span className="ai-spin" />}
          {error && <div className="ai-notice ai-notice-error">{error}</div>}
          {row === null && <div className="ai-hint">This change was already reverted or cannot be undone.</div>}
          {row && (
            <div className="ai-hint" style={{ fontSize: 13, lineHeight: 1.55 }}>
              Changed by {entry.actor}
              {entry.onBehalfOf ? `, on behalf of ${entry.onBehalfOf}` : ''}, at {hhmm(entry.at)}.{' '}
              {blocked
                ? `${row.editedBy ?? 'A person'} changed it again${row.editedAt ? ` at ${hhmm(row.editedAt)}` : ''}, so it is left as it is.`
                : 'Nobody has changed it since. The revert is recorded in Activity under your name.'}
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
            className="ai-btn ai-btn-danger"
            disabled={!row || blocked || revert.isPending}
            data-testid="revert-confirm"
            onClick={async () => {
              try {
                await revert.mutateAsync(row!.entryId as string);
                toast.success(`${field} reverted to ${to}`);
                onClose();
              } catch (err) {
                toast.error("Couldn't revert", extractError(err));
              }
            }}
          >
            Revert change
          </button>
        </div>
      </div>
    </div>
  );
}
