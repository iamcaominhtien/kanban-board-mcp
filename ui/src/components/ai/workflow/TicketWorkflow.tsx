import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAiBoardState, LoadError, ago } from '../aiUi';
import {
  useOddJobReviewer,
  useWorkflowMutation,
  useWorkflowTemplates,
  useTicketWorkflow,
  workflowApi,
} from '../../../api/aiWorkflow';
import { extractError } from '../../../api/extractError';
import { useTicketFlags } from '../../../api/aiCode';
import type { Ticket } from '../../../types';
import type { ReviewDepth, ViewStep, WorkflowView } from '../../../types/aiWorkflow';
import { openRun } from '../../aiteam/runLink';
import { ArbitrationCard } from './ArbitrationCard';
import { TddCard } from './TddCard';
import {
  DEPTHS,
  DEPTH_MODEL,
  DEPTH_READS,
  STATE_CLASS,
  STOP_TEXT,
  cap,
  roleName,
  stepStateLabel,
  totalRounds,
} from './wfFormat';
import { RoleChip } from './WfUi';
import './workflow.css';

function StepRow({ s, last, view, ticketId }: { s: ViewStep; last: boolean; view: WorkflowView; ticketId: string }) {
  const [skipError, setSkipError] = useState<string | null>(null);
  const skip = useWorkflowMutation(ticketId, (_: void) => workflowApi.skip(ticketId, s.id));
  const st = stepStateLabel(s, last);
  const you = s.kind === 'person';
  const bad = s.state === 'blocked' || s.state === 'failed';
  const cls = bad
    ? 'wf-step-bad'
    : s.state === 'done'
      ? 'wf-step-done'
      : s.state === 'active'
        ? 'wf-step-active'
        : you && (s.state === 'waiting' || s.state === 'pending')
          ? 'wf-step-waiting-you'
          : '';
  const failedChecks = (s.result?.checks ?? []).filter((c) => !c.ok);
  const label = s.role === 'reviewer' && view.reviewDepth ? `${s.label} · ${cap(view.reviewDepth)}` : s.label;
  return (
    <div className={`wf-step ${cls}`} data-testid={`wf-step-${s.key}`} data-state={s.state}>
      <span className="wf-n">{s.idx + 1}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <b>{label}</b>
        {s.attempt > 1 && (
          <span className="wf-pill wf-pill-blue" data-testid={`wf-attempt-${s.key}`}>
            attempt {s.attempt}
          </span>
        )}
      </div>
      <div className="wf-who">
        {s.kind === 'ai' && (
          <div className="wf-line" style={{ gap: 6 }}>
            <RoleChip role={s.role} title={roleName(s.role)} />
            <span>{s.memberName ?? roleName(s.role)}</span>
            {s.runId && (
              <button type="button" className="ai-link" onClick={() => openRun(s.runId as string)}>
                Open the run
              </button>
            )}
          </div>
        )}
        {s.kind === 'code' && (
          <span>
            <i>By code &middot; tests, lint, build</i>
          </span>
        )}
        {you && <span>You{s.endedAt && s.state === 'done' ? ` · ${ago(s.endedAt)}` : ''}</span>}
        {s.noteIn && (
          <div className="wf-note wf-quote" data-testid={`wf-note-in-${s.key}`}>
            Told: {s.noteIn}
          </div>
        )}
        {s.note && s.kind !== 'code' && <div className="wf-note">{s.note}</div>}
        {s.kind === 'code' && s.result?.noCommands && (
          <div className="wf-note">The project has no test, lint or build command, so there was nothing to run.</div>
        )}
        {failedChecks.map((c) => (
          <div key={c.name} className="wf-note" style={{ color: '#a5321e' }}>
            <b>{c.name}</b> failed <code className="ai-code">{c.command}</code>
            {c.tail && (
              <pre className="ai-term" style={{ margin: '4px 0 0', maxHeight: 90, overflow: 'auto' }}>
                {c.tail}
              </pre>
            )}
          </div>
        ))}
        {s.state === 'blocked' && s.kind === 'ai' && (
          <div className="wf-note" style={{ color: '#a5321e' }}>
            <b>No {roleName(s.role)} on this project.</b> Make one from the pack in Project settings › AI › Role packs,
            or skip the step for this ticket.
            <div className="wf-actions" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                disabled={skip.isPending}
                onClick={() => {
                  setSkipError(null);
                  skip.mutate(undefined, { onError: (e) => setSkipError(extractError(e)) });
                }}
              >
                Skip this step
              </button>
            </div>
            {skipError && (
              <div className="ai-error-text" role="alert">
                {skipError}
              </div>
            )}
          </div>
        )}
      </div>
      <span className={`wf-state ${STATE_CLASS[st.tone]}`}>{st.text}</span>
    </div>
  );
}

function DepthRow({ view, ticketId }: { view: WorkflowView; ticketId: string }) {
  const [error, setError] = useState<string | null>(null);
  const set = useWorkflowMutation(ticketId, (d: ReviewDepth) => workflowApi.depth(ticketId, d));
  const depth = view.reviewDepth;
  if (!depth) return null;
  return (
    <div className="wf-line" data-testid="depth-row">
      <span className="wf-h">Review</span>
      <span className="wf-pill" data-testid="depth-chip" title={DEPTH_READS[depth]}>
        {cap(depth)} &middot; {DEPTH_MODEL[depth]}
      </span>
      <span className="wf-hint" data-testid="depth-by">
        {view.depthBy === 'person' ? 'set by you' : 'chosen by Triage'}
      </span>
      <div className="wf-seg" role="group" aria-label="Review depth">
        {DEPTHS.map((d) => (
          <button
            key={d}
            type="button"
            className={d === depth ? 'on' : ''}
            aria-pressed={d === depth}
            disabled={set.isPending}
            onClick={() => {
              if (d === depth) return;
              setError(null);
              set.mutate(d, { onError: (e) => setError(extractError(e)) });
            }}
          >
            {cap(d)}
          </button>
        ))}
      </div>
      {view.depthNote && (
        <div className="wf-hint" style={{ flexBasis: '100%' }} data-testid="depth-note">
          {view.depthNote}
        </div>
      )}
      {error && (
        <div className="ai-error-text" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function DesignApproval({ step, view, ticketId }: { step: ViewStep; view: WorkflowView; ticketId: string }) {
  const [sendBack, setSendBack] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const decide = useWorkflowMutation(ticketId, (v: { approve: boolean; note?: string }) =>
    workflowApi.decide(ticketId, v.approve, v.note),
  );
  const prev = [...view.steps].filter((s) => s.idx < step.idx && s.kind === 'ai' && s.note).pop();
  const go = (approve: boolean) => {
    setError(null);
    decide.mutate(
      { approve, note: approve ? undefined : note.trim() || undefined },
      { onError: (e) => setError(extractError(e)) },
    );
  };
  return (
    <div className="wf-card wf-card-warn" data-testid="design-approval">
      <div className="wf-line">
        {prev && <RoleChip role={prev.role} />}
        <b>
          {prev?.memberName ?? 'The AI'} has a {prev?.label.toLowerCase() ?? 'result'} for {ticketId}
        </b>
        <span className="wf-grow" style={{ flex: 1 }} />
        <span className="wf-pill wf-pill-you">Waiting for you</span>
      </div>
      {prev?.note && <div className="wf-note">{prev.note}</div>}
      <div className="wf-hint">
        Step {step.idx + 1} of {view.steps.length} &middot; nothing is built until you answer
        {step.startedAt ? ` · waiting ${ago(step.startedAt).replace(' ago', '')}` : ''}
      </div>
      {sendBack && (
        <textarea
          className="wf-textarea"
          aria-label="What to change"
          placeholder="What should change first?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      <div className="wf-actions">
        {!sendBack ? (
          <>
            <button
              type="button"
              className="ai-btn ai-btn-primary ai-btn-sm"
              disabled={decide.isPending}
              onClick={() => go(true)}
            >
              Approve, go on and build it
            </button>
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => setSendBack(true)}>
              Change this first
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="ai-btn ai-btn-primary ai-btn-sm"
              disabled={decide.isPending}
              onClick={() => go(false)}
            >
              Send it back
            </button>
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => setSendBack(false)}>
              Cancel
            </button>
          </>
        )}
      </div>
      <div className="wf-hint">One of the two places the work stops for you. The other is the last step.</div>
      {error && (
        <div className="ai-error-text" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function StopCard({ view }: { view: WorkflowView }) {
  const t = view.stopReason ? STOP_TEXT[view.stopReason] : null;
  return (
    <div
      className={`wf-card ${t?.tone === 'violet' ? 'wf-card-violet' : 'wf-card-red'}`}
      data-testid="stop-card"
      role="status"
    >
      <div className="wf-line">
        <b>It stopped going round</b>
        <span className={`wf-pill ${t?.tone === 'violet' ? 'wf-pill-red' : 'wf-pill-red'}`}>
          {t?.title ?? 'Stopped'}
        </span>
        {t && <span className={`wf-pill ${t.tone === 'violet' ? 'wf-pill-violet' : 'wf-pill-you'}`}>{t.chip}</span>}
      </div>
      <div className="wf-note">{view.stopDetail || t?.goes}</div>
      {t && view.stopDetail && <div className="wf-hint">{t.goes}</div>}
    </div>
  );
}

function PutOnWorkflow({ ticket, onDone }: { ticket: Ticket; onDone?: () => void }) {
  const templates = useWorkflowTemplates(ticket.projectId);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const put = useWorkflowMutation(ticket.id, async (k: string) => {
    return workflowApi.attach(ticket.id, k);
  });
  const { members } = useAiBoardState();
  const reviewer = useOddJobReviewer(ticket.id);
  const qc = useQueryClient();
  const setReviewer = useMutation({
    mutationFn: (id: string | null) => workflowApi.setReviewer(ticket.id, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai', 'ticket-reviewer', ticket.id] }),
  });
  const assignee = ticket.assignee ? members.get(ticket.assignee) : undefined;
  if (templates.isLoading) return <div className="ai-skel" style={{ height: 44 }} aria-busy="true" />;
  if (templates.error || !templates.data)
    return <LoadError what="the workflows" error={templates.error} onRetry={() => void templates.refetch()} />;
  const chosen = key || templates.data.find((t) => t.key === 'standard')?.key || templates.data[0]?.key || '';
  return (
    <div className="wf-line" data-testid="put-on-workflow">
      <span className="wf-hint" style={{ flexBasis: '100%' }}>
        {assignee ? `No workflow — assigned to ${assignee.name}` : 'No workflow'}. An odd job: put it on one and the AIs
        follow its steps instead of inventing a process.
      </span>
      <label className="wf-line" style={{ gap: 6 }}>
        <span className="wf-h">Reviewer</span>
        <select
          className="wf-input"
          style={{ width: 'auto', minWidth: 160 }}
          aria-label="Reviewer"
          value={reviewer.data?.reviewerId ?? ''}
          disabled={setReviewer.isPending || reviewer.isLoading}
          onChange={(e) => setReviewer.mutate(e.target.value || null, { onError: (x) => setError(extractError(x)) })}
        >
          <option value="">Optional</option>
          {[...members.values()].map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <select
        className="wf-input"
        style={{ width: 'auto', minWidth: 180 }}
        aria-label="Workflow"
        value={chosen}
        onChange={(e) => setKey(e.target.value)}
      >
        {templates.data.map((t) => (
          <option key={t.key} value={t.key}>
            {t.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="ai-btn ai-btn-primary ai-btn-sm"
        disabled={!chosen || put.isPending}
        onClick={() => {
          setError(null);
          put.mutate(chosen, { onSuccess: () => onDone?.(), onError: (e) => setError(extractError(e)) });
        }}
      >
        Put on a workflow
      </button>
      {error && (
        <div className="ai-error-text" role="alert" style={{ flexBasis: '100%' }}>
          {error}
        </div>
      )}
    </div>
  );
}

function ChangeWorkflow({ ticket, onDone }: { ticket: Ticket; onDone: () => void }) {
  const templates = useWorkflowTemplates(ticket.projectId);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const change = useWorkflowMutation(ticket.id, async (k: string) => {
    await workflowApi.detach(ticket.id);
    return workflowApi.attach(ticket.id, k);
  });
  const chosen = key || templates.data?.[0]?.key || '';
  return (
    <div className="wf-line" data-testid="change-workflow">
      <select
        className="wf-input"
        style={{ width: 'auto', minWidth: 180 }}
        aria-label="Move to workflow"
        value={chosen}
        onChange={(e) => setKey(e.target.value)}
      >
        {(templates.data ?? []).map((t) => (
          <option key={t.key} value={t.key}>
            {t.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="ai-btn ai-btn-sm"
        disabled={!chosen || change.isPending}
        onClick={() => {
          setError(null);
          change.mutate(chosen, { onSuccess: onDone, onError: (e) => setError(extractError(e)) });
        }}
      >
        Move it over
      </button>
      <button type="button" className="ai-btn ai-btn-sm" onClick={onDone}>
        Cancel
      </button>
      <span className="wf-hint">
        Starts again from the first step of the new workflow; the steps done so far are dropped.
      </span>
      {error && (
        <div className="ai-error-text" role="alert" style={{ flexBasis: '100%' }}>
          {error}
        </div>
      )}
    </div>
  );
}

/** A ticket's workflow (design/screens/ai-team-process.md, F–I): the strip of steps, who holds it, review depth, the
 * design approval, an arbitration, the test-first evidence. */
export function TicketWorkflow({ ticket }: { ticket: Ticket }) {
  const { members } = useAiBoardState();
  const hasAi = members.size > 0;
  const q = useTicketWorkflow(ticket.id, hasAi);
  const flags = useTicketFlags(ticket.id, hasAi && !!q.data);
  const [changing, setChanging] = useState(false);

  if (!hasAi) return null;
  const wrap = (children: React.ReactNode) => (
    <div className="ai-card wf-wrap" style={{ padding: 12 }} data-testid="ticket-workflow" data-ticket={ticket.id}>
      {children}
    </div>
  );
  if (q.isLoading)
    return wrap(<div className="ai-skel" style={{ height: 60 }} aria-busy="true" aria-label="Loading workflow" />);
  if (q.error) return wrap(<LoadError what="the workflow" error={q.error} onRetry={() => void q.refetch()} />);
  const view = q.data;
  if (!view || view.state === 'detached') return wrap(<PutOnWorkflow ticket={ticket} />);

  const last = view.steps.length - 1;
  const current = view.steps.find((s) => ['active', 'waiting', 'blocked', 'failed'].includes(s.state));
  const position = (current?.idx ?? (view.state === 'done' ? last : 0)) + 1;
  const approval = view.steps.find((s) => s.kind === 'person' && s.idx < last && s.state === 'waiting');
  const rounds = totalRounds(view.rounds);
  const did = view.steps.filter((s) => s.state === 'done' || s.state === 'active').filter((s) => s.kind !== 'code');
  const arbitrationOpen = !!flags.data?.some((f) => f.kind === 'arbitration' && f.open);

  return wrap(
    <>
      <div className="wf-line">
        <b>{view.templateName}</b>
        <span className="wf-pill wf-pill-blue" data-testid="step-position">
          {view.state === 'done' ? 'done' : `step ${position} of ${view.steps.length}`}
        </span>
        <span className="wf-hint">
          {view.createdAt ? `started ${ago(view.createdAt)}` : `version ${view.templateVersion}`}
          {rounds > 0 ? ` · ${rounds} round${rounds === 1 ? '' : 's'} back from review` : ''}
        </span>
        <span className="wf-grow" style={{ flex: 1 }} />
        {!changing && (
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => setChanging(true)}>
            Change workflow
          </button>
        )}
      </div>
      {changing && <ChangeWorkflow ticket={ticket} onDone={() => setChanging(false)} />}
      <div className="wf-strip" data-testid="workflow-strip">
        {view.steps.map((s) => (
          <StepRow key={s.id} s={s} last={s.idx === last} view={view} ticketId={ticket.id} />
        ))}
      </div>
      {did.length > 0 && (
        <div style={{ display: 'grid', gap: 4 }} data-testid="who-held">
          <span className="wf-h">Who did what</span>
          {did.map((s) => (
            <div key={s.id} className="wf-line" style={{ gap: 6 }}>
              <RoleChip
                role={s.kind === 'person' ? 'you' : s.role}
                title={s.kind === 'person' ? 'You' : roleName(s.role)}
              />
              <span style={{ fontSize: 12.5 }}>
                {s.kind === 'person' ? 'You approved' : (s.memberName ?? roleName(s.role))}
              </span>
              <span className="wf-hint">
                {s.label} · {s.state === 'active' ? 'now' : s.endedAt ? ago(s.endedAt) : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      {view.state === 'stopped' && <StopCard view={view} />}
      {approval && <DesignApproval step={approval} view={view} ticketId={ticket.id} />}
      {view.steps[last]?.state === 'waiting' && view.state === 'active' && !approval && (
        <div className="wf-hint" data-testid="last-step-hint">
          The last step is you: the ticket sits in Review until you move it to Done.
        </div>
      )}
      <DepthRow view={view} ticketId={ticket.id} />
      <ArbitrationCard ticketId={ticket.id} view={view} flagOpen={arbitrationOpen} />
      <TddCard ticketId={ticket.id} view={view} />
    </>,
  );
}
