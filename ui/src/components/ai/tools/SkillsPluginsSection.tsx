import { useState } from 'react';
import { usePlugins, useSkillsUsage } from '../../../api/aiPlugins';
import { LoadError } from '../aiUi';
import { AddFromSource } from './AddFromSource';
import { CatalogueTab } from './CatalogueTab';
import { InstalledTab } from './InstalledTab';

type Tab = 'suggested' | 'source' | 'installed';

/** Skills and plugins of the project (design/screens/ai-team-process.md, B): suggested for a role, add from a source,
 * installed. */
export function SkillsPluginsSection({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<Tab>('installed');
  const plugins = usePlugins(projectId);
  const usage = useSkillsUsage(projectId);
  const tabs: [Tab, string][] = [
    ['suggested', 'Suggested for a role'],
    ['source', 'Add from a source'],
    ['installed', 'Installed'],
  ];

  let body;
  if (plugins.isLoading)
    body = <div className="ai-skel" style={{ height: 120 }} aria-busy="true" aria-label="Loading" />;
  else if (plugins.error || !plugins.data)
    body = <LoadError what="the plugins" error={plugins.error} onRetry={() => void plugins.refetch()} />;
  else if (tab === 'suggested') body = <CatalogueTab projectId={projectId} plugins={plugins.data} />;
  else if (tab === 'source') body = <AddFromSource projectId={projectId} onInstalled={() => setTab('installed')} />;
  else body = <InstalledTab projectId={projectId} plugins={plugins.data} usage={usage.data ?? []} />;

  return (
    <div data-testid="skills-plugins-section" data-project={projectId} style={{ display: 'grid', gap: 10 }}>
      <div className="ai-tabs" role="tablist" style={{ marginTop: 0 }}>
        {tabs.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={`ai-tab${tab === k ? ' ai-tab-active' : ''}`}
            onClick={() => setTab(k)}
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
