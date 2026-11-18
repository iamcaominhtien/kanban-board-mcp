import { useEffect, useState, type CSSProperties } from 'react';
import { docsAiError, useDocsAiJob, useDocsAiState } from '../../../api/docsAi';
import { useStartSinceViewed, type SinceViewedPage } from '../../../api/docsAiWrite';
import { aiGate, costLabel } from '../../../utils/docsAiRules';
import { pagesLabel } from '../../../utils/writeRules';
import type { DocsTreeNode } from '../../../types/docs';
import { AiSpark } from './AiSpark';
import { SuggestionsWaiting } from '../suggestions/extras';
import { SgIcon, Spark } from '../suggestions/sgIcons';

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
  /** On a phone the digest is a sheet from the bottom over a light scrim (AI board H 48). */
  phone?: boolean;
}

/** The corner card (desktop, tablet). */
const CARD: CSSProperties = {
  // bottom right, like a toast: at the top it covered the page's Edit / Share buttons
  position: 'absolute',
  bottom: 16,
  right: 16,
  width: 370,
  maxWidth: 'calc(100% - 32px)',
  zIndex: 4, // under the history / comments drawers, which have their own footers
  borderRadius: 12,
  border: '1px solid #E3E8E5',
  background: '#FFFFFF',
  boxShadow: '0 8px 28px rgba(30,42,34,0.14)',
  padding: '12px 14px 10px',
  boxSizing: 'border-box',
};
/** The phone sheet (H 48): r20 20 0 0, shadow 0 -10 30 .16, grab 36x4, head pad 4 16 6, body pad 0 16 12. */
const SHEET: CSSProperties = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 1100,
  borderRadius: '20px 20px 0 0',
  background: '#FFFFFF',
  boxShadow: '0 -10px 30px rgba(30,42,34,0.16)',
  padding: '0 16px 12px',
  boxSizing: 'border-box',
  maxHeight: '70vh',
  overflowY: 'auto',
};

/**
 * "Changes since you last viewed" as a card in the corner of the space (docs-ai-care D3): one line per page changed since this
 * person was last here, summarised by AI on request. Summary only: open a page to see the diff. Nothing renders when
 * Docs AI is off or nothing changed.
 */
export function SinceViewedDigest({ projectId, nodes, onOpenPage, phone }: Props) {
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

  const count = pagesLabel(done ? pages.length : changed);
  const card = (
    <div
      className="docs-root"
      data-testid="since-viewed-digest"
      role={phone ? 'dialog' : undefined}
      aria-label={phone ? 'Changes since you last viewed' : undefined}
      style={phone ? SHEET : CARD}
    >
      {phone ? (
        <>
          <div
            aria-hidden="true"
            style={{ width: 36, height: 4, borderRadius: 2, background: '#C7D2CB', margin: '8px auto 4px' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0 6px' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>Changes since you last viewed</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#2E6F40' }}>{count}</span>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SgIcon name="eye" size={16} sw={1.8} color="#2E6F40" />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#1E2A22', flex: 1 }}>
            Changes since you last viewed
          </span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: 20,
              padding: '0 8px',
              borderRadius: 999,
              background: '#E6F2EA',
              color: '#1F5A31',
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            {count}
          </span>
          <button
            type="button"
            className="sg-ending-x"
            aria-label="Dismiss"
            style={{ width: 24, height: 24 }}
            onClick={() => setDismissed(true)}
          >
            <SgIcon name="close" size={13} />
          </button>
        </div>
      )}
      <SuggestionsWaiting nodes={nodes} onOpenPage={onOpenPage} />
      {done ? (
        <div style={{ marginTop: 8 }}>
          {pages.map((p) => (
            <button
              key={p.pageId}
              type="button"
              onClick={() => onOpenPage(p.pageId)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                border: 'none',
                borderTop: '1px solid #E3E8E5',
                background: 'none',
                padding: '9px 0',
                font: 'inherit',
                cursor: 'pointer',
                color: '#1E2A22',
              }}
            >
              <span
                style={{
                  display: 'block',
                  fontSize: 13,
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {p.title}
              </span>
              <span style={{ display: 'block', fontSize: 12, color: '#5B6B60', marginTop: 2 }}>
                {p.line ?? (p.kind === 'new' ? 'A new page' : 'Changed')}
              </span>
            </button>
          ))}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              borderTop: '1px solid #E3E8E5',
              paddingTop: 8,
              fontSize: 11.5,
              color: '#5B6B60',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                height: 18,
                padding: '0 8px',
                borderRadius: 999,
                background: '#EFE8FB',
                border: '1px solid #D9CCF7',
                color: '#5B3AA6',
                fontSize: 10.5,
                fontWeight: 700,
                whiteSpace: 'nowrap',
                flex: 'none',
                boxSizing: 'border-box',
              }}
            >
              <Spark size={10.5} color="#5B3AA6" />
              Summary by AI
            </span>
            <span>Open a page to see the diff · {costLabel(done.cost, done.metered).replace('About ', '')}</span>
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
  if (!phone) return card;
  return (
    <>
      <div
        aria-hidden="true"
        data-testid="since-viewed-scrim"
        onClick={() => setDismissed(true)}
        style={{ position: 'fixed', inset: 0, zIndex: 1099, background: 'rgba(30,42,34,0.25)' }}
      />
      {card}
    </>
  );
}
