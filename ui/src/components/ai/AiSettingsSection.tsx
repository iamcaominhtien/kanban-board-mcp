import type { ReactNode } from 'react';
import { useAiSettings, useAiTeams } from '../../api/ai';
import { LineIcon } from '../ui/LineIcon';
import { LoadError } from './aiUi';
import { PauseAllButton } from './AiKillSwitch';
import { GroupHead, TeamRow } from './settings/settingsUi';
import { LimitSettings, RunRules, RunnerCard } from './settings/RunningSettings';
import './settings/teamOwn.css';
import { KnowledgeSection } from './knowledge/KnowledgeSection';
import { RolePacksSection } from './packs/RolePacksSection';
import { RepositoriesSection } from './code/RepositoriesSection';
import { SkillsPluginsSection } from './tools/SkillsPluginsSection';
import './aiPage.css';

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
          <div aria-busy="true" data-testid="ai-settings-loading" style={{ display: 'grid', gap: 12 }}>
            <div className="ai-skel" style={{ height: 96 }} />
            <div className="ai-skel" style={{ height: 220 }} />
          </div>
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
            <RunnerCard />
          </>
        )}
      </section>

      <section className="ai-group" id="ai-tools" aria-labelledby="ai-tools-h" data-toc="Skills & plugins">
        <GroupTitle
          id="ai-tools-h"
          title="Skills & plugins"
          hint="What the teams can use besides the board's own tools."
        />
        <SkillsPluginsSection projectId={projectId} />
      </section>

      <section className="ai-group" id="ai-memory" aria-labelledby="ai-memory-h" data-toc="Memory">
        <GroupTitle
          id="ai-memory-h"
          title="Memory"
          hint="What every run is told about the project, and what the teams learned while they worked."
        />
        <KnowledgeSection projectId={projectId} />
      </section>

      <section className="ai-group" id="ai-packs" aria-labelledby="ai-packs-h" data-toc="Role packs">
        <GroupTitle
          id="ai-packs-h"
          title="Role packs"
          hint="Everything that makes an AI a role, in one pack: who it is, its model, what it hands in. A team is made from packs; you can edit them for this project."
        />
        <RolePacksSection projectId={projectId} />
      </section>

      <section className="ai-group" id="ai-repos" aria-labelledby="ai-repos-h" data-toc="Repositories">
        <GroupTitle
          id="ai-repos-h"
          title="Repositories"
          hint="Where the AIs work on the project's code, and how a finished ticket leaves it."
        />
        <RepositoriesSection projectId={projectId} />
      </section>
    </div>
  );
}
