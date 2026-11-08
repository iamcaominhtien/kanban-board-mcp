import { useMemo, useState } from 'react';
import { aiPacksApi, usePackMutation } from '../../../api/aiPacks';
import { extractError } from '../../../api/extractError';
import { useCatalogue, useBoardSkills, usePlugins } from '../../../api/aiPlugins';
import { useProjectOps } from '../../../api/aiProjectOps';
import type { RolePack } from '../../../types/aiPacks';
import { LineIcon } from '../../ui/LineIcon';
import { useToast } from '../../Toast';
import { boardSkillOn } from '../tools/boardSkillLogic';
import { PackGlyph, PackStateChip } from './PackList';
import {
  bodyOf,
  draftOf,
  EFFORTS,
  MODELS,
  READY_MADE_KEYS,
  sameDraft,
  savedBy,
  validate,
  WRITES,
  dayOf,
  type Draft,
} from './packLogic';

/** A list of names (plugins or MCP servers) as chips, and a way to add one. */
function NameList({
  label,
  names,
  options,
  missing,
  addLabel,
  none,
  onChange,
}: {
  label: string;
  names: string[];
  options: string[];
  /** Names the project does not have yet (shown dashed). */
  missing?: string[];
  addLabel: string;
  none?: string;
  onChange: (next: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const listId = `rp-opts-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const add = () => {
    const v = text.trim();
    if (v && !names.includes(v)) onChange([...names, v]);
    setText('');
    setAdding(false);
  };
  return (
    <div className="rp-chips">
      {names.length === 0 && !adding && none && <span className="ai-hint">{none}</span>}
      {names.map((n) => (
        <span
          key={n}
          className={`rp-tool ${missing?.includes(n) ? 'rp-tool-missing' : ''}`}
          title={missing?.includes(n) ? 'Not on this project yet' : undefined}
        >
          {n}
          <button type="button" aria-label={`Remove ${n}`} onClick={() => onChange(names.filter((x) => x !== n))}>
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <span className="rp-add-line">
          <input
            className="ai-input"
            autoFocus
            list={listId}
            aria-label={addLabel}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              } else if (e.key === 'Escape') {
                setText('');
                setAdding(false);
              }
            }}
          />
          <datalist id={listId}>
            {options
              .filter((o) => !names.includes(o))
              .map((o) => (
                <option key={o} value={o} />
              ))}
          </datalist>
          <button type="button" className="ai-btn ai-btn-sm" onClick={add}>
            Add
          </button>
        </span>
      ) : (
        <button type="button" className="rp-add" onClick={() => setAdding(true)}>
          <LineIcon name="plus" size={12} />
          {addLabel}
        </button>
      )}
    </div>
  );
}

/** The model of a role: one of the three, or any other full model id. */
function ModelPicker({ value, error, onChange }: { value: string; error?: string; onChange: (v: string) => void }) {
  const known = (MODELS as readonly string[]).includes(value);
  const [other, setOther] = useState(!known && value !== '');
  return (
    <>
      <div className="rp-chips" role="radiogroup" aria-label="Model">
        {MODELS.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={value === m}
            className={`tw-chipbtn ${value === m ? 'tw-chipbtn-on' : ''}`}
            onClick={() => {
              setOther(false);
              onChange(m);
            }}
          >
            {m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={other || (!known && value !== '')}
          className={`tw-chipbtn ${other || (!known && value !== '') ? 'tw-chipbtn-on' : ''}`}
          onClick={() => {
            setOther(true);
            if (known) onChange('');
          }}
        >
          Other…
        </button>
      </div>
      {(other || (!known && value !== '')) && (
        <input
          className={`ai-input ai-mono ${error ? 'ai-input-error' : ''}`}
          aria-label="Model id"
          aria-invalid={!!error}
          placeholder="A full model id"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {error && <div className="rp-err">{error}</div>}
    </>
  );
}

/** Edit one role: who it is, its model, what it writes and hands in, its plugins and limits. */
export function PackEditor({
  projectId,
  pack,
  onBack,
  onExport,
  onReset,
  onRemove,
}: {
  projectId: string;
  pack: RolePack;
  onBack: () => void;
  onExport: (p: RolePack) => void;
  onReset: (p: RolePack) => void;
  onRemove: (p: RolePack) => void;
}) {
  const toast = useToast();
  const initial = useMemo(() => draftOf(pack), [pack]);
  const [d, setD] = useState<Draft>(initial);
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const save = usePackMutation(projectId, (body: ReturnType<typeof bodyOf>) =>
    aiPacksApi.save(projectId, pack.key, body),
  );

  const plugins = usePlugins(projectId);
  const catalogue = useCatalogue();
  const boardSkills = useBoardSkills();
  const ops = useProjectOps(projectId);
  const installed = useMemo(() => (plugins.data ?? []).map((p) => p.name), [plugins.data]);
  const pluginOptions = useMemo(
    () =>
      Array.from(
        new Set([...installed, ...(catalogue.data ?? []).filter((c) => c.kind === 'plugin').map((c) => c.key)]),
      ),
    [installed, catalogue.data],
  );
  const mcpOptions = useMemo(
    () => Array.from(new Set((catalogue.data ?? []).filter((c) => c.kind === 'mcp').map((c) => c.key))),
    [catalogue.data],
  );
  const missingPlugins = plugins.data ? d.plugins.filter((p) => !installed.includes(p)) : [];
  const skills = (boardSkills.data ?? []).filter((s) => !s.role || s.role === pack.key);

  const errors = validate(d);
  const shown = tried ? errors : {};
  const dirty = !sameDraft(d, initial);
  const ready = READY_MADE_KEYS.includes(pack.key);
  const nextVersion = pack.builtin ? 1 : pack.version + 1;
  // a refusal of the server is put under the field it names
  const serverFor = (field: string) => (serverError && serverError.toLowerCase().includes(field) ? serverError : null);
  const submit = async () => {
    setTried(true);
    setServerError(null);
    if (Object.keys(errors).length) return;
    try {
      const saved = await save.mutateAsync(bodyOf(d, pack));
      toast.success(
        `${saved.name} saved`,
        `Version ${saved.version}.${ready ? ' The ready-made one is untouched.' : ''}`,
      );
    } catch (e) {
      setServerError(extractError(e));
    }
  };
  const edited = !pack.builtin;

  return (
    <div className="rp-editor" data-testid="pack-editor">
      <div className="rp-ed-head">
        <PackGlyph pack={{ key: pack.key, glyph: d.glyph }} large />
        <div className="rp-ed-title">
          <button type="button" className="rp-crumb" onClick={onBack} data-testid="pack-back">
            Role packs ›
          </button>
          <h3 className="rp-ed-name">{pack.name}</h3>
        </div>
        <PackStateChip pack={pack} />
        <div className="rp-ed-actions">
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => onExport(pack)} data-testid="pack-export">
            <LineIcon name="download" size={13} />
            Export
          </button>
        </div>
      </div>

      {serverError && !['name', 'model', 'effort'].some((f) => serverFor(f)) && (
        <div className="ai-notice ai-notice-error" role="alert">
          {serverError}
        </div>
      )}

      <div className="rp-cols">
        <div className="rp-col">
          <div className="rp-name-row">
            <label className="rp-field">
              <span className="ai-label">Name</span>
              <input
                className={`ai-input ${shown.name || serverFor('name') ? 'ai-input-error' : ''}`}
                aria-label="Name"
                aria-invalid={!!(shown.name || serverFor('name'))}
                value={d.name}
                onChange={(e) => set('name', e.target.value)}
                data-testid="pack-name"
              />
              {(shown.name || serverFor('name')) && <span className="rp-err">{shown.name || serverFor('name')}</span>}
            </label>
            <label className="rp-field">
              <span className="ai-label">Glyph</span>
              <input
                className="ai-input ai-mono"
                aria-label="Glyph"
                maxLength={3}
                value={d.glyph}
                onChange={(e) => set('glyph', e.target.value.toUpperCase())}
              />
            </label>
            <label className="rp-field">
              <span className="ai-label">Tagline</span>
              <input
                className="ai-input"
                aria-label="Tagline"
                value={d.tagline}
                onChange={(e) => set('tagline', e.target.value)}
              />
            </label>
          </div>

          <label className="rp-field">
            <span className="ai-label">Persona</span>
            <textarea
              className="ai-textarea rp-persona"
              aria-label="Persona"
              value={d.persona}
              onChange={(e) => set('persona', e.target.value)}
              data-testid="pack-persona"
            />
            <span className="ai-hint">
              Who the role is and how it works. Every team with this role starts from it; a team can change it for
              itself on its page.
            </span>
          </label>

          <label className="rp-field">
            <span className="ai-label">Hands in</span>
            <input
              className="ai-input"
              aria-label="Hands in"
              value={d.handsIn}
              onChange={(e) => set('handsIn', e.target.value)}
            />
            <span className="ai-hint">What the lead asks of this role before it counts as done.</span>
          </label>

          <div className="rp-field">
            <span className="ai-label">Versions</span>
            <div className="rp-versions" data-testid="pack-versions">
              {edited && (
                <div className="rp-version rp-version-now">
                  <b>v{pack.version}</b>
                  <span>{savedBy(pack)}</span>
                  <span className="rp-cur">Current</span>
                </div>
              )}
              {ready && (
                <div className={`rp-version ${pack.builtin ? 'rp-version-now' : ''}`}>
                  <b>{pack.builtin ? `v${pack.version}` : ''}</b>
                  <span>{pack.builtin ? `Ready-made, version ${pack.version}` : 'Ready-made'}</span>
                  {pack.builtin && <span className="rp-cur">Current</span>}
                </div>
              )}
            </div>
            <span className="ai-hint">The last 20 versions are kept.</span>
          </div>
        </div>

        <div className="rp-col">
          <div className="rp-field">
            <span className="ai-label">Model</span>
            <ModelPicker
              value={d.model}
              error={shown.model || serverFor('model') || undefined}
              onChange={(v) => set('model', v)}
            />
          </div>

          <div className="rp-field">
            <span className="ai-label">Effort</span>
            <div className="rp-chips" role="radiogroup" aria-label="Effort">
              {EFFORTS.map((x) => (
                <button
                  key={x}
                  type="button"
                  role="radio"
                  aria-checked={d.effort === x}
                  className={`tw-chipbtn ${d.effort === x ? 'tw-chipbtn-on' : ''}`}
                  onClick={() => set('effort', x)}
                >
                  {x}
                </button>
              ))}
            </div>
            {d.effort && !(EFFORTS as readonly string[]).includes(d.effort) && (
              <input
                className="ai-input ai-input-error ai-mono"
                aria-label="Effort"
                value={d.effort}
                onChange={(e) => set('effort', e.target.value)}
              />
            )}
            {(shown.effort || serverFor('effort')) && (
              <span className="rp-err">{shown.effort || serverFor('effort')}</span>
            )}
          </div>

          <div className="rp-field">
            <span className="ai-label">Model for a second try</span>
            <select
              className="ai-select"
              style={{ width: 160 }}
              aria-label="Model for a second try"
              value={d.retryModel}
              onChange={(e) => set('retryModel', e.target.value)}
            >
              <option value="">None</option>
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m[0].toUpperCase() + m.slice(1)}
                </option>
              ))}
              {d.retryModel && !(MODELS as readonly string[]).includes(d.retryModel) && (
                <option value={d.retryModel}>{d.retryModel}</option>
              )}
            </select>
            <span className="ai-hint">Used when the first run of the role did not get there.</span>
          </div>

          <div className="rp-field">
            <span className="ai-label">Writes</span>
            <div className="rp-chips" role="radiogroup" aria-label="Writes">
              {WRITES.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  role="radio"
                  aria-checked={d.writes === w.id}
                  className={`tw-chipbtn ${d.writes === w.id ? 'tw-chipbtn-on' : ''}`}
                  onClick={() => set('writes', w.id)}
                >
                  {w.label}
                </button>
              ))}
            </div>
            <span className="ai-hint">Where the role may leave files. The Deny list of the project still applies.</span>
          </div>

          <div className="rp-field">
            <span className="ai-label">Plugins</span>
            <NameList
              label="plugins"
              names={d.plugins}
              options={pluginOptions}
              missing={missingPlugins}
              addLabel="Add a plugin"
              onChange={(v) => set('plugins', v)}
            />
            {missingPlugins.length > 0 && (
              <span className="ai-hint" data-testid="pack-missing">
                Not on this project yet: {missingPlugins.join(', ')}. Add them under Skills &amp; plugins.
              </span>
            )}
          </div>

          <div className="rp-field">
            <span className="ai-label">MCP servers</span>
            <NameList
              label="mcp"
              names={d.mcp}
              options={mcpOptions}
              addLabel="Add an MCP server"
              none="None"
              onChange={(v) => set('mcp', v)}
            />
          </div>

          <div className="rp-field">
            <span className="ai-label">Limits</span>
            <div className="rp-limits">
              <input
                className={`ai-input ${shown.maxParallel ? 'ai-input-error' : ''}`}
                aria-label="At once"
                inputMode="numeric"
                value={d.maxParallel}
                onChange={(e) => set('maxParallel', e.target.value)}
              />
              <span>at once</span>
              <input
                className={`ai-input ${shown.maxRunsPerDay ? 'ai-input-error' : ''}`}
                aria-label="Runs a day"
                inputMode="numeric"
                value={d.maxRunsPerDay}
                onChange={(e) => set('maxRunsPerDay', e.target.value)}
              />
              <span>runs a day</span>
            </div>
            {(shown.maxParallel || shown.maxRunsPerDay) && (
              <span className="rp-err">{shown.maxParallel || shown.maxRunsPerDay}</span>
            )}
          </div>

          <div className="rp-field">
            <span className="ai-label">Board skills it gets</span>
            <div className="rp-chips" data-testid="pack-skills">
              {skills.map((s) => (
                <span
                  key={s.name}
                  className={`rp-skill ${s.role ? 'rp-skill-role' : ''} ${
                    boardSkillOn(ops.data?.boardSkills, s.name) ? '' : 'rp-skill-off'
                  }`}
                  title={s.description}
                >
                  {s.name}
                </span>
              ))}
              {boardSkills.isSuccess && skills.length === 0 && <span className="ai-hint">None</span>}
            </div>
            <span className="ai-hint">Follow the role; switched on and off under Skills &amp; plugins.</span>
          </div>
        </div>
      </div>

      <div className="rp-foot">
        {ready && edited && (
          <button type="button" className="ai-btn ai-btn-sm ai-btn-danger-outline" onClick={() => onReset(pack)}>
            Reset to ready-made
          </button>
        )}
        {ready && !edited && (
          <>
            <button type="button" className="ai-btn ai-btn-sm ai-btn-danger-outline" disabled>
              Reset to ready-made
            </button>
            <span className="ai-hint">Nothing to reset: this is the ready-made version.</span>
          </>
        )}
        {!ready && (
          <button type="button" className="ai-btn ai-btn-sm ai-btn-danger-outline" onClick={() => onRemove(pack)}>
            Remove this role
          </button>
        )}
        {edited && pack.updatedAt && (
          <span className="ai-hint">
            {pack.updatedBy ? `Edited by ${pack.updatedBy} · ` : 'Edited · '}
            {dayOf(pack.updatedAt)}
          </span>
        )}
        <div className="rp-foot-right">
          <button type="button" className="ai-btn" onClick={onBack}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={save.isPending || (!dirty && !serverError)}
            onClick={() => void submit()}
            data-testid="pack-save"
          >
            Save as version {nextVersion}
          </button>
        </div>
      </div>
    </div>
  );
}
