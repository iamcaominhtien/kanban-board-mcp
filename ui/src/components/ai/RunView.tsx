import { useEffect, useState } from 'react';
import { aiApi, isActive, useAiMutation, useAiRun, useRunMessages, useTicketRuns } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiRun, AiRunFull, RunReport } from '../../types/ai';
import type { Ticket } from '../../types';
import { useToast } from '../Toast';
import { MarkdownRenderer } from '../MarkdownRenderer';
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
export function RunReportCard({ run }: { run: Pick<AiRun, 'report' | 'summary'> }) {
  const report: RunReport = run.report ?? {};
  const summary = report.summary || run.summary;
  const tests = testsOf(run);
  const open = report.openItems ?? [];
  if (!summary && !report.branch && !report.prUrl && !open.length && !tests) return null;
  return (
    <div
      data-testid="run-report"
      style={{
        boxSizing: 'border-box',
        border: '1px solid #BFDCC7',
        borderRadius: 12,
        background: '#F6FBF7',
        padding: '14px 17px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div className="ai-label" style={{ color: '#2E6F40' }}>
        Report
      </div>
      {summary && (
        <div style={{ fontSize: 13.5, lineHeight: 1.6 }} data-testid="run-report-text">
          <MarkdownRenderer plain>{summary}</MarkdownRenderer>
        </div>
      )}
      {(report.branch || report.prUrl || tests) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
          {report.branch && (
            <span data-testid="report-branch" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <LineIcon name="branch" size={12} /> <span className="ai-code">{report.branch}</span>
            </span>
          )}
          {report.prUrl && (
            <a href={report.prUrl} target="_blank" rel="noreferrer" data-testid="report-pr" className="ai-link">
              <LineIcon name="external" size={12} /> Pull request
            </a>
          )}
          {tests && <TestChips counts={tests} />}
        </div>
      )}
      {open.length > 0 && (
        <div data-testid="report-open-items">
          <div className="ai-label" style={{ marginBottom: 4 }}>
            Still open
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55 }}>
            {open.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </div>
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
  const sendNote = async () => {
    if (!text.trim() || send.isPending) return;
    try {
      await send.mutateAsync(text.trim());
      setText('');
      toast.success('Sent', run.live ? 'The lead has it.' : 'The lead gets it with its next turn.');
    } catch (err) {
      toast.error("Couldn't send the message", extractError(err));
    }
  };
  return (
    <div
      data-testid="run-message-box"
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '8px 10px',
        border: '1px solid #E3E8E5',
        borderRadius: 11,
        background: '#FBFCFB',
      }}
    >
      <label
        htmlFor={`run-msg-${run.id}`}
        style={{ fontSize: 12.5, fontWeight: 700, color: '#1F5A31', whiteSpace: 'nowrap', paddingLeft: 4 }}
      >
        {run.live ? 'Tell the lead now' : 'Leave a note for the lead'}
      </label>
      <input
        id={`run-msg-${run.id}`}
        type="text"
        className="ai-input"
        style={{ flex: '1 1 220px', minWidth: 0 }}
        value={text}
        placeholder={run.live ? 'It reads this at its next step…' : 'It reads this when it takes its next turn…'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void sendNote();
        }}
        data-testid="run-message-input"
      />
      <button
        type="button"
        className="ai-btn ai-btn-sm"
        disabled={!text.trim() || send.isPending}
        data-testid="run-message-send"
        onClick={() => void sendNote()}
      >
        <LineIcon name="send" size={12} /> Send
      </button>
    </div>
  );
}

/** Messages that went into and out of the run (a person's notes, other AI sessions). */
export function RunMessages({ runId }: { runId: string }) {
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

/** Cancel while it is going; Retry when it failed, Run again when it ended another way. */
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
  const failed = run.state === 'failed' || run.state === 'timed_out';
  return (
    <>
      {isActive(run.state) && (
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-btn-danger-outline"
          disabled={cancel.isPending}
          data-testid="run-cancel"
          onClick={() => void act(() => cancel.mutateAsync(undefined), "Couldn't cancel the run")}
        >
          <LineIcon name="square" size={13} /> {run.state === 'queued' ? 'Cancel run' : 'Stop run'}
        </button>
      )}
      {['failed', 'cancelled', 'timed_out', 'finished'].includes(run.state) && (
        <button
          type="button"
          className={`ai-btn ai-btn-sm ${failed ? 'ai-btn-primary' : ''}`}
          disabled={retry.isPending}
          data-testid="run-retry"
          onClick={() => void act(() => retry.mutateAsync(undefined), "Couldn't start a new run")}
        >
          {failed ? 'Retry' : 'Run again'}
        </button>
      )}
    </>
  );
}

/** Tokens, cost and the run's size, as on main's Usage card. */
export function UsageCard({ run, who }: { run: AiRun; who: string }) {
  return (
    <div className="tw-usage" data-testid="usage-card">
      <div className="ai-label">Usage</div>
      <div style={{ fontSize: 12, color: '#5B6B60', margin: '2px 0 8px' }}>
        {who} · run #{run.number} on <span className="ai-mono">{run.ticketId}</span>
      </div>
      {run.costUsd > 0 || run.tokensIn + run.tokensOut > 0 ? (
        <div className="tw-usage-grid">
          <div>
            <div className="ai-muted">Tokens in</div>
            <b className="ai-mono">{tokenWords(run.tokensIn)}</b>
          </div>
          <div>
            <div className="ai-muted">Tokens out</div>
            <b className="ai-mono">{tokenWords(run.tokensOut)}</b>
          </div>
          <div>
            <div className="ai-muted">Cost</div>
            <b className="ai-mono">{money(run.costUsd)}</b>
          </div>
        </div>
      ) : (
        <div className="ai-hint">Not metered: a local runner uses your signed-in CLI.</div>
      )}
    </div>
  );
}

/** The last commands the run ran, each with its exit code (the newest, still going, says "now"). */
function CommandsBlock({ run, running }: { run: AiRunFull; running: boolean }) {
  const commands = run.steps.filter((s) => s.kind === 'command').slice(-6);
  return (
    <div data-testid="run-commands">
      <span className="ai-label">Commands</span>
      {commands.length === 0 && <div className="ai-muted">None.</div>}
      {commands.map((c, i) => {
        const code = typeof c.detail?.exitCode === 'number' ? c.detail.exitCode : null;
        const now = i === commands.length - 1 && running && code == null;
        const good = now || code === 0;
        return (
          <div key={c.seq} className="tw-cmd">
            <span
              className="tw-exit"
              style={good ? { background: '#F1F8F3', color: '#2E6F40' } : { background: '#FBEEEA', color: '#C4432A' }}
            >
              {now ? (
                '● now'
              ) : code != null ? (
                <>
                  {code === 0 && (
                    <>
                      <LineIcon name="check" size={12} />{' '}
                    </>
                  )}
                  exit {code}
                </>
              ) : (
                '—'
              )}
            </span>
            <span className="ai-mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.title.replace(/^Ran /, '')}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One run, whole, as on main: its title and actions, who ran it and for how long, what it was asked, then the steps
 * (a tree: the lead and its roles) beside the files, commands, test results and usage. The lead's report is the one
 * addition of v2. Steps arrive live (SSE patches the cache); a role's steps and the earlier ones are fetched on request.
 */
export function RunView({ runId }: { runId: string }) {
  const q = useAiRun(runId);
  const { members } = useAiBoardState();
  const run = q.data;
  const live = isActive(run?.state);
  const running = run?.state === 'running' || run?.state === 'starting';
  useNow(1000, running);
  if (q.isError) return <LoadError what="the run" error={q.error} onRetry={() => void q.refetch()} />;
  if (!run) return <span className="ai-spin" />;
  const team = members.get(run.memberId);
  const who = team?.name ?? 'Team';
  const ended = run.endedReason && !live ? run.endedReason : null;
  const tests = testsOf(run);
  const secs = runSeconds(run);
  const tokens = run.tokensIn + run.tokensOut;
  return (
    <div className="ai-run-panel ai-root" data-testid="run-view">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18, fontWeight: 800 }}>
          {run.mode === 'ask' ? 'Answer' : 'Run'} #{run.number}
        </span>
        <RunStateChip state={run.paused ? 'paused' : run.state} />
        <span style={{ flex: 1 }} />
        <RunButtons run={run} />
      </div>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#5B6B60', flexWrap: 'wrap' }}
        data-testid="run-facts"
      >
        {team && <AiAvatar color={team.color} size={20} />}
        <b style={{ color: '#1E2A22' }}>{who}</b>·
        <span>
          {run.startedAt ? `started ${hhmm(run.startedAt)}` : `queued ${hhmm(run.queuedAt)}`} by {run.startedBy}
        </span>
        {secs != null && (
          <>
            ·
            <span className="ai-mono" style={{ color: '#2E6F40', fontWeight: 600 }}>
              {fmtElapsed(secs)}
            </span>
          </>
        )}
        {tokens > 0 && <>· {tokenWords(tokens)} tokens</>}
        {run.costUsd > 0 && <>· {money(run.costUsd)}</>}
        {run.model && (
          <>
            · <span className="ai-mono">{run.model}</span>
          </>
        )}
        {run.effort && <>· {run.effort}</>}
      </div>
      {run.instruction && (
        <div className="ai-notice ai-notice-info" style={{ fontSize: 12 }} data-testid="run-instruction">
          <b>{run.mode === 'ask' ? 'Question' : 'Instruction'}:</b> {run.instruction}
        </div>
      )}
      {run.state === 'queued' && run.waitingReason && (
        <div className="ai-notice ai-notice-warn" data-testid="why-waiting">
          {run.waitingReason}
        </div>
      )}
      {ended && (
        <div
          className={`ai-notice ${run.state === 'finished' ? 'ai-notice-info' : run.state === 'cancelled' ? 'ai-notice-slate' : 'ai-notice-error'}`}
        >
          {ended}
        </div>
      )}
      {run.state === 'needs_input' && run.question && !run.answer && <QuestionCard run={{ ...run }} />}
      <RunReportCard run={run} />
      <RunMessageBox run={run} />
      <div className="tw-runcols">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <span className="ai-label">Steps</span>
            <span className="ai-muted" data-testid="step-count">
              {run.stepsCount}
            </span>
          </div>
          <RunTree run={run} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="ai-label">Files touched</span>
              <span className="ai-muted">{run.files.length} changed</span>
            </div>
            {run.files.length === 0 && <div className="ai-muted">None yet.</div>}
            {run.files.map((f) => (
              <div key={f.path} style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '4px 0' }}>
                <span className="ai-mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {f.path}
                </span>
                <span className="ai-mono" style={{ color: '#2E6F40' }}>
                  +{f.added}
                </span>
                {f.new ? (
                  <span className="ai-mono" style={{ color: '#2E6F40' }}>
                    new
                  </span>
                ) : (
                  f.removed > 0 && (
                    <span className="ai-mono" style={{ color: '#C4432A' }}>
                      −{f.removed}
                    </span>
                  )
                )}
              </div>
            ))}
          </div>
          <CommandsBlock run={run} running={!!running} />
          {tests && (
            <div data-testid="run-tests">
              <span className="ai-label">Test results</span>
              <div style={{ margin: '6px 0' }}>
                <TestChips counts={tests} />
              </div>
              {(tests.failing?.length ?? 0) > 0 && (
                <div style={{ fontSize: 12.5, color: '#5B6B60' }}>
                  Failing:{' '}
                  {tests.failing!.map((f) => (
                    <span key={f} className="ai-code" style={{ marginRight: 6 }}>
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          <UsageCard run={run} who={who} />
        </div>
      </div>
      <RunMessages runId={run.id} />
      <div className="ai-muted">
        <LineIcon name="shield" size={13} /> Secrets, tokens and key-like strings are masked before the log is stored or
        shown.
      </div>
    </div>
  );
}

/** Every run on this ticket, newest first; a click opens that run (the table of main's run history). */
export function RunHistory({
  runs,
  selected,
  onSelect,
}: {
  runs: AiRun[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { members } = useAiBoardState();
  return (
    <table className="ai-table" data-testid="run-history">
      <thead>
        <tr>
          <th>Run</th>
          <th>Team</th>
          <th>Started by</th>
          <th>State</th>
          <th>Time</th>
          <th>Usage</th>
          <th>Changes</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr
            key={r.id}
            onClick={() => onSelect(r.id)}
            style={{ cursor: 'pointer', background: selected === r.id ? '#F6FAF7' : undefined }}
            data-testid="run-history-item"
            aria-selected={selected === r.id}
          >
            <td style={{ fontWeight: 700 }}>#{r.number}</td>
            <td>{members.get(r.memberId)?.name ?? 'Team'}</td>
            <td className="ai-muted">
              {r.mode === 'ask' ? 'Ask' : r.trigger === 'assign' ? 'Assigned' : (r.trigger ?? '').replace(/_/g, ' ')} by{' '}
              {r.startedBy},{' '}
              {r.queuedAt && new Date(r.queuedAt).toDateString() !== new Date().toDateString()
                ? shortDate(r.queuedAt)
                : hhmm(r.queuedAt)}
            </td>
            <td>
              <RunStateChip state={r.paused ? 'paused' : r.state} />
            </td>
            <td>{fmtElapsed(runSeconds(r))}</td>
            <td className="ai-muted">{r.costUsd > 0 ? money(r.costUsd) : 'Not metered'}</td>
            <td className="ai-muted">
              {r.mode === 'ask'
                ? 'no changes (answer only)'
                : r.files.length
                  ? `${r.files.length} file${r.files.length === 1 ? '' : 's'}`
                  : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The ticket's AI tab: the newest run in full, then the table of every run (a click opens that one). */
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
      <div className="ai-card ai-root" style={{ padding: 20 }} data-testid="no-runs">
        <b>No AI runs on this ticket yet</b>
        <div className="ai-hint">Assign it to a team, or use Run.</div>
      </div>
    );
  const current = runs.find((r) => r.id === picked) ?? runs[0];
  return (
    <div
      className="ai-root"
      style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px' }}
      data-testid="ticket-runs-tab"
    >
      <RunView key={current.id} runId={current.id} />
      <div className="ai-card" style={{ padding: 12 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 6 }}>Run history for {ticket.id}</div>
        <RunHistory runs={runs} selected={current.id} onSelect={setPicked} />
      </div>
    </div>
  );
}
