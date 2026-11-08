import { useState } from 'react';
import { assistApi, useAssistState } from '../../api/assist';
import { useDocsTree } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { AssistState, FeatureKey } from '../../types/assist';
import { Toggle } from '../ai/aiUi';
import { usd } from './assistUi';
import './assist.css';
import { SettingsCard } from '../settings/settingsUi';
import { LineIcon } from '../ui/LineIcon';

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
              {/* H1: name and description on one line, the cost, then the switch at the trailing edge */}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{f.label}</span>
                <span style={{ fontSize: 11.5, color: '#5B6B60' }}>
                  {f.key === 'health' ? `Daily insights at ${s.health.time}` : f.description}
                </span>
              </div>
              <span className="ai-mono" style={{ fontSize: 11, color: f.on ? '#5B6B60' : '#9AA8A0' }}>
                {f.costMonth > 0 ? usd(f.costMonth, 2) : '—'}
              </span>
              <Toggle
                on={f.on}
                label={f.label}
                testId={`feature-${f.key}`}
                onChange={(v) => void save({ features: { [f.key as FeatureKey]: v } })}
              />
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
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Tone">
            {TONES.map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={s.tone === k}
                className={`as-opt ${s.tone === k ? 'as-opt-on' : ''}`}
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
              <Toggle
                on={p.shared}
                label={`Share ${p.name}`}
                onChange={(v) => void save({ dataScope: [{ projectId: p.projectId, shared: v }] })}
              />
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="as-label">Excluded docs</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, position: 'relative' }}>
          {s.excludedDocs.map((d) => (
            <span key={d.id} className="as-ctx-chip">
              <span>
                <LineIcon name="lock" size={13} /> {d.title}
              </span>
              <button
                type="button"
                aria-label={`Include ${d.title} again`}
                onClick={() => void save({ excludedDocs: excluded.filter((x) => x !== d.id) })}
              >
                <LineIcon name="close" size={14} />
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
                    <LineIcon name="page" size={13} /> {n.title}
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
      <div className="as-sent-card" data-testid="assist-sent">
        <div className="as-label" style={{ margin: 0 }}>
          What is sent to {provider}
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gridAutoFlow: 'column',
            gridTemplateRows: 'repeat(3, auto)',
            gap: '4px 18px',
            fontSize: 12,
          }}
        >
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
            <div
              key={label}
              style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#1E2A22', lineHeight: 1.5 }}
            >
              <LineIcon
                name={sent ? 'check' : 'close'}
                size={13}
                strokeWidth={2}
                color={sent ? '#2E6F40' : '#C4432A'}
                title={sent ? 'Sent' : 'Not sent'}
              />
              {label}
            </div>
          ))}
        </div>
        {!s.boardAi.metered && s.boardAi.connection === 'local' && (
          <div className="ai-muted" style={{ marginTop: 4 }}>
            The Board AI is a local runner: requests go through the CLI you are signed in to. Each chat is one
            conversation, so earlier messages are not sent again; when it gets long Claude Code summarizes the older
            part. Set how early in Settings › AI › Limits › Auto-compact at.
          </div>
        )}
      </div>
      <div>
        <div className="as-label">Cost limits for the Board AI</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <label className="ai-field">
            <span className="ai-label">Monthly cap</span>
            <span className="as-money">
              <span aria-hidden>$</span>
              <input
                className="ai-input"
                aria-label="Monthly cap ($)"
                type="number"
                min={0}
                step="1"
                defaultValue={s.monthlyCap ?? ''}
                placeholder="No cap"
                onBlur={(e) => void save({ monthlyCap: num(e.target.value) })}
                data-testid="assist-monthly-cap"
              />
            </span>
          </label>
          <label className="ai-field">
            <span className="ai-label">Per request</span>
            <span className="as-money">
              <span aria-hidden>$</span>
              <input
                className="ai-input"
                aria-label="Per request ($)"
                type="number"
                min={0}
                step="0.05"
                defaultValue={s.perRequestCap ?? ''}
                placeholder="No cap"
                onBlur={(e) => void save({ perRequestCap: num(e.target.value) })}
              />
            </span>
          </label>
          <label className="ai-field">
            <span className="ai-label">Over the cap</span>
            <select className="ai-input" value={s.overCap} onChange={(e) => void save({ overCap: e.target.value })}>
              <option value="pause">Pause and tell owners</option>
              <option value="warn">Warn only</option>
            </select>
          </label>
        </div>
        {/* H2: the month's use under the fields, with a bar when there is a cap */}
        <div style={{ display: 'flex', marginTop: 10 }} data-testid="assist-used">
          <span style={{ fontSize: 11.5, color: '#5B6B60', flex: 1 }}>Used this month</span>
          <span className="ai-mono" style={{ fontSize: 11.5, fontWeight: 700 }}>
            {usd(s.usedMonth, 2)}
            {s.monthlyCap != null && ` of ${usd(s.monthlyCap, 2)}`}
          </span>
        </div>
        {s.monthlyCap != null && s.monthlyCap > 0 && (
          <div
            className="as-usage-bar"
            role="progressbar"
            aria-label="Used this month"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(1, s.usedMonth / s.monthlyCap) * 100)}
          >
            <div
              style={{
                width: `${Math.min(100, (s.usedMonth / s.monthlyCap) * 100)}%`,
                background: s.usedMonth >= s.monthlyCap ? '#C4432A' : '#2E6F40',
              }}
            />
          </div>
        )}
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
  if (st.isError && !st.data)
    return (
      <div className="ai-notice ai-notice-error" data-testid="assist-settings-error">
        Board AI settings could not load: {extractError(st.error)}.{' '}
        <button type="button" className="ai-link" onClick={() => void st.refetch()}>
          Try again
        </button>
      </div>
    );
  if (!st.data) return <div className="as-skel" style={{ height: 120 }} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="assist-settings">
      <SettingsCard
        title="Features"
        hint="What the board assistant does in this project, its language and tone, and what each feature cost this month."
      >
        <FeaturesBlock key={`f-${st.data.styleGuide.length}`} projectId={projectId} s={st.data} />
      </SettingsCard>
      <SettingsCard title="Data and limits" hint="What the Board AI may read, and how much it may spend.">
        <DataBlock
          key={`d-${st.data.monthlyCap}-${st.data.perRequestCap}`}
          projectId={projectId}
          s={st.data}
          onOpenAudit={onOpenAudit}
        />
      </SettingsCard>
    </div>
  );
}
