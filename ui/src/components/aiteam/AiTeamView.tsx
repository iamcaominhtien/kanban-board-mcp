import { useState } from 'react';
import { useTeamNow, useTeamStepped } from '../../api/aiTeam';
import type { TeamRange } from '../../types/aiTeam';
import { NowTab, type NowActions } from './NowTab';
import { FlowTab } from './FlowTab';
import { HealthTab } from './HealthTab';
import { SteppedInTab } from './SteppedInTab';
import { Icon, ICONS } from './teamUi';
import './aiTeam.css';

type Tab = 'now' | 'flow' | 'stepped' | 'health';

const TABS: { id: Tab; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'flow', label: 'Flow' },
  { id: 'stepped', label: 'You stepped in' },
  { id: 'health', label: 'Health' },
];

interface Props {
  projectId: string;
  projectName: string;
  onOpenTicket: (ticketId: string) => void;
  onOpenMember: (memberId: string) => void;
  onOpenDocsPage: (pageId: string) => void;
}

/** The AI Team view (design/screens/ai-team.md): what the AIs are doing, how work moves, where people stepped in. */
export function AiTeamView({ projectId, projectName, onOpenTicket, onOpenMember, onOpenDocsPage }: Props) {
  const [tab, setTab] = useState<Tab>('now');
  const [flowTicket, setFlowTicket] = useState<string | null>(null);
  // Now reads best for today, the other tabs for a week; each tab keeps the range the person picked
  const [ranges, setRanges] = useState<Record<Tab, TeamRange>>({
    now: 'today',
    flow: '7d',
    stepped: '7d',
    health: '7d',
  });
  const range = ranges[tab];
  const setRange = (r: TeamRange) => setRanges({ ...ranges, [tab]: r });
  const { data, isLoading, isError, dataUpdatedAt } = useTeamNow(projectId, ranges.now);
  const stepped = useTeamStepped(projectId, ranges.stepped);
  const actions: NowActions = {
    onOpenTicket,
    onOpenMember,
    onOpenDocsPage,
    onSeeFlow: () => setTab('flow'),
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
              {t.id === 'stepped' && stepped.data ? (
                <b style={{ fontWeight: 700, color: '#7A5A06' }}>{stepped.data.totals.touches}</b>
              ) : null}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <select
          className="at-range"
          value={range}
          onChange={(e) => setRange(e.target.value as TeamRange)}
          aria-label="Range"
        >
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
        <span className="at-hint">
          {isError ? 'Not live: reconnecting' : updated != null ? `Live · updated ${updated} s ago` : ''}
        </span>
      </div>

      {tab === 'flow' ? (
        <FlowTab
          key={flowTicket ?? 'map'}
          projectId={projectId}
          range={range}
          focusTicket={flowTicket}
          actions={{ onOpenTicket, onOpenDocsPage }}
        />
      ) : tab === 'health' ? (
        <HealthTab
          projectId={projectId}
          range={range}
          actions={{
            onOpenTicket,
            onOpenMember,
            onOpenDocsPage,
            onOpenFlow: (id) => {
              setFlowTicket(id);
              setTab('flow');
            },
          }}
        />
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
      ) : isLoading || !data ? (
        <div className="at-hint">{isError ? "Couldn't load the AI team." : 'Loading the AI team…'}</div>
      ) : (
        <NowTab data={data} range={range} actions={actions} />
      )}
    </div>
  );
}
