import { MenuSelect } from '../../ui/MenuSelect';
import { useState } from 'react';
import { useCatalogue } from '../../../api/aiPlugins';
import type { CatalogueEntry, Plugin } from '../../../types/aiPlugins';
import { LoadError } from '../aiUi';
import { ROLES, roleName } from './pluginLogic';

/** Whether an installed plugin is this catalogue entry. */
export function isInstalled(e: CatalogueEntry, plugins: Plugin[]): boolean {
  return plugins.some((p) => p.name === e.name || (!!e.plugin && p.name === e.plugin));
}

/** "Suggested for a role": one list per role (B1). */
export function CatalogueTab({
  plugins,
  mcpInstalled,
  onAdd,
}: {
  plugins: Plugin[];
  mcpInstalled?: Set<string>;
  /** “Add…”: open Add from a source with this suggestion filled in. */
  onAdd?: (e: CatalogueEntry) => void;
}) {
  const q = useCatalogue();
  const [role, setRole] = useState('');

  if (q.isLoading) return <div className="ai-skel" style={{ height: 100 }} aria-busy="true" aria-label="Loading" />;
  if (q.error || !q.data) return <LoadError what="the catalogue" error={q.error} onRetry={() => void q.refetch()} />;
  const entries = q.data.filter((e) => !role || e.roles.includes(role));

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
      {entries.length === 0 && <div className="ai-hint">Nothing is suggested for this role.</div>}
      {entries.map((e) => {
        const done = e.kind === 'plugin' ? isInstalled(e, plugins) : !!mcpInstalled?.has(e.key);
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
            </div>
            {done ? (
              <span className="ai-chip">Installed</span>
            ) : (
              onAdd &&
              e.source && (
                <button
                  type="button"
                  className="ai-btn ai-btn-sm"
                  data-testid={`cat-add-${e.key}`}
                  onClick={() => onAdd(e)}
                >
                  Add…
                </button>
              )
            )}
          </div>
        );
      })}
      <div className="ai-hint">These are suggestions. Add one from its source under “Add from a source”.</div>
    </div>
  );
}
