import { useRef, useState } from 'react';
import { extractError } from '../../../api/extractError';
import { Toggle } from '../aiUi';
import type { AiSkill } from '../../../types/ai';
import { configApi, useLibrary, type LibraryRow } from './configApi';
import { useCfg } from './configCtx';
import { CfgCard, Chip, CodeEditor, DiffView, Dialog, EmptyState, IssueText, TickRow, newId } from './parts';
import { frontMatter, skillTemplate } from './frontMatter';
import { useQuery } from '@tanstack/react-query';

const MAX_FOLDER = 2 * 1024 * 1024;
const SCRIPT = /\.(sh|bash|zsh|py|js|mjs|ts|rb|pl|ps1|bat)$/i;

type Tab = 'library' | 'write' | 'import';

/** “Add skill”: attach from the library, write a SKILL.md, or import a folder (design B10). */
function AddSkillModal({ editing, onClose }: { editing?: AiSkill; onClose: () => void }) {
  const { member, cfg, setCfg, replaceConfig } = useCfg();
  const [tab, setTab] = useState<Tab>(editing ? 'write' : 'library');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // library tab
  const [q, setQ] = useState('');
  const lib = useLibrary(member.projectId, 'skill', q);
  const attached = new Set(cfg.skills.map((s) => s.library?.id).filter(Boolean));
  const [picked, setPicked] = useState<string[]>([]);
  // write tab
  const [text, setText] = useState(editing?.content ?? skillTemplate());
  const [saveToLib, setSaveToLib] = useState(false);
  const [documented, setDocumented] = useState(editing?.mode === 'documented');
  const fm = frontMatter(text).fields;
  // import tab
  const [folder, setFolder] = useState<{
    name: string;
    skill: string;
    files: { path: string; content: string }[];
    size: number;
  } | null>(null);

  async function attachPicked() {
    setBusy(true);
    setError(null);
    try {
      let next = cfg;
      for (const id of picked) next = (await configApi.libraryEdit(member.id, 'attach', id, next)).config;
      replaceConfig(next);
      onClose();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveWritten() {
    setBusy(true);
    setError(null);
    try {
      const name = fm.name?.trim();
      if (!name) throw new Error('The front matter needs a name: line.');
      let library = editing?.library ?? null;
      if (saveToLib && !editing) {
        const item = await configApi.libraryCreate(member.projectId, {
          type: 'skill',
          name,
          description: fm.description ?? '',
          content: text,
        });
        library = { id: item.id, version: item.version };
      }
      const mode: AiSkill['mode'] = documented ? 'documented' : 'synced';
      if (editing) {
        setCfg({
          skills: cfg.skills.map((s) =>
            s.id === editing.id ? { ...s, content: text, name, description: fm.description ?? '', mode } : s,
          ),
        });
      } else {
        if (cfg.skills.some((s) => s.name === name))
          throw new Error(`This member already has a skill called “${name}”.`);
        setCfg({
          skills: [
            ...cfg.skills,
            {
              id: newId(),
              name,
              description: fm.description ?? '',
              content: text,
              files: [],
              enabled: true,
              mode,
              library,
            },
          ],
        });
      }
      onClose();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  }

  async function readFiles(files: { path: string; file: File }[]) {
    setError(null);
    const root = files.map((f) => f.path.split('/')[0])[0] ?? 'skill';
    const rel = files.map((f) => ({ ...f, rel: f.path.split('/').slice(1).join('/') || f.path }));
    const skillFile = rel.find((f) => f.rel === 'SKILL.md');
    if (!skillFile) {
      setFolder(null);
      setError('This folder has no SKILL.md at its top level.');
      return;
    }
    const size = rel.reduce((n, f) => n + f.file.size, 0);
    if (size > MAX_FOLDER) {
      setFolder(null);
      setError('A skill folder can hold 2 MB at most.');
      return;
    }
    const others: { path: string; content: string }[] = [];
    for (const f of rel) {
      if (f.rel === 'SKILL.md') continue;
      if (f.rel.split('/').some((p) => p.startsWith('.git'))) continue;
      const content = await f.file.text();
      if (content.includes('\u0000')) continue; // binary files are left out
      others.push({ path: f.rel, content });
    }
    setFolder({ name: root, skill: await skillFile.file.text(), files: others, size });
  }

  async function importFolder() {
    if (!folder) return;
    const name = frontMatter(folder.skill).fields.name || folder.name;
    if (cfg.skills.some((s) => s.name === name)) {
      setError(`This member already has a skill called “${name}”.`);
      return;
    }
    setCfg({
      skills: [
        ...cfg.skills,
        {
          id: newId(),
          name,
          description: frontMatter(folder.skill).fields.description ?? '',
          content: folder.skill,
          files: folder.files,
          enabled: true,
          mode: 'synced',
          library: null,
        },
      ],
    });
    onClose();
  }

  async function drop(e: React.DragEvent) {
    e.preventDefault();
    const out: { path: string; file: File }[] = [];
    const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
        out.push({ path: `${prefix}${entry.name}`, file });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const kids = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        for (const k of kids) await walk(k, `${prefix}${entry.name}/`);
      }
    };
    for (const item of Array.from(e.dataTransfer.items)) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) await walk(entry, '');
    }
    if (out.length) await readFiles(out);
  }

  const scripts = folder?.files.filter((f) => SCRIPT.test(f.path)) ?? [];
  const refs = (folder?.files.length ?? 0) - scripts.length;
  const foot =
    tab === 'library' ? (
      <>
        <span style={{ flex: 1 }} />
        <button type="button" className="ai-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-primary"
          disabled={!picked.length || busy}
          onClick={() => void attachPicked()}
        >
          {picked.length === 1 ? 'Attach 1 skill' : `Attach ${picked.length} skills`}
        </button>
      </>
    ) : tab === 'write' ? (
      <>
        <span style={{ flex: 1 }} />
        <button type="button" className="ai-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="ai-btn ai-btn-primary" disabled={busy} onClick={() => void saveWritten()}>
          {editing ? 'Save skill' : 'Add skill'}
        </button>
      </>
    ) : (
      <>
        <span style={{ flex: 1 }} />
        <button type="button" className="ai-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="ai-btn ai-btn-primary" disabled={!folder} onClick={() => void importFolder()}>
          Import
        </button>
      </>
    );
  return (
    <Dialog
      title={editing ? `Edit skill · ${editing.name}` : 'Add skill'}
      width={620}
      onClose={onClose}
      foot={foot}
      testId="add-skill-modal"
    >
      {!editing && (
        <div className="ai-seg" role="tablist">
          {(
            [
              ['library', 'From library'],
              ['write', 'Write SKILL.md'],
              ['import', 'Import folder'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="tab" className={tab === k ? 'ai-seg-on' : ''} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {tab === 'library' && (
        <>
          <input
            className="ai-input"
            placeholder="Search library skills"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {(lib.data?.items ?? []).length === 0 && (
            <div className="ai-muted">
              No skills in the library{q ? ' match' : ' yet'}. Write one, or create it in Settings → AI → Library.
            </div>
          )}
          {(lib.data?.items ?? []).map((it: LibraryRow) => (
            <label
              key={it.id}
              className="cfg-row"
              style={{ cursor: attached.has(it.id) ? 'default' : 'pointer', opacity: attached.has(it.id) ? 0.5 : 1 }}
            >
              <input
                type="checkbox"
                disabled={attached.has(it.id)}
                checked={picked.includes(it.id)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, it.id] : picked.filter((x) => x !== it.id))}
              />
              <span className="cfg-row-main">
                <span className="cfg-row-title">{it.name}</span>
                <span className="ai-muted">{it.description}</span>
              </span>
              <Chip tone="lib">{attached.has(it.id) ? 'Attached' : `Library · v${it.version}`}</Chip>
            </label>
          ))}
        </>
      )}
      {tab === 'write' && (
        <>
          <div className="ai-field">
            <span className="ai-mono" style={{ fontSize: 12, fontWeight: 700 }}>
              SKILL.md
            </span>
            <CodeEditor testId="skill-editor" ariaLabel="SKILL.md" rows={10} value={text} onChange={setText} />
          </div>
          {!editing && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
              <input type="checkbox" checked={saveToLib} onChange={(e) => setSaveToLib(e.target.checked)} />
              Also save to the board library as <b className="ai-mono">{fm.name || 'name'}</b> (v1)
            </label>
          )}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
            <input type="checkbox" checked={documented} onChange={(e) => setDocumented(e.target.checked)} />
            Documented only: I set it up by hand (nothing is written)
          </label>
        </>
      )}
      {tab === 'import' && (
        <>
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => void drop(e)}
            style={{
              border: '1px dashed #c7d2cb',
              borderRadius: 10,
              padding: 22,
              textAlign: 'center',
              cursor: 'pointer',
              display: 'block',
            }}
          >
            <b style={{ fontSize: 13 }}>Choose a skill folder</b>
            <div className="ai-muted">or drop it here · must contain SKILL.md</div>
            <input
              type="file"
              data-testid="skill-folder-input"
              style={{ display: 'none' }}
              // @ts-expect-error webkitdirectory is not in the DOM typings
              webkitdirectory=""
              multiple
              onChange={(e) =>
                void readFiles(
                  Array.from(e.target.files ?? []).map((f) => ({
                    path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
                    file: f,
                  })),
                )
              }
            />
          </label>
          {folder && (
            <div className="ai-notice ai-notice-info" data-testid="skill-folder-found">
              <div>
                <b>Found: {folder.name}/</b> SKILL.md, {refs} reference file{refs === 1 ? '' : 's'} and {scripts.length}{' '}
                script{scripts.length === 1 ? '' : 's'}
                {scripts.length ? ` (${scripts.map((s) => s.path).join(', ')})` : ''}. Scripts run on your computer when
                the skill runs. The folder is stored as is, up to 2 MB.
              </div>
            </div>
          )}
        </>
      )}
      {error && <div className="ai-error-text">{error}</div>}
    </Dialog>
  );
}

/** Review changes between the pinned version and the latest. */
function ReviewDialog({
  itemId,
  from,
  name,
  onClose,
}: {
  itemId: string;
  from: number;
  name: string;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ['ai', 'library-diff', itemId, from],
    queryFn: () => configApi.libraryDiff(itemId, from),
  });
  return (
    <Dialog
      title={`${name}: v${from} → v${q.data?.toVersion ?? '…'}`}
      width={640}
      onClose={onClose}
      foot={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {q.isLoading ? <div className="ai-skel" style={{ height: 120 }} /> : <DiffView rows={q.data?.changes ?? []} />}
    </Dialog>
  );
}

/** Skills of a Claude Code member (SKILL.md folders, design B2). */
export function SkillsCard() {
  const { member, cfg, setCfg, replaceConfig, issues, status, tick, pickLibrary } = useCfg();
  const lib = useLibrary(member.projectId, 'skill');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AiSkill | null>(null);
  const [review, setReview] = useState<AiSkill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = new Map((lib.data?.items ?? []).map((i) => [i.id, i]));
  const synced = cfg.skills.filter((s) => s.mode === 'synced').length;
  const wrap = useRef<HTMLDivElement>(null);
  const update = async (s: AiSkill) => {
    if (!s.library) return;
    setError(null);
    try {
      replaceConfig((await configApi.libraryEdit(member.id, 'update', s.library.id, cfg)).config);
    } catch (e) {
      setError(extractError(e));
    }
  };
  return (
    <CfgCard
      id="cfg-skills"
      testId="card-skills"
      title="Skills"
      mode="synced"
      sub={`${cfg.skills.length} skill${cfg.skills.length === 1 ? '' : 's'} · ${synced} Synced into .claude/skills/, ${cfg.skills.length - synced} Documented`}
      right={
        <>
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => pickLibrary(['skill'], true)}>
            Attach from library
          </button>
          <button type="button" className="ai-btn ai-btn-sm" data-testid="add-skill" onClick={() => setAdding(true)}>
            Add skill
          </button>
        </>
      }
    >
      <div ref={wrap}>
        {cfg.skills.length === 0 && (
          <EmptyState
            title="No skills yet"
            text="Add one, or attach from the library."
            action="Add skill"
            onAction={() => setAdding(true)}
          />
        )}
        {cfg.skills.map((s, i) => {
          const item = s.library ? latest.get(s.library.id) : undefined;
          const behind = !!(s.library && item && item.version > s.library.version);
          const doc = status?.documented.find((d) => d.key === `skill:${s.id}`);
          return (
            <div key={s.id} data-testid={`skill-${s.name}`}>
              <div className="cfg-row">
                <div className="cfg-row-main">
                  <div className="cfg-row-title">
                    <span className="ai-mono">{s.name || 'unnamed'}</span>
                    {s.library ? (
                      <Chip tone={behind ? 'warn' : 'lib'}>
                        Library · v{s.library.version}
                        {behind ? ' · behind' : ''}
                      </Chip>
                    ) : (
                      <Chip>This member only</Chip>
                    )}
                    <Chip tone={s.mode === 'synced' ? 'synced' : 'warn'}>
                      {s.mode === 'synced' ? 'Synced' : 'Documented'}
                    </Chip>
                    {s.files.length > 0 && (
                      <Chip>
                        {s.files.length} file{s.files.length === 1 ? '' : 's'}
                      </Chip>
                    )}
                  </div>
                  <div className="ai-muted cfg-ellipsis">{s.description || 'No description'}</div>
                </div>
                {s.mode === 'synced' && (
                  <Toggle
                    on={s.enabled}
                    label={`${s.name} on`}
                    onChange={(v) =>
                      setCfg({ skills: cfg.skills.map((x) => (x.id === s.id ? { ...x, enabled: v } : x)) })
                    }
                  />
                )}
                <button type="button" className="ai-btn ai-btn-sm" onClick={() => setEditing(s)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="ai-icobtn"
                  aria-label={`Remove ${s.name}`}
                  onClick={() => setCfg({ skills: cfg.skills.filter((x) => x.id !== s.id) })}
                >
                  ✕
                </button>
              </div>
              <IssueText issues={issues} path={`skills.${i}`} prefix />
              {s.mode === 'documented' && doc && (
                <div style={{ marginBottom: 8 }}>
                  <TickRow item={doc} onTick={(d) => void tick(doc.key, d)} />
                </div>
              )}
              {behind && s.library && (
                <div
                  className="ai-notice ai-notice-warn"
                  style={{ alignItems: 'center', marginBottom: 8 }}
                  data-testid="skill-update-banner"
                >
                  <span style={{ flex: 1 }}>
                    <b>
                      “{s.name}” has v{item!.version} in the library.
                    </b>{' '}
                    Updates never apply on their own.
                  </span>
                  <button type="button" className="ai-btn ai-btn-sm" onClick={() => setReview(s)}>
                    Review changes
                  </button>
                  <button type="button" className="ai-btn ai-btn-sm ai-btn-primary" onClick={() => void update(s)}>
                    Update to v{item!.version}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {error && <div className="ai-error-text">{error}</div>}
      </div>
      {adding && <AddSkillModal onClose={() => setAdding(false)} />}
      {editing && <AddSkillModal editing={editing} onClose={() => setEditing(null)} />}
      {review?.library && (
        <ReviewDialog
          itemId={review.library.id}
          from={review.library.version}
          name={review.name}
          onClose={() => setReview(null)}
        />
      )}
    </CfgCard>
  );
}
