import { useEffect, useState, type ReactNode } from 'react';
import { aiApi, useAiMutation, useAiSettings, useAiTeams } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiSettings, PermissionMode } from '../../types/ai';
import { LineIcon } from '../ui/LineIcon';
import { LoadError } from './aiUi';
import { PauseAllButton } from './AiKillSwitch';
import { PERMISSION_MODES } from './teamOptions';
import { GroupHead, NumberSetting, TeamRow } from './settings/settingsUi';
import './settings/teamOwn.css';
import { KnowledgeSection } from './knowledge/KnowledgeSection';
import { LessonsSettings } from './knowledge/LessonsSettings';
import { RepositoriesSection } from './code/RepositoriesSection';
import { SkillsPluginsSection } from './tools/SkillsPluginsSection';
import './aiPage.css';

/** Save a partial change of the project's AI settings; the error of the last try. */
function useSave(projectId: string) {
  const [error, setError] = useState<string | null>(null);
  const patch = useAiMutation((body: Partial<AiSettings>) => aiApi.updateSettings(projectId, body));
  const save = async (body: Partial<AiSettings>) => {
    setError(null);
    try {
      await patch.mutateAsync(body);
    } catch (e) {
      setError(extractError(e));
    }
  };
  return { save, error, pending: patch.isPending };
}

/** The permission mode of new runs and the deny list that holds in both modes. */
function RunRules({ projectId, settings }: { projectId: string; settings: AiSettings }) {
  const { save, error } = useSave(projectId);
  const [deny, setDeny] = useState(settings.denyList.join('\n'));
  useEffect(() => setDeny(settings.denyList.join('\n')), [settings.denyList]);
  return (
    <section className="to-sec" data-setting="ai-rules" data-testid="ai-rules">
      <div className="to-group">
        <GroupHead
          title="How teams run"
          hint="The default for every team of the project; a team can pick its own mode on its page."
        />
        <TeamRow title="Permission mode" hint="Takes effect on the next run.">
          <div style={{ display: 'flex', gap: 6 }} role="radiogroup" aria-label="Permission mode">
            {PERMISSION_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={settings.permissionMode === m.id}
                title={m.hint}
                className={`tw-chipbtn ${settings.permissionMode === m.id ? 'tw-chipbtn-on' : ''}`}
                onClick={() =>
                  settings.permissionMode !== m.id && void save({ permissionMode: m.id as PermissionMode })
                }
                data-testid={`settings-permission-${m.id}`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </TeamRow>
        <TeamRow
          title="Deny list"
          hint="One Claude Code tool rule per line, such as Bash(git push --force:*). A run never uses what is listed, in either mode."
        >
          <textarea
            className="ai-textarea"
            style={{ width: 320, minHeight: 80 }}
            aria-label="Deny list"
            value={deny}
            onChange={(e) => setDeny(e.target.value)}
            onBlur={() => {
              const rules = deny
                .split('\n')
                .map((r) => r.trim())
                .filter(Boolean);
              if (rules.join('\n') !== settings.denyList.join('\n')) void save({ denyList: rules });
            }}
            data-testid="settings-deny-list"
          />
        </TeamRow>
      </div>
      {error && <div className="ai-error-text">{error}</div>}
    </section>
  );
}

/** Caps and budgets for the whole project. */
function LimitSettings({ projectId, settings }: { projectId: string; settings: AiSettings }) {
  const { save, error } = useSave(projectId);
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
    <section className="to-sec" data-setting="ai-limits" data-testid="ai-limits">
      <div className="to-group">
        <GroupHead title="Limits" hint="Caps for the whole project. Changes take effect on the next run." />
        <TeamRow title="Daily cap" hint="Teams pause once the project has spent this much in a day. Empty is no cap.">
          {num('Daily cap ($)', settings.boardDailyCap, (v) => void save({ boardDailyCap: money(v) }), {
            min: 0,
            step: '0.5',
            placeholder: 'No cap',
          })}
          <span className="ai-hint">dollars</span>
        </TeamRow>
        <TeamRow title="Monthly budget" hint="Teams pause once the month's spend reaches this. Empty is no budget.">
          {num('Monthly budget ($)', settings.boardMonthlyBudget, (v) => void save({ boardMonthlyBudget: money(v) }), {
            min: 0,
            step: '1',
            placeholder: 'No budget',
          })}
          <span className="ai-hint">dollars</span>
        </TeamRow>
        <TeamRow title="Runs a day" hint="At most this many runs start in a day. Empty is no limit.">
          {num('Runs a day', settings.boardRunsPerDay, (v) => void save({ boardRunsPerDay: money(v) }), {
            min: 1,
            placeholder: 'No limit',
          })}
        </TeamRow>
        <TeamRow title="At once on this project" hint="Runs past this wait in line; nothing is lost.">
          <NumberSetting
            value={settings.boardMaxParallel}
            min={1}
            label="Runs at once on this project"
            testId="settings-at-once"
            onSave={(n) => void save({ boardMaxParallel: n })}
          />
          <span className="ai-hint">at a time</span>
        </TeamRow>
        <TeamRow
          title="Memory of one run"
          hint="A run whose Claude Code goes over this many MB is restarted. 0 is no limit."
        >
          <NumberSetting
            value={settings.runMemoryLimitMb}
            min={0}
            width={90}
            label="Memory of one run (MB)"
            testId="settings-memory-limit"
            onSave={(n) => void save({ runMemoryLimitMb: n })}
          />
          <span className="ai-hint">MB</span>
        </TeamRow>
        <TeamRow
          title="Auto-compact at"
          hint="When a session's context is this full, Claude Code summarizes the older part by itself and the AI carries on (it pauses a few seconds between two steps). 0 is Claude Code's own level."
        >
          <NumberSetting
            value={typeof settings.ops.autoCompactPct === 'number' ? settings.ops.autoCompactPct : 0}
            min={0}
            width={90}
            label="Auto-compact at (%)"
            testId="settings-auto-compact"
            onSave={(n) => void save({ ops: { autoCompactPct: n > 0 ? Math.max(30, Math.min(95, n)) : null } })}
          />
          <span className="ai-hint">% of the context</span>
        </TeamRow>
      </div>
      {error && <div className="ai-error-text">{error}</div>}
    </section>
  );
}

/** The title of one of the groups of the page, with what it decides. */
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

/** A part of a group: a small heading over the section it names. */
function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ai-part">
      <div className="ai-part-title">{title}</div>
      {children}
    </div>
  );
}

/** Settings › AI: how teams run, the limits, the kill switch, skills and plugins, knowledge and repositories. */
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
  const settings = useAiSettings(projectId);
  const teams = useAiTeams(projectId);
  return (
    <div
      className="ai-root"
      style={{ display: 'flex', flexDirection: 'column' }}
      data-testid="settings-ai"
      data-setting="board-ai"
    >
      <section className="ai-group" id="ai-run" aria-labelledby="ai-run-h" data-toc="Running the teams">
        <GroupTitle
          id="ai-run-h"
          title="Running the teams"
          hint="How AI teams of this project work, what they may not do, and the switch that stops them all."
          actions={
            <>
              {onManage && (
                <button type="button" className="ai-link" onClick={onManage} data-testid="manage-ai-members">
                  Manage AI teams
                  <LineIcon name="chevronRight" size={13} />
                </button>
              )}
              {onManageAccounts && (
                <button
                  type="button"
                  className="st-btn st-btn-sm"
                  onClick={onManageAccounts}
                  data-testid="manage-ai-accounts"
                >
                  <LineIcon name="external" size={14} />
                  Manage AI accounts
                </button>
              )}
            </>
          }
        />
        {settings.isError ? (
          <LoadError what="the AI settings" error={settings.error} onRetry={() => void settings.refetch()} />
        ) : !settings.data ? (
          <div className="ai-skel" style={{ height: 120 }} aria-busy="true" />
        ) : (
          <>
            <section className="to-sec" data-testid="ai-kill-switch">
              <div className="to-group">
                <GroupHead
                  title="Pause all AI"
                  hint="Nothing new starts and every message to a team waits until you resume."
                />
                <TeamRow title={settings.data.pausedAll ? 'AI is paused' : 'AI is working'}>
                  <PauseAllButton projectId={projectId} settings={settings.data} members={teams.data ?? []} />
                </TeamRow>
              </div>
            </section>
            <RunRules projectId={projectId} settings={settings.data} />
            <LimitSettings projectId={projectId} settings={settings.data} />
          </>
        )}
      </section>

      <section className="ai-group" id="ai-tools" aria-labelledby="ai-tools-h" data-toc="Skills and plugins">
        <GroupTitle
          id="ai-tools-h"
          title="Skills & plugins"
          hint="What the teams can use besides the board's own tools."
        />
        <SkillsPluginsSection projectId={projectId} />
      </section>

      <section className="ai-group" id="ai-knowledge" aria-labelledby="ai-knowledge-h" data-toc="Knowledge and code">
        <GroupTitle
          id="ai-knowledge-h"
          title="Knowledge and code"
          hint="What every run is told about the project, and where the AIs work on it."
        />
        <Sub title="Lessons">
          <LessonsSettings projectId={projectId} />
        </Sub>
        <Sub title="Project knowledge">
          <KnowledgeSection projectId={projectId} />
        </Sub>
        <Sub title="Repositories">
          <RepositoriesSection projectId={projectId} />
        </Sub>
      </section>
    </div>
  );
}
