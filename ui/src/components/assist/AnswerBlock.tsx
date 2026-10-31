import { useEffect, useState, type ReactNode } from 'react';
import { assistApi } from '../../api/assist';
import { extractError } from '../../api/extractError';
import type { AssistDraft, AssistState, ChatDetail, ChatMessage } from '../../types/assist';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { AiAvatar, hhmm, secondsSince, useAiBoardState } from '../ai/aiUi';
import { useAssist } from './AssistContext';
import { BoardAiAvatar, CostChip, TicketPill, usd } from './assistUi';
import { DraftChanges } from './DraftChanges';
import { DraftAiMembers } from './DraftAiMembers';

const SLOW_AFTER_S = 30;

/** What a chat about one thing (a ticket, an idea) adds to an answer: sharing it, its run, its own draft kinds. */
export interface AnswerPanel {
  /** "Post as comment": resolves when the comment exists. Only offered when given. */
  onPostComment?: (msg: ChatMessage) => Promise<void>;
  /** Open the run a "Do the work" message started. */
  onOpenRun?: (runId: string) => void;
  /** "See usage" on the daily cap tile. */
  onOpenUsage?: () => void;
  /** A draft of a kind the panel's scope owns; return null to use the board's own draft card. */
  renderDraft?: (draft: AssistDraft) => ReactNode | null;
}

function Steps({ steps, live }: { steps: ChatMessage['steps']; live: boolean }) {
  return (
    <div className="as-steps">
      {steps.map((s, i) => (
        <div key={i} className={`as-step ${live && i === steps.length - 1 ? 'as-step-now' : 'as-step-done'}`}>
          {s.text}
        </div>
      ))}
    </div>
  );
}

function useTick(active: boolean) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

/** One Board AI answer in every state: thinking with steps, streaming, slow, done with sources and suggested
 * actions, stopped, error, rate-limited, over budget; truncated context, injection and private-doc notices (B, I). */
export function AnswerBlock({
  msg,
  chat,
  state,
  onSend,
  panel,
}: {
  msg: ChatMessage;
  chat: ChatDetail;
  state: AssistState | undefined;
  onSend: (text: string, opts?: { draft?: boolean }) => void;
  /** Set by the chat panel of a ticket or an idea (design/screens/ai-where-you-work.md, B). */
  panel?: AnswerPanel;
}) {
  const ctx = useAssist();
  const { members } = useAiBoardState();
  const answerer = msg.memberId ? members.get(msg.memberId) : undefined;
  const [posting, setPosting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [thumb, setThumbState] = useState<'up' | 'down' | null>(msg.feedback?.thumb ?? null);
  const setThumb = (t: 'up' | 'down' | null) => {
    setThumbState(t);
    assistApi.feedback(msg.id, t).catch(() => setThumbState(thumb)); // kept on the server; undone if it fails
  };
  const [copied, setCopied] = useState(false);
  const [keepWaiting, setKeepWaiting] = useState(false);
  const live = ['thinking', 'streaming', 'queued', 'rate_limited'].includes(msg.state);
  useTick(live);
  const draft = chat.drafts.find((d) => d.id === msg.draftId) ?? null;
  const projectId = chat.projectId;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };
  const stop = () => act(() => assistApi.stop(msg.id));
  const retry = (sendAll = false) => act(() => assistApi.retry(msg.id, sendAll));
  const goOn = () => act(() => assistApi.retry(msg.id, false, true));
  const elapsed = secondsSince(msg.createdAt) ?? 0;
  const ctxInfo = msg.context;
  // the tool the member used last ("Using get_ticket · YU-12"), when it uses its own tools
  const lastStep = msg.steps.length ? msg.steps[msg.steps.length - 1].text : '';
  const usingTool = lastStep.startsWith('Using ');

  let body;
  if (msg.state === 'thinking' || msg.state === 'queued') {
    const slow = elapsed >= SLOW_AFTER_S && !keepWaiting;
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="answer-thinking">
        <div style={{ fontWeight: 700, fontSize: 13 }}>Thinking…</div>
        <Steps steps={msg.steps.length ? msg.steps : [{ text: 'Reading the board', at: msg.createdAt }]} live />
        {slow ? (
          <div className="as-tile as-tile-warn" data-testid="answer-slow">
            <div className="as-tile-title">
              Still working… {elapsed} s
              <span className="ai-chip" style={{ background: '#FBE7C6', color: '#9A5B12' }}>
                Slow
              </span>
            </div>
            <div className="ai-hint">
              {usingTool
                ? `${lastStep}… Reading the board with its tools can take a while. You can keep working meanwhile.`
                : 'Usually a few seconds. The provider is busy. You can keep working meanwhile.'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="ai-btn ai-btn-sm" onClick={() => setKeepWaiting(true)}>
                Keep waiting
              </button>
              <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={() => void stop()}>
                Stop
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="ai-muted" style={{ flex: 1 }}>
              Waiting for an answer…
            </span>
            <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={() => void stop()}>
              Stop
            </button>
          </div>
        )}
        <div className="ai-muted">You can stop at any time. Tokens used so far are still charged.</div>
      </div>
    );
  } else if (msg.state === 'streaming') {
    const soFar = msg.metered ? (msg.text.length / 4 / 1_000_000) * 15 : 0;
    body = (
      <div data-testid="answer-streaming">
        <MarkdownRenderer docs={{ projectId, onOpenTicket: ctx?.onOpenTicket }}>{msg.text}</MarkdownRenderer>
        <div className="as-meta">
          <span className="ai-chip" style={{ background: '#EAF5ED', color: '#2E6F40' }}>
            <span className="ai-spin" style={{ width: 9, height: 9 }} /> Streaming
          </span>
          {usingTool && (
            <span
              className="ai-muted"
              title={lastStep}
              style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {lastStep}
            </span>
          )}
          {msg.metered && <span className="as-cost">{usd(soFar)} so far</span>}
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={() => void stop()}>
            Stop
          </button>
        </div>
      </div>
    );
  } else if (msg.state === 'error') {
    body = (
      <div className="as-tile as-tile-error" data-testid="answer-error">
        <div className="as-tile-title">Couldn't get an answer</div>
        <div className="ai-hint">
          {msg.error.message ?? 'The provider returned an error.'} Nothing was changed and nothing was charged. Your
          message is kept.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="ai-btn ai-btn-primary ai-btn-sm"
            disabled={busy}
            onClick={() => void retry()}
          >
            Try again
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            onClick={() => {
              void navigator.clipboard?.writeText(JSON.stringify(msg.error, null, 2));
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : 'Copy error details'}
          </button>
        </div>
      </div>
    );
  } else if (msg.state === 'rate_limited') {
    const left = msg.retryAt ? Math.max(0, Math.round((new Date(msg.retryAt).getTime() - Date.now()) / 1000)) : 0;
    const who = state?.boardAi.providerLabel ?? 'the provider';
    body = (
      <div className="as-tile as-tile-warn" data-testid="answer-rate-limited">
        <div className="as-tile-title">Rate-limited by {who}</div>
        <div className="ai-hint">Too many requests on this API key. Your message is queued and sends in {left} s.</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="ai-btn ai-btn-primary ai-btn-sm"
            disabled={busy}
            onClick={() => void retry()}
          >
            Send now
          </button>
          <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={() => void stop()}>
            Cancel
          </button>
        </div>
      </div>
    );
  } else if (msg.state === 'over_budget' && msg.error.daily) {
    body = (
      <div className="as-tile as-tile-warn" data-testid="answer-over-budget">
        <div className="as-tile-title">AI is paused until tomorrow</div>
        <div className="ai-hint">
          The daily cap was reached. Ask-only answers and drafts stop; reading the thread still works.
        </div>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={panel?.onOpenUsage ?? ctx?.onOpenSettings}
        >
          See usage
        </button>
      </div>
    );
  } else if (msg.state === 'over_budget') {
    const cap = (msg.error.cap as number | undefined) ?? state?.monthlyCap ?? 0;
    const spent = (msg.error.spent as number | undefined) ?? state?.usedMonth ?? 0;
    body = (
      <div className="as-tile as-tile-warn" data-testid="answer-over-budget">
        <div className="as-tile-title">
          Monthly cap reached · {usd(spent, 2)} of {usd(cap, 2)}
        </div>
        <div className="ai-hint">
          Chat is paused until {String(msg.error.resets ?? state?.resets ?? 'the 1st')} or until an owner raises the
          cap. Past chats stay readable. Drafts you already have can still be applied.
        </div>
        <button type="button" className="ai-link" style={{ alignSelf: 'flex-start' }} onClick={ctx?.onOpenSettings}>
          Open usage in Settings → AI
        </button>
      </div>
    );
  } else {
    const trunc = ctxInfo.truncated;
    body = (
      <div data-testid="answer-done">
        {msg.text && (
          <MarkdownRenderer docs={{ projectId, onOpenTicket: ctx?.onOpenTicket }}>{msg.text}</MarkdownRenderer>
        )}
        {msg.state === 'stopped' && <div className="ai-muted">Stopped · the partial answer is kept.</div>}
        {ctxInfo.cutShort && (
          <div className="as-tile as-tile-warn" style={{ marginTop: 8 }} data-testid="answer-cut-short">
            <div className="as-tile-title">The reply is partial</div>
            <div className="ai-hint">The AI hit its length limit. What it wrote is kept.</div>
            <button
              type="button"
              className="ai-btn ai-btn-primary ai-btn-sm"
              style={{ alignSelf: 'flex-start' }}
              disabled={busy}
              onClick={() => void goOn()}
            >
              Continue
            </button>
          </div>
        )}
        {ctxInfo.run && (
          <div className="as-tile" style={{ marginTop: 8 }} data-testid="answer-run">
            <div className="as-tile-title">Run #{ctxInfo.run.number} started</div>
            <div className="ai-hint">
              {ctxInfo.run.memberName} works within its limits, stops at Review and asks you before risky steps.
            </div>
            {panel?.onOpenRun && (
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => panel.onOpenRun?.(ctxInfo.run!.id)}
              >
                Open run
              </button>
            )}
          </div>
        )}
        {draft && (
          <div style={{ marginTop: 8 }}>
            {panel?.renderDraft?.(draft) ??
              (draft.kind === 'ai_members' ? (
                <DraftAiMembers draftId={draft.id} initial={draft} />
              ) : (
                <DraftChanges
                  draftId={draft.id}
                  initial={draft}
                  onRefresh={() => void act(() => assistApi.retry(msg.id))}
                />
              ))}
          </div>
        )}
        {panel && !ctxInfo.run && msg.text && (
          <div className="sc-share" data-testid="answer-share">
            {panel.onPostComment &&
              (ctxInfo.posted ? (
                <span className="ai-muted" data-testid="answer-posted">
                  ✓ Posted as a comment
                </span>
              ) : (
                <button
                  type="button"
                  className="as-action"
                  disabled={posting}
                  data-testid="answer-post-comment"
                  onClick={async () => {
                    setPosting(true);
                    setError(null);
                    try {
                      await panel.onPostComment?.(msg);
                    } catch (e) {
                      setError(extractError(e));
                    } finally {
                      setPosting(false);
                    }
                  }}
                >
                  💬 Post as comment
                </button>
              ))}
            <button
              type="button"
              className="as-action"
              data-testid="answer-copy"
              onClick={() => {
                void navigator.clipboard?.writeText(msg.text);
                setCopied(true);
              }}
            >
              ⧉ {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
        {msg.actions.length > 0 && (
          <>
            <div className="as-label">Suggested actions · drafts only</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {msg.actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  className="as-action"
                  onClick={() => onSend(a.request, { draft: true })}
                >
                  ✎ {a.label}
                </button>
              ))}
            </div>
          </>
        )}
        {ctxInfo.injections && ctxInfo.injections.length > 0 && (
          <div className="as-tile as-tile-slate" style={{ marginTop: 8 }} data-testid="answer-injection">
            <div className="ai-hint">
              <b>{ctxInfo.injections[0].author ?? ctxInfo.injections[0].source}</b>
              {ctxInfo.injections[0].ticketId ? ` · ${ctxInfo.injections[0].source}` : ''}
            </div>
            <div style={{ fontStyle: 'italic', fontSize: 12.5 }}>“{ctxInfo.injections[0].quote}”</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="ai-chip" style={{ background: '#FDF2EE', color: '#B4541A' }}>
                Looks like instructions: treated as plain text
              </span>
              <span
                className="ai-link"
                title="Text written in tickets, comments and docs is sent to the AI as data. It never follows instructions found there, and the board's permissions apply whatever the text says."
              >
                Why
              </span>
            </div>
          </div>
        )}
        {ctxInfo.privateSkipped && ctxInfo.privateSkipped.length > 0 && (
          <div className="as-tile as-tile-slate" style={{ marginTop: 8 }} data-testid="answer-private">
            {ctxInfo.privateSkipped.map((p) => (
              <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="as-tile-title">
                  {p.title}{' '}
                  <span className="ai-chip" style={{ background: '#EEF1F5', color: '#5B6B7A' }}>
                    Private
                  </span>
                </div>
                <div className="ai-hint">
                  Not sent to the provider and not citable. Only a doc's owner can include it for one chat.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="ai-btn ai-btn-sm"
                    onClick={() =>
                      void act(async () => {
                        await assistApi.patchChat(chat.id, { includeDoc: p.id });
                        await assistApi.retry(msg.id);
                      })
                    }
                  >
                    Include for this chat
                  </button>
                  <button type="button" className="ai-btn ai-btn-sm" onClick={ctx?.onOpenSettings}>
                    Settings → AI
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {trunc && trunc.total > trunc.sent && (
          <div className="as-tile as-tile-warn" style={{ marginTop: 8 }} data-testid="answer-truncated">
            <div className="as-tile-title">
              {chat.scope === 'ticket' && chat.ticketId ? `${chat.ticketId} is long` : 'Long context'}:{' '}
              {trunc.sent.toLocaleString()} of {trunc.total.toLocaleString()} tokens sent
            </div>
            <div className="ai-hint">{trunc.note}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="ai-btn ai-btn-sm" onClick={() => setShowSources(true)}>
                See what was sent
              </button>
              <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={() => void retry(true)}>
                Send all{msg.metered ? ` (~${usd(((trunc.total - trunc.sent) / 1_000_000) * 3, 2)})` : ''}
              </button>
            </div>
          </div>
        )}
        {!ctxInfo.run && (
          <div className="as-meta">
            <button
              type="button"
              className="as-ctx-chip"
              style={{ cursor: 'pointer', maxWidth: 'none' }}
              onClick={() => setShowSources((v) => !v)}
            >
              <span>🔗 {ctxInfo.label ?? 'Based on the board'}</span> ▾
            </button>
            <span className="ai-muted">answered {hhmm(msg.finishedAt ?? msg.createdAt)}</span>
          </div>
        )}
        {showSources && (
          <div
            className="as-tile"
            style={{ marginTop: 6, maxHeight: 180, overflowY: 'auto' }}
            data-testid="answer-sources"
          >
            <div className="as-label" style={{ margin: 0 }}>
              What was sent · {ctxInfo.tokens?.toLocaleString() ?? 0} tokens
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(ctxInfo.items ?? []).slice(0, 60).map((it) =>
                it.kind === 'ticket' ? (
                  <TicketPill key={`t${it.id}`} id={it.id} />
                ) : (
                  <button
                    key={`d${it.id}`}
                    type="button"
                    className="as-ctx-chip"
                    onClick={() => ctx?.onOpenDoc(it.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <span>📄 {it.title}</span>
                  </button>
                ),
              )}
            </div>
          </div>
        )}
        {!ctxInfo.run && (
          <div className="as-meta" style={{ marginTop: 6 }}>
            <div className="as-icons">
              <button
                type="button"
                title="Copy"
                aria-label="Copy answer"
                onClick={() => void navigator.clipboard?.writeText(msg.text)}
              >
                ⧉
              </button>
              <button type="button" title="Regenerate" aria-label="Regenerate" onClick={() => void retry()}>
                ↻
              </button>
              <button
                type="button"
                title="Helpful"
                aria-label="Helpful"
                className={thumb === 'up' ? 'as-on' : ''}
                onClick={() => setThumb(thumb === 'up' ? null : 'up')}
              >
                👍{panel ? ' Helpful' : ''}
              </button>
              <button
                type="button"
                title="Not helpful"
                aria-label="Not helpful"
                className={thumb === 'down' ? 'as-on' : ''}
                onClick={() => setThumb(thumb === 'down' ? null : 'down')}
              >
                👎
              </button>
            </div>
            <span style={{ flex: 1 }} />
            <CostChip cost={msg.cost} tokens={msg.tokensIn + msg.tokensOut} metered={msg.metered} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="as-ai">
      {answerer ? (
        <AiAvatar provider={answerer.provider} color={answerer.color} glyph={answerer.glyph} size={26} />
      ) : (
        <BoardAiAvatar provider={state?.boardAi.provider} size={26} />
      )}
      <div className="as-ai-body">
        {body}
        {error && <div className="ai-error-text">{error}</div>}
      </div>
    </div>
  );
}
