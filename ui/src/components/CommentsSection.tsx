import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Comment, Member } from '../types/ticket';
import { useToast } from './Toast';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Composer } from './comments/Composer';
import { AiAvatar, fmtElapsed, useAiBoardState } from './ai/aiUi';
import { useTicketRuns } from '../api/ai';
import { ASK_AI_EVENT } from './ai/AiTicketContext';
import { useAiSuggest } from './ai/useMentionList';
import type { SendOpts } from './ai/MentionIntent';
import {
  AnswerFooter,
  AnswerTransitions,
  AskErrorCard,
  AskPlaceholder,
  ThreadChip,
  askRunOf,
  didNotStart,
  type ThreadState,
} from './ai/AiThread';
import type { AiRun } from '../types/ai';

const AI_KIND: Record<string, string> = {
  summary: 'AI summary',
  failed: 'Run failed',
  chat_answer: 'From chat',
};
import { Icon } from './docs/Icon';
import type { SuggestMember } from './docs/RefSuggester';
import { getAvatarColors } from './MemberAvatar';
import { CommentAiFlag } from './ai/AiTicketSafety';
import {
  UNDO_MS,
  exactTime,
  personFor,
  queueKey,
  readJson,
  relative,
  writeJson,
  type Person,
  type QueuedComment,
} from './comments/commentUtils';

interface CommentsSectionProps {
  ticketId: string;
  projectId: string;
  comments: Comment[];
  members?: Member[];
  currentMember?: Member | null;
  reporterId?: string | null;
  assigneeId?: string | null;
  /** First load of the ticket still running. */
  isLoading?: boolean;
  /** A comment to scroll to and tint (from Activity "View comment" or a #comment-id link). */
  focusCommentId?: string | null;
  onFocusHandled?: () => void;
  /** Acceptance criteria of the ticket (the “Context sent” chips of the Ask button). */
  criteriaCount?: number;
  /** Resolve with the saved comment id, reject when the server could not be reached. */
  onAdd: (text: string, opts?: SendOpts) => Promise<unknown>;
  onEdit: (id: string, text: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onRestore: (id: string) => Promise<unknown>;
}

interface Ghost {
  comment: Comment;
  index: number;
}
interface Failed {
  id: string;
  text: string;
  at: string;
  opts?: SendOpts;
}

const COLLAPSE_CHARS = 1200;
const COLLAPSE_LINES = 8;
const THREAD_COLLAPSE_OVER = 6;
const TAIL = 4;

const STYLE = `
.cm-row:hover .cm-bar, .cm-row:focus-within .cm-bar { opacity: 1; }
.cm-time { border-bottom: 1px dotted #9AA8A0; cursor: default; position: relative; }
.cm-time .cm-tt { display: none; position: absolute; left: 0; bottom: calc(100% + 6px); background: #1E2A22; color: #fff; font-size: 12px; font-weight: 500; padding: 6px 10px; border-radius: 6px; white-space: nowrap; z-index: 20; box-shadow: 0 4px 14px rgba(30,42,34,.28); }
.cm-time:hover .cm-tt { display: block; }
.cm-tint { animation: cm-tint 2.2s ease-out; }
@keyframes cm-tint { 0%, 70% { background: #E4F1E8; } 100% { background: transparent; } }
.mc-bar { animation: cm-load 1.1s ease-in-out infinite alternate; }
@keyframes cm-load { from { width: 25%; } to { width: 85%; } }
.cm-sk { background: linear-gradient(90deg,#EEF3EF,#F6FAF7,#EEF3EF); background-size: 200% 100%; animation: cm-sk 1.2s linear infinite; border-radius: 6px; }
@keyframes cm-sk { to { background-position: -200% 0; } }
.cm-sort-btn:hover { background: #F6FAF7; border-color: #C7D2CB; color: #1E2A22; }
`;

function Avatar({ person, dashed }: { person: Person; dashed?: boolean }) {
  return (
    <div
      title={person.name}
      style={{
        width: 28,
        height: 28,
        borderRadius: '50%',
        background: person.bg,
        color: person.color,
        fontSize: 11,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        userSelect: 'none',
        opacity: dashed ? 0.7 : 1,
      }}
    >
      {person.initials}
    </div>
  );
}

function Collapsible({ text }: { text: string }) {
  const long = text.length > COLLAPSE_CHARS || text.split('\n').length > COLLAPSE_LINES;
  const [open, setOpen] = useState(false);
  if (!long) return <MarkdownRenderer>{text}</MarkdownRenderer>;
  return (
    <div>
      <div style={{ position: 'relative', maxHeight: open ? undefined : 190, overflow: 'hidden' }}>
        <MarkdownRenderer>{text}</MarkdownRenderer>
        {!open && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: 48,
              background: 'linear-gradient(rgba(255,255,255,0),#FFFFFF)',
            }}
          />
        )}
      </div>
      <button
        type="button"
        data-testid="comment-show-more"
        onClick={() => setOpen((o) => !o)}
        style={{
          border: 'none',
          background: 'none',
          padding: '4px 0 0',
          cursor: 'pointer',
          color: '#2E6F40',
          fontWeight: 700,
          fontSize: 12.5,
          fontFamily: 'inherit',
        }}
      >
        {open ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
}

const barBtn = (danger?: boolean, on?: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 9px',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  background: on ? '#FBE7E4' : 'none',
  color: danger ? '#C4432A' : '#3A4A3E',
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 600,
});

/**
 * Comment thread with composer, mentions, edit, delete and undo.
 * @param props.currentMember - Member the new comments are written as.
 * @param props.reporterId - Ticket reporter member id, used for author badges.
 * @param props.assigneeId - Ticket assignee member id, used for author badges.
 * @param props.isLoading - First load of the ticket is still running.
 * @param props.focusCommentId - Comment to scroll to and tint (from "View comment" or a `#comment-id` link).
 * @param props.onFocusHandled - Called once the focused comment has been scrolled to.
 * @param props.onAdd - Called with the text; resolves when saved, rejects if the server could not be reached.
 * @param props.onEdit - Called with the comment id and new text; same promise contract as `onAdd`.
 * @param props.onDelete - Called with the comment id to delete (undoable via `onRestore`).
 * @param props.onRestore - Called with the id of a deleted comment to restore.
 */
export function CommentsSection({
  ticketId,
  projectId,
  comments,
  members = [],
  currentMember,
  reporterId,
  assigneeId,
  isLoading = false,
  focusCommentId,
  onFocusHandled,
  criteriaCount = 0,
  onAdd,
  onEdit,
  onDelete,
  onRestore,
}: CommentsSectionProps) {
  const toast = useToast();
  const { members: aiMembers } = useAiBoardState();
  const aiRunsData = useTicketRuns(ticketId).data;
  const aiRuns: AiRun[] = useMemo(() => aiRunsData ?? [], [aiRunsData]);
  const rootRef = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  // A mention put in the box by Ask on a hover card, or the AI comment the next comment replies to
  const [prefill, setPrefill] = useState<string | undefined>(undefined);
  const [replyTo, setReplyTo] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [failed, setFailed] = useState<Failed[]>([]);
  const [queue, setQueue] = useState<QueuedComment[]>(() => readJson<QueuedComment[]>(queueKey(ticketId), []));
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [expandedMiddle, setExpandedMiddle] = useState(false);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>(() => {
    try {
      const saved = localStorage.getItem('kanban.comments.sortOrder');
      if (saved === 'oldest' || saved === 'newest') return saved;
    } catch {
      // ignore
    }
    return 'newest';
  });

  const me = useMemo<Person>(
    () =>
      currentMember
        ? personFor(currentMember.name, members.length ? members : [currentMember])
        : { name: 'You', initials: 'ME', bg: '#DCEEE1', color: '#2E6F40' },
    [currentMember, members],
  );
  const isMine = (c: Comment) =>
    c.author === 'user' || (!!currentMember && (c.author === currentMember.name || c.author === currentMember.id));
  const author = currentMember?.name ?? 'user';

  const aiRows = useAiSuggest();
  const aiAssignee = assigneeId && aiMembers.get(assigneeId)?.kind === 'ai' ? assigneeId : null;
  const suggestMembers = useMemo<SuggestMember[]>(() => {
    const people = members.filter((m) => (m.kind ?? 'human') === 'human');
    const onTicket = new Map<string, string>();
    if (assigneeId) onTicket.set(assigneeId, 'Assignee');
    if (reporterId && !onTicket.has(reporterId)) onTicket.set(reporterId, 'Reporter');
    for (const c of comments) {
      const m = people.find((x) => x.id === c.author || x.name.toLowerCase() === c.author.toLowerCase());
      if (m && !onTicket.has(m.id)) onTicket.set(m.id, 'Commented');
    }
    const row = (m: Member, group: string, note: string): SuggestMember => ({
      id: m.id,
      name: m.name,
      group,
      note,
      ...getAvatarColors(m.color),
    });
    // With AI members in the project the list reads People / AI; without, the people keep their own groups
    const withAi = aiRows.length > 0;
    const first = [...onTicket.entries()].flatMap(([id, note]) => {
      const m = people.find((x) => x.id === id);
      return m ? [row(m, withAi ? 'People' : 'On this ticket', note)] : [];
    });
    const rest = people
      .filter((m) => !onTicket.has(m.id))
      .map((m) => row(m, withAi ? 'People' : 'Everyone else', m.id === currentMember?.id ? 'You' : ''));
    return [...first, ...rest, ...aiRows];
  }, [members, comments, assigneeId, reporterId, currentMember, aiRows]);

  // ---- offline queue -----------------------------------------------------
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  const saveQueue = useCallback(
    (q: QueuedComment[]) => {
      setQueue(q);
      writeJson(queueKey(ticketId), q);
    },
    [ticketId],
  );
  const flushing = useRef(false);
  useEffect(() => {
    if (!online || queue.length === 0 || flushing.current) return;
    flushing.current = true;
    (async () => {
      let rest = [...queue];
      for (const item of queue) {
        try {
          await onAdd(item.text);
          rest = rest.filter((q) => q.id !== item.id);
          saveQueue(rest);
        } catch {
          break;
        }
      }
      flushing.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, queue.length]);

  // ---- sending -----------------------------------------------------------
  async function send(text: string, opts?: SendOpts, retryId?: string) {
    if (!online) {
      saveQueue([...queue, { id: `q-${Date.now()}`, text, author, at: new Date().toISOString() }]);
      closeComposer();
      return;
    }
    try {
      await onAdd(text, opts);
      if (retryId) setFailed((f) => f.filter((x) => x.id !== retryId));
      closeComposer();
    } catch {
      closeComposer();
      setFailed((f) => [
        ...f.filter((x) => x.id !== retryId),
        { id: retryId ?? `f-${Date.now()}`, text, at: new Date().toISOString(), opts },
      ]);
    }
  }
  function closeComposer() {
    setComposing(false);
    setPrefill(undefined);
    setReplyTo(undefined);
  }
  // Ask on an AI's hover card: open the box with its mention in it
  useEffect(() => {
    const onAsk = (e: Event) => {
      const d = (e as CustomEvent<{ ticketId: string; memberId: string }>).detail;
      const ai = d && d.ticketId === ticketId ? aiMembers.get(d.memberId) : undefined;
      if (!ai) return;
      setReplyTo(undefined);
      setPrefill(`@[${ai.name}](member:${ai.id}) `);
      setComposing(true);
      requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    };
    window.addEventListener(ASK_AI_EVENT, onAsk);
    return () => window.removeEventListener(ASK_AI_EVENT, onAsk);
  }, [ticketId, aiMembers]);
  const composerAi = {
    criteriaCount,
    commentCount: comments.length,
    defaultAskId: aiAssignee,
    prefill,
    replyTo,
    replyLabel: replyTo ? comments.find((x) => x.id === replyTo)?.author : undefined,
  };

  // ---- delete with 10 s undo ---------------------------------------------
  async function remove(c: Comment, index: number) {
    setConfirmId(null);
    setGhosts((g) => [...g, { comment: c, index }]);
    try {
      await onDelete(c.id);
    } catch {
      setGhosts((g) => g.filter((x) => x.comment.id !== c.id));
      toast.error("Couldn't delete the comment");
      return;
    }
    let done = false;
    const drop = () => setGhosts((g) => g.filter((x) => x.comment.id !== c.id));
    const undo = async () => {
      if (done) return;
      done = true;
      drop();
      try {
        await onRestore(c.id);
      } catch {
        toast.error("Couldn't restore the comment");
      }
    };
    setUndoFns((m) => ({ ...m, [c.id]: undo }));
    toast.success('Comment deleted', `Your comment on ${ticketId} was removed.`, UNDO_MS, {
      label: 'Undo',
      onClick: () => void undo(),
    });
    setTimeout(() => {
      done = true;
      drop();
    }, UNDO_MS);
  }
  const [undoFns, setUndoFns] = useState<Record<string, () => void>>({});

  // ---- deep link / focus ---------------------------------------------------
  useEffect(() => {
    const hashId = window.location.hash.startsWith('#comment-') ? window.location.hash.slice(9) : null;
    const id = focusCommentId ?? hashId;
    if (!id) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(id)}"]`);
    if (!el) {
      if (focusCommentId) toast.info('That comment was deleted');
      onFocusHandled?.();
      return;
    }
    setExpandedMiddle(true);
    requestAnimationFrame(() => {
      const target = rootRef.current?.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(id)}"]`);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target?.classList.remove('cm-tint');
      void target?.offsetWidth;
      target?.classList.add('cm-tint');
      setTimeout(() => target?.classList.remove('cm-tint'), 2300);
    });
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCommentId, comments.length]);

  function copyLink(c: Comment) {
    const url = `${window.location.origin}${window.location.pathname}?ticket=${ticketId}#comment-${c.id}`;
    void navigator.clipboard?.writeText(url);
    toast.success('Link copied');
  }

  // ---- layout of the thread --------------------------------------------------
  const visible = useMemo(() => {
    const live: ({ kind: 'c'; c: Comment; i: number } | { kind: 'g'; g: Ghost } | { kind: 'p'; run: AiRun })[] =
      comments.map((c, i) => ({
        kind: 'c',
        c,
        i,
      }));
    for (const g of [...ghosts].sort((a, b) => a.index - b.index))
      live.splice(Math.min(g.index, live.length), 0, { kind: 'g', g });
    // the state of a run a comment started shows right under that comment: queued, reading, needs your OK, did not
    // start, and (for a work run) ready for review (design C3)
    aiRuns.forEach((r, i) => {
      const active = ['queued', 'starting', 'running'].includes(r.state);
      const show =
        active ||
        (r.mode === 'work' && didNotStart(r)) ||
        (r.mode === 'work' && r.state === 'finished' && i === 0 && !!r.sourceCommentId);
      if (!show) return;
      if (!active && !r.sourceCommentId) return;
      const at = live.findIndex((x) => x.kind === 'c' && x.c.id === r.sourceCommentId);
      if (at < 0 && !active) return;
      live.splice(at >= 0 ? at + 1 : live.length, 0, { kind: 'p', run: r });
    });
    if (sortOrder === 'newest') {
      live.reverse();
    }
    return live;
  }, [comments, ghosts, sortOrder, aiRuns]);
  const collapseMiddle = !expandedMiddle && comments.length > THREAD_COLLAPSE_OVER;
  const hiddenCount = collapseMiddle ? comments.length - 1 - TAIL : 0;

  function renderComment(c: Comment, index: number) {
    const p = personFor(c.author, members);
    const authorMember = members.find((m) => m.id === p.id);
    const aiAuthor = authorMember ? aiMembers.get(authorMember.id) : undefined;
    const mine = isMine(c);
    // where this comment stands in an ask thread: the question, the answer, an error, a reply that asks again
    const asked = askRunOf(c, aiRuns);
    const threadState: { state: ThreadState; label?: string } | null =
      c.ai?.kind === 'answer'
        ? { state: 'answered' }
        : c.ai?.kind === 'ask_failed'
          ? { state: 'error' }
          : c.ai?.kind === 'move_blocked'
            ? { state: 'blocked' }
            : c.asksAgain
              ? { state: 'asks_again' }
              : c.answerToRun
                ? { state: 'answer' }
                : asked
                  ? { state: 'asked', label: `Asked ${asked.memberName ?? 'AI'}` }
                  : null;
    if (editingId === c.id) {
      return (
        <div key={c.id} data-comment-id={c.id} style={{ padding: '6px 0' }}>
          <Composer
            ticketId={ticketId}
            projectId={projectId}
            me={p}
            members={suggestMembers}
            initial={c.text}
            editing
            onCancel={() => setEditingId(null)}
            onSubmit={(t) => {
              setEditingId(null);
              if (t !== c.text) void onEdit(c.id, t).catch(() => toast.error("Couldn't save the comment"));
            }}
          />
        </div>
      );
    }
    return (
      <div
        key={c.id}
        className="cm-row"
        data-comment-id={c.id}
        data-testid="comment"
        style={{
          position: 'relative',
          display: 'flex',
          gap: 12,
          alignItems: 'flex-start',
          padding: '8px 10px',
          margin: '0 -10px',
          borderRadius: 10,
        }}
      >
        {aiAuthor ? (
          <AiAvatar
            provider={aiAuthor.provider}
            color={aiAuthor.color}
            glyph={aiAuthor.glyph}
            size={32}
            title={aiAuthor.name}
          />
        ) : (
          <Avatar person={p} />
        )}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>{p.name}</span>
            {(aiAuthor || c.ai) && (
              <span
                className="ai-chip"
                style={{ height: 18, background: '#1E2A22', color: '#fff', alignSelf: 'center' }}
              >
                AI
              </span>
            )}
            {c.ai && AI_KIND[c.ai.kind] && (
              <span
                className="ai-chip"
                style={{
                  height: 18,
                  background: c.ai.kind === 'failed' ? '#FBEEEA' : '#F1F8F3',
                  color: c.ai.kind === 'failed' ? '#C4432A' : '#2E6F40',
                  alignSelf: 'center',
                }}
              >
                {AI_KIND[c.ai.kind]}
              </span>
            )}
            {threadState && (
              <span style={{ marginLeft: 'auto', alignSelf: 'center' }}>
                <ThreadChip state={threadState.state} label={threadState.label} />
              </span>
            )}
            {c.boardNote && (
              <span
                className="ai-chip"
                style={{ height: 18, background: '#EEF1EE', color: '#5B6B60', alignSelf: 'center' }}
              >
                Board
              </span>
            )}
            <span
              className="cm-time"
              style={{ fontSize: 12, color: '#9AA8A0', marginLeft: threadState ? 0 : undefined }}
            >
              {relative(c.at)}
              <span className="cm-tt">{exactTime(c.at)}</span>
            </span>
            {c.editedAt && (
              <span data-testid="comment-edited" style={{ fontSize: 12, color: '#9AA8A0' }}>
                · edited
              </span>
            )}
          </div>
          {c.ai?.kind === 'ask_failed' ? (
            <AskErrorCard
              comment={c}
              run={aiRuns.find((r) => r.id === c.ai?.runId)}
              onDismiss={() => void remove(c, index)}
            />
          ) : (
            <div style={{ fontSize: 14, lineHeight: 1.65, color: '#3A4A3E' }}>
              <Collapsible text={c.text} />
            </div>
          )}
          {c.ai?.kind === 'answer' && (
            <AnswerFooter
              comment={c}
              run={aiRuns.find((r) => r.id === c.ai?.runId)}
              canAct
              onReply={() => {
                setPrefill(undefined);
                setReplyTo(c.id);
                setComposing(true);
                requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
              }}
            />
          )}
          {c.ai?.kind === 'chat_answer' && (
            <div className="ai-muted" style={{ display: 'flex', gap: 8 }} data-testid="chat-answer-meta">
              <span>Answer from the AI chat · asked by {c.ai.askedBy ?? 'a teammate'}</span>
              <span>· {c.ai.metered ? `$${(c.ai.costUsd ?? 0).toFixed(2)}` : 'Not metered'}</span>
              {c.ai.model && <span className="ai-mono">· {c.ai.model}</span>}
            </div>
          )}
          <CommentAiFlag ticketId={ticketId} commentId={c.id} />
          {c.answerToRun && <AnswerTransitions run={aiRuns.find((r) => r.id === c.answerToRun)} />}
          {c.ai?.runNumber && c.ai.kind !== 'answer' && c.ai.kind !== 'ask_failed' && c.ai.kind !== 'chat_answer' && (
            <div
              className="ai-muted"
              style={{ display: 'flex', gap: 8, alignItems: 'center' }}
              data-testid="ai-comment-meta"
            >
              <span>Run #{c.ai.runNumber}</span>
              {c.ai.durationS != null && <span>· {fmtElapsed(c.ai.durationS)}</span>}
              <span>· {c.ai.metered ? `$${(c.ai.costUsd ?? 0).toFixed(2)}` : 'Not metered'}</span>
              {c.ai.model && <span className="ai-mono">· {c.ai.model}</span>}
            </div>
          )}
          {confirmId === c.id && (
            <div
              data-testid="comment-delete-confirm"
              style={{
                marginTop: 8,
                border: '1px solid #F0C4B8',
                background: '#FDF3F0',
                borderRadius: 8,
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: '#A5321E' }}>Delete this comment?</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#5B6B60' }}>
                It disappears for everyone on this ticket. You get 10 seconds to undo it. Mentions already sent stay
                sent.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="st-btn st-btn-sm" onClick={() => setConfirmId(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="st-btn st-btn-danger st-btn-sm"
                  data-testid="comment-delete-confirm-yes"
                  onClick={() => void remove(c, index)}
                >
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
        <div
          className="cm-bar"
          style={{
            position: 'absolute',
            right: 8,
            top: -14,
            opacity: confirmId === c.id ? 1 : 0,
            transition: 'opacity .12s',
            display: 'flex',
            gap: 2,
            background: '#FFFFFF',
            border: '1px solid #E3E8E5',
            borderRadius: 8,
            padding: 3,
            boxShadow: '0 4px 14px rgba(30,42,34,0.12)',
            zIndex: 2,
          }}
        >
          {mine && (
            <>
              <button
                type="button"
                data-testid="comment-edit"
                style={barBtn()}
                onClick={() => {
                  setEditingId(c.id);
                  setConfirmId(null);
                }}
              >
                <Icon name="i26" size={13} strokeWidth={1.9} />
                Edit
              </button>
              <button
                type="button"
                data-testid="comment-delete"
                style={barBtn(true, confirmId === c.id)}
                onClick={() => setConfirmId(confirmId === c.id ? null : c.id)}
              >
                <Icon name="i12" size={13} strokeWidth={1.9} />
                Delete
              </button>
            </>
          )}
          {c.ai?.kind === 'answer' && (
            <button
              type="button"
              data-testid="comment-reply"
              style={barBtn()}
              title="Replying asks this AI again"
              onClick={() => {
                setPrefill(undefined);
                setReplyTo(c.id);
                setComposing(true);
                requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
              }}
            >
              ↩ Reply
            </button>
          )}
          <button type="button" data-testid="comment-copy-link" style={barBtn()} onClick={() => copyLink(c)}>
            <Icon name="link" size={13} strokeWidth={1.9} />
            Copy link
          </button>
        </div>
      </div>
    );
  }

  const rows: React.ReactNode[] = [];
  let shownDivider = false;
  visible.forEach((it, idx) => {
    if (it.kind === 'g') {
      rows.push(
        <div
          key={`g-${it.g.comment.id}`}
          data-testid="comment-deleted-rule"
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', color: '#9AA8A0', fontSize: 12.5 }}
        >
          <span style={{ flex: 1, height: 1, background: '#E3E8E5' }} />
          Comment deleted ·
          <button
            type="button"
            data-testid="comment-undo"
            onClick={() => undoFns[it.g.comment.id]?.()}
            style={{
              border: 'none',
              background: 'none',
              padding: 0,
              cursor: 'pointer',
              color: '#2E6F40',
              fontWeight: 700,
              fontFamily: 'inherit',
              fontSize: 12.5,
            }}
          >
            Undo
          </button>
          <span style={{ flex: 1, height: 1, background: '#E3E8E5' }} />
        </div>,
      );
      return;
    }
    if (it.kind === 'p') {
      rows.push(<AskPlaceholder key={`ask-${it.run.id}`} run={it.run} />);
      return;
    }
    const { c, i } = it;
    const isCollapsed =
      collapseMiddle &&
      (sortOrder === 'newest' ? idx >= TAIL && idx < visible.length - 1 : idx > 0 && idx < visible.length - TAIL);

    if (isCollapsed) {
      if (!shownDivider) {
        shownDivider = true;
        rows.push(
          <button
            key="more"
            type="button"
            data-testid="comments-show-older"
            onClick={() => setExpandedMiddle(true)}
            style={{
              alignSelf: 'flex-start',
              border: '1px dashed #C7D2CB',
              background: '#FBFCFB',
              borderRadius: 8,
              padding: '7px 14px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12.5,
              fontWeight: 600,
              color: '#2E6F40',
            }}
          >
            Show {hiddenCount} older comments
          </button>,
        );
      }
      return;
    }
    rows.push(renderComment(c, i));
  });

  return (
    <div
      ref={rootRef}
      data-testid="comments"
      data-idea-source={JSON.stringify({ source: 'comment', id: ticketId, label: ticketId })}
      id="comments"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        paddingTop: 14,
        paddingBottom: 28,
        borderTop: '1px solid #EEF3EF',
      }}
    >
      <style>{STYLE}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color: '#5B6B60',
            textTransform: 'uppercase',
          }}
        >
          Comments
        </span>
        <span
          data-testid="comments-count"
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            color: '#5B6B60',
            background: '#EEF1EE',
            borderRadius: 999,
            padding: '1px 8px',
          }}
        >
          {isLoading ? '…' : comments.length}
        </span>
        <button
          type="button"
          data-testid="comments-sort-order"
          onClick={() => {
            const next = sortOrder === 'newest' ? 'oldest' : 'newest';
            setSortOrder(next);
            try {
              localStorage.setItem('kanban.comments.sortOrder', next);
            } catch {
              // ignore
            }
          }}
          className="cm-sort-btn"
          style={{
            marginLeft: 'auto',
            border: '1px solid #DCE3DF',
            background: '#FFFFFF',
            borderRadius: 6,
            padding: '3px 8px',
            fontSize: 12,
            fontWeight: 600,
            color: '#435348',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontFamily: 'inherit',
            transition: 'all 0.15s ease',
          }}
          title={`Currently ${sortOrder === 'newest' ? 'newest first' : 'oldest first'}. Click to toggle.`}
        >
          <span style={{ color: '#2E6F40', fontSize: 13, lineHeight: 1 }}>⇅</span>
          <span>{sortOrder === 'newest' ? 'Newest first' : 'Oldest first'}</span>
        </button>
      </div>

      {isLoading ? (
        <div data-testid="comments-loading" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {[1, 2].map((n) => (
            <div key={n} style={{ display: 'flex', gap: 12 }}>
              <div className="cm-sk" style={{ width: 28, height: 28, borderRadius: '50%' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                <div className="cm-sk" style={{ width: 140, height: 12 }} />
                <div className="cm-sk" style={{ width: `${60 + n * 12}%`, height: 12 }} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {!online && (
            <div
              data-testid="comments-offline"
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                background: '#FEF6E7',
                border: '1px solid #F0DBA8',
                borderRadius: 8,
                padding: '8px 12px',
                fontSize: 12.5,
                color: '#7A4F08',
              }}
            >
              <b>You are offline.</b> Comments are saved here and sent when the connection returns.
            </div>
          )}

          {sortOrder === 'newest' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {composing ? (
                <Composer
                  key={`${replyTo ?? ''}:${prefill ?? ''}`}
                  ticketId={ticketId}
                  projectId={projectId}
                  me={me}
                  members={suggestMembers}
                  onCancel={closeComposer}
                  onSubmit={(t, o) => void send(t, o)}
                  {...composerAi}
                />
              ) : (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <Avatar person={me} />
                  <button
                    type="button"
                    data-testid="comment-collapsed"
                    onClick={() => setComposing(true)}
                    onFocus={() => setComposing(true)}
                    style={{
                      flex: 1,
                      textAlign: 'left',
                      border: '1px solid #E3E8E5',
                      borderRadius: 8,
                      background: '#FFFFFF',
                      padding: '9px 14px',
                      fontFamily: 'inherit',
                      fontSize: 14,
                      color: '#6B7A70',
                      cursor: 'text',
                    }}
                  >
                    Add a comment…
                  </button>
                </div>
              )}
              {queue.map((q) => (
                <div
                  key={q.id}
                  data-testid="comment-queued"
                  style={{
                    display: 'flex',
                    gap: 12,
                    border: '1px dashed #C7D2CB',
                    borderRadius: 10,
                    padding: '8px 12px',
                    margin: '0 -2px',
                    background: '#FBFCFB',
                  }}
                >
                  <Avatar person={me} dashed />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{me.name}</span>
                      <span style={{ fontSize: 12, color: '#9AA8A0' }}>Queued</span>
                    </div>
                    <div style={{ fontSize: 14, lineHeight: 1.65, color: '#3A4A3E' }}>
                      <MarkdownRenderer>{q.text}</MarkdownRenderer>
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                      <button
                        type="button"
                        onClick={() => {
                          saveQueue(queue.filter((x) => x.id !== q.id));
                          setComposing(true);
                          writeJson(`kanban.commentDraft.${ticketId}`, q.text);
                        }}
                        style={{
                          border: 'none',
                          background: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          color: '#2E6F40',
                          fontWeight: 700,
                          fontSize: 12.5,
                          fontFamily: 'inherit',
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        data-testid="comment-cancel-send"
                        onClick={() => saveQueue(queue.filter((x) => x.id !== q.id))}
                        style={{
                          border: 'none',
                          background: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          color: '#C4432A',
                          fontWeight: 700,
                          fontSize: 12.5,
                          fontFamily: 'inherit',
                        }}
                      >
                        Cancel send
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {failed.map((f) => (
                <div
                  key={f.id}
                  data-testid="comment-failed"
                  style={{
                    display: 'flex',
                    gap: 12,
                    border: '1px solid #F0C4B8',
                    borderRadius: 10,
                    padding: '8px 12px',
                    background: '#FDF3F0',
                  }}
                >
                  <Avatar person={me} />
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{me.name}</span>
                      <span style={{ fontSize: 12, color: '#C4432A', fontWeight: 600 }}>Not sent</span>
                    </div>
                    <div style={{ fontSize: 14, lineHeight: 1.65, color: '#3A4A3E' }}>
                      <MarkdownRenderer>{f.text}</MarkdownRenderer>
                    </div>
                    <div style={{ fontSize: 12.5, color: '#A5321E' }}>
                      Couldn't reach the server. Your text is kept; nothing was lost.
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="st-btn st-btn-primary st-btn-sm"
                        data-testid="comment-retry"
                        onClick={() => void send(f.text, f.opts, f.id)}
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        className="st-btn st-btn-sm"
                        onClick={() => {
                          setFailed((x) => x.filter((y) => y.id !== f.id));
                          writeJson(`kanban.commentDraft.${ticketId}`, f.text);
                          setComposing(true);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="st-btn st-btn-sm"
                        onClick={() => setFailed((x) => x.filter((y) => y.id !== f.id))}
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {comments.length === 0 && ghosts.length === 0 && queue.length === 0 && failed.length === 0 && (
            <div
              data-testid="comments-empty"
              style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0 4px' }}
            >
              <span style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>No comments yet</span>
              <span style={{ fontSize: 13, color: '#5B6B60' }}>
                Start the conversation. Type @ to mention a teammate or [[ to link a doc.
              </span>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows}
            {sortOrder === 'oldest' && (
              <>
                {queue.map((q) => (
                  <div
                    key={q.id}
                    data-testid="comment-queued"
                    style={{
                      display: 'flex',
                      gap: 12,
                      border: '1px dashed #C7D2CB',
                      borderRadius: 10,
                      padding: '8px 12px',
                      margin: '0 -2px',
                      background: '#FBFCFB',
                    }}
                  >
                    <Avatar person={me} dashed />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                        <span style={{ fontSize: 14, fontWeight: 700 }}>{me.name}</span>
                        <span style={{ fontSize: 12, color: '#9AA8A0' }}>Queued</span>
                      </div>
                      <div style={{ fontSize: 14, lineHeight: 1.65, color: '#3A4A3E' }}>
                        <MarkdownRenderer>{q.text}</MarkdownRenderer>
                      </div>
                      <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                        <button
                          type="button"
                          onClick={() => {
                            saveQueue(queue.filter((x) => x.id !== q.id));
                            setComposing(true);
                            writeJson(`kanban.commentDraft.${ticketId}`, q.text);
                          }}
                          style={{
                            border: 'none',
                            background: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            color: '#2E6F40',
                            fontWeight: 700,
                            fontSize: 12.5,
                            fontFamily: 'inherit',
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          data-testid="comment-cancel-send"
                          onClick={() => saveQueue(queue.filter((x) => x.id !== q.id))}
                          style={{
                            border: 'none',
                            background: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            color: '#C4432A',
                            fontWeight: 700,
                            fontSize: 12.5,
                            fontFamily: 'inherit',
                          }}
                        >
                          Cancel send
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {failed.map((f) => (
                  <div
                    key={f.id}
                    data-testid="comment-failed"
                    style={{
                      display: 'flex',
                      gap: 12,
                      border: '1px solid #F0C4B8',
                      borderRadius: 10,
                      padding: '8px 12px',
                      background: '#FDF3F0',
                    }}
                  >
                    <Avatar person={me} />
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                        <span style={{ fontSize: 14, fontWeight: 700 }}>{me.name}</span>
                        <span style={{ fontSize: 12, color: '#C4432A', fontWeight: 600 }}>Not sent</span>
                      </div>
                      <div style={{ fontSize: 14, lineHeight: 1.65, color: '#3A4A3E' }}>
                        <MarkdownRenderer>{f.text}</MarkdownRenderer>
                      </div>
                      <div style={{ fontSize: 12.5, color: '#A5321E' }}>
                        Couldn't reach the server. Your text is kept; nothing was lost.
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          type="button"
                          className="st-btn st-btn-primary st-btn-sm"
                          data-testid="comment-retry"
                          onClick={() => void send(f.text, f.opts, f.id)}
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          className="st-btn st-btn-sm"
                          onClick={() => {
                            setFailed((x) => x.filter((y) => y.id !== f.id));
                            writeJson(`kanban.commentDraft.${ticketId}`, f.text);
                            setComposing(true);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="st-btn st-btn-sm"
                          onClick={() => setFailed((x) => x.filter((y) => y.id !== f.id))}
                        >
                          Discard
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          {sortOrder === 'oldest' &&
            (composing ? (
              <Composer
                key={`${replyTo ?? ''}:${prefill ?? ''}`}
                ticketId={ticketId}
                projectId={projectId}
                me={me}
                members={suggestMembers}
                onCancel={closeComposer}
                onSubmit={(t, o) => void send(t, o)}
                {...composerAi}
              />
            ) : (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <Avatar person={me} />
                <button
                  type="button"
                  data-testid="comment-collapsed"
                  onClick={() => setComposing(true)}
                  onFocus={() => setComposing(true)}
                  style={{
                    flex: 1,
                    textAlign: 'left',
                    border: '1px solid #E3E8E5',
                    borderRadius: 8,
                    background: '#FFFFFF',
                    padding: '9px 14px',
                    fontFamily: 'inherit',
                    fontSize: 14,
                    color: '#6B7A70',
                    cursor: 'text',
                  }}
                >
                  Add a comment…
                </button>
              </div>
            ))}
        </>
      )}
    </div>
  );
}
