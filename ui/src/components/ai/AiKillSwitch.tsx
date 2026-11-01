import { useMemo, useState } from 'react';
import { aiApi, useAiMutation } from '../../api/ai';
import { useResumeInfo } from '../../api/aiSafety';
import { extractError } from '../../api/extractError';
import type { AiMember, AiSettings } from '../../types/ai';
import { useToast } from '../Toast';
import { useAiBoardState } from './aiUi';
import { ACTION_LABEL, RESULT_STYLE, dateTime, usd } from './aiSafetyUi';
import { AiAvatar } from './aiUi';
import { PAUSE_COLOR, PauseGlyph, agoText, canResume, clockTime, pausedSummary } from './pausedUi';
import type { ResumeInfo } from '../../api/aiSafety';

/** Kill switch and containment (design/screens/ai-safety-cost.md, D1 to D5). */

/** Chip shown in headers and on cards while safe mode is on (D5): white with an eye, never the solid orange pause. */
export function SafeModeChip({ title = 'Read and comment only' }: { title?: string }) {
  return (
    <span
      className="ai-chip"
      style={{ background: '#fff', color: PAUSE_COLOR, border: '1px solid #F0CDB0', gap: 5 }}
      title={title}
      data-testid="safe-mode-chip"
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke={PAUSE_COLOR}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
        <circle cx="12" cy="12" r="2.8" />
      </svg>
      Safe mode
    </span>
  );
}

/** Top bar (design/screens/ai-paused.md, B1). The state is a label and the action a separate button, so reading
 * the state never risks starting something. A single paused AI is only a small amber chip. */
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
  const onePaused = members.filter((m) => m.paused).length;
  if (!members.length) return null;
  const mayResume = canResume(settings);
  const since = clockTime(settings.pausedAt);
  return (
    <>
      {settings.safeMode && <SafeModeChip />}
      {settings.pausedAll ? (
        <span className="ai-pausebar" data-testid="ai-paused-bar">
          <span
            className={`ai-pausebar-label ${mayResume ? '' : 'ai-pausebar-solo'}`}
            tabIndex={0}
            title={pausedSummary(settings)}
            aria-label={`AI paused${since ? ` since ${since}` : ''}. ${pausedSummary(settings)}`}
            data-testid="ai-paused-label"
          >
            <PauseGlyph />
            AI paused
            {since && <span className="ai-pausebar-since">since {since}</span>}
          </span>
          {mayResume && (
            <button
              type="button"
              className="ai-pausebar-resume"
              onClick={() => setDialog('resume')}
              data-testid="ai-resume-all"
            >
              Resume…
            </button>
          )}
        </span>
      ) : (
        <>
          {onePaused > 0 && (
            <span
              className="ai-chip"
              style={{ background: '#FEF3D9', color: '#7A5A06', gap: 5 }}
              title="Paused on its own: by a person, a budget or auto-trip. The project is still working."
              data-testid="ai-one-paused"
            >
              <PauseGlyph size={11} color="#7A5A06" />
              {onePaused} AI paused
            </span>
          )}
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
        </>
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
                toast.success(
                  'AI is paused',
                  `${r.cancelled} run${r.cancelled === 1 ? '' : 's'} cancelled, ${r.held} queued run${r.held === 1 ? '' : 's'} held.`,
                );
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

type ResumeFacts = ResumeInfo['members'][number];

/** One AI member's row in the Resume dialog: what it has waiting and what Resume does to it (ai-paused.md, C). */
function resumeRow(
  m: AiMember,
  f: ResumeFacts | undefined,
): { text: React.ReactNode; chip?: { text: string; tone: 'go' | 'wait' | 'stay' }; off: boolean } {
  const held = f?.held ?? [];
  const cancelled = f?.cancelled ?? [];
  const waiting = f?.waitingForYou ?? [];
  const offline = m.health === 'runner_missing' || m.health === 'not_logged_in';
  const key = (id: string) => <b key={id}>{id}</b>;
  const cancelledText = cancelled.map((c) => (
    <span key={c.ticketId}>
      {key(c.ticketId)} was cancelled at step {c.step}
    </span>
  ));
  if (f?.overBudget || m.status.code === 'over_budget')
    return {
      off: true,
      chip: { text: 'stays paused', tone: 'stay' },
      text: (
        <>
          {cancelled.length > 0 && <>{cancelledText[0]}. </>}
          {f?.overBudgetReason ?? 'Over budget'}: stays paused until it resets or until you raise the budget.
        </>
      ),
    };
  if (waiting.length)
    return {
      off: false,
      chip: { text: 'waiting for you', tone: 'wait' },
      text: <>Waiting for your answer on {waiting.map(key)}. The question is still there; answer it any time.</>,
    };
  const startChip = held.length ? { text: `starts ${held.join(', ')}`, tone: 'go' as const } : undefined;
  if (offline)
    return {
      off: false,
      chip: startChip ?? { text: 'offline', tone: 'stay' },
      text: (
        <>
          Offline{m.healthDetail ? ` (${m.healthDetail})` : ''}.{' '}
          {held.length ? 'Its held runs start when it reconnects.' : 'Nothing is held for it.'}
        </>
      ),
    };
  if (cancelled.length)
    return {
      off: false,
      chip: startChip,
      text: (
        <>
          {cancelledText[0]}; partial work is kept. It does not restart by itself; use Run again on the ticket.
          {held.length > 0 && (
            <>
              {' '}
              {held.map(key)} {held.length === 1 ? 'starts' : 'start'} on resume.
            </>
          )}
        </>
      ),
    };
  if (held.length)
    return {
      off: false,
      chip: startChip,
      text: (
        <>
          Held: {held.map(key)} {held.length === 1 ? 'starts' : 'start'} on resume.
        </>
      ),
    };
  return { off: false, text: 'Was idle. Nothing held.' };
}

/** The Resume dialog (D3): the checklist, Normal or Safe mode, and a row per AI member with what it has waiting. */
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
  const [already, setAlready] = useState<{ by?: string | null; at?: string | null; members?: number | null } | null>(
    null,
  );
  const toast = useToast();
  const board = useAiBoardState();
  const facts = useMemo(() => new Map((info.data?.members ?? []).map((f) => [f.memberId, f])), [info.data]);
  const overBudget = (m: AiMember) => m.status.code === 'over_budget' || !!facts.get(m.id)?.overBudget;
  const [picked, setPicked] = useState<string[]>(
    members.filter((m) => m.status.code !== 'over_budget').map((m) => m.id),
  );
  const resume = useAiMutation(() => aiApi.resumeAll(projectId, { safeMode: safe, memberIds: picked, reviewed }));
  const d = info.data;
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? '';
  const heldStarting = (d?.heldOrder ?? []).filter((h) => {
    const m = members.find((x) => x.id === h.memberId);
    return m && picked.includes(m.id) && !overBudget(m);
  });
  if (already)
    return (
      <div className="ai-overlay" onClick={onClose}>
        <div
          className="ai-modal"
          style={{ width: 440 }}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="AI was already resumed"
        >
          <div className="ai-modal-head">
            <h2 className="ai-modal-title">AI was already resumed</h2>
          </div>
          <div className="ai-modal-body" data-testid="resume-already">
            <span>
              {already.by ?? 'Someone'} resumed{already.members ? ` ${already.members} AI members` : ' AI'}
              {already.at ? ` at ${clockTime(already.at)}` : ''}. Nothing was changed by this dialog.
            </span>
          </div>
          <div className="ai-modal-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="ai-btn ai-btn-primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 560 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Resume AI"
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">Resume AI</h2>
        </div>
        <div className="ai-modal-body" style={{ maxHeight: '70vh', overflow: 'auto' }}>
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
              {d.budgetsOk ? 'Budget is fine' : 'A budget is used up'}: {usd(d.spentToday)} of{' '}
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
            <span className="ai-hint" data-testid="resume-safe-hint">
              {d?.safeBefore && <b>Safe mode was on before the pause. </b>}
              Safe mode applies to the whole project until someone turns it off in Settings.
            </span>
          </div>
          <div className="ai-field">
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="ai-label ai-label-dark" style={{ flex: 1 }}>
                Which AI members start again
              </span>
              <button
                type="button"
                className="ai-link"
                onClick={() => setPicked(members.filter((m) => !overBudget(m)).map((m) => m.id))}
              >
                All
              </button>
              <button type="button" className="ai-link" onClick={() => setPicked([])}>
                None
              </button>
            </span>
            {members.map((m) => {
              const row = resumeRow(m, facts.get(m.id));
              const on = picked.includes(m.id);
              return (
                <label
                  key={m.id}
                  className={`ai-resume-row ${row.off ? 'ai-resume-row-off' : ''}`}
                  data-testid={`resume-row-${m.id}`}
                >
                  <input
                    type="checkbox"
                    disabled={row.off}
                    checked={on && !row.off}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))}
                    aria-label={m.name}
                  />
                  <AiAvatar provider={m.provider} color={m.color} glyph={m.glyph} size={26} dim={row.off} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{m.name}</span>{' '}
                    <span className="ai-muted" style={{ fontSize: 11.5 }}>
                      {[
                        m.model,
                        m.connection === 'local' ? 'local runner' : m.connection === 'api_key' ? 'API key' : 'inbox',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <span className="ai-resume-sentence">{row.text}</span>
                    {!row.off && m.tokenRevokedAt && (
                      <span className="ai-resume-sentence">Token revoked: reconnects on resume.</span>
                    )}
                  </span>
                  {row.chip && (
                    <span className={`ai-resume-chip ai-resume-chip-${row.chip.tone}`}>{row.chip.text}</span>
                  )}
                </label>
              );
            })}
            {heldStarting.length > 0 && (
              <span className="ai-hint" data-testid="resume-order">
                {heldStarting.length} held run{heldStarting.length === 1 ? '' : 's'} start, in order:{' '}
                {heldStarting.map((h) => `${h.ticketId} (${nameOf(h.memberId)})`).join(', then ')}. Cancelled runs do
                not start.
              </span>
            )}
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
            className="ai-btn ai-btn-primary"
            disabled={!reviewed || resume.isPending}
            data-testid="resume-confirm"
            onClick={async () => {
              try {
                await resume.mutateAsync(undefined);
                toast.success('AI resumed', safe ? 'In safe mode: read and comment only.' : undefined);
                onClose();
              } catch (err) {
                const detail = (err as { response?: { data?: { detail?: Record<string, unknown> | string } } })
                  ?.response?.data?.detail;
                if (detail && typeof detail === 'object' && detail.code === 'already_resumed') {
                  setAlready({
                    by: (detail.by as string) ?? null,
                    at: (detail.at as string) ?? null,
                    members: (detail.members as number) ?? null,
                  });
                  return;
                }
                toast.error("Couldn't resume", extractError(err));
              }
            }}
          >
            Resume {picked.length} AI member{picked.length === 1 ? '' : 's'}
            {safe ? ' in safe mode' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

export { ResumeAllDialog };

/** Banner shown on every screen while AI is paused for the project (design/screens/ai-paused.md, B2). */
export function AiPausedBanner({ settings, onResume }: { settings: AiSettings; onResume: () => void }) {
  const board = useAiBoardState();
  const [dialog, setDialog] = useState(false);
  // Folded for this person until the next pause: remembered by the time of the pause
  const foldKey = 'kanban.ai.pausedBannerFolded';
  const [folded, setFolded] = useState(() => {
    try {
      return !!settings.pausedAt && localStorage.getItem(foldKey) === settings.pausedAt;
    } catch {
      return false;
    }
  });
  if (!settings.pausedAll) return null;
  const members = [...board.members.values()].filter((m) => m.kind === 'ai');
  const cancelled = settings.pausedCancelled ?? 0;
  const held = settings.pausedHeld ?? 0;
  const finishing = settings.pausedFinishing ?? 0;
  const mayResume = canResume(settings);
  const who = settings.pausedBy ?? 'someone';
  const at = clockTime(settings.pausedAt);
  const ago = agoText(settings.pausedAt);
  const fold = (next: boolean) => {
    setFolded(next);
    try {
      if (next && settings.pausedAt) localStorage.setItem(foldKey, settings.pausedAt);
      else localStorage.removeItem(foldKey);
    } catch {
      /* the fold is only a convenience */
    }
  };
  const chip = (icon: React.ReactNode, body: React.ReactNode, key: string) => (
    <span className="ai-paused-chip" key={key}>
      {icon}
      <span>{body}</span>
    </span>
  );
  const stroke = { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: PAUSE_COLOR, strokeWidth: 2 };
  const plural = (n: number) => (n === 1 ? '' : 's');
  return (
    <div
      className={`ai-paused-banner ${folded ? 'ai-paused-banner-folded' : ''}`}
      role="status"
      data-testid="ai-paused-banner"
    >
      <div className="ai-paused-head">
        <span className="ai-paused-ico">
          <PauseGlyph size={14} />
        </span>
        <div className="ai-paused-title">
          <b>AI is paused</b>
          <span>
            by <b>{who}</b>
            {at ? ` at ${at}` : ''}
            {ago && <span style={{ opacity: 0.8 }}> · {ago}</span>}
            {folded && (cancelled > 0 || held > 0) && (
              <span style={{ opacity: 0.8 }}>
                {cancelled > 0 ? ` · ${cancelled} cancelled` : ''}
                {held > 0 ? ` · ${held} held` : ''}
              </span>
            )}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        {mayResume ? (
          <button
            type="button"
            className="ai-btn ai-btn-sm ai-btn-primary"
            onClick={() => (board.projectId && members.length ? setDialog(true) : onResume())}
            data-testid="banner-resume"
          >
            Resume…
          </button>
        ) : (
          <span className="ai-paused-cannot" data-testid="banner-cannot-resume">
            Only owners and admins can resume
          </span>
        )}
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          onClick={() => board.openAiTab?.('audit')}
          data-testid="banner-audit"
        >
          View audit log
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-paused-fold"
          onClick={() => fold(!folded)}
          aria-expanded={!folded}
          data-testid="banner-fold"
        >
          {folded ? 'Show details' : 'Hide details'}
          <svg {...stroke} style={{ transform: folded ? undefined : 'rotate(180deg)' }} aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
      {!folded && (
        <div className="ai-paused-chips">
          {cancelled > 0 &&
            chip(
              <svg {...stroke} aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>,
              <>
                <b>{cancelled}</b> run{plural(cancelled)} cancelled
              </>,
              'cancelled',
            )}
          {finishing > 0 &&
            chip(
              <svg {...stroke} aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3.5 2" />
              </svg>,
              <>
                <b>{finishing}</b> run{plural(finishing)} still finishing, then{' '}
                {finishing === 1 ? 'it stops' : 'they stop'}
              </>,
              'finishing',
            )}
          {held > 0 &&
            chip(
              <svg {...stroke} aria-hidden="true">
                <path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4M12 8v4l3 2" />
              </svg>,
              <>
                <b>{held}</b> queued run{plural(held)} held
              </>,
              'held',
            )}
          {chip(
            <svg {...stroke} aria-hidden="true">
              <circle cx="12" cy="12" r="3.5" />
              <path d="M15.5 12v1.2a2.3 2.3 0 0 0 4.5 0V12a8 8 0 1 0-3.2 6.4" />
            </svg>,
            'Mentions of an AI are not delivered',
            'mentions',
          )}
          {settings.pausedTokensRevoked &&
            chip(
              <svg {...stroke} aria-hidden="true">
                <rect x="5" y="11" width="14" height="9" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>,
              <>
                <b>MCP tokens revoked</b>, AIs must reconnect
              </>,
              'tokens',
            )}
          {settings.pausedReason &&
            chip(
              <svg {...stroke} aria-hidden="true">
                <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />
              </svg>,
              <>Reason: “{settings.pausedReason}”</>,
              'reason',
            )}
        </div>
      )}
      {dialog && <ResumeAllDialog projectId={board.projectId} members={members} onClose={() => setDialog(false)} />}
    </div>
  );
}
