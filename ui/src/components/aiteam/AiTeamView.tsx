import { useEffect, useState } from 'react';
import { NowTab, type NowActions } from './NowTab';
import { HistoryTab } from './HistoryTab';
import { ResourcesTab } from './ResourcesTab';
import { useKnowledge } from '../../api/aiKnowledge';
import { KnowledgeSection, memoryWaiting } from '../ai/knowledge/KnowledgeSection';
import { OPEN_RUN_EVENT, takePendingRun } from './runLink';
import { TeamPage } from './TeamPage';
import { FlowTab } from './FlowTab';
import { SteppedInTab } from './SteppedInTab';
import { HealthTab } from './HealthTab';
import { useTouches } from '../../api/aiTouches';
import { OPEN_TIMELINE_EVENT, parseTimelineLink, takePendingTimeline, type TimelineLink } from './timelineLink';
import './aiTeam.css';

type Tab = 'now' | 'flow' | 'history' | 'stepped' | 'health' | 'resources' | 'memory';

const TABS: { id: Tab; label: string }[] = [
  { id: 'now', label: 'Now' },
  // the map and the timeline of the teams, by scope (the old tab Timeline is a view of it)
  { id: 'flow', label: 'Flow' },
  { id: 'history', label: 'Run history' },
  // every time a person had to touch the work (KBM-21)
  { id: 'stepped', label: 'You stepped in' },
  // is the AI team healthy, per team (KBM-22)
  { id: 'health', label: 'Health' },
  // the machine, the running runs and the limits (KBM-19)
  { id: 'resources', label: 'Resources' },
  // what the AIs remember, and what waits for a person there (issue #274)
  { id: 'memory', label: 'Memory' },
];

interface Props {
  projectId: string;
  projectName: string;
  onOpenTicket: (ticketId: string) => void;
  onOpenMember: (memberId: string) => void;
}

/** The AI Team view: what the teams are doing now, what they use, what they ran and what they remember. */
export function AiTeamView({ projectId, projectName, onOpenTicket, onOpenMember }: Props) {
  // A run was asked for (a link to its detail): Run history opens on it
  const [runId, setRunId] = useState<string | null>(() => takePendingRun());
  // Flow was asked for ("Open in Timeline" on a ticket, or an address with `?aiteam=flow` / `?aiteam=timeline`): the
  // Flow tab opens on that scope and view
  const [flowLink, setFlowLink] = useState<{ link: TimelineLink; key: number } | null>(() => {
    const link = takePendingTimeline() ?? parseTimelineLink(window.location.search);
    return link ? { link, key: Date.now() } : null;
  });
  const [tab, setTab] = useState<Tab>(runId ? 'history' : flowLink ? 'flow' : 'now');
  useEffect(() => {
    const open = () => {
      const link = takePendingTimeline();
      if (!link) return;
      setFlowLink({ link, key: Date.now() });
      setTab('flow');
    };
    window.addEventListener(OPEN_TIMELINE_EVENT, open);
    return () => window.removeEventListener(OPEN_TIMELINE_EVENT, open);
  }, []);
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
  // Health sends a person to the avoidable touches: the tab opens with that mark chosen
  const [steppedMark, setSteppedMark] = useState<'avoidable' | undefined>(undefined);
  const [steppedKey, setSteppedKey] = useState(0);
  const knowledge = useKnowledge(projectId);
  const touches = useTouches(projectId, '7d');
  // A team page (its roles) replaces tab Now until the person goes back
  const [teamId, setTeamId] = useState<string | null>(null);
  const actions: NowActions = {
    onOpenTicket,
    onOpenMember,
    onOpenTeam: setTeamId,
    onOpenResources: () => setTab('resources'),
  };

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
              onClick={() => {
                setSteppedMark(undefined);
                setTab(t.id);
                if (t.id === 'now') setTeamId(null);
                // leaving Flow forgets the request it was opened with: the tab opens on its default next time
                if (t.id !== 'flow') setFlowLink(null);
              }}
            >
              {t.label}
              {t.id === 'stepped' && touches.data && touches.data.totals.touches > 0 ? (
                <b
                  style={{ fontWeight: 700, color: '#7A5A06' }}
                  title="Times a person stepped in during the last 7 days"
                  data-testid="stepped-tab-count"
                >
                  {touches.data.totals.touches}
                </b>
              ) : null}
              {t.id === 'memory' && knowledge.data && memoryWaiting(knowledge.data) > 0 ? (
                <b
                  style={{ fontWeight: 700, color: '#7A5A06' }}
                  title="Lessons proposed, and memory that may be out of date"
                  data-testid="memory-tab-count"
                >
                  {memoryWaiting(knowledge.data)}
                </b>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {tab === 'flow' ? (
        <FlowTab
          key={flowLink?.key ?? 0}
          projectId={projectId}
          projectName={projectName}
          initial={flowLink?.link ?? null}
          onOpenTicket={onOpenTicket}
        />
      ) : tab === 'history' ? (
        <HistoryTab projectId={projectId} runId={runId} onRunChange={setRunId} onOpenTicket={onOpenTicket} />
      ) : tab === 'stepped' ? (
        <SteppedInTab key={steppedKey} projectId={projectId} onOpenTicket={onOpenTicket} initialMark={steppedMark} />
      ) : tab === 'health' ? (
        <HealthTab
          projectId={projectId}
          actions={{
            onOpenTicket,
            onOpenTeam: (id) => {
              setTeamId(id);
              setTab('now');
            },
            onOpenTab: (t, mark) => {
              setSteppedMark(mark);
              setSteppedKey((k) => k + 1);
              setTab(t);
            },
          }}
        />
      ) : tab === 'resources' ? (
        <ResourcesTab projectId={projectId} onOpenTicket={onOpenTicket} />
      ) : tab === 'memory' ? (
        <div style={{ padding: '4px 0 24px', maxWidth: 920 }} data-testid="at-memory">
          <KnowledgeSection projectId={projectId} initialTab="memory" />
        </div>
      ) : teamId ? (
        <TeamPage
          projectId={projectId}
          teamId={teamId}
          onBack={() => setTeamId(null)}
          onOpenTicket={onOpenTicket}
          onOpenMember={onOpenMember}
          onOpenResources={actions.onOpenResources}
        />
      ) : (
        <NowTab projectId={projectId} actions={actions} />
      )}
    </div>
  );
}
