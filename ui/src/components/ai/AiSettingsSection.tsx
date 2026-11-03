import { LineIcon } from '../ui/LineIcon';
import { useState, type ReactNode } from 'react';
import { PermissionsCard } from './AiPermissionsCards';
import { aiApi, useAiOverview } from '../../api/ai';
import { client } from '../../api/client';
import { extractError } from '../../api/extractError';
import type { AiSettings } from '../../types/ai';
import { BoardAiPicker } from './AiDialogs';
import { AiAvatar, Toggle } from './aiUi';
import { LibraryModal } from './config/LibraryView';
import { OperationsCard } from './settings/OperationsCard';
import { GroupHead, NumberSetting, TeamRow } from './settings/settingsUi';
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

/**
 * What a run needs, together (design ai-operations K): how many runs at once on this project, beside the per-account
 * limit that lives with the accounts.
 */
function RunsAtOnce({
  projectId,
  settings,
  onManageAccounts,
  onSaved,
}: {
  projectId: string;
  settings: AiSettings;
  onManageAccounts?: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="to-sec" data-testid="ops-at-once">
      <div className="to-group">
        <GroupHead title="How many at once" hint="Runs past these limits wait in line; nothing is lost." />
        <TeamRow
          title="At once on this project"
          hint={
            <>
              Runs of this project's AI members that may work at the same time.
              {onManageAccounts && (
                <>
                  {' '}
                  Each Claude account has its own limit too:{' '}
                  <button type="button" className="ai-link" onClick={onManageAccounts}>
                    AI accounts
                  </button>
                  .
                </>
              )}
            </>
          }
        >
          <NumberSetting
            value={settings.boardMaxParallel}
            min={1}
            label="Runs at once on this project"
            testId="ops-at-once-project"
            onSave={async (n) => {
              setError(null);
              try {
                await aiApi.updateSettings(projectId, { boardMaxParallel: n });
                onSaved();
              } catch (e) {
                setError(extractError(e));
              }
            }}
          />
          <span className="ai-hint">at a time</span>
        </TeamRow>
      </div>
      {error && <div className="ai-error-text">{error}</div>}
    </section>
  );
}

const RUN_KEEP = [
  [0, 'Keep forever'],
  [30, '30 days'],
  [90, '90 days'],
  [180, '180 days'],
  [365, '1 year'],
] as const;

interface RetentionPreview {
  days: number | null;
  wouldRemove: number;
  oldest: string | null;
  keptLinked: number;
  keptThisMonth: number;
}

/**
 * History (design ai-operations K, OPS-7): how long a finished run keeps its details. Keep forever is the default, as it
 * always was; a person who picks a number of days sees what would go first, and the hourly sweep then removes the
 * details (transcript, steps, prompt and logs) of finished runs older than that. The run itself stays: its cost,
 * status, summary and links. Runs still going, runs of this month and runs another record works from stay whole.
 */
export function RunHistory({
  projectId,
  settings,
  onSaved,
}: {
  projectId: string;
  settings: AiSettings;
  onSaved: () => void;
}) {
  const saved = settings.runRetentionDays ?? 0;
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [checking, setChecking] = useState(false);
  // a number of days picked but not saved yet: it is saved only after the person has seen what would go
  const [pending, setPending] = useState<number | null>(null);
  const shown = pending ?? saved;
  const show = async (days: number) => {
    setChecking(true);
    setError(null);
    try {
      const r = await client.get<RetentionPreview>(`/projects/${projectId}/ai/history/retention`, {
        params: { days },
      });
      setPreview(r.data);
    } catch (e) {
      setError(extractError(e));
    } finally {
      setChecking(false);
    }
  };
  const save = async (days: number) => {
    setError(null);
    try {
      await aiApi.updateSettings(projectId, { runRetentionDays: days });
      setPending(null);
      setPreview(null);
      onSaved();
    } catch (err) {
      setError(extractError(err));
    }
  };
  return (
    <section className="to-sec" data-testid="ops-history">
      <div className="to-group">
        <GroupHead
          title="History"
          hint="Every run stays in the history with its cost, status, summary and links. Transcripts also follow Settings › Notifications."
        />
        <TeamRow
          title="Keep run details for"
          hint="Run details are the transcript, steps, prompt and logs; after this many days they are removed. Runs still going, runs of this month and runs a workflow, approval or pinned transcript points at keep theirs."
        >
          <select
            className="ai-select"
            aria-label="Keep run details for"
            data-testid="ops-run-retention"
            value={shown}
            onChange={(e) => {
              const days = Number(e.target.value);
              setPreview(null);
              if (days === saved) {
                setPending(null);
              } else if (days === 0) {
                void save(0); // keeping more never removes anything: saved at once
              } else {
                setPending(days);
                void show(days);
              }
            }}
          >
            {RUN_KEEP.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="st-btn st-btn-sm"
            disabled={checking || shown === 0}
            onClick={() => void show(shown)}
            data-testid="ops-run-retention-preview"
          >
            Show what would go
          </button>
        </TeamRow>
        {preview && (
          <div className="ai-hint" role="status" data-testid="ops-run-retention-result">
            {preview.wouldRemove
              ? `The details (transcripts and logs) of ${preview.wouldRemove} finished run${preview.wouldRemove === 1 ? '' : 's'} would go, the oldest ended ${preview.oldest?.slice(0, 10)}. Their cost, status, summary and links stay.`
              : 'No run details would go now.'}
            {preview.keptLinked > 0 &&
              ` ${preview.keptLinked} older run${preview.keptLinked === 1 ? '' : 's'} keep theirs because a record points at them.`}
            {preview.keptThisMonth > 0 &&
              ` ${preview.keptThisMonth} keep theirs because they count toward this month's budget.`}
          </div>
        )}
        {pending != null && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="st-btn st-btn-sm"
              onClick={() => {
                setPending(null);
                setPreview(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="st-btn st-btn-sm st-btn-primary"
              data-testid="ops-run-retention-save"
              disabled={checking}
              onClick={() => void save(pending)}
            >
              Keep {RUN_KEEP.find(([v]) => v === pending)?.[1] ?? `${pending} days`}
            </button>
          </div>
        )}
      </div>
      {error && <div className="ai-error-text">{error}</div>}
    </section>
  );
}

/** Statuses that read as trouble on the Board AI card (red dot). */
const STATUS_BAD = new Set([
  'key_invalid',
  'not_logged_in',
  'runner_missing',
  'model_retired',
  'over_budget',
  'removed',
]);

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
              {onManage && (
                <button type="button" className="ai-link" onClick={onManage} data-testid="manage-ai-members">
                  Manage AI members
                  <LineIcon name="chevronRight" size={13} />
                </button>
              )}
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
            {/* H1: eyebrow "BOARD AI · ● status", then the name */}
            <div className="ai-boardai-eyebrow">
              <span>Board AI</span>
              {boardAi && (
                <span
                  className="ai-boardai-status"
                  style={{ color: STATUS_BAD.has(boardAi.status.code) ? '#C4432A' : '#2E6F40' }}
                >
                  <span className="ai-boardai-dot" />
                  {boardAi.status.label}
                </span>
              )}
            </div>
            <b style={{ fontSize: 13.5, color: '#1E2A22' }}>{boardAi?.name ?? 'No Board AI chosen'}</b>
            <div className="ai-hint">
              {boardAi
                ? 'Answers the board chat, ticket drafting and suggestions'
                : 'Pick an AI member to answer the chatbot, ticket drafting and suggestions.'}
            </div>
          </div>
          <button type="button" className="st-btn st-btn-sm" disabled={!members.length} onClick={() => setPicker(true)}>
            <LineIcon name="refresh" size={13} />
            {boardAi ? 'Change' : 'Choose'}
          </button>
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
        {overview.data && (
          <RunsAtOnce
            projectId={projectId}
            settings={overview.data.settings}
            onManageAccounts={onManageAccounts}
            onSaved={() => void overview.refetch()}
          />
        )}
        <OperationsCard projectId={projectId} />
        {overview.data && (
          <RunHistory projectId={projectId} settings={overview.data.settings} onSaved={() => void overview.refetch()} />
        )}
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
