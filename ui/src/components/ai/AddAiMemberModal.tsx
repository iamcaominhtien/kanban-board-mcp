import { useEffect, useState } from 'react';
import { aiApi, useAiMutation, useRunnerInfo } from '../../api/ai';
import { useAiMe } from '../../api/aiSafety';
import { useTickets } from '../../api/tickets';
import { extractError } from '../../api/extractError';
import type { AiMember, AiProvider, DetectResult } from '../../types/ai';
import { AiAvatar, AvatarPicker, DEFAULT_LOOK, PROVIDERS, STATUS_NAMES } from './aiUi';
import presetData from './memberPresets.json';
import { AiFillPanel, type AiFilled } from './AiFillPanel';

interface MemberPreset {
  id: string;
  name: string;
  model: string;
  template: string;
  ceiling: string;
  maxParallel: number;
  maxRunsPerDay: number;
  approvals: Record<string, boolean>;
  cliAllow?: string[];
  tagline: Record<'en' | 'vi', string>;
  description: Record<'en' | 'vi', string>;
  persona: Record<'en' | 'vi', string>;
}
/** What a member that never edits files may run (the same list as the PM and Reviewer presets). */
const READ_ONLY_ALLOW = ['Read', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)'];
/** Ready-made AI members from the guideline (PM, Dev, Reviewer). The same file feeds the guideline PDF. */
const PRESETS = presetData as MemberPreset[];

interface Props {
  projectId: string;
  projectName: string;
  /** Start on step 2 with this adapter (empty state "Set up" cards). */
  initialProvider?: AiProvider;
  onClose: () => void;
  onOpenProfile: (id: string) => void;
  /** The web build cannot start local runners; defaults to what the server says about this browser. */
  webBuild?: boolean;
}

/** The first characters of a key that name its kind (sk-ant-, sk-proj-, AIza…), for “sk-ant-••••3f9a”. */
function keyPrefix(key: string): string {
  return key.trim().match(/^(sk-ant-|sk-proj-|sk-or-|sk-|AIza|gsk_|xai-)/)?.[0] ?? '';
}

/** Open a link in the system browser (the desktop app) or a new tab. */
function openLink(url: string) {
  const open = (window as unknown as { electronAPI?: { openExternal?: (u: string) => void } }).electronAPI
    ?.openExternal;
  if (open) open(url);
  else window.open(url, '_blank', 'noopener');
}

const CEILINGS = ['none', 'backlog', 'todo', 'in-progress', 'review', 'testing', 'done'] as const;
/** Past Review needs the extra confirmation (and an owner). */
const beyondReview = (c: string) => c === 'testing' || c === 'done';
const APPROVAL_TOGGLES: { action: string; label: string; on: string; off: string; locked?: boolean }[] = [
  {
    action: 'delete_tickets',
    label: 'Delete a ticket',
    on: 'Needs approval every time. An owner enabled it; it is never allowed without a person',
    off: 'Blocked by default; an owner may allow it with approval only',
  },
  {
    action: 'change_assignee',
    label: 'Change an assignee',
    on: 'Posts an approval request in the ticket',
    off: 'Skipped — it changes assignees freely',
  },
  {
    action: 'create_tickets',
    label: 'Create tickets',
    on: 'New tickets wait for approval',
    off: 'Skipped — it creates tickets freely',
  },
  { action: 'edit_docs', label: 'Edit docs', on: 'Doc edits wait for approval', off: 'Skipped — it edits docs freely' },
];

/**
 * Add AI member stepper: type, connect, identity & limits, permissions & review, then the result.
 * Local runners never ask for a key; API-key members never ask for a folder.
 */
export function AddAiMemberModal({
  projectId,
  projectName,
  initialProvider,
  onClose,
  onOpenProfile,
  webBuild: webBuildProp,
}: Props) {
  const runner = useRunnerInfo();
  const me = useAiMe(projectId);
  // The web build (a browser on another computer) cannot start a CLI: local options are greyed out
  const webBuild = webBuildProp ?? runner.data?.local === false;
  const startProvider: AiProvider =
    initialProvider && !(webBuild && PROVIDERS[initialProvider].connection === 'local')
      ? initialProvider
      : webBuild
        ? 'anthropic'
        : 'claude-code';
  const [step, setStep] = useState(initialProvider && startProvider === initialProvider ? 2 : 1);
  const [provider, setProvider] = useState<AiProvider>(startProvider);
  const spec = PROVIDERS[provider];
  const local = spec.connection === 'local';
  const apiKey = spec.connection === 'api_key';
  // step 2
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [workingDir, setWorkingDir] = useState('');
  const [testRun, setTestRun] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState(spec.defaultModel ?? '');
  const [keyTest, setKeyTest] = useState<{ ok: boolean; text: string; models?: string[] } | null>(null);
  // step 3
  const [name, setName] = useState(`${spec.label.replace(' endpoint', '')} · `);
  const [nameCheck, setNameCheck] = useState<{ message: string | null; suggestion: string | null } | null>(null);
  const [description, setDescription] = useState('');
  const [persona, setPersona] = useState('');
  const [presetId, setPresetId] = useState<string | null>(null);
  // What "Ask AI to fill this in" chose, when no preset is on: a role template and the CLI allow list
  const [aiTemplate, setAiTemplate] = useState<'reviewer' | 'read_only' | null>(null);
  const [aiCliAllow, setAiCliAllow] = useState<string[] | null>(null);
  const [presetLang, setPresetLang] = useState<'en' | 'vi'>(() =>
    typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('vi') ? 'vi' : 'en',
  );
  const [maxParallel, setMaxParallel] = useState(2);
  const [dailyBudget, setDailyBudget] = useState('5.00');
  const [monthlyCap, setMonthlyCap] = useState('120.00');
  const [runsPerDay, setRunsPerDay] = useState(20);
  const [look, setLook] = useState<{ color: string; glyph: string }>(() => ({ ...DEFAULT_LOOK[startProvider] }));
  // Errors show once a field was left or Next was tried, so a fresh form is not covered in red
  const [attempted, setAttempted] = useState(false);
  const [folderTouched, setFolderTouched] = useState(false);
  // step 4
  const [ceiling, setCeiling] = useState('review');
  const [confirmDone, setConfirmDone] = useState(false);
  const [approvals, setApprovals] = useState<Record<string, boolean>>({
    delete_tickets: false,
    change_assignee: true,
    create_tickets: false,
    edit_docs: true,
  });
  const [created, setCreated] = useState<AiMember | null>(null);
  // The key's prefix is only known here (the server keeps the last 4); it is shown once in the Done step
  const [savedKeyPrefix, setSavedKeyPrefix] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const create = useAiMutation((body: Record<string, unknown>) => aiApi.create(projectId, body));
  const preset = PRESETS.find((p) => p.id === presetId) ?? null;
  // A preset on another role template (Reviewer) lets the template decide; the approval switches do not apply
  const fixedTemplate = preset && preset.template !== 'developer' ? preset.template : aiTemplate;
  const roleName = preset?.name ?? (aiTemplate === 'reviewer' ? 'Reviewer' : 'Read-only');

  /** Fill the form from a preset (or clear it for "Blank"); every field stays editable afterwards. */
  function applyPreset(id: string | null) {
    const p = PRESETS.find((x) => x.id === id) ?? null;
    setPresetId(p ? p.id : null);
    setAiTemplate(null);
    setAiCliAllow(null);
    setDescription(p ? p.description[presetLang] : '');
    setPersona(p ? p.persona[presetLang] : '');
    if (!p) return;
    setName(p.name);
    setMaxParallel(p.maxParallel);
    if (local) setRunsPerDay(p.maxRunsPerDay);
    setCeiling(p.ceiling);
    setConfirmDone(false);
    setApprovals({ ...p.approvals });
  }

  /** Fill the form from the member the AI proposed; the person still reviews it and presses Create. */
  function fillFromAi(m: AiFilled) {
    setPresetId(null);
    setName(m.name);
    setDescription(m.description);
    setPersona(m.persona);
    setMaxParallel(m.maxParallel);
    if (local) setRunsPerDay(m.maxRunsPerDay);
    setCeiling(m.ceiling);
    setConfirmDone(false);
    setAiTemplate(m.template === 'developer' ? null : m.template);
    setAiCliAllow(provider === 'claude-code' && m.readOnlyCli ? READ_ONLY_ALLOW : null);
    const wanted = m.model.toLowerCase();
    if (spec.models.includes(wanted)) setModel(wanted);
  }

  /** Switch the language of the preset text, unless it was edited by hand. */
  function changePresetLang(lang: 'en' | 'vi') {
    if (preset) {
      if (persona === preset.persona[presetLang]) setPersona(preset.persona[lang]);
      if (description === preset.description[presetLang]) setDescription(preset.description[lang]);
    }
    setPresetLang(lang);
  }

  useEffect(() => {
    setModel(spec.defaultModel ?? '');
    setBaseUrl(spec.baseUrl ?? '');
    setDetect(null);
    setTestRun(null);
    setKeyTest(null);
    setName(provider === 'mcp-client' ? '' : `${spec.label.replace(' endpoint', '')} · `);
    setLook({ ...DEFAULT_LOOK[provider] });
  }, [provider, spec.defaultModel, spec.baseUrl, spec.label]);

  async function runDetect() {
    setDetecting(true);
    try {
      setDetect(await aiApi.detect(provider));
    } catch (err) {
      setDetect({ found: false, path: null, checked: [], version: null, loggedIn: null, account: extractError(err) });
    } finally {
      setDetecting(false);
    }
  }

  useEffect(() => {
    if (step === 2 && local && !detect && !detecting) void runDetect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, local]);

  // F1: duplicate names are checked live while typing (and again on save)
  useEffect(() => {
    if (step !== 3 || !name.trim()) return;
    const t = setTimeout(async () => {
      try {
        const r = await aiApi.checkName(projectId, name);
        setNameCheck(r.ok ? null : { message: r.message, suggestion: r.suggestion });
      } catch {
        /* checked again on save */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [name, step, projectId]);

  async function runTest() {
    setTesting(true);
    setTestRun(null);
    try {
      const r = await aiApi.testRun({ provider, model, workingDir: workingDir || undefined });
      setTestRun(
        r.ok
          ? { ok: true, text: `Test run passed in ${r.seconds} s — CLI replied “${r.reply}”` }
          : { ok: false, text: r.error ?? 'Test run failed' },
      );
    } catch (err) {
      setTestRun({ ok: false, text: extractError(err) });
    } finally {
      setTesting(false);
    }
  }

  async function runKeyTest() {
    setTesting(true);
    setKeyTest(null);
    try {
      const r = await aiApi.testKey({ provider, apiKey: key, baseUrl: baseUrl || undefined });
      setKeyTest(
        r.ok
          ? { ok: true, text: r.note ?? `Key is valid — ${r.models?.length ?? 0} models available`, models: r.models }
          : { ok: false, text: r.error ?? 'Test failed' },
      );
    } catch (err) {
      setKeyTest({ ok: false, text: extractError(err) });
    } finally {
      setTesting(false);
    }
  }

  const daily = parseFloat(dailyBudget);
  const monthly = monthlyCap.trim() === '' ? null : parseFloat(monthlyCap);
  const amountOk = (v: string) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
  const dailyError = apiKey && !amountOk(dailyBudget) ? 'Enter an amount of 0 or more' : null;
  const monthlyError =
    apiKey && monthlyCap.trim() !== '' && !amountOk(monthlyCap)
      ? 'Enter an amount of 0 or more'
      : apiKey && monthly != null && !dailyError && monthly < daily
        ? 'At least the daily budget'
        : null;
  const nameError = !name.trim() ? 'Give it a name' : name.trim().length > 80 ? 'At most 80 characters' : null;
  const urlError =
    provider === 'custom' &&
    baseUrl.trim() &&
    !/^(https:\/\/|http:\/\/localhost|http:\/\/127\.0\.0\.1)/.test(baseUrl.trim())
      ? 'HTTPS is required except for localhost.'
      : null;
  const folderError =
    local && provider === 'claude-code' && !workingDir.trim() ? 'Choose the folder runs start in' : null;
  const capError = monthlyError;
  const step2Ok =
    provider === 'mcp-client' ||
    (local &&
      !webBuild &&
      detect?.found &&
      detect.loggedIn !== false &&
      (!!workingDir.trim() || provider !== 'claude-code')) ||
    (apiKey &&
      key.trim().length > 0 &&
      (provider !== 'custom' || (baseUrl.trim() && !urlError)) &&
      keyTest?.ok !== false);
  const step3Ok = !nameError && !nameCheck && !dailyError && !monthlyError && persona.length <= 1000;

  async function save() {
    setSaveError(null);
    const overrides: Record<string, string> = {};
    if (approvals.change_assignee === false) overrides.change_assignee = 'allowed';
    if (approvals.create_tickets) overrides.create_tickets = 'approval';
    if (approvals.edit_docs === false) overrides.edit_docs = 'allowed';
    // Delete is Blocked unless an owner turns it on, and then it needs approval (never Allowed)
    if (approvals.delete_tickets) overrides.delete_tickets = 'approval';
    const template = fixedTemplate ?? (Object.values(overrides).includes('allowed') ? 'custom' : 'developer');
    if (fixedTemplate) {
      for (const k of Object.keys(overrides)) delete overrides[k];
    } else if (template === 'custom') {
      // Custom starts wide: put back the approvals that stay on
      if (approvals.change_assignee) overrides.change_assignee = 'approval';
      if (approvals.edit_docs) overrides.edit_docs = 'approval';
      if (!approvals.create_tickets) delete overrides.create_tickets;
      if (!approvals.delete_tickets) overrides.delete_tickets = 'blocked';
    }
    try {
      const m = await create.mutateAsync({
        name: name.trim(),
        provider,
        description,
        persona,
        color: look.color,
        glyph: look.glyph,
        workingDir: local ? workingDir : undefined,
        model: model || undefined,
        apiKey: apiKey ? key : undefined,
        baseUrl: apiKey ? baseUrl || undefined : undefined,
        maxParallel,
        dailyBudget: apiKey ? daily : undefined,
        monthlyCap: apiKey && monthly != null ? monthly : undefined,
        maxRunsPerDay: local ? runsPerDay : undefined,
        ceiling,
        confirmDone: beyondReview(ceiling) ? confirmDone : undefined,
        template,
        permissions: overrides,
        config:
          (aiCliAllow ?? preset?.cliAllow) && provider === 'claude-code'
            ? { allowRules: aiCliAllow ?? preset?.cliAllow }
            : undefined,
      });
      setSavedKeyPrefix(apiKey ? keyPrefix(key) : '');
      setKey('');
      setCreated(m);
      setStep(5);
    } catch (err) {
      setSaveError(extractError(err));
    }
  }

  const titles = ['Type', 'Connect', 'Identity & limits', 'Permissions'];
  const approvalsOn = Object.values(approvals).filter(Boolean).length;

  return (
    <div className="ai-overlay" onClick={onClose}>
      <div className="ai-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add AI member">
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">
            {step === 2 && local
              ? `Connect ${spec.label}`
              : step === 2 && apiKey
                ? `Connect ${spec.label}`
                : step === 5
                  ? 'AI member added'
                  : 'Add AI member'}
          </h2>
          <div className="ai-hint" style={{ marginTop: 3 }}>
            {step === 1 && 'Choose how this AI member connects to the board.'}
            {step === 3 && 'Identity and limits.'}
            {step === 4 && 'Permissions and review. Details live in “AI safety & cost”.'}
          </div>
          {step <= 4 && (
            <div className="ai-stepper">
              {titles.map((t, i) => (
                <span key={t} style={{ display: 'contents' }}>
                  <span
                    className={`ai-step ${step === i + 1 ? 'ai-step-active' : ''} ${step > i + 1 ? 'ai-step-done' : ''}`}
                  >
                    <span className="ai-step-n">{step > i + 1 ? '✓' : i + 1}</span>
                    {step === i + 1 && t}
                  </span>
                  {i < titles.length - 1 && <span className="ai-step-line" />}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="ai-modal-body">
          {step === 1 && (
            <>
              <div className="ai-notice ai-notice-info">
                <ShieldIcon />
                <div>
                  <b>Your login stays in the CLI</b>
                  <div>
                    A local runner only starts the official CLI that you already signed in to. Kanban never stores,
                    copies or reuses its token.
                  </div>
                </div>
              </div>
              {webBuild && (
                <div className="ai-notice ai-notice-warn" data-testid="web-build-notice">
                  <div>
                    <b>Local runners only work in the desktop app</b>
                    <div>
                      This is the web build; it cannot start the Claude Code or Antigravity CLI. Their tickets queue and
                      start when the desktop app is online. API-key AI members still work here.
                    </div>
                  </div>
                </div>
              )}
              <Group title="Runs on your computer" tag="local runner">
                {(['claude-code', 'antigravity'] as AiProvider[]).map((p) => (
                  <TypeOption
                    key={p}
                    p={p}
                    active={provider === p}
                    onPick={setProvider}
                    disabled={webBuild}
                    sub={webBuild ? 'Needs the desktop app' : undefined}
                  />
                ))}
              </Group>
              <Group title="Runs on the board" tag="API key">
                {(['anthropic', 'openai', 'gemini', 'custom'] as AiProvider[]).map((p) => (
                  <TypeOption key={p} p={p} active={provider === p} onPick={setProvider} />
                ))}
              </Group>
              <Group title="Other" tag="inbox only">
                <TypeOption
                  p="mcp-client"
                  active={provider === 'mcp-client'}
                  onPick={setProvider}
                  sub="Cursor, Cline… connect through MCP like today. They get an inbox of assigned tickets and mentions, but the board cannot start them."
                  wide
                />
              </Group>
            </>
          )}

          {step === 2 && local && (
            <>
              {detecting && (
                <div className="ai-hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="ai-spin" /> Looking for the {spec.binary} CLI…
                </div>
              )}
              {detect && detect.found && (
                <>
                  <dl className="ai-kv">
                    <dt>CLI found</dt>
                    <dd className="ai-mono" style={{ fontSize: 12 }}>
                      {detect.path}
                    </dd>
                    <dt>Version</dt>
                    <dd data-testid="cli-version">
                      {detect.version ?? '—'}
                      {detect.upToDate === true && ' (latest)'}
                      {detect.upToDate === false && detect.latestVersion && (
                        <span style={{ color: '#B4571F' }}> · {detect.latestVersion} is available</span>
                      )}
                    </dd>
                    <dt>Signed in as</dt>
                    <dd style={{ color: detect.loggedIn === false ? '#C4432A' : undefined }}>
                      {detect.loggedIn === false
                        ? 'Not signed in — run it once in a terminal'
                        : (detect.account ?? (detect.loggedIn ? 'Signed in' : 'Not reported by the CLI'))}
                    </dd>
                    {runner.data && (
                      <>
                        <dt>Runs on</dt>
                        <dd data-testid="runner-host">{runner.data.host} · this computer</dd>
                      </>
                    )}
                  </dl>
                  <div className="ai-notice ai-notice-info">
                    <ShieldIcon />
                    <div>
                      <b>Account name only</b>
                      <div>
                        Kanban reads the account name the CLI reports. The login token stays in the CLI’s own keychain
                        and is never read, shown or stored.
                      </div>
                    </div>
                  </div>
                  <div className="ai-field">
                    <span className="ai-label ai-label-dark">Working folder</span>
                    <input
                      className={`ai-input ai-mono ${folderError && (folderTouched || attempted) ? 'ai-input-error' : ''}`}
                      value={workingDir}
                      onChange={(e) => setWorkingDir(e.target.value)}
                      onBlur={() => setFolderTouched(true)}
                      placeholder="~/dev/kanban-board"
                      data-testid="ai-working-dir"
                    />
                    {folderError && (folderTouched || attempted) ? (
                      <span className="ai-error-text">{folderError}</span>
                    ) : (
                      <span className="ai-hint">
                        Every run starts here with <span className="ai-code">claude -p</span> (headless). The runner can
                        only touch this folder and below.
                      </span>
                    )}
                  </div>
                  {provider === 'claude-code' && (
                    <div className="ai-field">
                      <span className="ai-label ai-label-dark">Model</span>
                      <select className="ai-select" value={model} onChange={(e) => setModel(e.target.value)}>
                        {spec.models.map((m) => (
                          <option key={m} value={m}>
                            {m === 'sonnet' ? 'Sonnet (alias)' : m === 'haiku' ? 'Haiku (alias)' : m}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {provider === 'claude-code' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <button type="button" className="ai-btn" onClick={runTest} disabled={testing}>
                        {testing ? <span className="ai-spin" /> : <PlayIcon />} Run test
                      </button>
                      {testRun && (
                        <span className={testRun.ok ? 'ai-ok-text' : 'ai-error-text'} data-testid="ai-test-result">
                          {testRun.text}
                        </span>
                      )}
                    </div>
                  )}
                  {provider === 'antigravity' && (
                    <div className="ai-notice ai-notice-warn">
                      Antigravity has no headless mode the board can start yet: it gets its assigned tickets and
                      mentions through MCP, and runs are marked as not supported.
                    </div>
                  )}
                </>
              )}
              {detect && !detect.found && (
                <>
                  <div className="ai-notice ai-notice-error">
                    <div>
                      <b>“{spec.binary}” was not found on this computer</b>
                      <div>
                        Checked PATH and the usual install folders. The desktop runner needs the official CLI installed
                        and signed in.
                      </div>
                    </div>
                  </div>
                  <div className="ai-label ai-label-dark">Install and sign in</div>
                  {detect.installSteps && detect.installSteps.length > 0 ? (
                    <ol className="ai-hint" style={{ margin: 0, paddingLeft: 18 }} data-testid="install-steps">
                      {detect.installSteps.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ol>
                  ) : (
                    <div className="ai-term">
                      $ {detect.install ?? spec.install ?? 'install the CLI'}
                      {'\n'}$ {spec.binary} # sign in once, then come back
                    </div>
                  )}
                  <div className="ai-hint">Installed somewhere unusual? Add its folder to PATH, then detect again.</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="ai-btn" onClick={runDetect} disabled={detecting}>
                      Detect again
                    </button>
                    {detect.guideUrl && (
                      <button
                        type="button"
                        className="ai-btn"
                        onClick={() => openLink(detect.guideUrl!)}
                        data-testid="install-guide"
                      >
                        Installation guide ↗
                      </button>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {step === 2 && apiKey && (
            <>
              <div className="ai-field">
                <span className="ai-label ai-label-dark">Provider</span>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {provider === 'custom' ? 'Custom (OpenAI-compatible)' : spec.label}
                </div>
              </div>
              {provider === 'custom' && (
                <div className="ai-field">
                  <span className="ai-label ai-label-dark">Base URL</span>
                  <input
                    className={`ai-input ai-mono ${urlError ? 'ai-input-error' : ''}`}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://llm.internal.example.dev/v1"
                  />
                  {urlError ? (
                    <span className="ai-error-text">{urlError}</span>
                  ) : (
                    <span className="ai-hint">Must expose /chat/completions. HTTPS required except for localhost.</span>
                  )}
                </div>
              )}
              <div className="ai-field">
                <span className="ai-label ai-label-dark">API key</span>
                <input
                  className={`ai-input ai-mono ${keyTest && !keyTest.ok ? 'ai-input-error' : ''}`}
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setKeyTest(null);
                  }}
                  placeholder="sk-…"
                />
                {keyTest && !keyTest.ok ? (
                  <span className="ai-error-text">{keyTest.text}</span>
                ) : (
                  <span className="ai-hint">
                    Stored encrypted on this computer. Never shown again after saving, never in tickets, comments or
                    logs.
                  </span>
                )}
              </div>
              <div className="ai-field">
                <span className="ai-label ai-label-dark">Model</span>
                <input
                  className="ai-input ai-mono"
                  list="ai-models"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
                <datalist id="ai-models">
                  {[...new Set([...(keyTest?.models ?? []), ...spec.models])].map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <span className="ai-hint">Used for every run of this AI member. You can change it later.</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button type="button" className="ai-btn" onClick={runKeyTest} disabled={testing || !key.trim()}>
                  {testing ? <span className="ai-spin" /> : <KeyIcon />} Test key
                </button>
                {keyTest && (
                  <span className={keyTest.ok ? 'ai-ok-text' : 'ai-error-text'}>
                    {keyTest.ok ? keyTest.text : `Test failed — ${keyTest.text.split(' — ')[0]}`}
                  </span>
                )}
              </div>
            </>
          )}

          {step === 2 && provider === 'mcp-client' && (
            <div className="ai-notice ai-notice-info">
              It connects through MCP like today (Settings → MCP integrations). The board lists it as an AI member, so
              it can be assigned and @mentioned; it reads its inbox of assigned tickets itself. The board cannot start
              it.
            </div>
          )}

          {step === 3 && (
            <>
              {provider !== 'mcp-client' && (
                <AiFillPanel
                  projectId={projectId}
                  form={{
                    name,
                    description,
                    persona,
                    template: fixedTemplate ?? 'developer',
                    ceiling,
                    maxParallel,
                    maxRunsPerDay: runsPerDay,
                    model,
                  }}
                  onFill={fillFromAi}
                />
              )}
              {provider !== 'mcp-client' && (
                <div className="ai-field" data-testid="ai-presets">
                  <span className="ai-label ai-label-dark">Start from</span>
                  <div className="ai-preset-row">
                    {PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`ai-preset ${presetId === p.id ? 'is-on' : ''}`}
                        onClick={() => applyPreset(p.id)}
                        data-testid={`ai-preset-${p.id}`}
                      >
                        <b>{p.name}</b>
                        <span>{p.tagline[presetLang]}</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      className={`ai-preset ${presetId === null ? 'is-on' : ''}`}
                      onClick={() => applyPreset(null)}
                      data-testid="ai-preset-blank"
                    >
                      <b>Blank</b>
                      <span>Set it up yourself.</span>
                    </button>
                  </div>
                  <div className="ai-preset-meta">
                    <span className="ai-hint">
                      {preset
                        ? `Filled in the name, description, persona, limits and permissions. Everything stays editable. Suggested model: ${preset.model}.`
                        : 'Pick a ready-made role to fill in the form, or keep it blank.'}
                    </span>
                    <span className="ai-seg ai-seg-small" role="group" aria-label="Preset language">
                      {(['en', 'vi'] as const).map((l) => (
                        <button
                          key={l}
                          type="button"
                          className={presetLang === l ? 'ai-seg-on' : ''}
                          onClick={() => changePresetLang(l)}
                          data-testid={`ai-preset-lang-${l}`}
                        >
                          {l === 'en' ? 'English' : 'Tiếng Việt'}
                        </button>
                      ))}
                    </span>
                  </div>
                </div>
              )}
              <div className="ai-field">
                <span className="ai-label ai-label-dark">Name</span>
                <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                  <AiAvatar provider={provider} color={look.color} glyph={look.glyph} size={44} />
                  <input
                    className={`ai-input ${nameCheck || (nameError && attempted) ? 'ai-input-error' : ''}`}
                    style={{ flex: 1 }}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    data-testid="ai-name"
                    autoFocus
                  />
                </div>
                {nameError && attempted ? (
                  <span className="ai-error-text">{nameError}</span>
                ) : nameCheck ? (
                  <span className="ai-error-text">
                    {nameCheck.message}{' '}
                    {nameCheck.suggestion && (
                      <button type="button" className="ai-link" onClick={() => setName(nameCheck.suggestion!)}>
                        Use suggestion
                      </button>
                    )}
                  </span>
                ) : (
                  <span className="ai-hint">Used for @mentions; unique in this project.</span>
                )}
              </div>
              <AvatarPicker
                provider={provider}
                color={look.color}
                glyph={look.glyph}
                onChange={setLook}
                preview={false}
              />
              <div className="ai-field">
                <span className="ai-label ai-label-dark">Short description</span>
                <input
                  className="ai-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Implements server tickets and opens PRs"
                />
              </div>
              <div className="ai-field">
                <span className="ai-label ai-label-dark" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  Role / persona <span style={{ fontWeight: 500 }}>{persona.length} / 1000</span>
                </span>
                <textarea
                  className={`ai-textarea ${persona.length > 1000 ? 'ai-input-error' : ''}`}
                  value={persona}
                  onChange={(e) => setPersona(e.target.value)}
                  placeholder="You review tickets that reach Review. Check the acceptance criteria one by one…"
                />
                <span className="ai-hint">System prompt for every run; visible to members.</span>
              </div>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div className="ai-field" style={{ width: 150 }}>
                  <span className="ai-label ai-label-dark">Max parallel runs</span>
                  <Stepper value={maxParallel} min={1} max={10} onChange={setMaxParallel} />
                </div>
                {apiKey ? (
                  <>
                    <div className="ai-field" style={{ width: 170 }}>
                      <span className="ai-label ai-label-dark">Daily budget</span>
                      <MoneyInput
                        value={dailyBudget}
                        onChange={setDailyBudget}
                        invalid={!!dailyError}
                        testId="ai-daily-budget"
                      />
                      {dailyError && <span className="ai-error-text">{dailyError}</span>}
                    </div>
                    <div className="ai-field" style={{ width: 170 }}>
                      <span className="ai-label ai-label-dark">Monthly cap</span>
                      <MoneyInput
                        value={monthlyCap}
                        onChange={setMonthlyCap}
                        invalid={!!capError}
                        testId="ai-monthly-cap"
                      />
                      {capError && <span className="ai-error-text">{capError}</span>}
                    </div>
                  </>
                ) : (
                  local && (
                    <div className="ai-field" style={{ width: 190 }}>
                      <span className="ai-label ai-label-dark" style={{ whiteSpace: 'nowrap' }}>
                        Scheduled runs per day
                      </span>
                      <Stepper value={runsPerDay} min={1} max={500} onChange={setRunsPerDay} />
                    </div>
                  )
                )}
              </div>
              <span className="ai-hint">
                At the limit it pauses and says why. Local runners get “Scheduled runs per day” instead. It only counts
                runs a schedule starts.
                {apiKey ? ' Costs are estimated in US dollars from the built-in price table.' : ''}
              </span>
            </>
          )}

          {step === 4 && (
            <>
              <div className="ai-field">
                <span className="ai-label ai-label-dark">May move tickets up to</span>
                <div className="ai-seg">
                  {CEILINGS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={ceiling === c ? 'ai-seg-on' : ''}
                      onClick={() => setCeiling(c)}
                    >
                      {STATUS_NAMES[c]}
                    </button>
                  ))}
                </div>
                <span className="ai-hint">
                  Default for every AI member: it can reach Review, a person decides what is Done. Choosing Testing or
                  Done needs an extra confirmation from an owner.
                </span>
                {beyondReview(ceiling) && (
                  <label className="ai-notice ai-notice-warn" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={confirmDone} onChange={(e) => setConfirmDone(e.target.checked)} />
                    <span>
                      <b>I understand nobody reviews these tickets first.</b> Tickets can reach Done without anyone
                      checking; they get an “AI-completed” badge.
                    </span>
                  </label>
                )}
              </div>
              {fixedTemplate ? (
                <div className="ai-notice ai-notice-info" data-testid="ai-fixed-template">
                  <span>
                    The <b>{roleName}</b> role template decides what it may do on tickets: it reads, comments and
                    changes status up to the ceiling; edits and new tickets wait for approval; it cannot change
                    assignees or edit docs. You can change the template later on the Permissions tab.
                  </span>
                </div>
              ) : (
                <div className="ai-field">
                  <span className="ai-label ai-label-dark">Ask a person first before it can…</span>
                  <div className="ai-card">
                    {APPROVAL_TOGGLES.map((t, i) => (
                      <div
                        key={t.action}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          padding: '10px 12px',
                          borderTop: i ? '1px solid #EEF3EF' : undefined,
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</div>
                          <div className="ai-muted">{approvals[t.action] ? t.on : t.off}</div>
                        </div>
                        <button
                          type="button"
                          aria-label={t.label}
                          className={`ai-toggle ${approvals[t.action] ? 'ai-toggle-on' : ''}`}
                          disabled={t.locked || (t.action === 'delete_tickets' && me.data?.role !== 'owner')}
                          title={
                            t.action === 'delete_tickets' && me.data?.role !== 'owner'
                              ? 'Only the owner can enable this'
                              : undefined
                          }
                          onClick={() => setApprovals({ ...approvals, [t.action]: !approvals[t.action] })}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="ai-card" style={{ padding: 12, background: '#F6FAF7' }}>
                <div className="ai-label" style={{ marginBottom: 8 }}>
                  Summary
                </div>
                <dl className="ai-kv">
                  <dt>Name</dt>
                  <dd>{name}</dd>
                  <dt>Connection</dt>
                  <dd>
                    {spec.label}
                    {model ? ` · ${model}` : ''}
                    {apiKey && key ? ` · ••••${key.trim().slice(-4)}` : ''}
                    {local && workingDir ? ` · ${workingDir}` : ''}
                  </dd>
                  <dt>Limits</dt>
                  <dd>
                    {maxParallel} runs
                    {apiKey
                      ? ` · $${daily || 0}/day${monthly != null ? ` · $${monthly || 0}/month` : ''}`
                      : local
                        ? ` · ${runsPerDay} runs/day`
                        : ''}
                  </dd>
                  <dt>Permissions</dt>
                  <dd>
                    Up to {STATUS_NAMES[ceiling]} ·{' '}
                    {fixedTemplate ? `${roleName} role template` : `${approvalsOn} approvals`}
                  </dd>
                </dl>
              </div>
              {saveError && (
                <div className="ai-notice ai-notice-error">
                  <div>
                    {/OS keychain/i.test(saveError) ? (
                      <>
                        {/* 5b: the desktop app keeps keys in the OS keychain and access was denied */}
                        <b>Could not store the key in the OS keychain</b>
                        <div>
                          Access to the system keychain was denied, so nothing was saved and no AI member was created.
                          Allow Kanban in your keychain settings, then retry.
                        </div>
                      </>
                    ) : (
                      <>
                        <b>Could not add the AI member</b>
                        <div>{saveError}. Nothing was saved and no AI member was created.</div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {step === 5 && created && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '10px 0' }}>
              <AiAvatar provider={created.provider} color={created.color} glyph={created.glyph} size={52} />
              <div style={{ fontSize: 16, fontWeight: 800 }}>{created.name} is ready</div>
              <div className="ai-hint" style={{ textAlign: 'center', maxWidth: 420 }}>
                Assign it a ticket or @mention it in a comment. It starts on its own and stops at{' '}
                {STATUS_NAMES[created.ceiling]}.
              </div>
              {created.keyLast4 && (
                <div className="ai-notice ai-notice-info" style={{ width: '100%' }}>
                  <ShieldIcon />
                  <div>
                    <b>Key saved securely</b>
                    <div>
                      <span className="ai-mono" data-testid="key-notice">
                        {savedKeyPrefix}••••••••{created.keyLast4}
                      </span>{' '}
                      is now encrypted. It will not be shown again; to change it, enter a new one.
                    </div>
                  </div>
                </div>
              )}
              <AssignFirstTicket
                projectId={projectId}
                member={created}
                onOpenProfile={() => onOpenProfile(created.id)}
                onDone={onClose}
              />
            </div>
          )}
        </div>

        <div className="ai-modal-foot">
          {step === 5 ? (
            <>
              <span className="ai-hint" style={{ flex: 1 }}>
                Appears under Members · AI in {projectName}
              </span>
              <button type="button" className="ai-btn" onClick={onClose} data-testid="ai-close">
                Close
              </button>
            </>
          ) : (
            <>
              {step > 1 && (
                <button type="button" className="ai-btn" onClick={() => setStep(step - 1)}>
                  Back
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button type="button" className="ai-btn" onClick={onClose}>
                Cancel
              </button>
              {step < 4 ? (
                <button
                  type="button"
                  className="ai-btn ai-btn-primary"
                  disabled={(step === 1 && webBuild && local) || (step === 2 && !step2Ok)}
                  onClick={() => {
                    if (step === 3 && !step3Ok) {
                      setAttempted(true);
                      return;
                    }
                    setStep(step + 1);
                  }}
                  data-testid="ai-next"
                >
                  Next
                </button>
              ) : (
                <button
                  type="button"
                  className="ai-btn ai-btn-primary"
                  disabled={create.isPending || (beyondReview(ceiling) && !confirmDone)}
                  onClick={save}
                  data-testid="ai-save"
                >
                  {create.isPending ? <span className="ai-spin" /> : null} Add AI member
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Group({ title, tag, children }: { title: string; tag: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{title}</span>
        <span className="ai-label">{tag}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>{children}</div>
    </div>
  );
}

function TypeOption({
  p,
  active,
  onPick,
  disabled,
  sub,
  wide,
}: {
  p: AiProvider;
  active: boolean;
  onPick: (p: AiProvider) => void;
  disabled?: boolean;
  sub?: string;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      className={`ai-option ${active ? 'ai-option-active' : ''}`}
      onClick={() => onPick(p)}
      disabled={disabled}
      style={wide ? { gridColumn: '1 / -1' } : undefined}
      data-testid={`ai-type-${p}`}
    >
      <AiAvatar provider={p} size={30} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{PROVIDERS[p].label}</span>
        <span className="ai-muted" style={{ fontSize: 11.5 }}>
          {sub ?? PROVIDERS[p].sub}
        </span>
      </span>
    </button>
  );
}

/** − n + stepper. */
export function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  // Shift + click moves by a tenth of the range (at least 5), so 20 → 50 is a few clicks, or just type the number
  const jump = (e: { shiftKey: boolean }) => (e.shiftKey ? Math.max(5, Math.round((max - min) / 10)) : 1);
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        alignSelf: 'flex-start',
        border: '1px solid #C7D2CB',
        borderRadius: 7,
      }}
    >
      <button
        type="button"
        className="ai-icobtn"
        onClick={(e) => onChange(clamp(value - jump(e)))}
        aria-label="Decrease"
        title="Shift + click: bigger steps"
      >
        −
      </button>
      <input
        type="text"
        inputMode="numeric"
        value={Number.isFinite(value) ? String(value) : ''}
        aria-label="Value"
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '');
          onChange(digits === '' ? NaN : Number(digits));
        }}
        onBlur={() => onChange(Number.isFinite(value) ? clamp(value) : min)}
        style={{
          width: 52,
          border: 'none',
          background: 'transparent',
          textAlign: 'center',
          fontSize: 13,
          fontWeight: 700,
        }}
      />
      <button
        type="button"
        className="ai-icobtn"
        onClick={(e) => onChange(clamp(value + jump(e)))}
        aria-label="Increase"
        title="Shift + click: bigger steps"
      >
        +
      </button>
    </div>
  );
}

/** Shield check icon used in safety notices. */
export function ShieldIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#2E6F40"
      strokeWidth="2"
      strokeLinecap="round"
      style={{ flexShrink: 0, marginTop: 1 }}
    >
      <path d="M12 3L20 6V12C20 16.5 16.5 20 12 21C7.5 20 4 16.5 4 12V6Z" />
      <path d="M9 12L11 14L15 10" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M7 4L20 12L7 20Z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12L20 3M17 6L20 9" />
    </svg>
  );
}

/** A money field with its currency: “$ 5.00  USD”. Costs are estimated in US dollars from the built-in price table. */
function MoneyInput({
  value,
  onChange,
  invalid,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  testId?: string;
}) {
  return (
    <div
      className={`ai-input ${invalid ? 'ai-input-error' : ''}`}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px' }}
    >
      <span className="ai-mono" style={{ color: '#5B6B60' }}>
        $
      </span>
      <input
        className="ai-mono"
        style={{
          border: 'none',
          outline: 'none',
          background: 'transparent',
          flex: 1,
          minWidth: 0,
          font: 'inherit',
          padding: '8px 0',
        }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        data-testid={testId}
      />
      <span className="ai-muted" style={{ fontWeight: 700 }} title="Costs are estimated in US dollars">
        USD
      </span>
    </div>
  );
}

/** Done step: “Assign a ticket” hands the new AI member a first ticket right away; Open profile and Done follow. */
function AssignFirstTicket({
  projectId,
  member,
  onOpenProfile,
  onDone,
}: {
  projectId: string;
  member: AiMember;
  onOpenProfile: () => void;
  onDone: () => void;
}) {
  const tickets = useTickets(projectId);
  const [open, setOpen] = useState(false);
  const [ticketId, setTicketId] = useState('');
  const [start, setStart] = useState<'now' | 'queue' | 'none'>(member.connection === 'inbox' ? 'none' : 'now');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const assign = useAiMutation(() => aiApi.assign(ticketId, { memberId: member.id, start }));
  const candidates = (tickets.data ?? []).filter((t) => !['done', 'wont_do'].includes(t.status) && !t.assignee);
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="ai-btn ai-btn-primary"
          onClick={() => setOpen(!open)}
          disabled={!!done}
          data-testid="ai-assign-ticket"
        >
          Assign a ticket
        </button>
        <button type="button" className="ai-btn" onClick={onOpenProfile}>
          Open profile
        </button>
        <button type="button" className="ai-btn" onClick={onDone} data-testid="ai-done">
          Done
        </button>
      </div>
      {done && (
        <div className="ai-notice ai-notice-info" style={{ width: '100%' }} data-testid="first-ticket-done">
          <div>
            <b>{done}</b>
          </div>
        </div>
      )}
      {open && !done && (
        <div
          className="ai-card"
          style={{ width: '100%', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <select
            className="ai-select"
            value={ticketId}
            onChange={(e) => setTicketId(e.target.value)}
            aria-label="Ticket to assign"
            data-testid="first-ticket-select"
          >
            <option value="">
              {candidates.length ? 'Choose an unassigned ticket…' : 'No unassigned open tickets'}
            </option>
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} · {t.title}
              </option>
            ))}
          </select>
          {member.connection !== 'inbox' && (
            <div className="ai-seg">
              {(
                [
                  ['now', 'Start now'],
                  ['queue', 'Queue'],
                  ['none', 'Assign only'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" className={start === id ? 'ai-seg-on' : ''} onClick={() => setStart(id)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {error && <div className="ai-error-text">{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="ai-btn ai-btn-sm ai-btn-primary"
              disabled={!ticketId || assign.isPending}
              data-testid="first-ticket-confirm"
              onClick={async () => {
                setError(null);
                try {
                  await assign.mutateAsync(undefined);
                  const how = start === 'none' ? '' : start === 'now' ? ' and starting' : ' and queued';
                  setDone(`${ticketId} is assigned to ${member.name}${how}.`);
                } catch (err) {
                  setError(extractError(err));
                }
              }}
            >
              {start === 'none' ? 'Assign' : 'Assign & start'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
