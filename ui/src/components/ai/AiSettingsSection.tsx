import { useState, type ReactNode } from 'react';
import { PermissionsCard } from './AiPermissionsCards';
import { aiApi, useAiOverview } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiSettings } from '../../types/ai';
import { BoardAiPicker } from './AiDialogs';
import { AiAvatar, Toggle } from './aiUi';
import { LibraryModal } from './config/LibraryView';
import { OperationsCard } from './settings/OperationsCard';
import { GroupHead, TeamRow } from './settings/settingsUi';
import './settings/teamOwn.css';
import { KnowledgeSection } from './knowledge/KnowledgeSection';
import { RepositoriesSection } from './code/RepositoriesSection';
import { SkillsPluginsSection } from './tools/SkillsPluginsSection';
import { TeamSection } from './packs/TeamSection';
import { WorkflowsSection } from './workflow/WorkflowsSection';
import { BoardAiSection } from './board/BoardAiSection';
import { StandingOrdersSection } from './board/StandingOrdersSection';
import './aiPage.css';

const EXPIRY = [
  [1, '1 h'],
  [4, '4 h'],
  [24, '24 h'],
  [72, '3 days'],
] as const;

/** Safe mode and the board-wide limits (design/screens/ai-safety-cost.md, B5, C4, D5, G). */
function AiSafetySettings({ projectId, settings }: { projectId: string; settings: AiSettings }) {
  const [error, setError] = useState<string | null>(null);
  const save = async (body: Partial<AiSettings>) => {
    setError(null);
    try {
      await aiApi.updateSettings(projectId, body);
    } catch (e) {
      setError(extractError(e));
    }
  };
  const money = (v: string) => (v.trim() === '' ? null : Number(v));
  const num = (label: string, value: number | null | undefined, onSave: (v: string) => void, extra: object = {}) => (
    <input
      className="ai-input"
      type="number"
      style={{ width: 110 }}
      aria-label={label}
      defaultValue={value ?? ''}
      onBlur={(e) => onSave(e.target.value)}
      {...extra}
    />
  );
  return (
    <section className="to-sec" data-setting="ai-limits">
      <div className="to-group">
        <GroupHead title="Safety" hint="What AI members may do at all." />
        <div data-setting="safe-mode">
          <TeamRow title="Safe mode" hint="AI members may only read and comment; every other action is blocked.">
            <Toggle
              on={settings.safeMode}
              label="Safe mode"
              testId="ai-safe-mode"
              onChange={(v) => void save({ safeMode: v })}
            />
          </TeamRow>
        </div>
      </div>
      <div className="to-rule" />
      <div className="to-group">
        <GroupHead title="Limits and budgets" hint="Caps for the whole board. Changes take effect on the next run." />
        <TeamRow
          title="Board daily cap"
          hint="AI members of this project are paused once it has spent this much in a day, until 00:00. Empty is no cap."
        >
          {num('Board daily cap ($)', settings.boardDailyCap, (v) => void save({ boardDailyCap: money(v) }), {
            min: 0,
            step: '0.5',
            placeholder: 'No cap',
          })}
          <span className="ai-hint">dollars</span>
        </TeamRow>
        <TeamRow
          title="Board monthly budget"
          hint="AI members are paused once the month’s spend reaches this. Empty is no budget."
        >
          {num(
            'Board monthly budget ($)',
            settings.boardMonthlyBudget,
            (v) => void save({ boardMonthlyBudget: money(v) }),
            { min: 0, step: '1', placeholder: 'No budget' },
          )}
          <span className="ai-hint">dollars</span>
        </TeamRow>
        <TeamRow title="Max chain depth" hint="How many times an AI may hand work to another AI.">
          {num('Max chain depth', settings.maxChainDepth, (v) => void save({ maxChainDepth: Number(v) }), {
            min: 1,
            max: 10,
          })}
        </TeamRow>
        <TeamRow
          title="Scheduled and AI-started runs per ticket a day"
          hint="A loop guard: how many runs a schedule or another AI may start on one ticket in a day. A person’s runs are not counted."
        >
          {num(
            'Scheduled and AI-started runs per ticket a day',
            settings.runsPerTicketPerDay,
            (v) => void save({ runsPerTicketPerDay: Number(v) }),
            {
              min: 1,
              max: 50,
            },
          )}
        </TeamRow>
        <TeamRow title="Approvals expire after" hint="How long an approval request waits for a person.">
          <span className="to-seg" role="group" aria-label="Approvals expire after">
            {EXPIRY.map(([h, label]) => (
              <button
                key={h}
                type="button"
                aria-pressed={settings.approvalExpiryHours === h}
                onClick={() => void save({ approvalExpiryHours: h })}
              >
                {label}
              </button>
            ))}
          </span>
        </TeamRow>
      </div>
      {error && <div className="ai-error-text">{error}</div>}
    </section>
  );
}

const GROUPS = [
  ['ai-board', 'Board AI'],
  ['ai-safety', 'Safety and limits'],
  ['ai-operations', 'Running the team'],
  ['ai-members', 'Members and workflows'],
  ['ai-knowledge', 'Knowledge and code'],
] as const;

/** The title of one of the five groups of the page, with what it decides. */
function GroupTitle({ id, title, hint }: { id: string; title: string; hint: string }) {
  return (
    <div>
      <h2 className="ai-group-title" id={id}>
        {title}
      </h2>
      <div className="ai-hint">{hint}</div>
    </div>
  );
}

/** A part of a group: a small heading over the section it names. */
function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ai-sub">
      <div className="ai-sub-title">{title}</div>
      {children}
    </div>
  );
}

/** Settings › AI: the Board AI selector, safe mode and the board-wide limits (A4). The board assistant has its own page. */
export function AiSettingsSection({
  projectId,
  onManage,
  onManageAccounts,
}: {
  projectId: string;
  onManage?: () => void;
  /** Opens the AI accounts tab of the Members page. */
  onManageAccounts?: () => void;
}) {
  const overview = useAiOverview(projectId);
  const [picker, setPicker] = useState(false);
  const [library, setLibrary] = useState(false);
  const members = overview.data?.members ?? [];
  const boardAi = members.find((m) => m.id === overview.data?.settings.boardAiId);
  return (
    <div
      className="ai-root"
      style={{ display: 'flex', flexDirection: 'column' }}
      data-testid="settings-ai"
      data-setting="board-ai"
    >
      <nav className="ai-page-nav" aria-label="On this page">
        <span className="ai-page-nav-l">On this page</span>
        {GROUPS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
          >
            {label}
          </button>
        ))}
      </nav>

      <section className="ai-group" id="ai-board" aria-labelledby="ai-board-h">
        <GroupTitle
          id="ai-board-h"
          title="Board AI"
          hint="Who answers board-wide requests, and what it may do by itself."
        />
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="ai-link"
            data-testid="open-library"
            onClick={() => setLibrary(true)}
            style={{ marginRight: 12 }}
          >
            Library
          </button>
          {onManageAccounts && (
            <button
              type="button"
              className="ai-link"
              onClick={onManageAccounts}
              style={{ marginRight: 12 }}
              data-testid="manage-ai-accounts"
            >
              Manage AI accounts
            </button>
          )}
          {onManage && (
            <button type="button" className="ai-link" onClick={onManage}>
              Manage AI members
            </button>
          )}
        </div>
        <div
          className="ai-card"
          style={{
            padding: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: '#F1F8F3',
            borderColor: '#BFDCC7',
          }}
        >
          {boardAi && <AiAvatar provider={boardAi.provider} color={boardAi.color} glyph={boardAi.glyph} size={32} />}
          <div style={{ flex: 1 }}>
            <div className="ai-label" style={{ color: '#2E6F40', display: 'flex', alignItems: 'center', gap: 6 }}>
              Board AI
              {boardAi && (
                <span
                  className="ai-chip"
                  style={{
                    height: 18,
                    background: '#EAF5ED',
                    color: '#2E6F40',
                    textTransform: 'none',
                    letterSpacing: 0,
                  }}
                >
                  {boardAi.status.label}
                </span>
              )}
            </div>
            <div className="ai-hint">
              Used for the chatbot, ticket drafting, suggestions and board management. Currently{' '}
              <b style={{ color: '#1E2A22' }}>{boardAi?.name ?? 'not chosen'}</b>.
            </div>
          </div>
          <button type="button" className="ai-btn ai-btn-sm" disabled={!members.length} onClick={() => setPicker(true)}>
            Change
          </button>
        </div>
        <div className="ai-muted">
          Changing it never affects who is assigned to tickets; it only picks which AI answers board-wide requests.
        </div>
        <Sub title="What the Board AI may do by itself">
          <BoardAiSection projectId={projectId} />
        </Sub>
        <StandingOrdersSection projectId={projectId} />
      </section>

      <section className="ai-group" id="ai-safety" aria-labelledby="ai-safety-h">
        <GroupTitle
          id="ai-safety-h"
          title="Safety and limits"
          hint="Safe mode, how much the AIs do on their own, the board-wide caps and how long an approval waits."
        />
        {overview.data && <AiSafetySettings projectId={projectId} settings={overview.data.settings} />}
        <PermissionsCard projectId={projectId} />
      </section>

      <section className="ai-group" id="ai-operations" aria-labelledby="ai-operations-h">
        <GroupTitle
          id="ai-operations-h"
          title="Running the team"
          hint="When the board looks at a silent run, how work reaches the team, and how far it goes on its own."
        />
        <OperationsCard projectId={projectId} />
      </section>

      <section className="ai-group" id="ai-members" aria-labelledby="ai-members-h">
        <GroupTitle
          id="ai-members-h"
          title="Members and workflows"
          hint="Who is on the team, the steps a ticket goes through, and the tools each member has."
        />
        <Sub title="Role packs and a team for this project">
          <TeamSection projectId={projectId} />
        </Sub>
        <Sub title="Workflows">
          <WorkflowsSection projectId={projectId} />
        </Sub>
        <Sub title="Skills & plugins">
          <SkillsPluginsSection projectId={projectId} />
        </Sub>
      </section>

      <section className="ai-group" id="ai-knowledge" aria-labelledby="ai-knowledge-h">
        <GroupTitle
          id="ai-knowledge-h"
          title="Knowledge and code"
          hint="What every run is told about the project, and where the AIs work on it."
        />
        <Sub title="Project knowledge">
          <KnowledgeSection projectId={projectId} />
        </Sub>
        <Sub title="Repositories">
          <RepositoriesSection projectId={projectId} />
        </Sub>
      </section>
      {library && <LibraryModal projectId={projectId} onClose={() => setLibrary(false)} />}
      {picker && overview.data && (
        <BoardAiPicker
          projectId={projectId}
          members={members}
          currentId={overview.data.settings.boardAiId}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}
