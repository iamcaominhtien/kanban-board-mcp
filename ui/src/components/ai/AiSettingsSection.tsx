import { useState } from 'react';
import { aiApi, useAiOverview } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiSettings } from '../../types/ai';
import { BoardAiPicker } from './AiDialogs';
import { AiAvatar, Toggle } from './aiUi';
import { LibraryModal } from './config/LibraryView';

const EXPIRY = [
  [1, '1 h'],
  [4, '4 h'],
  [24, '24 h'],
  [72, '3 days'],
] as const;

/** Safe mode and the board-wide limits (design/screens/ai-safety-cost.md, B5, C4, D5, G). */
function AiSafetySettings({ projectId, settings }: { projectId: string; settings: AiSettings }) {
  const [error, setError] = useState<string | null>(null);
  const save = async (body: Partial<AiSettings>) => {
    setError(null);
    try {
      await aiApi.updateSettings(projectId, body);
    } catch (e) {
      setError(extractError(e));
    }
  };
  const money = (v: string) => (v.trim() === '' ? null : Number(v));
  return (
    <div
      className="ai-card"
      data-setting="ai-limits"
      style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div data-setting="safe-mode" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Safe mode</div>
          <div className="ai-hint">AI members may only read and comment; every other action is blocked.</div>
        </div>
        <Toggle
          on={settings.safeMode}
          label="Safe mode"
          testId="ai-safe-mode"
          onChange={(v) => void save({ safeMode: v })}
        />
      </div>
      <div className="ai-divider" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <label className="ai-field">
          <span className="ai-label">Board daily cap ($)</span>
          <input
            className="ai-input"
            type="number"
            min={0}
            step="0.5"
            defaultValue={settings.boardDailyCap ?? ''}
            placeholder="No cap"
            onBlur={(e) => void save({ boardDailyCap: money(e.target.value) })}
          />
        </label>
        <label className="ai-field">
          <span className="ai-label">Board monthly budget ($)</span>
          <input
            className="ai-input"
            type="number"
            min={0}
            step="1"
            defaultValue={settings.boardMonthlyBudget ?? ''}
            placeholder="No budget"
            onBlur={(e) => void save({ boardMonthlyBudget: money(e.target.value) })}
          />
        </label>
        <label className="ai-field">
          <span className="ai-label">Max chain depth</span>
          <input
            className="ai-input"
            type="number"
            min={1}
            max={10}
            defaultValue={settings.maxChainDepth}
            onBlur={(e) => void save({ maxChainDepth: Number(e.target.value) })}
          />
        </label>
        <label className="ai-field">
          <span className="ai-label">Runs per ticket a day</span>
          <input
            className="ai-input"
            type="number"
            min={1}
            max={50}
            defaultValue={settings.runsPerTicketPerDay}
            onBlur={(e) => void save({ runsPerTicketPerDay: Number(e.target.value) })}
          />
        </label>
      </div>
      <div className="ai-field">
        <span className="ai-label">Approvals expire after</span>
        <div className="ai-seg">
          {EXPIRY.map(([h, label]) => (
            <button
              key={h}
              type="button"
              className={settings.approvalExpiryHours === h ? 'ai-seg-on' : ''}
              onClick={() => void save({ approvalExpiryHours: h })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}

/** Settings › AI: the Board AI selector, safe mode and the board-wide limits (A4). The board assistant has its own page. */
export function AiSettingsSection({ projectId, onManage }: { projectId: string; onManage?: () => void }) {
  const overview = useAiOverview(projectId);
  const [picker, setPicker] = useState(false);
  const [library, setLibrary] = useState(false);
  const members = overview.data?.members ?? [];
  const boardAi = members.find((m) => m.id === overview.data?.settings.boardAiId);
  return (
    <div
      className="ai-root"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      data-testid="settings-ai"
      data-setting="board-ai"
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>Board AI</span>
        <button
          type="button"
          className="ai-link"
          data-testid="open-library"
          onClick={() => setLibrary(true)}
          style={{ marginRight: 12 }}
        >
          Library
        </button>
        {onManage && (
          <button type="button" className="ai-link" onClick={onManage}>
            Manage AI members
          </button>
        )}
      </div>
      <div
        className="ai-card"
        style={{
          padding: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: '#F1F8F3',
          borderColor: '#BFDCC7',
        }}
      >
        {boardAi && <AiAvatar provider={boardAi.provider} color={boardAi.color} glyph={boardAi.glyph} size={32} />}
        <div style={{ flex: 1 }}>
          <div className="ai-label" style={{ color: '#2E6F40', display: 'flex', alignItems: 'center', gap: 6 }}>
            Board AI
            {boardAi && (
              <span
                className="ai-chip"
                style={{ height: 18, background: '#EAF5ED', color: '#2E6F40', textTransform: 'none', letterSpacing: 0 }}
              >
                {boardAi.status.label}
              </span>
            )}
          </div>
          <div className="ai-hint">
            Used for the chatbot, ticket drafting, suggestions and board management. Currently{' '}
            <b style={{ color: '#1E2A22' }}>{boardAi?.name ?? 'not chosen'}</b>.
          </div>
        </div>
        <button type="button" className="ai-btn ai-btn-sm" disabled={!members.length} onClick={() => setPicker(true)}>
          Change
        </button>
      </div>
      <div className="ai-muted">
        Changing it never affects who is assigned to tickets; it only picks which AI answers board-wide requests.
      </div>
      <div className="ai-divider" />
      <div style={{ fontSize: 13, fontWeight: 700 }}>AI members · safety and limits</div>
      {overview.data && <AiSafetySettings projectId={projectId} settings={overview.data.settings} />}
      {library && <LibraryModal projectId={projectId} onClose={() => setLibrary(false)} />}
      {picker && overview.data && (
        <BoardAiPicker
          projectId={projectId}
          members={members}
          currentId={overview.data.settings.boardAiId}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}
