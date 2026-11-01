import { useState } from 'react';
import { aiPluginsApi, usePluginMutation } from '../../../api/aiPlugins';
import { extractError } from '../../../api/extractError';
import type { Plugin, PluginAction, PluginChanges, UpdateCheck } from '../../../types/aiPlugins';
import { ago } from '../aiUi';
import { Toggle } from '../aiUi';
import { ROLES, applyFilter, buildRows, countOf, mb, roleName, type Filter, type Row } from './pluginLogic';
import type { SkillUsage } from '../../../types/aiPlugins';

export const TAKES_EFFECT = 'Every change takes effect from the next run.';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'plugins', label: 'Plugins' },
  { key: 'skills', label: 'Skills' },
  { key: 'mcp', label: 'MCP servers' },
  { key: 'never', label: 'Never used' },
];

const KIND_LABEL = { plugin: 'Plugin', skill: 'Skill', mcp: 'MCP server' } as const;

function sourceLabel(p: Plugin) {
  return { git: 'Git URL', marketplace: 'Marketplace', folder: 'Imported from a folder' }[p.sourceKind];
}

function PluginRow({ p, projectId }: { p: Plugin; projectId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [changes, setChanges] = useState<PluginChanges | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const act = usePluginMutation(projectId, (a: PluginAction) => aiPluginsApi.act(p.id, a));
  const patch = usePluginMutation(projectId, (b: { defaultOn?: boolean; roles?: string[] }) =>
    aiPluginsApi.patch(p.id, b),
  );
  const del = usePluginMutation(projectId, (_: void) => aiPluginsApi.remove(p.id));

  const guard = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(null);
    }
  };
  const doAct = (a: PluginAction) =>
    guard(a, async () => {
      await act.mutateAsync(a);
      setUpdate(null);
      setChanges(null);
    });
  const uses = p.used?.uses ?? 0;

  return (
    <div className="ai-card" data-testid={`plugin-${p.name}`} style={{ padding: 12, display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13.5 }}>{p.name}</b>
        <span className="ai-chip">Plugin</span>
        <span className="ai-hint" style={{ flex: 1 }}>
          {sourceLabel(p)} · {p.skills.length} skills
          {p.description ? ` · ${p.description}` : ''}
        </span>
      </div>
      <div className="ai-hint" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <span>{p.source}</span>
        <span data-testid="version">
          {p.version ? `v${p.version.replace(/^v/, '')}` : ''}
          {p.commit ? ` · ${p.commit.slice(0, 8)}` : ''}
          {p.pinned ? ' · pinned' : ''}
          {update?.update && update.latest ? ` → ${update.latest}` : ''}
        </span>
        <span data-testid="used">{uses === 0 ? 'never used' : `used ${uses} times`}</span>
        <span>
          On by default: {p.defaultOn ? 'every member' : p.roles.length ? p.roles.map(roleName).join(', ') : 'nobody'}
        </span>
        {p.updatedAt && <span>updated {ago(p.updatedAt)}</span>}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="ai-btn ai-btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          Open
        </button>
        <button className="ai-btn ai-btn-sm" disabled={!!busy} onClick={() => void doAct('reload')}>
          {busy === 'reload' ? 'Reloading…' : 'Reload'}
        </button>
        <button className="ai-btn ai-btn-sm" disabled={!!busy} onClick={() => void doAct('reset')}>
          {busy === 'reset' ? 'Resetting…' : 'Reset'}
        </button>
        <button
          className="ai-btn ai-btn-sm"
          disabled={!!busy}
          onClick={() => void guard('check', async () => setUpdate(await aiPluginsApi.checkUpdate(p.id)))}
        >
          {busy === 'check' ? 'Checking…' : 'Check for update'}
        </button>
        {update?.update && (
          <>
            <button className="ai-btn ai-btn-sm ai-btn-primary" disabled={!!busy} onClick={() => void doAct('update')}>
              {busy === 'update' ? 'Updating…' : 'Update'}
            </button>
            <button
              className="ai-btn ai-btn-sm"
              disabled={!!busy}
              onClick={() => void guard('changes', async () => setChanges(await aiPluginsApi.changes(p.id)))}
            >
              See what changed
            </button>
          </>
        )}
        {update && !update.update && <span className="ai-hint">Up to date.</span>}
        <button className="ai-btn ai-btn-sm" disabled={!!busy} onClick={() => void doAct(p.pinned ? 'unpin' : 'pin')}>
          {p.pinned ? 'Unpin' : `Pin${p.version ? ` v${p.version.replace(/^v/, '')}` : ''}`}
        </button>
        {p.hasPrevious && (
          <button className="ai-btn ai-btn-sm" disabled={!!busy} onClick={() => void doAct('rollback')}>
            {busy === 'rollback' ? 'Rolling back…' : 'Roll back'}
          </button>
        )}
        {confirmRemove ? (
          <>
            <span className="ai-hint">Remove {p.name}?</span>
            <button
              className="ai-btn ai-btn-sm ai-btn-danger"
              data-testid="confirm-remove"
              disabled={!!busy}
              onClick={() => void guard('remove', () => del.mutateAsync())}
            >
              Remove
            </button>
            <button className="ai-btn ai-btn-sm" onClick={() => setConfirmRemove(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="ai-btn ai-btn-sm ai-btn-danger-outline" onClick={() => setConfirmRemove(true)}>
            Remove
          </button>
        )}
        {busy && <span className="ai-spin" role="status" aria-label="Working" />}
      </div>
      {error && (
        <div className="ai-notice ai-notice-error" role="alert" data-testid="plugin-error">
          {error}
        </div>
      )}
      {changes && (
        <div className="ai-notice ai-notice-info" data-testid="plugin-changes" style={{ display: 'grid', gap: 2 }}>
          <b>Changes{changes.commit ? ` in ${changes.commit.slice(0, 8)}` : ''}</b>
          {changes.added.length + changes.removed.length + changes.changed.length === 0 && (
            <span>No file changed.</span>
          )}
          {changes.added.map((f) => (
            <span key={`a${f}`}>+ {f}</span>
          ))}
          {changes.removed.map((f) => (
            <span key={`r${f}`}>− {f}</span>
          ))}
          {changes.changed.map((f) => (
            <span key={`c${f}`}>~ {f}</span>
          ))}
        </div>
      )}
      {open && (
        <div style={{ display: 'grid', gap: 6, fontSize: 12.5 }} data-testid="plugin-detail">
          <div>
            {p.skills.length} skills{p.skills.length ? `: ${p.skills.join(', ')}` : ''} · {countOf(p.hooks)} hooks ·{' '}
            {countOf(p.mcp)} MCP servers{p.sizeBytes ? ` · ${mb(p.sizeBytes)}` : ''}
          </div>
          <Toggle
            label="On for every member"
            on={p.defaultOn}
            disabled={patch.isPending}
            onChange={(v) => void guard('patch', () => patch.mutateAsync({ defaultOn: v }))}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <span className="ai-label">Suggested for</span>
            {Object.entries(ROLES).map(([k, name]) => (
              <label key={k} style={{ display: 'flex', gap: 4 }}>
                <input
                  type="checkbox"
                  checked={p.roles.includes(k)}
                  disabled={patch.isPending}
                  onChange={(e) =>
                    void guard('patch', () =>
                      patch.mutateAsync({ roles: e.target.checked ? [...p.roles, k] : p.roles.filter((r) => r !== k) }),
                    )
                  }
                />
                {name}
              </label>
            ))}
          </div>
          {(p.used?.byMember ?? []).length > 0 && (
            <div className="ai-hint">Used by {p.used.byMember.length} members.</div>
          )}
        </div>
      )}
    </div>
  );
}

function LooseRow({ r }: { r: Row }) {
  const u = r.usage as SkillUsage;
  return (
    <div className="ai-card" data-testid={`loose-${r.name}`} style={{ padding: 12, display: 'flex', gap: 10 }}>
      <b style={{ fontSize: 13.5 }}>{r.name}</b>
      <span className="ai-chip">{KIND_LABEL[r.kind]}</span>
      <span className="ai-hint" style={{ flex: 1 }}>
        Attached to members · managed in each member's configuration
      </span>
      <span className="ai-hint">{u.uses === 0 ? `never · in ${u.runs} runs` : `used ${u.uses} times`}</span>
    </div>
  );
}

/** The installed list with its filters (B1). */
export function InstalledTab({
  projectId,
  plugins,
  usage,
}: {
  projectId: string;
  plugins: Plugin[];
  usage: SkillUsage[];
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const rows = buildRows(plugins, usage);
  const shown = applyFilter(rows, filter);
  return (
    <div style={{ display: 'grid', gap: 10 }} data-testid="installed-tab">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Filter">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`ai-btn ai-btn-sm${filter === f.key ? ' ai-btn-primary' : ''}`}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label} {applyFilter(rows, f.key).length}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="ai-hint" data-testid="installed-empty">
          {rows.length === 0
            ? 'Nothing installed yet. Pick one from the suggestions, or add one from a source.'
            : 'Nothing matches this filter.'}
        </div>
      ) : (
        shown.map((r) =>
          r.plugin ? <PluginRow key={r.id} p={r.plugin} projectId={projectId} /> : <LooseRow key={r.id} r={r} />,
        )
      )}
      <div className="ai-hint">
        “Really used” is counted from the Skill and Task tool calls in the run stream, not guessed. {TAKES_EFFECT}
      </div>
    </div>
  );
}
