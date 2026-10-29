import { useEffect, useState } from 'react';
import { aiApi, useAiMutation } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiMember } from '../../types/ai';
import type { Member } from '../../types';
import { useToast } from '../Toast';
import { AiAvatar, PROVIDERS } from './aiUi';
import { currentPerson } from '../assist/assistUi';

/** “Change” — choose the Board AI; it must be reachable right now. */
export function BoardAiPicker({
  projectId,
  members,
  currentId,
  onClose,
}: {
  projectId: string;
  members: AiMember[];
  currentId: string | null;
  onClose: () => void;
}) {
  const [pick, setPick] = useState(currentId);
  const [error, setError] = useState<string | null>(null);
  const save = useAiMutation((id: string) => aiApi.updateSettings(projectId, { boardAiId: id }));
  const unreachable = (m: AiMember) =>
    ['key_invalid', 'not_logged_in', 'runner_missing'].includes(m.status.code) || m.connection === 'inbox';
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div className="ai-modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">Choose the Board AI</h2>
          <div className="ai-hint">One AI answers board-wide requests. It needs to be reachable right now.</div>
        </div>
        <div className="ai-modal-body" style={{ gap: 8 }}>
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`ai-option ${pick === m.id ? 'ai-option-active' : ''}`}
              disabled={unreachable(m)}
              onClick={() => setPick(m.id)}
            >
              <span className={`ai-radio ${pick === m.id ? 'ai-radio-on' : ''}`} />
              <AiAvatar provider={m.provider} color={m.color} glyph={m.glyph} size={28} />
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{m.name}</span>
                <span className="ai-muted">
                  {unreachable(m)
                    ? m.connection === 'inbox'
                      ? 'Inbox only — the board cannot start it'
                      : `${m.status.label} — fix to use`
                    : `${m.connection === 'local' ? 'Local runner' : 'API key'} · ${PROVIDERS[m.provider].label}`}
                </span>
              </span>
            </button>
          ))}
          {error && <div className="ai-error-text">{error}</div>}
        </div>
        <div className="ai-modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!pick || pick === currentId || save.isPending}
            onClick={async () => {
              try {
                await save.mutateAsync(pick!);
                onClose();
              } catch (err) {
                setError(extractError(err));
              }
            }}
          >
            Use this AI
          </button>
        </div>
      </div>
    </div>
  );
}

/** Remove AI member, with work in flight (F2). */
export function RemoveAiDialog({
  member,
  humans,
  onClose,
  onRemoved,
}: {
  member: AiMember;
  humans: Member[];
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const [impact, setImpact] = useState<Awaited<ReturnType<typeof aiApi.removalImpact>> | null>(null);
  // “Reassign to a person” comes preselected (to you when you are one of them): nobody's work is dropped by accident
  const [tickets, setTickets] = useState<'reassign' | 'unassign'>(humans.length ? 'reassign' : 'unassign');
  const [reassignTo, setReassignTo] = useState((humans.find((h) => h.name === currentPerson()) ?? humans[0])?.id ?? '');
  const [runs, setRuns] = useState<'finish' | 'cancel'>('finish');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const remove = useAiMutation(() => aiApi.remove(member.id, { tickets, reassignTo, runs }));
  const loadImpact = () => {
    setError(null);
    aiApi
      .removalImpact(member.id)
      .then(setImpact)
      .catch((err) => setError(`Could not check what ${member.name} is working on. ${extractError(err)}`));
  };
  useEffect(loadImpact, [member.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = impact?.openTickets.length ?? 0;
  const running = impact?.activeRuns.filter((r) => r.state !== 'queued') ?? [];
  const reassignName = humans.find((h) => h.id === reassignTo)?.name;
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div className="ai-modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">Remove AI member</h2>
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
                  {running.length ? ` and a run on ${running[0].ticketId} is in progress` : ''}.
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
                  <div className="ai-muted">
                    Assignee becomes {reassignName ?? '…'} (open tickets only; Done tickets keep the AI as history).
                  </div>
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
          {running.length > 0 && (
            <div className="ai-field">
              <span className="ai-label ai-label-dark">The run in progress</span>
              <button
                type="button"
                className={`ai-option ${runs === 'finish' ? 'ai-option-active' : ''}`}
                onClick={() => setRuns('finish')}
              >
                <span className={`ai-radio ${runs === 'finish' ? 'ai-radio-on' : ''}`} />
                <span>
                  <b style={{ fontSize: 13 }}>Let it finish, then remove</b>
                  <div className="ai-muted">
                    Removal happens after {running[0].ticketId} ends. New runs do not start.
                  </div>
                </span>
              </button>
              <button
                type="button"
                className={`ai-option ${runs === 'cancel' ? 'ai-option-active' : ''}`}
                onClick={() => setRuns('cancel')}
              >
                <span className={`ai-radio ${runs === 'cancel' ? 'ai-radio-on' : ''}`} />
                <span>
                  <b style={{ fontSize: 13 }}>Cancel the run now</b>
                  <div className="ai-muted">Stops the CLI process. Partial work in the folder is kept.</div>
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
            disabled={!impact || remove.isPending || (tickets === 'reassign' && !reassignTo)}
            onClick={async () => {
              try {
                setError(null);
                const r = await remove.mutateAsync(undefined);
                toast.success(
                  r.scheduled ? `${member.name} will be removed when its run ends` : `${member.name} removed`,
                  open
                    ? tickets === 'reassign'
                      ? `${open} open ticket${open === 1 ? '' : 's'} reassigned to ${reassignName ?? 'a person'}. Done tickets keep it as history.`
                      : `${open} open ticket${open === 1 ? ' is' : 's are'} unassigned. Done tickets keep it as history.`
                    : 'Done tickets keep it as history.',
                );
                onRemoved?.();
                onClose();
              } catch (err) {
                setError(extractError(err));
              }
            }}
          >
            {open && tickets === 'reassign' ? 'Reassign & remove' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  );
}

export { AiPausedBanner, PauseAllButton } from './AiKillSwitch';
