import { useEffect, useState } from 'react';
import { useUpdateProject } from '../../api/projects';
import { extractError } from '../../api/extractError';
import type { Project } from '../../types/ticket';
import { Field, SettingRow, SettingsCard, Switch } from './settingsUi';
import styles from './SettingsPage.module.css';

const TOKENS = ['{project}', '{ticket_id}', '{branch}'];

/** Settings › Repositories: the Git settings of one project (design/screens/settings-pages.md F, Project › Repositories). */
export function ProjectRepoRow({ project }: { project: Project }) {
  const updateProject = useUpdateProject();
  const [draftRepo, setDraftRepo] = useState(project.repoPath ?? '');
  const [draftTemplate, setDraftTemplate] = useState(project.worktreeTemplate ?? '');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setDraftRepo(project.repoPath ?? '');
    setDraftTemplate(project.worktreeTemplate ?? '');
    setStatus(null);
  }, [project.id, project.repoPath, project.worktreeTemplate]);

  async function save(body: Parameters<typeof updateProject.mutateAsync>[0], okText: string) {
    setStatus(null);
    try {
      await updateProject.mutateAsync(body);
      setStatus({ ok: true, text: okText });
    } catch (err) {
      setStatus({ ok: false, text: extractError(err) });
    }
  }

  const linked = !!project.repoPath;
  const repoChanged = draftRepo.trim() !== (project.repoPath ?? '');
  const templateChanged = draftTemplate.trim() !== (project.worktreeTemplate ?? '');
  const busy = updateProject.isPending;

  return (
    <SettingsCard
      title={`${project.name} (${project.prefix})`}
      hint="Link a Git repository to create branches and worktrees from tickets. A ticket can override it from its branch menu."
      setting="repo-path"
      status={status ?? (linked ? { ok: true, text: 'Repository linked' } : null)}
      testId="repo-settings"
    >
      <Field label="Repository path" htmlFor={`repo-${project.id}`}>
        <div className={styles.row} style={{ flexWrap: 'nowrap' }}>
          <input
            id={`repo-${project.id}`}
            className={`${styles.input} ${styles.mono}`}
            type="text"
            placeholder="/path/to/git/repo"
            value={draftRepo}
            onChange={(e) => {
              setDraftRepo(e.target.value);
              setStatus(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && repoChanged && draftRepo.trim())
                void save({ id: project.id, repo_path: draftRepo.trim() }, 'Repository linked');
            }}
          />
          {repoChanged && draftRepo.trim() && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={busy}
              onClick={() => void save({ id: project.id, repo_path: draftRepo.trim() }, 'Repository linked')}
            >
              Apply
            </button>
          )}
          {linked && (
            <button
              type="button"
              className={styles.btn}
              disabled={busy}
              onClick={() => void save({ id: project.id, repo_path: '' }, 'Repository unlinked')}
            >
              Unlink
            </button>
          )}
        </div>
      </Field>

      <div data-setting="worktree" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field
          label="Worktree path template"
          htmlFor={`wt-${project.id}`}
          hint={
            <>
              Where new worktrees are created. Insert:{' '}
              {TOKENS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={styles.code}
                  style={{ border: 'none', cursor: 'pointer', marginRight: 4 }}
                  disabled={!linked}
                  onClick={() => setDraftTemplate((prev) => prev + t)}
                  title={`Insert ${t}`}
                >
                  {t}
                </button>
              ))}
            </>
          }
        >
          <div className={styles.row} style={{ flexWrap: 'nowrap' }}>
            <input
              id={`wt-${project.id}`}
              className={`${styles.input} ${styles.mono}`}
              type="text"
              placeholder="../worktrees/{project}/{ticket_id}-{branch}"
              value={draftTemplate}
              disabled={!linked}
              onChange={(e) => {
                setDraftTemplate(e.target.value);
                setStatus(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && templateChanged)
                  void save({ id: project.id, worktree_template: draftTemplate.trim() || null }, 'Saved');
              }}
            />
            {templateChanged && (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={busy}
                onClick={() => void save({ id: project.id, worktree_template: draftTemplate.trim() || null }, 'Saved')}
              >
                Apply
              </button>
            )}
          </div>
        </Field>

        <div className={styles.divider} />

        <SettingRow
          title="Create a worktree by default"
          hint={linked ? 'New branches get their own worktree.' : 'Link a repository to turn this on.'}
        >
          <Switch
            on={!!project.worktreeByDefault}
            label="Create a worktree by default"
            disabled={!linked || busy}
            onChange={(on) => void save({ id: project.id, worktree_by_default: on }, 'Saved')}
          />
        </SettingRow>
      </div>
    </SettingsCard>
  );
}
