import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  addThread,
  canvasFailure,
  canvasKeys,
  canvasMarkdown,
  deleteComment,
  proposeFixFromThread,
  replyThread,
  setThreadStatus,
  type CanvasBoard,
  type CanvasThread,
} from '../../api/canvases';
import { actorInitials, actorName, relativeTime } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { CanvasIcon } from './CanvasIcon';
import styles from './Canvas.module.css';

export type CommentFilter = 'open' | 'resolved' | 'board' | 'mine' | 'ai';

interface Props {
  canvasId: string;
  title: string;
  threads: CanvasThread[];
  boards: CanvasBoard[];
  /** The board whose threads "Only this board" keeps. */
  boardId: string | null;
  selectedThread: string | null;
  onSelectThread: (id: string | null) => void;
  canComment: boolean;
  /** Who is looking, for "Only mine" and delete. */
  me: string;
  /** AI is available here, so "Propose a fix" is offered on an AI member's comment. */
  aiAvailable?: boolean;
  /** Called with the job once "Propose a fix" started. */
  onProposeStarted?: (jobId: string) => void;
  /** Start a new thread on the board in view (the large view has no pin tool). */
  newOnBoard?: boolean;
  filters?: CommentFilter[];
  dark?: boolean;
}

const LABEL: Record<CommentFilter, string> = {
  open: 'Open',
  resolved: 'Resolved',
  board: 'Only this board',
  mine: 'Only mine',
  ai: 'Written by AI',
};

/** Whether a thread passes the filters. Open is on by default; the others narrow it. */
export function filterThreads(threads: CanvasThread[], on: Set<CommentFilter>, boardId: string | null, me: string) {
  return threads.filter((t) => {
    if (on.has('open') && !on.has('resolved') && t.status !== 'open') return false;
    if (on.has('resolved') && !on.has('open') && t.status !== 'resolved') return false;
    if (on.has('board') && t.boardId !== boardId) return false;
    if (on.has('mine') && t.createdBy !== me && !t.comments.some((c) => c.author === me)) return false;
    if (on.has('ai') && !t.byAi) return false;
    return true;
  });
}

function mentioned(text: string) {
  return text.split(/(@[\w][\w.-]*(?: [A-Z][\w.-]*)?)/g).map((part, i) =>
    part.startsWith('@') ? (
      <span key={i} className={styles.mention}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/**
 * The Comments tab: every thread of the canvas with filters, reply, resolve and "Create ticket". Selecting a thread
 * selects its board and brings the pin forward on the plane.
 * @param props - Threads, the board in view, who is looking, and what may be done.
 */
export function CommentsPanel(props: Props) {
  const {
    canvasId,
    title,
    threads,
    boards,
    boardId,
    selectedThread,
    onSelectThread,
    canComment,
    me,
    filters,
    newOnBoard,
  } = props;
  const qc = useQueryClient();
  const toast = useToast();
  const [on, setOn] = useState<Set<CommentFilter>>(new Set(['open']));
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState<Record<string, string>>({});
  const shown = filterThreads(threads, on, boardId, me);
  const refresh = () => void qc.invalidateQueries({ queryKey: canvasKeys.threads(canvasId) });
  const nameOf = (id: string | null) => boards.find((b) => b.id === id)?.name ?? 'The plane';
  const toggle = (f: CommentFilter) =>
    setOn((cur) => {
      const next = new Set(cur);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      if (f === 'open' && next.has('open')) next.delete('resolved');
      if (f === 'resolved' && next.has('resolved')) next.delete('open');
      if (!next.has('open') && !next.has('resolved')) next.add('open');
      return next;
    });
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refresh();
    } catch (e) {
      toast.error('Comment failed', canvasFailure(e).message);
    }
  };
  const createTicket = async (t: CanvasThread) => {
    try {
      const { client } = await import('../../api/client');
      const first = t.comments[0]?.body ?? '';
      const proj = (await client.get<{ projectId: string | null }>(`/canvases/${canvasId}`)).data.projectId;
      if (!proj) throw new Error('This canvas is not in a project.');
      const r = await client.post<{ id: string; key?: string }>(`/projects/${proj}/tickets`, {
        title: first.replace(/\s+/g, ' ').slice(0, 80) || 'Canvas comment',
        description: `${first}\n\n${canvasMarkdown({ id: canvasId, title }, t.boardId ?? undefined)}`,
      });
      toast.success('Ticket created', r.data.key ?? r.data.id);
    } catch (e) {
      toast.error('Could not create the ticket', canvasFailure(e).message);
    }
  };

  return (
    <div data-testid="canvas-comments">
      <div className={styles.filters} role="group" aria-label="Filter comments">
        {(filters ?? (['open', 'resolved', 'board', 'mine', 'ai'] as CommentFilter[])).map((f) => (
          <button
            key={f}
            type="button"
            className={`${styles.filter} ${on.has(f) ? styles.filterOn : ''}`}
            aria-pressed={on.has(f)}
            onClick={() => toggle(f)}
          >
            {LABEL[f]}
          </button>
        ))}
      </div>
      {newOnBoard && canComment && (
        <div className={styles.thread}>
          <textarea
            className={styles.input}
            rows={2}
            placeholder={`Comment on “${nameOf(boardId)}”… Type @ to mention a person or an AI member`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            data-testid="canvas-new-comment"
          />
          <div className={styles.threadActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
              disabled={!draft.trim()}
              onClick={() =>
                void run(async () => {
                  await addThread(canvasId, { body: draft.trim(), boardId, x: 0.5, y: 0.5 });
                  setDraft('');
                })
              }
            >
              Comment
            </button>
          </div>
        </div>
      )}
      {!shown.length && <div className={styles.hint}>No comments here yet.</div>}
      {shown.map((t) => (
        <div
          key={t.id}
          className={`${styles.thread} ${selectedThread === t.id ? styles.threadOn : ''}`}
          onClick={() => onSelectThread(t.id)}
          data-testid="canvas-thread"
        >
          <div className={styles.threadHead}>
            <span
              className={`${styles.pin}`}
              style={{
                position: 'static',
                transform: 'none',
                background: t.status === 'resolved' ? '#9aa8a0' : t.byAi ? '#5b3aa6' : '#8a6a12',
              }}
            >
              {t.number}
            </span>
            <span>“{nameOf(t.boardId)}”</span>
            {t.status === 'resolved' && <span className={styles.hint}>Resolved</span>}
          </div>
          {t.comments.map((c) => (
            <div key={c.id} className={styles.comment}>
              <span className={`${styles.avatar} ${c.isAi ? styles.avatarAi : ''}`}>{actorInitials(c.author)}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div>
                  <span className={styles.commentName}>{actorName(c.author)}</span>
                  {c.isAi && (
                    <span
                      className={styles.chip}
                      style={{ marginLeft: 6, height: 18, background: '#efe8fb', color: '#5b3aa6' }}
                    >
                      AI
                    </span>
                  )}
                  <span className={styles.commentTime}>{relativeTime(c.createdAt)}</span>
                </div>
                <div className={styles.commentText}>{mentioned(c.body)}</div>
                {c.isAi && c.ai?.canPropose && props.aiAvailable && t.boardId && t.status === 'open' && (
                  <div className={styles.threadActions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnSm} ${styles.btnAi}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void run(async () => {
                          const job = await proposeFixFromThread(t.id);
                          props.onProposeStarted?.(job.id);
                        });
                      }}
                      data-testid="canvas-propose-fix"
                    >
                      <CanvasIcon name="spark" size={13} /> Propose a fix
                    </button>
                  </div>
                )}
                {c.author === me && t.comments[0]?.id === c.id && (
                  <button
                    type="button"
                    className={styles.iconBtn}
                    style={{ width: 22, height: 22 }}
                    aria-label="Delete thread"
                    onClick={(e) => {
                      e.stopPropagation();
                      void run(() => deleteComment(c.id));
                    }}
                  >
                    <CanvasIcon name="trash" size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
          {canComment && t.status === 'open' && (
            <input
              className={styles.input}
              placeholder="Reply…"
              value={reply[t.id] ?? ''}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setReply((r) => ({ ...r, [t.id]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (reply[t.id] ?? '').trim()) {
                  const body = reply[t.id].trim();
                  void run(async () => {
                    await replyThread(t.id, body);
                    setReply((r) => ({ ...r, [t.id]: '' }));
                  });
                }
              }}
            />
          )}
          <div className={styles.threadActions}>
            {canComment && (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSm}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void run(() => setThreadStatus(t.id, t.status === 'open' ? 'resolved' : 'open'));
                }}
              >
                {t.status === 'open' ? 'Resolve' : 'Reopen'}
              </button>
            )}
            {canComment && (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSm}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void createTicket(t);
                }}
              >
                Create ticket
              </button>
            )}
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={(e) => {
                e.stopPropagation();
                void navigator.clipboard
                  ?.writeText(canvasMarkdown({ id: canvasId, title }, t.boardId ?? undefined))
                  .then(() => toast.success('Link copied'));
              }}
            >
              Copy link
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
