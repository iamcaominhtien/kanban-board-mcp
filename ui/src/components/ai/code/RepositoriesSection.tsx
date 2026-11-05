import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { aiApi, useAiBoard } from '../../../api/ai';
import { codeApi, useCodeMutation, useWorktrees } from '../../../api/aiCode';
import { extractError } from '../../../api/extractError';
import { usePatchProjectOps, useProjectOps, type ProjectOps } from '../../../api/aiProjectOps';
import type { HandoverRoute } from '../../../types/aiCode';
import { LoadError, Toggle } from '../aiUi';
import { ROUTE_TEXT, ROUTE_TITLE, WorktreeRow, mbText } from './worktreeUi';
import { TeamRow } from '../settings/settingsUi';
import { EnvBlock } from '../packs/EnvBlock';
import '../settings/teamOwn.css';

interface WtSettings {
  on?: boolean;
  repo?: string | null;
  prepare?: string;
  basePort?: number;
  handover?: HandoverRoute;
  baseBranch?: string | null;
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <TeamRow title={title} hint={hint}>
      {children}
    </TeamRow>
  );
}

/** Text field that saves on blur / Enter, only when the value changed. */
function TextSetting({
  value,
  placeholder,
  label,
  width,
  onSave,
  testId,
}: {
  value: string;
  placeholder?: string;
  label: string;
  width: number;
  onSave: (v: string) => void;
  testId?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="ai-input"
      style={{ width }}
      aria-label={label}
      data-testid={testId}
      placeholder={placeholder}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft != null && draft !== value) onSave(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

/** "Use as a check" for a command the Checks step runs; off keeps the command saved but out of the loop. */
function CheckBox({
  name,
  hasCommand,
  off,
  disabled,
  onChange,
}: {
  name: 'test' | 'lint' | 'build';
  hasCommand: boolean;
  off: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="ai-hint" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
      <input
        type="checkbox"
        data-testid={`check-${name}`}
        aria-label={`Use ${name} as a check`}
        checked={!off}
        disabled={disabled || !hasCommand}
        onChange={(e) => onChange(e.target.checked)}
      />
      Use as a check
    </label>
  );
}

/** Where the AIs work (design/screens/ai-operations.md, I and K): worktrees, ports, the prepare command, hand-over. */
export function RepositoriesSection({ projectId }: { projectId: string }) {
  const ops = useProjectOps(projectId);
  const patch = usePatchProjectOps(projectId);
  const list = useWorktrees(projectId);
  const board = useAiBoard(projectId);
  const runOf = new Map(Object.entries(board.data?.tickets ?? {}));
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const remove = useCodeMutation((id: string) => codeApi.remove(id));
  const keep = useCodeMutation((id: string) => codeApi.keep(id));
  const cleanup = useCodeMutation(() => codeApi.cleanup(projectId));
  const stop = useCodeMutation((runId: string) => aiApi.cancel(runId));
  const open = useCodeMutation((id: string) => codeApi.open(id));

  if (ops.isLoading) return <div className="ai-skel" style={{ height: 120 }} aria-busy="true" aria-label="Loading" />;
  if (ops.error || !ops.data)
    return <LoadError what="the repository settings" error={ops.error} onRetry={() => void ops.refetch()} />;

  const wt = (ops.data.worktrees ?? {}) as WtSettings;
  const on = !!wt.on;
  const route: HandoverRoute = wt.handover ?? 'auto';
  const save = async (body: Partial<ProjectOps>) => {
    setError(null);
    try {
      await patch.mutateAsync(body);
      void qc.invalidateQueries({ queryKey: ['ai', 'worktrees'] });
    } catch (e) {
      setError(extractError(e));
    }
  };
  const checksOff = ops.data.checksOff ?? [];
  const setCheck = (name: string, on: boolean) =>
    save({ checksOff: on ? checksOff.filter((x) => x !== name) : [...new Set([...checksOff, name])] });
  const saveWt = (part: WtSettings) => save({ worktrees: part as Record<string, unknown> });
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError(extractError(e));
    }
  };
  const repoName = wt.repo || 'the member’s working folder';
  const perRun = on ? true : !!ops.data.perRunConfig;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="repositories-section">
      <div style={{ fontSize: 13, fontWeight: 700 }}>Where the AIs work</div>
      <div className="ai-card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Row
          title="One worktree per ticket"
          hint="A branch and a folder of its own for each ticket, so two tickets can run at once and a reviewer reads the real files. Nothing applies to a run that is already going."
        >
          <Toggle
            on={on}
            label="One worktree per ticket"
            testId="wt-on"
            disabled={patch.isPending}
            onChange={(v) => void saveWt({ on: v })}
          />
        </Row>
        <div className="ai-divider" />
        <Row
          title="Repository path"
          hint={`The main checkout. Worktrees go in ${wt.repo ? `${wt.repo}.worktrees/<KEY>` : 'a folder beside it'}, never inside, where they would show as untracked files and block a local merge. Empty: the member's working folder.`}
        >
          <TextSetting
            value={wt.repo ?? ''}
            placeholder="~/code/kanban"
            label="Repository path"
            width={240}
            testId="wt-repo"
            onSave={(v) => void saveWt({ repo: v.trim() || null })}
          />
        </Row>
        <Row
          title="Base branch"
          hint="What a ticket's branch starts from and merges into. Empty: the repository's current branch."
        >
          <TextSetting
            value={wt.baseBranch ?? ''}
            placeholder="current branch"
            label="Base branch"
            width={160}
            testId="wt-base-branch"
            onSave={(v) => void saveWt({ baseBranch: v.trim() || null })}
          />
        </Row>
        <Row title="Branch" hint="ai/<KEY>-<slug>, made when the worktree is made.">
          <span className="ai-mono" style={{ fontSize: 12 }}>
            ai/&lt;KEY&gt;-&lt;slug&gt;
          </span>
        </Row>
        <Row
          title="Prepare command"
          hint="Run once in every new worktree, before the first AI touches it. The board remembers how long it took."
        >
          <TextSetting
            value={wt.prepare ?? ''}
            placeholder="npm ci && uv sync"
            label="Prepare command"
            width={240}
            testId="wt-prepare"
            onSave={(v) => void saveWt({ prepare: v })}
          />
        </Row>
        <Row
          title="Ports for worktrees"
          hint="One per worktree, handed back when it is removed. A clash is a board fault, not the AI's."
        >
          <TextSetting
            value={String(wt.basePort ?? 5180)}
            label="First port"
            width={72}
            testId="wt-base-port"
            onSave={(v) => {
              const n = Math.round(Number(v));
              if (Number.isFinite(n) && n >= 1024 && n <= 65515) void saveWt({ basePort: n });
              else setError('The first port must be between 1024 and 65515.');
            }}
          />
          <span className="ai-hint">
            {wt.basePort ?? 5180}-{(wt.basePort ?? 5180) + 19}
          </span>
        </Row>
        <Row title="Hand over finished code by" hint={ROUTE_TEXT[route === 'auto' ? 'pr' : route]}>
          <select
            className="ai-select"
            aria-label="Hand over finished code by"
            data-testid="wt-handover"
            value={route}
            onChange={(e) => void saveWt({ handover: e.target.value as HandoverRoute })}
          >
            <option value="auto">Guessed from the repository</option>
            {(Object.keys(ROUTE_TITLE) as (keyof typeof ROUTE_TITLE)[]).map((r) => (
              <option key={r} value={r}>
                {ROUTE_TITLE[r]}
              </option>
            ))}
          </select>
        </Row>
        <div className="ai-divider" />
        <div className="ai-hint">
          The project&rsquo;s checks. The Checks step runs them in the ticket&rsquo;s folder, with no AI and no quota.
          The scan can fill them in; here you can set them by hand.
        </div>
        <Row title="Test command" hint="Run by the Checks step of a workflow, and by the Dev before it hands in.">
          <TextSetting
            value={ops.data.commands?.test ?? ''}
            placeholder="npm test"
            label="Test command"
            width={240}
            testId="cmd-test"
            onSave={(v) => void save({ commands: { test: v.trim() } })}
          />
          <CheckBox
            name="test"
            hasCommand={!!ops.data.commands?.test}
            off={checksOff.includes('test')}
            disabled={patch.isPending}
            onChange={(on) => void setCheck('test', on)}
          />
        </Row>
        <Row title="Lint command" hint="Run by the Checks step. Empty: no lint check.">
          <TextSetting
            value={ops.data.commands?.lint ?? ''}
            placeholder="npm run lint"
            label="Lint command"
            width={240}
            testId="cmd-lint"
            onSave={(v) => void save({ commands: { lint: v.trim() } })}
          />
          <CheckBox
            name="lint"
            hasCommand={!!ops.data.commands?.lint}
            off={checksOff.includes('lint')}
            disabled={patch.isPending}
            onChange={(on) => void setCheck('lint', on)}
          />
        </Row>
        <Row title="Build command" hint="Run by the Checks step. Empty: no build check.">
          <TextSetting
            value={ops.data.commands?.build ?? ''}
            placeholder="npm run build"
            label="Build command"
            width={240}
            testId="cmd-build"
            onSave={(v) => void save({ commands: { build: v.trim() } })}
          />
          <CheckBox
            name="build"
            hasCommand={!!ops.data.commands?.build}
            off={checksOff.includes('build')}
            disabled={patch.isPending}
            onChange={(on) => void setCheck('build', on)}
          />
        </Row>
        <EnvBlock
          folders={(ops.data.envPath ?? []).map((path) => ({ path, by: 'project' as const }))}
          onChange={(next) => void save({ envPath: next.map((f) => f.path) })}
          changeNote="Saved for this project. The next run of a command or a ticket uses it."
          disabled={patch.isPending}
        />
        <div className="ai-divider" />
        <Row
          title="Load each member's configuration per run"
          hint={
            on
              ? 'Always on while worktrees are on: nothing is written into the repository.'
              : 'Skills, hooks and MCP servers are passed when a run starts instead of being written into the member’s folder.'
          }
        >
          <Toggle
            on={perRun}
            label="Load each member's configuration per run"
            testId="wt-per-run"
            disabled={on || patch.isPending}
            onChange={(v) => void save({ perRunConfig: v })}
          />
        </Row>
        {!on && (
          <div className="ai-hint" data-testid="wt-off-note">
            Worktrees are off: every member of the project shares {repoName}, the way it works today. Not a git
            repository? The board says so once and falls back to one shared folder.
          </div>
        )}
        {error && (
          <div className="ai-error-text" role="alert">
            {error}
          </div>
        )}
      </div>

      {on && (
        <div className="ai-card" style={{ padding: 12 }} data-testid="worktree-list">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>Where the AIs work</span>{' '}
              {list.data && (
                <span className="ai-hint">
                  {list.data.worktrees.length} worktree{list.data.worktrees.length === 1 ? '' : 's'} ·{' '}
                  {mbText(list.data.totalMb)}
                </span>
              )}
            </div>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              data-testid="wt-cleanup"
              disabled={cleanup.isPending || !list.data?.worktrees.length}
              onClick={() =>
                void act(async () => {
                  const r = await cleanup.mutateAsync(undefined);
                  setNote(
                    `Removed ${r.removed.length}${r.kept.length ? `; kept ${r.kept.map((k) => `${k.ticketId} (${k.why})`).join(', ')}` : ''}.`,
                  );
                })
              }
            >
              Clean up finished
            </button>
          </div>
          {note && (
            <div className="ai-ok-text" style={{ marginBottom: 6 }}>
              {note}
            </div>
          )}
          {list.isLoading ? (
            <div className="ai-skel" style={{ height: 64 }} aria-busy="true" aria-label="Loading" />
          ) : list.error || !list.data ? (
            <LoadError what="the worktrees" error={list.error} onRetry={() => void list.refetch()} />
          ) : list.data.worktrees.length === 0 ? (
            <div className="ai-hint" data-testid="wt-empty">
              No worktree yet. One is made when an AI first works on a ticket.
            </div>
          ) : (
            <table className="ai-table">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Branch</th>
                  <th>State</th>
                  <th>Size</th>
                  <th>Port</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.worktrees.map((w) => (
                  <WorktreeRow
                    key={w.ticketId}
                    w={w}
                    run={runOf.get(w.ticketId)}
                    busy={remove.isPending || keep.isPending || stop.isPending}
                    onOpen={() => void act(() => open.mutateAsync(w.ticketId))}
                    onStop={() => {
                      const r = runOf.get(w.ticketId);
                      if (r) void act(() => stop.mutateAsync(r.runId));
                    }}
                    onRemove={() => void act(() => remove.mutateAsync(w.ticketId))}
                    onKeep={() => void act(() => keep.mutateAsync(w.ticketId))}
                    onCopyPath={() => void navigator.clipboard?.writeText(w.path)}
                  />
                ))}
              </tbody>
            </table>
          )}
          <div className="ai-hint" style={{ marginTop: 8 }}>
            One worktree per ticket, not per member. A worktree is never removed while something is uncommitted: Remove
            is not offered, Keep is.
          </div>
        </div>
      )}
    </div>
  );
}
