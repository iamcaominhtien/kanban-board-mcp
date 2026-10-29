import { useState } from 'react';
import { assistApi, useAssistState } from '../../api/assist';
import { useDocsTree } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { AssistState, FeatureKey } from '../../types/assist';
import { Toggle } from '../ai/aiUi';
import { usd } from './assistUi';
import './assist.css';

const LANGUAGES = ['English (US)', 'English (UK)', 'Tiếng Việt', 'Français', 'Deutsch', 'Español', '日本語'];
const TONES = [
  ['neutral', 'Neutral'],
  ['friendly', 'Friendly'],
  ['concise', 'Concise'],
] as const;

function useSave(projectId: string) {
  const [error, setError] = useState<string | null>(null);
  const save = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      await assistApi.updateSettings(projectId, body);
    } catch (e) {
      setError(extractError(e));
    }
  };
  return { error, save };
}

/** Settings → AI, top: features with their cost this month, language, tone and the style guide (H1). */
function FeaturesBlock({ projectId, s }: { projectId: string; s: AssistState }) {
  const { error, save } = useSave(projectId);
  const [guide, setGuide] = useState(s.styleGuide);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div className="as-label" style={{ marginTop: 0 }}>
          Features · cost this month
        </div>
        <div className="ai-card" style={{ padding: 0 }}>
          {s.features.map((f, i) => (
            <div
              key={f.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderTop: i ? '1px solid #EDF1EE' : 'none',
              }}
            >
              <Toggle
                on={f.on}
                label={f.label}
                testId={`feature-${f.key}`}
                onChange={(v) => void save({ features: { [f.key as FeatureKey]: v } })}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{f.label}</div>
                <div className="ai-muted">
                  {f.key === 'health' ? `Daily insights at ${s.health.time}` : f.description}
                </div>
              </div>
              <span className="ai-mono" style={{ fontSize: 12, color: f.on ? '#1E2A22' : '#9AA8A0' }}>
                {f.costMonth > 0 ? usd(f.costMonth, 2) : '—'}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="ai-field" style={{ minWidth: 180 }}>
          <span className="ai-label">Language</span>
          <select className="ai-input" value={s.language} onChange={(e) => void save({ language: e.target.value })}>
            {[...new Set([s.language, ...LANGUAGES])].map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <div className="ai-field">
          <span className="ai-label">Tone</span>
          <div className="ai-seg">
            {TONES.map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={s.tone === k ? 'ai-seg-on' : ''}
                onClick={() => void save({ tone: k })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <label className="ai-field">
        <span style={{ display: 'flex' }}>
          <span className="ai-label" style={{ flex: 1 }}>
            Style guide for ticket drafts
          </span>
          <span className="ai-muted">
            {guide.length} / {s.styleGuideMax}
          </span>
        </span>
        <textarea
          className="ai-textarea"
          rows={3}
          maxLength={s.styleGuideMax}
          value={guide}
          placeholder="Always include acceptance criteria. Titles are imperative, 70 characters at most."
          onChange={(e) => setGuide(e.target.value)}
          onBlur={() => guide !== s.styleGuide && void save({ styleGuide: guide })}
          data-testid="style-guide"
        />
      </label>
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}

/** Settings → AI, continued: data scope, excluded docs, what is sent, cost limits (H2). */
function DataBlock({ projectId, s, onOpenAudit }: { projectId: string; s: AssistState; onOpenAudit?: () => void }) {
  const { error, save } = useSave(projectId);
  const tree = useDocsTree(projectId);
  const [pick, setPick] = useState(false);
  const provider = s.boardAi.providerLabel ?? 'the provider';
  const excluded = s.excludedDocs.map((d) => d.id);
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="assist-data-limits">
      <div>
        <div className="as-label" style={{ marginTop: 0 }}>
          Data scope · what the Board AI may read
        </div>
        <div className="ai-card" style={{ padding: 0 }}>
          {s.dataScope.map((p, i) => (
            <div
              key={p.projectId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 12px',
                borderTop: i ? '1px solid #EDF1EE' : 'none',
              }}
            >
              <Toggle
                on={p.shared}
                label={`Share ${p.name}`}
                onChange={(v) => void save({ dataScope: [{ projectId: p.projectId, shared: v }] })}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
                <div className="ai-muted">
                  {p.shared
                    ? p.docs
                      ? `Tickets, comments and ${p.sharedDocs} of ${p.docs} docs`
                      : 'Tickets and comments'
                    : 'Not shared with the Board AI'}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="as-label">Excluded docs</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, position: 'relative' }}>
          {s.excludedDocs.map((d) => (
            <span key={d.id} className="as-ctx-chip">
              <span>🔒 {d.title}</span>
              <button
                type="button"
                aria-label={`Include ${d.title} again`}
                onClick={() => void save({ excludedDocs: excluded.filter((x) => x !== d.id) })}
              >
                ✕
              </button>
            </span>
          ))}
          <button type="button" className="ai-link" onClick={() => setPick((v) => !v)}>
            + Exclude a doc
          </button>
          {pick && (
            <div className="as-menu" style={{ top: 26, left: 0, maxHeight: 220, overflowY: 'auto' }}>
              {(tree.data ?? [])
                .filter((n) => !excluded.includes(n.id))
                .map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      setPick(false);
                      void save({ excludedDocs: [...excluded, n.id] });
                    }}
                  >
                    📄 {n.title}
                  </button>
                ))}
              {!tree.data?.length && (
                <div className="ai-muted" style={{ padding: 8 }}>
                  No docs in this project
                </div>
              )}
            </div>
          )}
        </div>
        <div className="ai-muted" style={{ marginTop: 4 }}>
          Excluded docs are private: never sent, never cited. Their owner can include one for a single chat.
        </div>
      </div>
      <div>
        <div className="as-label">What is sent to {provider}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 12.5 }}>
          {(
            [
              ['Ticket titles and descriptions', true],
              ['Comments on tickets in scope', true],
              ['Docs in scope, not excluded', true],
              ['API keys and secrets, never', false],
              ['Attachments', false],
              ['Docs marked private, unless included', false],
            ] as const
          ).map(([label, sent]) => (
            <div key={label} style={{ color: sent ? '#1E2A22' : '#9AA8A0' }}>
              {sent ? '✓' : '✕'} {label}
            </div>
          ))}
        </div>
        {!s.boardAi.metered && s.boardAi.connection === 'local' && (
          <div className="ai-muted" style={{ marginTop: 4 }}>
            The Board AI is a local runner: requests go through the CLI you are signed in to.
          </div>
        )}
      </div>
      <div>
        <div className="as-label">Cost limits for the Board AI</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <label className="ai-field">
            <span className="ai-label">Monthly cap ($)</span>
            <input
              className="ai-input"
              type="number"
              min={0}
              step="1"
              defaultValue={s.monthlyCap ?? ''}
              placeholder="No cap"
              onBlur={(e) => void save({ monthlyCap: num(e.target.value) })}
              data-testid="assist-monthly-cap"
            />
          </label>
          <label className="ai-field">
            <span className="ai-label">Per request ($)</span>
            <input
              className="ai-input"
              type="number"
              min={0}
              step="0.05"
              defaultValue={s.perRequestCap ?? ''}
              placeholder="No cap"
              onBlur={(e) => void save({ perRequestCap: num(e.target.value) })}
            />
          </label>
          <label className="ai-field">
            <span className="ai-label">Over the cap</span>
            <select className="ai-input" value={s.overCap} onChange={(e) => void save({ overCap: e.target.value })}>
              <option value="pause">Pause and tell owners</option>
              <option value="warn">Warn only</option>
            </select>
          </label>
          <div className="ai-field">
            <span className="ai-label">Used this month</span>
            <span style={{ fontSize: 14, fontWeight: 700, paddingTop: 6 }}>
              {usd(s.usedMonth, 2)}
              {s.monthlyCap != null && <span className="ai-muted"> of {usd(s.monthlyCap, 2)}</span>}
            </span>
          </div>
        </div>
        {!s.boardAi.metered && (
          <div className="ai-muted" style={{ marginTop: 4 }}>
            Caps apply to API-key Board AIs; a local runner uses its subscription and is not metered.
          </div>
        )}
      </div>
      {onOpenAudit && (
        <button type="button" className="ai-link" style={{ alignSelf: 'flex-start' }} onClick={onOpenAudit}>
          Audit log: AI safety & cost
        </button>
      )}
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}

/** Settings → AI (board-wide): the full home of the Board AI (design/screens/ai-board-assistant.md, H). */
export function AssistSettings({ projectId, onOpenAudit }: { projectId: string; onOpenAudit?: () => void }) {
  const st = useAssistState(projectId);
  if (!st.data) return <div className="as-skel" style={{ height: 120 }} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="assist-settings">
      <FeaturesBlock key={`f-${st.data.styleGuide.length}`} projectId={projectId} s={st.data} />
      <div className="ai-divider" />
      <div style={{ fontSize: 13, fontWeight: 700 }}>AI · data and limits</div>
      <DataBlock
        key={`d-${st.data.monthlyCap}-${st.data.perRequestCap}`}
        projectId={projectId}
        s={st.data}
        onOpenAudit={onOpenAudit}
      />
    </div>
  );
}
