import { useEffect, useState } from 'react';
import { useUpdateProject } from '../../api/projects';
import { extractError } from '../../api/extractError';
import type { Project } from '../../types/ticket';
import styles from './SettingsPage.module.css';

/** Git settings of one project: repository path, worktree template and default. */
export function ProjectRepoRow({ project }: { project: Project }) {
  const updateProject = useUpdateProject();
  const [draftRepo, setDraftRepo] = useState(project.repoPath ?? '');
  const [draftTemplate, setDraftTemplate] = useState(project.worktreeTemplate ?? '');
  const [worktreeByDefault, setWorktreeByDefault] = useState(project.worktreeByDefault ?? false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setDraftRepo(project.repoPath ?? '');
    setDraftTemplate(project.worktreeTemplate ?? '');
    setWorktreeByDefault(project.worktreeByDefault ?? false);
  }, [project.repoPath, project.worktreeTemplate, project.worktreeByDefault]);

  async function saveRepo(path: string) {
    setStatus(null);
    try {
      await updateProject.mutateAsync({ id: project.id, repo_path: path });
      setStatus(path ? '✓ Repository linked' : '✓ Repository unlinked');
    } catch (err) {
      setStatus(`✗ ${extractError(err)}`);
    }
  }

  async function saveWorktreeSettings() {
    setStatus(null);
    try {
      await updateProject.mutateAsync({
        id: project.id,
        worktree_template: draftTemplate.trim() || null,
        worktree_by_default: worktreeByDefault,
      });
      setStatus('✓ Worktree settings saved');
    } catch (err) {
      setStatus(`✗ ${extractError(err)}`);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 14px',
        background: '#F8FAF8',
        borderRadius: 8,
        border: '1px solid #E3E8E5',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#1E2A22' }}>
          {project.name} ({project.prefix})
        </span>
        {project.repoPath && (
          <span
            style={{
              fontSize: 11,
              color: '#2E6F40',
              background: 'rgba(46,111,64,0.1)',
              padding: '2px 8px',
              borderRadius: 12,
              fontWeight: 600,
            }}
          >
            Git linked
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: '#5B6B60' }}>Repository path</span>
        <div className={styles.inputRow}>
          <input
            className={styles.input}
            type="text"
            placeholder="/path/to/git/repo"
            value={draftRepo}
            onChange={(e) => {
              setDraftRepo(e.target.value);
              setStatus(null);
            }}
          />
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={updateProject.isPending || !draftRepo.trim() || draftRepo.trim() === (project.repoPath ?? '')}
            onClick={() => saveRepo(draftRepo.trim())}
          >
            Save repo
          </button>
          {project.repoPath && (
            <button
              type="button"
              className={styles.btn}
              disabled={updateProject.isPending}
              onClick={() => saveRepo('')}
            >
              Unlink
            </button>
          )}
        </div>
      </div>

      {project.repoPath && (
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6, borderTop: '1px dashed #D5DED8' }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: '#5B6B60' }}>Default Worktree Template</span>
            <input
              className={styles.input}
              type="text"
              placeholder="../worktrees/{project}/{ticket_id}-{branch}"
              value={draftTemplate}
              onChange={(e) => {
                setDraftTemplate(e.target.value);
                setStatus(null);
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
              <span style={{ fontSize: 11, color: '#9AA8A0' }}>Tokens:</span>
              {['{project}', '{ticket_id}', '{branch}'].map((token) => (
                <button
                  key={token}
                  type="button"
                  style={{
                    background: '#FFFFFF',
                    border: '1px solid #D5DED8',
                    borderRadius: 4,
                    padding: '1px 6px',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 10.5,
                    color: '#2E6F40',
                    cursor: 'pointer',
                  }}
                  onClick={() => setDraftTemplate((prev) => prev + token)}
                  title={`Insert ${token}`}
                >
                  +{token}
                </button>
              ))}
            </div>
          </div>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              fontSize: 12.5,
              color: '#1E2A22',
            }}
          >
            <input
              type="checkbox"
              checked={worktreeByDefault}
              onChange={(e) => {
                setWorktreeByDefault(e.target.checked);
                setStatus(null);
              }}
              style={{ accentColor: '#2E6F40' }}
            />
            <span>Create git worktree by default when creating a branch</span>
          </label>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 8 }}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              style={{ fontSize: 12, padding: '5px 12px' }}
              disabled={
                updateProject.isPending ||
                (draftTemplate === (project.worktreeTemplate ?? '') &&
                  worktreeByDefault === (project.worktreeByDefault ?? false))
              }
              onClick={saveWorktreeSettings}
            >
              Save worktree settings
            </button>
          </div>
        </div>
      )}

      {status && <span className={status.startsWith('✓') ? styles.statusOk : styles.statusErr}>{status}</span>}
    </div>
  );
}
