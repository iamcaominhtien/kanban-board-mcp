import { useState } from 'react';
import { LineIcon } from '../../ui/LineIcon';
import { aiPluginsApi, usePluginMutation } from '../../../api/aiPlugins';
import { extractError } from '../../../api/extractError';
import type { Plugin, PluginAction, PluginChanges, UpdateCheck } from '../../../types/aiPlugins';
import { ago, Toggle, useAiBoardState } from '../aiUi';
import { ROLES, applyFilter, buildRows, countOf, mb, roleName, type Filter } from './pluginLogic';
import { BoardSkillsCard } from './BoardSkillsCard';

export const TAKES_EFFECT = 'Every change takes effect from the next run.';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'plugins', label: 'Plugins' },
  { key: 'skills', label: 'Skills' },
  { key: 'mcp', label: 'MCP servers' },
  { key: 'never', label: 'Never used' },
];

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
  const { members } = useAiBoardState();
  const uses = p.used?.uses ?? 0;
  const usedBy = (p.used?.byMember ?? [])
    .map((m) => members.get(m.memberId)?.name)
    .filter((n): n is string => !!n)
    .join(', ');

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
        <span data-testid="used">
          {uses === 0 ? 'never used' : `used ${uses} times${usedBy ? ` by ${usedBy}` : ''}`}
        </span>
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

/** The installed list with its filters (B1). */
export function InstalledTab({ projectId, plugins }: { projectId: string; plugins: Plugin[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const rows = buildRows(plugins);
  const needle = q.trim().toLowerCase();
  const shown = applyFilter(rows, filter).filter((r) => !needle || r.name.toLowerCase().includes(needle));
  return (
    <div style={{ display: 'grid', gap: 10 }} data-testid="installed-tab">
      <BoardSkillsCard projectId={projectId} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* B: a search field beside the filter chips */}
        <label className="ai-search-field" style={{ width: 220 }}>
          <LineIcon name="search" size={14} color="#9AA8A0" />
          <input
            placeholder="Search skills and plugins…"
            aria-label="Search installed"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="installed-search"
          />
        </label>
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
      </div>
      {shown.length === 0 ? (
        <div className="ai-hint" data-testid="installed-empty">
          {rows.length === 0
            ? 'Nothing installed yet. Pick one from the suggestions, or add one from a source.'
            : needle
              ? 'Nothing matches this search.'
              : 'Nothing matches this filter.'}
        </div>
      ) : (
        shown.map((r) => <PluginRow key={r.id} p={r.plugin} projectId={projectId} />)
      )}
      {/* B: the two notes as cards (green, amber) */}
      <div className="tl-callouts">
        <div className="tl-callout tl-callout-amber">
          <b>No approval step, and no pretending otherwise.</b> Installing from the internet runs other people’s code on
          your machine. The board records the source and the commit, shows the diff before an update, and keeps one
          button back to the version that worked.
        </div>
      </div>
    </div>
  );
}
