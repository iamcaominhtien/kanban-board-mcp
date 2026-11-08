import { useEffect, useState } from 'react';
import { aiApi, useAiMutation, useTeamPacks } from '../../api/ai';
import { extractError } from '../../api/extractError';
import { useToast } from '../Toast';
import { AccountPicker } from './accounts/AccountPicker';
import { EFFORTS, MODELS } from './teamOptions';
import { PersonaField } from './PersonaField';
import { roleName } from './tools/pluginLogic';
import { LineIcon } from '../ui/LineIcon';
import './ai.css';

/**
 * Add an AI team: a name, the folder runs start in, the Claude account it runs as, the model and effort of its
 * lead, the team pack (which roles it brings) and a persona. The roles are edited later on the team's page.
 */
export function AddTeamModal({
  projectId,
  projectName,
  onClose,
  onOpenProfile,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onOpenProfile?: (id: string) => void;
}) {
  const packs = useTeamPacks();
  const toast = useToast();
  const [name, setName] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [model, setModel] = useState('sonnet');
  const [effort, setEffort] = useState('');
  const [packKey, setPackKey] = useState('standard');
  const [persona, setPersona] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const create = useAiMutation(() =>
    aiApi.createTeam(projectId, {
      name: name.trim(),
      workingDir: workingDir.trim(),
      accountId: accountId ?? undefined,
      model,
      effort: effort || undefined,
      packKey,
      persona: persona.trim(),
    }),
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const nameError = !name.trim() ? 'Give the team a name' : null;
  const folderError = !workingDir.trim() ? 'Choose the folder runs start in' : null;
  const pack = packs.data?.find((p) => p.key === packKey);

  const submit = async () => {
    setAttempted(true);
    if (nameError || folderError) return;
    setError(null);
    try {
      const team = await create.mutateAsync(undefined);
      toast.success(`${team.name} added`, 'Assign it a ticket and its lead starts.');
      onClose();
      onOpenProfile?.(team.id);
    } catch (e) {
      setError(extractError(e));
    }
  };

  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 600 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Add AI team"
        data-testid="add-team-modal"
      >
        <div className="ai-modal-head" style={{ position: 'relative', paddingRight: 52 }}>
          <button type="button" className="ai-icobtn ai-modal-x" aria-label="Close" onClick={onClose}>
            <LineIcon name="close" size={16} />
          </button>
          <h2 className="ai-modal-title">Add an AI team</h2>
          <div className="ai-hint">
            A team works on the tickets assigned to it in {projectName}. Its lead runs Claude Code; its roles work as
            helpers of the lead.
          </div>
        </div>
        <div className="ai-modal-body" style={{ maxHeight: '64vh', overflow: 'auto' }}>
          <label className="ai-field">
            <span className="ai-label ai-label-dark ai-label-sentence">Name</span>
            <input
              className={`ai-input ${nameError && attempted ? 'ai-input-error' : ''}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Backend team"
              maxLength={60}
              autoFocus
              data-testid="team-name"
            />
            {nameError && attempted && <span className="ai-error-text">{nameError}</span>}
          </label>
          <label className="ai-field">
            <span className="ai-label ai-label-dark ai-label-sentence">Working folder</span>
            <input
              className={`ai-input ai-mono ${folderError && attempted ? 'ai-input-error' : ''}`}
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              placeholder="~/dev/my-project"
              data-testid="team-working-dir"
            />
            {folderError && attempted ? (
              <span className="ai-error-text">{folderError}</span>
            ) : (
              <span className="ai-hint">Every run starts here, in a worktree of this repository.</span>
            )}
          </label>
          <div className="ai-field">
            <span className="ai-label ai-label-dark ai-label-sentence">Claude account</span>
            <AccountPicker provider="claude-code" value={accountId} projectId={projectId} onChange={setAccountId} />
          </div>
          <div style={{ display: 'flex', gap: 14 }}>
            <label className="ai-field" style={{ flex: 1 }}>
              <span className="ai-label ai-label-dark ai-label-sentence">Model of the lead</span>
              <select
                className="ai-select"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                data-testid="team-model"
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="ai-field" style={{ flex: 1 }}>
              <span className="ai-label ai-label-dark ai-label-sentence">Effort</span>
              <select
                className="ai-select"
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                data-testid="team-effort"
              >
                <option value="">Default</option>
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="ai-field">
            <span className="ai-label ai-label-dark ai-label-sentence">Team pack</span>
            <div className="ai-pack-grid" role="radiogroup" aria-label="Team pack">
              {(packs.data ?? []).map((p) => (
                <button
                  key={p.key}
                  type="button"
                  role="radio"
                  aria-checked={packKey === p.key}
                  className={`ai-option ${packKey === p.key ? 'ai-option-active' : ''}`}
                  onClick={() => setPackKey(p.key)}
                  data-testid={`team-pack-${p.key}`}
                >
                  <span className={`ai-radio ${packKey === p.key ? 'ai-radio-on' : ''}`} />
                  <span style={{ textAlign: 'left' }}>
                    <b style={{ fontSize: 13 }}>{p.name}</b>
                    <div className="ai-muted">{p.description}</div>
                  </span>
                </button>
              ))}
              {packs.isLoading && <span className="ai-spin" />}
            </div>
            {pack && (
              <span className="ai-hint">
                Roles: {pack.roles.map(roleName).join(', ')}. Change any of them on the team's page.
              </span>
            )}
          </div>
          <label className="ai-field">
            <span className="ai-label ai-label-dark ai-label-sentence">Persona (optional)</span>
            <PersonaField
              value={persona}
              onChange={setPersona}
              placeholder="How this team works: its tone, the rules it keeps, what it never touches."
              testId="team-persona"
            />
          </label>
          {error && (
            <div className="ai-notice ai-notice-error" role="alert" data-testid="add-team-error">
              <div>{error}</div>
            </div>
          )}
        </div>
        <div className="ai-modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={create.isPending}
            onClick={() => void submit()}
            data-testid="add-team-submit"
          >
            {create.isPending ? 'Adding…' : 'Add team'}
          </button>
        </div>
      </div>
    </div>
  );
}
