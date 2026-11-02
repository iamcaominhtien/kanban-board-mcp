import { useState } from 'react';
import type { EnvFolder } from '../../../types/aiPacks';
import { Ico } from './wizardIcons';
import './packs.css';

const BY: Record<EnvFolder['by'], string> = {
  ai: 'added by the AI',
  you: 'added by you',
  project: 'saved for this project',
};

function tagOf(f: EnvFolder): string {
  if (f.by === 'ai') return f.why ? `Added by the AI · ${f.why}` : 'Added by the AI';
  if (f.by === 'you') return 'Added by you';
  return f.why ? `Saved for this project · ${f.why}` : 'Saved for this project';
}

/** One editable folder: saved on blur or Enter, only when it changed. */
function FolderRow({
  folder,
  disabled,
  onSave,
  onRemove,
}: {
  folder: EnvFolder;
  disabled?: boolean;
  onSave: (path: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const done = () => {
    const v = (draft ?? folder.path).trim();
    if (draft != null && v && v !== folder.path) onSave(v);
    setDraft(null);
  };
  return (
    <div className="pk-env-row" data-testid="env-row">
      <input
        className="ai-input pk-cmd"
        aria-label={`Folder ${folder.path}`}
        value={draft ?? folder.path}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <div className="pk-env-tagcell">
        <span className={`ai-chip pk-env-tag ${folder.by === 'ai' ? 'pk-c-ok' : 'pk-c-grey'}`}>{tagOf(folder)}</span>
      </div>
      <button
        type="button"
        className="ai-btn ai-btn-sm"
        aria-label={`Remove ${folder.path}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <Ico name="x" />
        Remove
      </button>
    </div>
  );
}

/**
 * The environment the commands run in (design D3, E4): extra folders put in front of the PATH for everything the
 * project runs. Collapsed to one line; open at first sight when the AI added a folder.
 */
export function EnvBlock({
  folders,
  basePath,
  onChange,
  changeNote,
  disabled,
}: {
  folders: EnvFolder[];
  /** The app's own PATH, shown read-only under the folders. */
  basePath?: string;
  onChange: (next: EnvFolder[]) => void;
  /** The sentence beside "Add a folder". */
  changeNote: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const isOpen = open ?? folders.some((f) => f.by === 'ai');
  const by = [...new Set(folders.map((f) => BY[f.by]))].join(' and ');
  const n = folders.length;

  const commitAdd = () => {
    const v = (adding ?? '').trim();
    if (v && !folders.some((f) => f.path === v)) onChange([...folders, { path: v, by: 'you' }]);
    setAdding(null);
  };

  return (
    <div className={`pk-env${isOpen ? ' pk-env-open' : ''}`} data-testid="env-block">
      <button
        type="button"
        className="pk-env-head"
        aria-expanded={isOpen}
        data-testid="env-toggle"
        onClick={() => setOpen(!isOpen)}
      >
        <Ico name="terminal" size={15} color="#3A4A3E" sw={2} />
        <span style={{ flex: 1 }}>
          <span className="pk-env-title">Environment the commands run in</span>
          {!isOpen && (
            <span className="pk-hint-sm" data-testid="env-summary">
              {n === 0 ? (
                'PATH has no extra folder'
              ) : (
                <>
                  PATH has {n} extra folder{n === 1 ? '' : 's'}:{' '}
                  {folders.map((f, i) => (
                    <span key={f.path}>
                      {i > 0 && ', '}
                      <span className="ai-code">{f.path}</span>
                    </span>
                  ))}{' '}
                  · {by}
                </>
              )}{' '}
              · used only by this project
            </span>
          )}
        </span>
        <Ico name={isOpen ? 'up' : 'down'} size={15} color="#5B6B60" />
      </button>
      {isOpen && (
        <>
          <div className="ai-hint">
            Folders put in front of the PATH when this project’s commands run. The app may be opened from the Dock, so
            it can start with a short PATH and not see Homebrew or nvm.
          </div>
          {folders.map((f, i) => (
            <FolderRow
              key={`${f.path}-${i}`}
              folder={f}
              disabled={disabled}
              onSave={(path) => onChange(folders.map((x, j) => (j === i ? { path, by: 'you' } : x)))}
              onRemove={() => onChange(folders.filter((_, j) => j !== i))}
            />
          ))}
          {adding != null && (
            <div className="pk-env-row">
              <input
                className="ai-input pk-cmd"
                aria-label="New folder"
                placeholder="/opt/homebrew/bin"
                autoFocus
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                onBlur={commitAdd}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
            </div>
          )}
          {basePath != null && (
            <div className="pk-env-row">
              <input className="ai-input pk-cmd pk-in-ro" aria-label="The app’s own PATH" readOnly value={basePath} />
              <div className="pk-env-tagcell">
                <span className="ai-chip pk-env-tag pk-c-grey">What the app was started with · not editable</span>
              </div>
              <span className="ai-btn ai-btn-sm pk-env-gap" aria-hidden="true">
                <Ico name="x" />
                Remove
              </span>
            </div>
          )}
          <div className="pk-actions">
            <button type="button" className="ai-btn ai-btn-sm" disabled={disabled} onClick={() => setAdding('')}>
              <Ico name="plus" />
              Add a folder
            </button>
            <span className="ai-hint">{changeNote}</span>
          </div>
          <div className="pk-env-used">
            <b>Used by everything this project runs:</b> the commands above, the prepare command of every ticket’s
            worktree, the lint, build and test checks of a workflow, and the AI members’ own runs on this project’s
            tickets — so a Dev’s <span className="ai-code">npm test</span> sees the same PATH. <b>Not used by</b> other
            projects.
          </div>
        </>
      )}
    </div>
  );
}
