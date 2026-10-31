import { useState } from 'react';
import { extractError } from '../../../api/extractError';
import { Toggle } from '../aiUi';
import type { AiKv, AiMcpServer, AiRemoteMcp } from '../../../types/ai';
import { configApi, useLibrary, type ProbeResult } from './configApi';
import { adapterOf, useCfg } from './configCtx';
import { CfgCard, Chip, Dialog, EmptyState, IssueText, ModeChip, TickRow, newId } from './parts';
import { joinWords, splitWords } from './frontMatter';

const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** Why a remote URL cannot be used by the board server (design D4), or null. */
export function remoteUrlProblem(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  if (/^(npx|uvx|node|python3?|docker|bunx?)\b/.test(u) || !u.includes('://'))
    return 'stdio servers cannot run on the board server. Use a remote HTTP URL, or attach this server to a local-runner member such as Claude Code.';
  if (!/^(https:\/\/|http:\/\/localhost|http:\/\/127\.0\.0\.1)/.test(u))
    return 'Enter an https:// URL (http:// only for localhost).';
  return null;
}

/** Status text of a probe: “Connected · 18 tools”, “Failed to start”, “Not checked”. */
function ProbeChip({ r, documented, busy }: { r?: ProbeResult; documented?: boolean; busy?: boolean }) {
  if (busy) return <Chip>Checking…</Chip>;
  if (documented) return <Chip tone="warn">Not checked · Documented</Chip>;
  if (!r) return <Chip>Not checked</Chip>;
  if (r.ok)
    return (
      <Chip tone="synced">
        Connected · {r.tools} tool{r.tools === 1 ? '' : 's'}
      </Chip>
    );
  return (
    <Chip tone="bad" title={r.error ?? ''}>
      Failed · {(r.error ?? '').slice(0, 48)}
    </Chip>
  );
}

/** Edit list of name/value pairs (env vars, headers); API-agent headers can be marked secret. */
function KvEditor({
  label,
  rows,
  onChange,
  secretFlag,
  namePlaceholder,
  valuePlaceholder,
}: {
  label: string;
  rows: AiKv[];
  onChange: (rows: AiKv[]) => void;
  secretFlag?: boolean;
  namePlaceholder: string;
  valuePlaceholder: string;
}) {
  return (
    <div className="ai-field">
      <span className="ai-label ai-label-dark">{label}</span>
      {rows.map((r, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: secretFlag ? '1fr 1.4fr auto 28px' : '1fr 1.4fr 28px',
            gap: 6,
            alignItems: 'center',
          }}
        >
          <input
            aria-label={`${label} name`}
            className="ai-input ai-mono"
            placeholder={namePlaceholder}
            value={r.name}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
          />
          <input
            aria-label={`${label} value`}
            className="ai-input ai-mono"
            type={r.secret ? 'password' : 'text'}
            autoComplete="off"
            placeholder={r.secret && r.masked ? `${r.masked} (kept; type to replace)` : valuePlaceholder}
            value={r.value}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
          />
          {secretFlag && (
            <label
              className="ai-muted"
              style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
              title="Secret values are encrypted and never shown again"
            >
              <input
                type="checkbox"
                checked={!!r.secret}
                onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, secret: e.target.checked } : x)))}
              />
              🔒 Secret
            </label>
          )}
          <button
            type="button"
            className="ai-icobtn"
            aria-label={`Remove ${label}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ai-link"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => onChange([...rows, { name: '', value: '', secret: secretFlag ? false : undefined }])}
      >
        + Add {label.toLowerCase().replace(/s$/, '')}
      </button>
    </div>
  );
}

/** Add or edit a stdio / http server of a local runner (env and headers editing). */
function ServerDialog({
  server,
  onSave,
  onClose,
}: {
  server: AiMcpServer;
  onSave: (s: AiMcpServer) => void;
  onClose: () => void;
}) {
  const { member } = useCfg();
  const isAg = adapterOf(member) === 'antigravity';
  const [s, setS] = useState(server);
  const line = s.type === 'http' ? s.url : joinWords([s.command, ...s.args].filter(Boolean));
  const literal = s.env.filter((p) => p.value && !ENV_REF.test(p.value));
  return (
    <Dialog
      title={server.name ? `Edit server · ${server.name}` : 'Add server'}
      sub={
        isAg
          ? 'Written to a file inside the project only if experimental sync is on.'
          : 'Written to .mcp.json in the working folder.'
      }
      width={600}
      onClose={onClose}
      testId="server-dialog"
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!s.name.trim() || !line.trim()}
            onClick={() => onSave({ ...s, name: s.name.trim() })}
          >
            Save server
          </button>
        </>
      }
    >
      <div className="cfg-two">
        <div className="ai-field">
          <span className="ai-label ai-label-dark">Name</span>
          <input
            aria-label="Server name"
            className="ai-input"
            value={s.name}
            onChange={(e) => setS({ ...s, name: e.target.value })}
            placeholder="github"
          />
        </div>
        <div className="ai-field">
          <span className="ai-label ai-label-dark">Type</span>
          <select
            aria-label="Server type"
            className="ai-select"
            value={s.type}
            onChange={(e) => setS({ ...s, type: e.target.value as 'stdio' | 'http' })}
          >
            <option value="stdio">stdio — a command on this computer</option>
            <option value="http">Remote HTTP</option>
          </select>
        </div>
      </div>
      <div className="ai-field">
        <span className="ai-label ai-label-dark">{s.type === 'http' ? 'URL' : 'Command'}</span>
        <input
          aria-label={s.type === 'http' ? 'Server URL' : 'Server command'}
          className="ai-input ai-mono"
          value={line}
          placeholder={s.type === 'http' ? 'https://…/mcp' : 'npx -y @modelcontextprotocol/server-github'}
          onChange={(e) => {
            const v = e.target.value;
            if (s.type === 'http') setS({ ...s, url: v });
            else {
              const w = splitWords(v);
              setS({ ...s, command: w[0] ?? '', args: w.slice(1) });
            }
          }}
        />
      </div>
      {s.type === 'stdio' && (
        <KvEditor
          label="Environment"
          rows={s.env}
          onChange={(env) => setS({ ...s, env })}
          namePlaceholder="GITHUB_TOKEN"
          valuePlaceholder="${GITHUB_TOKEN}"
        />
      )}
      {s.type === 'http' && (
        <KvEditor
          label="Headers"
          rows={s.headers}
          onChange={(headers) => setS({ ...s, headers })}
          namePlaceholder="Authorization"
          valuePlaceholder="Bearer ${TOKEN}"
        />
      )}
      {literal.length > 0 && !isAg && (
        <div className="ai-notice ai-notice-warn" data-testid="literal-env-warning">
          {literal.map((p) => p.name).join(', ')} holds a literal value that will be written to .mcp.json in your repo.
          Use a reference such as ${'{'}
          {literal[0].name}
          {'}'} and set the variable on this computer.
        </div>
      )}
      {!isAg && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
          <input
            type="checkbox"
            checked={s.mode === 'documented'}
            onChange={(e) => setS({ ...s, mode: e.target.checked ? 'documented' : 'synced' })}
          />
          Documented only: I set it up by hand (sign-in happens in Claude Code, nothing is written)
        </label>
      )}
    </Dialog>
  );
}

/** Add or edit a remote HTTP server of an API agent. */
function RemoteDialog({
  server,
  onSave,
  onClose,
}: {
  server: AiRemoteMcp;
  onSave: (s: AiRemoteMcp) => void;
  onClose: () => void;
}) {
  const [s, setS] = useState(server);
  const problem = remoteUrlProblem(s.url);
  return (
    <Dialog
      title={server.name ? `Edit server · ${server.name}` : 'Add server'}
      sub="Remote HTTP only. The board connects from its server, so there is no local process to launch."
      width={600}
      onClose={onClose}
      testId="server-dialog"
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!s.name.trim() || !s.url.trim() || !!problem}
            onClick={() => onSave({ ...s, name: s.name.trim(), url: s.url.trim() })}
          >
            Save server
          </button>
        </>
      }
    >
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Name</span>
        <input
          aria-label="Server name"
          className="ai-input"
          value={s.name}
          onChange={(e) => setS({ ...s, name: e.target.value })}
          placeholder="acme-docs"
        />
      </div>
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Add server — URL or command</span>
        <input
          aria-label="Server URL"
          className={`ai-input ai-mono ${problem ? 'ai-input-error' : ''}`}
          value={s.url}
          placeholder="https://mcp.acme-docs.dev/mcp"
          onChange={(e) => setS({ ...s, url: e.target.value })}
        />
        {problem && (
          <span className="ai-error-text" data-testid="remote-url-error">
            {problem}
          </span>
        )}
      </div>
      <KvEditor
        label="Headers"
        rows={s.headers}
        onChange={(headers) => setS({ ...s, headers })}
        secretFlag
        namePlaceholder="Authorization"
        valuePlaceholder="Bearer …"
      />
      <div className="ai-hint">
        Secret header values are encrypted at rest; only the last 4 characters come back. Never in exports, logs or the
        dry-run trace.
      </div>
    </Dialog>
  );
}

/** MCP servers of a Claude Code member (design B3), Antigravity (C4) or an API agent (D4). */
export function McpCard() {
  const { member, cfg, setCfg, issues, status, tick, pickLibrary, replaceConfig } = useCfg();
  const kind = adapterOf(member);
  const lib = useLibrary(member.projectId, 'mcp_server');
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<AiMcpServer | null>(null);
  const [editingRemote, setEditingRemote] = useState<AiRemoteMcp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = new Map((lib.data?.items ?? []).map((i) => [i.id, i]));

  async function probe(key: string, kindName: 'kanban' | 'mcp_servers' | 'remote_mcp', server?: unknown) {
    setBusy(key);
    try {
      const r = await configApi.probe(member.id, kindName, server);
      setProbes((p) => ({ ...p, [key]: r }));
    } catch (e) {
      setProbes((p) => ({
        ...p,
        [key]: { ok: false, tools: 0, seconds: 0, error: extractError(e), state: 'checked' },
      }));
    } finally {
      setBusy(null);
    }
  }
  async function updateFromLibrary(id: string) {
    setError(null);
    try {
      replaceConfig((await configApi.libraryEdit(member.id, 'update', id, cfg)).config);
    } catch (e) {
      setError(extractError(e));
    }
  }
  const blankServer = (): AiMcpServer => ({
    id: newId(),
    name: '',
    type: 'stdio',
    command: '',
    args: [],
    url: '',
    env: [],
    headers: [],
    enabled: true,
    mode: kind === 'antigravity' ? 'documented' : 'synced',
    description: '',
    library: null,
  });
  const saveServer = (s: AiMcpServer) => {
    const exists = cfg.mcpServers.some((x) => x.id === s.id);
    setCfg({ mcpServers: exists ? cfg.mcpServers.map((x) => (x.id === s.id ? s : x)) : [...cfg.mcpServers, s] });
    setEditing(null);
  };

  if (kind === 'api') {
    return (
      <CfgCard
        id="cfg-mcp"
        testId="card-mcp"
        title="MCP client servers"
        mode="direct"
        sub="Remote HTTP only. The board connects from its server, so there is no local process to launch."
        right={
          <>
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => pickLibrary(['mcp_server'], true)}>
              Attach from library
            </button>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              data-testid="add-remote"
              onClick={() =>
                setEditingRemote({ id: newId(), name: '', url: '', headers: [], enabled: true, library: null })
              }
            >
              Add server
            </button>
          </>
        }
      >
        {cfg.remoteMcp.length === 0 && <div className="ai-muted">No remote servers yet.</div>}
        {cfg.remoteMcp.map((s, i) => {
          const r = probes[s.id];
          const auth = s.headers.find((h) => h.secret && h.masked);
          const item = s.library ? latest.get(s.library.id) : undefined;
          return (
            <div key={s.id}>
              <div className="cfg-row" data-testid={`remote-${s.name}`}>
                <div className="cfg-row-main">
                  <div className="cfg-row-title">
                    <span className="ai-mono">{s.name}</span>
                    <ProbeChip r={r} busy={busy === s.id} />
                    {auth && (
                      <Chip>
                        {auth.name === 'Authorization' ? 'Bearer ' : ''}
                        {auth.masked}
                      </Chip>
                    )}
                    {s.library && (
                      <Chip tone={item && item.version > s.library.version ? 'warn' : 'lib'}>
                        Library · v{s.library.version}
                      </Chip>
                    )}
                  </div>
                  <div className="ai-muted cfg-ellipsis">Remote HTTP · {s.url}</div>
                </div>
                <Toggle
                  on={s.enabled}
                  label={`${s.name} on`}
                  onChange={(v) =>
                    setCfg({ remoteMcp: cfg.remoteMcp.map((x) => (x.id === s.id ? { ...x, enabled: v } : x)) })
                  }
                />
                <button
                  type="button"
                  className="ai-btn ai-btn-sm"
                  disabled={busy === s.id}
                  onClick={() => void probe(s.id, 'remote_mcp', s)}
                >
                  Check
                </button>
                <button type="button" className="ai-btn ai-btn-sm" onClick={() => setEditingRemote(s)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="ai-icobtn"
                  aria-label={`Remove ${s.name}`}
                  onClick={() => setCfg({ remoteMcp: cfg.remoteMcp.filter((x) => x.id !== s.id) })}
                >
                  ✕
                </button>
              </div>
              <IssueText issues={issues} path={`remote_mcp.${i}`} prefix />
            </div>
          );
        })}
        {editingRemote && (
          <RemoteDialog
            server={editingRemote}
            onClose={() => setEditingRemote(null)}
            onSave={(s) => {
              const exists = cfg.remoteMcp.some((x) => x.id === s.id);
              setCfg({ remoteMcp: exists ? cfg.remoteMcp.map((x) => (x.id === s.id ? s : x)) : [...cfg.remoteMcp, s] });
              setEditingRemote(null);
            }}
          />
        )}
      </CfgCard>
    );
  }

  const isAg = kind === 'antigravity';
  const syncOn = isAg && cfg.antigravity.syncMcp;
  const effMode = (s: AiMcpServer) => (isAg ? (syncOn ? 'synced' : 'documented') : s.mode);
  return (
    <CfgCard
      id="cfg-mcp"
      testId="card-mcp"
      title={isAg ? 'MCP servers — the rare Synced item' : 'MCP servers'}
      mode={isAg ? (syncOn ? 'synced' : 'documented') : 'synced'}
      sub={
        isAg
          ? 'Sync only works if Antigravity reads MCP servers from a file inside the project.'
          : 'Written to .mcp.json in the working folder. The Kanban server is always present and locked.'
      }
      right={
        <>
          {isAg && <Chip tone="warn">Experimental</Chip>}
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => pickLibrary(['mcp_server'], true)}>
            Attach from library
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            data-testid="add-server"
            onClick={() => setEditing(blankServer())}
          >
            Add server
          </button>
        </>
      }
    >
      {isAg && (
        <div className="ai-notice ai-notice-slate" style={{ flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Toggle
              on={cfg.antigravity.syncMcp}
              label="Sync MCP servers into the project"
              onChange={(v) => setCfg({ antigravity: { ...cfg.antigravity, syncMcp: v } })}
            />
            <b>Sync MCP servers into the project</b>
            <ModeChip mode={syncOn ? 'synced' : 'documented'} />
          </div>
          <span>Off by default. When off, both servers below are Documented.</span>
          {syncOn && (
            <div className="ai-field">
              <span className="ai-label ai-label-dark">Target file (inside the working folder)</span>
              <input
                data-path="antigravity.mcp_target"
                className="ai-input ai-mono"
                value={cfg.antigravity.mcpTarget}
                onChange={(e) => setCfg({ antigravity: { ...cfg.antigravity, mcpTarget: e.target.value } })}
              />
              <IssueText issues={issues} path="antigravity.mcp_target" />
            </div>
          )}
          <span className="ai-hint">
            Antigravity runs started by the board do not read this file; it is for the Antigravity app only.
          </span>
        </div>
      )}
      <div className="cfg-row" data-testid="mcp-kanban-row">
        <div className="cfg-row-main">
          <div className="cfg-row-title">
            <span aria-hidden="true">🔒</span>
            <span className="ai-mono">kanban</span>
            <ProbeChip r={probes.kanban} busy={busy === 'kanban'} />
            <Chip>Preattached</Chip>
            <Chip tone={isAg && !syncOn ? 'warn' : 'synced'}>
              {isAg ? (syncOn ? 'Synced' : 'Documented') : 'Synced'}
            </Chip>
          </div>
          <div className="ai-muted">Board’s own MCP server · {status?.endpoint ?? '/mcp/'} · locked</div>
        </div>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          disabled={busy === 'kanban'}
          onClick={() => void probe('kanban', 'kanban')}
        >
          Check
        </button>
      </div>
      {cfg.mcpServers.length === 0 && !isAg && (
        <div className="ai-muted">No other servers. Add one, or attach one from the library.</div>
      )}
      {cfg.mcpServers.map((s, i) => {
        const r = probes[s.id];
        const mode = effMode(s);
        const doc = status?.documented.find((d) => d.key === `mcp:${s.id}`);
        const item = s.library ? latest.get(s.library.id) : undefined;
        const behind = !!(s.library && item && item.version > s.library.version);
        return (
          <div key={s.id}>
            <div className="cfg-row" data-testid={`server-${s.name}`}>
              <div className="cfg-row-main">
                <div className="cfg-row-title">
                  <span className="ai-mono">{s.name || 'unnamed'}</span>
                  <ProbeChip r={r} busy={busy === s.id} documented={mode === 'documented' && !r} />
                  {s.library ? (
                    <Chip tone={behind ? 'warn' : 'lib'}>
                      Library · v{s.library.version}
                      {behind ? ' · behind' : ''}
                    </Chip>
                  ) : (
                    <Chip>This member only</Chip>
                  )}
                  <Chip tone={mode === 'synced' ? 'synced' : 'warn'}>
                    {mode === 'synced' ? 'Synced' : 'Documented'}
                  </Chip>
                </div>
                <div className="ai-muted cfg-ellipsis">
                  {s.type === 'http' ? `Remote HTTP · ${s.url}` : `stdio · ${joinWords([s.command, ...s.args])}`}
                  {s.env.length > 0 && ` · env ${s.env.map((e) => e.name).join(', ')}`}
                </div>
              </div>
              {mode === 'synced' && (
                <Toggle
                  on={s.enabled}
                  label={`${s.name} on`}
                  onChange={(v) =>
                    setCfg({ mcpServers: cfg.mcpServers.map((x) => (x.id === s.id ? { ...x, enabled: v } : x)) })
                  }
                />
              )}
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                disabled={busy === s.id}
                onClick={() => void probe(s.id, 'mcp_servers', { ...s, mode })}
              >
                Check
              </button>
              <button type="button" className="ai-btn ai-btn-sm" onClick={() => setEditing(s)}>
                Edit
              </button>
              <button
                type="button"
                className="ai-icobtn"
                aria-label={`Remove ${s.name}`}
                onClick={() => setCfg({ mcpServers: cfg.mcpServers.filter((x) => x.id !== s.id) })}
              >
                ✕
              </button>
            </div>
            <IssueText issues={issues} path={`mcp_servers.${i}`} prefix />
            {mode === 'documented' && doc && (
              <div style={{ marginBottom: 8 }}>
                <TickRow item={doc} onTick={(d) => void tick(doc.key, d)} />
              </div>
            )}
            {behind && s.library && (
              <div className="ai-notice ai-notice-warn" style={{ alignItems: 'center', marginBottom: 8 }}>
                <span style={{ flex: 1 }}>
                  <b>
                    “{s.name}” has v{item!.version} in the library.
                  </b>{' '}
                  Updates never apply on their own.
                </span>
                <button
                  type="button"
                  className="ai-btn ai-btn-sm ai-btn-primary"
                  onClick={() => void updateFromLibrary(s.library!.id)}
                >
                  Update to v{item!.version}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {error && <div className="ai-error-text">{error}</div>}
      {cfg.mcpServers.length === 0 && isAg && (
        <EmptyState
          title="No servers yet"
          text="Add one, or attach from the library."
          action="Add server"
          onAction={() => setEditing(blankServer())}
        />
      )}
      {editing && <ServerDialog server={editing} onClose={() => setEditing(null)} onSave={saveServer} />}
    </CfgCard>
  );
}
