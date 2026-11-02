import { useCallback, useEffect, useRef, useState } from 'react';
import { useDecidedForYou, useTeamNow, useTeamStepped } from '../../api/aiTeam';
import type { TeamRange } from '../../types/aiTeam';
import { NowTab, type NowActions } from './NowTab';
import { FlowTab } from './FlowTab';
import { HealthTab } from './HealthTab';
import { SteppedInTab } from './SteppedInTab';
import { DecidedTab } from './DecidedTab';
import { AwayCard, AwaySummary, type AwayActions } from './AwayCard';
import { decidedIsNew, markDecidedSeen, useAwayWindow } from './awayStore';
import { ResumeAllDialog } from '../ai/AiKillSwitch';
import { useAiBoardState } from '../ai/aiUi';
import { ResourcesTab } from './ResourcesTab';
import { HistoryTab } from './HistoryTab';
import { OPEN_RUN_EVENT, takePendingRun } from './runLink';
import { CalendarIcon, Icon, ICONS } from './teamUi';
import { MenuSelect } from '../ui/MenuSelect';
import { OPEN_TIMELINE_EVENT, syncFlowAddress, takePendingTimeline, type TimelineLink } from './timelineLink';
import { PROJECT_SCOPE, scopeLevel, type FlowScope, type FlowView } from './flowScope';
import './aiTeam.css';

type Tab = 'now' | 'flow' | 'stepped' | 'decided' | 'health' | 'resources' | 'history';

const TABS: { id: Tab; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'flow', label: 'Flow' },
  { id: 'stepped', label: 'You stepped in' },
  { id: 'decided', label: 'Decided for you' },
  { id: 'health', label: 'Health' },
  { id: 'resources', label: 'Resources' },
  { id: 'history', label: 'Run history' },
];

interface Props {
  projectId: string;
  projectName: string;
  onOpenTicket: (ticketId: string) => void;
  onOpenMember: (memberId: string) => void;
  onOpenDocsPage: (pageId: string) => void;
  /** Open a Story's page; without it the Story's ticket opens. */
  onOpenStory?: (storyId: string) => void;
}

/** Where Flow opens from a link: a Flow link names its scope and view, a Timeline link may name one ticket. */
function scopeFromLink(link: TimelineLink | null): { scope: FlowScope; view: FlowView } {
  if (link?.flow) return { scope: { story: link.flow.story, ticket: link.flow.ticket }, view: link.flow.view };
  if (link) return { scope: { story: null, ticket: link.scope ?? null }, view: 'timeline' };
  return { scope: PROJECT_SCOPE, view: 'map' };
}

/** The AI Team view (design/screens/ai-team.md): what the AIs are doing, how work moves, where people stepped in. */
export function AiTeamView({ projectId, projectName, onOpenTicket, onOpenMember, onOpenDocsPage, onOpenStory }: Props) {
  // The Timeline was asked for (a link, or "Open in Timeline" on a ticket): Flow opens on it
  const [timelineLink, setTimelineLink] = useState<{ link: TimelineLink; key: number } | null>(() => {
    const link = takePendingTimeline();
    return link ? { link, key: Date.now() } : null;
  });
  // A run was asked for (a link to its detail): Run history opens on it
  const [runId, setRunId] = useState<string | null>(() => takePendingRun());
  const [tab, setTab] = useState<Tab>(runId ? 'history' : timelineLink ? 'flow' : 'now');
  // Flow's scope and view (design/screens/ai-story-flow.md, G), kept on the address while Flow is open
  const [flowScope, setFlowScopeState] = useState<FlowScope>(() => scopeFromLink(timelineLink?.link ?? null).scope);
  const [flowView, setFlowView] = useState<FlowView>(() => scopeFromLink(timelineLink?.link ?? null).view);
  // a Story or a ticket opens on its whole life until a range is picked
  const [flowLife, setFlowLife] = useState(() => scopeLevel(flowScope) !== 'project');
  const scopeRef = useRef(flowScope);
  const setFlowScope = useCallback((next: FlowScope) => {
    const prev = scopeRef.current;
    if (prev.story === next.story && prev.ticket === next.ticket) return;
    scopeRef.current = next;
    setFlowScopeState(next);
    setFlowLife(scopeLevel(next) !== 'project');
  }, []);
  useEffect(() => {
    const open = () => {
      const link = takePendingTimeline();
      if (!link) return;
      setTimelineLink({ link, key: Date.now() });
      const next = scopeFromLink(link);
      setFlowScope(next.scope);
      setFlowView(next.view);
      setTab('flow');
    };
    window.addEventListener(OPEN_TIMELINE_EVENT, open);
    return () => window.removeEventListener(OPEN_TIMELINE_EVENT, open);
  }, [setFlowScope]);
  useEffect(() => {
    const open = () => {
      const id = takePendingRun();
      if (!id) return;
      setRunId(id);
      setTab('history');
    };
    window.addEventListener(OPEN_RUN_EVENT, open);
    return () => window.removeEventListener(OPEN_RUN_EVENT, open);
  }, []);
  // Now reads best for today, the other tabs for a week; each tab keeps the range the person picked
  const [ranges, setRanges] = useState<Record<Tab, TeamRange>>({
    now: 'today',
    flow: '7d',
    stepped: '7d',
    decided: '7d',
    health: '7d',
    resources: 'today',
    history: '30d',
  });
  const range = ranges[tab];
  const setRange = (r: TeamRange) => setRanges({ ...ranges, [tab]: r });
  const scoped = tab === 'flow' && scopeLevel(flowScope) !== 'project';
  const life = scoped && flowLife;
  const scopeId = flowScope.ticket ?? flowScope.story;

  useEffect(() => {
    syncFlowAddress(projectId, tab === 'flow' ? { ...flowScope, view: flowView } : null);
  }, [projectId, tab, flowScope, flowView]);
  useEffect(() => () => syncFlowAddress(projectId, null), [projectId]);
  const { data, isLoading, isError, dataUpdatedAt } = useTeamNow(projectId, ranges.now);
  const stepped = useTeamStepped(projectId, ranges.stepped);
  const decided = useDecidedForYou(projectId, ranges.decided);
  const [decidedNew, setDecidedNew] = useState(decidedIsNew);
  useEffect(() => {
    if (tab === 'decided' && decidedNew) {
      markDecidedSeen();
      setDecidedNew(false);
    }
  }, [tab, decidedNew]);
  // While you were away (M2): the card on Now, its full summary, and Resume when AI was paused
  const away = useAwayWindow();
  const [awayFull, setAwayFull] = useState(false);
  const [resuming, setResuming] = useState(false);
  const board = useAiBoardState();
  const openStory = (id: string) => (onOpenStory ? onOpenStory(id) : onOpenTicket(id));
  const closeAway = () => {
    away.close();
    setAwayFull(false);
  };
  const awayActions: AwayActions = {
    onOpenTicket,
    onOpenStory: openStory,
    onOpenWaiting: () => {
      setAwayFull(false);
      setTab('now');
      window.setTimeout(() => document.getElementById('at-needs-you')?.scrollIntoView?.({ behavior: 'smooth' }), 0);
    },
    onSeeDecided: () => setTab('decided'),
    onResume: () => setResuming(true),
  };
  const actions: NowActions = {
    onOpenTicket,
    onOpenMember,
    onOpenDocsPage,
    onSeeFlow: () => setTab('flow'),
    onSeeResources: () => setTab('resources'),
  };
  const updated = dataUpdatedAt ? Math.max(0, Math.round((Date.now() - dataUpdatedAt) / 1000)) : null;

  return (
    <div className="at-root" data-testid="ai-team-view">
      <div className="at-head">
        <h1 className="at-title">AI Team</h1>
        <span className="at-chip" style={{ background: '#E6F2EA', color: '#1F5A31' }}>
          {projectName}
        </span>
        <div className="at-seg" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'on' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'resources' && data && data.restartedRuns > 0 ? (
                <span
                  data-testid="resources-dot"
                  role="img"
                  aria-label={`${data.restartedRuns} run${data.restartedRuns === 1 ? '' : 's'} restarted for memory`}
                  title={`${data.restartedRuns} run${data.restartedRuns === 1 ? '' : 's'} restarted for memory`}
                  style={{
                    display: 'inline-block',
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: '#E8821A',
                    marginLeft: 6,
                  }}
                />
              ) : null}
              {t.id === 'stepped' && stepped.data ? (
                <b style={{ fontWeight: 700, color: '#7A5A06' }}>{stepped.data.totals.touches}</b>
              ) : null}
              {t.id === 'decided' && decided.data ? (
                <b
                  style={{ fontWeight: 700, color: '#7A5A06' }}
                  title={`${decided.data.totals.overridable} you can still override`}
                  data-testid="decided-count"
                >
                  {decided.data.totals.overridable}
                </b>
              ) : null}
              {t.id === 'decided' && decidedNew ? (
                <span
                  className="at-chip"
                  style={{
                    background: '#E3F3E7',
                    color: '#1F5A31',
                    height: 17,
                    fontSize: 10,
                    letterSpacing: '0.04em',
                    padding: '0 6px',
                  }}
                >
                  NEW
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {!(tab === 'resources' || tab === 'history' || (tab === 'flow' && flowView === 'timeline')) && (
          // Flow › Timeline has its own range in its toolbar: a second one here disagreed with it
          <MenuSelect<TeamRange | 'life'>
            variant="button"
            label="Range"
            testId="at-range"
            icon={<CalendarIcon />}
            value={life ? 'life' : range}
            options={[
              ...(scoped ? [{ value: 'life' as const, label: 'Whole life' }] : []),
              { value: 'today', label: 'Today' },
              { value: '7d', label: 'Last 7 days' },
              { value: '30d', label: 'Last 30 days' },
            ]}
            onChange={(v) => {
              if (v === 'life') {
                setFlowLife(true);
                return;
              }
              setRange(v);
              if (tab === 'flow') setFlowLife(false);
            }}
          />
        )}
        <span className="at-hint" hidden={tab === 'resources' || tab === 'history'} data-testid="range-hint">
          {life
            ? `The whole life of ${scopeId}`
            : isError
              ? 'Not live: reconnecting'
              : updated != null
                ? `Live · updated ${updated} s ago`
                : ''}
        </span>
      </div>

      {tab === 'flow' ? (
        <FlowTab
          key={`flow:${timelineLink?.key ?? 0}`}
          timelineLink={timelineLink?.link ?? null}
          projectId={projectId}
          projectName={projectName}
          range={life ? null : range}
          scope={flowScope}
          view={flowView}
          onScope={setFlowScope}
          onView={setFlowView}
          actions={{ onOpenTicket, onOpenDocsPage, onOpenStory }}
        />
      ) : tab === 'health' ? (
        <HealthTab
          projectId={projectId}
          range={range}
          onWiden={() => setRange('30d')}
          actions={{
            onOpenTicket,
            onOpenMember,
            onOpenDocsPage,
            onOpenFlow: (id) => {
              setFlowScope({ story: null, ticket: id });
              setFlowView('map');
              setTab('flow');
            },
            onOpenStepped: () => setTab('stepped'),
            onOpenStory: openStory,
          }}
        />
      ) : tab === 'history' ? (
        <HistoryTab
          projectId={projectId}
          members={data?.members ?? []}
          runId={runId}
          onRunChange={setRunId}
          onOpenTicket={onOpenTicket}
        />
      ) : tab === 'resources' ? (
        <ResourcesTab projectId={projectId} onOpenTicket={onOpenTicket} />
      ) : tab === 'decided' ? (
        <DecidedTab projectId={projectId} range={range} actions={{ onOpenTicket, onOpenStory }} />
      ) : tab === 'stepped' ? (
        <SteppedInTab
          projectId={projectId}
          range={range}
          actions={{
            onOpenTicket,
            onOpenDocsPage,
            onOpenAudit: (id) => id && onOpenMember(id),
          }}
        />
      ) : tab !== 'now' ? (
        <div className="at-soon">
          <Icon color="#7C5CD6" size={16}>
            {ICONS.sparkle}
          </Icon>{' '}
          This tab is not built yet.
        </div>
      ) : away.since && awayFull ? (
        <AwaySummary
          projectId={projectId}
          since={away.since}
          members={data?.members ?? []}
          onBack={() => setAwayFull(false)}
          onMarkSeen={closeAway}
          actions={awayActions}
        />
      ) : (
        <>
          {away.since && (
            <AwayCard
              projectId={projectId}
              since={away.since}
              onClose={closeAway}
              onOpenFull={() => setAwayFull(true)}
              actions={awayActions}
            />
          )}
          {isLoading || !data ? (
            <div className="at-hint">{isError ? "Couldn't load the AI team." : 'Loading the AI team…'}</div>
          ) : (
            <NowTab data={data} range={range} actions={actions} />
          )}
        </>
      )}
      {resuming && (
        <ResumeAllDialog
          projectId={projectId}
          members={[...board.members.values()].filter((m) => m.kind === 'ai')}
          onClose={() => setResuming(false)}
        />
      )}
    </div>
  );
}
