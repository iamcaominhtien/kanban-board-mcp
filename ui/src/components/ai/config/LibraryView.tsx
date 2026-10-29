import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { extractError } from '../../../api/extractError';
import { useToast } from '../../Toast';
import { ago } from '../aiUi';
import {
  configApi,
  configKeys,
  useLibrary,
  useLibraryItem,
  type LibraryItem,
  type LibraryRow,
  type LibraryType,
} from './configApi';
import { Chip, CodeEditor, Dialog, DiffView, EmptyState } from './parts';
import { skillTemplate } from './frontMatter';

const TYPES: { key: LibraryType; label: string }[] = [
  { key: 'skill', label: 'Skills' },
  { key: 'tool', label: 'Tools' },
  { key: 'mcp_server', label: 'MCP servers' },
  { key: 'snippet', label: 'Instructions' },
];
const TYPE_LABEL: Record<LibraryType, string> = {
  skill: 'Skill',
  tool: 'Tool',
  mcp_server: 'MCP server',
  snippet: 'Instructions',
};

const STARTER: Record<LibraryType, string> = {
  skill: skillTemplate('my-skill'),
  snippet: '- Use conventional commits.\n- Reference the ticket key in the first line.',
  mcp_server: JSON.stringify(
    {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: [{ name: 'GITHUB_TOKEN', value: '${GITHUB_TOKEN}' }],
    },
    null,
    2,
  ),
  tool: JSON.stringify(
    {
      name: 'get_deploy_status',
      description: 'Current deploy state of an environment.',
      input_schema: {
        type: 'object',
        properties: { environment: { type: 'string', enum: ['staging', 'prod'] } },
        required: ['environment'],
      },
      http: { method: 'GET', url: 'https://deploy.example.dev/api/status' },
    },
    null,
    2,
  ),
};

/** Create a library item. */
function NewItemDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (i: LibraryItem) => void;
}) {
  const [type, setType] = useState<LibraryType>('skill');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState(STARTER.skill);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title="New library item"
      sub="Create an item once, use it on every member."
      width={620}
      onClose={onClose}
      testId="new-library-item"
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!name.trim()}
            onClick={async () => {
              try {
                onCreated(await configApi.libraryCreate(projectId, { type, name, description, content }));
              } catch (e) {
                setError(extractError(e));
              }
            }}
          >
            Create item
          </button>
        </>
      }
    >
      <div className="cfg-two">
        <div className="ai-field">
          <span className="ai-label ai-label-dark">Type</span>
          <select
            aria-label="Item type"
            className="ai-select"
            value={type}
            onChange={(e) => {
              setType(e.target.value as LibraryType);
              setContent(STARTER[e.target.value as LibraryType]);
            }}
          >
            {TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {TYPE_LABEL[t.key]}
              </option>
            ))}
          </select>
        </div>
        <div className="ai-field">
          <span className="ai-label ai-label-dark">Name</span>
          <input
            aria-label="Item name"
            className="ai-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={type === 'tool' ? 'get_deploy_status' : 'commit-conventions'}
          />
        </div>
      </div>
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Description</span>
        <input
          aria-label="Item description"
          className="ai-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <CodeEditor ariaLabel="Item content" rows={10} value={content} onChange={setContent} />
      {error && <div className="ai-error-text">{error}</div>}
    </Dialog>
  );
}

/** After saving a new version: who is behind, and a choice per member (design E2). */
function UpdatePrompt({ item, previous, onClose }: { item: LibraryItem; previous: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const behind = item.users.filter((u) => u.version < item.version);
  const ok = behind.filter((u) => u.mode !== 'skipped');
  const [picked, setPicked] = useState<string[]>(ok.map((u) => u.memberId));
  const diff = useQuery({
    queryKey: ['ai', 'library-diff', item.id, previous],
    queryFn: () => configApi.libraryDiff(item.id, previous),
  });
  const [error, setError] = useState<string | null>(null);
  const current = item.users.filter((u) => u.version >= item.version);
  return (
    <Dialog
      title={`Update “${item.name}” to v${item.version}?`}
      sub={`${behind.length} of ${item.users.length} members are on an older version.${current.length ? ` ${current.map((u) => u.name).join(', ')} already on v${item.version}.` : ''}`}
      width={600}
      onClose={onClose}
      testId="update-prompt"
      foot={
        <>
          <button type="button" className="ai-btn" onClick={onClose}>
            Keep v{previous}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Not now
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!picked.length}
            onClick={async () => {
              try {
                const r = await configApi.libraryPropagate(item.id, picked);
                void qc.invalidateQueries({ queryKey: ['ai'] });
                if (r.failed.length) setError(r.failed.map((f) => f.message).join(' '));
                else {
                  toast.success(
                    `Updated ${r.updated.length} member${r.updated.length === 1 ? '' : 's'}`,
                    `${item.name} v${item.version}`,
                  );
                  onClose();
                }
              } catch (e) {
                setError(extractError(e));
              }
            }}
          >
            Update {picked.length} member{picked.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <span className="ai-label">What changed in v{item.version}</span>
      <DiffView rows={diff.data?.changes ?? []} empty={diff.isLoading ? 'Loading…' : 'No visible change.'} />
      {behind.map((u) => (
        <label key={u.memberId} className="cfg-row" style={{ cursor: u.mode === 'skipped' ? 'default' : 'pointer' }}>
          <input
            type="checkbox"
            disabled={u.mode === 'skipped'}
            checked={picked.includes(u.memberId)}
            onChange={(e) =>
              setPicked(e.target.checked ? [...picked, u.memberId] : picked.filter((x) => x !== u.memberId))
            }
          />
          <span className="cfg-row-main">
            <span className="cfg-row-title">{u.name}</span>
            <span className="ai-muted">on v{u.version}</span>
          </span>
          <Chip tone={u.mode === 'synced' ? 'synced' : 'warn'}>
            {u.mode === 'synced' ? 'Synced' : u.mode === 'documented' ? 'Documented' : 'Skipped'}
          </Chip>
        </label>
      ))}
      <div className="ai-hint">
        Synced members get the new file on their next run. Documented members see a “redo” reminder. Updates never apply
        on their own.
      </div>
      {error && <div className="ai-error-text">{error}</div>}
    </Dialog>
  );
}

/** One item: edit it as a new version, see its history and who uses it. */
function ItemDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const q = useLibraryItem(id);
  const qc = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ item: LibraryItem; previous: number } | null>(null);
  const it = q.data;
  if (!it) return <div className="ai-skel" style={{ height: 200 }} />;
  const value = text ?? it.content;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" className="ai-link" onClick={onBack}>
          ← All items
        </button>
        <b style={{ fontSize: 14 }}>{it.name}</b>
        <Chip tone="lib">{TYPE_LABEL[it.type]}</Chip>
        <Chip>v{it.version}</Chip>
      </div>
      <div className="ai-hint">{it.description}</div>
      <CodeEditor ariaLabel="Item content" testId="library-content" rows={11} value={value} onChange={setText} />
      <input
        className="ai-input"
        placeholder="What changed? (optional)"
        aria-label="Change note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          className="ai-btn ai-btn-primary"
          data-testid="save-version"
          disabled={value === it.content}
          onClick={async () => {
            setError(null);
            try {
              const next = await configApi.libraryVersion(it.id, { content: value, note: note || undefined });
              setText(null);
              setNote('');
              void qc.invalidateQueries({ queryKey: ['ai', 'library'] });
              void qc.invalidateQueries({ queryKey: configKeys.libraryItem(it.id) });
              if (next.users.some((u) => u.version < next.version)) setPrompt({ item: next, previous: it.version });
            } catch (e) {
              setError(extractError(e));
            }
          }}
        >
          Save as v{it.version + 1}
        </button>
        <span className="ai-muted">Members stay on v{it.version} until someone updates them.</span>
      </div>
      {error && <div className="ai-error-text">{error}</div>}
      <span className="ai-label">Used by</span>
      {it.users.length === 0 && <div className="ai-muted">Nobody yet.</div>}
      {it.users.map((u) => (
        <div key={u.memberId} className="cfg-row">
          <span className="cfg-row-main cfg-row-title">{u.name}</span>
          <Chip tone={u.behind ? 'warn' : 'lib'}>
            v{u.version}
            {u.behind ? ' · behind' : ''}
          </Chip>
          <Chip tone={u.mode === 'synced' ? 'synced' : 'warn'}>
            {u.mode === 'synced' ? 'Synced' : u.mode === 'documented' ? 'Documented' : 'Skipped'}
          </Chip>
        </div>
      ))}
      <span className="ai-label">History</span>
      {[{ version: it.version, at: it.updatedAt, by: null, note: 'Current' }, ...it.history].map((h) => (
        <div key={h.version} className="cfg-row">
          <span className="cfg-row-main">
            v{h.version}
            {h.note ? ` · ${h.note}` : ''}
          </span>
          <span className="ai-muted">{ago(h.at)}</span>
        </div>
      ))}
      {prompt && <UpdatePrompt item={prompt.item} previous={prompt.previous} onClose={() => setPrompt(null)} />}
    </>
  );
}

/** Settings → AI → Library: skills, snippets, MCP servers and tools shared by members (design E1). */
export function LibraryModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [type, setType] = useState<LibraryType | ''>('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useLibrary(projectId, type || undefined, q);
  const counts = list.data?.counts ?? {};
  return (
    <Dialog
      title="Library"
      sub="Define a skill, tool, MCP server or instruction snippet once and attach it to many AI members. Each edit creates a new version."
      width={820}
      onClose={onClose}
      testId="library-modal"
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {open ? (
        <ItemDetail id={open} onBack={() => setOpen(null)} />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="ai-seg">
              <button type="button" className={type === '' ? 'ai-seg-on' : ''} onClick={() => setType('')}>
                All · {counts.all ?? 0}
              </button>
              {TYPES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={type === t.key ? 'ai-seg-on' : ''}
                  onClick={() => setType(t.key)}
                >
                  {t.label} · {counts[t.key] ?? 0}
                </button>
              ))}
            </div>
            <input
              className="ai-input"
              style={{ flex: 1, minWidth: 140 }}
              placeholder="Search library"
              aria-label="Search library"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button
              type="button"
              className="ai-btn ai-btn-primary"
              data-testid="new-library-button"
              onClick={() => setCreating(true)}
            >
              New item
            </button>
          </div>
          {list.isLoading && <div className="ai-skel" style={{ height: 120 }} />}
          {list.data && list.data.items.length === 0 && (
            <EmptyState
              title="The library is empty"
              text="Create an item once, use it on every member."
              action="New item"
              onAction={() => setCreating(true)}
            />
          )}
          {list.data && list.data.items.length > 0 && (
            <table className="ai-table" style={{ width: '100%' }} data-testid="library-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Latest</th>
                  <th>Used by</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((it: LibraryRow) => (
                  <tr
                    key={it.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setOpen(it.id)}
                    data-testid={`library-row-${it.name}`}
                  >
                    <td style={{ fontWeight: 700 }}>
                      {it.name}
                      <div className="ai-muted" style={{ fontWeight: 400 }}>
                        {it.description}
                      </div>
                    </td>
                    <td>{it.typeLabel}</td>
                    <td>v{it.version}</td>
                    <td>
                      {it.usedBy} member{it.usedBy === 1 ? '' : 's'}
                    </td>
                    <td>
                      {it.behind ? <Chip tone="warn">{it.behind} behind</Chip> : <Chip tone="synced">All current</Chip>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="ai-hint">
            Antigravity members get library items as Documented steps, so “behind” there means the tick is stale.
          </div>
        </>
      )}
      {creating && (
        <NewItemDialog
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={(i) => {
            setCreating(false);
            setOpen(i.id);
          }}
        />
      )}
    </Dialog>
  );
}

/** Choose library items to attach to the draft configuration. */
export function LibraryPicker({
  projectId,
  types,
  multiple,
  attached,
  onClose,
  onPick,
}: {
  projectId: string;
  types: LibraryType[];
  multiple: boolean;
  attached: Set<string>;
  onClose: () => void;
  onPick: (ids: string[]) => Promise<void>;
}) {
  const list = useLibrary(projectId);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = useMemo(
    () =>
      (list.data?.items ?? []).filter(
        (i) => types.includes(i.type) && `${i.name} ${i.description}`.toLowerCase().includes(q.toLowerCase()),
      ),
    [list.data, types, q],
  );
  return (
    <Dialog
      title="Attach from library"
      width={560}
      onClose={onClose}
      testId="library-picker"
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!picked.length || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onPick(picked);
                onClose();
              } catch (e) {
                setError(extractError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Attach {picked.length || ''}
          </button>
        </>
      }
    >
      <input
        className="ai-input"
        placeholder="Search library"
        aria-label="Search library"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {items.length === 0 && (
        <div className="ai-muted">
          {list.isLoading ? 'Loading…' : 'Nothing in the library matches. Create items in Settings → AI → Library.'}
        </div>
      )}
      {items.map((it) => (
        <label
          key={it.id}
          className="cfg-row"
          style={{ cursor: attached.has(it.id) ? 'default' : 'pointer', opacity: attached.has(it.id) ? 0.5 : 1 }}
        >
          <input
            type={multiple ? 'checkbox' : 'radio'}
            name="lib-pick"
            disabled={attached.has(it.id)}
            checked={picked.includes(it.id)}
            onChange={(e) =>
              setPicked(
                multiple ? (e.target.checked ? [...picked, it.id] : picked.filter((x) => x !== it.id)) : [it.id],
              )
            }
          />
          <span className="cfg-row-main">
            <span className="cfg-row-title">{it.name}</span>
            <span className="ai-muted">{it.description}</span>
          </span>
          <Chip tone="lib">{attached.has(it.id) ? 'Attached' : `${it.typeLabel} · v${it.version}`}</Chip>
        </label>
      ))}
      {error && <div className="ai-error-text">{error}</div>}
    </Dialog>
  );
}
