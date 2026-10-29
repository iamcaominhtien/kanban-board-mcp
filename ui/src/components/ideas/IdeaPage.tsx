import { useCallback, useEffect, useRef, useState } from 'react';
import { useDocsTree } from '../../api/docs';
import {
  ideaRuleError,
  useDeleteIdea,
  useEditIdeaPage,
  useIdea,
  useRecordOutcome,
  useSetIdeaProject,
  useVote,
} from '../../api/ideas';
import type { Project } from '../../types';
import type { Idea, IdeaStage } from '../../types/idea';
import { STAGE_LABELS } from '../../types/idea';
import { relativeTime } from '../../utils/relativeTime';
import { DocsEditor, type DocsEditorHandle } from '../docs/editor/DocsEditor';
import { plural } from '../docs/docsShared';
import { useToast } from '../Toast';
import { WorkspaceSection } from '../WorkspaceSection';
import { IdeaAssumptions } from './IdeaAssumptions';
import { IdeaActivityTab, IdeaComments, IdeaLog } from './IdeaDiscussion';
import { IdeaEvidenceTab } from './IdeaEvidenceTab';
import { AiChip, Demand, ReadinessBadge, StagePill, sourceLine } from './ideaShared';
import { ProjectSelect } from './TriageDialogs';
import { useIdeaMoves } from './useIdeaMoves';
import { AiRailCard, ShapeButton, ShapePanel } from './IdeaAiPanel';

type Tab = 'page' | 'assumptions' | 'evidence' | 'comments' | 'log' | 'workspace' | 'activity';

/** The name this browser acts as, the same one the API receives in `X-Actor`. */
export function currentActor(): string {
  try {
    return localStorage.getItem('kanbanActor') || 'user';
  } catch {
    return 'user';
  }
}

interface Props {
  ideaId: string;
  projects: Project[];
  onBack: () => void;
  onOpenIdea: (id: string) => void;
  onOpenTicket: (id: string) => void;
  onPromote: (idea: Pick<Idea, 'id' | 'title' | 'projectId' | 'stage' | 'tags' | 'body' | 'description'>) => void;
  /** Open Settings › Idea Space (from the AI states). */
  onOpenSettings?: () => void;
}

const MOVES: Record<IdeaStage, IdeaStage[]> = {
  inbox: ['exploring', 'parked', 'archived'],
  exploring: ['ready', 'parked', 'archived'],
  ready: ['exploring', 'parked', 'archived'],
  parked: ['inbox', 'exploring', 'archived'],
  building: [],
  shipped: ['exploring', 'archived'],
  archived: ['inbox', 'exploring'],
};

/** The idea as a page: writing, assumptions, evidence, comments, research log, workspace and activity. */
export function IdeaPage({ ideaId, projects, onBack, onOpenIdea, onOpenTicket, onPromote, onOpenSettings }: Props) {
  const toast = useToast();
  const { data: idea, isLoading, isError, refetch } = useIdea(ideaId);
  const edit = useEditIdeaPage();
  const vote = useVote();
  const outcome = useRecordOutcome();
  const setProject = useSetIdeaProject();
  const del = useDeleteIdea();
  const [tab, setTab] = useState<Tab>('page');
  const [menuOpen, setMenuOpen] = useState(false);
  const [shapeOpen, setShapeOpen] = useState(false);
  const moves = useIdeaMoves({ onPromote });

  useEffect(() => {
    setTab('page');
    setShapeOpen(false);
  }, [ideaId]);

  if (isLoading) return <div className="is-empty">Loading the idea…</div>;
  if (isError || !idea) {
    return (
      <div className="is-empty">
        <h3>Could not open the idea</h3>
        <button type="button" className="is-btn" onClick={() => refetch()}>
          Try again
        </button>{' '}
        <button type="button" className="is-btn" onClick={onBack}>
          Back
        </button>
      </div>
    );
  }

  const closed = idea.stage === 'archived' || idea.stage === 'shipped';
  const readOnly = closed || !idea.canEdit;
  const me = currentActor();
  const voted = idea.voters.includes(me);
  const promotable = ['inbox', 'exploring', 'ready'].includes(idea.stage);
  const project = projects.find((p) => p.id === idea.projectId);
  const from = sourceLine(idea);
  const staleDays = Math.floor((Date.now() - new Date(idea.updatedAt).getTime()) / 86400000);
  const disproved = idea.assumptions.filter((a) => a.state === 'disproved' && a.impact === 'high');
  const tabs: { id: Tab; label: string; n?: number }[] = [
    { id: 'page', label: 'Page' },
    { id: 'assumptions', label: 'Assumptions', n: idea.assumptions.length },
    { id: 'evidence', label: 'Evidence', n: idea.evidenceCount },
    { id: 'comments', label: 'Comments', n: idea.commentCount },
    { id: 'log', label: 'Research log', n: idea.logCount },
    { id: 'workspace', label: 'Workspace' },
    { id: 'activity', label: 'Activity' },
  ];

  return (
    <div className="is-page" data-testid="idea-page">
      <header className="is-page-head">
        <button type="button" className="is-btn is-btn-ghost" onClick={onBack} aria-label="Back to Idea Space">
          ← Idea Space
        </button>
        <span className="is-mono">{idea.id}</span>
        <StagePill stage={idea.stage} />
        <ReadinessBadge readiness={idea.readiness} />
        <span className="is-grow" />
        <ShapeButton projectId={idea.projectId} active={shapeOpen} onClick={() => setShapeOpen(!shapeOpen)} />
        {!closed && idea.stage !== 'building' && (
          <button type="button" className="is-btn" onClick={() => moves.request(idea, 'parked')}>
            Park
          </button>
        )}
        <div className="is-switch">
          <button
            type="button"
            className="is-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="More actions"
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              className="is-switch-menu"
              role="menu"
              style={{ right: 0, left: 'auto', minWidth: 210 }}
              onMouseLeave={() => setMenuOpen(false)}
            >
              {MOVES[idea.stage]
                .filter((s) => s !== 'parked')
                .map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="menuitem"
                    className="is-switch-item"
                    onClick={() => {
                      setMenuOpen(false);
                      moves.request(idea, s);
                    }}
                  >
                    {s === 'archived' ? 'Archive…' : s === 'inbox' ? 'Back to the Inbox' : `Move to ${STAGE_LABELS[s]}`}
                  </button>
                ))}
              {!closed && idea.stage !== 'building' && (
                <button
                  type="button"
                  role="menuitem"
                  className="is-switch-item"
                  onClick={() => {
                    setMenuOpen(false);
                    moves.decide(idea, 'merge');
                  }}
                >
                  Merge into another idea…
                </button>
              )}
              <div className="is-sep" />
              <button
                type="button"
                role="menuitem"
                className="is-switch-item"
                onClick={async () => {
                  setMenuOpen(false);
                  if (idea.stage === 'building')
                    return toast.error('Not allowed while the ticket is open', 'Close or remove the ticket first.');
                  if (!window.confirm(`Delete ${idea.id} for good? Archive keeps it searchable instead.`)) return;
                  try {
                    await del.mutateAsync(idea.id);
                    onBack();
                  } catch (e) {
                    toast.error('Could not delete', ideaRuleError(e).message);
                  }
                }}
              >
                Delete…
              </button>
            </div>
          )}
        </div>
        {promotable ? (
          <button type="button" className="is-btn is-btn-primary" onClick={() => onPromote(idea)} data-testid="promote">
            Promote
          </button>
        ) : idea.ticket ? (
          <button type="button" className="is-btn is-btn-primary" onClick={() => onOpenTicket(idea.ticket!.id)}>
            Open {idea.ticket.id}
          </button>
        ) : null}
      </header>

      <div className="is-page-main">
        <div className="is-page-col">
          <TitleField
            idea={idea}
            readOnly={closed}
            onSave={(title) =>
              edit.mutate(
                { id: idea.id, title },
                { onError: (e) => toast.error('Could not rename', ideaRuleError(e).message) },
              )
            }
          />
          <div className="is-row-sub" style={{ marginBottom: 10 }}>
            {from && <span>{from}</span>}
            {idea.createdBy && <span>· {idea.createdBy === 'user' ? 'You' : idea.createdBy}</span>}
            {idea.source === 'ai' && <AiChip />}
            {idea.tags.map((t) => (
              <span key={t} className="is-tag">
                {t}
              </span>
            ))}
            <button
              type="button"
              className={`is-chip ${voted ? '' : ''}`}
              aria-pressed={voted}
              onClick={() => vote.mutate({ id: idea.id, on: !voted })}
              data-testid="vote"
            >
              {voted ? '✓ You want this' : 'I want this'}
            </button>
            <Demand voters={idea.voters} max={4} />
            {idea.voters.length > 0 && <span>{plural(idea.voters.length, 'person wants', 'people want')} this</span>}
          </div>

          <Banners
            idea={idea}
            staleDays={staleDays}
            disproved={disproved.map((a) => a.text)}
            onPark={() => moves.request(idea, 'parked')}
            onArchive={() => moves.request(idea, 'archived')}
            onReopen={() => moves.request(idea, 'exploring')}
            onChooseProject={(id) => setProject.mutate({ id: idea.id, projectId: id })}
            onOutcome={(o) => outcome.mutate({ id: idea.id, outcome: o })}
            onOpenTicket={onOpenTicket}
            onSeeEvidence={() => setTab('assumptions')}
            projects={projects}
          />

          <div className="is-tabs is-page-tabs" role="tablist" aria-label="Idea sections">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                className="is-tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                data-testid={`tab-${t.id}`}
              >
                {t.label} {t.n ? <span className="is-muted">{t.n}</span> : null}
              </button>
            ))}
          </div>

          <div className="is-page-body">
            {tab === 'page' && (
              <PageTab idea={idea} projects={projects} readOnly={readOnly} onOpenTicket={onOpenTicket} />
            )}
            {tab === 'assumptions' && <IdeaAssumptions idea={idea} readOnly={readOnly} onOpenTicket={onOpenTicket} />}
            {tab === 'evidence' && <IdeaEvidenceTab idea={idea} readOnly={readOnly} />}
            {tab === 'comments' && <IdeaComments idea={idea} readOnly={false} />}
            {tab === 'log' && <IdeaLog idea={idea} readOnly={!idea.canEdit} closed={closed} />}
            {tab === 'workspace' && <IdeaWorkspaceTab idea={idea} closed={closed} />}
            {tab === 'activity' && <IdeaActivityTab idea={idea} />}
          </div>
        </div>

        <aside className="is-rail" aria-label="Decide">
          <section className="is-rail-card" data-testid="readiness-card">
            <div className="is-label">Readiness</div>
            <div className="is-rail-big">
              {idea.readiness.validated} of {idea.readiness.total}
            </div>
            <ReadinessBadge readiness={idea.readiness} />
            <p className="is-muted" style={{ marginTop: 8 }}>
              {idea.readiness.total === 0
                ? 'Write what must be true for this to work. A bare idea is never promoted by accident.'
                : idea.readiness.state === 'ready'
                  ? 'Every high-impact assumption is validated and none is disproved.'
                  : idea.readiness.state === 'at_risk'
                    ? 'A high-impact assumption was disproved. Rethink before promoting.'
                    : `${idea.readiness.highOpen} high-impact ${idea.readiness.highOpen === 1 ? 'assumption is' : 'assumptions are'} not validated yet.`}
            </p>
            {idea.readiness.nextId && (
              <button type="button" className="is-link" onClick={() => setTab('assumptions')}>
                Go to “{idea.assumptions.find((a) => a.id === idea.readiness.nextId)?.text.slice(0, 50)}”
              </button>
            )}
          </section>

          <section className="is-rail-card">
            <div className="is-label">Details</div>
            <dl className="is-dl">
              <dt>Project</dt>
              <dd>
                <ProjectSelect
                  value={idea.projectId}
                  onChange={(id) => setProject.mutate({ id: idea.id, projectId: id })}
                />
              </dd>
              <dt>Stage</dt>
              <dd>
                {STAGE_LABELS[idea.stage]}
                {idea.parkUntil ? ` until ${idea.parkUntil}` : ''}
              </dd>
              <dt>Owner</dt>
              <dd>
                <input
                  className="is-input"
                  defaultValue={idea.owner ?? ''}
                  key={`${idea.id}-${idea.owner}`}
                  placeholder="Nobody yet"
                  aria-label="Owner"
                  disabled={closed}
                  onBlur={(e) =>
                    e.target.value !== (idea.owner ?? '') && edit.mutate({ id: idea.id, owner: e.target.value || null })
                  }
                />
              </dd>
              <dt>Effort guess</dt>
              <dd>
                <input
                  className="is-input"
                  defaultValue={idea.effortGuess ?? ''}
                  key={`${idea.id}-e-${idea.effortGuess}`}
                  placeholder="Small, medium, big…"
                  aria-label="Effort guess"
                  disabled={closed}
                  onBlur={(e) =>
                    e.target.value !== (idea.effortGuess ?? '') &&
                    edit.mutate({ id: idea.id, effortGuess: e.target.value || null })
                  }
                />
              </dd>
              <dt>Last touched</dt>
              <dd>{relativeTime(idea.updatedAt)}</dd>
            </dl>
          </section>

          <section className="is-rail-card">
            <div className="is-label">Linked</div>
            {idea.ticket ? (
              <div>
                <button type="button" className="is-link is-mono" onClick={() => onOpenTicket(idea.ticket!.id)}>
                  {idea.ticket.id}
                </button>{' '}
                <span className="is-muted">
                  {idea.ticket.title} · {idea.ticket.status}
                </span>
              </div>
            ) : (
              <div className="is-muted">
                No ticket yet.{' '}
                {idea.projectId
                  ? `Promote creates one in ${project?.name ?? 'the project'}.`
                  : 'Choose a project, then promote.'}
              </div>
            )}
            {idea.assumptions
              .filter((a) => a.testTicketId)
              .map((a) => (
                <div key={a.id}>
                  <span className="is-muted">test </span>
                  <button type="button" className="is-link is-mono" onClick={() => onOpenTicket(a.testTicketId!)}>
                    {a.testTicketId}
                  </button>
                </div>
              ))}
            {idea.mergedIntoId && (
              <div>
                <span className="is-muted">merged into </span>
                <button type="button" className="is-link is-mono" onClick={() => onOpenIdea(idea.mergedIntoId!)}>
                  {idea.mergedIntoId}
                </button>
              </div>
            )}
          </section>
          <AiRailCard idea={idea} onOpen={() => setShapeOpen(true)} />
        </aside>
      </div>
      {shapeOpen && (
        <ShapePanel
          idea={idea}
          onClose={() => setShapeOpen(false)}
          onOpenIdea={onOpenIdea}
          onOpenTicket={onOpenTicket}
          onOpenSettings={onOpenSettings}
        />
      )}
      {moves.dialogs}
    </div>
  );
}

function TitleField({ idea, readOnly, onSave }: { idea: Idea; readOnly: boolean; onSave: (title: string) => void }) {
  const [value, setValue] = useState(idea.title);
  useEffect(() => setValue(idea.title), [idea.title, idea.id]);
  return (
    <input
      className="is-title-input"
      value={value}
      readOnly={readOnly}
      aria-label="Idea title"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value.trim() && value.trim() !== idea.title && onSave(value.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** The banners that tell what needs a look: closed, stale, disproved, no project, shipped outcome. */
function Banners({
  idea,
  staleDays,
  disproved,
  onPark,
  onArchive,
  onReopen,
  onChooseProject,
  onOutcome,
  onOpenTicket,
  onSeeEvidence,
  projects,
}: {
  idea: Idea;
  staleDays: number;
  disproved: string[];
  onPark: () => void;
  onArchive: () => void;
  onReopen: () => void;
  onChooseProject: (id: string | null) => void;
  onOutcome: (o: 'worked' | 'partly' | 'no') => void;
  onOpenTicket: (id: string) => void;
  onSeeEvidence: () => void;
  projects: Project[];
}) {
  const [choosing, setChoosing] = useState(false);
  return (
    <>
      {idea.stage === 'archived' && (
        <div className="is-banner" role="status">
          <div style={{ flex: 1 }}>
            <b>This idea is archived{idea.archiveReason ? ` (${idea.archiveReason.replace('_', ' ')})` : ''}.</b> The
            log, workspace and activity stay readable; adding entries and files is turned off.
            {idea.archiveNote ? ` “${idea.archiveNote}”` : ''}
          </div>
          <button type="button" className="is-btn is-btn-sm" onClick={onReopen}>
            Reopen
          </button>
        </div>
      )}
      {idea.stage === 'shipped' && (
        <div className="is-banner" role="status">
          <div style={{ flex: 1 }}>
            <b>Shipped{idea.ticket ? ` as ${idea.ticket.id}` : ''}.</b> The idea is read only; comments are still open.{' '}
            {idea.ticket && (
              <button type="button" className="is-link" onClick={() => onOpenTicket(idea.ticket!.id)}>
                Open the ticket
              </button>
            )}
            {!idea.outcome ? (
              <div style={{ marginTop: 6 }}>
                Did it work as expected?{' '}
                <button type="button" className="is-btn is-btn-sm" onClick={() => onOutcome('worked')}>
                  Yes
                </button>{' '}
                <button type="button" className="is-btn is-btn-sm" onClick={() => onOutcome('partly')}>
                  Partly
                </button>{' '}
                <button type="button" className="is-btn is-btn-sm" onClick={() => onOutcome('no')}>
                  No
                </button>
              </div>
            ) : (
              <div className="is-muted">Outcome: {idea.outcome}</div>
            )}
          </div>
          <button type="button" className="is-btn is-btn-sm" onClick={onReopen}>
            Reopen
          </button>
        </div>
      )}
      {idea.stage === 'building' && idea.ticket && (
        <div className="is-banner" role="status">
          <div style={{ flex: 1 }}>
            <b>Building</b> · {idea.ticket.id} · {idea.ticket.status}. It moves to Shipped when {idea.ticket.id} is
            Done.
          </div>
          <button type="button" className="is-btn is-btn-sm" onClick={() => onOpenTicket(idea.ticket!.id)}>
            Open ticket
          </button>
        </div>
      )}
      {idea.formerTicketId && !idea.ticket && (idea.stage === 'exploring' || idea.stage === 'ready') && (
        <div className="is-banner is-banner-warn" role="status">
          <div style={{ flex: 1 }}>
            {idea.formerTicketId} was {idea.stage === 'ready' ? 'deleted' : 'dropped'}.{' '}
            {idea.stage === 'ready' ? 'You can promote again; nothing was lost.' : 'Try again, park it or archive it.'}
          </div>
        </div>
      )}
      {disproved.length > 0 && !['archived', 'shipped', 'building'].includes(idea.stage) && (
        <div className="is-banner is-banner-risk" role="alert">
          <div style={{ flex: 1 }}>
            <b>A key assumption was disproved.</b> “{disproved[0]}” is disproved. Promoting now is not recommended.
          </div>
          <button type="button" className="is-btn is-btn-sm" onClick={onSeeEvidence}>
            See the evidence
          </button>
        </div>
      )}
      {staleDays >= 30 && ['exploring', 'ready'].includes(idea.stage) && (
        <div className="is-banner is-banner-warn" role="status">
          <div style={{ flex: 1 }}>
            <b>Not touched for {staleDays} days.</b> Still worth doing? Test an assumption, park it, or archive it.
          </div>
          <button type="button" className="is-btn is-btn-sm" onClick={onPark}>
            Park
          </button>
          <button type="button" className="is-btn is-btn-sm" onClick={onArchive}>
            Archive
          </button>
        </div>
      )}
      {idea.projectId === null && !['archived', 'shipped'].includes(idea.stage) && (
        <div className="is-banner" role="status">
          <div style={{ flex: 1 }}>
            <b>This idea is not in a project.</b> You can keep writing, testing and drawing. Choose a project when you
            want to promote it.
            {choosing && (
              <div style={{ marginTop: 8, maxWidth: 260 }}>
                <select
                  className="is-select"
                  style={{ width: '100%' }}
                  aria-label="Choose a project"
                  defaultValue=""
                  onChange={(e) => e.target.value && onChooseProject(e.target.value)}
                >
                  <option value="">Choose a project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          {!choosing && (
            <button type="button" className="is-btn is-btn-sm" onClick={() => setChoosing(true)}>
              Choose a project
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** The page itself: the Docs editor on the idea's markdown body, saved as you type. */
function PageTab({
  idea,
  projects,
  readOnly,
  onOpenTicket,
}: {
  idea: Idea;
  projects: Project[];
  readOnly: boolean;
  onOpenTicket: (id: string) => void;
}) {
  const edit = useEditIdeaPage();
  const editor = useRef<DocsEditorHandle>(null);
  const projectId = idea.projectId ?? projects[0]?.id ?? '';
  const tree = useDocsTree(projectId);
  const [value, setValue] = useState(idea.body);
  const [status, setStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const latest = useRef({ value: idea.body, id: idea.id, saved: idea.body });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(
    (body: string) => {
      setStatus('saving');
      edit.mutate(
        { id: latest.current.id, body },
        {
          onSuccess: () => {
            latest.current.saved = body;
            setStatus(latest.current.value === body ? 'saved' : 'saving');
          },
          onError: () => setStatus('error'),
        },
      );
    },
    [edit],
  );

  // a different idea, or a change made elsewhere while there are no edits of ours, reloads the text
  useEffect(() => {
    if (latest.current.id !== idea.id || latest.current.value === latest.current.saved) {
      latest.current = { value: idea.body, id: idea.id, saved: idea.body };
      setValue(idea.body);
    }
  }, [idea.id, idea.body]);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        if (latest.current.value !== latest.current.saved) save(latest.current.value);
      }
    },
    [save],
  );

  if (!projectId) {
    return <div className="is-empty">Create a project first: the page editor needs one to resolve references.</div>;
  }

  return (
    <div className="is-editor" data-testid="idea-editor">
      <div className="is-saved" aria-live="polite">
        {readOnly
          ? 'Read only'
          : status === 'saving'
            ? 'Saving…'
            : status === 'error'
              ? 'Could not save. Your text is kept here; keep typing to retry.'
              : 'Saved'}
      </div>
      <DocsEditor
        ref={editor}
        projectId={projectId}
        markdown={value}
        mode="visual"
        nodes={tree.data ?? []}
        currentPageId={idea.id}
        pageTitle={idea.title}
        filename={`${idea.id}.md`}
        toc={null}
        readOnly={readOnly}
        onOpenTicket={onOpenTicket}
        onChange={(md) => {
          if (md === latest.current.value) return;
          latest.current.value = md;
          setValue(md);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            timer.current = null;
            if (latest.current.value !== latest.current.saved) save(latest.current.value);
          }, 900);
        }}
      />
    </div>
  );
}

function IdeaWorkspaceTab({ idea, closed }: { idea: Idea; closed: boolean }) {
  const edit = useEditIdeaPage();
  return (
    <div data-testid="workspace-tab">
      {closed && (
        <div className="is-banner" style={{ marginBottom: 10 }}>
          The idea is closed. The folder stays readable; adding files is turned off.
        </div>
      )}
      <WorkspaceSection
        ticketId={idea.id}
        readOnly={closed}
        ideaRetention={{
          value: idea.workspaceRetention,
          onChange: (workspaceRetention) => edit.mutate({ id: idea.id, workspaceRetention }),
        }}
      />
    </div>
  );
}
