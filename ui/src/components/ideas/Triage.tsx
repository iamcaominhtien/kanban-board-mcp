import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ideaRuleError,
  useIdeaList,
  useParkMany,
  useSimilar,
  useTagSuggestions,
  useUndoIdeaMove,
  useEditIdeaPage,
} from '../../api/ideas';
import type { IdeaRow, IdeaScope } from '../../types/idea';
import { relativeTime } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { plural } from '../docs/docsShared';
import { AiChip, Kbd, StagePill, dateIn, sourceLine } from './ideaShared';
import { useIdeaMoves, type Decision } from './useIdeaMoves';
import { useIdeaCapture } from './IdeaCapture';
import { AdviceBar, AdviceCard } from './IdeaAiExtras';

interface Props {
  scope: IdeaScope;
  projectId?: string;
  onOpenIdea: (id: string) => void;
  onOpenTicket: (id: string) => void;
  onPromote: (idea: IdeaRow) => void;
  onBack: () => void;
  onOpenSettings?: () => void;
}

const WAITING_DAYS = 14;

/** Triage: a short list on the left, one idea in focus on the right, one key per decision. */
export function Triage({ scope, projectId, onOpenIdea, onOpenTicket, onPromote, onBack, onOpenSettings }: Props) {
  const toast = useToast();
  const capture = useIdeaCapture();
  const list = useIdeaList({ scope, projectId, stages: ['inbox'], sort: 'created' });
  const parkMany = useParkMany();
  const undo = useUndoIdeaMove();
  const edit = useEditIdeaPage();
  const [sorted, setSorted] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastMoved, setLastMoved] = useState<string | null>(null);

  const ideas = useMemo(() => list.data ?? [], [list.data]);
  const current = ideas.find((i) => i.id === selectedId) ?? ideas[0] ?? null;
  const index = current ? ideas.findIndex((i) => i.id === current.id) : -1;
  const waiting = ideas.filter((i) => Date.now() - new Date(i.createdAt).getTime() > WAITING_DAYS * 86400000);

  const moves = useIdeaMoves({
    onPromote: (i) => onPromote(i as IdeaRow),
    onChanged: (id) => {
      setSorted((n) => n + 1);
      setLastMoved(id);
      // the next idea opens after each decision
      const next = ideas[ideas.findIndex((i) => i.id === id) + 1] ?? ideas.find((i) => i.id !== id);
      setSelectedId(next?.id ?? null);
    },
  });

  const similar = useSimilar(current ? `${current.title} ${current.body || current.description}` : '', {
    exclude: current?.id,
    projectId: current?.projectId,
  }).data;
  const dup = similar?.find((s) => s.kind === 'idea' && s.score >= 0.4);
  const relatedTicket = similar?.find((s) => s.kind === 'ticket');
  const tagHints = (
    useTagSuggestions(current ? `${current.title} ${current.body}` : '', current?.id).data ?? []
  ).filter((t) => !current?.tags.includes(t));

  const decide = useCallback((d: Decision) => current && moves.decide(current, d), [current, moves]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('[role="dialog"]')) return;
      const k = e.key.toLowerCase();
      if (k === 'k') decide('keep');
      else if (k === 'p') decide('park');
      else if (k === 'm') decide('merge');
      else if (k === 'x') decide('archive');
      else if (k === 'z' && lastMoved) {
        undo.mutate(lastMoved, { onSuccess: () => toast.info('Undone') });
        setLastMoved(null);
        setSorted((n) => Math.max(0, n - 1));
      } else if (e.key === 'ArrowDown' && ideas.length) setSelectedId(ideas[Math.min(ideas.length - 1, index + 1)].id);
      else if (e.key === 'ArrowUp' && ideas.length) setSelectedId(ideas[Math.max(0, index - 1)].id);
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decide, ideas, index, lastMoved, undo, toast]);

  async function parkAll() {
    try {
      await parkMany.mutateAsync({ ids: waiting.map((i) => i.id), parkUntil: dateIn(30) });
      toast.success(`Parked ${plural(waiting.length, 'idea')} for a month`);
    } catch (e) {
      toast.error('Could not park them', ideaRuleError(e).message);
    }
  }

  if (list.isLoading) return <div className="is-empty">Loading the Inbox…</div>;

  if (!current) {
    return (
      <div className="is-body">
        <div className="is-empty" data-testid="inbox-empty">
          <h3>Inbox is empty</h3>
          <div>
            {sorted > 0 ? `You sorted ${plural(sorted, 'idea')} in this pass.` : 'Nothing is waiting to be sorted.'}
          </div>
          <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button
              type="button"
              className="is-btn is-btn-primary"
              onClick={() =>
                capture.open({ projectId: scope === 'project' ? projectId : scope === 'none' ? null : undefined })
              }
            >
              New idea
            </button>
            <button type="button" className="is-btn" onClick={onBack}>
              Back to the list
            </button>
          </div>
        </div>
      </div>
    );
  }

  const from = sourceLine(current);
  const backFromParked = current.activityTrail.some((e) => e.label.startsWith('Back in the Inbox'));
  const oldest = ideas[ideas.length - 1];

  return (
    <div className="is-body" data-testid="triage">
      <div className="is-triage-head">
        <div>
          <div className="is-title" style={{ fontSize: 17 }}>
            Triage
          </div>
          <div className="is-muted">Sort what came in. Aim for under two minutes.</div>
        </div>
        <span className="is-grow" />
        <span className="is-muted">
          {sorted} of {sorted + ideas.length} sorted
        </span>
        <button type="button" className="is-btn" onClick={onBack}>
          Back to the list
        </button>
      </div>

      <AdviceBar
        projectId={scope === 'project' ? (projectId ?? null) : null}
        ideaIds={ideas.map((i) => i.id)}
        onOpenSettings={onOpenSettings}
      />
      {waiting.length > 0 && (
        <div className="is-banner is-banner-warn" style={{ marginBottom: 12 }} role="status">
          <div style={{ flex: 1 }}>
            <b>{plural(waiting.length, 'idea')}</b> {waiting.length === 1 ? 'has' : 'have'} been waiting more than{' '}
            {WAITING_DAYS} days. An idea that waits too long stops being fresh.
          </div>
          <button type="button" className="is-btn is-btn-sm" onClick={parkAll} disabled={parkMany.isPending}>
            Park all for a month
          </button>
        </div>
      )}

      {current && !current.canEdit && (
        <div className="is-banner" style={{ marginBottom: 12 }} role="status" data-testid="view-only">
          <div>
            <b>View only.</b> Only owners and members can move ideas. You can still add one, and vote.
          </div>
        </div>
      )}
      <div className="is-triage">
        <aside className="is-inbox-list" aria-label="Inbox">
          <div className="is-inbox-title">
            Inbox <span className="is-count-pill">{ideas.length}</span>{' '}
            <span className="is-muted">to sort · newest first</span>
          </div>
          {ideas.map((i) => (
            <button
              key={i.id}
              type="button"
              className="is-inbox-item"
              aria-current={i.id === current.id}
              onClick={() => setSelectedId(i.id)}
            >
              <span className="is-inbox-name">
                {i.title} {i.source === 'ai' && <AiChip />}
              </span>
              <span className="is-muted is-inbox-meta">
                {sourceLine(i) ?? (i.projectId ? '' : 'No project')} · {relativeTime(i.createdAt)}
              </span>
            </button>
          ))}
          {oldest && (
            <div className="is-muted" style={{ padding: '8px 4px' }}>
              Oldest waiting: {relativeTime(oldest.createdAt)}
            </div>
          )}
        </aside>

        <section className="is-focus" aria-label="Idea in focus">
          <div className="is-row-sub" style={{ marginTop: 0 }}>
            <span className="is-mono">{current.id}</span>
            <StagePill stage={current.stage} />
            {backFromParked && <span className="is-warn">Back from parked</span>}
            {from && <span>{from}</span>}
            {current.createdBy && <span>· {current.createdBy === 'user' ? 'You' : current.createdBy}</span>}
            <span>· {relativeTime(current.createdAt)}</span>
          </div>
          <h2 className="is-focus-title">{current.title}</h2>
          {current.sourceRef.quote && <blockquote className="is-quote">“{current.sourceRef.quote}”</blockquote>}
          {current.sourceRef.why && (
            <div className="is-banner is-banner-ai">
              <div>
                <b>Why:</b> {current.sourceRef.why}
              </div>
            </div>
          )}
          {!current.sourceRef.quote && (current.body || current.description) && (
            <p className="is-focus-body">{current.body || current.description}</p>
          )}

          {dup && (
            <div className="is-dup" data-testid="duplicate">
              <div className="is-label" style={{ color: '#8a5a00' }}>
                Possible duplicate · {Math.round(dup.score * 100)}% similar
              </div>
              <div className="is-row-title">{dup.title}</div>
              <div className="is-muted">
                {dup.stage && `${dup.stage[0].toUpperCase()}${dup.stage.slice(1)}`}
                {dup.votes ? ` · ${plural(dup.votes, 'person', 'people')} want it` : ''}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button type="button" className="is-btn is-btn-sm" onClick={() => onOpenIdea(dup.id)}>
                  Open
                </button>
                <button type="button" className="is-btn is-btn-sm" onClick={() => decide('merge')}>
                  Merge into it
                </button>
              </div>
              <div className="is-muted" style={{ marginTop: 6 }}>
                Merging adds this text and its source to that idea and counts you as a +1. Nothing is lost.
              </div>
            </div>
          )}

          {(tagHints.length > 0 || relatedTicket) && (
            <div className="is-suggest-tags" style={{ marginTop: 12 }}>
              {tagHints.length > 0 && <span className="is-muted">Suggested tags</span>}
              {tagHints.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="is-tag is-tag-btn"
                  onClick={() => edit.mutate({ id: current.id, tags: [...current.tags, t] })}
                >
                  + {t}
                </button>
              ))}
              {relatedTicket && (
                <span className="is-muted">
                  · related ticket{' '}
                  <button type="button" className="is-link is-mono" onClick={() => onOpenTicket(relatedTicket.id)}>
                    {relatedTicket.id}
                  </button>
                </span>
              )}
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <AdviceCard projectId={current.projectId} ideaId={current.id} onAccept={(decision) => decide(decision)} />
          </div>

          <div className="is-label" style={{ margin: '18px 0 8px' }}>
            What do you want to do with it?
          </div>
          <div className="is-decisions">
            <DecisionButton k="K" label="Keep" hint="Start exploring it" onClick={() => decide('keep')} />
            <DecisionButton k="P" label="Park" hint="Come back on a date" onClick={() => decide('park')} />
            <DecisionButton k="M" label="Merge" hint="Into a similar idea" onClick={() => decide('merge')} />
            <DecisionButton
              k="X"
              label="Archive"
              hint="Not doing it, with a reason"
              onClick={() => decide('archive')}
            />
          </div>
          <div className="is-muted" style={{ marginTop: 10 }}>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move between ideas · the next one opens after each decision · <Kbd>Z</Kbd> undo
          </div>
          <button type="button" className="is-link" style={{ marginTop: 12 }} onClick={() => onOpenIdea(current.id)}>
            Open the page
          </button>
        </section>
      </div>
      {moves.dialogs}
    </div>
  );
}

function DecisionButton({ k, label, hint, onClick }: { k: string; label: string; hint: string; onClick: () => void }) {
  return (
    <button type="button" className="is-decision" onClick={onClick} data-testid={`decide-${label.toLowerCase()}`}>
      <span className="is-decision-main">
        <b>{label}</b> <Kbd>{k}</Kbd>
      </span>
      <span className="is-muted">{hint}</span>
    </button>
  );
}
