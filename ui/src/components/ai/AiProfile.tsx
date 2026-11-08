import { useEffect, useState } from 'react';
import { aiApi, useAiMutation, useAiTeam, useRoleCatalogue, useTeamPacks } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { Member } from '../../types';
import type { AiTeam, AiTeamRole, RoleOverride } from '../../types/ai';
import { useToast } from '../Toast';
import { AccountPicker } from './accounts/AccountPicker';
import { RemoveAiDialog } from './AiDialogs';
import { EFFORTS, MODELS, PERMISSION_MODES } from './teamOptions';
import { PersonaField } from './PersonaField';
import {
  changedFields,
  draftOf,
  isChanged,
  offKeys,
  withRoleOff,
  withRoleOn,
  withRoleOverride,
  type RoleDraft,
} from './roleEdit';
import { AiAvatar, LoadError, StatusLabel, money, statusSub, useNow } from './aiUi';
import { roleLook } from './roleLook';
import { displayStatus } from '../../utils/memberAccount';
import { LineIcon } from '../ui/LineIcon';
import './ai.css';

/** A card with a title: the team page is a column of them. */
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="ai-card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <h2 style={{ fontSize: 14.5, fontWeight: 800, margin: 0 }}>{title}</h2>
        {hint && <div className="ai-hint">{hint}</div>}
      </div>
      {children}
    </section>
  );
}

/** A number setting saved when the field is left; empty means no limit. */
function LimitField({
  label,
  value,
  step,
  onSave,
}: {
  label: string;
  value: number | null;
  step?: string;
  onSave: (v: number | null) => void;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => setText(value == null ? '' : String(value)), [value]);
  return (
    <label className="ai-field" style={{ minWidth: 0 }}>
      <span className="ai-label ai-label-dark ai-label-sentence">{label}</span>
      <input
        className="ai-input"
        type="number"
        min={0}
        step={step}
        value={text}
        placeholder="No limit"
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const next = text.trim() === '' ? null : Number(text);
          if (next !== value) onSave(next);
        }}
      />
    </label>
  );
}

/** One role of the team: what it runs on, its tools, its prompt; changes are saved as an override on the pack. */
function RoleRow({
  role,
  overrides,
  onChange,
}: {
  role: AiTeamRole;
  overrides: RoleOverride[];
  onChange: (next: RoleOverride[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<RoleDraft>(() => draftOf(role));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(draftOf(role)), [role.model, role.effort, role.prompt]); // eslint-disable-line react-hooks/exhaustive-deps
  const look = roleLook(role.key);
  const changed = isChanged(role, draft);
  const run = async (next: RoleOverride[]) => {
    setBusy(true);
    setError(null);
    try {
      await onChange(next);
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      style={{ border: '1px solid #E3E8E5', borderRadius: 10, padding: '10px 12px', background: '#fff' }}
      data-testid={`role-${role.key}`}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          className="ai-chip"
          style={{
            background: look.bg,
            color: look.fg,
            border: `1px solid ${look.border}`,
            minWidth: 30,
            justifyContent: 'center',
          }}
        >
          {look.glyph}
        </span>
        <div style={{ flex: 1, minWidth: 160 }}>
          <b style={{ fontSize: 13.5 }}>{role.name ?? role.key}</b>
          <div className="ai-muted">{role.description}</div>
        </div>
        <label className="ai-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <span className="ai-muted">Model</span>
          <select
            className="ai-select"
            style={{ width: 110 }}
            aria-label={`${role.name ?? role.key} model`}
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          >
            <option value="">Same as lead</option>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="ai-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <span className="ai-muted">Effort</span>
          <select
            className="ai-select"
            style={{ width: 100 }}
            aria-label={`${role.name ?? role.key} effort`}
            value={draft.effort}
            onChange={(e) => setDraft({ ...draft, effort: e.target.value })}
          >
            <option value="">Default</option>
            {EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="ai-link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide prompt' : 'Prompt & tools'}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="ai-muted" data-testid="role-tools">
            Tools: {role.tools ? role.tools.join(', ') : 'every tool of the run'}
            {role.writes ? ` · writes: ${role.writes}` : ''}
          </div>
          <textarea
            className="ai-textarea"
            style={{ minHeight: 120 }}
            aria-label={`${role.name ?? role.key} prompt`}
            value={draft.prompt}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          />
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-btn-primary"
          disabled={!changed || busy}
          data-testid={`role-save-${role.key}`}
          onClick={() => void run(withRoleOverride(overrides, role.key, changedFields(role, draft)))}
        >
          Save role
        </button>
        {changed && (
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => setDraft(draftOf(role))}>
            Undo
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="ai-link"
          disabled={busy}
          data-testid={`role-off-${role.key}`}
          onClick={() => void run(withRoleOff(overrides, role.key))}
        >
          Turn off
        </button>
        {error && <span className="ai-error-text">{error}</span>}
      </div>
    </div>
  );
}

/** The roles of the team's pack with a minimal editor, the ones turned off, and a way to add one. */
function RolesCard({ team }: { team: AiTeam }) {
  const catalogue = useRoleCatalogue();
  const packs = useTeamPacks();
  const overrides = team.config.roles ?? [];
  const save = useAiMutation((next: RoleOverride[]) => aiApi.updateTeam(team.id, { config: { roles: next } }));
  const off = offKeys(overrides);
  const have = new Set(team.roles.map((r) => r.key));
  const addable = (catalogue.data ?? []).filter((r) => !have.has(r.key) && !off.includes(r.key));
  const nameOf = (key: string) => catalogue.data?.find((r) => r.key === key)?.name ?? key;
  const pack = packs.data?.find((p) => p.key === team.packKey);
  const [adding, setAdding] = useState('');
  return (
    <Section
      title="Roles"
      hint={`${team.packName ?? pack?.name ?? 'Team pack'}: the lead calls these as helpers (subagents). A change is saved on this team only.`}
    >
      {team.roles.map((r) => (
        <RoleRow
          key={r.key}
          role={r}
          overrides={overrides}
          onChange={async (next) => void (await save.mutateAsync(next))}
        />
      ))}
      {team.roles.length === 0 && <div className="ai-muted">This team has no roles: its lead works alone.</div>}
      {off.length > 0 && (
        <div className="ai-muted" data-testid="roles-off">
          Turned off:{' '}
          {off.map((k) => (
            <button
              key={k}
              type="button"
              className="ai-link"
              style={{ marginRight: 10 }}
              onClick={() => void save.mutateAsync(withRoleOn(overrides, k))}
            >
              {nameOf(k)} (turn on)
            </button>
          ))}
        </div>
      )}
      {addable.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            className="ai-select"
            style={{ width: 220 }}
            aria-label="Add a role"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
          >
            <option value="">Add a role…</option>
            {addable.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name ?? r.key}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={!adding || save.isPending}
            onClick={async () => {
              await save.mutateAsync(withRoleOverride(overrides, adding, {}));
              setAdding('');
            }}
          >
            Add
          </button>
        </div>
      )}
    </Section>
  );
}

/** The team's own settings: folder, account, model, effort, permission mode, persona and limits. */
function SettingsCard({ team }: { team: AiTeam }) {
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState(team.workingDir ?? '');
  const [persona, setPersona] = useState(team.persona ?? '');
  const update = useAiMutation((body: Record<string, unknown>) => aiApi.updateTeam(team.id, body));
  const save = async (body: Record<string, unknown>, ok?: string) => {
    setError(null);
    try {
      await update.mutateAsync(body);
      if (ok) toast.success(ok);
    } catch (e) {
      setError(extractError(e));
    }
  };
  useEffect(() => setFolder(team.workingDir ?? ''), [team.workingDir]);
  useEffect(() => setPersona(team.persona ?? ''), [team.persona]);
  return (
    <Section title="Settings" hint="Changes take effect on the next run.">
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <label className="ai-field" style={{ flex: 2, minWidth: 260 }}>
          <span className="ai-label ai-label-dark ai-label-sentence">Working folder</span>
          <input
            className="ai-input ai-mono"
            value={folder}
            aria-label="Working folder"
            onChange={(e) => setFolder(e.target.value)}
            onBlur={() => folder.trim() !== (team.workingDir ?? '') && void save({ workingDir: folder.trim() })}
          />
        </label>
        <label className="ai-field" style={{ flex: 1, minWidth: 130 }}>
          <span className="ai-label ai-label-dark ai-label-sentence">Model of the lead</span>
          <select
            className="ai-select"
            value={team.model ?? 'sonnet'}
            aria-label="Model of the lead"
            onChange={(e) => void save({ model: e.target.value })}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="ai-field" style={{ flex: 1, minWidth: 110 }}>
          <span className="ai-label ai-label-dark ai-label-sentence">Effort</span>
          <select
            className="ai-select"
            value={team.effort ?? ''}
            aria-label="Effort of the lead"
            onChange={(e) => void save({ effort: e.target.value || null })}
          >
            <option value="">Default</option>
            {EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="ai-field">
        <span className="ai-label ai-label-dark ai-label-sentence">Permission mode</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="radiogroup" aria-label="Permission mode">
          {PERMISSION_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={team.permissionMode === m.id}
              className={`ai-option ${team.permissionMode === m.id ? 'ai-option-active' : ''}`}
              style={{ flex: 1, minWidth: 220 }}
              onClick={() => team.permissionMode !== m.id && void save({ permissionMode: m.id })}
              data-testid={`permission-${m.id}`}
            >
              <span className={`ai-radio ${team.permissionMode === m.id ? 'ai-radio-on' : ''}`} />
              <span style={{ textAlign: 'left' }}>
                <b style={{ fontSize: 13 }}>{m.label}</b>
                <div className="ai-muted">{m.hint}</div>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="ai-field">
        <span className="ai-label ai-label-dark ai-label-sentence">Claude account</span>
        <AccountPicker
          provider="claude-code"
          value={team.accountId}
          projectId={team.projectId}
          currentAccountId={team.accountId}
          profile
          onChange={(id) => void save({ accountId: id })}
        />
      </div>
      <label className="ai-field">
        <span className="ai-label ai-label-dark ai-label-sentence">Persona</span>
        <PersonaField value={persona} onChange={setPersona} ariaLabel="Persona" />
        <span>
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={persona === (team.persona ?? '') || update.isPending}
            onClick={() => void save({ persona }, 'Persona saved')}
          >
            Save persona
          </button>
        </span>
      </label>
      <div>
        <div className="ai-label ai-label-dark ai-label-sentence" style={{ marginBottom: 6 }}>
          Limits
        </div>
        <div className="ai-limits">
          <LimitField
            label="Runs at once"
            value={team.maxParallel}
            onSave={(v) => v != null && v >= 1 && void save({ maxParallel: v })}
          />
          <LimitField label="Runs a day" value={team.maxRunsPerDay} onSave={(v) => void save({ maxRunsPerDay: v })} />
          <LimitField label="Tokens a day" value={team.tokensPerDay} onSave={(v) => void save({ tokensPerDay: v })} />
          <LimitField
            label="Daily budget ($)"
            value={team.dailyBudget}
            step="0.5"
            onSave={(v) => void save({ dailyBudget: v })}
          />
          <LimitField
            label="Monthly cap ($)"
            value={team.monthlyCap}
            step="1"
            onSave={(v) => void save({ monthlyCap: v })}
          />
          <LimitField
            label="Per run ($)"
            value={team.capPerRun}
            step="0.5"
            onSave={(v) => void save({ capPerRun: v })}
          />
        </div>
      </div>
      {error && <div className="ai-error-text">{error}</div>}
    </Section>
  );
}

/** The page of one AI team: status, its tickets, its roles, its settings. */
export function AiProfile({
  member,
  humans,
  onOpenTicket,
  onRemoved,
  onViewOnBoard,
}: {
  member: AiTeam;
  projectId: string;
  humans: Member[];
  onOpenTicket: (ticketId: string) => void;
  onRemoved?: () => void;
  onViewOnBoard?: (memberId: string) => void;
}) {
  const q = useAiTeam(member.id);
  const team = q.data ?? member;
  const toast = useToast();
  const [removing, setRemoving] = useState(false);
  const pause = useAiMutation(() => (team.paused ? aiApi.resumeTeam(team.id) : aiApi.pauseTeam(team.id)));
  const test = useAiMutation(() => aiApi.testTeam(team.id));
  useNow(1000, team.status.code === 'running');
  if (q.isError && !q.data) return <LoadError what="the team" error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="ai-profile">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <AiAvatar color={team.color} size={52} dim={team.paused} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 className="ai-h1" style={{ margin: 0 }}>
            {team.name}
          </h1>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            <StatusLabel
              status={displayStatus(team)}
              sub={displayStatus(team) !== team.status ? displayStatus(team).detail : (statusSub(team) ?? null)}
            />
            <span className="ai-muted">
              {team.packName ?? team.packKey} · {team.model ?? 'sonnet'}
              {team.effort ? ` · ${team.effort}` : ''} · {team.permissionMode}
            </span>
          </div>
        </div>
        <button type="button" className="ai-btn" disabled={pause.isPending} onClick={() => pause.mutate(undefined)}>
          <LineIcon name={team.paused ? 'play' : 'pause'} size={13} /> {team.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className="ai-btn"
          disabled={test.isPending}
          data-testid="team-test"
          onClick={async () => {
            try {
              const r = await test.mutateAsync(undefined);
              if (r.ok) toast.success(`${team.name}: Claude Code works`, r.message);
              else toast.error(`${team.name}: check failed`, r.message);
            } catch (e) {
              toast.error('Test failed', extractError(e));
            }
          }}
        >
          <LineIcon name="bolt" size={13} /> Test
        </button>
        {onViewOnBoard && (
          <button type="button" className="ai-btn" onClick={() => onViewOnBoard(team.id)}>
            View on board
          </button>
        )}
        <button
          type="button"
          className="ai-btn ai-btn-danger-outline"
          onClick={() => setRemoving(true)}
          data-testid="team-remove"
        >
          <LineIcon name="trash" size={13} /> Remove…
        </button>
      </div>
      {team.healthDetail && team.health !== 'ok' && (
        <div className="ai-notice ai-notice-warn">
          {displayStatus(team) !== team.status && team.accountRef
            ? `The account ${team.accountRef.name} needs to sign in.`
            : team.healthDetail}
        </div>
      )}

      <Section title="Today">
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', fontSize: 13 }}>
          <span>
            <b>{team.usage.runsToday}</b> run{team.usage.runsToday === 1 ? '' : 's'}
          </span>
          <span>
            <b>{money(team.usage.costToday)}</b> spent
          </span>
          <span>
            <b>{team.slotsInUse}</b> of {team.maxParallel} running
          </span>
          <span>
            <b>{team.queued}</b> queued
          </span>
        </div>
        {team.running.length > 0 && (
          <div>
            {team.running.map((r) => (
              <button
                key={r.runId}
                type="button"
                className="ai-link"
                style={{ display: 'block' }}
                onClick={() => onOpenTicket(r.ticketId)}
              >
                {r.ticketId} {r.ticketTitle} · run #{r.number} ({r.state.replace('_', ' ')})
              </button>
            ))}
          </div>
        )}
        <div className="ai-label ai-label-dark">Assigned tickets ({team.assigned.length})</div>
        {team.assigned.length === 0 ? (
          <div className="ai-muted">Nothing is assigned to this team.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {team.assigned.map((t) => (
              <button
                key={t.id}
                type="button"
                className="ai-link"
                style={{ textAlign: 'left' }}
                onClick={() => onOpenTicket(t.id)}
              >
                <span className="ai-mono">{t.id}</span> {t.title} <span className="ai-muted">· {t.status}</span>
              </button>
            ))}
          </div>
        )}
      </Section>

      <RolesCard team={team} />
      <SettingsCard team={team} />
      {removing && (
        <RemoveAiDialog member={team} humans={humans} onClose={() => setRemoving(false)} onRemoved={onRemoved} />
      )}
    </div>
  );
}
