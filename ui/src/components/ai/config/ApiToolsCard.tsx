import { useEffect, useMemo, useState } from 'react';
import { extractError } from '../../../api/extractError';
import { Toggle } from '../aiUi';
import type { AiCustomTool, AiKv } from '../../../types/ai';
import { configApi, useLibrary, type ToolCheck, type ToolTestResult } from './configApi';
import { useCfg } from './configCtx';
import { CfgCard, Chip, CodeEditor, Dialog, IssueText, newId, useDebounced } from './parts';

type Groups = ReturnType<typeof useCfg>['cfg']['toolGroups'];

const GROUPS: { key: keyof Groups; label: string; tools: string; writes: boolean; locked?: boolean; note?: string }[] =
  [
    {
      key: 'read',
      label: 'Read tickets',
      tools: 'list_tickets · get_ticket · search_tickets',
      writes: false,
      locked: true,
    },
    {
      key: 'update',
      label: 'Update ticket',
      tools: 'update_ticket · move_ticket',
      writes: true,
      note: '(up to the ceiling)',
    },
    { key: 'comment', label: 'Comment', tools: 'add_comment', writes: true },
    { key: 'create', label: 'Create ticket', tools: 'create_ticket', writes: true },
    { key: 'docsRead', label: 'Docs read', tools: 'list_docs · read_doc · search_docs', writes: false },
    { key: 'docsWrite', label: 'Docs write', tools: 'create_doc · update_doc', writes: true },
    { key: 'testCases', label: 'Run test cases', tools: 'set_test_case', writes: true },
  ];

const BLANK_TOOL = JSON.stringify(
  {
    name: 'lookup_customer',
    description: 'Look a customer up by id.',
    input_schema: {
      type: 'object',
      properties: { customer_id: { type: 'string', description: 'The customer id' } },
      required: ['customer_id'],
    },
    http: { method: 'GET', url: 'https://crm.example.dev/v1/customers/{customer_id}' },
  },
  null,
  2,
);

/** Schema editor and test call for one custom HTTP tool (design D3, F3). */
function ToolDialog({
  tool,
  onSave,
  onClose,
}: {
  tool: AiCustomTool;
  onSave: (t: AiCustomTool) => void;
  onClose: () => void;
}) {
  const { member } = useCfg();
  const [spec, setSpec] = useState(tool.spec || BLANK_TOOL);
  const [headers, setHeaders] = useState<AiKv[]>(tool.headers);
  const [check, setCheck] = useState<ToolCheck | null>(null);
  const [args, setArgs] = useState('{}');
  const [res, setRes] = useState<ToolTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const debounced = useDebounced(spec, 250);
  useEffect(() => {
    let live = true;
    configApi
      .checkTool(debounced)
      .then((c) => {
        if (live) setCheck(c);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [debounced]);
  const bad = useMemo(() => (check?.problems ?? []).map((p) => p.line ?? 1), [check]);
  const [argsTouched, setArgsTouched] = useState(false);
  useEffect(() => {
    if (check?.sampleArgs && !argsTouched) setArgs(check.sampleArgs);
  }, [check?.sampleArgs, argsTouched]);

  async function test() {
    setTesting(true);
    setTestError(null);
    setRes(null);
    try {
      setRes(
        await configApi.testTool(member.id, {
          spec,
          toolId: tool.id,
          headers: headers.map((h) => ({ name: h.name, value: h.value, secret: !!h.secret })),
          argsText: args,
        }),
      );
    } catch (e) {
      setTestError(extractError(e));
    } finally {
      setTesting(false);
    }
  }
  const problems = check?.problems ?? [];
  return (
    <Dialog
      title={tool.name ? `Custom tool · ${tool.name}` : 'Add custom tool'}
      sub="JSON schema for the input, plus the HTTP request the board makes. Checked while typing. Response is capped at 20 KB and passed to the model as text."
      width={760}
      onClose={onClose}
      testId="tool-dialog"
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            data-testid="save-tool"
            onClick={() => onSave({ ...tool, name: check?.name ?? tool.name, spec, headers })}
          >
            Save tool
          </button>
        </>
      }
    >
      <div className="ai-field">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="ai-mono" style={{ fontSize: 12, fontWeight: 700 }}>
            {check?.name || 'tool'}.tool.json
          </span>
          <Chip tone={problems.length ? 'bad' : 'synced'}>{problems.length ? 'Not valid' : 'Parsed as JSON'}</Chip>
        </div>
        <CodeEditor testId="tool-spec" ariaLabel="Tool file" rows={14} value={spec} onChange={setSpec} bad={bad} />
      </div>
      {problems.length > 0 && (
        <div
          className="ai-notice ai-notice-error"
          style={{ flexDirection: 'column', gap: 4 }}
          data-testid="tool-problems"
        >
          <b>
            {problems.length} problem{problems.length === 1 ? '' : 's'} — tool is disabled until fixed
          </b>
          {problems.map((p, i) => (
            <div key={i}>
              {p.line ? `Line ${p.line} · ` : ''}
              <span className="ai-mono">{p.path}</span> {p.message}
              {p.hint && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="ai-link"
                    onClick={() => {
                      const re = /"(\w+)"(\s*[,}\n])/;
                      const wrong = p.message.match(/Got “([^”]*)”/)?.[1];
                      if (wrong) setSpec(spec.replace(`"${wrong}"`, `"${p.hint}"`));
                      else setSpec(spec.replace(re, `"${p.hint}"$2`));
                    }}
                  >
                    Did you mean “{p.hint}”?
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Headers</span>
        {headers.map((h, i) => (
          <div
            key={i}
            style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr auto 28px', gap: 6, alignItems: 'center' }}
          >
            <input
              aria-label="Header name"
              className="ai-input ai-mono"
              placeholder="Authorization"
              value={h.name}
              onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
            <input
              aria-label="Header value"
              className="ai-input ai-mono"
              type={h.secret ? 'password' : 'text'}
              autoComplete="off"
              placeholder={h.secret && h.masked ? `${h.masked} — type to replace` : 'Value'}
              value={h.value}
              onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            />
            <label
              className="ai-muted"
              style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
              title="Secret values are encrypted and never come back"
            >
              <input
                type="checkbox"
                aria-label="Secret header"
                checked={!!h.secret}
                onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, secret: e.target.checked } : x)))}
              />
              🔒 Secret
            </label>
            <button
              type="button"
              className="ai-icobtn"
              aria-label="Remove header"
              onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="ai-link"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setHeaders([...headers, { name: '', value: '', secret: false }])}
        >
          + Add header
        </button>
        <span className="ai-hint">
          Encrypted at rest; only the last 4 characters come back. Never in exports, logs or the dry-run trace. Mark any
          header secret with the lock.
        </span>
      </div>
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Test call — arguments (JSON)</span>
        <CodeEditor
          ariaLabel="Test arguments"
          rows={4}
          value={args}
          onChange={(v) => {
            setArgs(v);
            setArgsTouched(true);
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            data-testid="test-call"
            disabled={testing || problems.length > 0}
            onClick={() => void test()}
          >
            {testing ? 'Calling…' : 'Test call'}
          </button>
          <span className="ai-muted">
            This sends the real request
            {check?.method && check.method !== 'GET' ? ` (${check.method} has side effects)` : ''}.
          </span>
        </div>
        {testError && <div className="ai-error-text">{testError}</div>}
        {res && (
          <div data-testid="test-result">
            <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
              <Chip tone={res.ok ? 'synced' : 'bad'}>{res.status ? `HTTP ${res.status}` : 'No response'}</Chip>
              <Chip>{res.seconds} s</Chip>
              <span className="ai-muted ai-mono cfg-ellipsis">
                {res.method} {res.url}
              </span>
            </div>
            <div className="cfg-mono-box" style={{ maxHeight: 160, overflow: 'auto' }}>
              {res.body}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Tools of an API agent: board tool groups with Read / Writes chips, and custom HTTP tools (design D2). */
export function ApiToolsCard() {
  const { cfg, setCfg, issues, pickLibrary, replaceConfig, member } = useCfg();
  const lib = useLibrary(member.projectId, 'tool');
  const [editing, setEditing] = useState<AiCustomTool | null>(null);
  const [q, setQ] = useState('');
  const on = GROUPS.filter((g) => cfg.toolGroups[g.key]).length;
  const shown = GROUPS.filter((g) => `${g.label} ${g.tools}`.toLowerCase().includes(q.toLowerCase()));
  const latest = new Map((lib.data?.items ?? []).map((i) => [i.id, i]));
  const toolIssues = (i: number) => issues.filter((x) => x.path === `custom_tools.${i}.spec`);
  return (
    <CfgCard
      id="cfg-tools"
      testId="card-tools"
      title="Tools"
      mode="direct"
      right={
        <span className="ai-muted">
          {on} of {GROUPS.length} groups · {cfg.customTools.length} custom
        </span>
      }
      sub="Board tools by group. Writes still obey the member’s ceiling."
    >
      <input
        className="ai-input"
        placeholder="Search tools"
        aria-label="Search tools"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {shown.map((g) => (
        <div key={g.key} className="cfg-row" data-testid={`tool-group-${g.key}`}>
          <div className="cfg-row-main">
            <div className="cfg-row-title">
              {g.label} <Chip tone={g.writes ? 'warn' : 'synced'}>{g.writes ? 'Writes' : 'Read'}</Chip>
            </div>
            <div className="ai-muted ai-mono">
              {g.tools} {g.note}
            </div>
          </div>
          <Toggle
            on={cfg.toolGroups[g.key]}
            disabled={g.locked}
            label={g.label}
            onChange={(v) => setCfg({ toolGroups: { ...cfg.toolGroups, [g.key]: v } })}
          />
        </div>
      ))}
      <div className="ai-divider" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ fontSize: 12.5, flex: 1 }}>Custom HTTP tools</b>
        <button type="button" className="ai-btn ai-btn-sm" onClick={() => pickLibrary(['tool'], true)}>
          Attach from library
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          data-testid="add-tool"
          onClick={() => setEditing({ id: newId(), name: '', spec: '', headers: [], enabled: true, library: null })}
        >
          Add tool
        </button>
      </div>
      {cfg.customTools.length === 0 && (
        <div className="ai-muted">No custom tools. A custom tool turns a model’s call into one HTTP request.</div>
      )}
      {cfg.customTools.map((t, i) => {
        const probs = toolIssues(i);
        const item = t.library ? latest.get(t.library.id) : undefined;
        const behind = !!(t.library && item && item.version > t.library.version);
        let method = 'GET';
        let url = '';
        try {
          const o = JSON.parse(t.spec) as { http?: { method?: string; url?: string } };
          method = o.http?.method ?? 'GET';
          url = o.http?.url ?? '';
        } catch {
          /* shown as a schema error */
        }
        return (
          <div key={t.id}>
            <div className="cfg-row" data-testid={`custom-tool-${t.name}`}>
              <div className="cfg-row-main">
                <div className="cfg-row-title">
                  <span className="ai-mono">{t.name || 'unnamed'}</span>
                  {t.headers.some((h) => h.secret) && <Chip>🔒 Secret header</Chip>}
                  {t.library && (
                    <Chip tone={behind ? 'warn' : 'lib'}>
                      Library · v{t.library.version}
                      {behind ? ' · behind' : ''}
                    </Chip>
                  )}
                  <Chip tone={probs.length ? 'bad' : 'synced'}>{probs.length ? 'Schema error' : 'Valid'}</Chip>
                </div>
                <div className="ai-muted ai-mono cfg-ellipsis">
                  {method} {url}
                </div>
              </div>
              <Toggle
                on={t.enabled}
                label={`${t.name} on`}
                onChange={(v) =>
                  setCfg({ customTools: cfg.customTools.map((x) => (x.id === t.id ? { ...x, enabled: v } : x)) })
                }
              />
              <button type="button" className="ai-btn ai-btn-sm" onClick={() => setEditing(t)}>
                Edit
              </button>
              <button
                type="button"
                className="ai-icobtn"
                aria-label={`Remove ${t.name}`}
                onClick={() => setCfg({ customTools: cfg.customTools.filter((x) => x.id !== t.id) })}
              >
                ✕
              </button>
            </div>
            <IssueText issues={issues} path={`custom_tools.${i}.spec`} />
            {behind && t.library && (
              <div className="ai-notice ai-notice-warn" style={{ alignItems: 'center', marginBottom: 8 }}>
                <span style={{ flex: 1 }}>
                  <b>
                    “{t.name}” has v{item!.version} in the library.
                  </b>{' '}
                  Updates never apply on their own.
                </span>
                <button
                  type="button"
                  className="ai-btn ai-btn-sm ai-btn-primary"
                  onClick={async () =>
                    replaceConfig((await configApi.libraryEdit(member.id, 'update', t.library!.id, cfg)).config)
                  }
                >
                  Update to v{item!.version}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {editing && (
        <ToolDialog
          tool={editing}
          onClose={() => setEditing(null)}
          onSave={(t) => {
            const exists = cfg.customTools.some((x) => x.id === t.id);
            setCfg({
              customTools: exists ? cfg.customTools.map((x) => (x.id === t.id ? t : x)) : [...cfg.customTools, t],
            });
            setEditing(null);
          }}
        />
      )}
    </CfgCard>
  );
}
