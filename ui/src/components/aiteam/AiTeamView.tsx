import { useEffect, useState } from 'react';
import { useTeamNow } from '../../api/aiTeam';
import type { TeamRange } from '../../types/aiTeam';
import { NowTab, type NowActions } from './NowTab';
import { ResourcesTab } from './ResourcesTab';
import { HistoryTab } from './HistoryTab';
import { useKnowledge } from '../../api/aiKnowledge';
import { KnowledgeSection, memoryWaiting } from '../ai/knowledge/KnowledgeSection';
import { OPEN_RUN_EVENT, takePendingRun } from './runLink';
import { CalendarIcon } from './teamUi';
import { MenuSelect } from '../ui/MenuSelect';
import './aiTeam.css';

type Tab = 'now' | 'resources' | 'history' | 'memory';

const TABS: { id: Tab; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'resources', label: 'Resources' },
  { id: 'history', label: 'Run history' },
  // what the AIs remember, and what waits for a person there (issue #274)
  { id: 'memory', label: 'Memory' },
];

interface Props {
  projectId: string;
  projectName: string;
  onOpenTicket: (ticketId: string) => void;
  onOpenMember: (memberId: string) => void;
}

/** The AI Team view (design/screens/ai-team.md): what the AIs are doing, what they use, what they ran and remember. */
export function AiTeamView({ projectId, projectName, onOpenTicket, onOpenMember }: Props) {
  // A run was asked for (a link to its detail): Run history opens on it
  const [runId, setRunId] = useState<string | null>(() => takePendingRun());
  const [tab, setTab] = useState<Tab>(runId ? 'history' : 'now');
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
    resources: 'today',
    history: '30d',
    memory: '30d',
  });
  const range = ranges[tab];
  const setRange = (r: TeamRange) => setRanges({ ...ranges, [tab]: r });
  const { data, isLoading, isError, dataUpdatedAt } = useTeamNow(projectId, ranges.now);
  const knowledge = useKnowledge(projectId);
  const actions: NowActions = {
    onOpenTicket,
    onOpenMember,
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
        <span style={{ flex: 1 }} />
        {tab === 'now' && (
          <MenuSelect<TeamRange>
            variant="button"
            label="Range"
            testId="at-range"
            icon={<CalendarIcon />}
            value={range}
            options={[
              { value: 'today', label: 'Today' },
              { value: '7d', label: 'Last 7 days' },
              { value: '30d', label: 'Last 30 days' },
            ]}
            onChange={setRange}
          />
        )}
        <span className="at-hint" hidden={tab === 'resources' || tab === 'history'} data-testid="range-hint">
          {isError ? 'Not live: reconnecting' : updated != null ? `Live · updated ${updated} s ago` : ''}
        </span>
      </div>

      {tab === 'history' ? (
        <HistoryTab
          projectId={projectId}
          members={data?.members ?? []}
          runId={runId}
          onRunChange={setRunId}
          onOpenTicket={onOpenTicket}
        />
      ) : tab === 'memory' ? (
        <div style={{ padding: '4px 0 24px', maxWidth: 920 }} data-testid="at-memory">
          <KnowledgeSection projectId={projectId} initialTab="memory" />
        </div>
      ) : tab === 'resources' ? (
        <ResourcesTab projectId={projectId} onOpenTicket={onOpenTicket} />
      ) : (
        <>
          {isLoading || !data ? (
            <div className="at-hint">{isError ? "Couldn't load the AI team." : 'Loading the AI team…'}</div>
          ) : (
            <NowTab data={data} range={range} actions={actions} />
          )}
        </>
      )}
    </div>
  );
}
