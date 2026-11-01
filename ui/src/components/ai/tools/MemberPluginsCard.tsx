import { useState } from 'react';
import { useAiMember } from '../../../api/ai';
import { aiPluginsApi, useCatalogue, usePluginMutation, usePlugins } from '../../../api/aiPlugins';
import { extractError } from '../../../api/extractError';
import { Toggle } from '../aiUi';
import { effective, followed, roleName } from './pluginLogic';
import { isInstalled } from './CatalogueTab';

/** The member's role pack key, wherever the config keeps it. */
export function roleOfConfig(cfg: unknown): string | null {
  const c = (cfg ?? {}) as { role?: string; pack?: { key?: string } };
  return c.role ?? c.pack?.key ?? null;
}

/** A member's plugins and skills, with the project default beside each switch (design/screens/ai-team-process.md, B3). */
export function MemberPluginsCard({ memberId, projectId }: { memberId: string; projectId: string }) {
  const member = useAiMember(memberId);
  const plugins = usePlugins(projectId);
  const catalogue = useCatalogue();
  const [error, setError] = useState<string | null>(null);
  const setM = usePluginMutation(projectId, (a: { id: string; on: boolean | null }) =>
    aiPluginsApi.setMember(a.id, memberId, a.on),
  );
  const installM = usePluginMutation(projectId, (key: string) => aiPluginsApi.installEntry(projectId, key, [memberId]));
  const role = roleOfConfig(member.data?.config);

  const set = async (id: string, on: boolean | null) => {
    setError(null);
    try {
      await setM.mutateAsync({ id, on });
    } catch (e) {
      setError(extractError(e));
    }
  };

  const shell = (children: React.ReactNode) => (
    <div
      className="ai-card"
      data-testid="member-plugins"
      data-member={memberId}
      data-project={projectId}
      style={{ padding: 14, display: 'grid', gap: 8 }}
    >
      <b style={{ fontSize: 13.5 }}>Skills and plugins</b>
      {children}
    </div>
  );
  if (plugins.isLoading)
    return shell(<div className="ai-skel" style={{ height: 60 }} aria-busy="true" aria-label="Loading" />);
  if (plugins.error || !plugins.data)
    return shell(
      <div className="ai-notice ai-notice-error" role="alert">
        Couldn't load the plugins: {extractError(plugins.error)}.{' '}
        <button className="ai-link" onClick={() => void plugins.refetch()}>
          Try again
        </button>
      </div>,
    );
  const list = plugins.data;
  const suggested = (catalogue.data ?? []).filter(
    (e) => e.kind === 'plugin' && role && e.roles.includes(role) && !isInstalled(e, list),
  );

  return shell(
    <>
      <div className="ai-hint">{role ? `Role: ${roleName(role)}.` : 'This member has no role pack.'}</div>
      {list.length === 0 && <div className="ai-hint">No plugin is installed on this project.</div>}
      {list.map((p) => {
        const eff = effective(p, memberId, role);
        const def = followed(p, role);
        const own = eff.why === 'own';
        const mine = (p.used?.byMember ?? []).some((m) => m.memberId === memberId);
        return (
          <div key={p.id} data-testid={`mp-${p.name}`} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Toggle label={p.name} on={eff.on} disabled={setM.isPending} onChange={(v) => void set(p.id, v)} />
            <b style={{ fontSize: 13 }}>{p.name}</b>
            <span className="ai-chip">Plugin</span>
            <span className="ai-hint" style={{ flex: 1 }} data-testid="default-note">
              Project default is {def ? 'on' : 'off'}
              {eff.why === 'role' ? ' (suggested for this role)' : ''}.
              {p.skills.length ? ` ${p.skills.length} skills` : ''}
              {p.used?.uses ? ` · used ${p.used.uses} times${mine ? ' by this member' : ''}` : ''}
              {own ? ' Switched here.' : ''}
            </span>
            {own && (
              <button className="ai-link" onClick={() => void set(p.id, null)}>
                Follow the default
              </button>
            )}
          </div>
        );
      })}
      {suggested.map((e) => (
        <div key={e.key} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <b style={{ fontSize: 13 }}>{e.name}</b>
          <span className="ai-hint" style={{ flex: 1 }}>
            Not installed on this project. Suggested for the {roleName(role as string)} role.
          </span>
          <button
            className="ai-btn ai-btn-sm"
            disabled={installM.isPending}
            onClick={() => void installM.mutateAsync(e.key).catch((x) => setError(extractError(x)))}
          >
            Install
          </button>
        </div>
      ))}
      {error && (
        <div className="ai-notice ai-notice-error" role="alert">
          {error}
        </div>
      )}
      <div className="ai-hint">
        Changing any of these starts a new conversation on the next run: the list of plugins is part of the prompt, and
        --resume cannot be trusted across a different set. Every change takes effect from the next run.
      </div>
    </>,
  );
}
