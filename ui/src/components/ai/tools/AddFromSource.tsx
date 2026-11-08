import { useRef, useState } from 'react';
import { aiPluginsApi, usePluginMutation } from '../../../api/aiPlugins';
import { extractError } from '../../../api/extractError';
import type { PluginPreview, PreviewChoices, SourceKind } from '../../../types/aiPlugins';
import { ROLES, countOf, mb } from './pluginLogic';

const KINDS: { key: SourceKind; label: string; field: string; placeholder: string; hint: string }[] = [
  {
    key: 'git',
    label: 'Git URL',
    field: 'Repository',
    placeholder: 'https://github.com/anthropics/skills',
    hint: 'A plugin, or a repository of them. Public, or one this computer can already clone.',
  },
  {
    key: 'marketplace',
    label: 'Marketplace',
    field: 'Marketplace',
    placeholder: 'owner/marketplace or a marketplace URL',
    hint: 'A marketplace of plugins. If it holds several, you choose one.',
  },
  {
    key: 'folder',
    label: 'A folder on this computer',
    field: 'Folder',
    placeholder: '~/tools/release-notes',
    hint: 'A folder with a plugin or a SKILL.md in it.',
  },
];

export const NO_REVIEW =
  'This runs code from the internet on this computer, inside the AI’s runs. There is no review step. The commit is recorded, and one button puts the previous version back.';

function isChoices(p: PluginPreview | PreviewChoices): p is PreviewChoices {
  return 'choices' in p;
}

/** "Add from a source": git URL, marketplace or a folder, with a preview of what will be installed (B2). */
export function AddFromSource({
  projectId,
  onInstalled,
  initial,
}: {
  projectId: string;
  onInstalled: () => void;
  /** A suggestion the person chose (“Add…”): its source and the roles it is suggested for. */
  initial?: { source: string; plugin?: string; roles: string[] };
}) {
  const [kind, setKind] = useState<SourceKind>('git');
  const [source, setSource] = useState(initial?.source ?? '');
  const [ref, setRef] = useState('');
  const [plugin, setPlugin] = useState<string | undefined>(initial?.plugin);
  const [roles, setRoles] = useState<string[]>(initial?.roles ?? []);
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [choices, setChoices] = useState<PreviewChoices['choices'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const meta = KINDS.find((k) => k.key === kind) ?? KINDS[0];

  const body = (pl = plugin) => ({
    sourceKind: kind,
    source: source.trim(),
    ...(ref.trim() ? { ref: ref.trim() } : {}),
    ...(pl ? { plugin: pl } : {}),
  });
  const previewM = usePluginMutation(projectId, (pl?: string) => aiPluginsApi.preview(projectId, body(pl)));
  const installM = usePluginMutation(projectId, (_: void) =>
    aiPluginsApi.install(projectId, { ...body(), roles, defaultOn: false }),
  );

  // a preview that comes back after the source was edited is for another source: forget it
  const seq = useRef(0);
  const reset = () => {
    seq.current += 1;
    setPreview(null);
    setChoices(null);
    setPlugin(undefined);
    setError(null);
  };
  const run = async (pl?: string) => {
    setError(null);
    setPreview(null);
    const mine = ++seq.current;
    try {
      const r = await previewM.mutateAsync(pl);
      if (mine !== seq.current) return;
      if (isChoices(r)) setChoices(r.choices);
      else {
        setChoices(null);
        setPreview(r);
      }
    } catch (e) {
      setError(extractError(e));
    }
  };
  const install = async () => {
    setError(null);
    try {
      await installM.mutateAsync();
      setSource('');
      setRef('');
      setRoles([]);
      reset();
      onInstalled();
    } catch (e) {
      setError(extractError(e));
    }
  };

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 640 }} data-testid="add-from-source">
      <div className="ai-tabs" role="tablist" style={{ marginTop: 0 }}>
        {KINDS.map((k) => (
          <button
            key={k.key}
            role="tab"
            aria-selected={kind === k.key}
            className={`ai-tab${kind === k.key ? ' ai-tab-active' : ''}`}
            onClick={() => {
              setKind(k.key);
              reset();
            }}
          >
            {k.label}
          </button>
        ))}
      </div>
      <label style={{ display: 'grid', gap: 4 }}>
        <span className="ai-label">{meta.field}</span>
        <input
          className="ai-input"
          aria-label={meta.field}
          value={source}
          placeholder={meta.placeholder}
          onChange={(e) => {
            setSource(e.target.value);
            reset();
          }}
        />
        <span className="ai-hint">{meta.hint}</span>
      </label>
      {kind !== 'folder' && (
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="ai-label">Version</span>
          <input
            className="ai-input"
            aria-label="Version"
            value={ref}
            placeholder="Latest"
            onChange={(e) => {
              setRef(e.target.value);
              reset();
            }}
          />
          <span className="ai-hint">Pin it to a tag or a commit and updates stop being offered until you unpin.</span>
        </label>
      )}
      <div style={{ display: 'grid', gap: 4 }}>
        <span className="ai-label">Who gets it</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {Object.entries(ROLES).map(([k, name]) => (
            <label key={k} style={{ display: 'flex', gap: 4, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={roles.includes(k)}
                onChange={(e) => setRoles(e.target.checked ? [...roles, k] : roles.filter((r) => r !== k))}
              />
              {name}
            </label>
          ))}
        </div>
        <span className="ai-hint">
          A team can switch it off for itself. Choosing nobody installs it and leaves it off.
        </span>
      </div>
      <div>
        <button
          className="ai-btn"
          data-testid="preview-source"
          disabled={!source.trim() || previewM.isPending}
          onClick={() => void run(plugin)}
        >
          {previewM.isPending ? 'Looking…' : 'Preview'}
        </button>
        {previewM.isPending && (
          <span className="ai-hint" role="status" style={{ marginLeft: 8 }}>
            <span className="ai-spin" /> Fetching the source can take a while.
          </span>
        )}
      </div>
      {choices && (
        <div className="ai-card" data-testid="plugin-choices" style={{ padding: 12, display: 'grid', gap: 6 }}>
          <b style={{ fontSize: 13 }}>This source has several plugins. Choose one.</b>
          {choices.map((c) => (
            <div key={c.name} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 1, fontSize: 12.5 }}>
                <b>{c.name}</b> {c.description}
              </span>
              <button
                className="ai-btn ai-btn-sm"
                onClick={() => {
                  setPlugin(c.name);
                  void run(c.name);
                }}
              >
                Preview {c.name}
              </button>
            </div>
          ))}
        </div>
      )}
      {preview && (
        <div className="ai-card" data-testid="install-preview" style={{ padding: 12, display: 'grid', gap: 6 }}>
          <b style={{ fontSize: 13 }}>What will be installed</b>
          <div style={{ fontSize: 13 }}>
            <b>{preview.name}</b>
            {preview.version ? ` v${preview.version.replace(/^v/, '')}` : ''}
            {preview.description ? ` · ${preview.description}` : ''}
          </div>
          <div style={{ fontSize: 12.5 }} data-testid="install-counts">
            {preview.skills.length} skills · {countOf(preview.hooks)} hooks · {countOf(preview.mcp)} MCP servers
            {preview.sizeBytes != null ? ` · ${mb(preview.sizeBytes)}` : ''}
          </div>
          {preview.skills.length > 0 && <div className="ai-hint">{preview.skills.join(', ')}</div>}
          {preview.commit && (
            <div className="ai-hint">
              Commit <code>{preview.commit.slice(0, 10)}</code>
            </div>
          )}
          <div className="ai-notice ai-notice-warn" data-testid="no-review">
            {NO_REVIEW}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="ai-btn ai-btn-primary"
              data-testid="install-confirm"
              disabled={installM.isPending}
              onClick={() => void install()}
            >
              {installM.isPending ? 'Installing…' : 'Install'}
            </button>
            <button className="ai-btn" disabled={installM.isPending} onClick={reset}>
              Cancel
            </button>
            {installM.isPending && (
              <span className="ai-hint" role="status">
                <span className="ai-spin" /> Cloning the repository…
              </span>
            )}
          </div>
        </div>
      )}
      {error && (
        <div className="ai-notice ai-notice-error" role="alert" data-testid="source-error">
          {error}
        </div>
      )}
    </div>
  );
}
