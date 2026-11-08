import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { assistApi, assistError, assistKeys, useChat, useScopeState } from '../../api/assist';
import { aiApi, isActive, useTicketRuns, useTicketSessions } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { ChatMessage, ChatScope, ScopeState, StartingPoint } from '../../types/assist';
import { AiAvatar, SparkleIcon, useAiBoardState } from '../ai/aiUi';
import { AnswerBlock, type AnswerPanel } from './AnswerBlock';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { PanelMaxButton, PanelResizer, panelSizing } from '../PanelResizer';
import './assist.css';
import './scopedChat.css';
import { ContextMeter, shortTokens } from './ContextMeter';
import { LineIcon } from '../ui/LineIcon';
import { ReplyTray, SelectToReply, UserText, composeReplies, useQuoteReplies } from './quoteReplies';

/** Props of the chat panel. The panel is generic over what the chat is about; see `ChatScope`. */
export interface ScopedChatProps {
  /** What the chat is about: `{ kind: 'ticket', id }` on the ticket page, `{ kind: 'idea', id }` on an idea. */
  scope: ChatScope;
  /** Starting points of the empty chat, shown before the ones the server sends for the scope. */
  startingPoints?: StartingPoint[];
  /** The panel's "Runs" tab. Without it there is no tab bar. */
  runsTab?: { label: string; content: ReactNode };
  /** Close (the X, and Ctrl+J). */
  onClose: () => void;
  /** "Open AI Team" on the Claude-Code-missing state. */
  onOpenAiMembers?: () => void;
  /** Called after an answer was posted as a comment (the thread refreshes itself). */
  onPosted?: (ticketId: string, commentId: string) => void;
  /** Shown as the heading; defaults to the answering AI member's name. */
  title?: string;
  /** Something to show above the chat (a team's question waiting for an answer on this ticket). */
  banner?: ReactNode;
}

/** A command typed after "/" in the box of a ticket chat that talks to a team. */
interface SlashCommand {
  name: string;
  hint: string;
  enabled: boolean;
  run: () => Promise<void>;
}

const REPORT_REQUEST =
  'Give me a short report: what is done, what you are doing now, and what is blocking you. Answer here, then carry on.';

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

/** The small icon of a "Reading" chip, as the design draws it (Description, comments, linked Docs, branch). */
const CHIP_ICONS: Record<string, ReactNode> = {
  description: (
    <>
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5" />
    </>
  ),
  comments: <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />,
  docs: <path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10" />,
  branch: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 8.5v7M18 11.5c0 4-6 3-12 4.5" />
    </>
  ),
};
CHIP_ICONS.doc = CHIP_ICONS.docs;
CHIP_ICONS.private_docs = CHIP_ICONS.docs;

function ChipIcon({ kind }: { kind: string }) {
  const paths = CHIP_ICONS[kind];
  if (!paths) return null;
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#5B6B60"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {paths}
    </svg>
  );
}

/** Who answers: the ticket's team with its state ("Idle", "Working on this ticket"), else the Board AI. */
function Who({ state }: { state: ScopeState | undefined }) {
  const { members: aiMembers } = useAiBoardState();
  const cur = state?.members.find((m) => m.id === state.memberId);
  const ai = cur ? aiMembers.get(cur.id) : undefined;
  const board = state?.boardAi;
  return (
    <div className="sc-who">
      {ai ? (
        <AiAvatar provider={ai.provider} color={ai.color} size={34} />
      ) : (
        <span className="sc-who-spark">
          <SparkleIcon size={16} />
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="sc-who-name" data-testid="chat-member">
          <span>{cur?.name ?? 'Board AI'}</span>
        </div>
        <div className="sc-who-sub">
          <span className={`as-dot ${(cur ? cur.ready : board?.ready) ? '' : 'as-dot-grey'}`} />
          <span>
            {cur
              ? cur.status
              : !board
                ? ' '
                : board.ready
                  ? `${board.name === 'Board AI' ? 'Claude Code' : `${board.name} (${board.providerLabel})`} · online`
                  : board.label}
          </span>
        </div>
      </div>
    </div>
  );
}

/** The state tiles of design E that replace the composer: Claude Code missing, viewer, unavailable. */
function Blocked({ state, onMembers }: { state: ScopeState; onMembers?: () => void }) {
  const a = state.availability;
  if (a.code === 'not_configured')
    return (
      <div className="as-tile as-tile-error" data-testid="chat-no-member">
        <div className="as-tile-title">
          <LineIcon name="warning" size={14} /> {state.boardAi?.label ?? 'Claude Code was not found'}
        </div>
        <div className="ai-hint">
          {a.message ?? 'Claude Code was not found on this computer. Install it, or add an AI team in Members.'}
        </div>
        <button type="button" className="ai-btn ai-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onMembers}>
          Open AI Team
        </button>
      </div>
    );
  if (a.code === 'viewer')
    return (
      <div className="sc-tile sc-tile-blue" data-testid="chat-viewer">
        <div className="sc-tile-title">
          <LineIcon name="lock" size={14} /> You can read, not ask
        </div>
        <div className="ai-hint">
          Only members can ask the AI. You can still read answers posted on this {state.scope.kind}.
        </div>
      </div>
    );
  return (
    <div className="sc-tile sc-tile-amber" data-testid="chat-unavailable">
      <div className="sc-tile-title">
        <LineIcon name="warning" size={14} /> The AI cannot answer now
      </div>
      <div className="ai-hint">{a.message ?? 'Try again in a moment.'}</div>
      <button type="button" className="ai-btn ai-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onMembers}>
        Open AI Team
      </button>
    </div>
  );
}

/**
 * The chat panel for one thing: a ticket, an idea, a page (design/screens/ai-where-you-work.md, B).
 *
 * It shows exactly what the AI reads, keeps the conversation (private to the person who asks) and picks it up
 * again when the thing is reopened, answers as text, can post an answer as a comment, and, on a ticket with a
 * team, writes to the team's lead (the team answers here and keeps working). Enter sends, Ctrl+J closes.
 *
 * To use it for another thing, register a scope on the server (`services/ai/assist/scopes.py`) and render
 * `<ScopedChat scope={{ kind: 'idea', id }} startingPoints={…} />` inside a column of the page.
 */
export function ScopedChat({
  scope,
  startingPoints,
  runsTab,
  onClose,
  onOpenAiMembers,
  onPosted,
  title,
  banner,
}: ScopedChatProps) {
  const qc = useQueryClient();
  const st = useScopeState(scope);
  const state = st.data;
  // the team of a ticket: its runs say how full the lead's conversation is and whether it is working now
  const teamRuns = useTicketRuns(scope.kind === 'ticket' && state?.members.length ? scope.id : undefined).data ?? [];
  const liveRun = teamRuns.find((r) => isActive(r.state));
  const fillRun = teamRuns.find((r) => r.contextWindow && r.contextUsed != null);
  const [notice, setNotice] = useState<string | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [confirmOver, setConfirmOver] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [overBusy, setOverBusy] = useState(false);
  const history = useTicketSessions(scope.kind === 'ticket' && state?.members.length ? scope.id : undefined).data ?? [];
  const [slashAt, setSlashAt] = useState(0);
  const [chatId, setChatId] = useState<string | null>(null);
  const [tab, setTab] = useState<'chat' | 'runs'>('chat');
  const size = useResizablePanel(`chat-${scope.kind}`, 400, { min: 340 });
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const scopeKey = `${scope.kind}:${scope.id}`;
  const quotes = useQuoteReplies();
  const outgoing = composeReplies(quotes.replies, text);
  const clearQuotes = quotes.clear;

  // a different ticket or idea is a different conversation
  useEffect(() => {
    setChatId(null);
    setText('');
    setError(null);
    setTab('chat');
    clearQuotes();
  }, [scopeKey, clearQuotes]);
  useEffect(() => {
    if (!chatId && state?.chatId) setChatId(state.chatId);
  }, [chatId, state?.chatId]);

  // While a ticket's chat is open and in front of the person, tell the board: a run their message started that ends
  // now needs no "AI finished" notice, the answer is on their screen. A closed chat or a window nobody looks at
  // does get the notice.
  useEffect(() => {
    if (!chatId || scope.kind !== 'ticket') return undefined;
    const beat = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        void assistApi.seen(chatId).catch(() => undefined);
      }
    };
    beat();
    const timer = setInterval(beat, 15_000);
    window.addEventListener('focus', beat);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', beat);
    };
  }, [chatId, scope.kind]);

  const chat = useChat(chatId);
  const messages = chat.data?.messages ?? [];
  // how full the shared CLI conversation is, as of the newest answer that says so
  const sessionFill = [...messages].reverse().find((m) => m.role === 'ai' && m.context.contextWindow)
    ?.context.contextWindow;
  const fill = state?.members.length
    ? fillRun
      ? { used: fillRun.contextUsed as number, size: fillRun.contextWindow as number }
      : undefined
    : sessionFill;
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
  const chosen = state?.memberId ?? null;
  const info = state?.scope;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: assistKeys.scope(scope.kind, scope.id) });
    if (chatId) await qc.invalidateQueries({ queryKey: assistKeys.chat(chatId) });
  };

  /** Sends one message; true once the server has it. */
  const send = async (raw: string): Promise<boolean> => {
    const q = raw.trim();
    if (!q || sending || !canAsk) return false;
    setSending(true);
    setError(null);
    try {
      let id = chatId;
      if (!id) {
        const c = await assistApi.scopeChat(scope);
        id = c.id;
        setChatId(id);
      }
      await assistApi.send(id, { text: q, mode: 'ask', memberId: chosen });
      setText('');
      await qc.invalidateQueries({ queryKey: assistKeys.chat(id) });
      return true;
    } catch (e) {
      const body = assistError(e);
      setError(body?.detail ?? extractError(e));
      if (body && ['viewer', 'ai_off', 'not_configured', 'unavailable'].includes(body.code)) void refresh();
      return false;
    } finally {
      setSending(false);
    }
  };

  /** The composer's message with the passages waiting in the tray; they leave the tray once it is sent. */
  const sendComposed = async () => {
    // `//` starts a message that really begins with a slash
    if (await send(outgoing.startsWith('//') ? outgoing.slice(1) : outgoing)) quotes.clear();
  };

  const newChat = async () => {
    setPlusOpen(false);
    try {
      const c = await assistApi.scopeChat(scope, true);
      setChatId(c.id);
      setTab('chat');
      await refresh();
    } catch (e) {
      setError(extractError(e));
    }
  };
  const startOver = async () => {
    setOverBusy(true);
    try {
      const row = await aiApi.newSession(scope.id);
      setConfirmOver(false);
      setShowHistory(true);
      setNotice(`Started over. Kept in History: “${row.title}”.`);
      await qc.invalidateQueries({ queryKey: ['ai'] });
    } catch (e) {
      setError(extractError(e));
      setConfirmOver(false);
    } finally {
      setOverBusy(false);
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
    }),
    [scope.kind, qc, onPosted],
  );

  const points = [...(startingPoints ?? []), ...(info?.startingPoints ?? [])];
  const reading = info?.reading ?? [];
  const placeholder = info?.placeholder ?? 'Ask…';
  const team = state?.members.find((m) => m.id === chosen);
  const memberName = team?.name ?? 'the AI';
  const teamWorking = !!team && team.status.startsWith('Working');

  // "/" at the start of the box opens the commands of a ticket's team
  const slashCommands: SlashCommand[] = team
    ? [
        {
          name: 'compact',
          hint: liveRun ? 'Summarise its conversation; runs after this run' : 'Summarise the lead’s conversation',
          enabled: !!(liveRun || fillRun),
          run: async () => {
            const r = await aiApi.compact(scope.id);
            setNotice(
              r.state === 'queued'
                ? 'Compacting once the lead finishes the step it is on. It is not stopped.'
                : `Compacted: ${shortTokens(r.before ?? 0)} → ${shortTokens(r.after ?? 0)} tokens.`,
            );
            await qc.invalidateQueries({ queryKey: ['ai'] });
          },
        },
        {
          name: 'new',
          hint: 'Start over; a summary stays in History',
          enabled: !liveRun && teamRuns.length > 0,
          run: async () => {
            setConfirmOver(true);
          },
        },
        {
          name: 'history',
          hint: 'Closed conversations of this team',
          enabled: true,
          run: async () => {
            setShowHistory((v) => !v);
          },
        },
        {
          name: 'report',
          hint: 'A short report, answered here',
          enabled: true,
          run: async () => {
            await send(REPORT_REQUEST);
          },
        },
        {
          name: 'stop',
          hint: 'Stop the working run',
          enabled: !!liveRun,
          run: async () => {
            if (liveRun) await aiApi.cancel(liveRun.id);
            setNotice('Stopped.');
            await qc.invalidateQueries({ queryKey: ['ai'] });
          },
        },
        {
          name: 'cost',
          hint: 'What the team spent here',
          enabled: teamRuns.length > 0,
          run: async () => {
            const spent = teamRuns.reduce((n, r) => n + (r.costUsd || 0), 0);
            const tokens = teamRuns.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0);
            setNotice(
              `${teamRuns.length} run${teamRuns.length === 1 ? '' : 's'} · ${shortTokens(tokens)} tokens${spent > 0 ? ` · $${spent.toFixed(2)}` : ' · not metered'}`,
            );
          },
        },
      ]
    : [];
  const slashOpen = !!team && /^\/[a-z]*$/i.test(text);
  const slashMatches = slashOpen ? slashCommands.filter((c) => c.name.startsWith(text.slice(1).toLowerCase())) : [];
  const slashPick = Math.min(slashAt, Math.max(0, slashMatches.length - 1));
  const runSlash = async (c: SlashCommand) => {
    if (!c.enabled || sending) return;
    setText('');
    setError(null);
    setNotice(null);
    try {
      await c.run();
    } catch (e) {
      setError(extractError(e));
    }
  };
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
        <Who state={state} />
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
        {team ? (
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="ai-icobtn"
              title="New chat, start the team over, history"
              aria-label="Chat menu"
              aria-haspopup="menu"
              aria-expanded={plusOpen}
              data-testid="chat-plus"
              onClick={() => setPlusOpen((v) => !v)}
            >
              +
            </button>
            {plusOpen && (
              <div
                className="as-menu"
                role="menu"
                data-testid="chat-plus-menu"
                style={{ position: 'absolute', right: 0, top: '100%', zIndex: 8, width: 280 }}
              >
                <button type="button" role="menuitem" className="as-action" onClick={() => void newChat()}>
                  <LineIcon name="plus" size={14} /> New chat <span className="ai-muted">the lead still remembers</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="as-action"
                  disabled={!!liveRun}
                  title={liveRun ? 'The team is working: stop the run first' : undefined}
                  data-testid="chat-start-over"
                  onClick={() => {
                    setPlusOpen(false);
                    setConfirmOver(true);
                  }}
                >
                  <LineIcon name="refresh" size={14} /> Start the team over{' '}
                  <span className="ai-muted">the lead forgets</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="as-action"
                  data-testid="chat-history-toggle"
                  onClick={() => {
                    setPlusOpen(false);
                    setShowHistory((v) => !v);
                  }}
                >
                  <LineIcon name="clock" size={14} /> History <span className="ai-muted">{history.length}</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="ai-icobtn"
            title="New chat"
            aria-label="New chat"
            onClick={() => void newChat()}
          >
            +
          </button>
        )}
        <PanelMaxButton panel={size} />
        <button type="button" className="ai-icobtn" aria-label="Close" title="Close" onClick={onClose}>
          <LineIcon name="close" size={14} />
        </button>
      </div>

      {tab === 'runs' && runsTab ? (
        <div className="sc-body" data-testid="chat-runs">
          {runsTab.content}
        </div>
      ) : (
        <>
          {banner}
          <div className="sc-reading" data-testid="chat-reading">
            <span className="sc-reading-label">Reading</span>
            {st.isLoading && <span className="as-skel" style={{ height: 22, width: 160 }} />}
            {reading.map((r) => (
              <span key={r.label} className={`sc-chip ${r.skipped ? 'sc-chip-skip' : ''}`} data-kind={r.kind}>
                <ChipIcon kind={r.kind} />
                {r.label}
              </span>
            ))}
            {!reading.length && !st.isLoading && <span className="ai-muted">{info?.title}</span>}
          </div>
          <div className="sc-body" ref={bodyRef}>
            {team && confirmOver && (
              <div className="as-tile as-tile-warn" data-testid="chat-start-over-confirm">
                <div className="as-tile-title">Start {memberName} over?</div>
                <div className="ai-hint">
                  The lead will not remember this conversation. A title and a summary are kept in History, and the
                  ticket, its comments and the Workspace stay as they are. The next message starts a new conversation.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="ai-btn ai-btn-sm ai-btn-primary"
                    disabled={overBusy}
                    data-testid="chat-start-over-yes"
                    onClick={() => void startOver()}
                  >
                    {overBusy ? 'Summarising…' : 'Start over'}
                  </button>
                  <button
                    type="button"
                    className="ai-btn ai-btn-sm"
                    disabled={overBusy}
                    onClick={() => setConfirmOver(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {team && showHistory && (
              <div className="as-tile" data-testid="chat-history">
                <div className="as-tile-title">
                  <LineIcon name="clock" size={13} /> History of {memberName} on this ticket
                </div>
                {history.length === 0 && <div className="ai-muted">Nothing closed yet.</div>}
                {history.map((h) => (
                  <details key={h.id} data-testid="chat-history-item">
                    <summary style={{ cursor: 'pointer' }}>
                      <b>{h.title || 'Untitled'}</b> <span className="ai-muted">{h.endedAt.slice(0, 10)}</span>
                    </summary>
                    <div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, margin: '4px 0 6px 12px' }}>{h.summary}</div>
                    <div className="ai-muted" style={{ fontSize: 11, marginLeft: 12 }}>
                      {h.runIds.length} run{h.runIds.length === 1 ? '' : 's'}
                      {h.sessionIds.length ? ` · session ${h.sessionIds.join(', ')}` : ''}
                    </div>
                  </details>
                ))}
              </div>
            )}
            {st.isError && (
              <div className="ai-notice ai-notice-error" data-testid="chat-load-error">
                The AI chat could not load: {extractError(st.error)}
              </div>
            )}
            {state && !canAsk && availability?.code !== 'viewer' && messages.length === 0 && (
              <Blocked state={state} onMembers={onOpenAiMembers} />
            )}
            {state && !messages.length && canAsk && (
              <div className="sc-welcome" data-testid="chat-welcome">
                <div className="ai-hint" style={{ fontSize: 13 }} data-testid="chat-hint">
                  {team
                    ? `Write to ${memberName}, the team on this ticket. Working, it reads your message at its next step, answers here and carries on; idle, your message is its next task.`
                    : `I read ${scope.kind === 'ticket' ? scope.id : (info?.title ?? 'this')} and what is listed above. I do what can be undone at once and ask you about the rest.`}
                </div>
                {!team && points.length > 0 && <div className="as-label">Try asking</div>}
                {(team ? [] : points).map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className="as-action"
                    style={{ justifyContent: 'flex-start' }}
                    onClick={() => void send(p.request)}
                  >
                    <LineIcon name="chat" size={13} /> {p.label}
                  </button>
                ))}
              </div>
            )}
            {chat.data &&
              messages.map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className="as-user">
                    <UserText text={m.text} />
                  </div>
                ) : (
                  <AnswerBlock key={m.id} msg={m} chat={chat.data!} panel={panel} />
                ),
              )}
            {state && !canAsk && messages.length > 0 && <Blocked state={state} onMembers={onOpenAiMembers} />}
          </div>
          <SelectToReply containerRef={bodyRef} onReply={quotes.add} disabled={!canAsk} />
          <div className="sc-composer">
            {availability?.code === 'viewer' && state ? (
              <Blocked state={state} />
            ) : (
              <>
                <div className="sc-modebar">
                  {team ? (
                    <span className="ai-muted" data-testid="chat-team-note">
                      To {memberName}
                      {teamWorking ? ': it answers here and keeps working unless you tell it to stop' : ''}
                    </span>
                  ) : (
                    <span className="ai-muted" data-testid="chat-private">
                      Private to you
                    </span>
                  )}
                </div>
                <ReplyTray
                  replies={quotes.replies}
                  focusId={quotes.focusId}
                  onChange={quotes.update}
                  onRemove={quotes.remove}
                  onDone={() => input.current?.focus()}
                />
                {notice && (
                  <div className="ai-muted" style={{ marginBottom: 6 }} data-testid="chat-notice">
                    {notice}
                  </div>
                )}
                <div className="sc-box" style={{ position: 'relative' }}>
                  {slashMatches.length > 0 && (
                    <div
                      role="listbox"
                      aria-label="Commands"
                      data-testid="chat-slash-menu"
                      style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        bottom: '100%',
                        marginBottom: 6,
                        background: 'var(--bg, #fff)',
                        border: '1px solid #DCE3DE',
                        borderRadius: 10,
                        boxShadow: '0 6px 20px rgba(0,0,0,.08)',
                        padding: 4,
                        zIndex: 6,
                      }}
                    >
                      {slashMatches.map((c, i) => (
                        <button
                          key={c.name}
                          type="button"
                          role="option"
                          aria-selected={i === slashPick}
                          aria-disabled={!c.enabled}
                          data-testid={`chat-slash-${c.name}`}
                          onMouseEnter={() => setSlashAt(i)}
                          onClick={() => void runSlash(c)}
                          style={{
                            display: 'flex',
                            gap: 10,
                            width: '100%',
                            textAlign: 'left',
                            padding: '6px 8px',
                            border: 0,
                            borderRadius: 6,
                            background: i === slashPick ? '#EEF4F0' : 'transparent',
                            opacity: c.enabled ? 1 : 0.45,
                            cursor: c.enabled ? 'pointer' : 'default',
                            font: 'inherit',
                            fontSize: 12,
                            alignItems: 'baseline',
                            color: 'inherit',
                          }}
                        >
                          <b
                            style={{
                              fontFamily: 'JetBrains Mono, monospace',
                              fontSize: 12,
                              fontWeight: 600,
                              flexShrink: 0,
                            }}
                          >
                            /{c.name}
                          </b>
                          <span className="ai-muted" style={{ fontSize: 12 }}>
                            {c.hint}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={input}
                    rows={1}
                    value={text}
                    disabled={!canAsk}
                    placeholder={quotes.replies.length ? 'Anything else? (optional)' : placeholder}
                    aria-label="Ask the AI"
                    data-testid="chat-input"
                    onChange={(e) => {
                      setText(e.target.value);
                      setSlashAt(0);
                      setNotice(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return;
                      if (slashMatches.length) {
                        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                          e.preventDefault();
                          const n = slashMatches.length;
                          setSlashAt((slashPick + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
                          return;
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          setText('');
                          return;
                        }
                        if (e.key === 'Enter' || e.key === 'Tab') {
                          e.preventDefault();
                          void runSlash(slashMatches[slashPick]);
                          return;
                        }
                      }
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void sendComposed();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="as-send"
                    disabled={!canAsk || sending || !outgoing.trim()}
                    aria-label="Send"
                    title="Send"
                    data-testid="chat-send"
                    onClick={() => (slashMatches.length ? void runSlash(slashMatches[slashPick]) : void sendComposed())}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M4 12l16-8-6 16-3-7-7-1z" />
                    </svg>
                  </button>
                </div>
                {error && (
                  <div className="ai-error-text" style={{ marginTop: 6 }} data-testid="chat-error">
                    {error}
                  </div>
                )}
                <div className="sc-foot">
                  {fill && <ContextMeter used={fill.used} size={fill.size} inline />}
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
