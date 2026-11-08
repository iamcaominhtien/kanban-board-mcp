import { useEffect, useState } from 'react';
import { aiApi, useAiMutation } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiTeam } from '../../types/ai';
import type { Member } from '../../types';
import { useToast } from '../Toast';
import { currentPerson } from '../assist/assistUi';

/** Remove an AI team, with work in flight: its open tickets go to a person or to nobody; its runs are cancelled. */
export function RemoveAiDialog({
  member,
  humans,
  onClose,
  onRemoved,
}: {
  member: AiTeam;
  humans: Member[];
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const [impact, setImpact] = useState<Awaited<ReturnType<typeof aiApi.removalImpact>> | null>(null);
  // “Reassign to a person” comes preselected (to you when you are one of them): nobody's work is dropped by accident
  const [tickets, setTickets] = useState<'reassign' | 'unassign'>(humans.length ? 'reassign' : 'unassign');
  const [reassignTo, setReassignTo] = useState((humans.find((h) => h.name === currentPerson()) ?? humans[0])?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const remove = useAiMutation(() =>
    aiApi.removeTeam(member.id, { tickets, reassignTo: tickets === 'reassign' ? reassignTo : undefined }),
  );
  const loadImpact = () => {
    setError(null);
    aiApi
      .removalImpact(member.id)
      .then(setImpact)
      .catch((err) => setError(`Could not check what ${member.name} is working on. ${extractError(err)}`));
  };
  useEffect(loadImpact, [member.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const open = impact?.openTickets.length ?? 0;
  const running = impact?.activeRuns.filter((r) => r.state !== 'queued') ?? [];
  const reassignName = humans.find((h) => h.id === reassignTo)?.name;
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div className="ai-modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">Remove team {member.name}</h2>
        </div>
        <div className="ai-modal-body">
          {!impact ? (
            error ? (
              <div className="ai-notice ai-notice-error" role="alert">
                <div>
                  <b>Could not load</b>
                  <div>{error}</div>
                  <button type="button" className="ai-link" onClick={loadImpact}>
                    Try again
                  </button>
                </div>
              </div>
            ) : (
              <span className="ai-spin" />
            )
          ) : open || running.length ? (
            <div className="ai-notice ai-notice-warn">
              <div>
                <b>{member.name} still has work</b>
                <div>
                  {open} open ticket{open === 1 ? ' is' : 's are'} assigned to it
                  {running.length ? ` and a run on ${running[0].ticketId} is in progress (it is cancelled)` : ''}.
                </div>
              </div>
            </div>
          ) : (
            <div className="ai-hint">
              {member.name} has no open tickets and no run in progress. Done tickets keep it as history.
            </div>
          )}
          {open > 0 && (
            <div className="ai-field">
              <span className="ai-label ai-label-dark">Its tickets</span>
              <button
                type="button"
                className={`ai-option ${tickets === 'reassign' ? 'ai-option-active' : ''}`}
                onClick={() => setTickets('reassign')}
              >
                <span className={`ai-radio ${tickets === 'reassign' ? 'ai-radio-on' : ''}`} />
                <span style={{ flex: 1 }}>
                  <b style={{ fontSize: 13 }}>Reassign to a person</b>
                  <div className="ai-muted">Assignee becomes {reassignName ?? '…'} (open tickets only).</div>
                </span>
                <select
                  className="ai-select"
                  style={{ width: 150 }}
                  value={reassignTo}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setReassignTo(e.target.value)}
                >
                  {humans.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </button>
              <button
                type="button"
                className={`ai-option ${tickets === 'unassign' ? 'ai-option-active' : ''}`}
                onClick={() => setTickets('unassign')}
              >
                <span className={`ai-radio ${tickets === 'unassign' ? 'ai-radio-on' : ''}`} />
                <span>
                  <b style={{ fontSize: 13 }}>Leave unassigned</b>
                  <div className="ai-muted">Tickets go back to the pool.</div>
                </span>
              </button>
            </div>
          )}
          {impact && error && (
            <div className="ai-notice ai-notice-error" role="alert" data-testid="remove-error">
              <div>
                <b>Could not remove {member.name}</b>
                <div>{error}</div>
              </div>
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
            disabled={!impact || remove.isPending || (open > 0 && tickets === 'reassign' && !reassignTo)}
            data-testid="remove-team-confirm"
            onClick={async () => {
              try {
                setError(null);
                await remove.mutateAsync(undefined);
                toast.success(
                  `${member.name} removed`,
                  open
                    ? tickets === 'reassign'
                      ? `${open} open ticket${open === 1 ? '' : 's'} reassigned to ${reassignName ?? 'a person'}.`
                      : `${open} open ticket${open === 1 ? ' is' : 's are'} unassigned.`
                    : 'Done tickets keep it as history.',
                );
                onRemoved?.();
                onClose();
              } catch (err) {
                setError(extractError(err));
              }
            }}
          >
            {open > 0 && tickets === 'reassign' ? 'Reassign & remove' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  );
}

export { AiPausedBanner, PauseAllButton } from './AiKillSwitch';
