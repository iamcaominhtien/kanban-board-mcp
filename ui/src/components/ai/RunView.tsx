import { useEffect, useState } from 'react';
import { aiApi, isActive, useAiMutation, useAiRun, useRunMessages, useTicketRuns } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiRun, AiRunFull, RunReport } from '../../types/ai';
import type { Ticket } from '../../types';
import { useToast } from '../Toast';
import { QuestionCard } from './QuestionCard';
import { RunTree } from './run/RunTree';
import {
  AiAvatar,
  LoadError,
  RunStateChip,
  TestChips,
  fmtElapsed,
  hhmm,
  money,
  shortDate,
  testsOf,
  useAiBoardState,
  useNow,
} from './aiUi';
import './ticketWork.css';
import { LineIcon } from '../ui/LineIcon';

/** How long a run took, or has taken so far. */
function runSeconds(run: Pick<AiRun, 'startedAt' | 'endedAt'>): number | null {
  if (!run.startedAt) return null;
  const end = run.endedAt ? new Date(run.endedAt).getTime() : Date.now();
  return Math.max(0, Math.round((end - new Date(run.startedAt).getTime()) / 1000));
}

/** Tokens as "12.3k". */
export function tokenWords(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

/** What the lead handed in at the end: summary, branch, PR, what is left, the tests. */
export function RunReportCard({ run }: { run: Pick<AiRun, 'report' | 'summary' | 'files'> }) {
  const report: RunReport = run.report ?? {};
  const summary = report.summary || run.summary;
  const tests = testsOf(run);
  const open = report.openItems ?? [];
  if (!summary && !report.branch && !report.prUrl && !open.length && !tests && !run.files.length) return null;
  return (
    <div className="tw-card" data-testid="run-report">
      <div className="ai-label ai-label-dark" style={{ marginBottom: 6 }}>
        Report
      </div>
      {summary && <div style={{ fontSize: 13.5, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{summary}</div>}
      {(report.branch || report.prUrl) && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, fontSize: 12.5 }}>
          {report.branch && (
            <span data-testid="report-branch">
              <LineIcon name="branch" size={12} /> <span className="ai-code">{report.branch}</span>
            </span>
          )}
          {report.prUrl && (
            <a href={report.prUrl} target="_blank" rel="noreferrer" data-testid="report-pr" className="ai-link">
              <LineIcon name="external" size={12} /> Pull request
            </a>
          )}
        </div>
      )}
      {tests && (
        <div style={{ marginTop: 8 }}>
          <TestChips counts={tests} />
        </div>
      )}
      {open.length > 0 && (
        <div style={{ marginTop: 8 }} data-testid="report-open-items">
          <div className="ai-label">Still open</div>
          <ul style={{ margin: '4px 0 0 18px', padding: 0, fontSize: 13 }}>
            {open.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </div>
      )}
      {run.files.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="ai-muted" style={{ cursor: 'pointer' }}>
            {run.files.length} file{run.files.length === 1 ? '' : 's'} changed
          </summary>
          <div style={{ marginTop: 4 }}>
            {run.files.map((f) => (
              <div key={f.path} className="ai-mono" style={{ fontSize: 11.5 }}>
                {f.path} <span style={{ color: '#2E6F40' }}>+{f.added}</span>
                {f.removed > 0 && <span style={{ color: '#C4432A' }}> −{f.removed}</span>}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** A note to the running lead (live: it hears it now; else at its next turn). */
export function RunMessageBox({ run }: { run: Pick<AiRun, 'id' | 'live' | 'state'> }) {
  const [text, setText] = useState('');
  const toast = useToast();
  const send = useAiMutation((t: string) => aiApi.message(run.id, t));
  if (!isActive(run.state) || run.state === 'queued') return null;
  return (
    <div className="tw-card" data-testid="run-message-box">
      <label className="ai-label" htmlFor={`run-msg-${run.id}`}>
        {run.live ? 'Tell the lead now' : 'Leave a note for the lead'}
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <textarea
          id={`run-msg-${run.id}`}
          className="ai-textarea"
          style={{ flex: 1, minHeight: 44 }}
          value={text}
          placeholder={run.live ? 'It reads this at its next step…' : 'It reads this when it takes its next turn…'}
          onChange={(e) => setText(e.target.value)}
          data-testid="run-message-input"
        />
        <button
          type="button"
          className="ai-btn ai-btn-primary"
          style={{ alignSelf: 'flex-end' }}
          disabled={!text.trim() || send.isPending}
          data-testid="run-message-send"
          onClick={async () => {
            try {
              await send.mutateAsync(text.trim());
              setText('');
              toast.success('Sent', run.live ? 'The lead has it.' : 'The lead gets it with its next turn.');
            } catch (err) {
              toast.error("Couldn't send the message", extractError(err));
            }
          }}
        >
          <LineIcon name="send" size={12} /> Send
        </button>
      </div>
    </div>
  );
}

/** Messages that went into and out of the run (a person's notes, other AI sessions). */
function RunMessages({ runId }: { runId: string }) {
  const q = useRunMessages(runId);
  const list = q.data ?? [];
  if (!list.length) return null;
  return (
    <details data-testid="run-messages">
      <summary className="ai-muted" style={{ cursor: 'pointer' }}>
        {list.length} message{list.length === 1 ? '' : 's'}
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
        {list.map((m) => (
          <div key={m.id} style={{ fontSize: 12.5 }}>
            <b>{m.direction === 'in' ? `${m.peer} →` : `→ ${m.peer}`}</b> <span className="ai-muted">{hhmm(m.at)}</span>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
          </div>
        ))}
      </div>
    </details>
  );
}

/** Cancel while it is going, Run again when it ended without a finish. */
export function RunButtons({ run }: { run: Pick<AiRun, 'id' | 'state'> }) {
  const toast = useToast();
  const cancel = useAiMutation(() => aiApi.cancel(run.id));
  const retry = useAiMutation(() => aiApi.retry(run.id));
  const act = async (fn: () => Promise<unknown>, fail: string) => {
    try {
      await fn();
    } catch (err) {
      toast.error(fail, extractError(err));
    }
  };
  return (
    <span style={{ display: 'inline-flex', gap: 8 }}>
      {isActive(run.state) && (
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          disabled={cancel.isPending}
          data-testid="run-cancel"
          onClick={() => void act(() => cancel.mutateAsync(undefined), "Couldn't cancel the run")}
        >
          <LineIcon name="stop" size={12} /> {run.state === 'queued' ? 'Cancel' : 'Stop'}
        </button>
      )}
      {['failed', 'cancelled', 'timed_out', 'finished'].includes(run.state) && (
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          disabled={retry.isPending}
          data-testid="run-retry"
          onClick={() => void act(() => retry.mutateAsync(undefined), "Couldn't run it again")}
        >
          <LineIcon name="refresh" size={12} /> Run again
        </button>
      )}
    </span>
  );
}

/** The facts line: model, tokens, cost, time. */
function RunFacts({ run }: { run: AiRunFull | AiRun }) {
  const secs = runSeconds(run);
  const bits = [
    run.model,
    run.effort,
    run.tokensIn + run.tokensOut > 0 ? `${tokenWords(run.tokensIn + run.tokensOut)} tokens` : null,
    run.costUsd > 0 ? money(run.costUsd) : null,
    secs != null ? fmtElapsed(secs) : null,
    run.startedAt ? `started ${shortDate(run.startedAt)} ${hhmm(run.startedAt)}` : null,
  ].filter(Boolean);
  return (
    <div className="ai-muted" data-testid="run-facts">
      {bits.join(' · ')}
    </div>
  );
}

/**
 * One run, whole: who and what state, the lead's question, the report, a message box while it works, and the steps
 * as a tree. Steps arrive live (SSE patches the cache); a role's steps and the earlier ones are fetched on request.
 */
export function RunView({ runId }: { runId: string }) {
  const q = useAiRun(runId);
  const { members } = useAiBoardState();
  const run = q.data;
  const active = isActive(run?.state);
  useNow(1000, run?.state === 'running');
  if (q.isError) return <LoadError what="the run" error={q.error} onRetry={() => void q.refetch()} />;
  if (!run) return <span className="ai-spin" />;
  const team = members.get(run.memberId);
  const ended = run.endedReason && !active ? run.endedReason : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="run-view">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {team && <AiAvatar color={team.color} size={30} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            {team?.name ?? 'Team'} · Run #{run.number}
          </div>
          <RunFacts run={run} />
        </div>
        <RunStateChip state={run.paused ? 'paused' : run.state} />
        <RunButtons run={run} />
      </div>
      {run.instruction && (
        <div className="tw-card" style={{ fontSize: 13 }} data-testid="run-instruction">
          <div className="ai-label">Asked</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{run.instruction}</div>
        </div>
      )}
      {run.state === 'queued' && run.waitingReason && (
        <div className="ai-notice ai-notice-info">{run.waitingReason}</div>
      )}
      {ended && (
        <div className={`ai-notice ${run.state === 'finished' ? 'ai-notice-info' : 'ai-notice-warn'}`}>{ended}</div>
      )}
      {run.state === 'needs_input' && run.question && !run.answer && <QuestionCard run={{ ...run }} />}
      <RunReportCard run={run} />
      <RunMessageBox run={run} />
      <RunTree run={run} />
      <RunMessages runId={run.id} />
    </div>
  );
}

/** A row of the ticket's runs, newest first; a click opens that run. */
export function RunHistory({
  runs,
  selected,
  onSelect,
}: {
  runs: AiRun[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} data-testid="run-history">
      {runs.map((r) => (
        <button
          key={r.id}
          type="button"
          className={`tw-chipbtn ${selected === r.id ? 'tw-chipbtn-on' : ''}`}
          aria-pressed={selected === r.id}
          onClick={() => onSelect(r.id)}
          data-testid="run-history-item"
        >
          #{r.number} · {r.state.replace('_', ' ')} · {shortDate(r.queuedAt)}
        </button>
      ))}
    </div>
  );
}

/** The ticket's AI tab: the newest run in full, the older ones one click away. */
export function TicketRunsTab({ ticket, runId }: { ticket: Ticket; runId?: string | null }) {
  const q = useTicketRuns(ticket.id);
  const runs = q.data ?? [];
  const [picked, setPicked] = useState<string | null>(runId ?? null);
  useEffect(() => {
    if (runId) setPicked(runId);
  }, [runId]);
  if (q.isError) return <LoadError what="the runs" error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <span className="ai-spin" />;
  if (!runs.length)
    return (
      <div className="ai-muted" data-testid="no-runs">
        No run on this ticket yet. Assign it to a team, or use Run.
      </div>
    );
  const current = runs.find((r) => r.id === picked) ?? runs[0];
  return (
    <div
      className="ai-root"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      data-testid="ticket-runs-tab"
    >
      {runs.length > 1 && <RunHistory runs={runs} selected={current.id} onSelect={setPicked} />}
      <RunView key={current.id} runId={current.id} />
    </div>
  );
}
