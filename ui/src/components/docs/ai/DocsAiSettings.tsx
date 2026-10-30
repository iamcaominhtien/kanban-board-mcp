import { useDocsAccess } from '../../../api/docsAccess';
import { useDocsTree } from '../../../api/docs';
import { docsAiError, useDocsAiState, useUpdateDocsAi, type DocsAiSettingsPatch } from '../../../api/docsAi';
import type { Project } from '../../../types/ticket';

const box: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '12px 14px',
  background: '#F8FAF8',
  borderRadius: 8,
  border: '1px solid #E3E8E5',
};
const label: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: '#1E2A22' };
const hint: React.CSSProperties = { fontSize: 12, color: '#5B6B60', marginTop: 2 };
const select: React.CSSProperties = {
  font: 'inherit',
  fontSize: 12.5,
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid #D5DDD8',
  background: '#fff',
  maxWidth: 260,
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

/** Settings › Docs › AI (docs-ai-care F1): the switch, who answers, what AI may read, style guide, edits by AI members. */
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
      <span style={{ fontSize: 11.5, fontWeight: 600, color: '#5B6B60' }}>
        {project.name} ({project.prefix}) · Docs › AI
      </span>
      <Row title="Use AI in Docs" text="Ask the docs, the AI menu, Check this page and Docs health. Off by default.">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600 }}>
          <input
            type="checkbox"
            role="switch"
            checked={d.enabled}
            disabled={!admin || update.isPending || !d.master}
            onChange={(e) => save({ enabled: e.target.checked })}
            data-testid="docs-ai-enabled"
          />
          {d.enabled ? 'On' : 'Off'}
        </label>
      </Row>
      {!d.master && (
        <div style={hint}>
          Docs AI is switched off for the whole board (Settings › AI › Features). Turn it on there first.
        </div>
      )}
      {d.enabled && d.state === 'no_member' && (
        <div role="status" style={{ ...hint, color: '#B4541A' }}>
          No AI member can read this space. Pick one below or add an AI member in Members.
        </div>
      )}
      {!admin && <div style={hint}>Only project admins change these settings.</div>}
      <div style={{ opacity: off ? 0.55 : 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Row title="AI that answers" text="Answers and checks are made by this AI member. It counts toward its budget.">
          <select
            style={select}
            value={d.memberId ?? ''}
            disabled={!admin || off}
            onChange={(e) => save({ memberId: e.target.value || null })}
            aria-label="AI that answers"
          >
            <option value="">Board AI (default)</option>
            {d.candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Row>
        <Row title="What AI may read" text="Pages hidden from AI are never read, by anyone's AI.">
          <select
            style={select}
            value={d.readScope}
            disabled={!admin || off}
            onChange={(e) => save({ readScope: e.target.value as DocsAiSettingsPatch['readScope'] })}
            aria-label="What AI may read"
          >
            <option value="all">All pages</option>
            <option value="except_hidden">Except hidden</option>
            <option value="picked">Only picked</option>
          </select>
        </Row>
        {d.readScope === 'picked' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} aria-label="Picked pages">
            {pages.map((p) => {
              const on = d.pickedPages.includes(p.id);
              return (
                <label key={p.id} style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!admin || off}
                    onChange={() =>
                      save({ pickedPages: on ? d.pickedPages.filter((x) => x !== p.id) : [...d.pickedPages, p.id] })
                    }
                  />
                  {p.title}
                </label>
              );
            })}
          </div>
        )}
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
          title="Pages AI should always read"
          text={`Architecture, naming, rules. Read by AI members on every run in this project. Limit ${d.guidanceLimit.toLocaleString()} tokens. Mark a page in its info (AI › Use as AI guidance).`}
        >
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>
            {d.guidancePages.length ? d.guidancePages.map((p) => p.title).join(', ') : 'None'}
          </span>
        </Row>
        <Row
          title="Freshness checks"
          text="Compare pages with their tickets every day. A digest goes out on Mondays at 09:00."
        >
          <input
            type="checkbox"
            role="switch"
            aria-label="Freshness checks"
            checked={d.freshnessOn}
            disabled={!admin || off}
            onChange={(e) => save({ freshnessOn: e.target.checked })}
          />
        </Row>
        <Row
          title="Edits by AI members"
          text="What happens when an AI member wants to change a page. “Make the change” follows each member’s own permissions."
        >
          <select
            style={select}
            value={d.editsMode}
            disabled={!admin || off}
            onChange={(e) => save({ editsMode: e.target.value as DocsAiSettingsPatch['editsMode'] })}
            aria-label="Edits by AI members"
          >
            <option value="direct">Make the change</option>
            <option value="proposal">Proposal to review</option>
            <option value="draft">Draft only</option>
          </select>
        </Row>
        <Row title="Proposals expire after" text="Nothing changes when they expire.">
          <select
            style={select}
            value={d.proposalDays}
            disabled={!admin || off || d.editsMode !== 'proposal'}
            onChange={(e) => save({ proposalDays: Number(e.target.value) })}
            aria-label="Proposals expire after"
          >
            {[3, 7, 14, 30].map((n) => (
              <option key={n} value={n}>
                {n} days
              </option>
            ))}
          </select>
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
