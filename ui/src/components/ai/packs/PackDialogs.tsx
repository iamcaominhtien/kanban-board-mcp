import { useState, type ReactNode } from 'react';
import { useAiWindows } from '../../../api/aiWindows';
import { useImportPack, useMakeMember, useSavePack } from '../../../api/aiPacks';
import { extractError } from '../../../api/extractError';
import type { Pack, PackDraft, PackExport, PackImportResult, PackModel, PackWrites } from '../../../types/aiPacks';
import { CEILINGS, EFFORTS, MODELS, WRITES, WRITES_LABEL, cap } from './packLabels';
import './packs.css';

/** A modal in the look of the other AI dialogs. */
export function Dialog({
  title,
  onClose,
  children,
  foot,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  foot: ReactNode;
}) {
  return (
    <div className="ai-overlay" onClick={onClose} role="presentation">
      <div className="ai-modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">{title}</h2>
        </div>
        <div className="ai-modal-body">{children}</div>
        <div className="ai-modal-foot">{foot}</div>
      </div>
    </div>
  );
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const list = (s: string) =>
  s
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

/** Edit a pack. Saving a ready-made one makes the project's own copy; every save is a new version. */
export function EditPackModal({
  projectId,
  pack,
  onClose,
  onSaved,
}: {
  projectId: string;
  pack: Pack;
  onClose: () => void;
  onSaved: (p: Pack) => void;
}) {
  const save = useSavePack(projectId);
  const [f, setF] = useState({
    name: pack.name,
    tagline: pack.tagline,
    model: pack.model as PackModel,
    retryModel: (pack.retryModel ?? '') as string,
    effort: pack.effort,
    ceiling: pack.ceiling,
    writes: pack.writes as PackWrites,
    handsIn: pack.handsIn,
    persona: pack.persona,
    allow: pack.allow.join('\n'),
    plugins: pack.plugins.join(', '),
    mcp: pack.mcp.join(', '),
    maxParallel: String(pack.limits.maxParallel),
    maxRunsPerDay: String(pack.limits.maxRunsPerDay),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((o) => ({ ...o, [k]: v }));
  const limitsOk = Number(f.maxParallel) >= 1 && Number(f.maxRunsPerDay) >= 1;
  const valid = f.name.trim() !== '' && limitsOk;

  const submit = () => {
    const body: PackDraft = {
      name: f.name.trim(),
      tagline: f.tagline,
      model: f.model,
      retryModel: (f.retryModel || null) as PackModel | null,
      effort: f.effort,
      template: pack.template,
      ceiling: f.ceiling,
      writes: f.writes,
      handsIn: f.handsIn,
      persona: f.persona,
      allow: lines(f.allow),
      plugins: list(f.plugins),
      mcp: list(f.mcp),
      limits: { maxParallel: Number(f.maxParallel), maxRunsPerDay: Number(f.maxRunsPerDay) },
      depthModels: pack.depthModels ?? null,
      personas: pack.personas ?? null,
      glyph: pack.glyph,
    };
    save.mutate({ key: pack.key, body }, { onSuccess: onSaved });
  };

  return (
    <Dialog
      title={`Edit ${pack.name}`}
      onClose={onClose}
      foot={
        <>
          <button className="ai-btn ai-btn-primary" disabled={!valid || save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : pack.builtin ? 'Save as the project’s copy' : 'Save new version'}
          </button>
          <button className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          {save.error && (
            <span className="ai-error-text" role="alert">
              {extractError(save.error)}
            </span>
          )}
        </>
      }
    >
      {pack.builtin && (
        <div className="ai-notice ai-notice-info">
          This is a ready-made pack. Saving makes this project’s own copy and leaves the ready-made one as it is.
        </div>
      )}
      <div className="pk-form">
        <div className="pk-two">
          <label>
            Name <input className="ai-input" value={f.name} onChange={(e) => set('name', e.target.value)} />
          </label>
          <label>
            Tagline <input className="ai-input" value={f.tagline} onChange={(e) => set('tagline', e.target.value)} />
          </label>
        </div>
        <div className="pk-two">
          <label>
            Model{' '}
            <select className="ai-select" value={f.model} onChange={(e) => set('model', e.target.value as PackModel)}>
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {cap(m)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Effort{' '}
            <select className="ai-select" value={f.effort} onChange={(e) => set('effort', e.target.value)}>
              {[...new Set([...EFFORTS, f.effort])].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Model on a second attempt at the same step{' '}
          <select className="ai-select" value={f.retryModel} onChange={(e) => set('retryModel', e.target.value)}>
            <option value="">Same model</option>
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {cap(m)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Who it is (persona){' '}
          <textarea className="ai-textarea" value={f.persona} onChange={(e) => set('persona', e.target.value)} />
        </label>
        <div className="pk-two">
          <label>
            Ceiling (furthest status it may move a ticket to){' '}
            <select className="ai-select" value={f.ceiling} onChange={(e) => set('ceiling', e.target.value)}>
              {[...new Set([...CEILINGS, f.ceiling])].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            Where it may write{' '}
            <select
              className="ai-select"
              value={f.writes}
              onChange={(e) => set('writes', e.target.value as PackWrites)}
            >
              {WRITES.map((m) => (
                <option key={m} value={m}>
                  {WRITES_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          What it must hand in{' '}
          <textarea className="ai-textarea" value={f.handsIn} onChange={(e) => set('handsIn', e.target.value)} />
        </label>
        <label>
          Allowed commands (one rule per line){' '}
          <textarea className="ai-textarea pk-cmd" value={f.allow} onChange={(e) => set('allow', e.target.value)} />
        </label>
        <div className="pk-two">
          <label>
            Plugins (comma separated){' '}
            <input className="ai-input" value={f.plugins} onChange={(e) => set('plugins', e.target.value)} />
          </label>
          <label>
            MCP servers (comma separated){' '}
            <input className="ai-input" value={f.mcp} onChange={(e) => set('mcp', e.target.value)} />
          </label>
        </div>
        <div className="pk-two">
          <label>
            Runs at a time{' '}
            <input
              className="ai-input"
              type="number"
              min={1}
              value={f.maxParallel}
              onChange={(e) => set('maxParallel', e.target.value)}
            />
          </label>
          <label>
            Runs a day{' '}
            <input
              className="ai-input"
              type="number"
              min={1}
              value={f.maxRunsPerDay}
              onChange={(e) => set('maxRunsPerDay', e.target.value)}
            />
          </label>
        </div>
        {!limitsOk && <span className="ai-error-text">Limits must be at least 1.</span>}
      </div>
    </Dialog>
  );
}

/** Import a pack from an exported file; says which plugins this project does not have. */
export function ImportPackModal({
  projectId,
  onClose,
  onDone,
}: {
  projectId: string;
  onClose: () => void;
  onDone: (r: PackImportResult) => void;
}) {
  const imp = useImportPack(projectId);
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<PackImportResult | null>(null);

  const load = async (file: File | undefined) => {
    if (file) setText(await file.text());
  };
  const submit = () => {
    let parsed: PackExport;
    try {
      parsed = JSON.parse(text) as PackExport;
    } catch {
      setParseError('This is not JSON. Paste a file made by Export.');
      return;
    }
    if (parsed?.format !== 'kanban-role-pack/1') {
      setParseError('This is not a role pack file (expected format kanban-role-pack/1).');
      return;
    }
    setParseError(null);
    imp.mutate(parsed, { onSuccess: setResult });
  };

  return (
    <Dialog
      title="Import a role pack"
      onClose={onClose}
      foot={
        result ? (
          <button className="ai-btn ai-btn-primary" onClick={() => onDone(result)}>
            Done
          </button>
        ) : (
          <>
            <button className="ai-btn ai-btn-primary" disabled={!text.trim() || imp.isPending} onClick={submit}>
              {imp.isPending ? 'Importing…' : 'Import'}
            </button>
            <button className="ai-btn" onClick={onClose}>
              Cancel
            </button>
          </>
        )
      }
    >
      {result ? (
        <>
          <div className="ai-notice ai-notice-info" data-testid="import-result">
            Imported {result.pack.name} (version {result.pack.version}).
          </div>
          {result.missing.length > 0 ? (
            <div className="ai-notice ai-notice-warn" data-testid="import-missing">
              Could not find on this project: {result.missing.join(', ')}. Install them in Skills & plugins, or the pack
              runs without them.
            </div>
          ) : (
            <div className="ai-ok-text">Everything the pack uses is on this project.</div>
          )}
        </>
      ) : (
        <>
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Pack file"
            onChange={(e) => void load(e.target.files?.[0])}
          />
          <textarea
            className="ai-textarea pk-cmd"
            aria-label="Pack JSON"
            placeholder='{"format": "kanban-role-pack/1", …}'
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ minHeight: 160 }}
          />
          {(parseError || imp.error) && (
            <span className="ai-error-text" role="alert">
              {parseError ?? extractError(imp.error)}
            </span>
          )}
        </>
      )}
    </Dialog>
  );
}

const PERSONAS = ['in a hurry', 'first time here', 'keyboard only', 'on a phone'];

/** Make a member from a pack: a name, a folder, the account it runs as and, for the User tester, who it plays. */
export function MakeMemberModal({
  projectId,
  pack,
  onClose,
  onDone,
}: {
  projectId: string;
  pack: Pack;
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const make = useMakeMember(projectId);
  const windows = useAiWindows();
  const [name, setName] = useState(pack.name);
  const [dir, setDir] = useState('');
  const [account, setAccount] = useState('local');
  const [plays, setPlays] = useState(pack.personas?.[0] ?? PERSONAS[0]);
  const isTester = pack.key === 'user_tester' || !!pack.personas;
  const personas = pack.personas?.length ? pack.personas : PERSONAS;

  const submit = () =>
    make.mutate(
      {
        key: pack.key,
        body: {
          name: name.trim(),
          workingDir: dir.trim() || undefined,
          accountId: account === 'local' ? null : account,
          plays: isTester ? plays : undefined,
        },
      },
      { onSuccess: (m) => onDone(m.name ?? name) },
    );

  return (
    <Dialog
      title={`Make a member from ${pack.name}`}
      onClose={onClose}
      foot={
        <>
          <button className="ai-btn ai-btn-primary" disabled={!name.trim() || make.isPending} onClick={submit}>
            {make.isPending ? 'Creating…' : 'Make member'}
          </button>
          <button className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          {make.error && (
            <span className="ai-error-text" role="alert">
              {extractError(make.error)}
            </span>
          )}
        </>
      }
    >
      <div className="pk-form">
        <label>
          Name <input className="ai-input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Working folder (optional){' '}
          <input
            className="ai-input pk-cmd"
            placeholder="/path/to/the/repository"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
          />
        </label>
        <label>
          Runs as{' '}
          <select className="ai-select" value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="local">This computer’s own Claude login</option>
            {(windows.data?.accounts ?? [])
              .filter((a) => a.key !== 'local')
              .map((a) => (
                <option key={a.key} value={a.key}>
                  {a.name}
                  {a.email ? ` · ${a.email}` : ''}
                </option>
              ))}
          </select>
        </label>
        {isTester && (
          <label>
            Plays{' '}
            <input className="ai-input" list="pk-personas" value={plays} onChange={(e) => setPlays(e.target.value)} />
            <datalist id="pk-personas">
              {personas.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </label>
        )}
      </div>
    </Dialog>
  );
}
