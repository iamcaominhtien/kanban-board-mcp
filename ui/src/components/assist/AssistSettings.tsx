import { useState } from 'react';
import { assistApi, useAssistState } from '../../api/assist';
import { extractError } from '../../api/extractError';
import type { AssistState, FeatureKey } from '../../types/assist';
import { Toggle } from '../ai/aiUi';
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

/** Settings → AI, top: features, language, tone and the style guide (F1). */
function FeaturesBlock({ projectId, s }: { projectId: string; s: AssistState }) {
  const { error, save } = useSave(projectId);
  const [guide, setGuide] = useState(s.styleGuide);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div className="as-label" style={{ marginTop: 0 }}>
          Features
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

/** Settings → AI, continued: what is sent to Claude Code (F2). */
function SentBlock({ s }: { s: AssistState }) {
  const provider = s.boardAi.providerLabel ?? 'Claude Code';
  return (
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
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#1E2A22', lineHeight: 1.5 }}>
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
      <div className="ai-muted" style={{ marginTop: 4 }}>
        The Board AI is a Claude Code session: one conversation per chat, summarised by Claude Code when it gets long.
        Set how early under Settings › AI › Limits › Auto-compact at.
      </div>
    </div>
  );
}

/** The Board AI itself: the first team of the project, run by Claude Code (F1, "BOARD AI"). */
function BoardAiBlock({ s, onOpenAiTeam }: { s: AssistState; onOpenAiTeam?: () => void }) {
  const ready = s.boardAi.state === 'ready';
  return (
    <div className="ai-card" style={{ display: 'flex', alignItems: 'center', gap: 12 }} data-testid="assist-board-ai">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="as-label" style={{ margin: 0 }}>
          Board AI
        </div>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          {s.boardAi.name ?? 'Board AI'}{' '}
          <span className="ai-chip" style={ready ? { background: '#E6F2EA', color: '#1F5A31' } : undefined}>
            {ready ? 'Online' : (s.boardAi.status?.label ?? 'Claude Code was not found')}
          </span>
        </div>
        <div className="ai-muted">The first team of this project · Claude Code. Its lead answers in the chat.</div>
      </div>
      {onOpenAiTeam && (
        <button type="button" className="ai-link" onClick={onOpenAiTeam}>
          Open AI Team →
        </button>
      )}
    </div>
  );
}

/** Settings → AI (board-wide): the Board AI, its features and what it is sent (design/screens/ai-board-assistant.md, F). */
export function AssistSettings({ projectId, onOpenAiTeam }: { projectId: string; onOpenAiTeam?: () => void }) {
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
      <BoardAiBlock s={st.data} onOpenAiTeam={onOpenAiTeam} />
      <SettingsCard title="Features" hint="What the board assistant does in this project, its language and tone.">
        <FeaturesBlock key={`f-${st.data.styleGuide.length}`} projectId={projectId} s={st.data} />
      </SettingsCard>
      <SettingsCard title="What it may read" hint="What the Board AI is sent.">
        <SentBlock s={st.data} />
      </SettingsCard>
    </div>
  );
}
