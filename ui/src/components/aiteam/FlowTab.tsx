import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useFlowMap, useFlowScopes, type FlowMapQuery } from '../../api/aiFlow';
import { useToast } from '../Toast';
import { AddTeamModal } from '../ai/AddTeamModal';
import { MenuSelect } from '../ui/MenuSelect';
import { CalendarIcon } from './teamUi';
import { FlowMap } from './FlowMap';
import { ALL_TEAMS, FlowScopeBar, isStory, scopeWords, type FlowScope, type FlowView } from './FlowScopeBar';
import { TimelineTab } from './TimelineTab';
import { buildFlowLink, syncFlowAddress, type FlowLink, type TimelineLink } from './timelineLink';
import './flow.css';

type MapRange = FlowMapQuery['range'];

const RANGES: { id: MapRange; label: string; word: string }[] = [
  { id: 'hour', label: 'Last hour', word: 'in the last hour' },
  { id: 'today', label: 'Today', word: 'today' },
  { id: '24h', label: 'Last 24 h', word: 'in the last 24 hours' },
  { id: '7d', label: '7 days', word: 'in the last 7 days' },
  { id: 'all', label: 'All time', word: 'yet' },
];

/** The scope and the view a request asks for: a Flow link, an old Timeline link, or a ticket asked from its modal. */
export function startOf(initial: TimelineLink | null): { scope: FlowScope; view: FlowView } {
  if (initial?.flow) {
    const f = initial.flow;
    return {
      scope: { teamId: f.team ?? null, ticketId: f.team ? null : (f.story ?? f.ticket) },
      view: f.view,
    };
  }
  // an old Timeline link, or "Open in Timeline" on a ticket
  if (initial) return { scope: { teamId: null, ticketId: initial.scope ?? null }, view: 'timeline' };
  return { scope: ALL_TEAMS, view: 'map' };
}

/**
 * Flow: how work passes between you, the AI teams and the tickets, in one scope (all teams, one team, one Story or
 * one ticket) and in one of two views: the Map (new in v2) and the Timeline.
 * @param props.projectId - The project.
 * @param props.projectName - The first crumb of the scope bar.
 * @param props.initial - The state a link or a request asked for.
 * @param props.onOpenTicket - Open a ticket's modal.
 */
export function FlowTab({
  projectId,
  projectName,
  initial,
  onOpenTicket,
}: {
  projectId: string;
  projectName: string;
  initial: TimelineLink | null;
  onOpenTicket: (ticketId: string) => void;
}) {
  const start = useMemo(() => startOf(initial), [initial]);
  const [scope, setScope] = useState<FlowScope>(start.scope);
  const [view, setView] = useState<FlowView>(start.view);
  const [range, setRange] = useState<MapRange>(start.scope.ticketId ? 'all' : 'today');
  const scopes = useFlowScopes(projectId);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const story = isStory(scopes.data, scope.ticketId);

  const link = useMemo<FlowLink>(
    () => ({
      story: story ? scope.ticketId : null,
      ticket: story ? null : scope.teamId ? null : scope.ticketId,
      team: scope.teamId,
      view,
    }),
    [scope, story, view],
  );
  useEffect(() => syncFlowAddress(projectId, link), [projectId, link]);
  useEffect(() => () => syncFlowAddress(projectId, null), [projectId]);

  const choose = (s: FlowScope) => {
    setScope(s);
    // a Story or a ticket opens on its whole life (design G, 4); a team or all teams on today
    setRange(s.ticketId ? 'all' : 'today');
  };

  const map = useFlowMap(projectId, { range, ticketId: scope.ticketId, teamId: scope.teamId });
  const totalRuns = scopes.data?.teams.reduce((n, t) => n + t.runs, 0) ?? null;
  const teamCount = scopes.data?.teams.length ?? null;

  const summary = (() => {
    const d = scopes.data;
    if (!d) return scopes.isError ? 'Couldn’t read the teams.' : 'Reading the teams…';
    if (scope.teamId) {
      const t = d.teams.find((x) => x.id === scope.teamId);
      return `${t?.name ?? 'This team'}: ${t?.runs ?? 0} run${t?.runs === 1 ? '' : 's'}${t?.live ? ', working now' : ''}`;
    }
    if (scope.ticketId) {
      const s = d.stories.find((x) => x.id === scope.ticketId);
      return s
        ? `${s.tickets} ticket${s.tickets === 1 ? '' : 's'} in this Story, ${s.done} done, from the plan to now`
        : 'One ticket, from the first assignment to done';
    }
    return `${d.teams.length} team${d.teams.length === 1 ? '' : 's'} · ${d.tickets.length} ticket${d.tickets.length === 1 ? '' : 's'} with AI work, in ${d.stories.length} Stor${d.stories.length === 1 ? 'y' : 'ies'}`;
  })();

  const copyLink = () => {
    navigator.clipboard
      ?.writeText(buildFlowLink(projectId, link))
      .then(() => toast.success('Link copied', 'It opens this scope and this view.'))
      .catch(() => toast.error("Couldn't copy the link"));
  };

  const words = RANGES.find((r) => r.id === range)?.word ?? 'today';
  const label = scope.teamId || scope.ticketId ? scopeWords(scope, scopes.data) : null;
  // a project where no team has ever run, and a project without a team
  const neverRan = totalRuns === 0 && !scopes.isError && scope.teamId === null && scope.ticketId === null;

  return (
    <div className="fl-root" data-testid="flow-tab">
      <FlowScopeBar
        projectName={projectName}
        scope={scope}
        scopes={scopes.data}
        view={view}
        summary={summary}
        mapTickets={map.data?.tickets}
        onScope={choose}
        onView={setView}
        onCopyLink={copyLink}
        right={
          view === 'map' ? (
            <MenuSelect<MapRange>
              variant="button"
              label="Range"
              testId="flow-range"
              icon={<CalendarIcon />}
              value={range}
              options={RANGES.map((r) => ({ value: r.id, label: r.label }))}
              onChange={setRange}
            />
          ) : null
        }
      />

      {neverRan ? (
        <div className="fl-empty" data-testid="flow-empty-project" role="status">
          <b>{teamCount === 0 ? 'No AI team on this board yet' : 'No AI has worked on this board yet'}</b>
          <span className="at-hint">
            {teamCount === 0
              ? 'Create a team first, then give it a ticket: the map and the timeline fill in as it works.'
              : 'Give a ticket to a team (assign it, or press Run on it). Who took it, who wrote to whom and what waited for you show up here.'}
          </span>
          {teamCount === 0 && (
            <button
              type="button"
              className="tl-btn primary"
              onClick={() => setAdding(true)}
              data-testid="flow-add-team"
            >
              Add an AI team
            </button>
          )}
        </div>
      ) : view === 'map' ? (
        map.data ? (
          <FlowMap
            data={map.data}
            rangeWord={scope.teamId ? `by ${label ?? 'this team'} ${words}` : words}
            onWiden={range === 'all' ? null : () => setRange('all')}
            onOpenTicket={onOpenTicket}
            onScopeTeam={(id) => choose({ teamId: id, ticketId: null })}
            onScopeTicket={(id) => choose({ teamId: null, ticketId: id })}
          />
        ) : map.isError ? (
          <div className="fl-error" role="alert" data-testid="flow-map-error">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#C4432A"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M12 3L22 20H2Z M12 10V14 M12 17V17.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <b>Couldn’t load the map.</b>
            <button type="button" className="tl-btn" onClick={() => void map.refetch()} data-testid="flow-map-retry">
              <RetryIcon /> Retry
            </button>
          </div>
        ) : (
          <div data-testid="flow-map-loading" role="status" aria-label="Drawing the map">
            <div className="fl-skel" aria-hidden="true">
              <i style={{ left: 14, top: 40, width: 150, height: 100 }} />
              {[16, 88, 160].map((top) => (
                <i key={`t${top}`} style={{ left: 330, top, width: 250, height: 54 }} />
              ))}
              {[16, 82, 148].map((top) => (
                <i key={`k${top}`} style={{ left: 860, top, width: 262, height: 54 }} />
              ))}
            </div>
            <div className="at-hint" style={{ marginTop: 8 }}>
              Drawing the map…
            </div>
          </div>
        )
      ) : (
        <TimelineTab
          key={`${scope.teamId}|${scope.ticketId}`}
          projectId={projectId}
          initial={
            // a Story or a ticket opens on its whole life in the Map: the Timeline's longest range (7 days) is the nearest
            initial && !initial.flow
              ? { ...initial, scope: undefined, range: initial.range ?? (scope.ticketId ? '7d' : undefined) }
              : scope.ticketId
                ? { range: '7d' }
                : null
          }
          scopeTicketId={scope.ticketId}
          teamId={scope.teamId}
          scopeBar
          groups
          scopeLabel={label}
          actions={{
            onOpenTicket,
            onOpenDocsPage: () => undefined,
            onSeeMap: () => setView('map'),
          }}
        />
      )}
      {adding && (
        <AddTeamModal
          projectId={projectId}
          projectName={projectName}
          onClose={() => {
            setAdding(false);
            void queryClient.invalidateQueries({ queryKey: ['ai', 'team'] });
          }}
        />
      )}
    </div>
  );
}

function RetryIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      aria-hidden="true"
    >
      <path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
