import { MenuSelect } from '../../ui/MenuSelect';
import { useState } from 'react';
import { aiPluginsApi, useCatalogue, usePluginMutation } from '../../../api/aiPlugins';
import { extractError } from '../../../api/extractError';
import type { CatalogueEntry, Plugin } from '../../../types/aiPlugins';
import { LoadError } from '../aiUi';
import { ROLES, roleName } from './pluginLogic';

/** Whether an installed plugin is this catalogue entry. */
export function isInstalled(e: CatalogueEntry, plugins: Plugin[]): boolean {
  return plugins.some((p) => p.name === e.name || (!!e.plugin && p.name === e.plugin));
}

/** "Suggested for a role": one list per role (B1). */
export function CatalogueTab({
  projectId,
  plugins,
  mcpInstalled,
}: {
  projectId: string;
  plugins: Plugin[];
  mcpInstalled?: Set<string>;
}) {
  const q = useCatalogue();
  const [role, setRole] = useState('');
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const install = usePluginMutation(projectId, (key: string) => aiPluginsApi.installEntry(projectId, key));

  if (q.isLoading) return <div className="ai-skel" style={{ height: 100 }} aria-busy="true" aria-label="Loading" />;
  if (q.error || !q.data) return <LoadError what="the catalogue" error={q.error} onRetry={() => void q.refetch()} />;
  const entries = q.data.filter((e) => !role || e.roles.includes(role));

  const go = async (e: CatalogueEntry) => {
    setBusy(e.key);
    setErr(null);
    try {
      const r = await install.mutateAsync(e.key);
      const n = r.mcpAddedTo?.length;
      setMsg((m) => ({ ...m, [e.key]: r.plugin ? 'Installed.' : `Added to ${n ?? 0} member${n === 1 ? '' : 's'}.` }));
    } catch (x) {
      setErr(extractError(x));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 10 }} data-testid="catalogue-tab">
      {/* B: the role filter is the design's dropdown chip */}
      <div>
        <MenuSelect
          variant="chip"
          label="Role"
          prefix="Role:"
          value={role}
          onChange={setRole}
          testId="catalogue-role"
          options={[
            { value: '', label: 'All roles' },
            ...Object.entries(ROLES).map(([k, n]) => ({ value: k, label: n })),
          ]}
        />
      </div>
      {err && (
        <div className="ai-notice ai-notice-error" role="alert">
          {err}
        </div>
      )}
      {entries.length === 0 && <div className="ai-hint">Nothing is suggested for this role.</div>}
      {entries.map((e) => {
        const done = e.kind === 'plugin' ? isInstalled(e, plugins) : !!mcpInstalled?.has(e.key) || !!msg[e.key];
        return (
          <div
            key={e.key}
            className="ai-card"
            data-testid={`cat-${e.key}`}
            style={{ padding: 12, display: 'flex', gap: 10 }}
          >
            <div style={{ flex: 1, display: 'grid', gap: 3 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <b style={{ fontSize: 13.5 }}>{e.name}</b>
                <span className="ai-chip">{e.kind === 'mcp' ? 'MCP server' : 'Plugin'}</span>
              </div>
              <span style={{ fontSize: 12.5 }}>{e.what}</span>
              <span className="ai-hint">
                Suggested for {e.roles.map(roleName).join(', ')}
                {e.source ? ` · ${e.source}` : ''}
              </span>
              {msg[e.key] && <span className="ai-hint">{msg[e.key]}</span>}
            </div>
            <div>
              {done && e.kind === 'plugin' ? (
                <span className="ai-chip">Installed</span>
              ) : (
                <button className="ai-btn ai-btn-sm" disabled={busy !== null} onClick={() => void go(e)}>
                  {busy === e.key ? 'Installing…' : 'Install'}
                </button>
              )}
            </div>
          </div>
        );
      })}
      <div className="ai-hint">
        An MCP server is added to the members of its roles. Every change takes effect from the next run.
      </div>
    </div>
  );
}
