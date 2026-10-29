import { useState } from 'react';
import { extractError } from '../../../api/extractError';
import { Toggle } from '../aiUi';
import type { AiHook, AiSubagent } from '../../../types/ai';
import { configApi } from './configApi';
import { useCfg } from './configCtx';
import { CfgCard, Chip, CodeEditor, Dialog, EmptyState, IssueText, newId } from './parts';
import { agentTemplate, frontMatter } from './frontMatter';

const EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionStart',
  'SessionEnd',
];

/** Add or edit a subagent file. */
function AgentDialog({
  agent,
  onSave,
  onClose,
}: {
  agent: AiSubagent | null;
  onSave: (a: AiSubagent) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(agent?.content ?? agentTemplate());
  const fm = frontMatter(text).fields;
  return (
    <Dialog
      title={agent ? `Edit subagent · ${agent.name}` : 'Add subagent'}
      sub={
        <>
          Written to <span className="ai-code">.claude/agents/{fm.name || 'name'}.md</span>
        </>
      }
      width={600}
      onClose={onClose}
      testId="agent-dialog"
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!fm.name}
            onClick={() =>
              onSave({
                id: agent?.id ?? newId(),
                name: fm.name,
                description: fm.description ?? '',
                content: text,
                model: fm.model ?? '',
                tools: fm.tools ?? '',
                enabled: agent?.enabled ?? true,
                library: agent?.library ?? null,
              })
            }
          >
            {agent ? 'Save subagent' : 'Add subagent'}
          </button>
        </>
      }
    >
      <CodeEditor testId="agent-editor" ariaLabel="Subagent file" rows={11} value={text} onChange={setText} />
      {!fm.name && <div className="ai-error-text">The front matter needs a name: line.</div>}
    </Dialog>
  );
}

/** Subagents: `.claude/agents/<name>.md` (design B4). */
export function SubagentsCard() {
  const { cfg, setCfg, issues } = useCfg();
  const [editing, setEditing] = useState<AiSubagent | null | 'new'>(null);
  return (
    <CfgCard
      id="cfg-subagents"
      testId="card-subagents"
      title="Subagents"
      mode="synced"
      sub={
        <>
          Written to <span className="ai-code">.claude/agents/</span>name<span className="ai-code">.md</span>
        </>
      }
      right={
        <button type="button" className="ai-btn ai-btn-sm" data-testid="add-subagent" onClick={() => setEditing('new')}>
          Add subagent
        </button>
      }
    >
      {cfg.subagents.length === 0 && (
        <EmptyState
          title="No subagents yet"
          text="A subagent is a helper Claude Code can hand work to, such as a read-only code reviewer."
          action="Add subagent"
          onAction={() => setEditing('new')}
        />
      )}
      {cfg.subagents.map((a, i) => (
        <div key={a.id}>
          <div className="cfg-row" data-testid={`agent-${a.name}`}>
            <div className="cfg-row-main">
              <div className="cfg-row-title">
                <span className="ai-mono">{a.name || 'unnamed'}</span>
                {a.model && <Chip>Model: {a.model}</Chip>}
                {a.tools && <Chip>Tools: {a.tools}</Chip>}
                <Chip tone="synced">Synced</Chip>
              </div>
              <div className="ai-muted cfg-ellipsis">{a.description}</div>
            </div>
            <Toggle
              on={a.enabled}
              label={`${a.name} on`}
              onChange={(v) =>
                setCfg({ subagents: cfg.subagents.map((x) => (x.id === a.id ? { ...x, enabled: v } : x)) })
              }
            />
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => setEditing(a)}>
              Edit
            </button>
            <button
              type="button"
              className="ai-icobtn"
              aria-label={`Remove ${a.name}`}
              onClick={() => setCfg({ subagents: cfg.subagents.filter((x) => x.id !== a.id) })}
            >
              ✕
            </button>
          </div>
          <IssueText issues={issues} path={`subagents.${i}`} prefix />
        </div>
      ))}
      {editing && (
        <AgentDialog
          agent={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(a) => {
            const exists = cfg.subagents.some((x) => x.id === a.id);
            setCfg({ subagents: exists ? cfg.subagents.map((x) => (x.id === a.id ? a : x)) : [...cfg.subagents, a] });
            setEditing(null);
          }}
        />
      )}
    </CfgCard>
  );
}

/** Type “allow hooks” to let the board write the hooks block (design B5). */
function ConfirmHooksDialog({ onClose }: { onClose: () => void }) {
  const { member, cfg, refreshStatus } = useCfg();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enabled = cfg.hooks.filter((h) => h.enabled);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await configApi.write(member.id, { confirmHooks: typed });
      if (!r.ok && r.error) setError(r.error.message);
      else if (!r.ok && r.conflicts?.length)
        setError('A file changed outside Kanban: resolve the conflict in Sync preview first.');
      else {
        refreshStatus();
        onClose();
      }
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Allow hooks?"
      width={520}
      onClose={onClose}
      testId="confirm-hooks"
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-danger"
            disabled={typed.trim() !== 'allow hooks' || busy}
            onClick={() => void go()}
          >
            Write hooks now
          </button>
        </>
      }
    >
      <div className="ai-notice ai-notice-warn">
        These {enabled.length} hook command{enabled.length === 1 ? '' : 's'} will run on your computer with your user
        rights every time the event fires, with no prompt.
      </div>
      {enabled.map((h) => (
        <div key={h.id} className="cfg-mono-box">
          {h.event}
          {h.matcher ? ` (${h.matcher})` : ''}: {h.command}
        </div>
      ))}
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Type “allow hooks” to confirm</span>
        <input
          aria-label="Type allow hooks"
          className="ai-input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
        />
      </div>
      {error && <div className="ai-error-text">{error}</div>}
    </Dialog>
  );
}

/** Hooks: the hooks block of `.claude/settings.json`, behind a typed confirmation (design B5). */
export function HooksCard() {
  const { cfg, setCfg, issues, status, dirty } = useCfg();
  const [confirming, setConfirming] = useState(false);
  const set = (id: string, patch: Partial<AiHook>) =>
    setCfg({ hooks: cfg.hooks.map((h) => (h.id === id ? { ...h, ...patch } : h)) });
  const active = cfg.hooks.filter((h) => h.enabled && h.event && h.command);
  return (
    <CfgCard
      id="cfg-hooks"
      testId="card-hooks"
      title="Hooks"
      mode="synced"
      sub={
        <>
          Written to the hooks block of <span className="ai-code">.claude/settings.json</span>
        </>
      }
      right={
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          data-testid="add-hook"
          onClick={() =>
            setCfg({
              hooks: [
                ...cfg.hooks,
                { id: newId(), event: 'PostToolUse', matcher: 'Edit|Write', command: '', enabled: true },
              ],
            })
          }
        >
          Add hook
        </button>
      }
    >
      <div className="ai-notice ai-notice-warn" style={{ flexDirection: 'column', gap: 2 }}>
        <b>Hooks run shell commands on your computer</b>
        <span>
          They run with your user rights every time the event fires, with no prompt. Only enable commands you have read.
          The first Synced write of hooks asks you to type “allow hooks”.
        </span>
      </div>
      {cfg.hooks.length === 0 && <div className="ai-muted">No hooks.</div>}
      {cfg.hooks.length > 0 && (
        <table className="ai-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Event</th>
              <th>Matcher</th>
              <th>Command</th>
              <th />
              <th />
            </tr>
          </thead>
          <tbody>
            {cfg.hooks.map((h, i) => (
              <tr key={h.id} data-testid={`hook-${i}`}>
                <td>
                  <select
                    aria-label="Hook event"
                    className="ai-select"
                    value={h.event}
                    onChange={(e) => set(h.id, { event: e.target.value })}
                  >
                    {EVENTS.map((ev) => (
                      <option key={ev}>{ev}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    aria-label="Hook matcher"
                    className="ai-input ai-mono"
                    value={h.matcher}
                    placeholder="Edit|Write"
                    onChange={(e) => set(h.id, { matcher: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    aria-label="Hook command"
                    className="ai-input ai-mono"
                    data-path={`hooks.${i}.command`}
                    value={h.command}
                    placeholder="npm run lint --silent"
                    onChange={(e) => set(h.id, { command: e.target.value })}
                  />
                </td>
                <td>
                  <Toggle on={h.enabled} label="Hook on" onChange={(v) => set(h.id, { enabled: v })} />
                </td>
                <td>
                  <button
                    type="button"
                    className="ai-icobtn"
                    aria-label="Remove hook"
                    onClick={() => setCfg({ hooks: cfg.hooks.filter((x) => x.id !== h.id) })}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <IssueText issues={issues} path="hooks" prefix />
      {active.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {status?.hooksConfirmed && !dirty ? (
            <Chip tone="synced">Allowed{status.hooksBy ? ` by ${status.hooksBy}` : ''}</Chip>
          ) : (
            <>
              <Chip tone="warn">Waiting for “allow hooks”</Chip>
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                disabled={dirty}
                title={dirty ? 'Save your changes first' : undefined}
                onClick={() => setConfirming(true)}
              >
                Allow hooks…
              </button>
            </>
          )}
          <span className="ai-muted">Hook scripts that live in the repo are not copied by Kanban.</span>
        </div>
      )}
      {confirming && <ConfirmHooksDialog onClose={() => setConfirming(false)} />}
    </CfgCard>
  );
}
