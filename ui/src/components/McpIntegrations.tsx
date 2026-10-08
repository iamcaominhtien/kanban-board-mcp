import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { extractError } from '../api/extractError';
import {
  openMcpConfigFile,
  useMcpAction,
  useMcpClient,
  useMcpTest,
  type McpClientId,
  type McpClientStatus,
  type McpTarget,
  type McpTestResult,
} from '../api/settings';
import styles from './McpIntegrations.module.css';

interface ClientDef {
  id: McpClientId;
  label: string;
  initials: string;
  tagline: string;
  scopes: { value: string; label: string }[];
  docsUrl: string;
}

const CLIENTS: ClientDef[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    initials: 'CC',
    tagline: 'Runs claude mcp add for you',
    scopes: [
      { value: 'user', label: 'User - all projects' },
      { value: 'project', label: "Project - this folder's .mcp.json" },
      { value: 'local', label: 'Local' },
    ],
    docsUrl: 'https://code.claude.com/docs/en/mcp',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    initials: 'AG',
    tagline: 'Writes kanban to mcp_config.json',
    scopes: [
      { value: 'global', label: 'Global (~/.gemini/config/mcp_config.json)' },
      { value: 'workspace', label: 'Workspace (.agents/mcp_config.json)' },
    ],
    docsUrl: 'https://antigravity.google/docs/mcp/',
  },
];

const SCOPE_NOTE: Record<string, string> = {
  user: 'Available in all your projects.',
  project: 'Shared with your team through git.',
  local: 'Private to you, for this project folder only.',
  global: 'Global: applies to every workspace on this computer.',
  workspace: 'Workspace: applies to this folder only.',
};

const RESTART_HINT: Record<McpClientId, string> = {
  'claude-code': 'In Claude Code run /mcp reconnect all to pick it up.',
  antigravity: 'No restart needed - changes apply when the file is saved.',
};

function Icon({ d, size = 13 }: { d: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {d}
    </svg>
  );
}

const CopyIcon = (
  <Icon
    d={
      <>
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V6a2 2 0 0 1 2-2h9" />
      </>
    }
  />
);
const CheckIcon = <Icon d={<path d="M5 12.5l4.5 4.5L19 7.5" />} />;
const InfoIcon = (
  <Icon
    d={
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </>
    }
    size={14}
  />
);
const ExternalIcon = (
  <Icon d={<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />} />
);

function Spinner({ dark }: { dark?: boolean }) {
  return <span className={`${styles.spin} ${dark ? styles.spinDark : ''}`} aria-hidden="true" />;
}

/** Colours the command (flags, the `claude mcp add` head) or JSON (keys, strings) for the dark block. */
function highlight(text: string, kind: 'command' | 'json'): ReactNode {
  if (kind === 'json') {
    const out: ReactNode[] = [];
    let last = 0;
    for (const m of text.matchAll(/("(?:[^"\\]|\\.)*")(\s*:)?/g)) {
      const at = m.index ?? 0;
      if (at > last)
        out.push(
          <span key={`p${last}`} className={styles.p}>
            {text.slice(last, at)}
          </span>,
        );
      out.push(
        <span key={`t${at}`} className={m[2] ? styles.k : styles.s}>
          {m[1]}
        </span>,
      );
      if (m[2])
        out.push(
          <span key={`c${at}`} className={styles.p}>
            {m[2]}
          </span>,
        );
      last = at + m[0].length;
    }
    if (last < text.length)
      out.push(
        <span key="end" className={styles.p}>
          {text.slice(last)}
        </span>,
      );
    return out;
  }
  let words = 0;
  return text.split(/(\s+)/).map((part, i) => {
    if (/^\s+$/.test(part)) return <Fragment key={i}>{part}</Fragment>;
    const cls = words++ < 3 ? styles.c : part.startsWith('--') ? styles.f : undefined;
    return (
      <span key={i} className={cls}>
        {part}
      </span>
    );
  });
}

function CodeBlock({ text, kind, copyLabel }: { text: string; kind: 'command' | 'json'; copyLabel: string }) {
  const copied = useCopy();
  return (
    <div className={styles.codeBlock}>
      {highlight(text, kind)}
      <button type="button" className={styles.copyBtn} aria-label={copyLabel} onClick={() => copied.copy(text)}>
        {copied.done ? CheckIcon : CopyIcon}
        {copied.done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function useCopy() {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return {
    done,
    copy(text: string) {
      navigator.clipboard?.writeText(text).then(
        () => setDone(true),
        () => setDone(false),
      );
    },
  };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const copied = useCopy();
  return (
    <button type="button" className={styles.btn} onClick={() => copied.copy(text)}>
      {copied.done ? CheckIcon : CopyIcon}
      {copied.done ? 'Copied' : label}
    </button>
  );
}

type Toast = { title: string; body: string } | null;

interface RowProps {
  def: ClientDef;
  folder: string;
  onFolder: (folder: string) => void;
  onToast: (toast: Toast) => void;
  onToolCount: (count: number) => void;
}

function ClientRow({ def, folder, onFolder, onToast, onToolCount }: RowProps) {
  const [expanded, setExpanded] = useState(false);
  const [scope, setScope] = useState(def.scopes[0].value);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const needsFolder = scope === 'project' || scope === 'local' || scope === 'workspace';
  const target: McpTarget = { id: def.id, scope, folder: needsFolder ? folder.trim() : '' };
  const query = useMcpClient(target);
  const action = useMcpAction();
  const test = useMcpTest();
  const status: McpClientStatus | undefined = query.data;
  const isElectron = !!(window as any).electronAPI?.selectFolder;

  useEffect(() => {
    if (status) onToolCount(status.toolCount);
  }, [status, onToolCount]);

  // A different scope or folder is a different entry: forget results about the previous one.
  useEffect(() => {
    setTestResult(null);
    setConfirmRemove(false);
    setActionError(null);
  }, [scope, folder]);

  const installing = action.isPending && action.variables?.action === 'install';
  const busy = action.isPending || test.isPending;
  const error = status?.error ?? (actionError ? { code: 'request', message: actionError } : null);
  const installed = !!status?.installed;
  const notDetected = !!status && !status.detected && !installed;
  const folderMissing = !!status?.needsFolder;
  const installLabel = installed ? (status?.updateAvailable ? 'Update' : 'Reinstall') : 'Install';

  async function run(kind: 'install' | 'remove') {
    setActionError(null);
    setTestResult(null);
    setConfirmRemove(false);
    try {
      const next = await action.mutateAsync({ target, action: kind });
      if (next.error) return;
      onToast(
        kind === 'install'
          ? { title: `kanban installed in ${def.label}`, body: RESTART_HINT[def.id] }
          : { title: `kanban removed from ${def.label}`, body: 'Your other MCP servers were not touched.' },
      );
    } catch (err) {
      setActionError(extractError(err));
    }
  }

  async function runTest() {
    setTestResult(null);
    try {
      setTestResult(await test.mutateAsync(target));
    } catch (err) {
      setTestResult({ ok: false, toolCount: 0, message: extractError(err) });
    }
  }

  async function browse() {
    const picked = await (window as any).electronAPI?.selectFolder?.();
    if (picked) onFolder(picked);
  }

  let chip = (
    <span className={`${styles.chip} ${styles.chipNone}`}>
      <span className={styles.dot} />
      Not installed
    </span>
  );
  if (installing)
    chip = (
      <span className={`${styles.chip} ${styles.chipNone}`}>
        <Spinner dark />
        Installing…
      </span>
    );
  else if (error)
    chip = (
      <span className={`${styles.chip} ${styles.chipErr}`}>
        <span className={styles.dot} />
        Error
      </span>
    );
  else if (notDetected)
    chip = (
      <span className={`${styles.chip} ${styles.chipNone}`}>
        <span className={styles.dot} />
        Not detected
      </span>
    );
  else if (installed && status?.updateAvailable)
    chip = (
      <span className={`${styles.chip} ${styles.chipWarn}`}>
        <span className={styles.dot} />
        Update available
      </span>
    );
  else if (installed)
    chip = (
      <span className={`${styles.chip} ${styles.chipOk}`}>
        <span className={styles.dot} />
        Installed
      </span>
    );

  let headButton: ReactNode = null;
  if (installing) {
    headButton = (
      <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnBusy}`} disabled>
        <Spinner />
        Installing…
      </button>
    );
  } else if (error) {
    headButton = (
      <button
        type="button"
        className={`${styles.btn} ${styles.btnPrimary}`}
        disabled={busy || folderMissing}
        onClick={() => (error.code === 'request' ? query.refetch() : run('install'))}
      >
        Try again
      </button>
    );
  } else if (notDetected) {
    headButton = (
      <button type="button" className={styles.btn} onClick={() => query.refetch()}>
        Check again
      </button>
    );
  } else if (!installed || status?.updateAvailable) {
    headButton = (
      <button
        type="button"
        className={`${styles.btn} ${styles.btnPrimary}`}
        disabled={busy || folderMissing || !status}
        onClick={() => {
          setExpanded(true);
          run('install');
        }}
      >
        {installLabel}
      </button>
    );
  }

  const manual = def.id === 'claude-code' ? status?.command : status?.entryJson;
  const manualKind = def.id === 'claude-code' ? 'command' : 'json';
  const copyText = def.id === 'claude-code' ? 'Copy command' : 'Copy JSON';

  const scopeChips = (
    <>
      <p className={styles.label}>Scope</p>
      <div className={styles.chips} role="radiogroup" aria-label={`${def.label} scope`}>
        {def.scopes.map((s) => (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={scope === s.value}
            className={`${styles.opt} ${scope === s.value ? styles.optActive : ''}`}
            disabled={busy}
            onClick={() => setScope(s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {needsFolder && (
        <>
          <p className={styles.label}>{scope === 'workspace' ? 'Workspace folder' : 'Project folder'}</p>
          <div className={styles.folderRow}>
            <input
              className={styles.input}
              type="text"
              placeholder="/path/to/project"
              aria-label="Project folder"
              value={folder}
              onChange={(e) => onFolder(e.target.value)}
            />
            {isElectron && (
              <button type="button" className={styles.btn} onClick={browse}>
                Browse…
              </button>
            )}
          </div>
          {query.isError && folder.trim() && <span className={styles.fail}>{extractError(query.error)}</span>}
        </>
      )}
    </>
  );

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.tile} aria-hidden="true">
          {def.initials}
        </span>
        <div className={styles.headText}>
          <span className={styles.name}>{def.label}</span>
          {notDetected ? (
            <span className={styles.tagline}>
              {def.label} not found on this computer ·{' '}
              <a className={styles.link} href={def.docsUrl} target="_blank" rel="noreferrer">
                {def.label} docs
              </a>
            </span>
          ) : (
            <span className={styles.tagline}>{def.tagline}</span>
          )}
        </div>
        {chip}
        {headButton}
        <button
          type="button"
          className={`${styles.chevron} ${expanded ? styles.chevronUp : ''}`}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${def.label}`}
          onClick={() => setExpanded((v) => !v)}
        >
          <Icon d={<path d="M6 9l6 6 6-6" />} size={16} />
        </button>
      </div>

      {expanded && (
        <div className={styles.body}>
          {error ? (
            <>
              <div className={styles.errorBanner} role="alert">
                {error.message}
              </div>
              {manual && (
                <>
                  <p className={styles.label}>{def.id === 'claude-code' ? 'Run it yourself' : 'Entry to add'}</p>
                  <CodeBlock text={manual} kind={manualKind} copyLabel={copyText} />
                </>
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={busy || folderMissing}
                  onClick={() => run('install')}
                >
                  Try again
                </button>
                {manual && <CopyButton text={manual} label={copyText} />}
                {def.id === 'claude-code' ? (
                  <a className={styles.link} href={def.docsUrl} target="_blank" rel="noreferrer">
                    Claude Code docs
                  </a>
                ) : (
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => openMcpConfigFile(target).catch((e) => setActionError(extractError(e)))}
                  >
                    Open file {ExternalIcon}
                  </button>
                )}
              </div>
            </>
          ) : installed ? (
            <>
              <p className={styles.label}>Installed in</p>
              <p className={styles.text}>
                {def.id === 'claude-code' && (
                  <>
                    <span className={styles.code}>{scope}</span> scope, in{' '}
                  </>
                )}
                <span className={styles.code}>{status?.storedIn}</span>. Server name{' '}
                <span className={styles.code}>kanban</span>.
              </p>
              {status?.updateAvailable && (
                <>
                  <div className={styles.versions}>
                    <span>
                      Installed: <span className={styles.code}>{status.installedCommand}</span>
                    </span>
                  </div>
                  <p className={styles.hint}>
                    Update replaces the existing kanban entry with the new one. No duplicate is created.
                  </p>
                </>
              )}
              {confirmRemove ? (
                <div className={styles.confirm} role="alertdialog" aria-label={`Remove kanban from ${def.label}`}>
                  <p className={styles.text}>
                    <strong>Remove &quot;kanban&quot; from {def.label}?</strong> This only deletes the kanban entry.
                  </p>
                  <p className={styles.hint}>
                    {def.id === 'claude-code' ? (
                      <>
                        Runs <span className={styles.code}>claude mcp remove kanban</span>. Your other MCP servers are
                        not touched.
                      </>
                    ) : (
                      <>
                        Removes only the kanban key from <span className={styles.code}>{status?.storedIn}</span>. Your
                        other MCP servers are not touched.
                      </>
                    )}
                  </p>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnSm}`}
                      onClick={() => setConfirmRemove(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnSm} ${styles.btnDanger}`}
                      disabled={busy}
                      onClick={() => run('remove')}
                    >
                      Remove
                    </button>
                  </div>
                  <p className={styles.hint}>Reinstall and Test connection are disabled while this is open.</p>
                </div>
              ) : (
                <div className={styles.actions}>
                  {status?.updateAvailable && (
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      disabled={busy}
                      onClick={() => run('install')}
                    >
                      Update
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${styles.btn} ${status?.updateAvailable ? '' : styles.btnPrimary} ${styles.btnBusy}`}
                    disabled={busy}
                    onClick={runTest}
                  >
                    {test.isPending && <Spinner dark={!!status?.updateAvailable} />}
                    {test.isPending ? 'Testing…' : 'Test connection'}
                  </button>
                  {!status?.updateAvailable && (
                    <button type="button" className={styles.btn} disabled={busy} onClick={() => run('install')}>
                      Reinstall
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnDangerOutline}`}
                    disabled={busy}
                    onClick={() => {
                      setTestResult(null);
                      setConfirmRemove(true);
                    }}
                  >
                    Remove
                  </button>
                  {def.id === 'antigravity' && (
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() => openMcpConfigFile(target).catch((e) => setActionError(extractError(e)))}
                    >
                      Open file {ExternalIcon}
                    </button>
                  )}
                </div>
              )}
              {testResult && (
                <>
                  <div className={testResult.ok ? styles.ok : styles.fail} role="status">
                    {testResult.ok ? CheckIcon : null}
                    {testResult.message}
                  </div>
                  {testResult.ok && (
                    <p className={styles.hint}>
                      {def.id === 'claude-code' ? (
                        <>
                          In Claude Code run <span className={styles.code}>/mcp reconnect all</span> so a running
                          session picks up the server.
                        </>
                      ) : (
                        RESTART_HINT[def.id]
                      )}
                    </p>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <p className={styles.label}>What will happen</p>
              <p className={styles.text}>
                {def.id === 'claude-code' ? (
                  <>
                    The app runs the command below with the Claude Code CLI. It adds one server named{' '}
                    <span className={styles.code}>kanban</span> in the scope you pick. Other servers are not touched.
                  </>
                ) : (
                  <>
                    The app reads the file below, adds or replaces only the <span className={styles.code}>kanban</span>{' '}
                    entry under <span className={styles.code}>mcpServers</span>, and saves it. Every other server stays
                    as it is.
                  </>
                )}
              </p>
              {scopeChips}
              {manual && (
                <>
                  <p className={styles.label}>{def.id === 'claude-code' ? 'Command' : 'Entry to add'}</p>
                  <CodeBlock text={manual} kind={manualKind} copyLabel={copyText} />
                </>
              )}
              {status?.storedIn && (
                <>
                  <p className={styles.label}>Stored in</p>
                  <p className={styles.text}>
                    <span className={styles.code}>{status.storedIn}</span> {SCOPE_NOTE[scope]}
                  </p>
                </>
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary} ${styles.btnBusy}`}
                  disabled={busy || folderMissing || !status}
                  onClick={() => run('install')}
                >
                  {installing && <Spinner />}
                  {installing ? 'Installing…' : 'Install'}
                </button>
                {manual && (
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={busy}
                    onClick={() => navigator.clipboard?.writeText(manual)}
                  >
                    {CopyIcon}
                    {copyText}
                  </button>
                )}
                {def.id === 'antigravity' && (
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => openMcpConfigFile(target).catch((e) => setActionError(extractError(e)))}
                  >
                    Open file {ExternalIcon}
                  </button>
                )}
              </div>
              <p className={styles.note}>
                <span className={styles.noteIcon}>{InfoIcon}</span>
                {def.id === 'claude-code' ? (
                  <span>
                    Needs the Claude Code CLI (<span className={styles.code}>claude</span>) installed on this computer.
                    Project and Local scope also need a project folder.
                  </span>
                ) : (
                  <span>{RESTART_HINT.antigravity}</span>
                )}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function McpIntegrations() {
  const [folder, setFolder] = useState('');
  const [toolCount, setToolCount] = useState<number | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  // Only the first read decides "checking…"; later refetches keep the rows on screen.
  const probe = useMcpClient({ id: 'claude-code', scope: 'user', folder: '' });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className={styles.section}>
      <div className={styles.headRow}>
        <h3 className={styles.title}>MCP integrations</h3>
        {toolCount !== null && <span className={styles.toolsChip}>kanban - {toolCount} tools</span>}
      </div>
      <p className={styles.hint}>Let AI coding tools use your boards through MCP.</p>

      {probe.isLoading ? (
        <>
          <div className={styles.skel} aria-hidden="true" />
          <div className={styles.skel} aria-hidden="true" />
          <p className={styles.hint} role="status">
            Checking which tools are installed…
          </p>
        </>
      ) : (
        CLIENTS.map((def) => (
          <ClientRow
            key={def.id}
            def={def}
            folder={folder}
            onFolder={setFolder}
            onToast={setToast}
            onToolCount={setToolCount}
          />
        ))
      )}

      {toast && (
        <div className={styles.toast} role="status">
          <span className={styles.toastIcon}>{CheckIcon}</span>
          <div className={styles.toastText}>
            <span className={styles.toastTitle}>{toast.title}</span>
            <span className={styles.toastBody}>{toast.body}</span>
          </div>
          <button type="button" className={styles.chevron} aria-label="Dismiss" onClick={() => setToast(null)}>
            <Icon d={<path d="M6 6L18 18M18 6L6 18" />} size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
