import { useState } from 'react';
import { extractError } from '../../../api/extractError';
import { pullApi, usePullMutation, usePulls } from '../../../api/aiPulls';
import { useProjectOps } from '../../../api/aiProjectOps';
import { useTicket } from '../../../api/tickets';
import { useTicketRuns } from '../../../api/ai';
import { ago, useAiBoardState } from '../aiUi';
import { BRANCH, BUBBLE, CI_TEXT, EXTERNAL } from './pullParts';

/** A pull request the board opened (design/screens/ai-board-wave3.md, E): CI state, red CI and review comments. */
export function PullStatus({ ticketId }: { ticketId: string }) {
  const ticket = useTicket(ticketId);
  const projectId = ticket.data?.projectId;
  const pulls = usePulls(projectId);
  const ops = useProjectOps(projectId ?? '');
  const runs = useTicketRuns(ticketId).data ?? [];
  const { members } = useAiBoardState();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const poll = usePullMutation(projectId, () => pullApi.poll(projectId as string));

  const p = pulls.data?.find((x) => x.ticketId === ticketId);
  if (!p) return null;

  const red = p.ci === 'red' && p.red;
  const checked = p.checkedAt ? `checked ${ago(p.checkedAt)}` : 'not checked yet';
  const unreachable = !!p.lastError;
  const run = async (fn: () => Promise<{ runId: string }>, what: string) => {
    setError(null);
    setSent(null);
    try {
      await fn();
      setSent(what);
    } catch (e) {
      setError(extractError(e));
    }
  };
  const nComments = p.pendingComments.length;
  /** The team the board gave a run to: the one that ran it, else "the team". */
  const teamOf = (runId?: string | null) => {
    const run = runs.find((r) => r.id === runId);
    return (run && members.get(run.memberId)?.name) || 'the team';
  };
  const givenComments = p.pendingComments.find((c) => c.handledAt);
  const dot = (c: string) => (
    <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, display: 'inline-block' }} />
  );

  return (
    <div
      data-testid="pull-status"
      data-ticket={ticketId}
      className="ai-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        border: '1px solid #E3E8E5',
        borderRadius: 12,
        background: '#fff',
        padding: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Pull request</span>
        <a href={p.url} target="_blank" rel="noreferrer" className="ai-link" data-testid="pull-link">
          #{p.number}
        </a>
        <span className="ai-chip" style={{ background: '#F1F3F1', color: '#5B6B60' }}>
          Opened by the board
        </span>
        {p.state === 'closed' ? (
          <span className="ai-chip" style={{ background: '#F1F3F1', color: '#5B6B60' }}>
            Closed
          </span>
        ) : (
          <span
            className="ai-chip"
            data-testid="pull-ci"
            style={
              p.ci === 'red'
                ? { background: '#FDECE8', color: '#A5321E' }
                : p.ci === 'green'
                  ? { background: '#E6F2EA', color: '#1F5A31' }
                  : { background: '#F1F3F1', color: '#5B6B60' }
            }
          >
            {dot(p.ci === 'red' ? '#C4432A' : p.ci === 'green' ? '#2E6F40' : '#9AA8A0')}
            {CI_TEXT[p.ci ?? 'none'] ?? 'CI not known yet'}
          </span>
        )}
        <span className="ai-muted">{checked}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          disabled={poll.isPending}
          onClick={() =>
            void run(async () => ({ runId: String((await poll.mutateAsync(undefined)).changes) }), 'Checked.')
          }
        >
          {poll.isPending ? 'Checking...' : 'Check now'}
        </button>
      </div>
      {unreachable && (
        <div className="ai-notice ai-notice-warn" role="alert" data-testid="pull-unreachable">
          GitHub could not be reached ({p.lastError}). The state above is {checked}, not a green light; the board does
          not act on old data.
        </div>
      )}
      {ops.data && !ops.data.github?.on && (
        <div className="ai-hint">
          GitHub watching is off for this project, so this is only as fresh as the last check. Turn it on in the
          project’s AI settings to have it polled every {ops.data.github?.pollMin ?? 5} minutes.
        </div>
      )}

      {red && (
        <div
          data-testid="pull-red-card"
          style={{
            border: '1px solid #F2C7BB',
            borderRadius: 10,
            background: '#FDECE8',
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            {BRANCH}
            <b style={{ fontSize: 13.5, flex: 1 }}>CI is red on the pull request for {ticketId}</b>
            <span className="ai-chip" style={{ background: '#F1F3F1', color: '#5B6B60' }}>
              Opened by the board
            </span>
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
            #{p.number} · {red.at ? `${ago(red.at)} · ` : ''}
            <b style={{ color: '#A5321E' }}>{red.check} failed</b>.
          </div>
          {red.blamed ? (
            <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
              {red.base ? <b>{red.base} is green</b> : <b>The base branch is green</b>}, so this failure is this pull
              request’s.
            </div>
          ) : (
            <div style={{ fontSize: 12.5, lineHeight: 1.6 }} data-testid="pull-not-ours">
              <b>{red.base ?? 'The base branch'} is red on the same check.</b> The failure is not this ticket’s.
            </div>
          )}
          {red.handledAt && (
            <div style={{ color: '#1F5A31', fontSize: 12.5, lineHeight: 1.6 }} data-testid="pull-given">
              The board gave the failing check to {teamOf(red.runId)}: a new run, started by the board (red CI).
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {red.url && (
              <a className="ai-btn" href={red.url} target="_blank" rel="noreferrer">
                {EXTERNAL}
                Open the run on GitHub
              </a>
            )}
          </div>
        </div>
      )}

      {nComments > 0 && (
        <div
          data-testid="pull-comments-card"
          style={{
            border: '1px solid #CBDDEE',
            borderRadius: 10,
            background: '#F2F7FC',
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            {BUBBLE}
            <b style={{ fontSize: 13.5, flex: 1 }}>
              {nComments === 1 ? 'One review comment' : `${nComments} review comments`} on {ticketId}
            </b>
            <span className="ai-chip" style={{ background: '#E8F1FA', color: '#244E78' }}>
              From a person
            </span>
          </div>
          {p.pendingComments.map((c) => (
            <div
              key={c.id}
              data-testid="pull-comment"
              style={{
                border: '1px solid #CBDDEE',
                borderRadius: 9,
                background: '#fff',
                padding: '9px 11px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div className="ai-muted" style={{ color: '#5B6B60' }}>
                {c.path ? `${c.path}${c.line ? `:${c.line}` : ''}` : 'On the pull request'} · {c.author}
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>“{c.body}”</div>
            </div>
          ))}
          {givenComments && (
            <div style={{ color: '#1F5A31', fontSize: 12.5, lineHeight: 1.6 }} data-testid="pull-comments-given">
              The board gave the review comments to {teamOf(givenComments.runId)}: a new run, started by the board
              (review comments).
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <a className="ai-btn" href={p.url} target="_blank" rel="noreferrer">
              {EXTERNAL}I will answer them
            </a>
          </div>
        </div>
      )}

      {sent && (
        <div className="ai-ok-text" data-testid="pull-sent">
          {sent}
        </div>
      )}
      {error && (
        <div className="ai-error-text" role="alert" data-testid="pull-error">
          {error}
        </div>
      )}
    </div>
  );
}
