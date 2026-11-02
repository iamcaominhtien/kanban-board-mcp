import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useScopeState } from '../../api/assist';
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
import { useIdeaAiStatus } from '../../api/ideaAi';
import type { Project } from '../../types';
import type { Idea, IdeaStage } from '../../types/idea';
import { STAGE_LABELS } from '../../types/idea';
import { relativeTime } from '../../utils/relativeTime';
import { DocsEditor, type DocsEditorHandle } from '../docs/editor/DocsEditor';
import { Avatar, plural } from '../docs/docsShared';
import { useToast } from '../Toast';
import { WorkspaceSection } from '../WorkspaceSection';
import { IdeaAssumptions } from './IdeaAssumptions';
import { IdeaActivityTab, IdeaComments, IdeaLog } from './IdeaDiscussion';
import { IdeaEvidenceTab } from './IdeaEvidenceTab';
import {
  AiChip,
  Demand,
  ReadinessBadge,
  ReadinessBar,
  StagePill,
  StateCard,
  shortDate,
  sourceLine,
} from './ideaShared';
import { IdeaIcon, type IdeaIconName } from './ideaIcons';
import { ProjectPill } from './TriageDialogs';
import { useIdeaMoves } from './useIdeaMoves';
import { AiRailCard, ShapeButton, ShapePanel } from './IdeaAiPanel';
import { AskAiButton, AskAiShortcut, IdeaChat } from './IdeaChat';
import { LineIcon } from '../ui/LineIcon';

type Tab = 'page' | 'assumptions' | 'evidence' | 'comments' | 'log' | 'workspace' | 'activity';
type SaveState = 'saved' | 'saving' | 'error' | 'readonly';

/** The three tools of the header (icon buttons; hover shows a short summary). Each opens in place of the tabs' body. */
const TOOLS: { id: Tab; label: string; icon: IdeaIconName; summary: (idea: Idea) => string }[] = [
  {
    id: 'log',
    label: 'Research log',
    icon: 'log',
    summary: (i) => `Research log — ${i.logCount} ${i.logCount === 1 ? 'entry' : 'entries'}`,
  },
  { id: 'workspace', label: 'Workspace', icon: 'folder', summary: (i) => `Workspace — the folder ${i.id}/ on disk` },
  {
    id: 'activity',
    label: 'Activity',
    icon: 'history',
    summary: () => 'Activity — who changed what, and when',
  },
];

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
  /** The tab to open on (a link from a ticket to the idea log); the page tab by default. */
  initialTab?: string;
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
export function IdeaPage({
  ideaId,
  initialTab,
  projects,
  onBack,
  onOpenIdea,
  onOpenTicket,
  onPromote,
  onOpenSettings,
}: Props) {
  const toast = useToast();
  const { data: idea, isLoading, isError, refetch } = useIdea(ideaId);
  const edit = useEditIdeaPage();
  const vote = useVote();
  const outcome = useRecordOutcome();
  const setProject = useSetIdeaProject();
  const del = useDeleteIdea();
  const [tab, setTab] = useState<Tab>('page');
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState | null>(null);
  const [shapeOpen, setShapeOpen] = useState(false);
  // Shape with AI and Ask AI are both docked on the right: only one is open at a time
  const [askOpen, setAskOpen] = useState(false);
  const moves = useIdeaMoves({ onPromote });

  useEffect(() => {
    setTab(
      (['page', 'assumptions', 'evidence', 'comments', 'log', 'workspace', 'activity'] as Tab[]).find(
        (t) => t === initialTab,
      ) ?? 'page',
    );
    setShapeOpen(false);
    setAskOpen(false);
  }, [ideaId, initialTab]);

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
  ];

  return (
    <div className="is-page" data-testid="idea-page">
      <header className="is-page-head">
        <button type="button" className="is-btn is-btn-sm" onClick={onBack} aria-label="Back to Idea Space">
          <IdeaIcon name="arrowLeft" size={14} />
          Idea Space
        </button>
        <span className="is-key-chip">{idea.id}</span>
        <span className="is-page-head-title" title={idea.title}>
          {idea.title}
        </span>
        <span className="is-grow" />
        {tab === 'page' && saveState && (
          <span className="is-muted is-head-saved" aria-live="polite">
            {saveState === 'readonly'
              ? 'Read only'
              : saveState === 'saving'
                ? 'Saving…'
                : saveState === 'error'
                  ? 'Could not save. Your text is kept here; keep typing to retry.'
                  : 'Saved'}
          </span>
        )}
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="is-tool"
            aria-pressed={tab === t.id}
            aria-label={t.label}
            title={t.summary(idea)}
            onClick={() => setTab(tab === t.id ? 'page' : t.id)}
            data-testid={`tab-${t.id}`}
          >
            <IdeaIcon name={t.icon} size={17} />
          </button>
        ))}
        <span className="is-head-sep" aria-hidden="true" />
        <AskAiButton
          projectId={idea.projectId}
          active={askOpen}
          onClick={() => {
            setShapeOpen(false);
            setAskOpen(!askOpen);
          }}
        />
        {!closed && idea.stage !== 'building' && (
          <button type="button" className="is-btn" onClick={() => moves.request(idea, 'parked')}>
            <IdeaIcon name="bars" size={14} />
            Park
          </button>
        )}
        <ShapeButton
          projectId={idea.projectId}
          active={shapeOpen}
          onClick={() => {
            setAskOpen(false);
            setShapeOpen(!shapeOpen);
          }}
        />
        {promotable ? (
          <button type="button" className="is-btn is-btn-primary" onClick={() => onPromote(idea)} data-testid="promote">
            <IdeaIcon name="rocket" size={14} />
            Promote
          </button>
        ) : idea.ticket ? (
          <button type="button" className="is-btn is-btn-primary" onClick={() => onOpenTicket(idea.ticket!.id)}>
            <IdeaIcon name="external" size={14} />
            Open {idea.ticket.id}
          </button>
        ) : null}
        <div className="is-switch">
          <button
            type="button"
            className="is-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="More actions"
          >
            <LineIcon name="more" size={16} />
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
          <div className="is-row-sub is-page-meta">
            <StagePill stage={idea.stage} />
            <ReadinessBadge readiness={idea.readiness} />
            {(idea.owner ?? idea.createdBy) && (
              <span className="is-row-who">
                <Avatar name={idea.owner ?? idea.createdBy ?? ''} size={20} />
                {(idea.owner ?? idea.createdBy) === 'user' ? 'You' : (idea.owner ?? idea.createdBy)}
              </span>
            )}
            {from && (
              <span className="is-row-who">
                <IdeaIcon
                  name={idea.source === 'ai' ? 'sparkle' : idea.source === 'comment' ? 'comment' : 'book'}
                  size={12}
                />
                {from}
              </span>
            )}
            {idea.source === 'ai' && <AiChip />}
            {idea.tags.map((t) => (
              <span key={t} className="is-tag">
                {t}
              </span>
            ))}
          </div>
          <div className="is-row-sub is-page-demand">
            <button
              type="button"
              className="is-btn is-btn-sm"
              aria-pressed={voted}
              onClick={() => vote.mutate({ id: idea.id, on: !voted })}
              data-testid="vote"
            >
              <IdeaIcon name={voted ? 'check' : 'thumb'} size={13} />
              {voted ? 'You want this' : 'I want this'}
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

          <div className="is-utabs" role="tablist" aria-label="Idea sections">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                className="is-utab"
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
              <PageTab
                idea={idea}
                projects={projects}
                readOnly={readOnly}
                onOpenTicket={onOpenTicket}
                onStatus={setSaveState}
              />
            )}
            {tab === 'assumptions' && (
              <IdeaAssumptions
                idea={idea}
                readOnly={readOnly}
                onOpenTicket={onOpenTicket}
                onSuggest={() => {
                  setAskOpen(false);
                  setShapeOpen(true);
                }}
              />
            )}
            {tab === 'evidence' && <IdeaEvidenceTab idea={idea} readOnly={readOnly} />}
            {tab === 'comments' && <IdeaComments idea={idea} readOnly={false} />}
            {tab === 'log' && <IdeaLog idea={idea} readOnly={!idea.canEdit} closed={closed} />}
            {tab === 'workspace' && <IdeaWorkspaceTab idea={idea} closed={closed} />}
            {tab === 'activity' && <IdeaActivityTab idea={idea} />}
          </div>
        </div>

        <aside className="is-rail" aria-label="Decide">
          <section className="is-rail-card" data-testid="readiness-card">
            <div className="is-rail-head">
              <span className="is-label is-grow">Readiness</span>
              <ReadinessBadge readiness={idea.readiness} />
            </div>
            {idea.readiness.total > 0 && (
              <div className="is-rail-bar">
                <ReadinessBar idea={idea} />
              </div>
            )}
            <p className="is-rail-text">
              {idea.readiness.total === 0
                ? 'Write what must be true for this to work. A bare idea is never promoted by accident.'
                : idea.readiness.state === 'ready'
                  ? 'Every high-impact assumption is validated and none is disproved.'
                  : idea.readiness.state === 'at_risk'
                    ? 'A high-impact assumption was disproved. Rethink before promoting.'
                    : `${idea.readiness.highOpen} high-impact ${idea.readiness.highOpen === 1 ? 'assumption is' : 'assumptions are'} not validated yet.`}
              {idea.readiness.nextId && idea.assumptions.find((a) => a.id === idea.readiness.nextId) && (
                <>
                  {' '}
                  Start with <b>“{idea.assumptions.find((a) => a.id === idea.readiness.nextId)!.text}”</b>
                </>
              )}
            </p>
            {idea.readiness.nextId && (
              <button type="button" className="is-btn is-btn-sm is-rail-go" onClick={() => setTab('assumptions')}>
                <IdeaIcon name="arrowUpRight" size={13} />
                Go to it
              </button>
            )}
          </section>

          <section className="is-rail-card">
            <div className="is-label">Details</div>
            <dl className="is-dl is-details">
              <dt>Project</dt>
              <dd>
                <ProjectPill
                  plain
                  value={idea.projectId}
                  onChange={(id) => setProject.mutate({ id: idea.id, projectId: id })}
                />
              </dd>
              <dt>Stage</dt>
              <dd className="is-dd-row">
                <StagePill stage={idea.stage} />
                {idea.parkUntil ? <span className="is-muted">until {shortDate(idea.parkUntil)}</span> : null}
              </dd>
              <dt>Owner</dt>
              <dd>
                <ClickToEdit
                  key={`${idea.id}-${idea.owner}`}
                  value={idea.owner ?? ''}
                  label="Owner"
                  placeholder="Nobody yet"
                  disabled={closed}
                  display={
                    idea.owner ? (
                      <span className="is-row-who">
                        <Avatar name={idea.owner} size={20} />
                        {idea.owner}
                      </span>
                    ) : null
                  }
                  onSave={(v) => edit.mutate({ id: idea.id, owner: v || null })}
                />
              </dd>
              <dt>Effort guess</dt>
              <dd>
                <ClickToEdit
                  key={`${idea.id}-e-${idea.effortGuess}`}
                  value={idea.effortGuess ?? ''}
                  label="Effort guess"
                  placeholder="Small, medium, big…"
                  disabled={closed}
                  display={idea.effortGuess ? <b>{idea.effortGuess}</b> : null}
                  onSave={(v) => edit.mutate({ id: idea.id, effortGuess: v || null })}
                />
              </dd>
              <dt>Last touched</dt>
              <dd>{relativeTime(idea.updatedAt)}</dd>
            </dl>
          </section>

          <section className="is-rail-card">
            <div className="is-label">Linked</div>
            <div className="is-linked">
              {idea.ticket && (
                <div className="is-linked-row">
                  <button
                    type="button"
                    className="is-ticket-chip is-chip-btn"
                    onClick={() => onOpenTicket(idea.ticket!.id)}
                    title={`${idea.ticket.title} · ${statusLabel(idea.ticket.status)}`}
                  >
                    <span className="is-dot" style={{ background: idea.stage === 'shipped' ? '#2E6F40' : '#E8861A' }} />
                    {idea.ticket.id}
                  </button>
                  <span className="is-muted">ticket · {statusLabel(idea.ticket.status)}</span>
                </div>
              )}
              {idea.assumptions
                .filter((a) => a.testTicketId)
                .map((a) => (
                  <div key={a.id} className="is-linked-row">
                    <button
                      type="button"
                      className="is-ticket-chip is-chip-btn"
                      onClick={() => onOpenTicket(a.testTicketId!)}
                      title={a.text}
                    >
                      <span className="is-dot" style={{ background: '#E8B93A' }} />
                      {a.testTicketId}
                    </button>
                    <span className="is-muted">test</span>
                  </div>
                ))}
              {idea.source !== 'manual' && (idea.sourceRef.label || idea.sourceRef.id) && (
                <div className="is-linked-row">
                  {idea.source === 'ticket' && idea.sourceRef.id ? (
                    <button
                      type="button"
                      className="is-ticket-chip is-chip-btn"
                      onClick={() => onOpenTicket(idea.sourceRef.id!)}
                    >
                      {idea.sourceRef.id}
                    </button>
                  ) : (
                    <span className="is-doc-chip" title={idea.sourceRef.quote ?? undefined}>
                      <IdeaIcon
                        name={idea.source === 'doc' ? 'doc' : idea.source === 'comment' ? 'comment' : 'link'}
                        size={12}
                      />
                      {idea.sourceRef.label ?? idea.sourceRef.id}
                    </span>
                  )}
                  <span className="is-muted">source</span>
                </div>
              )}
              {idea.mergedIntoId && (
                <div className="is-linked-row">
                  <button
                    type="button"
                    className="is-ticket-chip is-chip-btn"
                    onClick={() => onOpenIdea(idea.mergedIntoId!)}
                  >
                    {idea.mergedIntoId}
                  </button>
                  <span className="is-muted">merged into</span>
                </div>
              )}
              {!idea.ticket && (
                <div className="is-muted">
                  No ticket yet.{' '}
                  {idea.projectId
                    ? `Promote creates one in ${project?.name ?? 'the project'}.`
                    : 'Choose a project, then promote.'}
                </div>
              )}
            </div>
          </section>
          <AiRailCard
            idea={idea}
            onOpen={() => {
              setAskOpen(false);
              setShapeOpen(true);
            }}
          />
        </aside>
      </div>
      <AskAiShortcut
        projectId={idea.projectId}
        onToggle={() => {
          setShapeOpen(false);
          setAskOpen((v) => !v);
        }}
      />
      {askOpen && <IdeaChat idea={idea} onClose={() => setAskOpen(false)} />}
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

/** A value shown as text; a click (or Enter) turns it into a field, saved when it loses the focus. */
function ClickToEdit({
  value,
  label,
  placeholder,
  disabled,
  display,
  onSave,
}: {
  value: string;
  label: string;
  placeholder: string;
  disabled: boolean;
  display: ReactNode;
  onSave: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing && !disabled) {
    return (
      <input
        className="is-input"
        defaultValue={value}
        placeholder={placeholder}
        aria-label={label}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={(e) => {
          setEditing(false);
          if (e.target.value.trim() !== value) onSave(e.target.value.trim());
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="is-click-edit"
      aria-label={`${label}: ${value || placeholder}. Change`}
      disabled={disabled}
      onClick={() => setEditing(true)}
      onFocus={() => setEditing(true)}
    >
      {display ?? <span className="is-muted">{placeholder}</span>}
    </button>
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
    <div className="is-banners">
      {idea.stage === 'archived' && (
        <StateCard
          icon="archive"
          title={`This idea is archived${idea.archiveReason ? ` (${idea.archiveReason.replace('_', ' ')})` : ''}`}
          actions={
            <button type="button" className="is-btn is-btn-sm" onClick={onReopen}>
              Reopen
            </button>
          }
        >
          The log, workspace and activity stay readable; adding entries and files is turned off.
          {idea.archiveNote ? ` “${idea.archiveNote}”` : ''}
        </StateCard>
      )}
      {idea.stage === 'shipped' && (
        <StateCard
          tone="ok"
          icon="check"
          title={`Shipped${idea.ticket ? ` as ${idea.ticket.id}` : ''}`}
          actions={
            <>
              {!idea.outcome ? (
                <>
                  <span>Did it work as expected?</span>
                  <button type="button" className="is-btn is-btn-sm" onClick={() => onOutcome('worked')}>
                    Yes
                  </button>
                  <button type="button" className="is-btn is-btn-sm" onClick={() => onOutcome('partly')}>
                    Partly
                  </button>
                  <button type="button" className="is-btn is-btn-sm" onClick={() => onOutcome('no')}>
                    No
                  </button>
                </>
              ) : (
                <span className="is-muted">Outcome: {idea.outcome}</span>
              )}
              <span className="is-grow" />
              {idea.ticket && (
                <button type="button" className="is-btn is-btn-sm" onClick={() => onOpenTicket(idea.ticket!.id)}>
                  <IdeaIcon name="external" size={13} />
                  Open the ticket
                </button>
              )}
              <button type="button" className="is-btn is-btn-sm" onClick={onReopen}>
                Reopen
              </button>
            </>
          }
        >
          The idea is read only; comments are still open.
        </StateCard>
      )}
      {idea.stage === 'building' && idea.ticket && (
        <div className="is-promoted" role="status" data-testid="promoted-card">
          <div className="is-promoted-card">
            <IdeaIcon name="rocket" size={18} strokeWidth={2} color="#1F5A31" />
            <div className="is-grow">
              <b>Promoted to</b>{' '}
              <span className="is-ticket-chip">
                <span className="is-dot" style={{ background: '#E8861A' }} />
                {idea.ticket.id}
              </span>{' '}
              <span className="is-muted">
                · {statusLabel(idea.ticket.status)}
                {idea.ticket.assignee ? ` · ${idea.ticket.assignee}` : ''}
                {idea.promotedAt ? ` · promoted ${relativeTime(idea.promotedAt)}` : ''}
              </span>
            </div>
            <button type="button" className="is-btn is-btn-sm" onClick={() => onOpenTicket(idea.ticket!.id)}>
              <IdeaIcon name="external" size={14} />
              Open ticket
            </button>
          </div>
          <div className="is-promoted-next">
            <StagePill stage="building" />
            <span className="is-muted">→ moves to Shipped when {idea.ticket.id} is Done</span>
          </div>
        </div>
      )}
      {idea.formerTicketId && !idea.ticket && (idea.stage === 'exploring' || idea.stage === 'ready') && (
        <StateCard
          tone="warn"
          icon="warning"
          title={`${idea.formerTicketId} was ${idea.stage === 'ready' ? 'deleted' : 'dropped'}`}
        >
          {idea.stage === 'ready' ? 'You can promote again; nothing was lost.' : 'Try again, park it or archive it.'}
        </StateCard>
      )}
      {disproved.length > 0 && !['archived', 'shipped', 'building'].includes(idea.stage) && (
        <StateCard
          tone="risk"
          role="alert"
          icon="warning"
          title="A key assumption was disproved"
          actions={
            <button type="button" className="is-btn is-btn-sm" onClick={onSeeEvidence}>
              See the evidence
            </button>
          }
        >
          “{disproved[0]}” is disproved. Promoting now is not recommended.
        </StateCard>
      )}
      {staleDays >= 30 && ['exploring', 'ready'].includes(idea.stage) && (
        <StateCard
          tone="warn"
          icon="clock"
          title={`Not touched for ${staleDays} days`}
          actions={
            <>
              <button type="button" className="is-btn is-btn-sm" onClick={onPark}>
                Park
              </button>
              <button type="button" className="is-btn is-btn-sm" onClick={onArchive}>
                Archive
              </button>
            </>
          }
        >
          Still worth doing? Test an assumption, park it, or archive it.
        </StateCard>
      )}
      {idea.projectId === null && !['archived', 'shipped'].includes(idea.stage) && (
        <StateCard
          icon="folder"
          title="This idea is not in a project"
          actions={
            choosing ? (
              <div style={{ maxWidth: 260, width: '100%' }}>
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
            ) : (
              <button type="button" className="is-btn is-btn-sm" onClick={() => setChoosing(true)}>
                Choose a project
              </button>
            )
          }
        >
          You can keep writing, testing and drawing. Choose a project when you want to promote it.
        </StateCard>
      )}
    </div>
  );
}

/** "in_progress" → "In progress". */
function statusLabel(status: string): string {
  const t = status.replace(/_/g, ' ');
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

/** The page itself: the Docs editor on the idea's markdown body, saved as you type. */
function PageTab({
  idea,
  projects,
  readOnly,
  onOpenTicket,
  onStatus,
}: {
  idea: Idea;
  projects: Project[];
  readOnly: boolean;
  onOpenTicket: (id: string) => void;
  /** "Saved", "Saving…" or the error, shown in the page header. */
  onStatus: (s: SaveState | null) => void;
}) {
  const edit = useEditIdeaPage();
  const editor = useRef<DocsEditorHandle>(null);
  const projectId = idea.projectId ?? projects[0]?.id ?? '';
  const tree = useDocsTree(projectId);
  // AI in the page text: the project of the idea; an idea with no project is asked from a project of the person
  const aiStatus = useIdeaAiStatus(idea.projectId).data;
  const aiOn = !!aiStatus && aiStatus.state !== 'off';
  const askScope = useScopeState(aiOn && !idea.projectId ? { kind: 'idea', id: idea.id } : null);
  const aiProjectId = aiOn ? (idea.projectId ?? askScope.data?.scope.projectId) : undefined;
  const [value, setValue] = useState(idea.body);
  const [status, setStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const latest = useRef({ value: idea.body, id: idea.id, saved: idea.body });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `mutate` is stable; `edit` changes on every mutation state, which would re-run the unmount flush below
  const { mutate } = edit;
  const save = useCallback(
    (body: string) => {
      setStatus('saving');
      mutate(
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
    [mutate],
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
        timer.current = null;
        if (latest.current.value !== latest.current.saved) save(latest.current.value);
      }
    },
    [save],
  );

  useEffect(() => {
    onStatus(readOnly ? 'readonly' : status);
  }, [onStatus, readOnly, status]);
  useEffect(() => () => onStatus(null), [onStatus]);

  if (!projectId) {
    return <div className="is-empty">Create a project first: the page editor needs one to resolve references.</div>;
  }

  return (
    <div className="is-editor" data-testid="idea-editor">
      <DocsEditor
        ref={editor}
        projectId={projectId}
        markdown={value}
        mode="visual"
        nodes={tree.data ?? []}
        currentPageId={idea.id}
        sketchOwnerKind="idea"
        inlineAi={{ surface: 'idea', projectId: aiProjectId }}
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
      <div className="is-tool-title">
        <h3>Workspace</h3>
        <span className="is-muted">· {idea.id}</span>
      </div>
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
