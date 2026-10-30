import { useEffect, useState } from 'react';
import { docsAiError, useDocsAiJob, useDocsAiState } from '../../../api/docsAi';
import { useStartSinceViewed, type SinceViewedPage } from '../../../api/docsAiWrite';
import { aiGate, costLabel } from '../../../utils/docsAiRules';
import { pagesLabel } from '../../../utils/writeRules';
import type { DocsTreeNode } from '../../../types/docs';
import { Icon } from '../Icon';
import { AiSpark } from './AiSpark';

const key = (projectId: string) => `docsLastVisit:${projectId}`;

/** When this person last opened the space (read once per mount, then moved to now). Null when never. */
function useLastVisit(projectId: string): string | null {
  const [since] = useState<string | null>(() => {
    try {
      return localStorage.getItem(key(projectId));
    } catch {
      return null;
    }
  });
  useEffect(() => {
    // leave the old value readable for this visit; record the new one when the space is left
    const save = () => {
      try {
        localStorage.setItem(key(projectId), new Date().toISOString());
      } catch {
        /* storage unavailable */
      }
    };
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      save();
    };
  }, [projectId]);
  return since;
}

interface Props {
  projectId: string;
  nodes: DocsTreeNode[];
  onOpenPage: (pageId: string) => void;
}

/**
 * "Changes since you last viewed" at the top of the space (docs-ai-care D3): one line per page changed since this
 * person was last here, summarised by AI on request. Summary only: open a page to see the diff. Nothing renders when
 * Docs AI is off or nothing changed.
 */
export function SinceViewedDigest({ projectId, nodes, onOpenPage }: Props) {
  const state = useDocsAiState(projectId);
  const since = useLastVisit(projectId);
  const [dismissed, setDismissed] = useState(false);
  const start = useStartSinceViewed(projectId);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useDocsAiJob(jobId);

  const changed = since ? nodes.filter((n) => n.version > 0 && n.updatedAt > since).length : 0;
  if (dismissed || !aiGate(state.data).show || state.data?.state !== 'ready' || changed === 0) return null;

  const running = start.isPending || (!!jobId && (!job.data || ['queued', 'running'].includes(job.data.state)));
  const done = job.data?.state === 'finished' ? job.data : null;
  const pages = (done?.result.pages as SinceViewedPage[] | undefined) ?? [];
  const problem = start.error
    ? docsAiError(start.error)?.detail
    : job.data?.state === 'failed'
      ? job.data.error.message
      : null;
  if (done && pages.length === 0) return null; // the server found nothing new

  return (
    <div
      className="docs-root"
      data-testid="since-viewed-digest"
      style={{
        position: 'absolute',
        top: 12,
        right: 16,
        width: 340,
        zIndex: 30,
        borderRadius: 12,
        border: '1px solid #E3E8E5',
        background: '#FFFFFF',
        boxShadow: '0 8px 28px rgba(30,42,34,0.14)',
        padding: '10px 12px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'flex', color: '#2E6F40' }}>
          <Icon name="eye" size={16} strokeWidth={1.8} />
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#1E2A22', flex: 1 }}>Changes since you last viewed</span>
        <span className="mc-chip" style={{ background: '#DCEEE1', color: '#1F5A31' }}>
          {pagesLabel(done ? pages.length : changed)}
        </span>
        <button
          type="button"
          className="dk-icobtn"
          aria-label="Dismiss"
          style={{ width: 24, height: 24 }}
          onClick={() => setDismissed(true)}
        >
          <Icon name="close" size={13} strokeWidth={2} />
        </button>
      </div>
      {done ? (
        <div
          style={{
            marginTop: 8,
            padding: '8px 10px',
            borderRadius: 9,
            border: '1px solid #D9CCF7',
            background: '#F8F5FE',
          }}
        >
          {pages.map((p) => (
            <div key={p.pageId} style={{ fontSize: 13, lineHeight: 1.5, color: '#1E2A22' }}>
              <button
                type="button"
                onClick={() => onOpenPage(p.pageId)}
                style={{
                  border: 'none',
                  background: 'none',
                  padding: 0,
                  font: 'inherit',
                  fontWeight: 700,
                  cursor: 'pointer',
                  color: '#1E2A22',
                }}
              >
                {p.title}
              </button>
              :{' '}
              {p.line ??
                (p.hidden
                  ? 'changed (hidden from AI, so not summarised)'
                  : p.kind === 'new'
                    ? 'a new page'
                    : 'changed')}
            </div>
          ))}
          <div style={{ fontSize: 11.5, color: '#5B6B60', marginTop: 4 }}>
            Summary by AI · open a page to see the diff · {costLabel(done.cost, done.metered).replace('About ', '')}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className="st-btn st-btn-sm"
            disabled={running}
            data-testid="summarise-since-viewed"
            onClick={() => start.mutate(undefined, { onSuccess: (j) => setJobId(j.id) })}
          >
            <AiSpark size={12} />
            {running ? 'Reading the pages…' : 'Summarise with AI'}
          </button>
          <span style={{ fontSize: 11.5, color: '#5B6B60' }}>One line per page. Nothing is changed.</span>
        </div>
      )}
      {problem && (
        <div role="alert" style={{ marginTop: 6, fontSize: 12, color: '#C4432A' }}>
          {problem}
        </div>
      )}
    </div>
  );
}
