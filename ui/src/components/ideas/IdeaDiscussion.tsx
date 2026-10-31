import { useState } from 'react';
import { extractError } from '../../api/extractError';
import {
  ideaRuleError,
  useAddComment,
  useAddLogEntry,
  useDeleteComment,
  useDeleteLogEntry,
  useEditComment,
  useEditLogEntry,
  useIdeaActivity,
  useIdeaComments,
  useIdeaLog,
  useLogAsEvidence,
} from '../../api/ideas';
import type { Idea, IdeaActivityEntry, LogKind } from '../../types/idea';
import { LOG_KIND_LABELS } from '../../types/idea';
import { absoluteTime, relativeTime } from '../../utils/relativeTime';
import { lineDiffCounts } from '../../utils/lineDiff';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { Avatar, plural } from '../docs/docsShared';
import { useToast } from '../Toast';
import { AiChip } from './ideaShared';

const who = (a?: string | null) => (!a ? 'Someone' : a === 'user' ? 'You' : a === 'agent' ? 'AI agent' : a);

/** Comments on the idea page. */
export function IdeaComments({ idea, readOnly }: { idea: Idea; readOnly: boolean }) {
  const list = useIdeaComments(idea.id);
  const add = useAddComment();
  const edit = useEditComment();
  const del = useDeleteComment();
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const comments = list.data ?? [];

  async function post() {
    if (!body.trim()) return;
    try {
      await add.mutateAsync({ id: idea.id, body });
      setBody('');
      setError(null);
    } catch (e) {
      setError(extractError(e));
    }
  }

  return (
    <div data-testid="comments-tab" style={{ maxWidth: 720 }}>
      {comments.length === 0 && (
        <div className="is-empty">No comments yet. Say what you think; it stays on the idea.</div>
      )}
      {comments.map((c) => (
        <div key={c.id} className="is-comment">
          <Avatar name={c.author ?? '?'} size={26} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="is-comment-head">
              <b>{who(c.author)}</b> {c.ai && <AiChip />}
              <span className="is-muted" title={absoluteTime(c.createdAt)}>
                {relativeTime(c.createdAt)}
                {c.editedAt ? ' · edited' : ''}
              </span>
              <span className="is-grow" />
              {!readOnly && editing?.id !== c.id && (
                <>
                  <button
                    type="button"
                    className="is-btn is-btn-ghost is-btn-sm"
                    onClick={() => setEditing({ id: c.id, body: c.body })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="is-btn is-btn-ghost is-btn-sm"
                    onClick={() =>
                      window.confirm('Delete this comment?') && del.mutate({ id: idea.id, commentId: c.id })
                    }
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
            {editing?.id === c.id ? (
              <>
                <textarea
                  className="is-textarea"
                  rows={3}
                  value={editing.body}
                  onChange={(e) => setEditing({ id: c.id, body: e.target.value })}
                  aria-label="Edit comment"
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button
                    type="button"
                    className="is-btn is-btn-primary is-btn-sm"
                    onClick={async () => {
                      await edit.mutateAsync({ id: idea.id, commentId: c.id, body: editing.body });
                      setEditing(null);
                    }}
                  >
                    Save
                  </button>
                  <button type="button" className="is-btn is-btn-sm" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <MarkdownRenderer>{c.body}</MarkdownRenderer>
            )}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 14 }}>
        <textarea
          className="is-textarea"
          rows={3}
          value={body}
          aria-label="Write a comment"
          placeholder={idea.stage === 'shipped' ? 'Comments stay open after shipping.' : 'Write a comment…'}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && post()}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <button
            type="button"
            className="is-btn is-btn-primary"
            onClick={post}
            disabled={!body.trim() || add.isPending}
          >
            Comment
          </button>
          {error && <span className="is-muted">{error}</span>}
        </div>
      </div>
    </div>
  );
}

const LOG_KINDS = Object.keys(LOG_KIND_LABELS) as LogKind[];

/** The research log: what was found, tried and decided, in the order it happened. */
export function IdeaLog({ idea, readOnly, closed }: { idea: Idea; readOnly: boolean; closed: boolean }) {
  const toast = useToast();
  const list = useIdeaLog(idea.id);
  const add = useAddLogEntry();
  const edit = useEditLogEntry();
  const del = useDeleteLogEntry();
  const asEvidence = useLogAsEvidence();
  const [kind, setKind] = useState<LogKind>('note');
  const [body, setBody] = useState('');
  const [assumptionId, setAssumptionId] = useState('');
  const [filter, setFilter] = useState<LogKind | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const entries = (list.data ?? []).filter((e) => filter === 'all' || e.kind === filter);
  const counts = (list.data ?? []).reduce<Record<string, number>>(
    (m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }),
    {},
  );

  async function submit() {
    if (!body.trim()) return;
    try {
      await add.mutateAsync({ id: idea.id, kind, body, assumptionId: assumptionId || null });
      setBody('');
      setAssumptionId('');
      setError(null);
    } catch (e) {
      setError(ideaRuleError(e).message);
    }
  }

  return (
    <div data-testid="log-tab" style={{ maxWidth: 760 }}>
      <div className="is-muted" style={{ marginBottom: 10 }}>
        {plural((list.data ?? []).length, 'entry', 'entries')} · the story of exploring this idea
      </div>
      {closed ? (
        <div className="is-banner" style={{ marginBottom: 12 }}>
          The idea is closed. The log stays readable; adding entries is turned off. Reopen the idea to turn it back on.
        </div>
      ) : !readOnly ? (
        <div className="is-log-form">
          <div className="is-radio-row" style={{ marginBottom: 8 }}>
            {LOG_KINDS.map((k) => (
              <button key={k} type="button" className="is-choice" aria-pressed={kind === k} onClick={() => setKind(k)}>
                {LOG_KIND_LABELS[k]}
              </button>
            ))}
          </div>
          <textarea
            className="is-textarea"
            rows={3}
            value={body}
            aria-label="Log entry"
            placeholder="Write what you found, tried or decided… (markdown)"
            onChange={(e) => setBody(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              className="is-select"
              value={assumptionId}
              aria-label="Link to assumption"
              onChange={(e) => setAssumptionId(e.target.value)}
            >
              <option value="">Link to assumption…</option>
              {idea.assumptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.text.slice(0, 60)}
                </option>
              ))}
            </select>
            <span className="is-grow" />
            {error && <span className="is-muted">{error}</span>}
            <button
              type="button"
              className="is-btn is-btn-primary"
              onClick={submit}
              disabled={!body.trim() || add.isPending}
            >
              Add to log
            </button>
          </div>
        </div>
      ) : null}

      {(list.data ?? []).length > 0 && (
        <div className="is-filters" style={{ marginTop: 12 }}>
          <button type="button" className="is-chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            All <small>{(list.data ?? []).length}</small>
          </button>
          {LOG_KINDS.filter((k) => counts[k]).map((k) => (
            <button key={k} type="button" className="is-chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {LOG_KIND_LABELS[k]} <small>{counts[k]}</small>
            </button>
          ))}
        </div>
      )}

      {(list.data ?? []).length === 0 && (
        <div className="is-empty">
          <h3>Nothing logged yet</h3>
          <div>
            Write down what you find, try or decide while you explore. It is the memory of how the idea got here.
          </div>
        </div>
      )}

      <div className="is-timeline">
        {entries.map((e) => {
          const supports = idea.assumptions.find((a) => a.id === e.assumptionId);
          return (
            <article key={e.id} className={`is-log-entry ${e.pinned ? 'is-log-pinned' : ''}`} data-testid="log-entry">
              <div className="is-comment-head">
                <Avatar name={e.author ?? '?'} size={22} />
                <b>{who(e.author)}</b>
                {e.ai && <AiChip />}
                <span className={`is-tag is-log-${e.kind}`}>{LOG_KIND_LABELS[e.kind]}</span>
                {e.pinned && <span className="is-warn">Pinned</span>}
                <span className="is-muted">{relativeTime(e.createdAt)}</span>
                <span className="is-grow" />
                {!readOnly && !closed && (
                  <>
                    <button
                      type="button"
                      className="is-btn is-btn-ghost is-btn-sm"
                      onClick={() => edit.mutate({ id: idea.id, entryId: e.id, pinned: !e.pinned })}
                    >
                      {e.pinned ? 'Unpin' : 'Pin'}
                    </button>
                    <button
                      type="button"
                      className="is-btn is-btn-ghost is-btn-sm"
                      onClick={() =>
                        window.confirm('Delete this entry? It stays in Activity as “entry deleted”.') &&
                        del.mutate({ id: idea.id, entryId: e.id })
                      }
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
              <MarkdownRenderer>{e.body}</MarkdownRenderer>
              <div className="is-row-sub">
                {supports && <span>Supports: {supports.text}</span>}
                {e.ticketId && <span className="is-mono">Test ticket {e.ticketId}</span>}
                {!readOnly && !closed && e.kind === 'finding' && idea.assumptions.length > 0 && (
                  <select
                    className="is-select"
                    aria-label="Use as evidence"
                    value=""
                    onChange={(ev) =>
                      ev.target.value &&
                      asEvidence.mutate(
                        { id: idea.id, entryId: e.id, assumptionId: ev.target.value },
                        {
                          onSuccess: () => toast.success('Added as evidence'),
                          onError: (err) => toast.error('Could not add', ideaRuleError(err).message),
                        },
                      )
                    }
                  >
                    <option value="">Use as evidence…</option>
                    {idea.assumptions.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.text.slice(0, 60)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

const ACTIVITY_FILTERS: { id: string; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'stage', label: 'Stage' },
  { id: 'assumptions', label: 'Assumptions' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'page', label: 'Page text' },
  { id: 'ai', label: 'By AI' },
  { id: 'links', label: 'Project and links' },
];

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d
    .toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    })
    .toUpperCase();
}

function Diff({ entry }: { entry: IdeaActivityEntry }) {
  const [open, setOpen] = useState(false);
  const from = String(entry.meta?.from ?? '');
  const to = String(entry.meta?.to ?? '');
  if (entry.kind !== 'page' || (!from && !to)) return null;
  const { added, removed } = lineDiffCounts(from, to);
  return (
    <div>
      <button type="button" className="is-link" onClick={() => setOpen(!open)}>
        {open ? 'Hide changes' : `+${added} −${removed} · show changes`}
      </button>
      {open && (
        <pre className="is-diff">
          <span className="is-diff-del">{from}</span>
          {'\n'}
          <span className="is-diff-add">{to}</span>
        </pre>
      )}
    </div>
  );
}

/** Activity: who changed what, and when. Read-only, grouped by day, with filters. */
export function IdeaActivityTab({ idea }: { idea: Idea }) {
  const [filter, setFilter] = useState('all');
  const activity = useIdeaActivity(idea.id, filter === 'all' ? undefined : filter);
  const items = activity.data?.items ?? [];
  const counts = activity.data?.counts ?? {};
  const groups: { day: string; items: IdeaActivityEntry[] }[] = [];
  items.forEach((i) => {
    const day = dayLabel(i.at);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(i);
    else groups.push({ day, items: [i] });
  });

  return (
    <div data-testid="activity-tab" style={{ maxWidth: 760 }}>
      <div className="is-muted" style={{ marginBottom: 8 }}>
        {plural(counts.all ?? 0, 'change')} · {idea.id}
      </div>
      <div className="is-filters">
        {ACTIVITY_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className="is-chip"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label} {counts[f.id] ? <small>{counts[f.id]}</small> : null}
          </button>
        ))}
      </div>
      {items.length === 0 && (
        <div className="is-empty">
          <h3>No activity yet</h3>
          <div>Moves between stages, assumption changes, evidence and edits will show up here.</div>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.day}>
          <div className="is-label" style={{ margin: '14px 0 6px' }}>
            {g.day} · {plural(g.items.length, 'change')}
          </div>
          {g.items.map((i) => (
            <div key={i.id} className="is-activity-row">
              <Avatar name={i.author ?? '?'} size={22} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>
                  {i.label} {i.ai && <AiChip />}
                </div>
                <div className="is-muted">
                  {who(i.author)} · <span title={absoluteTime(i.at)}>{relativeTime(i.at)}</span>
                  {i.kind && <span> · {i.kind}</span>}
                </div>
                <Diff entry={i} />
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
