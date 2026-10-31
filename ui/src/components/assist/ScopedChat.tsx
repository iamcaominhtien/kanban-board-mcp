import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { assistApi, assistError, assistKeys, useChat, useScopeState } from '../../api/assist';
import { extractError } from '../../api/extractError';
import type { AssistDraft, ChatMessage, ChatScope, ScopeMember, ScopeState, StartingPoint } from '../../types/assist';
import { AiAvatar, SparkleIcon, useAiBoardState } from '../ai/aiUi';
import { AnswerBlock, type AnswerPanel } from './AnswerBlock';
import { usd } from './assistUi';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { PanelMaxButton, PanelResizer, panelSizing } from '../PanelResizer';
import './assist.css';
import './scopedChat.css';

/** Props of the chat panel. The panel is generic over what the chat is about; see `ChatScope`. */
export interface ScopedChatProps {
  /** What the chat is about: `{ kind: 'ticket', id }` on the ticket page, `{ kind: 'idea', id }` on an idea. */
  scope: ChatScope;
  /** Starting points of the empty chat, shown before the ones the server sends for the scope. */
  startingPoints?: StartingPoint[];
  /** A draft of a kind the scope owns (an idea's draft types); return null to use the board's own draft card. */
  renderDraft?: (draft: AssistDraft) => ReactNode | null;
  /** The panel's "Runs" tab. Without it there is no tab bar. */
  runsTab?: { label: string; content: ReactNode };
  /** Close (the X, and Ctrl+J). */
  onClose: () => void;
  /** Open the run that "Do the work" started. */
  onOpenRun?: (runId: string) => void;
  /** "Open AI members" on the no-AI-member state. */
  onOpenAiMembers?: () => void;
  /** "See usage" on the over-budget state. */
  onOpenUsage?: () => void;
  /** Called after an answer was posted as a comment (the thread refreshes itself). */
  onPosted?: (ticketId: string, commentId: string) => void;
  /** Shown as the heading; defaults to the answering AI member's name. */
  title?: string;
}

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

function costLine(state: ScopeState | undefined, mode: 'ask' | 'work'): string {
  const est = mode === 'work' ? state?.work.estimate : state?.estimate;
  if (!est) return '';
  if (!est.metered) return 'Not metered';
  const usdText = est.usd == null ? '' : est.usd < 0.01 ? 'less than $0.01' : usd(est.usd, 2);
  return mode === 'work' ? `About ${usdText} or more, up to its limits` : `About ${usdText} per answer`;
}

/** The AI member that answers, with its state in words ("Local runner · online"). */
function Who({ state, onPick }: { state: ScopeState | undefined; onPick: (id: string) => void }) {
  const { members: aiMembers } = useAiBoardState();
  const [open, setOpen] = useState(false);
  const cur = state?.members.find((m) => m.id === state.memberId);
  const ai = cur ? aiMembers.get(cur.id) : undefined;
  const choices = (state?.members ?? []).filter((m) => m.ready || m.id === cur?.id);
  return (
    <div className="sc-who">
      {ai ? (
        <AiAvatar provider={ai.provider} color={ai.color} glyph={ai.glyph} size={34} />
      ) : (
        <span className="sc-who-spark">
          <SparkleIcon size={16} />
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="sc-who-name" data-testid="chat-member">
          <span>{cur?.name ?? 'AI'}</span>
          {choices.length > 1 && (
            <button
              type="button"
              className="sc-who-change"
              aria-label="Change the AI that answers"
              onClick={() => setOpen((v) => !v)}
              data-testid="chat-member-change"
            >
              ▾
            </button>
          )}
        </div>
        <div className="sc-who-sub">
          <span className={`as-dot ${cur?.ready ? '' : 'as-dot-grey'}`} />
          <span>{cur?.status ?? 'No AI member'}</span>
        </div>
        {open && (
          <div className="as-menu" style={{ position: 'absolute', zIndex: 5, width: 260 }} role="menu">
            {choices.map((m: ScopeMember) => (
              <button
                key={m.id}
                type="button"
                role="menuitemradio"
                aria-checked={m.id === state?.memberId}
                onClick={() => {
                  setOpen(false);
                  onPick(m.id);
                }}
              >
                <span style={{ flex: 1 }}>
                  {m.name}
                  <span className="ai-muted"> · {m.status}</span>
                </span>
                {m.id === state?.memberId && <span style={{ color: '#2E6F40' }}>✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The state tiles of design E that replace the composer: no AI member, over budget, viewer, unavailable. */
function Blocked({ state, onMembers, onUsage }: { state: ScopeState; onMembers?: () => void; onUsage?: () => void }) {
  const a = state.availability;
  if (a.code === 'not_configured')
    return (
      <div className="sc-tile sc-tile-blue" data-testid="chat-no-member">
        <div className="sc-tile-title">
          <SparkleIcon size={13} /> Choose an AI to use these helpers
        </div>
        <div className="ai-hint">
          The AI button, @ picker and /ai appear when an AI member that can read this project exists.
        </div>
        <button type="button" className="ai-btn ai-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onMembers}>
          Open AI members
        </button>
      </div>
    );
  if (a.code === 'over_budget')
    return (
      <div className="sc-tile sc-tile-amber" data-testid="chat-over-budget">
        <div className="sc-tile-title">⚠ {a.daily ? 'AI is paused until tomorrow' : 'AI is paused'}</div>
        <div className="ai-hint">
          {a.daily
            ? 'The daily cap was reached. Ask-only answers and drafts stop; reading the thread still works.'
            : (a.message ?? 'The cap was reached. Reading the thread still works.')}
        </div>
        <button type="button" className="ai-btn ai-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onUsage}>
          See usage
        </button>
      </div>
    );
  if (a.code === 'viewer')
    return (
      <div className="sc-tile sc-tile-blue" data-testid="chat-viewer">
        <div className="sc-tile-title">🔒 You can read, not ask</div>
        <div className="ai-hint">
          Only members can ask the AI. You can still read answers posted on this {state.scope.kind}.
        </div>
      </div>
    );
  return (
    <div className="sc-tile sc-tile-amber" data-testid="chat-unavailable">
      <div className="sc-tile-title">⚠ The AI cannot answer now</div>
      <div className="ai-hint">{a.message ?? 'Try again in a moment.'}</div>
      <button type="button" className="ai-btn ai-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onMembers}>
        Open AI members
      </button>
    </div>
  );
}

/**
 * The chat panel for one thing: a ticket, an idea, a page (design/screens/ai-where-you-work.md, B).
 *
 * It shows exactly what the AI reads, keeps the conversation (private to the person who asks) and picks it up
 * again when the thing is reopened, answers as text or as drafts that are applied only on a click, can post an
 * answer as a comment, and, on a ticket, starts a limited run when the person chooses **Do the work**. The default
 * is **Ask only**, so a question never starts a run. Enter sends, Ctrl+J closes.
 *
 * To use it for another thing, register a scope on the server (`services/ai/assist/scopes.py`) and render
 * `<ScopedChat scope={{ kind: 'idea', id }} startingPoints={…} renderDraft={…} />` inside a column of the page.
 */
export function ScopedChat({
  scope,
  startingPoints,
  renderDraft,
  runsTab,
  onClose,
  onOpenRun,
  onOpenAiMembers,
  onOpenUsage,
  onPosted,
  title,
}: ScopedChatProps) {
  const qc = useQueryClient();
  const st = useScopeState(scope);
  const state = st.data;
  const [chatId, setChatId] = useState<string | null>(null);
  const [tab, setTab] = useState<'chat' | 'runs'>('chat');
  const size = useResizablePanel(`chat-${scope.kind}`, 400, { min: 340 });
  const [mode, setMode] = useState<'ask' | 'work'>('ask');
  const [memberId, setMemberId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const scopeKey = `${scope.kind}:${scope.id}`;

  // a different ticket or idea is a different conversation
  useEffect(() => {
    setChatId(null);
    setMode('ask');
    setMemberId(null);
    setText('');
    setError(null);
    setTab('chat');
  }, [scopeKey]);
  useEffect(() => {
    if (!chatId && state?.chatId) setChatId(state.chatId);
  }, [chatId, state?.chatId]);

  const chat = useChat(chatId);
  const messages = chat.data?.messages ?? [];
  const lastLen = messages.length ? (messages[messages.length - 1]?.text.length ?? 0) : 0;
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastLen, tab]);
  useEffect(() => {
    input.current?.focus();
  }, [scopeKey, tab]);

  const availability = state?.availability;
  const canAsk = availability?.code === 'ok';
  const chosen = memberId ?? state?.memberId ?? null;
  const workOk = !!state?.work.allowed && canAsk;
  const info = state?.scope;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: assistKeys.scope(scope.kind, scope.id) });
    if (chatId) await qc.invalidateQueries({ queryKey: assistKeys.chat(chatId) });
  };

  const send = async (raw: string, opts?: { draft?: boolean; mode?: 'ask' | 'work' }) => {
    const q = raw.trim();
    if (!q || sending || !canAsk) return;
    const how = opts?.mode ?? mode;
    setSending(true);
    setError(null);
    try {
      let id = chatId;
      if (!id) {
        const c = await assistApi.scopeChat(scope);
        id = c.id;
        setChatId(id);
      }
      await assistApi.send(id, { text: q, draft: opts?.draft, mode: how, memberId: chosen });
      setText('');
      setMode('ask'); // Do the work is chosen on purpose, once
      await qc.invalidateQueries({ queryKey: assistKeys.chat(id) });
      if (how === 'work') {
        await qc.invalidateQueries({ queryKey: ['ai'] });
      }
    } catch (e) {
      const body = assistError(e);
      setError(body?.detail ?? extractError(e));
      if (body && ['viewer', 'ai_off', 'over_budget', 'not_configured', 'unavailable'].includes(body.code))
        void refresh();
    } finally {
      setSending(false);
    }
  };

  const panel = useMemo<AnswerPanel>(
    () => ({
      onPostComment:
        scope.kind === 'ticket'
          ? async (msg: ChatMessage) => {
              const r = await assistApi.postAsComment(msg.id);
              await qc.invalidateQueries({ queryKey: assistKeys.chat(msg.chatId) });
              await qc.invalidateQueries({ queryKey: ['tickets'] });
              onPosted?.(r.ticketId, r.commentId);
            }
          : undefined,
      onOpenRun,
      onOpenUsage,
      renderDraft,
    }),
    [scope.kind, qc, onPosted, onOpenRun, onOpenUsage, renderDraft],
  );

  const points = [...(startingPoints ?? []), ...(info?.startingPoints ?? [])];
  const reading = info?.reading ?? [];
  const placeholder = info?.placeholder ?? 'Ask…';
  const memberName = state?.members.find((m) => m.id === chosen)?.name ?? 'the AI';
  const runsHere = !!runsTab;
  const sizing = panelSizing(size);

  return (
    <aside
      className={`sc-panel ai-root ${sizing.className}`}
      style={sizing.style}
      data-testid="scoped-chat"
      aria-label={title ?? 'AI chat'}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <PanelResizer panel={size} label="Resize chat" />
      <div className="sc-head">
        <Who state={state} onPick={(id) => setMemberId(id)} />
        {runsHere && (
          <div className="sc-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'chat'}
              className={tab === 'chat' ? 'sc-tab-on' : ''}
              onClick={() => setTab('chat')}
            >
              Chat
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'runs'}
              className={tab === 'runs' ? 'sc-tab-on' : ''}
              onClick={() => setTab('runs')}
              data-testid="chat-runs-tab"
            >
              {runsTab!.label}
            </button>
          </div>
        )}
        <button
          type="button"
          className="ai-icobtn"
          title="New chat"
          aria-label="New chat"
          onClick={async () => {
            try {
              const c = await assistApi.scopeChat(scope, true);
              setChatId(c.id);
              setTab('chat');
              await refresh();
            } catch (e) {
              setError(extractError(e));
            }
          }}
        >
          +
        </button>
        <PanelMaxButton panel={size} />
        <button type="button" className="ai-icobtn" aria-label="Close" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>

      {tab === 'runs' && runsTab ? (
        <div className="sc-body" data-testid="chat-runs">
          {runsTab.content}
        </div>
      ) : (
        <>
          <div className="sc-reading" data-testid="chat-reading">
            <span className="sc-reading-label">Reading</span>
            {st.isLoading && <span className="as-skel" style={{ height: 22, width: 160 }} />}
            {reading.map((r) => (
              <span key={r.label} className={`sc-chip ${r.skipped ? 'sc-chip-skip' : ''}`} data-kind={r.kind}>
                {r.label}
              </span>
            ))}
            {!reading.length && !st.isLoading && <span className="ai-muted">{info?.title}</span>}
          </div>
          <div className="sc-body" ref={bodyRef}>
            {st.isError && (
              <div className="ai-notice ai-notice-error" data-testid="chat-load-error">
                The AI chat could not load: {extractError(st.error)}
              </div>
            )}
            {state && !canAsk && availability?.code !== 'viewer' && messages.length === 0 && (
              <Blocked state={state} onMembers={onOpenAiMembers} onUsage={onOpenUsage} />
            )}
            {state && !messages.length && canAsk && (
              <div className="sc-welcome" data-testid="chat-welcome">
                <div className="ai-hint" style={{ fontSize: 13 }}>
                  I read {info?.title ?? 'this'} and what is listed above. I propose changes as drafts and never change
                  anything until you press Add or Apply.
                </div>
                {points.length > 0 && <div className="as-label">Try asking</div>}
                {points.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className="as-action"
                    style={{ justifyContent: 'flex-start' }}
                    onClick={() => void send(p.request, { draft: p.draft, mode: 'ask' })}
                  >
                    {p.draft ? '✎' : '💬'} {p.label}
                  </button>
                ))}
              </div>
            )}
            {chat.data &&
              messages.map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className="as-user">
                    {m.text}
                  </div>
                ) : (
                  <AnswerBlock
                    key={m.id}
                    msg={m}
                    chat={chat.data!}
                    state={undefined}
                    panel={panel}
                    onSend={(t, o) => void send(t, { draft: o?.draft, mode: 'ask' })}
                  />
                ),
              )}
            {state && !canAsk && messages.length > 0 && (
              <Blocked state={state} onMembers={onOpenAiMembers} onUsage={onOpenUsage} />
            )}
          </div>
          <div className="sc-composer">
            {availability?.code === 'viewer' && state ? (
              <Blocked state={state} />
            ) : (
              <>
                <div className="sc-modebar">
                  <div className="sc-mode" role="radiogroup" aria-label="What the AI should do">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={mode === 'ask'}
                      className={mode === 'ask' ? 'sc-mode-on' : ''}
                      onClick={() => setMode('ask')}
                      data-testid="chat-mode-ask"
                    >
                      Ask only
                    </button>
                    {info?.work && (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={mode === 'work'}
                        className={mode === 'work' ? 'sc-mode-on sc-mode-work' : ''}
                        disabled={!workOk}
                        title={workOk ? undefined : 'Start a run needs an AI member that can work on this ticket'}
                        onClick={() => setMode('work')}
                        data-testid="chat-mode-work"
                      >
                        Do the work
                      </button>
                    )}
                  </div>
                  <span style={{ flex: 1 }} />
                  <span className="ai-muted" data-testid="chat-private">
                    Private to you
                  </span>
                </div>
                {mode === 'work' && (
                  <div className="sc-worknote" data-testid="chat-work-note">
                    Starts a run of <b>{memberName}</b> on {scope.id} with your message as the instruction. Same limits
                    as an assignment: it stops at Review and asks you before risky steps.
                  </div>
                )}
                <div className="sc-box">
                  <textarea
                    ref={input}
                    rows={1}
                    value={text}
                    disabled={!canAsk}
                    placeholder={placeholder}
                    aria-label="Ask the AI"
                    data-testid="chat-input"
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void send(text);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="as-send"
                    disabled={!canAsk || sending || !text.trim()}
                    aria-label={mode === 'work' ? 'Start a run' : 'Send'}
                    title={mode === 'work' ? 'Start a run' : 'Send'}
                    data-testid="chat-send"
                    onClick={() => void send(text)}
                  >
                    {mode === 'work' ? '▶' : '➤'}
                  </button>
                </div>
                {error && (
                  <div className="ai-error-text" style={{ marginTop: 6 }} data-testid="chat-error">
                    {error}
                  </div>
                )}
                <div className="sc-foot">
                  <span data-testid="chat-cost">{costLine(state, mode)}</span>
                  <span style={{ flex: 1 }} />
                  <span>
                    <kbd>Enter</kbd> send · <kbd>{MOD}</kbd>
                    <kbd>J</kbd> close
                  </span>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
