import { useEffect, useState } from 'react';
import { NowTab, type NowActions } from './NowTab';
import { HistoryTab } from './HistoryTab';
import { useKnowledge } from '../../api/aiKnowledge';
import { KnowledgeSection, memoryWaiting } from '../ai/knowledge/KnowledgeSection';
import { OPEN_RUN_EVENT, takePendingRun } from './runLink';
import { TimelineTab } from './TimelineTab';
import { OPEN_TIMELINE_EVENT, takePendingTimeline, type TimelineLink } from './timelineLink';
import './aiTeam.css';

type Tab = 'now' | 'timeline' | 'history' | 'memory';

const TABS: { id: Tab; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'timeline', label: 'Timeline' },
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

/** The AI Team view: what the teams are doing now, what they use, what they ran and what they remember. */
export function AiTeamView({ projectId, projectName, onOpenTicket, onOpenMember }: Props) {
  // A run was asked for (a link to its detail): Run history opens on it
  const [runId, setRunId] = useState<string | null>(() => takePendingRun());
  // The Timeline was asked for ("Open in Timeline" on a ticket): the Timeline tab opens on it
  const [timelineLink, setTimelineLink] = useState<{ link: TimelineLink; key: number } | null>(() => {
    const link = takePendingTimeline();
    return link ? { link, key: Date.now() } : null;
  });
  const [tab, setTab] = useState<Tab>(runId ? 'history' : timelineLink ? 'timeline' : 'now');
  useEffect(() => {
    const open = () => {
      const link = takePendingTimeline();
      if (!link) return;
      setTimelineLink({ link, key: Date.now() });
      setTab('timeline');
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
  const knowledge = useKnowledge(projectId);
  const actions: NowActions = { onOpenTicket, onOpenMember };

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

      {tab === 'timeline' ? (
        <TimelineTab
          key={timelineLink?.key ?? 0}
          projectId={projectId}
          initial={timelineLink?.link ?? null}
          actions={{ onOpenTicket, onOpenDocsPage: () => undefined }}
        />
      ) : tab === 'history' ? (
        <HistoryTab projectId={projectId} runId={runId} onRunChange={setRunId} onOpenTicket={onOpenTicket} />
      ) : tab === 'memory' ? (
        <div style={{ padding: '4px 0 24px', maxWidth: 920 }} data-testid="at-memory">
          <KnowledgeSection projectId={projectId} initialTab="memory" />
        </div>
      ) : (
        <NowTab projectId={projectId} actions={actions} />
      )}
    </div>
  );
}
