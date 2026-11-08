import { useState } from 'react';
import { kbApi, useKbList, useKbMutation, useKbSearch } from '../../../api/aiKb';
import { usePatchProjectOps, useProjectOps } from '../../../api/aiProjectOps';
import type { KbStore, KbUpload } from '../../../types/aiKb';
import { LoadError } from '../aiUi';
import { KbAddForm, KindIcon, Snippet, kindName } from './kbParts';
import { KbRow } from './kbRows';

type View = KbStore | 'toc';

const chip = (bg: string, color: string) => ({
  background: bg,
  color,
  fontSize: 11,
  fontWeight: 700,
  padding: '3px 9px',
  borderRadius: 999,
});

/** The knowledge base (design/screens/ai-board-wave3.md, I): what the AIs search, with no embeddings. */
export function KnowledgeBasePanel({ projectId }: { projectId: string }) {
  const list = useKbList(projectId);
  const ops = useProjectOps(projectId);
  const patchOps = usePatchProjectOps(projectId);
  const [view, setView] = useState<View>('project');
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const search = useKbSearch(projectId, term);
  const upload = useKbMutation(projectId, (u: KbUpload) => kbApi.upload(projectId, u));

  if (list.isLoading)
    return (
      <div
        className="ai-skel"
        style={{ height: 120 }}
        aria-busy="true"
        aria-label="Loading"
        data-testid="knowledge-base-panel"
      />
    );
  if (list.error || !list.data)
    return <LoadError what="the knowledge base" error={list.error} onRetry={() => void list.refetch()} />;

  const docs = list.data.documents;
  const sharedOn = list.data.stores.includes('shared');
  // the Shared tab lists the shared store even while this project does not search it (WV-7)
  const sharedDocs = sharedOn ? docs.filter((d) => d.store === 'shared') : (list.data.sharedDocuments ?? []);
  const shown = view === 'toc' ? docs : view === 'shared' ? sharedDocs : docs.filter((d) => d.store === view);
  const tabs: [View, string, number | null][] = [
    ['project', 'This project', docs.filter((d) => d.store === 'project').length],
    ['shared', 'Shared', sharedDocs.length],
    ['toc', 'Table of contents', null],
  ];

  return (
    <div
      data-testid="knowledge-base-panel"
      data-project={projectId}
      style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}
    >
      <div style={{ flex: '1 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 15 }}>Knowledge base</b>
          <span style={chip('#E6F2EA', '#1F5A31')}>This project</span>
          {sharedOn ? (
            <span style={chip('#EFE8FB', '#5B3AA6')}>+ shared store</span>
          ) : (
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              disabled={patchOps.isPending || ops.isLoading}
              onClick={() => patchOps.mutate({ knowledgeShared: true })}
            >
              Search the shared store too
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="ai-btn ai-btn-primary ai-btn-sm"
            onClick={() => setAdding(!adding)}
            aria-expanded={adding}
          >
            Add files
          </button>
        </div>
        {adding && (
          <KbAddForm
            sharedOn={sharedOn}
            busy={upload.isPending}
            onCancel={() => setAdding(false)}
            onSubmit={async (u) => {
              await upload.mutateAsync(u);
              setAdding(false);
            }}
          />
        )}
        <form
          role="search"
          style={{ display: 'flex', gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            setTerm(q.trim());
          }}
        >
          <input
            className="ai-input"
            aria-label="Search the knowledge base"
            placeholder="Search as the AIs do: keywords"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (!e.target.value.trim()) setTerm('');
            }}
          />
          <button type="submit" className="ai-btn" disabled={!q.trim()}>
            Search
          </button>
        </form>
        {term && (
          <div
            className="ai-card"
            style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}
            data-testid="kb-results"
          >
            {search.isLoading ? (
              <div className="ai-skel" style={{ height: 40 }} aria-busy="true" />
            ) : search.error ? (
              <LoadError what="the search" error={search.error} onRetry={() => void search.refetch()} />
            ) : !search.data?.length ? (
              <div className="ai-hint">Nothing found for “{term}”. The AIs would try another wording.</div>
            ) : (
              search.data.map((h) => (
                <div key={h.id} data-testid="kb-hit" style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                  <KindIcon kind={h.kind} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <b style={{ fontSize: 12.5 }}>{h.title}</b>
                      <span className="ai-muted">
                        {kindName(h.kind)} · from the {h.store === 'shared' ? 'shared store' : 'project store'} · score{' '}
                        {h.score.toFixed(2)}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, lineHeight: 1.55, color: '#3A4A3E' }}>
                      <Snippet text={h.snippet} />
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
        <div className="ai-tabs" role="tablist" style={{ marginTop: 0 }}>
          {tabs.map(([key, label, n]) => (
            <button
              key={key}
              role="tab"
              aria-selected={view === key}
              className={`ai-tab${view === key ? ' ai-tab-active' : ''}`}
              onClick={() => setView(key)}
            >
              {label}
              {n != null && <span className="ai-tab-count">{n}</span>}
            </button>
          ))}
        </div>
        {view === 'shared' && !sharedOn && (
          <div className="ai-hint" data-testid="kb-shared-off" style={{ padding: '2px 4px' }}>
            This project does not search the shared store, so its AIs cannot find these. “Search the shared store too”
            turns it on.
          </div>
        )}
        {shown.length === 0 ? (
          <div className="ai-hint" data-testid="kb-empty" style={{ padding: '14px 4px' }}>
            {view === 'shared' && !sharedOn
              ? 'Nothing in the shared store yet.'
              : docs.length === 0
                ? 'Nothing here yet. Add a file and the AIs can look things up in it.'
                : 'Nothing in this store yet.'}
          </div>
        ) : view === 'toc' ? (
          <div style={{ overflowX: 'auto' }}>
            <table className="ai-table" data-testid="kb-toc">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>One line</th>
                  <th>Kind</th>
                  <th>Store</th>
                  <th>Who sees it</th>
                  <th>Last read</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => (
                  <KbRow key={d.id} projectId={projectId} doc={d} sharedOn={sharedOn} table />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          shown.map((d) => <KbRow key={d.id} projectId={projectId} doc={d} sharedOn={sharedOn} table={false} />)
        )}
        <div className="ai-hint" style={{ fontSize: 11.5 }}>
          Each file was turned into text when it was added. A light model wrote the one-line summary and the keywords,
          once. Nothing is sent anywhere but Claude, and there is no embedding service and no extra key.
        </div>
      </div>
    </div>
  );
}
