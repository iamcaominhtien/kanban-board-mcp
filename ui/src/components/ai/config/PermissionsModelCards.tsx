import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Stepper } from '../AddAiMemberModal';
import { useAiMe } from '../../../api/aiSafety';
import { configApi } from './configApi';
import { adapterOf, useCfg } from './configCtx';
import { BYPASS_PHRASE, CfgCard, Chip, IssueText, NumField, TickRow, hasError } from './parts';
import { joinWords, splitWords } from './frontMatter';

const REJECTED = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  'bypassPermissions',
  '--permission-mode',
];
const TOOL_RE = /^[A-Za-z_][A-Za-z0-9_-]*(__[A-Za-z0-9_*-]+)*$/;

/** Why a CLI permission rule is malformed (mirrors the server check), or null. */
export function ruleProblem(rule: string): string | null {
  const r = rule.trim();
  if (!r) return 'is empty.';
  if (!r.includes('(') && !r.includes(')'))
    return TOOL_RE.test(r) ? null : 'tool names are letters, digits and underscores, e.g. Read or mcp__kanban__*.';
  if (!r.endsWith(')') || r.split('(').length !== 2 || r.split(')').length !== 2)
    return 'needs one pair of parentheses at the end, e.g. Bash(npm run build:*).';
  const [tool, spec] = r.slice(0, -1).split('(');
  if (!TOOL_RE.test(tool)) return `“${tool}” is not a tool name.`;
  if (!spec.trim()) return 'has empty parentheses; write the tool name alone to match every call.';
  if (spec.includes(':*') && !spec.endsWith(':*')) return '“:*” only works at the end of the specifier.';
  return null;
}

/** A list of rule chips with an input that checks syntax and duplicates as you type. */
function RuleList({
  label,
  path,
  rules,
  other,
  onChange,
  danger,
}: {
  label: string;
  path: string;
  rules: string[];
  other: string[];
  onChange: (r: string[]) => void;
  danger?: boolean;
}) {
  const { issues } = useCfg();
  const [draft, setDraft] = useState('');
  const problem = draft.trim() ? ruleProblem(draft) : null;
  const dup = draft.trim() && rules.includes(draft.trim());
  const clash = draft.trim() && other.includes(draft.trim());
  const add = () => {
    if (!draft.trim() || problem || dup) return;
    onChange([...rules, draft.trim()]);
    setDraft('');
  };
  return (
    <div className="ai-field" data-testid={`rules-${path}`}>
      <span className="ai-label ai-label-dark">{label}</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {rules.map((r) => {
          const bad = ruleProblem(r) || other.includes(r);
          return (
            <span
              key={r}
              className="ai-chip ai-mono"
              style={{
                background: bad ? '#FDF5E6' : danger ? '#FBEEEA' : '#F1F8F3',
                color: bad ? '#8A5A12' : danger ? '#C4432A' : '#2E6F40',
                fontWeight: 500,
              }}
            >
              {r}
              <button
                type="button"
                aria-label={`Remove ${r}`}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', padding: 0 }}
                onClick={() => onChange(rules.filter((x) => x !== r))}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
      <input
        data-path={path}
        aria-label={`Add ${label.toLowerCase()} rule`}
        className={`ai-input ai-mono ${problem || dup ? 'ai-input-error' : ''}`}
        placeholder="Add a rule, e.g. Bash(npm run build:*)"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && add()}
      />
      {problem && (
        <span className="ai-error-text">
          “{draft.trim()}” {problem}
        </span>
      )}
      {dup && <span className="ai-error-text">“{draft.trim()}” is already in this list.</span>}
      {clash && !dup && (
        <span className="ai-hint" style={{ color: '#8A5A12' }}>
          “{draft.trim()}” is also in the other list; deny wins.
        </span>
      )}
      <IssueText issues={issues.filter((i) => i.severity !== 'error' || i.path === path)} path={path} />
    </div>
  );
}

/** Permission mode: only the Allow rules run, or every tool except what a Deny rule stops (Codex: no sandbox). */
function PermissionModeBlock() {
  const { member, cfg, setCfg, draft, setDraft, issues } = useCfg();
  const codex = member.provider === 'codex';
  const me = useAiMe(member.projectId);
  const isOwner = me.data?.role === 'owner';
  const bypass = cfg.permissionMode === 'bypass';
  const saved = member.config.permissionMode === 'bypass';
  const projects = (member.projects ?? []).filter((p) => p.on).length;
  const locked = !isOwner && !bypass;
  // the typed phrase is only sent while Bypass is being turned on, so switching back needs no clean-up
  const pick = (mode: 'allowlist' | 'bypass') => setCfg({ permissionMode: mode });
  return (
    <div className="ai-field" data-testid="permission-mode" data-path="permission_mode">
      <span className="ai-label ai-label-dark">Permission mode</span>
      <div className="perm-opts" role="radiogroup" aria-label="Permission mode">
        <label className={`perm-opt ${bypass ? '' : 'is-on'}`}>
          <input
            type="radio"
            name={`perm-mode-${member.id}`}
            checked={!bypass}
            onChange={() => pick('allowlist')}
            data-testid="perm-mode-allowlist"
          />
          <span className="perm-opt-text">
            <span className="perm-opt-title">
              Allow list only <span className="perm-opt-tag">Recommended</span>
            </span>
            <span className="perm-opt-desc">
              {codex
                ? 'Codex runs in its own workspace-write sandbox: it can change files in the working folder only.'
                : 'The CLI runs only the tools in Allow; anything else is refused, because a run cannot ask a person.'}
            </span>
          </span>
        </label>
        <label className={`perm-opt perm-opt-danger ${bypass ? 'is-on' : ''} ${locked ? 'is-disabled' : ''}`}>
          <input
            type="radio"
            name={`perm-mode-${member.id}`}
            checked={bypass}
            disabled={locked}
            onChange={() => pick('bypass')}
            data-testid="perm-mode-bypass"
          />
          <span className="perm-opt-text">
            <span className="perm-opt-title">Bypass permissions</span>
            <span className="perm-opt-desc">
              {codex
                ? 'Codex runs without its sandbox, with full access to this computer. Only for work runs.'
                : 'The CLI runs any tool without the Allow list. Only for work runs.'}
              {locked ? ' Only the project owner can turn it on.' : ''}
            </span>
          </span>
        </label>
      </div>
      {bypass && (
        <div className="perm-warn" data-testid="bypass-warning">
          <b>Bypass permissions runs shell commands and edits files on this computer without asking.</b> Still in force:{' '}
          {codex ? 'the' : 'the Deny rules, the'} board’s own ceiling and approvals, and Safe mode (it overrides
          Bypass). {codex ? 'The Deny rules do not apply to Codex. ' : ''}Ask runs stay read-only and the web stays off.
          Use it in a folder you can restore from git.
          {projects > 1 ? ` This AI member is in ${projects} projects: the setting applies in all of them.` : ''}
        </div>
      )}
      {bypass && !saved && (
        <label className="ai-field" style={{ marginTop: 4 }}>
          <span className="ai-label ai-label-dark">Type “{BYPASS_PHRASE}” to confirm</span>
          <input
            className={`ai-input ${hasError(issues, 'permission_mode') ? 'ai-input-error' : ''}`}
            value={draft.confirmBypass}
            onChange={(e) => setDraft({ confirmBypass: e.target.value })}
            placeholder={BYPASS_PHRASE}
            data-testid="bypass-confirm"
          />
        </label>
      )}
      <IssueText issues={issues} path="permission_mode" />
    </div>
  );
}

/** Permissions: allow / deny tool rules written to settings.json (Claude Code, B6), or documented notes (Antigravity, C3). */
export function PermissionsCard() {
  const { member, cfg, setCfg, status, tick } = useCfg();
  const kind = adapterOf(member);
  if (kind === 'antigravity') {
    const item = status?.documented.find((d) => d.key === 'permissions');
    return (
      <CfgCard
        id="cfg-permissions"
        testId="card-permissions"
        title="Permissions"
        mode="documented"
        sub="The Allow and Deny rules are passed to Antigravity for each run. Notes below are only for you; Kanban cannot read the app’s own settings."
      >
        {member.connection === 'local' && <PermissionModeBlock />}
        <RuleList
          label="Allow"
          path="allow_rules"
          rules={cfg.allowRules}
          other={cfg.denyRules}
          onChange={(r) => setCfg({ allowRules: r })}
        />
        <RuleList
          label="Deny"
          path="deny_rules"
          rules={cfg.denyRules}
          other={cfg.allowRules}
          onChange={(r) => setCfg({ denyRules: r })}
          danger
        />
        <textarea
          aria-label="Permission notes"
          className="ai-textarea"
          placeholder="e.g. Allow terminal commands: git status, npm run test. Ask before anything else."
          value={cfg.permissionNotes}
          onChange={(e) => setCfg({ permissionNotes: e.target.value })}
        />
        <TickRow item={item} onTick={(d) => void tick('permissions', d)} />
        <div className="ai-hint">
          Separate from the board’s own ceiling in the Permissions tab: the board checks its rules even if the app
          allows more.
        </div>
      </CfgCard>
    );
  }
  if (kind === 'cli') {
    const codex = member.provider === 'codex';
    return (
      <CfgCard
        id="cfg-permissions"
        testId="card-permissions"
        title="Permissions"
        mode="synced"
        sub={
          codex
            ? 'Codex runs in its own sandbox; the Allow and Deny rules do not apply to it.'
            : 'Passed to opencode as its permission map for each run: everything not allowed is refused.'
        }
      >
        <PermissionModeBlock />
        {!codex && (
          <>
            <RuleList
              label="Allow"
              path="allow_rules"
              rules={cfg.allowRules}
              other={cfg.denyRules}
              onChange={(r) => setCfg({ allowRules: r })}
            />
            <RuleList
              label="Deny"
              path="deny_rules"
              rules={cfg.denyRules}
              other={cfg.allowRules}
              onChange={(r) => setCfg({ denyRules: r })}
              danger
            />
          </>
        )}
      </CfgCard>
    );
  }
  return (
    <CfgCard
      id="cfg-permissions"
      testId="card-permissions"
      title="Permissions"
      mode="synced"
      sub={
        <>
          Written to <span className="ai-code">.claude/settings.json</span> and passed as --allowedTools /
          --disallowedTools. Pattern syntax: TODO verify.
        </>
      }
    >
      {member.connection === 'local' && kind === 'claude-code' && <PermissionModeBlock />}
      <RuleList
        label="Allow"
        path="allow_rules"
        rules={cfg.allowRules}
        other={cfg.denyRules}
        onChange={(r) => setCfg({ allowRules: r })}
      />
      <RuleList
        label="Deny"
        path="deny_rules"
        rules={cfg.denyRules}
        other={cfg.allowRules}
        onChange={(r) => setCfg({ denyRules: r })}
        danger
      />
      <div className="ai-hint">
        Separate from the board’s own ceiling (“Up to {member.ceiling === 'review' ? 'Review' : member.ceiling}”) in the
        Permissions tab: the board checks its rules even if a hook or flag tries to skip them. Rules in settings.json
        also apply when you open Claude Code in this folder yourself.
      </div>
    </CfgCard>
  );
}

/** Model, effort, working folder, limits and extra CLI flags (design B7); Antigravity: model is Documented (C3). */
export function ModelCard() {
  const { member, cfg, setCfg, draft, setDraft, issues, status, tick } = useCfg();
  const kind = adapterOf(member);
  const models = useQuery({
    queryKey: ['ai', 'models', member.id],
    queryFn: () => configApi.models(member.id),
    staleTime: 60_000,
  });
  const [flagText, setFlagText] = useState(joinWords(cfg.extraFlags));
  const [flagError, setFlagError] = useState<string | null>(null);
  const options = models.data?.models ?? [];
  const known = options.some((m) => m.id === draft.model);
  const onFlags = (v: string) => {
    setFlagText(v);
    const words = splitWords(v);
    const bad = words.find((w) => REJECTED.some((r) => w.includes(r)));
    setFlagError(bad ? `Flags that skip permission checks are rejected: ${bad}` : null);
    setCfg({ extraFlags: words });
  };
  if (kind === 'antigravity') {
    const item = status?.documented.find((d) => d.key === 'model');
    return (
      <CfgCard
        id="cfg-model"
        testId="card-model"
        title="Model & limits"
        mode="documented"
        sub="The model is picked inside the Antigravity app; the board only limits how long a run may take."
      >
        <TickRow item={item} onTick={(d) => void tick('model', d)} />
        <div className="cfg-two">
          <div className="ai-field">
            <span className="ai-label ai-label-dark">Working folder</span>
            <input
              data-path="working_dir"
              className="ai-input ai-mono"
              value={draft.workingDir}
              onChange={(e) => setDraft({ workingDir: e.target.value })}
            />
          </div>
          <NumField
            label="Run timeout"
            unit="min"
            value={cfg.runTimeoutMin}
            onChange={(v) => setCfg({ runTimeoutMin: v })}
            path="run_timeout_min"
            issues={issues}
            hint="Run timeout only: the other limits are Antigravity’s own."
          />
        </div>
      </CfgCard>
    );
  }
  return (
    <CfgCard
      id="cfg-model-card"
      testId="card-model"
      title="Model & flags"
      mode="synced"
      sub="Passed on the command line; nothing is written to files."
    >
      <div className="cfg-two">
        <div className="ai-field">
          <span className="ai-label ai-label-dark">Model</span>
          <select
            id="cfg-model"
            data-path="model"
            className="ai-select"
            value={draft.model}
            onChange={(e) => setDraft({ model: e.target.value })}
          >
            {!known && <option value={draft.model}>{draft.model || 'Choose a model'}</option>}
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="ai-field">
          <span className="ai-label ai-label-dark">Effort</span>
          <select
            aria-label="Effort"
            data-path="effort"
            className="ai-select"
            value={cfg.effort ?? ''}
            onChange={(e) => setCfg({ effort: e.target.value || null })}
          >
            <option value="">Default</option>
            {['low', 'medium', 'high', 'xhigh', 'max'].map((e) => (
              <option key={e} value={e}>
                {e[0].toUpperCase() + e.slice(1)}
              </option>
            ))}
          </select>
          <IssueText issues={issues} path="effort" />
        </div>
        <div className="ai-field" style={{ gridColumn: '1 / -1' }}>
          <span className="ai-label ai-label-dark">Working folder (Synced files are written here)</span>
          <input
            data-path="working_dir"
            className={`ai-input ai-mono ${hasError(issues, 'working_dir') ? 'ai-input-error' : ''}`}
            value={draft.workingDir}
            onChange={(e) => setDraft({ workingDir: e.target.value })}
          />
          <IssueText issues={issues} path="working_dir" />
        </div>
        <NumField
          label="Max turns per run"
          value={cfg.maxTurns}
          onChange={(v) => setCfg({ maxTurns: v })}
          path="max_turns"
          issues={issues}
        />
        <NumField
          label="Run timeout"
          unit="min"
          value={cfg.runTimeoutMin}
          onChange={(v) => setCfg({ runTimeoutMin: v })}
          path="run_timeout_min"
          issues={issues}
        />
        <NumField
          label="No output timeout"
          unit="min"
          value={cfg.idleTimeoutMin}
          onChange={(v) => setCfg({ idleTimeoutMin: v })}
          path="idle_timeout_min"
          issues={issues}
        />
        <NumField
          label="Auto-compact at"
          unit="% of context"
          value={cfg.compactAtPct}
          onChange={(v) => setCfg({ compactAtPct: v })}
          path="compact_at_pct"
          issues={issues}
          hint="A ticket keeps one conversation with this member. When it fills this share of the model's context, Claude Code summarizes the older part."
        />
        <NumField
          id="cfg-budget"
          label="Scheduled runs per day"
          value={draft.maxRunsPerDay}
          onChange={(v) => setDraft({ maxRunsPerDay: v })}
          path="max_runs_per_day"
          issues={issues}
        />
        <div className="ai-field">
          <span className="ai-label ai-label-dark">Parallel runs</span>
          <Stepper value={draft.maxParallel} min={1} max={10} onChange={(v) => setDraft({ maxParallel: v })} />
        </div>
        <div className="ai-field" style={{ gridColumn: '1 / -1' }}>
          <span className="ai-label ai-label-dark">
            Extra CLI flags (flags that skip permission checks are rejected)
          </span>
          <input
            data-path="extra_flags"
            aria-label="Extra CLI flags"
            className={`ai-input ai-mono ${flagError ? 'ai-input-error' : ''}`}
            placeholder="--verbose --add-dir ../shared"
            value={flagText}
            onChange={(e) => onFlags(e.target.value)}
          />
          {flagError && (
            <span className="ai-error-text" data-testid="flag-error">
              {flagError}
            </span>
          )}
          <IssueText issues={issues} path="extra_flags" />
        </div>
      </div>
      <div className="ai-muted">A run stops at the first limit it reaches and says which one.</div>
      {status?.runner && !status.runner.online && <Chip tone="warn">Working folder not reachable</Chip>}
    </CfgCard>
  );
}
