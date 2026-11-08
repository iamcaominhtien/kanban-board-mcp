import { useEffect, useState, type ReactNode } from 'react';
import { aiApi, useAiMutation, useRunnerInfo } from '../../../api/ai';
import { extractError } from '../../../api/extractError';
import type { AiSettings, PermissionMode } from '../../../types/ai';
import { PERMISSION_MODES } from '../teamOptions';
import { GroupHead, Ico, TeamRow } from './settingsUi';

/** Section A of design/screens/ai-project-settings.md (Running the teams) and the runner card of section F. */

/** Save a partial change of the project's AI settings; true when it was saved, the error of the last try otherwise. */
function useSave(projectId: string) {
  const [error, setError] = useState<string | null>(null);
  const patch = useAiMutation((body: Partial<AiSettings>) => aiApi.updateSettings(projectId, body));
  const save = async (body: Partial<AiSettings>): Promise<boolean> => {
    setError(null);
    try {
      await patch.mutateAsync(body);
      return true;
    } catch (e) {
      setError(extractError(e));
      return false;
    }
  };
  return { save, error, clearError: () => setError(null) };
}

/** One quiet line under a row: an icon and a sentence. */
function Note({ icon, children }: { icon: 'info' | 'lock'; children: ReactNode }) {
  return (
    <div className="to-note">
      <Ico name={icon} size={13} />
      <span>{children}</span>
    </div>
  );
}

const MODE_NOTE: Record<PermissionMode, string> = {
  bypass: 'Bypass: nothing asks first. A short deny list still applies.',
  auto: 'Auto: Claude Code’s own classifier decides what needs a person.',
};

/** The permission mode of new runs and the deny list that holds in both modes. */
export function RunRules({ projectId, settings }: { projectId: string; settings: AiSettings }) {
  const mode = useSave(projectId);
  const rules = useSave(projectId);
  const [deny, setDeny] = useState(settings.denyList.join('\n'));
  const [saved, setSaved] = useState(false);
  // a failed save keeps the lines typed; only a change that comes from the server replaces them
  useEffect(() => setDeny(settings.denyList.join('\n')), [settings.denyList]);
  const saveDeny = async () => {
    const list = deny
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean);
    if (list.join('\n') === settings.denyList.join('\n')) return;
    setSaved(false);
    setSaved(await rules.save({ denyList: list }));
  };
  return (
    <section className="to-sec" data-setting="ai-rules" data-testid="ai-rules">
      <div className="to-group">
        <GroupHead
          title="How teams run"
          hint="The default for every team of the project; a team can pick its own mode on its page."
        />
        <TeamRow title="Permission mode" hint="Takes effect on the next run.">
          <div style={{ display: 'flex', gap: 6 }} role="radiogroup" aria-label="Permission mode">
            {PERMISSION_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={settings.permissionMode === m.id}
                title={m.hint}
                className={`tw-chipbtn ${settings.permissionMode === m.id ? 'tw-chipbtn-on' : ''}`}
                onClick={() =>
                  settings.permissionMode !== m.id && void mode.save({ permissionMode: m.id as PermissionMode })
                }
                data-testid={`settings-permission-${m.id}`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </TeamRow>
        <Note icon="info">{MODE_NOTE[settings.permissionMode] ?? MODE_NOTE.bypass}</Note>
        {mode.error && <div className="ai-error-text">{mode.error}</div>}
        <TeamRow
          title="Deny list"
          hint="One Claude Code tool rule per line, such as Bash(git push --force:*). A run never uses what is listed, in either mode."
        >
          <textarea
            className={`ai-textarea to-mono ${rules.error ? 'ai-input-error' : ''}`}
            style={{ width: 320, minHeight: 80 }}
            aria-label="Deny list"
            aria-invalid={!!rules.error}
            placeholder="One rule per line"
            value={deny}
            onChange={(e) => {
              setDeny(e.target.value);
              setSaved(false);
              rules.clearError();
            }}
            onBlur={() => void saveDeny()}
            data-testid="settings-deny-list"
          />
        </TeamRow>
        {saved && !rules.error && (
          <div className="ai-ok-text" role="status" data-testid="deny-saved">
            Saved. Takes effect on the next run.
          </div>
        )}
        {rules.error && (
          <div className="ai-error-text" role="alert" data-testid="deny-error">
            Could not save the deny list: {rules.error} Your lines are kept in the field.
          </div>
        )}
        <Note icon="lock">
          The board is not a sandbox. Only Claude Code controls the shell, the files and the network.
        </Note>
      </div>
    </section>
  );
}

/** A whole number or empty (null) that saves on blur and keeps what was typed when the save fails. */
function LimitInput({
  value,
  label,
  placeholder,
  min,
  max,
  step,
  width = 110,
  testId,
  onSave,
  onFocusChange,
}: {
  value: number | null | undefined;
  label: string;
  placeholder?: string;
  min: number;
  max?: number;
  step?: string;
  width?: number;
  testId?: string;
  /** Resolves true when the value was saved. Gets null for an empty field. */
  onSave: (n: number | null) => Promise<boolean>;
  onFocusChange?: (on: boolean) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const commit = async () => {
    onFocusChange?.(false);
    if (draft == null) return;
    const text = draft.trim();
    const n = text === '' ? null : Number(text);
    if (n !== null && (!Number.isFinite(n) || n < min)) {
      setDraft(null);
      return;
    }
    if (n === (value ?? null)) {
      setDraft(null);
      return;
    }
    const ok = await onSave(n);
    setFailed(!ok);
    if (ok) setDraft(null);
  };
  return (
    <input
      className={`ai-input ${failed ? 'ai-input-error' : ''}`}
      type="number"
      min={min}
      max={max}
      step={step}
      style={{ width }}
      aria-label={label}
      aria-invalid={failed}
      placeholder={placeholder}
      data-testid={testId}
      value={draft ?? (value == null ? '' : String(value))}
      onFocus={() => onFocusChange?.(true)}
      onChange={(e) => {
        setDraft(e.target.value);
        setFailed(false);
      }}
      onBlur={() => void commit()}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

/** Caps and budgets for the whole project. The money caps show only once a run has reported a real cost (C-12). */
export function LimitSettings({ projectId, settings }: { projectId: string; settings: AiSettings }) {
  const { save, error, clearError } = useSave(projectId);
  const [compactFocus, setCompactFocus] = useState(false);
  // the row whose save failed shows the error under itself
  const [failedRow, setFailedRow] = useState<string | null>(null);
  const wrap = (row: string, body: (n: number | null) => Partial<AiSettings>) => async (n: number | null) => {
    clearError();
    setFailedRow(null);
    const ok = await save(body(n));
    if (!ok) setFailedRow(row);
    return ok;
  };
  const failure = (row: string) =>
    failedRow === row && error ? (
      <div className="ai-error-text" role="alert" data-testid="limits-error">
        Could not save the limits: {error} The field keeps what you typed.
      </div>
    ) : null;
  const compact = typeof settings.ops.autoCompactPct === 'number' ? settings.ops.autoCompactPct : 0;
  const memory = settings.runMemoryLimitMb;
  return (
    <section className="to-sec" data-setting="ai-limits" data-testid="ai-limits">
      <div className="to-group">
        <GroupHead title="Limits" hint="Caps for the whole project. Changes take effect on the next run." />
        {settings.reportsCost && (
          <>
            <TeamRow
              title="Daily cap"
              hint="Teams pause once the project has spent this much in a day; what is asked waits in line and nothing is lost. Empty is no cap."
              testId="limit-daily-cap"
            >
              <LimitInput
                value={settings.boardDailyCap}
                label="Daily cap ($)"
                placeholder="No cap"
                min={0}
                step="0.5"
                onSave={wrap('daily', (n) => ({ boardDailyCap: n }))}
              />
              <span className="ai-hint">dollars</span>
            </TeamRow>
            {failure('daily')}
            <TeamRow
              title="Monthly budget"
              hint="Teams pause once the month’s spend reaches this. Empty is no budget."
              testId="limit-monthly-budget"
            >
              <LimitInput
                value={settings.boardMonthlyBudget}
                label="Monthly budget ($)"
                placeholder="No budget"
                min={0}
                step="1"
                onSave={wrap('monthly', (n) => ({ boardMonthlyBudget: n }))}
              />
              <span className="ai-hint">dollars</span>
            </TeamRow>
            {failure('monthly')}
          </>
        )}
        <TeamRow title="Runs a day" hint="At most this many runs start in a day. Empty is no limit.">
          <LimitInput
            value={settings.boardRunsPerDay}
            label="Runs a day"
            placeholder="No limit"
            min={1}
            onSave={wrap('runs', (n) => ({ boardRunsPerDay: n }))}
          />
        </TeamRow>
        {failure('runs')}
        <TeamRow title="At once on this project" hint="Runs past this wait in line; nothing is lost.">
          <LimitInput
            value={settings.boardMaxParallel}
            label="Runs at once on this project"
            testId="settings-at-once"
            min={1}
            width={64}
            onSave={wrap('atonce', (n) => (n == null ? {} : { boardMaxParallel: n }))}
          />
          <span className="ai-hint">at a time</span>
        </TeamRow>
        {failure('atonce')}
        <TeamRow
          title="Memory of one run"
          hint="A run whose Claude Code goes over this many MB is restarted. 0 is no limit."
        >
          <LimitInput
            value={memory}
            label="Memory of one run (MB)"
            testId="settings-memory-limit"
            min={0}
            width={90}
            onSave={wrap('memory', (n) => (n == null ? {} : { runMemoryLimitMb: n }))}
          />
          <span className="ai-hint">{memory === 0 ? 'MB (no limit)' : 'MB'}</span>
        </TeamRow>
        {failure('memory')}
        <TeamRow
          title="Auto-compact at"
          hint={
            compactFocus
              ? 'A value from 30 to 95. Below 30 it is saved as 30; 0 is Claude Code’s own level.'
              : 'When a session’s context is this full, Claude Code summarizes the older part by itself and the AI carries on (it pauses a few seconds between two steps). 0 is Claude Code’s own level.'
          }
        >
          <LimitInput
            value={compact}
            label="Auto-compact at (%)"
            testId="settings-auto-compact"
            min={0}
            max={95}
            width={90}
            onFocusChange={setCompactFocus}
            onSave={wrap('compact', (n) => ({
              ops: { autoCompactPct: n && n > 0 ? Math.max(30, Math.min(95, n)) : null },
            }))}
          />
          <span className="ai-hint">{compact === 0 ? '% (Claude Code’s own level)' : '% of the context'}</span>
        </TeamRow>
        {failure('compact')}
      </div>
    </section>
  );
}

/** Section F4: where the runs happen: this computer (detected or not) or another one (the web build). */
export function RunnerCard() {
  const runner = useRunnerInfo();
  const info = runner.data;
  if (!info) return null;
  const monitor = (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  );
  const icon = (color: string, paths: ReactNode) => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
  return (
    <section className="to-sec" data-setting="ai-runner" data-testid="ai-runner">
      <div className="to-group">
        <GroupHead
          title="Where runs happen"
          hint="Runs happen on a computer where the desktop app is open. A team can still be asked when no runner is found: its tickets wait in the queue."
        />
        {!info.local ? (
          <div className="rn-card" data-testid="runner-other">
            <div className="rn-head">
              {icon('#5B6B60', <path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9.5 4 4 0 0 1 17 18z" />)}
              <b>Runs on another computer</b>
            </div>
            <div className="rn-line">
              <span>Computer</span>
              <b>{info.host}</b>
            </div>
            <div className="ai-hint">You are in the web build. Runs happen where the desktop app is open.</div>
          </div>
        ) : info.claudeFound ? (
          <div className="rn-card" data-testid="runner-detected">
            <div className="rn-head">
              {icon('#2E6F40', monitor)}
              <b>Runs on this computer</b>
              <span className="rn-pill rn-pill-ok">Detected</span>
            </div>
            <div className="rn-line">
              <span>Computer</span>
              <b>{info.host}</b>
            </div>
            <div className="rn-line">
              <span>System</span>
              <b>{info.platform}</b>
            </div>
            <div className="rn-line">
              <span>App</span>
              <b>version {info.appVersion}</b>
            </div>
          </div>
        ) : (
          <div className="rn-card" data-testid="runner-missing">
            <div className="rn-head">
              {icon('#B4571F', monitor)}
              <b>No runner on this computer</b>
              <span className="rn-pill rn-pill-warn">Offline</span>
            </div>
            <div className="ai-hint">
              Claude Code not found on this computer. A team here can still be asked: its tickets wait in the queue and
              start when a runner is found.
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
