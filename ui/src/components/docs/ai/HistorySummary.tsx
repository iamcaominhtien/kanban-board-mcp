import { useEffect, useState } from 'react';
import { docsAiError, useDocsAiJob, useDocsAiState } from '../../../api/docsAi';
import { useStartHistorySummary } from '../../../api/docsAiWrite';
import { aiGate, costLabel } from '../../../utils/docsAiRules';
import { AiSpark } from './AiSpark';

interface Props {
  projectId: string;
  pageId: string;
  /** Published version numbers, newest first. */
  versions: number[];
  /** Versions ticked in the list: two of them make the range. */
  selected: number[];
}

/** The range to summarise: the two ticked versions, else "since" the picked version up to the newest. */
export function summaryRange(
  versions: number[],
  selected: number[],
  since: number | null,
): { from: number; to: number } | null {
  if (versions.length < 2) return null;
  if (selected.length === 2) {
    const [from, to] = [...selected].sort((a, b) => a - b);
    return { from, to };
  }
  const newest = versions[0];
  const from = since != null && since < newest ? since : versions[Math.min(2, versions.length - 1)];
  return from < newest ? { from, to: newest } : null;
}

/**
 * "WHAT CHANGED SINCE V12" at the top of History: an AI summary of a range of versions (docs-ai-care D1).
 * It reads only when asked, shows its cost, and changes nothing. Nothing renders when Docs AI is off.
 */
export function HistorySummary({ projectId, pageId, versions, selected }: Props) {
  const state = useDocsAiState(projectId);
  const [since, setSince] = useState<number | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const start = useStartHistorySummary(pageId);
  const job = useDocsAiJob(jobId);
  const range = summaryRange(versions, selected, since);
  // a new range makes the shown summary stale
  useEffect(() => setJobId(null), [range?.from, range?.to]);

  if (!aiGate(state.data).show || state.data?.state !== 'ready' || !range) return null;
  const running = start.isPending || (!!jobId && (!job.data || ['queued', 'running'].includes(job.data.state)));
  const done = job.data?.state === 'finished' ? job.data : null;
  const problem = start.error
    ? docsAiError(start.error)?.detail
    : job.data?.state === 'failed'
      ? job.data.error.message
      : null;
  const line = done && typeof done.result.line === 'string' ? done.result.line : null;

  return (
    <div
      data-testid="history-summary"
      style={{
        margin: '0 16px 12px',
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid #D9CCF7',
        background: '#F8F5FE',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: '#5B3FBF' }}>
          WHAT CHANGED SINCE V{range.from}
        </span>
        {done && (
          <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#5B6B60' }}>
            AI · {costLabel(done.cost, done.metered).replace('About ', '')}
          </span>
        )}
      </div>
      {line ? (
        <div style={{ fontSize: 13, lineHeight: 1.5, color: '#1E2A22', marginTop: 6 }}>{line}</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          {selected.length !== 2 && versions.length > 2 && (
            <select
              aria-label="Summarise changes since"
              className="st-input"
              value={range.from}
              onChange={(e) => setSince(Number(e.target.value))}
              style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }}
            >
              {versions.slice(1).map((v) => (
                <option key={v} value={v}>
                  since v{v}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="st-btn st-btn-sm"
            disabled={running}
            data-testid="summarise-history"
            onClick={() =>
              start.mutate({ fromVersion: range.from, toVersion: range.to }, { onSuccess: (j) => setJobId(j.id) })
            }
          >
            <AiSpark size={12} />
            {running ? 'Reading the versions…' : `Summarise v${range.from} → v${range.to}`}
          </button>
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
