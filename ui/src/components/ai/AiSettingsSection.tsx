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

/** The title of one of the five groups of the page, with what it decides. */
function GroupTitle({ id, title, hint, actions }: { id: string; title: string; hint: string; actions?: ReactNode }) {
  return (
    <div className="ai-group-head">
      <div>
        <h2 className="ai-group-title" id={id}>
          {title}
        </h2>
        <div className="ai-group-hint">{hint}</div>
      </div>
      {actions && <div className="ai-group-actions">{actions}</div>}
    </div>
  );
}

const ExternalIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);

/** A part of a group: a small heading over the section it names. */
function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ai-part">
      <div className="ai-part-title">{title}</div>
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
      <section className="ai-group" id="ai-board" aria-labelledby="ai-board-h" data-toc="Board AI">
        <GroupTitle
          id="ai-board-h"
          title="Board AI"
          hint="Answers board-wide requests: chat, ticket drafting and suggestions. Changing it never affects who is assigned to tickets."
          actions={
            <>
              <button
                type="button"
                className="st-btn st-btn-sm"
                data-testid="open-library"
                onClick={() => setLibrary(true)}
              >
                Library
              </button>
              {onManageAccounts && (
                <button
                  type="button"
                  className="st-btn st-btn-sm"
                  onClick={onManageAccounts}
                  data-testid="manage-ai-accounts"
                >
                  {ExternalIcon}
                  Manage AI accounts
                </button>
              )}
            </>
          }
        />
        <div className="ai-boardai">
          {boardAi ? (
            <AiAvatar provider={boardAi.provider} color={boardAi.color} glyph={boardAi.glyph} size={32} />
          ) : (
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#6D5DD3"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ flexShrink: 0 }}
            >
              <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
            </svg>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <b style={{ fontSize: 13, color: '#1E2A22' }}>{boardAi?.name ?? 'No Board AI chosen'}</b>
            <div className="ai-hint">
              {boardAi
                ? `${boardAi.status.label} · answers the board chat, ticket drafting and suggestions`
                : 'Pick an AI member to answer the chatbot, ticket drafting and suggestions.'}
            </div>
          </div>
          <button type="button" className="st-btn st-btn-sm" disabled={!members.length} onClick={() => setPicker(true)}>
            {boardAi ? 'Change' : 'Choose'}
          </button>
          {onManage && (
            <button type="button" className="st-btn st-btn-sm" onClick={onManage}>
              {ExternalIcon}
              Manage AI members
            </button>
          )}
        </div>
        <Sub title="What the Board AI may do by itself">
          <BoardAiSection projectId={projectId} />
        </Sub>
        <StandingOrdersSection projectId={projectId} />
      </section>

      <section className="ai-group" id="ai-safety" aria-labelledby="ai-safety-h" data-toc="Safety and limits">
        <GroupTitle
          id="ai-safety-h"
          title="Safety and limits"
          hint="Safe mode, how much the AIs do on their own, the board-wide caps and how long an approval waits."
        />
        {overview.data && <AiSafetySettings projectId={projectId} settings={overview.data.settings} />}
        <PermissionsCard projectId={projectId} />
      </section>

      <section className="ai-group" id="ai-operations" aria-labelledby="ai-operations-h" data-toc="Running the team">
        <GroupTitle
          id="ai-operations-h"
          title="Running the team"
          hint="When the board looks at a silent run, how work reaches the team, and how far it goes on its own."
        />
        <OperationsCard projectId={projectId} />
      </section>

      <section className="ai-group" id="ai-members" aria-labelledby="ai-members-h" data-toc="Members and workflows">
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

      <section className="ai-group" id="ai-knowledge" aria-labelledby="ai-knowledge-h" data-toc="Knowledge and code">
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
