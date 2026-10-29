import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { assistApi, assistError, useAssistState, useChat, useChats } from '../../api/assist';
import { extractError } from '../../api/extractError';
import { useDocsTree } from '../../api/docs';
import type { AssistScope, AssistState, Chat } from '../../types/assist';
import { useAssist } from './AssistContext';
import { AnswerBlock } from './AnswerBlock';
import { BoardAiAvatar, dayOrTime, usd } from './assistUi';
import './assist.css';

const SCOPES: { key: AssistScope; label: string; reads: string; size: string }[] = [
  { key: 'ticket', label: 'This ticket', reads: 'Comments, sub-tickets, linked docs', size: '~4k tokens' },
  { key: 'project', label: 'This project', reads: 'Filtered tickets and attached docs', size: '~20k tokens' },
  { key: 'all', label: 'All projects', reads: 'Only projects you belong to · slower', size: '~5× cost' },
];

const SUGGESTIONS = ['Who’s blocked this week?', 'What changed since Monday?', 'What should I pick up next?'];

/** A7: no Board AI chosen yet. */
export function NoBoardAi({ onSettings, onMembers }: { onSettings?: () => void; onMembers?: () => void }) {
  return (
    <div className="as-tile" data-testid="assist-not-configured">
      <div className="as-tile-title">
        Board AI isn’t set up
        <span className="ai-chip" style={{ background: '#EEF1F5', color: '#5B6B7A' }}>
          Not configured
        </span>
      </div>
      <div className="ai-hint">
        Pick the AI that answers board-wide questions. It needs a working API key or local runner. Until then chat,
        drafting and suggestions are disabled.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="ai-btn ai-btn-primary ai-btn-sm" onClick={onSettings}>
          Open Settings → AI
        </button>
        <button type="button" className="ai-btn ai-btn-sm" onClick={onMembers}>
          Manage AI members
        </button>
      </div>
    </div>
  );
}

/** I1: the Board AI cannot answer now. */
export function BoardAiOffline({ state, onMembers }: { state: AssistState; onMembers?: () => void }) {
  return (
    <div className="as-tile as-tile-error" data-testid="assist-unavailable">
      <div className="as-tile-title">
        {state.boardAi.name}: {state.boardAi.status?.label?.toLowerCase() ?? 'unavailable'}
      </div>
      <div className="ai-hint">
        {state.boardAi.status?.detail ?? 'Chat, drafting and suggestions are disabled until it is fixed.'}
      </div>
      <button type="button" className="ai-link" style={{ alignSelf: 'flex-start' }} onClick={onMembers}>
        Fix in AI members
      </button>
    </div>
  );
}

function scopeLabel(c: Chat): string {
  if (c.scope === 'ticket') return c.ticketId ?? 'This ticket';
  if (c.scope === 'all') return 'All projects';
  if (c.scope === 'doc') return 'This page';
  return 'This project';
}

function History({ projectId, onOpen, onNew }: { projectId: string; onOpen: (id: string) => void; onNew: () => void }) {
  const [q, setQ] = useState('');
  const list = useChats(projectId, q);
  const chats = list.data?.chats ?? [];
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  const groups: [string, Chat[]][] = [
    ['Today', chats.filter((c) => new Date(c.updatedAt).toDateString() === today)],
    ['Yesterday', chats.filter((c) => new Date(c.updatedAt).toDateString() === yesterday)],
    ['Earlier', chats.filter((c) => ![today, yesterday].includes(new Date(c.updatedAt).toDateString()))],
  ];
  return (
    <div className="as-body" data-testid="assist-history">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Chat history</div>
          <div className="ai-muted">Only visible to you</div>
        </div>
        <button type="button" className="ai-btn ai-btn-primary ai-btn-sm" onClick={onNew}>
          + New chat
        </button>
      </div>
      <input
        className="ai-input"
        placeholder="Search chats…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search chats"
      />
      {list.isLoading && <div className="as-skel" style={{ height: 40 }} />}
      {!list.isLoading && !chats.length && <div className="ai-muted">No chats yet.</div>}
      {groups.map(([label, rows]) =>
        rows.length ? (
          <div key={label}>
            <div className="as-label">{label}</div>
            {rows.map((c) => (
              <div
                key={c.id}
                className="as-history-row"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(c.id)}
                onKeyDown={(e) => e.key === 'Enter' && onOpen(c.id)}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.title}
                  </div>
                  <div className="ai-muted">
                    {scopeLabel(c)} · {dayOrTime(c.updatedAt)}
                  </div>
                </div>
                <span className="as-cost">{usd(c.cost)}</span>
              </div>
            ))}
          </div>
        ) : null,
      )}
      <div className="ai-muted" style={{ marginTop: 'auto' }}>
        Chats are private to you. Kept {list.data?.keepDays ?? 30} days, then deleted. A chat that applied changes keeps
        only a log line in Activity.
      </div>
      <div className="ai-muted">
        {list.data?.count ?? 0} chats · {usd(list.data?.monthCost ?? 0)} this month
      </div>
    </div>
  );
}

/** The 420 px Board AI dock on the right (A1, B). The board shrinks; nothing is covered. */
export function AssistDock() {
  const ctx = useAssist();
  const qc = useQueryClient();
  const projectId = ctx?.projectId ?? '';
  const st = useAssistState(projectId);
  const state = st.data;
  const chat = useChat(ctx?.chatId ?? null);
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [scopeHelp, setScopeHelp] = useState(false);
  const [docChip, setDocChip] = useState<string | null>(null);
  const [docPicker, setDocPicker] = useState(false);
  const tree = useDocsTree(projectId);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const scope = ctx?.scope ?? 'project';

  const send = async (raw: string, opts?: { draft?: boolean; sendAll?: boolean }) => {
    if (!ctx || !projectId) return;
    const q = raw.trim();
    if (!q) return;
    setSending(true);
    setError(null);
    try {
      let id = ctx.chatId;
      if (!id) {
        const created = await assistApi.createChat(projectId, {
          scope,
          ticketId: scope === 'ticket' ? ctx.ticketId : null,
          docId: scope === 'doc' ? ctx.docId : null,
        });
        id = created.id;
        ctx.setChatId(id);
      }
      const f = ctx.filters;
      await assistApi.send(id, {
        text: q,
        draft: opts?.draft,
        sendAll: opts?.sendAll,
        docIds: docChip ? [docChip] : [],
        filters: {
          assignee: f.assignee ?? undefined,
          type: f.type ?? undefined,
          priority: f.priority ?? undefined,
          q: f.q ?? undefined,
        },
      });
      setText('');
      await qc.invalidateQueries({ queryKey: ['assist', 'chat', id] });
    } catch (e) {
      const body = assistError(e);
      setError(body?.detail ?? extractError(e));
    } finally {
      setSending(false);
    }
  };

  // A request from an entry point ("Ask about this ticket", "Draft first ticket with AI"…)
  useEffect(() => {
    if (!ctx?.pending) return;
    const p = ctx.consumePending();
    setView('chat');
    if (p?.text) void send(p.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.pending]);

  const msgCount = chat.data?.messages.length ?? 0;
  const lastLen = msgCount ? (chat.data?.messages[msgCount - 1]?.text.length ?? 0) : 0;
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgCount, lastLen]);

  if (!ctx || !ctx.open) return null;

  const switchScope = async (s: AssistScope) => {
    ctx.setScope(s);
    if (ctx.chatId) {
      try {
        await assistApi.patchChat(ctx.chatId, {
          scope: s,
          ticketId: s === 'ticket' ? ctx.ticketId : undefined,
        });
        await chat.refetch();
      } catch (e) {
        setError(extractError(e));
      }
    }
  };

  const b = state?.boardAi;
  const notConfigured = b?.state === 'not_configured';
  const chatFeature = state?.features.find((f) => f.key === 'chat');
  const chatOff = chatFeature ? !chatFeature.on : false;
  const offline = b?.state === 'unavailable';
  const overBudget = !!state?.overBudget;
  const messages = chat.data?.messages ?? [];
  const placeholder =
    scope === 'ticket'
      ? 'Ask about this ticket…'
      : scope === 'all'
        ? 'Ask about all your projects…'
        : scope === 'doc'
          ? 'Ask about this page…'
          : 'Ask about this project…';
  const disabled = notConfigured || chatOff || offline || overBudget;
  const f = ctx.filters;
  const filterLabel = f.assignee || f.type || f.priority || f.q ? 'Filtered' : 'No filters';

  return (
    <aside className="as-dock ai-root" data-testid="assist-dock" aria-label="Board AI">
      <div className="as-head">
        <BoardAiAvatar provider={b?.provider} size={34} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="as-head-title">Board AI</div>
          <div className="as-head-sub">
            <span
              className={`as-dot ${b?.state === 'ready' ? '' : b?.state === 'unavailable' ? 'as-dot-red' : 'as-dot-grey'}`}
            />
            {b?.name ? (
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {b.name} · {b.state === 'ready' ? 'online' : (b.status?.label?.toLowerCase() ?? 'unavailable')}
              </span>
            ) : (
              'Not configured'
            )}
          </div>
        </div>
        <button
          type="button"
          className="ai-icobtn"
          title="Chat history"
          aria-label="Chat history"
          onClick={() => setView(view === 'history' ? 'chat' : 'history')}
        >
          ⟲
        </button>
        <button
          type="button"
          className="ai-icobtn"
          title="New chat"
          aria-label="New chat"
          onClick={() => {
            ctx.setChatId(null);
            setView('chat');
          }}
        >
          +
        </button>
        <button type="button" className="ai-icobtn" title="Close" aria-label="Close Board AI" onClick={ctx.close}>
          ✕
        </button>
      </div>
      {view === 'history' ? (
        <History
          projectId={projectId}
          onOpen={(id) => {
            ctx.setChatId(id);
            setView('chat');
          }}
          onNew={() => {
            ctx.setChatId(null);
            setView('chat');
          }}
        />
      ) : (
        <>
          <div
            style={{ padding: '12px 16px 0', display: 'flex', flexDirection: 'column', gap: 8, position: 'relative' }}
          >
            {scope === 'doc' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b style={{ fontSize: 14 }}>Ask this page</b>
                <button
                  type="button"
                  className="ai-link"
                  style={{ fontSize: 12 }}
                  onClick={() => void switchScope('project')}
                >
                  Ask about the project instead
                </button>
              </div>
            )}
            {scope !== 'doc' && (
              <div className="as-scope" role="tablist" aria-label="Scope">
                {SCOPES.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    role="tab"
                    aria-selected={scope === s.key}
                    className={scope === s.key ? 'as-scope-on' : ''}
                    disabled={s.key === 'ticket' && !ctx.ticketId}
                    title={
                      s.key === 'ticket' && !ctx.ticketId ? 'Open a ticket to ask about it' : `${s.reads} · ${s.size}`
                    }
                    onClick={() => void switchScope(s.key)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setScopeHelp(true);
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span className="as-ctx-chip">
                <span>🗀 {scope === 'all' ? 'All projects' : ctx.projectName}</span>
              </span>
              {scope === 'ticket' && ctx.ticketId && (
                <span className="as-ctx-chip">
                  <span>🗋 {ctx.ticketId}</span>
                </span>
              )}
              {scope === 'project' && (
                <span className="as-ctx-chip" title="The board's active filters are sent with the question">
                  <span>⚙ {filterLabel}</span>
                </span>
              )}
              {scope === 'doc' ? (
                <span className="as-ctx-chip">
                  <span>📄 This page</span>
                </span>
              ) : (
                <span className="as-ctx-chip" style={{ position: 'relative' }}>
                  <button
                    type="button"
                    style={{ color: '#1E2A22', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit' }}
                    onClick={() => setDocPicker((v) => !v)}
                    data-testid="assist-doc-chip"
                  >
                    📄 {docChip ? (tree.data?.find((n) => n.id === docChip)?.title ?? 'Doc') : 'No doc selected'}
                  </button>
                  {docChip && (
                    <button type="button" aria-label="Remove doc" onClick={() => setDocChip(null)}>
                      ✕
                    </button>
                  )}
                  {docPicker && (
                    <div className="as-menu" style={{ top: 26, left: 0, maxHeight: 220, overflowY: 'auto' }}>
                      {(tree.data ?? []).length === 0 && (
                        <div className="ai-muted" style={{ padding: 8 }}>
                          No docs yet
                        </div>
                      )}
                      {(tree.data ?? []).map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => {
                            setDocChip(n.id);
                            setDocPicker(false);
                          }}
                        >
                          📄 {n.title}
                        </button>
                      ))}
                    </div>
                  )}
                </span>
              )}
              <button
                type="button"
                className="ai-icobtn"
                style={{ width: 22, height: 22, fontSize: 12 }}
                title="What the Board AI may read"
                aria-label="What the Board AI may read"
                onClick={() => setScopeHelp((v) => !v)}
              >
                ⓘ
              </button>
            </div>
            {scopeHelp && (
              <div className="as-popover" style={{ top: 50, left: 16, right: 16 }} data-testid="assist-scope-help">
                <div className="as-label" style={{ marginTop: 2 }}>
                  Scope · what the Board AI may read
                </div>
                {SCOPES.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    className="as-history-row"
                    style={{
                      width: '100%',
                      border: 'none',
                      background: scope === s.key ? '#F1F8F3' : 'none',
                      textAlign: 'left',
                      fontFamily: 'inherit',
                    }}
                    disabled={s.key === 'ticket' && !ctx.ticketId}
                    onClick={() => {
                      setScopeHelp(false);
                      void switchScope(s.key);
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{s.label}</div>
                      <div className="ai-muted">{s.reads}</div>
                    </div>
                    <span className="as-cost">{s.size}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="as-body" ref={bodyRef}>
            {notConfigured && <NoBoardAi onSettings={ctx.onOpenSettings} onMembers={ctx.onOpenAiMembers} />}
            {!notConfigured && offline && state && <BoardAiOffline state={state} onMembers={ctx.onOpenAiMembers} />}
            {!notConfigured && chatOff && (
              <div className="as-tile" data-testid="assist-feature-off">
                <div className="as-tile-title">Chat is turned off for this board</div>
                <div className="ai-hint">
                  Turned off in Settings → AI. Header button and {`⌘J`} are hidden; other features keep working.
                </div>
                <button
                  type="button"
                  className="ai-btn ai-btn-sm"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={ctx.onOpenSettings}
                >
                  Open Settings → AI
                </button>
              </div>
            )}
            {!messages.length && !disabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="assist-welcome">
                <BoardAiAvatar provider={b?.provider} size={38} />
                <div style={{ fontSize: 17, fontWeight: 700 }}>
                  Ask about{' '}
                  {scope === 'ticket' && ctx.ticketId
                    ? ctx.ticketId
                    : scope === 'all'
                      ? 'your projects'
                      : ctx.projectName}
                </div>
                <div className="ai-hint" style={{ fontSize: 13 }}>
                  I read tickets, comments and docs you can see, and propose changes as drafts. I never change anything
                  until you press Apply.
                </div>
                {state && state.ticketCount === 0 ? (
                  <div className="as-tile" data-testid="assist-empty-board">
                    <div className="as-tile-title">Nothing to analyse yet</div>
                    <div className="ai-hint">This project has no tickets. Chat can still help you start.</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="ai-btn ai-btn-primary ai-btn-sm"
                        onClick={() => void send('Suggest a first ticket for this project and draft it.')}
                      >
                        Draft first ticket with AI
                      </button>
                      <button type="button" className="ai-btn ai-btn-sm" onClick={ctx.close}>
                        Skip
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="as-label">Try asking</div>
                    {(scope === 'ticket'
                      ? ['Summarise this ticket', 'What is left to do here?', 'Who should review this?']
                      : SUGGESTIONS
                    ).map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="as-action"
                        style={{ justifyContent: 'flex-start' }}
                        onClick={() => void send(s)}
                      >
                        💬 {s}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
            {chat.data &&
              messages.map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className="as-user">
                    {m.text}
                  </div>
                ) : (
                  <AnswerBlock key={m.id} msg={m} chat={chat.data!} state={state} onSend={(t, o) => void send(t, o)} />
                ),
              )}
          </div>
          <div className="as-composer">
            {overBudget ? (
              <div className="as-composer-box" style={{ background: '#F6F7F7' }} data-testid="assist-composer-paused">
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#5B6B60' }}>Chat is paused</div>
                  <div className="ai-muted">Over budget. Nothing was sent to the provider.</div>
                </div>
              </div>
            ) : (
              <div className="as-composer-box">
                <textarea
                  rows={1}
                  value={text}
                  placeholder={placeholder}
                  disabled={disabled}
                  aria-label="Ask the Board AI"
                  data-testid="assist-input"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send(text);
                    }
                  }}
                />
                <button
                  type="button"
                  className="as-send"
                  disabled={disabled || sending || !text.trim()}
                  aria-label="Send"
                  onClick={() => void send(text)}
                >
                  ➤
                </button>
              </div>
            )}
            {error && (
              <div className="ai-error-text" style={{ marginTop: 6 }}>
                {error}
              </div>
            )}
            <div className="as-foot">
              🛡{' '}
              {scope === 'doc'
                ? 'Only this page and linked tickets are sent.'
                : 'AI proposes · you apply. Answers can be wrong.'}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
