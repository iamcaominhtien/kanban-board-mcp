import { useDocsAccess } from '../../../api/docsAccess';
import { docsAiError, useDocsAiState, useSetPageAiFlags } from '../../../api/docsAi';
import type { DocsPage } from '../../../types/docs';

/**
 * "AI" block of the page info popover (docs-ai-care F2): Hide from AI and Use as AI guidance.
 * Shown when Docs AI is on for the project; only people who can edit the page can change them.
 */
export function PageAiFlags({ page }: { page: DocsPage }) {
  const state = useDocsAiState(page.projectId);
  const access = useDocsAccess(page.projectId);
  const set = useSetPageAiFlags(page.projectId, page.id);
  if (!state.data || state.data.state === 'off') return null;
  const canEdit = !!access.data?.canEdit;
  const hidden = !!page.aiHidden;
  const guidance = !!page.aiGuidance;
  const tokens = Math.max(1, Math.round(page.markdown.length / 4));
  const err = set.error ? (docsAiError(set.error)?.detail ?? 'Could not save.') : null;
  return (
    <div data-testid="page-ai-flags" style={{ borderTop: '1px solid #EEF3EF', marginTop: 6, paddingTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6B5BD2', letterSpacing: 0.4, marginBottom: 4 }}>AI</div>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '4px 0', fontSize: 12.5 }}>
        <input
          type="checkbox"
          checked={hidden}
          disabled={!canEdit || set.isPending}
          onChange={(e) => set.mutate({ hidden: e.target.checked })}
          data-testid="flag-hide-from-ai"
        />
        <span>
          <b style={{ color: '#1E2A22' }}>Hide from AI</b>
          <div style={{ color: '#5B6B60' }}>Ask, summaries and AI runs will not read this page.</div>
        </span>
      </label>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '4px 0', fontSize: 12.5 }}>
        <input
          type="checkbox"
          checked={guidance}
          disabled={!canEdit || hidden || set.isPending}
          onChange={(e) => set.mutate({ guidance: e.target.checked })}
          data-testid="flag-ai-guidance"
        />
        <span>
          <b style={{ color: '#1E2A22' }}>Use as AI guidance</b>
          <div style={{ color: '#5B6B60' }}>
            Every AI run in this project reads it. About {tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens}{' '}
            tokens.
            {hidden ? ' A hidden page cannot be guidance.' : ''}
          </div>
        </span>
      </label>
      {!canEdit && <div style={{ fontSize: 11.5, color: '#9AA8A0' }}>Only people who can edit the page change this.</div>}
      {err && (
        <div role="alert" style={{ fontSize: 12, color: '#C4432A' }}>
          {err}
        </div>
      )}
    </div>
  );
}
