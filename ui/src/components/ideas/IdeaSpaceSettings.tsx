import { useState } from 'react';
import { extractError } from '../../api/extractError';
import { useIdeaAiStatus, useUpdateIdeaAiSettings, type IdeaAiSettings } from '../../api/ideaAi';
import './ideas.css';

interface RowProps {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}

function SwitchRow({ label, hint, checked, disabled, onChange, testId }: RowProps) {
  return (
    <label className="is-set-row" data-testid={testId}>
      <span>
        <b>{label}</b>
        <span className="is-muted is-set-hint">{hint}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
    </label>
  );
}

/** Settings › Idea Space: four switches, one AI member, what it can read, one cap. All on by default. */
export function IdeaSpaceSettings({ projectId, onManageAi }: { projectId: string; onManageAi?: () => void }) {
  const status = useIdeaAiStatus(projectId).data;
  const update = useUpdateIdeaAiSettings(projectId);
  const [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  if (!status) return <div className="is-muted">Loading…</div>;
  const s = status.settings;
  const set = (patch: Partial<IdeaAiSettings>) => {
    setError(null);
    update.mutate(patch, { onError: (e) => setError(extractError(e)) });
  };
  const off = !s.enabled;

  return (
    <div
      className="is-root is-settings"
      style={{ background: 'transparent', flex: 'none' }}
      data-testid="idea-settings"
    >
      <p className="is-muted">AI helpers and what they may use. Everything else in Idea Space works without them.</p>

      <section className="is-set-card" data-setting="idea-ai-enable">
        <h3>AI help in Idea Space</h3>
        <p className="is-muted">
          Turn the optional helpers on or off for this project. Off hides every AI button and panel in Idea Space.
        </p>
        <SwitchRow
          label="Enable AI help"
          hint="Off hides every AI button and panel in Idea Space."
          checked={s.enabled}
          onChange={(enabled) => set({ enabled })}
          testId="idea-ai-enable"
        />
        <SwitchRow
          label="Triage advice"
          hint="Suggest Keep, Park, Merge or Archive for new ideas."
          checked={s.triageAdvice}
          disabled={off}
          onChange={(triageAdvice) => set({ triageAdvice })}
        />
        <SwitchRow
          label="Weekly grooming"
          hint="Write a digest every Monday at 9:00. Findings are worked out on this computer; the AI adds one sentence."
          checked={s.weeklyGrooming}
          disabled={off}
          onChange={(weeklyGrooming) => set({ weeklyGrooming })}
        />
        <SwitchRow
          label="Ask about ideas"
          hint="Show the side panel."
          checked={s.ask}
          disabled={off}
          onChange={(ask) => set({ ask })}
        />
      </section>

      <section className="is-set-card" data-setting="idea-ai-member">
        <h3>Who and what it may use</h3>
        <p className="is-muted">The AI member and the data it can read.</p>
        <div className="is-set-row">
          <span>
            <b>AI member</b>
            <span className="is-muted is-set-hint">
              Uses that member’s own limits and permissions: the Board AI of this project.
            </span>
          </span>
          <span>
            {status.member ?? 'None chosen'}{' '}
            {onManageAi && (
              <button type="button" className="is-link" onClick={onManageAi}>
                Change
              </button>
            )}
          </span>
        </div>
        <SwitchRow
          label="Read Docs and tickets"
          hint="To find duplicates and related work."
          checked={s.readDocs}
          disabled={off}
          onChange={(readDocs) => set({ readDocs })}
        />
        <SwitchRow
          label="Read the linked repository"
          hint="To guess effort. Read only: file names, never contents."
          checked={s.readRepo}
          disabled={off}
          onChange={(readRepo) => set({ readRepo })}
        />
        <div className="is-set-row">
          <span>
            <b>Use the web</b>
            <span className="is-muted is-set-hint">Not offered in v1.</span>
          </span>
          <input type="checkbox" role="switch" checked={false} disabled aria-label="Use the web" />
        </div>
      </section>

      <section className="is-set-card" data-setting="idea-ai-cap">
        <h3>Cost</h3>
        <p className="is-muted">Shown before each action and added up on the AI member’s page.</p>
        <div className="is-set-row">
          <span>
            <b>Daily cap for Idea Space ($)</b>
            <span className="is-muted is-set-hint">
              Counts toward the board’s daily cap too. When reached, helpers stop and say so.
            </span>
          </span>
          <input
            className="is-input"
            style={{ width: 90 }}
            type="number"
            min={0.01}
            step={0.25}
            aria-label="Daily cap"
            value={cap ?? s.dailyCap.toFixed(2)}
            disabled={off}
            onChange={(e) => setCap(e.target.value)}
            onBlur={() => {
              const n = parseFloat(cap ?? '');
              setCap(null);
              if (n > 0 && n !== s.dailyCap) set({ dailyCap: n });
            }}
          />
        </div>
        <div className="is-muted" style={{ marginTop: 8 }}>
          Today: ${status.spentToday.toFixed(2)} of ${status.cap.toFixed(2)}.
        </div>
      </section>
      {error && (
        <div className="is-banner is-banner-risk" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
