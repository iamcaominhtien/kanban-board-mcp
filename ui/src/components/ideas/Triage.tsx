import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ideaRuleError,
  useIdeaList,
  useParkMany,
  useSimilar,
  useTagSuggestions,
  useUndoIdeaMove,
  useEditIdeaPage,
  useSortedThisWeek,
  sortedThisWeekLine,
} from '../../api/ideas';
import type { IdeaRow, IdeaScope } from '../../types/idea';
import { relativeTime } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { plural } from '../docs/docsShared';
import { AiChip, Kbd, StagePill, dateIn, sourceLine } from './ideaShared';
import { useIdeaMoves, type Decision } from './useIdeaMoves';
import { useIdeaCapture } from './IdeaCapture';
import { AdviceBar, AdviceCard, AdviceSwitch, RowAdvice } from './IdeaAiExtras';
import { IdeaIcon, type IdeaIconName } from './ideaIcons';

interface Props {
  scope: IdeaScope;
  projectId?: string;
  onOpenIdea: (id: string) => void;
  onOpenTicket: (id: string) => void;
  onPromote: (idea: IdeaRow) => void;
  onBack: () => void;
  onOpenSettings?: () => void;
  /** The project switcher, drawn in the triage header after the title. */
  switcher?: ReactNode;
  /** The List / Stages / Matrix tabs, so another view stays one click away. */
  views?: ReactNode;
  /** Buttons of the Idea Space header that stay reachable in triage (Ask, New idea, notifications). */
  actions?: ReactNode;
}

const WAITING_DAYS = 14;

/** Triage: a short list on the left, one idea in focus on the right, one key per decision. */
export function Triage({
  scope,
  projectId,
  onOpenIdea,
  onOpenTicket,
  onPromote,
  onBack,
  onOpenSettings,
  switcher,
  views,
  actions,
}: Props) {
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

  const total = sorted + ideas.length;
  // the empty Inbox says what this person sorted in the last 7 days, from the activity the moves wrote (ICT-9)
  const weekLine = sortedThisWeekLine(useSortedThisWeek(scope, projectId, !list.isLoading && ideas.length === 0).data);
  const aiProject = scope === 'project' ? (projectId ?? null) : null;
  const head = (
    <div className="is-triage-head">
      <button type="button" className="is-btn is-btn-sm" onClick={onBack} data-testid="triage-back">
        <IdeaIcon name="arrowLeft" size={14} />
        Idea Space
      </button>
      <h2 className="is-triage-h">Triage</h2>
      {switcher}
      {views}
      <span className="is-muted is-triage-sub">Sort what came in. Aim for under two minutes.</span>
      <span className="is-grow" />
      <AdviceSwitch projectId={aiProject} />
      {total > 0 && (
        <>
          <span className="is-bar is-triage-progress" aria-hidden="true">
            <i className="is-seg-validated" style={{ width: `${(sorted / total) * 100}%` }} />
          </span>
          <span className="is-muted is-triage-count">
            {sorted} of {total} sorted
          </span>
        </>
      )}
      {actions}
    </div>
  );

  if (list.isLoading)
    return (
      <div className="is-triage-root">
        {head}
        <div className="is-empty">Loading the Inbox…</div>
      </div>
    );

  if (!current) {
    return (
      <div className="is-triage-root">
        {head}
        <div className="is-body">
          <div className="is-empty" data-testid="inbox-empty">
            <span className="is-empty-icon" aria-hidden="true">
              <IdeaIcon name="check" size={22} strokeWidth={2} />
            </span>
            <h3>Inbox is empty</h3>
            <div>
              {weekLine ??
                (sorted > 0
                  ? `You sorted ${plural(sorted, 'idea')} in this pass.`
                  : 'Nothing is waiting to be sorted.')}
            </div>
            <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button
                type="button"
                className="is-btn is-btn-primary"
                onClick={() =>
                  capture.open({ projectId: scope === 'project' ? projectId : scope === 'none' ? null : undefined })
                }
              >
                <IdeaIcon name="plus" size={14} />
                New idea
              </button>
              <button type="button" className="is-btn" onClick={onBack}>
                Back to the list
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const from = sourceLine(current);
  const backFromParked = current.activityTrail.some((e) => e.label.startsWith('Back in the Inbox'));
  const oldest = ideas[ideas.length - 1];

  return (
    <div className="is-triage-root" data-testid="triage">
      {head}
      {(waiting.length > 0 || !current.canEdit) && (
        <div className="is-triage-notes">
          {waiting.length > 0 && (
            <div className="is-banner is-banner-warn" role="status">
              <div style={{ flex: 1 }}>
                <b>{plural(waiting.length, 'idea')}</b> {waiting.length === 1 ? 'has' : 'have'} been waiting more than{' '}
                {WAITING_DAYS} days. An idea that waits too long stops being fresh.
              </div>
              <button type="button" className="is-btn is-btn-sm" onClick={parkAll} disabled={parkMany.isPending}>
                Park all for a month
              </button>
            </div>
          )}
          {!current.canEdit && (
            <div className="is-banner" role="status" data-testid="view-only">
              <div>
                <b>View only.</b> Only owners and members can move ideas. You can still add one, and vote.
              </div>
            </div>
          )}
        </div>
      )}
      <div className="is-triage">
        <aside className="is-inbox-list" aria-label="Inbox">
          <div className="is-inbox-title">
            <b>Inbox</b> <span className="is-count-amber">{ideas.length} to sort</span>
            <span className="is-grow" />
            <span className="is-muted">newest first</span>
          </div>
          <AdviceBar projectId={aiProject} ideaIds={ideas.map((i) => i.id)} onOpenSettings={onOpenSettings} />
          <div className="is-inbox-scroll">
            {ideas.map((i) => {
              const src = sourceLine(i);
              return (
                <div key={i.id} className="is-inbox-row" aria-current={i.id === current.id}>
                  <button
                    type="button"
                    className="is-inbox-item"
                    aria-current={i.id === current.id}
                    onClick={() => setSelectedId(i.id)}
                  >
                    <span className="is-inbox-name">
                      {i.title} {i.source === 'ai' && <AiChip />}
                      {!i.projectId && scope !== 'project' && <span className="is-warn is-warn-grey">No project</span>}
                    </span>
                    <span className="is-muted is-inbox-meta">
                      <span className="is-row-who">
                        <IdeaIcon name={src ? (INBOX_SOURCE_ICONS[i.source] ?? 'page') : 'edit'} size={12} />
                        {src ?? (i.createdBy === 'user' ? 'You' : (i.createdBy ?? ''))}
                      </span>
                      <span className="is-grow" />
                      {relativeTime(i.createdAt)}
                    </span>
                  </button>
                  <RowAdvice
                    projectId={aiProject}
                    ideaId={i.id}
                    ideaIds={ideas.map((x) => x.id)}
                    onAccept={(decision) => {
                      setSelectedId(i.id);
                      moves.decide(i, decision);
                    }}
                  />
                </div>
              );
            })}
          </div>
          {oldest && (
            <div className="is-inbox-foot">
              Oldest waiting: <b>{relativeTime(oldest.createdAt)}</b>
            </div>
          )}
        </aside>

        <section className="is-focus" aria-label="Idea in focus">
          <h2 className="is-focus-title">{current.title}</h2>
          <div className="is-row-sub" style={{ marginTop: 0 }}>
            <StagePill stage={current.stage} />
            {backFromParked && (
              <span className="is-warn is-warn-blue">
                <IdeaIcon name="calendar" size={11} strokeWidth={2} />
                Back from parked
              </span>
            )}
            {from && <span>{from}</span>}
            {current.createdBy && <span>· {current.createdBy === 'user' ? 'You' : current.createdBy}</span>}
            <span>· {relativeTime(current.createdAt)}</span>
            <span className="is-mono is-muted">{current.id}</span>
          </div>
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
              <div className="is-label" style={{ color: '#7a5a06', display: 'flex', alignItems: 'center', gap: 6 }}>
                <IdeaIcon name="merge" size={14} />
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

          <button type="button" className="is-link" style={{ marginTop: 12 }} onClick={() => onOpenIdea(current.id)}>
            Open the page
          </button>
          <span className="is-grow" />
          <div className="is-label" style={{ margin: '18px 0 8px' }}>
            What do you want to do with it?
          </div>
          <div className="is-decisions">
            <DecisionButton
              k="K"
              icon="flask"
              tone="keep"
              label="Keep"
              hint="Start exploring it"
              onClick={() => decide('keep')}
            />
            <DecisionButton k="P" icon="bars" label="Park" hint="Come back on a date" onClick={() => decide('park')} />
            <DecisionButton
              k="M"
              icon="merge"
              tone="merge"
              suggested={!!dup}
              label="Merge"
              hint="Into a similar idea"
              onClick={() => decide('merge')}
            />
            <DecisionButton
              k="X"
              icon="archive"
              label="Archive"
              hint="Not doing it, with a reason"
              onClick={() => decide('archive')}
            />
          </div>
          <div className="is-muted is-triage-keys">
            <IdeaIcon name="keyboard" size={14} />
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move between ideas · the next one opens after each decision · <Kbd>Z</Kbd> undo
          </div>
        </section>
      </div>
      {moves.dialogs}
    </div>
  );
}

const INBOX_SOURCE_ICONS: Partial<Record<IdeaRow['source'], IdeaIconName>> = {
  ai: 'sparkle',
  doc: 'book',
  comment: 'comment',
  ticket: 'comment',
  selection: 'book',
  picture: 'image',
  import: 'download',
};

function DecisionButton({
  k,
  icon,
  tone,
  suggested,
  label,
  hint,
  onClick,
}: {
  k: string;
  icon: IdeaIconName;
  tone?: 'keep' | 'merge';
  suggested?: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`is-decision ${tone ? `is-decision-${tone}` : ''} ${suggested ? 'is-decision-on' : ''}`}
      onClick={onClick}
      data-testid={`decide-${label.toLowerCase()}`}
    >
      <IdeaIcon name={icon} size={18} strokeWidth={2} className="is-decision-icon" />
      <b>{label}</b>
      <span className="is-muted">{hint}</span>
      <Kbd>{k}</Kbd>
    </button>
  );
}
