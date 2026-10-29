import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { extractError } from '../../../api/extractError';
import type { AiConfig, AiMember } from '../../../types/ai';
import { useToast } from '../../Toast';
import { LoadError, ProviderChip, ago } from '../aiUi';
import { HooksCard, SubagentsCard } from './AgentsHooksCards';
import { ApiToolsCard } from './ApiToolsCard';
import { ContextCard, DryRunCard, LimitsCard, OutputCard } from './ApiLimitsCards';
import {
  configApi,
  configKeys,
  useCapabilityMatrix,
  useConfigStatus,
  type ConfigIssue,
  type ImportPreview,
  type LibraryType,
} from './configApi';
import { CfgContext, adapterOf, useCfg as useCtx, type CfgCtx } from './configCtx';
import { InstructionsCard } from './InstructionsCard';
import { LibraryPicker } from './LibraryView';
import { McpCard } from './McpCard';
import { ModelCard, PermissionsCard } from './PermissionsModelCards';
import { BYPASS_PHRASE, CfgCard, Chip, Dialog, ModeChip, SkeletonCard, useDebounced, type MemberDraft } from './parts';
import { SkillsCard } from './SkillsCard';
import { SyncPreview } from './SyncPreview';
import { countChanges } from './changes';

const GROUP_LABEL: Record<string, string> = {
  skills: 'Skills',
  subagents: 'Subagents',
  hooks: 'Hooks',
  tools: 'Custom tools',
  mcp_servers: 'MCP servers',
};

/** The capability matrix of the adapters (design A2): which groups each adapter declares and how. */
function MatrixPanel({ provider }: { provider: AiMember['provider'] }) {
  const q = useCapabilityMatrix();
  const current =
    provider === 'claude-code' || provider === 'antigravity' || provider === 'mcp-client' ? provider : 'api';
  if (q.isError && !q.data) return <LoadError what="the adapters" error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <div className="ai-skel" style={{ height: 80 }} />;
  return (
    <div className="ai-card" style={{ padding: 12, overflowX: 'auto' }} data-testid="capability-matrix">
      <table className="cfg-matrix">
        <thead>
          <tr>
            <th>Option group</th>
            {q.data.adapters.map((a) => (
              <th key={a.key} style={{ background: a.key === current ? '#F1F8F3' : undefined }}>
                {a.label}
                <div className="ai-muted" style={{ fontWeight: 400 }}>
                  {a.sub}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {q.data.groups.map((g) => (
            <tr key={g.key}>
              <td style={{ fontWeight: 700 }}>{g.label}</td>
              {q.data.adapters.map((a) => {
                const c = a.cells[g.key.replace(/_(\w)/g, (_, ch: string) => ch.toUpperCase())];
                return (
                  <td key={a.key} style={{ background: a.key === current ? '#F6FAF7' : undefined }}>
                    <ModeChip mode={c.mode} />
                    {c.note && <small>{c.note}</small>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ai-muted" style={{ marginTop: 8 }}>
        Synced: the board stores it and the runner writes it (for the API agent: used directly, no files are written).
        Documented: the board only shows steps. Not supported: hidden in this adapter.
      </div>
    </div>
  );
}

/** Other MCP client: it pulls tasks itself, the tab shows only the connection (design A4). */
function InboxCard({ endpoint }: { endpoint: string }) {
  return (
    <CfgCard
      testId="card-inbox"
      title="Other MCP client (inbox only)"
      right={<Chip>No config</Chip>}
      sub="It pulls tasks itself. The Configuration tab shows only the connection."
    >
      <div className="cfg-two">
        <div className="ai-field">
          <span className="ai-label ai-label-dark">MCP endpoint</span>
          <input className="ai-input ai-mono" readOnly value={endpoint} aria-label="MCP endpoint" />
        </div>
        <div className="ai-field">
          <span className="ai-label ai-label-dark">Access token</span>
          <input className="ai-input ai-mono" readOnly value="kb_••••••••••••••••" aria-label="Access token" />
          <span className="ai-muted">
            The board does not issue a token per client yet: the endpoint is open to whoever can reach it. The token
            shown is a placeholder.
          </span>
        </div>
      </div>
    </CfgCard>
  );
}

/** Antigravity: how many Documented items are done (design C3). */
function ItemStatus() {
  const { status } = useCtx();
  if (!status) return null;
  const rows = status.documented.filter((d) => ['instructions', 'skills', 'permissions', 'model'].includes(d.key));
  return (
    <CfgCard
      testId="card-item-status"
      title="Item status"
      right={
        <span className="ai-muted">
          {rows.filter((r) => r.done).length} of {rows.length} Documented items done
        </span>
      }
      sub="Most items are Documented. Only board-side settings can be Synced."
    >
      {rows.map((r) => (
        <div key={r.key} className="cfg-row">
          <span className="cfg-row-main cfg-row-title">{r.label}</span>
          <ModeChip mode="documented" />
          <Chip tone={r.done ? 'synced' : r.stale ? 'warn' : 'plain'}>
            {r.done ? 'Done' : r.stale ? 'Redo' : 'Not done'}
          </Chip>
        </div>
      ))}
    </CfgCard>
  );
}

/** Items attached from the library that this adapter ignores: skipped, never silently dropped (design F6). */
function SkippedBanners({ member }: { member: AiMember }) {
  const { status, cfg, replaceConfig } = useCtx();
  const [dismissed, setDismissed] = useState<string[]>([]);
  const adapter =
    adapterOf(member) === 'claude-code'
      ? 'Claude Code'
      : adapterOf(member) === 'antigravity'
        ? 'Antigravity'
        : 'API agent';
  const detach = (group: string) => {
    const next: AiConfig = { ...cfg };
    if (group === 'skills') next.skills = [];
    if (group === 'subagents') next.subagents = [];
    if (group === 'hooks') next.hooks = [];
    if (group === 'tools') next.customTools = [];
    if (group === 'mcp_servers') {
      if (adapterOf(member) === 'api') next.mcpServers = [];
      else next.remoteMcp = [];
    }
    replaceConfig(next);
  };
  return (
    <>
      {(status?.skipped ?? [])
        .filter((s) => !dismissed.includes(s.group))
        .map((s) => (
          <div
            key={s.group}
            className="ai-notice ai-notice-warn"
            style={{ flexDirection: 'column', gap: 6 }}
            data-testid={`skipped-${s.group}`}
          >
            <b>
              {GROUP_LABEL[s.group] ?? s.group} skipped for {member.name}
            </b>
            <span>
              The {adapter} has no {GROUP_LABEL[s.group] ?? s.group}. These were attached from the library or imported
              and are ignored for this member.
            </span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {s.names.map((n) => (
                <Chip key={n} tone="warn">
                  {n} · skipped
                </Chip>
              ))}
              <span style={{ flex: 1 }} />
              <button type="button" className="ai-btn ai-btn-sm" onClick={() => detach(s.group)}>
                Detach
              </button>
              <button type="button" className="ai-btn ai-btn-sm" onClick={() => setDismissed([...dismissed, s.group])}>
                Keep for other members
              </button>
            </div>
          </div>
        ))}
    </>
  );
}

/** Reset to defaults, with the explanation of what stays (design F8). */
function ResetDialog({
  member,
  count,
  onClose,
  onDone,
}: {
  member: AiMember;
  count: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title="Reset configuration?"
      width={460}
      onClose={onClose}
      testId="reset-dialog"
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-danger"
            onClick={async () => {
              try {
                await configApi.reset(member.id);
                onDone();
              } catch (e) {
                setError(extractError(e));
              }
            }}
          >
            Reset
          </button>
        </>
      }
    >
      <div className="ai-hint">
        Removes everything except the preattached Kanban MCP server and returns settings to adapter defaults. Library
        items stay. Files already written are not deleted. This can be undone for 30 days.
        {count > 0 && ` Your ${count} unsaved change${count === 1 ? ' is' : 's are'} discarded.`}
      </div>
      {error && <div className="ai-error-text">{error}</div>}
    </Dialog>
  );
}

/** Choose a JSON file; the preview says what it adds and the result goes into the form unsaved (design F7). */
function ImportDialog({
  member,
  cfg,
  text,
  onClose,
  onApply,
}: {
  member: AiMember;
  cfg: AiConfig;
  text: string;
  onClose: () => void;
  onApply: (p: ImportPreview) => void;
}) {
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [p, setP] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    configApi
      .importPreview(member.id, text, cfg, mode)
      .then((r) => live && (setP(r), setError(null)))
      .catch((e) => live && setError(extractError(e)));
    return () => {
      live = false;
    };
  }, [member.id, text, cfg, mode]);
  return (
    <Dialog
      title="Import JSON"
      width={520}
      onClose={onClose}
      testId="import-dialog"
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!p || (p?.errors.length ?? 0) > 0}
            onClick={() => p && onApply(p)}
          >
            Import as unsaved changes
          </button>
        </>
      }
    >
      <div className="ai-seg">
        <button type="button" className={mode === 'merge' ? 'ai-seg-on' : ''} onClick={() => setMode('merge')}>
          Add what is new
        </button>
        <button type="button" className={mode === 'replace' ? 'ai-seg-on' : ''} onClick={() => setMode('replace')}>
          Replace everything
        </button>
      </div>
      {error && <div className="ai-notice ai-notice-error">{error}</div>}
      {p && (
        <>
          <div className="ai-notice ai-notice-info" data-testid="import-preview">
            Import preview: {p.summary}
          </div>
          {p.errors.map((e, i) => (
            <div key={i} className="ai-error-text">
              {e.message}
            </div>
          ))}
          {p.skipped.length > 0 && (
            <div className="ai-hint">
              Skipped for this adapter: {p.skipped.map((s) => GROUP_LABEL[s.group] ?? s.group).join(', ')}.
            </div>
          )}
          {p.secretsMissing.length > 0 && (
            <div className="ai-hint">Re-enter secrets: {p.secretsMissing.join(', ')}.</div>
          )}
        </>
      )}
    </Dialog>
  );
}

const bypassConfirmed = (d: MemberDraft) => d.confirmBypass.trim().toLowerCase() === BYPASS_PHRASE;

/** Local checks of the member-level fields that are not in `config`. */
function localIssues(d: MemberDraft, member: AiMember): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  const err = (path: string, message: string) => out.push({ path, message, severity: 'error' });
  if (
    member.connection === 'local' &&
    (!Number.isInteger(d.maxRunsPerDay) || d.maxRunsPerDay < 1 || d.maxRunsPerDay > 500)
  )
    err('max_runs_per_day', 'Scheduled runs per day: 1 to 500.');
  if (d.config.permissionMode === 'bypass' && member.config.permissionMode !== 'bypass' && !bypassConfirmed(d))
    err('permission_mode', 'Type “bypass permissions” to confirm.');
  if (member.connection === 'api_key') {
    if (!Number.isFinite(d.dailyBudget) || d.dailyBudget < 0) err('daily_budget', 'Daily budget must be 0 or more.');
    if (d.monthlyCap && d.monthlyCap < d.dailyBudget)
      err('monthly_cap', `Monthly cap must be at least the daily budget ($${d.dailyBudget.toFixed(2)}).`);
  }
  if (d.persona.length > 1000) err('persona', 'Role / persona must be at most 1000 characters.');
  return out;
}

/** The Configuration tab, built from the adapter's declared groups (design/screens/ai-provider-config.md). */
export function ConfigTab({
  member,
  form,
  initial,
  setForm,
  newKey,
  setNewKey,
  onSave,
  onDiscard,
  saving,
  error,
  blocked,
  identity,
}: {
  member: AiMember;
  form: MemberDraft;
  initial: MemberDraft;
  setForm: (f: MemberDraft) => void;
  newKey: string;
  setNewKey: (v: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  saving: boolean;
  error: string | null;
  blocked: boolean;
  identity: ReactNode;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const statusQ = useConfigStatus(member.id);
  const status = statusQ.data;
  const kind = adapterOf(member);
  const caps = member.capabilities;
  const declares = status?.declares ?? Object.values(caps).filter((m) => m !== 'not_supported').length;
  const changes = countChanges(initial, form, !!newKey);
  const dirty = changes > 0;
  const [serverIssues, setServerIssues] = useState<ConfigIssue[]>([]);
  const probe = useDebounced(JSON.stringify([form.config, form.workingDir]), 350);
  useEffect(() => {
    let live = true;
    configApi
      .validate(member.id, JSON.parse(probe)[0] as AiConfig, form.workingDir)
      .then((r) => live && setServerIssues(r))
      .catch(() => live && setServerIssues([]));
    return () => {
      live = false;
    };
    // `probe` carries the draft; the form itself changes on every keystroke
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe, member.id]);
  const issues = useMemo(() => [...serverIssues, ...localIssues(form, member)], [serverIssues, form, member]);
  const errors = issues.filter((i) => i.severity === 'error');

  const [matrix, setMatrix] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [importText, setImportText] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ types: LibraryType[]; multiple: boolean } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const formRef = useRef(form);
  formRef.current = form;
  const setCfg = useCallback(
    (patch: Partial<AiConfig>) => setForm({ ...formRef.current, config: { ...formRef.current.config, ...patch } }),
    [setForm],
  );
  const setDraft = useCallback((patch: Partial<MemberDraft>) => setForm({ ...formRef.current, ...patch }), [setForm]);
  const replaceConfig = useCallback((c: AiConfig) => setForm({ ...formRef.current, config: c }), [setForm]);
  const refreshStatus = useCallback(
    () => void qc.invalidateQueries({ queryKey: configKeys.status(member.id) }),
    [qc, member.id],
  );

  const tick = useCallback(
    async (key: string, done: boolean) => {
      await configApi.tick(member.id, key, done);
      refreshStatus();
    },
    [member.id, refreshStatus],
  );
  const attached = new Set<string>(
    [
      ...form.config.skills.map((s) => s.library?.id),
      ...form.config.mcpServers.map((s) => s.library?.id),
      ...form.config.remoteMcp.map((s) => s.library?.id),
      ...form.config.customTools.map((s) => s.library?.id),
      ...form.config.snippets.map((s) => s.libraryId),
    ].filter(Boolean) as string[],
  );

  const ctx: CfgCtx = {
    member,
    draft: form,
    cfg: form.config,
    saved: initial.config,
    setCfg,
    setDraft,
    replaceConfig,
    issues,
    status,
    refreshStatus,
    dirty,
    pickLibrary: (types, multiple = false) => setPicker({ types, multiple }),
    tick,
    newKey,
    setNewKey,
  };

  async function exportJson() {
    try {
      const r = await configApi.exportJson(member.id, form.config);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.text], { type: 'application/json' }));
      a.download = r.filename;
      a.click();
    } catch (e) {
      toast.error('Could not export', extractError(e));
    }
  }

  function trySave() {
    setSaveError(null);
    if (errors.length) {
      const el = (document.querySelector(`[data-path="${errors[0].path}"]`) ??
        document.querySelector('[data-testid="cfg-issue"]')) as HTMLElement | null;
      el?.scrollIntoView({ block: 'center' });
      el?.focus();
      setSaveError(
        `${errors.length} problem${errors.length === 1 ? '' : 's'} to fix before saving: ${errors[0].message}`,
      );
      return;
    }
    onSave();
  }

  if (statusQ.isLoading) {
    return (
      <div className="cfg-root" data-testid="cfg-skeleton" aria-busy="true">
        <SkeletonCard rows={1} />
        <div className="cfg-grid">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  const left: ReactNode[] = [];
  const right: ReactNode[] = [];
  if (kind === 'claude-code') {
    left.push(<InstructionsCard key="i" />, <McpCard key="m" />, <PermissionsCard key="p" />);
    right.push(<SkillsCard key="s" />, <SubagentsCard key="a" />, <HooksCard key="h" />, <ModelCard key="mo" />);
  } else if (kind === 'antigravity') {
    left.push(<ItemStatus key="st" />, <InstructionsCard key="i" />, <SkillsCard key="s" />);
    right.push(<McpCard key="m" />, <PermissionsCard key="p" />, <ModelCard key="mo" />);
  } else if (kind === 'api') {
    left.push(<InstructionsCard key="i" />, <ContextCard key="c" />, <OutputCard key="o" />);
    right.push(<ApiToolsCard key="t" />, <McpCard key="m" />, <LimitsCard key="l" />);
  }
  const notes = kind === 'claude-code' || (kind === 'antigravity' && form.config.antigravity.syncMcp);

  return (
    <CfgContext.Provider value={ctx}>
      <div className="cfg-root" style={{ paddingBottom: dirty ? 70 : 0 }} data-testid="cfg-root">
        <div className="ai-card cfg-toolbar" data-testid="cfg-toolbar">
          <span className="ai-label">Adapter</span>
          <ProviderChip provider={member.provider} />
          <span className="cfg-toolbar-meta" data-testid="declares">
            · declares {declares} of {status?.groupsTotal ?? 9} option groups
          </span>
          <button type="button" className="ai-link" onClick={() => setMatrix(!matrix)}>
            {matrix ? 'Hide' : 'Compare'} adapters
          </button>
          <span style={{ flex: 1 }} />
          {kind !== 'inbox' && (
            <span className="cfg-toolbar-meta" data-testid="config-version">
              Config v{status?.version ?? 1} ·{' '}
              {status?.syncedAt
                ? `synced ${ago(status.syncedAt)} · ${status.syncedFiles} file${status.syncedFiles === 1 ? '' : 's'}`
                : kind === 'api'
                  ? 'used directly'
                  : 'nothing synced yet'}
            </span>
          )}
          {kind !== 'inbox' && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                data-testid="import-file"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setImportText(await f.text());
                  e.target.value = '';
                }}
              />
              <button type="button" className="ai-btn ai-btn-sm" onClick={() => fileRef.current?.click()}>
                Import JSON
              </button>
              <button type="button" className="ai-btn ai-btn-sm" onClick={() => void exportJson()}>
                Export JSON
              </button>
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                data-testid="reset-defaults"
                onClick={() => setResetting(true)}
              >
                Reset to defaults
              </button>
              <button
                type="button"
                className="ai-btn ai-btn-sm ai-btn-primary"
                data-testid="toolbar-save"
                disabled={!dirty || saving || blocked}
                onClick={trySave}
              >
                Save changes
              </button>
            </>
          )}
        </div>
        {matrix && <MatrixPanel provider={member.provider} />}
        {status?.undo && (
          <div className="ai-notice ai-notice-info" style={{ alignItems: 'center' }} data-testid="undo-reset">
            <span style={{ flex: 1 }}>
              The configuration was reset {ago(status.undo.at)}
              {status.undo.by ? ` by ${status.undo.by}` : ''}. You can undo it for {status.undo.daysLeft} more days.
            </span>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              onClick={async () => {
                try {
                  await configApi.undoReset(member.id);
                  void qc.invalidateQueries({ queryKey: ['ai'] });
                  toast.success('Reset undone', 'The earlier configuration is back.');
                } catch (e) {
                  toast.error('Could not undo', extractError(e));
                }
              }}
            >
              Undo reset
            </button>
          </div>
        )}
        <SkippedBanners member={member} />
        {kind === 'inbox' ? (
          <InboxCard endpoint={status?.endpoint ?? '/mcp/'} />
        ) : (
          <>
            {identity}
            <div className="cfg-grid">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>{left}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>{right}</div>
            </div>
            {notes && <SyncPreview />}
            {kind === 'api' && <DryRunCard />}
          </>
        )}
        {(error || saveError) && (
          <div className="ai-notice ai-notice-error" data-testid="cfg-error">
            {error ?? saveError}
          </div>
        )}
        {dirty && (
          <div className="cfg-bar" data-testid="unsaved-bar">
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#F2C98A' }} />
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>
              {changes} unsaved change{changes === 1 ? '' : 's'}
              {errors.length > 0 && (
                <span style={{ color: '#F4B7A8', fontWeight: 500 }}>
                  {' '}
                  · {errors.length} problem{errors.length === 1 ? '' : 's'} block saving
                </span>
              )}
            </span>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              onClick={() => {
                onDiscard();
                setSaveError(null);
              }}
            >
              Discard
            </button>
            <button
              type="button"
              className="ai-btn ai-btn-sm ai-btn-primary"
              data-testid="save-changes"
              onClick={trySave}
              disabled={saving || blocked}
            >
              Save changes
            </button>
          </div>
        )}
        {picker && (
          <LibraryPicker
            projectId={member.projectId}
            types={picker.types}
            multiple={picker.multiple}
            attached={attached}
            onClose={() => setPicker(null)}
            onPick={async (ids) => {
              let next = formRef.current.config;
              for (const id of ids) next = (await configApi.libraryEdit(member.id, 'attach', id, next)).config;
              replaceConfig(next);
            }}
          />
        )}
        {resetting && (
          <ResetDialog
            member={member}
            count={changes}
            onClose={() => setResetting(false)}
            onDone={() => {
              setResetting(false);
              void qc.invalidateQueries({ queryKey: ['ai'] });
              toast.success('Configuration reset', 'Undo is available for 30 days.');
            }}
          />
        )}
        {importText !== null && (
          <ImportDialog
            member={member}
            cfg={form.config}
            text={importText}
            onClose={() => setImportText(null)}
            onApply={(p) => {
              replaceConfig(p.config);
              setImportText(null);
              toast.success('Imported as unsaved changes', p.summary);
            }}
          />
        )}
      </div>
    </CfgContext.Provider>
  );
}
