import { useState } from 'react';
import { aiPluginsApi, usePluginMutation, usePlugins } from '../../../api/aiPlugins';
import type { CatalogueEntry } from '../../../types/aiPlugins';
import { extractError } from '../../../api/extractError';
import { LoadError } from '../aiUi';
import { AddFromSource } from './AddFromSource';
import { ByTeamTab } from './ByTeamTab';
import { CatalogueTab } from './CatalogueTab';
import { InstalledTab, TAKES_EFFECT } from './InstalledTab';

type Tab = 'installed' | 'suggested' | 'source' | 'byTeam';

/** Skills and plugins of the project (design/screens/ai-team-process.md, B): suggested for a role, add from a source,
 * installed, by team. */
export function SkillsPluginsSection({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<Tab>('installed');
  const [pick, setPick] = useState<CatalogueEntry | null>(null);
  const plugins = usePlugins(projectId);
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const bulk = usePluginMutation(projectId, async (action: 'reload' | 'reset') => {
    const results = await Promise.allSettled((plugins.data ?? []).map((p) => aiPluginsApi.act(p.id, action)));
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (failed.length) throw failed[0].reason;
    return results.length;
  });
  const runBulk = (action: 'reload' | 'reset') => {
    setError(null);
    setDone(null);
    setConfirmReset(false);
    bulk.mutate(action, {
      onSuccess: (n) => setDone(`${action === 'reload' ? 'Reloaded' : 'Reset'} ${n} from the source. ${TAKES_EFFECT}`),
      onError: (e) => setError(extractError(e)),
    });
  };
  const some = (plugins.data?.length ?? 0) > 0;
  const tabs: [Tab, string][] = [
    ['installed', 'Installed'],
    ['suggested', 'Suggested for a role'],
    ['source', 'Add from a source'],
    ['byTeam', 'By team'],
  ];

  let body;
  if (tab === 'source')
    body = (
      <AddFromSource
        key={pick?.key ?? 'blank'}
        projectId={projectId}
        initial={pick?.source ? { source: pick.source, plugin: pick.plugin, roles: pick.roles } : undefined}
        onInstalled={() => {
          setPick(null);
          setTab('installed');
        }}
      />
    );
  else if (plugins.isLoading)
    body = <div className="ai-skel" style={{ height: 120 }} aria-busy="true" aria-label="Loading" />;
  else if (plugins.error || !plugins.data)
    body = <LoadError what="the plugins" error={plugins.error} onRetry={() => void plugins.refetch()} />;
  else if (tab === 'suggested')
    body = (
      <CatalogueTab
        plugins={plugins.data}
        onAdd={(e) => {
          setPick(e);
          setTab('source');
        }}
      />
    );
  else if (tab === 'byTeam') body = <ByTeamTab projectId={projectId} plugins={plugins.data} />;
  else body = <InstalledTab projectId={projectId} plugins={plugins.data} />;

  return (
    <div data-testid="skills-plugins-section" data-project={projectId} style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-btn-primary"
          onClick={() => {
            setPick(null);
            setTab('source');
          }}
        >
          Add from a source
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          disabled={!some || bulk.isPending}
          onClick={() => runBulk('reload')}
        >
          Reload all
        </button>
        {confirmReset ? (
          <>
            <span className="ai-hint">Put every plugin back to its source and drop local edits?</span>
            <button type="button" className="ai-btn ai-btn-sm ai-btn-danger" onClick={() => runBulk('reset')}>
              Reset all
            </button>
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => setConfirmReset(false)}>
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={!some || bulk.isPending}
            onClick={() => setConfirmReset(true)}
          >
            Reset all to the catalogue
          </button>
        )}
      </div>
      {error && (
        <div className="ai-notice ai-notice-error" role="alert">
          {error}
        </div>
      )}
      {done && (
        <div className="ai-notice ai-notice-info" role="status">
          {done}
        </div>
      )}
      <div className="ai-tabs" role="tablist" style={{ marginTop: 0 }}>
        {tabs.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={`ai-tab${tab === k ? ' ai-tab-active' : ''}`}
            onClick={() => {
              setTab(k);
              setDone(null);
              setError(null);
            }}
          >
            {label}
            {k === 'installed' && plugins.data && <span className="ai-tab-count">{plugins.data.length}</span>}
          </button>
        ))}
      </div>
      {body}
    </div>
  );
}
