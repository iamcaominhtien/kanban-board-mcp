import { useState } from 'react';
import { aiApi, useAiMutation } from '../../api/ai';
import { useResumeInfo } from '../../api/aiSafety';
import { extractError } from '../../api/extractError';
import type { AiMember, AiSettings } from '../../types/ai';
import { useToast } from '../Toast';
import { useAiBoardState } from './aiUi';
import { ACTION_LABEL, RESULT_STYLE, dateTime, usd } from './aiSafetyUi';

/** Kill switch and containment (design/screens/ai-safety-cost.md, D1 to D5). */

/** Chip shown in headers and on cards while safe mode is on (D5). */
export function SafeModeChip({ title = 'Read and comment only' }: { title?: string }) {
  return (
    <span
      className="ai-chip"
      style={{ background: '#FDF0E6', color: '#B4571F' }}
      title={title}
      data-testid="safe-mode-chip"
    >
      Safe mode
    </span>
  );
}

/** Header button: “Pause all AI” (with the running count) or, while paused, “AI paused · Resume”. */
export function PauseAllButton({
  projectId,
  settings,
  members,
}: {
  projectId: string;
  settings: AiSettings;
  members: AiMember[];
}) {
  const [dialog, setDialog] = useState<'pause' | 'resume' | null>(null);
  const running = members.reduce((n, m) => n + m.slotsInUse, 0);
  if (!members.length) return null;
  return (
    <>
      {settings.safeMode && <SafeModeChip />}
      {settings.pausedAll ? (
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          style={{ background: '#B4571F', borderColor: '#B4571F', color: '#fff' }}
          onClick={() => setDialog('resume')}
          data-testid="ai-resume-all"
        >
          AI paused · Resume
        </button>
      ) : (
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-btn-danger-outline"
          onClick={() => setDialog('pause')}
          data-testid="ai-pause-all"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
          Pause all AI
          {running > 0 && (
            <span className="ai-chip" style={{ height: 18, background: '#FBEEEA', color: '#C4432A' }}>
              {running} running
            </span>
          )}
        </button>
      )}
      {dialog === 'pause' && <PauseAllDialog projectId={projectId} members={members} onClose={() => setDialog(null)} />}
      {dialog === 'resume' && (
        <ResumeAllDialog projectId={projectId} members={members} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function PauseAllDialog({
  projectId,
  members,
  onClose,
}: {
  projectId: string;
  members: AiMember[];
  onClose: () => void;
}) {
  const [cancelRunning, setCancelRunning] = useState(true);
  const [revoke, setRevoke] = useState(false);
  const [reason, setReason] = useState('');
  const toast = useToast();
  const pause = useAiMutation(() => aiApi.pauseAll(projectId, { reason, cancelRunning, revokeTokens: revoke }));
  const running = members.flatMap((m) =>
    m.running.filter((r) => r.state === 'running').map((r) => ({ ...r, name: m.name })),
  );
  const queued = members.reduce((n, m) => n + m.queued, 0);
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 500 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Pause all AI"
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">Pause all AI in this project?</h2>
        </div>
        <div className="ai-modal-body">
          <div className="ai-field">
            <span className="ai-label ai-label-dark">Running runs</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className={`ai-option ${cancelRunning ? 'ai-option-active' : ''}`}
                onClick={() => setCancelRunning(true)}
              >
                <span className={`ai-radio ${cancelRunning ? 'ai-radio-on' : ''}`} /> Cancel now
              </button>
              <button
                type="button"
                className={`ai-option ${!cancelRunning ? 'ai-option-active' : ''}`}
                onClick={() => setCancelRunning(false)}
              >
                <span className={`ai-radio ${!cancelRunning ? 'ai-radio-on' : ''}`} /> Let them finish
              </button>
            </div>
            <span className="ai-hint">
              {running.length
                ? `${running.map((r) => `${r.ticketId} · ${r.name}`).join(', ')}. Partial work in the folder is kept.`
                : 'Nothing is running right now.'}
            </span>
          </div>
          <div className="ai-hint">
            <b>{queued} queued runs are held.</b> Nothing is lost. They start again after resume, in order.
            <br />
            <b>No new runs, no AI @mentions.</b> People keep working as usual.
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={revoke}
              onChange={(e) => setRevoke(e.target.checked)}
              data-testid="pause-revoke"
            />
            <span>
              <b>Revoke MCP tokens</b>
              <div className="ai-muted">Optional. Agents must reconnect to work again.</div>
            </span>
          </label>
          <div className="ai-field">
            <span className="ai-label ai-label-dark">Reason (banner and audit log)</span>
            <input
              className="ai-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Unexpected assignee changes"
            />
          </div>
        </div>
        <div className="ai-modal-foot">
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <span className="ai-muted" style={{ flex: 1, textAlign: 'center' }}>
            Owners and admins
          </span>
          <button
            type="button"
            className="ai-btn ai-btn-danger"
            disabled={pause.isPending}
            onClick={async () => {
              try {
                const r = await pause.mutateAsync(undefined);
                toast.success('AI is paused', `${r.cancelled} run cancelled, ${r.held} queued runs held.`);
                onClose();
              } catch (err) {
                toast.error("Couldn't pause AI", extractError(err));
              }
            }}
            data-testid="ai-pause-all-confirm"
          >
            Pause all AI
          </button>
        </div>
      </div>
    </div>
  );
}

function ResumeAllDialog({
  projectId,
  members,
  onClose,
}: {
  projectId: string;
  members: AiMember[];
  onClose: () => void;
}) {
  const info = useResumeInfo(projectId);
  const [reviewed, setReviewed] = useState(false);
  const [safe, setSafe] = useState(true);
  const [showActions, setShowActions] = useState(false);
  const toast = useToast();
  const board = useAiBoardState();
  const overBudget = (m: AiMember) => m.status.code === 'over_budget';
  const [picked, setPicked] = useState<string[]>(members.filter((m) => !overBudget(m)).map((m) => m.id));
  const resume = useAiMutation(() => aiApi.resumeAll(projectId, { safeMode: safe, memberIds: picked, reviewed }));
  const d = info.data;
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 520 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Resume AI"
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">Resume AI</h2>
        </div>
        <div className="ai-modal-body">
          <label
            style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'center', cursor: 'pointer', flexWrap: 'wrap' }}
          >
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
              data-testid="resume-reviewed"
            />
            I looked at what the AI did before the stop
            {d && (
              <button
                type="button"
                className="ai-link"
                onClick={(e) => {
                  e.preventDefault();
                  setShowActions(!showActions);
                }}
              >
                {d.actionCount} action{d.actionCount === 1 ? '' : 's'} in the last 10 min
              </button>
            )}
          </label>
          {showActions && d && (
            <div className="ai-card" style={{ padding: 8, maxHeight: 150, overflow: 'auto' }}>
              {d.actions.length === 0 && <div className="ai-muted">The AI did nothing in those 10 minutes.</div>}
              {d.actions.map((a) => {
                const r = RESULT_STYLE[a.result] ?? RESULT_STYLE.info;
                return (
                  <div
                    key={a.id}
                    style={{ display: 'flex', gap: 8, fontSize: 12, padding: '3px 0', alignItems: 'center' }}
                  >
                    <span className="ai-mono ai-muted">{dateTime(a.at).slice(-5)}</span>
                    <span style={{ flex: 1 }}>
                      {a.memberName}: {ACTION_LABEL[a.action] ?? a.action} {a.target}
                    </span>
                    <span style={{ color: r.color }}>{r.label}</span>
                  </div>
                );
              })}
              {board.openAiTab && (
                <button
                  type="button"
                  className="ai-link"
                  onClick={() => {
                    onClose();
                    board.openAiTab?.('audit');
                  }}
                >
                  Open in audit log
                </button>
              )}
            </div>
          )}
          {d && (
            <span
              className="ai-chip"
              style={{
                alignSelf: 'flex-start',
                background: d.budgetsOk ? '#F1F8F3' : '#FDF0E6',
                color: d.budgetsOk ? '#2E6F40' : '#B4571F',
              }}
              data-testid="resume-budget"
            >
              {d.budgetsOk ? 'Budgets are fine' : 'A budget is used up'}: {usd(d.spentToday)} of{' '}
              {d.dailyCap != null ? usd(d.dailyCap) : 'no cap'} today
            </span>
          )}
          <div className="ai-field">
            <span className="ai-label ai-label-dark">Resume as</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className={`ai-option ${!safe ? 'ai-option-active' : ''}`}
                onClick={() => setSafe(false)}
              >
                <span className={`ai-radio ${!safe ? 'ai-radio-on' : ''}`} /> Normal
              </button>
              <button
                type="button"
                className={`ai-option ${safe ? 'ai-option-active' : ''}`}
                onClick={() => setSafe(true)}
              >
                <span className={`ai-radio ${safe ? 'ai-radio-on' : ''}`} /> Safe mode first
                <span className="ai-muted">(read and comment only)</span>
              </button>
            </div>
          </div>
          <div className="ai-field">
            <span className="ai-label ai-label-dark">Which agents</span>
            {members.map((m) => (
              <label
                key={m.id}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  fontSize: 13,
                  opacity: overBudget(m) ? 0.5 : 1,
                }}
              >
                <input
                  type="checkbox"
                  disabled={overBudget(m)}
                  checked={picked.includes(m.id)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))}
                />
                {m.name}
                {overBudget(m) && <span className="ai-muted">over budget, stays paused</span>}
                {!overBudget(m) && m.tokenRevokedAt && (
                  <span className="ai-muted">token revoked, reconnects on resume</span>
                )}
              </label>
            ))}
          </div>
        </div>
        <div className="ai-modal-foot">
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!reviewed || resume.isPending}
            data-testid="resume-confirm"
            onClick={async () => {
              try {
                await resume.mutateAsync(undefined);
                toast.success('AI resumed', safe ? 'In safe mode: read and comment only.' : undefined);
                onClose();
              } catch (err) {
                toast.error("Couldn't resume", extractError(err));
              }
            }}
          >
            Resume {picked.length} agent{picked.length === 1 ? '' : 's'}
            {safe ? ' in safe mode' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Banner shown on every screen while AI is paused for the project (D1). */
export function AiPausedBanner({ settings, onResume }: { settings: AiSettings; onResume: () => void }) {
  const board = useAiBoardState();
  const [dialog, setDialog] = useState(false);
  if (!settings.pausedAll) return null;
  const members = [...board.members.values()].filter((m) => m.kind === 'ai');
  return (
    <div className="ai-banner" role="status" data-testid="ai-paused-banner">
      <b>AI is paused for this project</b>
      <span>
        by {settings.pausedBy ?? 'someone'}
        {settings.pausedAt
          ? ` at ${new Date(settings.pausedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : ''}
        . {settings.pausedCancelled} run{settings.pausedCancelled === 1 ? '' : 's'} cancelled, {settings.pausedHeld}{' '}
        queued run
        {settings.pausedHeld === 1 ? '' : 's'} held. Nothing new starts and @mentions of AI are not delivered.
        {settings.pausedReason ? ` Reason: “${settings.pausedReason}”.` : ''}
        {settings.pausedTokensRevoked ? ' MCP tokens were revoked.' : ''}
      </span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        className="ai-btn ai-btn-sm"
        onClick={() => (board.projectId && members.length ? setDialog(true) : onResume())}
        data-testid="banner-resume"
      >
        Resume…
      </button>
      <button
        type="button"
        className="ai-btn ai-btn-sm"
        onClick={() => board.openAiTab?.('audit')}
        data-testid="banner-audit"
      >
        View audit log
      </button>
      {dialog && <ResumeAllDialog projectId={board.projectId} members={members} onClose={() => setDialog(false)} />}
    </div>
  );
}
