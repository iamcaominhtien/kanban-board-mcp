import { useDocsAccess } from '../../../api/docsAccess';
import { useDocsTree } from '../../../api/docs';
import { docsAiError, useDocsAiState, useUpdateDocsAi, type DocsAiSettingsPatch } from '../../../api/docsAi';
import type { Project } from '../../../types/ticket';
import { Switch } from '../../settings/settingsUi';

const box: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14 };
const label: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: '#1E2A22' };
const hint: React.CSSProperties = { fontSize: 12, color: '#5B6B60', lineHeight: 1.5 };
const select: React.CSSProperties = {
  font: 'inherit',
  fontSize: 13,
  minHeight: 34,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid #C7D2CB',
  background: '#fff',
  color: '#1E2A22',
  maxWidth: 240,
};

function Row({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={label}>{title}</div>
        <div style={hint}>{text}</div>
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

/** Settings › Docs › AI (docs-ai-care F1): the switch, which AI team answers, the style guide page, freshness checks. */
export function DocsAiSettings({ project }: { project: Project }) {
  const state = useDocsAiState(project.id);
  const update = useUpdateDocsAi(project.id);
  const access = useDocsAccess(project.id, project.docsEnabled !== false);
  const tree = useDocsTree(project.id);
  const d = state.data;
  if (!d) return null;
  const admin = access.data?.role === 'admin';
  const save = (patch: DocsAiSettingsPatch) => update.mutate(patch);
  const err = update.error ? (docsAiError(update.error)?.detail ?? 'Could not save.') : null;
  const pages = tree.data ?? [];
  const off = !d.enabled;
  return (
    <div className="docs-root" style={box} data-testid="docs-ai-settings">
      <Row title="Use AI in Docs" text="Ask the docs, the AI menu, Check this page and Docs health. Off by default.">
        <Switch
          on={d.enabled}
          label="Use AI in Docs"
          disabled={!admin || update.isPending || !d.master}
          onChange={(v) => save({ enabled: v })}
          testId="docs-ai-enabled"
        />
      </Row>
      {!d.master && (
        <div style={hint}>
          Docs AI is switched off for the whole board (Settings › AI › Features). Turn it on there first.
        </div>
      )}
      {d.enabled && d.state === 'no_member' && (
        <div role="status" style={{ ...hint, color: '#B4541A' }}>
          {d.problem?.code === 'paused'
            ? d.problem.message
            : 'No AI team can read this space. Pick one below or add an AI team in Members.'}
        </div>
      )}
      {!admin && <div style={hint}>Only project admins change these settings.</div>}
      <div style={{ opacity: off ? 0.55 : 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Row
          title="AI that answers"
          text="Docs answers and checks run with this AI team (its account and model, and its budget). Default: the first AI team of the project that is not paused."
        >
          <select
            style={select}
            value={d.memberId ?? ''}
            disabled={!admin || off}
            onChange={(e) => save({ memberId: e.target.value || null })}
            aria-label="AI that answers"
          >
            <option value="">First AI team (default)</option>
            {d.candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Style guide page" text="Used by Check this page and Write with AI.">
          <select
            style={select}
            value={d.stylePageId ?? ''}
            disabled={!admin || off}
            onChange={(e) => save({ stylePageId: e.target.value || null })}
            aria-label="Style guide page"
          >
            <option value="">None</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </Row>
        <Row
          title="Freshness checks"
          text="Compare pages with their tickets every day. A digest goes out on Mondays at 09:00."
        >
          <Switch
            on={d.freshnessOn}
            label="Freshness checks"
            disabled={!admin || off}
            onChange={(v) => save({ freshnessOn: v })}
          />
        </Row>
      </div>
      {err && (
        <div role="alert" style={{ fontSize: 12, color: '#C4432A' }}>
          {err}
        </div>
      )}
    </div>
  );
}
