import { useState } from 'react';
import { usePageJob, type SummaryResult } from '../../../api/docsAiPage';
import { moneyLabel, problemLine } from '../../../utils/pageAiRules';
import type { PageAiView } from './usePageAiView';
import './pageAi.css';

/**
 * "Summarise": a dashed block above the page, marked as AI and not part of it (docs-ai E1). It is view state: Hide
 * removes it, Copy puts the text on the clipboard, and inserting it needs the editor.
 */
export function SummaryBlock({ view }: { view: PageAiView }) {
  const s = view.summary;
  const { job, running, result, error } = usePageJob<SummaryResult>(s?.jobId);
  const [copied, setCopied] = useState(false);
  if (!s) return null;
  const waiting = !s.problem && (!s.jobId || running);
  const fail = s.problem ?? error;
  return (
    <div className="pai-summary" data-testid="page-summary" role="region" aria-label="Summary by AI">
      <div className="pai-head">
        <b>SUMMARY</b>
        <span className="pai-tag">✦ AI</span>
        <span>
          {s.of === 'selection' ? 'of the selection · ' : ''}not part of the page
          {result ? ` · ${moneyLabel(result.cost, result.metered)}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="pai-link" onClick={view.hideSummary} data-testid="summary-hide">
          Hide
        </button>
      </div>
      {waiting && (
        <div aria-live="polite" style={{ display: 'grid', gap: 8 }} data-testid="summary-loading">
          <div className="pai-skel" style={{ width: '92%' }} />
          <div className="pai-skel" style={{ width: '70%' }} />
        </div>
      )}
      {fail && (
        <div className="pai-err" role="alert">
          {problemLine(fail.code, fail.detail)}
        </div>
      )}
      {result && (
        <>
          <div style={{ fontSize: 15, lineHeight: 1.55, color: '#1e2a22' }} data-testid="summary-text">
            {result.text}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="st-btn st-btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(result.text);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <span className="pai-foot">Insert at top is available when you edit the page</span>
          </div>
        </>
      )}
      {job?.reads && job.reads.some((r) => r.cut) && (
        <div className="pai-foot">The page is long: only its first sections were read.</div>
      )}
    </div>
  );
}
