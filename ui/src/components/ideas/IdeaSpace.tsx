import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIdeaCounts, useIdeaList, type IdeaListParams } from '../../api/ideas';
import type { Project } from '../../types';
import type { IdeaBucketCounts, IdeaRow, IdeaScope, IdeaSource } from '../../types/idea';
import { useIdeaCapture } from './IdeaCapture';
import { useAppCommand } from '../../utils/appCommands';
import { IdeaList, StageChips, type StageFilter } from './IdeaList';
import { IdeaMatrix } from './IdeaMatrix';
import { IdeaPage } from './IdeaPage';
import { IdeaStages } from './IdeaStages';
import { AskPanel, DigestCard } from './IdeaAiExtras';
import { useIdeaAiStatus } from '../../api/ideaAi';
import { Kbd, BulbIcon } from './ideaShared';
import { PromoteDialog } from './PromoteDialog';
import { Triage } from './Triage';
import { useIdeaMoves } from './useIdeaMoves';
import './ideas.css';

type View = 'list' | 'stages' | 'matrix';
interface ScopeState {
  scope: IdeaScope;
  projectId?: string;
}

const STORAGE_KEY = 'ideaSpaceScope';

function loadScope(fallbackProjectId: string): ScopeState {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as ScopeState | null;
    if (raw && (raw.scope === 'all' || raw.scope === 'none' || (raw.scope === 'project' && raw.projectId))) return raw;
  } catch {
    /* no saved scope */
  }
  return { scope: 'project', projectId: fallbackProjectId };
}

interface Props {
  projects: Project[];
  /** The project you were last in: the space opens on it. */
  currentProjectId: string;
  /** Open this idea's page (a link from a ticket, a toast, a mention). */
  requestedIdea?: { id: string; tab?: string } | null;
  onRequestHandled?: () => void;
  onOpenTicket: (ticketId: string) => void;
  /** Open Settings › Idea Space (from the AI states). */
  onOpenSettings?: () => void;
}

/** The project switcher: one project, all projects, or ideas that belong to none. */
function Switcher({
  projects,
  value,
  counts,
  onChange,
}: {
  projects: Project[];
  value: ScopeState;
  counts?: { all: IdeaBucketCounts; none: IdeaBucketCounts; projects: (IdeaBucketCounts & { projectId: string })[] };
  onChange: (s: ScopeState) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const project = projects.find((p) => p.id === value.projectId);
  const label =
    value.scope === 'all' ? 'All projects' : value.scope === 'none' ? 'No project' : (project?.name ?? 'Project');
  const total = (b?: IdeaBucketCounts) => b?.total ?? 0;
  const pick = (s: ScopeState) => {
    onChange(s);
    setOpen(false);
  };

  return (
    <div className="is-switch" ref={ref}>
      <button
        type="button"
        className="is-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="idea-switcher"
      >
        {value.scope === 'project' && project && <span className="is-dot" style={{ background: project.color }} />}
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="is-switch-menu" role="menu">
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              aria-checked={value.scope === 'project' && value.projectId === p.id}
              className="is-switch-item"
              onClick={() => pick({ scope: 'project', projectId: p.id })}
            >
              <span className="is-dot" style={{ background: p.color }} />
              <span className="is-grow">{p.name}</span>
              <span className="is-muted">{total(counts?.projects.find((c) => c.projectId === p.id))}</span>
            </button>
          ))}
          <div className="is-sep" />
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value.scope === 'all'}
            className="is-switch-item"
            onClick={() => pick({ scope: 'all' })}
          >
            <span className="is-grow">All projects</span>
            <span className="is-muted">{total(counts?.all)}</span>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value.scope === 'none'}
            className="is-switch-item"
            onClick={() => pick({ scope: 'none' })}
          >
            <span className="is-grow">No project</span>
            <span className="is-muted">{total(counts?.none)}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Idea Space at the workspace level: a place for rough ideas that can become tickets.
 * Three ways to look at the same ideas (list, stages, matrix), the Inbox with its triage, and the idea page.
 */
export function IdeaSpace({
  projects,
  currentProjectId,
  requestedIdea,
  onRequestHandled,
  onOpenTicket,
  onOpenSettings,
}: Props) {
  const capture = useIdeaCapture();
  const [scope, setScope] = useState<ScopeState>(() => loadScope(currentProjectId));
  const [view, setView] = useState<View>('list');
  const [stage, setStage] = useState<StageFilter>('active');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [source, setSource] = useState<IdeaSource | ''>('');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState<NonNullable<IdeaListParams['sort']>>('readiness');
  const [triage, setTriage] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // the tab a link asked for (the idea log from a ticket)
  const [openTab, setOpenTab] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<IdeaRow | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Desktop menu: Edit › Find in Board
  useAppCommand('find-board', () => searchRef.current?.focus());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(scope));
    } catch {
      /* storage unavailable */
    }
  }, [scope]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    if (requestedIdea) {
      setOpenId(requestedIdea.id);
      setOpenTab(requestedIdea.tab ?? null);
      setTriage(false);
      onRequestHandled?.();
    }
  }, [requestedIdea, onRequestHandled]);
  // a project that no longer exists falls back to the one you are in
  useEffect(() => {
    if (scope.scope === 'project' && !projects.some((p) => p.id === scope.projectId))
      setScope({ scope: 'project', projectId: currentProjectId });
  }, [projects, scope, currentProjectId]);

  const counts = useIdeaCounts().data;
  const aiStatus = useIdeaAiStatus(scope.scope === 'project' ? (scope.projectId ?? null) : null).data;
  // "Ask" shows while AI help is on and its Ask switch is on; with AI off nothing is drawn
  const askAvailable = !!aiStatus && aiStatus.state !== 'off' && aiStatus.settings.ask;
  const bucket: IdeaBucketCounts | undefined =
    scope.scope === 'all'
      ? counts?.all
      : scope.scope === 'none'
        ? counts?.none
        : counts?.projects.find((p) => p.projectId === scope.projectId);
  const inboxHere = bucket?.stages.inbox ?? 0;

  const stageParams = view === 'stages' ? undefined : stage === 'active' ? undefined : [stage];
  const params: IdeaListParams = {
    scope: scope.scope,
    projectId: scope.projectId,
    stages: view === 'matrix' ? ['inbox', 'exploring', 'ready'] : stageParams,
    active: view === 'list' && stage === 'active' ? true : undefined,
    q: debounced,
    source: source || undefined,
    tag: tag || undefined,
    sort,
  };
  const list = useIdeaList(params, !openId && !triage);
  const ideas = useMemo(() => {
    const rows = list.data ?? [];
    // the stages view shows every stage but the Inbox (it has its own place) and Archived (a filter)
    return view === 'stages'
      ? rows.filter((r) => r.stage !== 'inbox' && (stage === 'archived' || r.stage !== 'archived'))
      : rows;
  }, [list.data, view, stage]);
  const allTags = useMemo(() => Array.from(new Set((list.data ?? []).flatMap((i) => i.tags))).sort(), [list.data]);

  const moves = useIdeaMoves({ onPromote: (i) => setPromoting(i as IdeaRow) });
  const newIdea = useCallback(
    () =>
      capture.open({
        projectId: scope.scope === 'none' ? null : scope.scope === 'project' ? scope.projectId : undefined,
      }),
    [capture, scope],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('[role="dialog"]')) return;
      if (e.key === 'c' && !openId) {
        e.preventDefault();
        newIdea();
      } else if (e.key === '/' && !openId && !triage) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newIdea, openId, triage]);

  if (openId) {
    return (
      <div className="is-root" data-testid="idea-space">
        <IdeaPage
          ideaId={openId}
          initialTab={openTab ?? undefined}
          projects={projects}
          onBack={() => setOpenId(null)}
          onOpenIdea={setOpenId}
          onOpenTicket={onOpenTicket}
          onPromote={(i) => setPromoting(i as IdeaRow)}
          onOpenSettings={onOpenSettings}
        />
        {promoting && (
          <PromoteDialog
            idea={promoting}
            projects={projects}
            onClose={() => setPromoting(null)}
            onOpenTicket={onOpenTicket}
            onPromoted={() => setPromoting(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="is-root" data-testid="idea-space">
      <div className="is-head">
        <h1 className="is-title">
          <BulbIcon size={20} /> Idea Space
        </h1>
        <Switcher projects={projects} value={scope} counts={counts} onChange={(s) => setScope(s)} />
        <div className="is-tabs" role="tablist" aria-label="View">
          {(['list', 'stages', 'matrix'] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              className="is-tab"
              aria-selected={view === v && !triage}
              onClick={() => {
                setView(v);
                setTriage(false);
              }}
            >
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <span className="is-grow" />
        <div className="is-search">
          <input
            ref={searchRef}
            className="is-input"
            placeholder="Search ideas"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search ideas"
          />
          <Kbd>/</Kbd>
        </div>
        {askAvailable && (
          <button
            type="button"
            className="is-btn"
            aria-pressed={askOpen}
            onClick={() => setAskOpen(!askOpen)}
            data-testid="ask-button"
          >
            <span aria-hidden="true">✦</span> Ask
          </button>
        )}
        <button type="button" className="is-btn" onClick={() => setTriage(true)} data-testid="inbox-button">
          Inbox {inboxHere > 0 && <span className="is-count-pill">{inboxHere}</span>}
        </button>
        <button type="button" className="is-btn is-btn-primary" onClick={newIdea} data-testid="new-idea">
          New idea <Kbd>C</Kbd>
        </button>
      </div>

      {triage ? (
        <Triage
          scope={scope.scope}
          projectId={scope.projectId}
          onOpenIdea={(id) => {
            setTriage(false);
            setOpenId(id);
          }}
          onOpenTicket={onOpenTicket}
          onPromote={(i) => setPromoting(i)}
          onBack={() => setTriage(false)}
          onOpenSettings={onOpenSettings}
        />
      ) : (
        <div className="is-body">
          <DigestCard
            projectId={scope.scope === 'project' ? (scope.projectId ?? null) : null}
            onOpenInbox={() => setTriage(true)}
            onOpenIdea={setOpenId}
          />
          <div className="is-filters">
            {view !== 'matrix' && <StageChips value={stage} onChange={setStage} counts={bucket} />}
            <span className="is-grow" />
            <select
              className="is-select"
              value={source}
              onChange={(e) => setSource(e.target.value as IdeaSource | '')}
              aria-label="Source"
            >
              <option value="">Source: all</option>
              {(['manual', 'doc', 'comment', 'ticket', 'picture', 'ai', 'import'] as IdeaSource[]).map((s) => (
                <option key={s} value={s}>
                  {s === 'ai' ? 'AI suggested' : s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
            <select className="is-select" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
              <option value="">Tag: all</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {view === 'list' && (
              <select
                className="is-select"
                value={sort}
                onChange={(e) => setSort(e.target.value as typeof sort)}
                aria-label="Sort"
              >
                <option value="readiness">Sort: readiness</option>
                <option value="updated">Sort: updated</option>
                <option value="created">Sort: newest</option>
                <option value="votes">Sort: demand</option>
                <option value="title">Sort: title</option>
              </select>
            )}
          </div>
          {list.isError ? (
            <div className="is-empty">
              <h3>Could not load the ideas</h3>
              <button type="button" className="is-btn" onClick={() => list.refetch()}>
                Try again
              </button>
            </div>
          ) : view === 'list' ? (
            <IdeaList
              ideas={ideas}
              scope={scope.scope}
              projects={projects}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onOpen={setOpenId}
              onOpenTicket={onOpenTicket}
              filtered={!!debounced || !!source || !!tag || stage !== 'active'}
              emptyAction={
                <button type="button" className="is-btn is-btn-primary" onClick={newIdea}>
                  New idea
                </button>
              }
            />
          ) : view === 'stages' ? (
            <IdeaStages
              ideas={ideas}
              showArchived={stage === 'archived'}
              onOpen={setOpenId}
              onMove={(i, to) => moves.request(i, to)}
            />
          ) : (
            <IdeaMatrix ideas={ideas} onOpen={setOpenId} />
          )}
          <div className="is-muted" style={{ marginTop: 12 }}>
            {bucket
              ? `${bucket.active} active ${bucket.active === 1 ? 'idea' : 'ideas'} · the ${inboxHere} in the Inbox are not counted`
              : ''}
          </div>
        </div>
      )}
      {moves.dialogs}
      {askOpen && (
        <AskPanel
          projectId={scope.scope === 'project' ? scope.projectId : undefined}
          scope={scope.scope}
          onClose={() => setAskOpen(false)}
          onOpenIdea={(id) => {
            setAskOpen(false);
            setOpenId(id);
          }}
          onOpenSettings={onOpenSettings}
        />
      )}
      {promoting && (
        <PromoteDialog
          idea={promoting}
          projects={projects}
          onClose={() => setPromoting(null)}
          onOpenTicket={onOpenTicket}
          onPromoted={() => setPromoting(null)}
        />
      )}
    </div>
  );
}
