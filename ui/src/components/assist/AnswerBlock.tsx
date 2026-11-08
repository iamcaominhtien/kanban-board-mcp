import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { assistApi, assistKeys } from '../../api/assist';
import { extractError } from '../../api/extractError';
import type { ChatDetail, ChatMessage } from '../../types/assist';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { AiAvatar, hhmm, secondsSince, useAiBoardState } from '../ai/aiUi';
import { useAssist } from './AssistContext';
import { BoardAiAvatar, CostChip, TicketPill, currentPerson } from './assistUi';
import { DoneReceipt } from './DoneReceipt';
import { LineIcon } from '../ui/LineIcon';

const SLOW_AFTER_S = 30;

/** What a chat about one thing (a ticket, an idea) adds to an answer: sharing it. */
export interface AnswerPanel {
  /** "Post as comment": resolves when the comment exists. Only offered when given. */
  onPostComment?: (msg: ChatMessage) => Promise<void>;
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

/** One Board AI answer in every state: thinking with steps, streaming, slow, done with sources and the receipt of what
 * it did, stopped, error, rate-limited; truncated context, injection and private-doc notices (B, G). */
export function AnswerBlock({
  msg,
  chat,
  panel,
}: {
  msg: ChatMessage;
  chat: ChatDetail;
  /** Set by the chat panel of a ticket or an idea (design/screens/ai-where-you-work.md, B). */
  panel?: AnswerPanel;
}) {
  const ctx = useAssist();
  const qc = useQueryClient();
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
  const undoAll = () =>
    act(async () => {
      await assistApi.undo(msg.id);
      await qc.invalidateQueries({ queryKey: assistKeys.chat(chat.id) });
    });
  const elapsed = secondsSince(msg.createdAt) ?? 0;
  const ctxInfo = msg.context;
  // the tool the member used last ("Using get_ticket · YU-12"), when it uses its own tools
  const lastStep = msg.steps.length ? msg.steps[msg.steps.length - 1].text : '';
  const usingTool = lastStep.startsWith('Using ');

  const receiptBlock =
    ctxInfo.receipt && ctxInfo.receipt.applied.length > 0 ? (
      <div style={{ marginTop: 8 }}>
        <DoneReceipt
          receipt={ctxInfo.receipt}
          person={chat.owner || currentPerson()}
          busy={busy}
          onUndo={() => void undoAll()}
        />
      </div>
    ) : null;

  let body;
  if ((msg.state === 'thinking' || msg.state === 'queued') && ctxInfo.team) {
    // a message to the team: its lead answers here when it reaches it, and keeps working meanwhile
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="answer-waiting-team">
        <div style={{ fontWeight: 700, fontSize: 13 }}>Waiting for {ctxInfo.team}…</div>
        <div className="ai-muted">
          It reads your message at its next step, answers here and carries on with its work. Tell it to stop if you want
          it to.
        </div>
      </div>
    );
  } else if (msg.state === 'thinking' || msg.state === 'queued') {
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
                : 'Usually a few seconds. Claude Code is busy. You can keep working meanwhile.'}
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
      </div>
    );
  } else if (msg.state === 'streaming') {
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
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={() => void stop()}>
            Stop
          </button>
        </div>
      </div>
    );
  } else if (msg.state === 'error') {
    body = (
      <div>
        <div className="as-tile as-tile-error" data-testid="answer-error">
          <div className="as-tile-title">Couldn’t get an answer</div>
          <div className="ai-hint">
            {msg.error.message ?? 'Claude Code did not answer.'}{' '}
            {ctxInfo.receipt?.applied.length
              ? 'It had changed some things before it stopped: see below.'
              : 'Nothing was changed.'}{' '}
            Your message is kept.
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
        {receiptBlock}
      </div>
    );
  } else if (msg.state === 'rate_limited') {
    const left = msg.retryAt ? Math.max(0, Math.round((new Date(msg.retryAt).getTime() - Date.now()) / 1000)) : 0;
    body = (
      <div className="as-tile as-tile-warn" data-testid="answer-rate-limited">
        <div className="as-tile-title">Rate-limited by the Claude account</div>
        <div className="ai-hint">The account’s usage window is full. Your message is queued and sends in {left} s.</div>
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
  } else {
    const trunc = ctxInfo.truncated;
    body = (
      <div data-testid="answer-done">
        {msg.text && (
          // a passage selected here can be replied to (quoteReplies.tsx)
          <div className="as-quotable">
            <MarkdownRenderer docs={{ projectId, onOpenTicket: ctx?.onOpenTicket }}>{msg.text}</MarkdownRenderer>
          </div>
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
        {receiptBlock}
        {panel && msg.text && (
          <div className="sc-share" data-testid="answer-share">
            {panel.onPostComment &&
              (ctxInfo.posted ? (
                <span className="ai-muted" data-testid="answer-posted">
                  <LineIcon name="check" size={12} /> Posted as a comment
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
                  <LineIcon name="chat" size={13} /> Post as comment
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
              <LineIcon name="copy" size={13} /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
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
                  Not sent to Claude Code and not citable. Only a doc's owner can include it for one chat.
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
                Send all
              </button>
            </div>
          </div>
        )}
        {
          <div className="as-meta">
            <button
              type="button"
              className="as-ctx-chip"
              style={{ cursor: 'pointer', maxWidth: 'none' }}
              onClick={() => setShowSources((v) => !v)}
            >
              <span>
                <LineIcon name="link" size={13} /> {ctxInfo.label ?? 'Based on the board'}
              </span>{' '}
              <LineIcon name="chevronDown" size={12} />
            </button>
            <span className="ai-muted">answered {hhmm(msg.finishedAt ?? msg.createdAt)}</span>
          </div>
        }
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
                    <span>
                      <LineIcon name="page" size={13} /> {it.title}
                    </span>
                  </button>
                ),
              )}
            </div>
          </div>
        )}
        {
          <div className="as-meta" style={{ marginTop: 6 }}>
            <div className="as-icons">
              <button
                type="button"
                title="Copy"
                aria-label="Copy answer"
                onClick={() => void navigator.clipboard?.writeText(msg.text)}
              >
                <LineIcon name="copy" size={14} />
              </button>
              {!ctxInfo.receipt?.applied.length && (
                <button type="button" title="Regenerate" aria-label="Regenerate" onClick={() => void retry()}>
                  <LineIcon name="refresh" size={14} />
                </button>
              )}
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
            {msg.metered && <CostChip cost={msg.cost} tokens={msg.tokensIn + msg.tokensOut} />}
          </div>
        }
      </div>
    );
  }
  return (
    <div className="as-ai">
      {answerer ? (
        <AiAvatar provider={answerer.provider} color={answerer.color} size={26} />
      ) : (
        <BoardAiAvatar size={26} />
      )}
      <div className="as-ai-body">
        {body}
        {error && <div className="ai-error-text">{error}</div>}
      </div>
    </div>
  );
}
