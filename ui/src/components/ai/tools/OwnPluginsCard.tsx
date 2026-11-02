import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { pluginKeys, useOwnPlugins, type OwnPlugin } from '../../../api/aiPlugins';
import { usePatchProjectOps, useProjectOps, type ProjectOps } from '../../../api/aiProjectOps';
import { extractError } from '../../../api/extractError';
import { Toggle } from '../aiUi';
import './ownPlugins.css';

/** The grid's columns and the role keys each one stands for (Tester covers QA and the User tester). */
export const OWN_ROLE_COLUMNS: { label: string; roles: string[] }[] = [
  { label: 'PM', roles: ['pm'] },
  { label: 'BA', roles: ['ba'] },
  { label: 'Designer', roles: ['designer'] },
  { label: 'Dev', roles: ['dev'] },
  { label: 'Tester', roles: ['qa', 'user_tester'] },
  { label: 'Reviewer', roles: ['reviewer'] },
];
/** Every role a plugin that is not narrowed loads for, Triage included. */
const ALL_ROLES = ['triage', ...OWN_ROLE_COLUMNS.flatMap((c) => c.roles)];

type Narrowing = NonNullable<ProjectOps['ownClaudeRoles']>;

/** The project's narrowing after one tick changed: a plugin back on every role leaves the list. */
export function withTick(list: Narrowing, plugin: string, column: string[], on: boolean): Narrowing {
  const entry = list.find((r) => r.plugin === plugin);
  const current = new Set(entry ? entry.roles : ALL_ROLES);
  column.forEach((r) => (on ? current.add(r) : current.delete(r)));
  const rest = list.filter((r) => r.plugin !== plugin);
  if (ALL_ROLES.every((r) => current.has(r))) return rest;
  return [...rest, { plugin, roles: ALL_ROLES.filter((r) => current.has(r)) }];
}

const skills = (n: number) => `${n} skill${n === 1 ? '' : 's'}`;

/**
 * Your own Claude Code plugins (design/screens/ai-story-flow.md, Q2): whether a Claude Code run loads the plugins the
 * person installed for themselves (`own_claude`), and which roles load each (`own_claude_roles`).
 */
export function OwnPluginsCard({ projectId }: { projectId: string }) {
  const own = useOwnPlugins(projectId);
  const ops = useProjectOps(projectId);
  const patch = usePatchProjectOps(projectId);
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const on = ops.data?.ownClaude ?? own.data?.on ?? true;
  const busy = patch.isPending || !ops.data;
  const plugins = own.data?.plugins ?? [];

  const save = async (body: Partial<ProjectOps>) => {
    setError(null);
    try {
      await patch.mutateAsync(body);
      await qc.invalidateQueries({ queryKey: pluginKeys.own(projectId) });
    } catch (e) {
      setError(extractError(e));
    }
  };

  const narrowing = (): Narrowing =>
    ops.data?.ownClaudeRoles ??
    plugins.filter((p) => p.roles != null).map((p) => ({ plugin: p.name, roles: p.roles ?? [] }));
  const ticked = (p: OwnPlugin, column: string[]) => {
    const roles = narrowing().find((r) => r.plugin === p.name)?.roles ?? p.roles;
    return roles == null || column.some((r) => roles.includes(r));
  };

  return (
    <section className="op-sec" data-testid="own-plugins">
      <div>
        <div className="op-title">Your own Claude Code plugins</div>
        <div className="ai-hint" style={{ marginTop: 3 }}>
          A run starts with the account’s own config folder, so the plugins you installed for yourself are not there and
          an AI works with less than the same model in your terminal.
        </div>
      </div>
      <div>
        <div className="op-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="op-row-title">Let Claude Code runs use my plugins</div>
            <div className="ai-hint">
              Loads, with <span className="op-code">--plugin-dir</span>, each plugin you installed for your user and did
              not switch off. Not loaded in Safe mode. Skills synced from the desktop app are left out: they drive the
              app’s own tools, which a run does not have.
            </div>
          </div>
          <Toggle
            on={on}
            label="Let Claude Code runs use my plugins"
            testId="own-plugins-on"
            disabled={busy}
            onChange={(v) => void save({ ownClaude: v })}
          />
        </div>
        <div className="op-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="op-row-title">Which roles get which</div>
            <div className="ai-hint">
              A tick means members with that role load the plugin. Ticks start from <i>on for everyone</i>; you can
              narrow them. A member can still switch one off for itself under Configuration, Tools. A change starts a
              new conversation on the next run.
            </div>
          </div>
        </div>
      </div>
      {own.isLoading ? (
        <div className="ai-skel" style={{ height: 120 }} aria-busy="true" aria-label="Loading your plugins" />
      ) : own.error ? (
        <div className="ai-notice ai-notice-slate" data-testid="own-plugins-error">
          Couldn't read your Claude Code folder: {extractError(own.error)}.{' '}
          <button type="button" className="ai-link" onClick={() => void own.refetch()}>
            Try again
          </button>
        </div>
      ) : plugins.length === 0 ? (
        <div className="ai-notice ai-notice-slate" data-testid="own-plugins-none">
          No plugins in your Claude Code folder.
        </div>
      ) : (
        <div className="op-grid" role="table" aria-label="Which roles load each plugin" data-testid="own-plugins-grid">
          <div className="op-line op-line-head" role="row">
            <span role="columnheader">Plugin in ~/.claude</span>
            {OWN_ROLE_COLUMNS.map((c) => (
              <span key={c.label} role="columnheader" style={{ textAlign: 'center' }}>
                {c.label}
              </span>
            ))}
          </div>
          {plugins.map((p) => (
            <div
              key={p.name}
              role="row"
              className={`op-line${p.loaded ? '' : ' op-line-off'}`}
              data-testid={`own-plugin-${p.name}`}
            >
              <div role="cell">
                <b style={{ fontSize: 13, color: p.loaded ? undefined : '#5B6B60' }}>{p.name}</b>
                <div className="ai-hint" style={{ fontSize: 11.5 }}>
                  {p.loaded ? `${p.scope} · ${skills(p.skills)}` : `${p.reason ?? 'Not found.'} Not loaded.`}
                </div>
              </div>
              {OWN_ROLE_COLUMNS.map((c) => (
                <span key={c.label} role="cell" className="op-cell">
                  <input
                    type="checkbox"
                    className="op-tick"
                    aria-label={`${p.name} for ${c.label}`}
                    checked={p.loaded && ticked(p, c.roles)}
                    disabled={!p.loaded || !on || busy}
                    onChange={(e) =>
                      void save({ ownClaudeRoles: withTick(narrowing(), p.name, c.roles, e.target.checked) })
                    }
                  />
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="ai-hint">
        Read from your Claude Code folder when this page opens. Nothing is installed or changed there.
      </div>
      {error && (
        <div className="ai-error-text" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
