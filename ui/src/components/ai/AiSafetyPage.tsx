import { useState } from 'react';
import { aiApi, useAiMutation, useAiOverview } from '../../api/ai';
import { safetyApi, useAiChecklist, useAiKeys, useAiMe, useWorkspaceDefaults } from '../../api/aiSafety';
import { extractError } from '../../api/extractError';
import type { AiMember, AiSettings } from '../../types/ai';
import { useToast } from '../Toast';
import { AiAvatar, Toggle } from './aiUi';
import { ChipChoice, Pill, RadioRow, SafetyCard, TrustChip } from './aiSafetyUi';

const TRUST_ROWS: { source: string; trust: 'trusted' | 'data_only' | 'untrusted'; how: string }[] = [
  {
    source: 'Text written by project members',
    trust: 'trusted',
    how: 'Passed as the person’s own words, within their rights',
  },
  { source: 'Other AI members’ comments', trust: 'data_only', how: 'Context only; an @mention is one chain hop' },
  {
    source: 'Comments by guests or external people',
    trust: 'untrusted',
    how: 'Fenced; shown only if the agent allows external sources',
  },
  { source: 'Imported or pasted content (CSV, Jira, logs)', trust: 'untrusted', how: 'Fenced and labelled' },
  { source: 'Docs from outside, linked or imported', trust: 'untrusted', how: 'Fenced; private docs are never sent' },
  {
    source: 'Attachments: file name and extracted text',
    trust: 'untrusted',
    how: 'Fenced; binaries and images not sent to API agents',
  },
  {
    source: 'Web fetch results',
    trust: 'untrusted',
    how: 'Fenced; a local runner may only fetch from the allowed domains',
  },
];

const ROLES: [string, boolean | string, boolean | string, boolean | string, boolean | string][] = [
  ['Add or remove AI members', true, true, false, false],
  ['Change AI permissions', true, 'asks owner', false, false],
  ['Allow Done, wider scope, defaults', true, false, false, false],
  ['Change budgets and limits', true, true, false, false],
  ['Pause or resume AI', true, true, 'pause only', false],
  ['View the audit log', true, true, 'own runs', false],
  ['Approve low and medium risk', true, true, 'as assigner', false],
  ['Approve high risk', true, false, false, false],
];

function Stepper({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  label: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} aria-label={label}>
      <button
        type="button"
        className="ai-icobtn"
        onClick={() => onChange(Math.max(min, value - 1))}
        aria-label={`Less ${label}`}
      >
        −
      </button>
      <b style={{ minWidth: 22, textAlign: 'center' }} data-testid={`stepper-${label}`}>
        {value}
      </b>
      <button
        type="button"
        className="ai-icobtn"
        onClick={() => onChange(Math.min(max, value + 1))}
        aria-label={`More ${label}`}
      >
        +
      </button>
    </div>
  );
}

/** Safety tab: first-time checklist, safe mode, trust, links and sandbox, keys, loops, notifications, defaults, roles. */
export function SafetyView({
  projectId,
  members,
  onOpenAudit,
}: {
  projectId: string;
  members: AiMember[];
  onOpenAudit: () => void;
}) {
  const overview = useAiOverview(projectId);
  const s = overview.data?.settings;
  const me = useAiMe(projectId);
  const toast = useToast();
  if (!s) return <span className="ai-spin" />;
  const save = async (body: Record<string, unknown>) => {
    try {
      await safetyApi.updateSettings(projectId, body);
      void overview.refetch();
    } catch (err) {
      toast.error("Couldn't save", extractError(err));
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="ai-safety">
      <div>
        <b style={{ fontSize: 16 }}>Safety</b>
        <div className="ai-hint">
          What AI members may read, trust and reach, how loops are stopped, who is told, and the defaults new members
          start from. You are <b>{me.data ? `${me.data.name} (${me.data.role})` : '…'}</b>.
        </div>
      </div>
      <Checklist projectId={projectId} />
      <SafeModeCard s={s} save={save} />
      <AutoTripCard s={s} save={save} />
      <div className="ai-grid2">
        <TrustCard />
        <ExternalSources members={members} />
      </div>
      <LinksCard s={s} save={save} />
      <KeysCard projectId={projectId} s={s} save={save} />
      <LoopsCard s={s} save={save} />
      <NotificationsCard s={s} save={save} />
      <div className="ai-grid2">
        <DefaultsCard projectId={projectId} />
        <RolesCard role={me.data?.role} onOpenAudit={onOpenAudit} />
      </div>
    </div>
  );
}

function Checklist({ projectId }: { projectId: string }) {
  const q = useAiChecklist(projectId);
  const mut = useAiMutation((body: { tick?: string; dismiss?: boolean }) => safetyApi.tickChecklist(projectId, body));
  const c = q.data;
  if (!c?.show) return null;
  const tickable = ['notifications', 'pause'];
  return (
    <SafetyCard
      title={
        <>
          Review AI safety defaults{' '}
          <span className="ai-muted">
            {c.done} of {c.total}
          </span>
        </>
      }
      sub="Shown once to the owner when a project gets its first AI member."
      id="first-time"
    >
      <div data-testid="first-time-checklist">
        {c.items.map((i) => (
          <label
            key={i.key}
            className="ai-checkrow"
            style={{ cursor: tickable.includes(i.key) ? 'pointer' : 'default' }}
          >
            <input
              type="checkbox"
              checked={i.done}
              disabled={!tickable.includes(i.key) || i.done}
              onChange={() => void mut.mutate({ tick: i.key })}
            />
            <span style={{ color: i.done ? '#2E6F40' : undefined }}>{i.label}</span>
          </label>
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        <button type="button" className="ai-link" onClick={() => void mut.mutate({ dismiss: true })}>
          Dismiss for now
        </button>
      </div>
    </SafetyCard>
  );
}

/** Auto-trip rules (D6): one switch per rule, thresholds editable by owners and admins. */
function AutoTripCard({ s, save }: { s: AiSettings; save: (b: Record<string, unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const rules = s.autoTrip ?? [];
  const set = (key: string, patch: Record<string, unknown>) => save({ autoTrip: [{ key, ...patch }] });
  const num = (key: string, field: 'count' | 'minutes' | 'factor', value: number | undefined, unit: string) =>
    value === undefined ? null : (
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <input
          className="ai-input"
          style={{ width: 64, padding: '3px 6px' }}
          type="number"
          step={field === 'factor' ? 0.5 : 1}
          defaultValue={value}
          aria-label={`${key} ${field}`}
          onBlur={(e) => Number(e.target.value) !== value && void set(key, { [field]: Number(e.target.value) })}
        />
        <span className="ai-muted">{unit}</span>
      </label>
    );
  return (
    <SafetyCard
      title="Auto-trip rules"
      sub="Thresholds are invented defaults. They protect against a runaway agent when nobody is watching."
      id="auto-trip"
      right={
        <button type="button" className="ai-link" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Done' : 'Edit thresholds'}
        </button>
      }
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.6fr) minmax(0,1fr) auto',
          gap: '8px 14px',
          alignItems: 'center',
          fontSize: 13,
        }}
        data-testid="auto-trip"
      >
        <span className="ai-label">Rule</span>
        <span className="ai-label">Trips when</span>
        <span className="ai-label">Then</span>
        <span />
        {rules.map((r) => (
          <div key={r.key} style={{ display: 'contents' }}>
            <b style={{ fontWeight: 600, color: r.on ? undefined : '#9AA8A0' }}>{r.label}</b>
            {editing ? (
              <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {num(r.key, 'factor', r.factor, '× norm')}
                {num(r.key, 'count', r.count, r.key === 'many_agents' ? 'agents' : 'times')}
                {num(r.key, 'minutes', r.minutes, 'min')}
              </span>
            ) : (
              <span className={r.on ? undefined : 'ai-muted'}>{r.when}</span>
            )}
            <span className="ai-muted">{r.then}</span>
            <Toggle
              on={r.on}
              label={r.label}
              testId={`auto-trip-${r.key}`}
              onChange={(v) => void set(r.key, { on: v })}
            />
          </div>
        ))}
      </div>
      <div className="ai-muted" style={{ marginTop: 8 }}>
        A trip shows a banner on the agent, a toast and a desktop notification. The run stops, queued work is held, and
        only an owner or admin can resume.
      </div>
    </SafetyCard>
  );
}

function SafeModeCard({ s, save }: { s: AiSettings; save: (b: Record<string, unknown>) => Promise<void> }) {
  return (
    <SafetyCard
      title="Safe mode"
      sub="Read-only AI. Every agent can read tickets and docs and post comments, nothing else. Approvals still work for what it asks, but anything beyond reading is blocked."
      right={
        <Toggle on={s.safeMode} label="Safe mode" testId="ai-safe-mode" onChange={(v) => void save({ safeMode: v })} />
      }
    >
      <div className="ai-chips">
        {['Read', 'Comment'].map((c) => (
          <Pill key={c} bg="#F1F8F3" color="#2E6F40">
            ✓ {c}
          </Pill>
        ))}
        {['Edit', 'Status', 'Create', 'Run tools'].map((c) => (
          <Pill key={c} bg="#FBEEEA" color="#C4432A">
            ⊘ {c}
          </Pill>
        ))}
      </div>
      <div className="ai-muted" style={{ marginTop: 6 }}>
        A “Safe mode” chip is shown in the header and on each agent. A local runner’s CLI also loses Edit, Write, Bash
        and the web. Per-agent safe mode is on each agent’s Permissions tab.
      </div>
    </SafetyCard>
  );
}

function TrustCard() {
  return (
    <SafetyCard title="Trust levels" sub="By source, not by wording.">
      <table className="ai-table" data-testid="trust-table">
        <thead>
          <tr>
            <th>Where the text comes from</th>
            <th>Trust</th>
            <th>How it is handled</th>
          </tr>
        </thead>
        <tbody>
          {TRUST_ROWS.map((r) => (
            <tr key={r.source}>
              <td>{r.source}</td>
              <td>
                <TrustChip trust={r.trust} />
              </td>
              <td className="ai-muted">{r.how}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ai-hint" style={{ marginTop: 8 }}>
        Untrusted text reaches an agent inside <span className="ai-mono">&lt;untrusted&gt;</span> tags and is never
        followed as instructions. Fencing lowers the risk; it does not remove it, so every action is checked by the
        board after the model.
      </div>
    </SafetyCard>
  );
}

function ExternalSources({ members }: { members: AiMember[] }) {
  const toast = useToast();
  const save = useAiMutation((v: { id: string; on: boolean }) => aiApi.update(v.id, { allowExternal: v.on }));
  return (
    <SafetyCard title="Three rules no text can change" sub="Enforced in the permission layer, after the model">
      {[
        ['Widen permissions.', 'Never adds an action, scope or ceiling'],
        ['Auto-approve.', 'Never approves, or triggers, an approval'],
        ['Reach out.', 'No outbound network or tool call without approval'],
      ].map(([a, b]) => (
        <div key={a} style={{ fontSize: 12.5, padding: '3px 0' }}>
          <span style={{ color: '#C4432A' }}>⊘</span> <b>{a}</b> <span className="ai-muted">{b}</span>
        </div>
      ))}
      <div className="ai-label ai-label-dark" style={{ margin: '12px 0 6px' }}>
        Allow external sources, per agent
      </div>
      {members.length === 0 && <div className="ai-muted">No AI members yet.</div>}
      {members.map((m) => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
          <AiAvatar provider={m.provider} size={24} />
          <span style={{ flex: 1, fontSize: 12.5 }}>
            <b>{m.name}</b>{' '}
            <span className="ai-muted">
              {m.allowExternal ? '· reads outside text, fenced' : '· guest comments hidden'}
            </span>
          </span>
          <Toggle
            on={m.allowExternal}
            label={`Allow external sources for ${m.name}`}
            testId={`external-${m.name}`}
            onChange={async (on) => {
              try {
                await save.mutateAsync({ id: m.id, on });
              } catch (err) {
                toast.error("Couldn't save", extractError(err));
              }
            }}
          />
        </div>
      ))}
    </SafetyCard>
  );
}

function LinksCard({ s, save }: { s: AiSettings; save: (b: Record<string, unknown>) => Promise<void> }) {
  const [domain, setDomain] = useState('');
  return (
    <SafetyCard
      title="Links, attachments, sandbox and secrets"
      sub="What an agent may do with them, and the honest limits"
    >
      <div className="ai-grid2">
        <div>
          <div className="ai-label ai-label-dark">Links and attachments</div>
          <div style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
            <span>
              <span style={{ color: '#C4432A' }}>✕</span> Links in untrusted text are never opened on their own
            </span>
            <span>
              ✋ A local runner may fetch a web page only from an allowed domain; anything else is refused (a run cannot
              wait for you mid-call)
            </span>
            <span>
              <span style={{ color: '#C4432A' }}>✕</span> Attachments: file name and extracted text only; never executed
            </span>
          </div>
          <div className="ai-chips" style={{ marginTop: 8 }} data-testid="allowed-domains">
            {s.allowedDomains.map((d) => (
              <span key={d} className="ai-chip" style={{ background: '#F6FAF7', border: '1px solid #E3E8E5' }}>
                {d}
                <button
                  type="button"
                  className="ai-link"
                  aria-label={`Remove ${d}`}
                  onClick={() => void save({ allowedDomains: s.allowedDomains.filter((x) => x !== d) })}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input
              className="ai-input"
              style={{ height: 32, width: 200 }}
              placeholder="example.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              data-testid="domain-input"
            />
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              disabled={!domain.trim()}
              onClick={async () => {
                await save({ allowedDomains: [...s.allowedDomains, domain] });
                setDomain('');
              }}
            >
              Allow domain
            </button>
          </div>
        </div>
        <div>
          <div className="ai-label ai-label-dark">Runner sandbox and secrets</div>
          <div style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            <span>
              📁 Runners start in their working folder; the board refuses paths outside it. The CLI itself may still
              read elsewhere if its own settings allow.
            </span>
            <span>
              🔑 <b>Secrets never go into prompts.</b> Keys, tokens, marked env values and{' '}
              <span className="ai-mono">.env</span> become ••••• before text is sent, logged or saved.
            </span>
          </div>
        </div>
      </div>
    </SafetyCard>
  );
}

function ago(days: number | null) {
  return days == null ? '—' : days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`;
}

function KeysCard({
  projectId,
  s,
  save,
}: {
  projectId: string;
  s: AiSettings;
  save: (b: Record<string, unknown>) => Promise<void>;
}) {
  const keys = useAiKeys(projectId);
  const [rotating, setRotating] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const toast = useToast();
  const update = useAiMutation((v: { id: string; apiKey: string }) => aiApi.update(v.id, { apiKey: v.apiKey }));
  const revoke = useAiMutation((id: string) => safetyApi.revokeToken(id));
  const reconnect = useAiMutation((id: string) => safetyApi.reconnect(id));
  return (
    <SafetyCard
      title="Keys and tokens"
      sub="Rotation reminders for API keys, and each member’s MCP token."
      right={
        <label className="ai-muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Remind after
          <select
            className="ai-select-sm"
            value={s.keyReminderDays}
            onChange={(e) => void save({ keyReminderDays: Number(e.target.value) })}
          >
            {[30, 60, 90, 180].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
      }
    >
      <div data-testid="keys-card">
        {keys.data?.members.length === 0 && <div className="ai-muted">No AI members yet.</div>}
        {keys.data?.members.map((k) => (
          <div key={k.memberId} style={{ padding: '8px 0', borderTop: '1px solid #EEF3EF' }}>
            {k.connection === 'api_key' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, flex: 1 }}>
                  <b>
                    {k.name} · key ••••{k.keyLast4}
                  </b>
                  <div className="ai-muted" style={{ color: k.rotateDue ? '#B4571F' : undefined }}>
                    Rotated {ago(k.keyAgeDays)} · reminder at {k.reminderDays}
                    {k.rotateDue ? ' · rotation due' : ''}
                  </div>
                </span>
                {rotating === k.memberId ? (
                  <>
                    <input
                      className="ai-input"
                      type="password"
                      style={{ width: 240, height: 32 }}
                      placeholder="New API key"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="ai-btn ai-btn-sm ai-btn-primary"
                      disabled={!key.trim()}
                      onClick={async () => {
                        try {
                          await update.mutateAsync({ id: k.memberId, apiKey: key });
                          toast.success('Key rotated', `${k.name} uses the new key from its next call.`);
                          setRotating(null);
                          setKey('');
                        } catch (err) {
                          toast.error("Couldn't rotate", extractError(err));
                        }
                      }}
                    >
                      Save key
                    </button>
                  </>
                ) : (
                  <button type="button" className="ai-btn ai-btn-sm" onClick={() => setRotating(k.memberId)}>
                    Rotate…
                  </button>
                )}
              </div>
            )}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                marginTop: k.connection === 'api_key' ? 6 : 0,
              }}
            >
              <span style={{ fontSize: 12.5, flex: 1 }}>
                <b>{k.name} · MCP token</b>
                <div className="ai-muted">
                  Created {new Date(k.tokenCreatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} ·{' '}
                  {k.tokenRevokedAt
                    ? `revoked by ${k.tokenRevokedBy}`
                    : k.tokenLastUsedAt
                      ? `last used ${new Date(k.tokenLastUsedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`
                      : 'not used yet'}
                </div>
              </span>
              {k.tokenRevokedAt ? (
                <button type="button" className="ai-btn ai-btn-sm" onClick={() => void reconnect.mutate(k.memberId)}>
                  Reconnect
                </button>
              ) : (
                <button
                  type="button"
                  className="ai-btn ai-btn-sm ai-btn-danger-outline"
                  onClick={async () => {
                    try {
                      await revoke.mutateAsync(k.memberId);
                      toast.success('Token revoked', `${k.name} stops at its next call.`);
                    } catch (err) {
                      toast.error("Couldn't revoke", extractError(err));
                    }
                  }}
                  data-testid={`revoke-${k.name}`}
                >
                  Revoke
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </SafetyCard>
  );
}

function LoopsCard({ s, save }: { s: AiSettings; save: (b: Record<string, unknown>) => Promise<void> }) {
  const [cool, setCool] = useState(String(s.loopCooldownS));
  return (
    <SafetyCard title="Chain and re-run limits" sub="Invented defaults; owners change them" id="loops">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1 }}>
            <b style={{ fontSize: 13 }}>Max chain depth</b>
            <div className="ai-muted">Each AI-to-AI @mention is one hop</div>
          </span>
          <Stepper
            label="depth"
            value={s.maxChainDepth}
            min={1}
            max={10}
            onChange={(n) => void save({ maxChainDepth: n })}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1 }}>
            <b style={{ fontSize: 13 }}>No repeats in a chain</b>
            <div className="ai-muted">An agent already in it is not mentioned again</div>
          </span>
          <Toggle
            on={s.noRepeatChain}
            label="No repeats in a chain"
            testId="no-repeat"
            onChange={(v) => void save({ noRepeatChain: v })}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1 }}>
            <b style={{ fontSize: 13 }}>Cooldown between AI mentions</b>
            <div className="ai-muted">Per ticket, so replies cannot ping-pong</div>
          </span>
          <input
            className="ai-input"
            type="number"
            min={0}
            style={{ width: 80, height: 32 }}
            value={cool}
            onChange={(e) => setCool(e.target.value)}
            onBlur={() => Number(cool) !== s.loopCooldownS && void save({ loopCooldownS: Number(cool) })}
            data-testid="cooldown"
          />
          <span className="ai-muted">sec</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1 }}>
            <b style={{ fontSize: 13 }}>Runs per ticket in 24 h</b>
            <div className="ai-muted">Re-runs after “Request changes” count too</div>
          </span>
          <Stepper
            label="runs"
            value={s.runsPerTicketPerDay}
            min={1}
            max={50}
            onChange={(n) => void save({ runsPerTicketPerDay: n })}
          />
        </div>
        <div className="ai-hint">
          A mention that breaks a limit is simply not delivered. The ticket is not blocked and nothing is retried
          silently; a Board comment on the ticket says why. The chain of who woke whom is shown on the ticket.
        </div>
      </div>
    </SafetyCard>
  );
}

function NotificationsCard({ s, save }: { s: AiSettings; save: (b: Record<string, unknown>) => Promise<void> }) {
  const toggle = async (event: string, field: 'inapp' | 'desktop', on: boolean) => {
    if (field === 'desktop' && on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore */
      }
    }
    const cur = s.notify.find((n) => n.event === event)!;
    await save({ notify: [{ event, inapp: cur.inapp, desktop: cur.desktop, [field]: on }] });
  };
  return (
    <SafetyCard
      title="AI safety notifications"
      sub="In-app toasts and desktop notifications; no email."
      id="notifications"
    >
      <table className="ai-table" data-testid="notify-table">
        <thead>
          <tr>
            <th>When this happens</th>
            <th>In-app</th>
            <th>Desktop</th>
          </tr>
        </thead>
        <tbody>
          {s.notify.map((n) => (
            <tr key={n.event}>
              <td>
                {n.label}{' '}
                {n.urgent ? <span className="ai-muted">· urgent</span> : <span className="ai-muted">· digest</span>}
              </td>
              <td>
                <Toggle
                  on={n.inapp}
                  label={`${n.label} in-app`}
                  testId={`notify-${n.event}-inapp`}
                  onChange={(v) => void toggle(n.event, 'inapp', v)}
                />
              </td>
              <td>
                <Toggle
                  on={n.desktop}
                  label={`${n.label} desktop`}
                  testId={`notify-${n.event}-desktop`}
                  onChange={(v) => void toggle(n.event, 'desktop', v)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <span className="ai-label ai-label-dark">Non-urgent as one digest</span>
        <select
          className="ai-select-sm"
          value={s.digest}
          onChange={(e) => void save({ digest: e.target.value })}
          data-testid="digest"
        >
          <option value="off">Off: show them as they happen</option>
          <option value="daily">Daily 09:00</option>
          <option value="weekdays">Daily 09:00, Mon to Fri</option>
        </select>
      </div>
      <div className="ai-muted" style={{ marginTop: 6 }}>
        Urgent ones (approvals, auto-trip) are never held for the digest. Owners and admins get all; members only their
        own.
      </div>
    </SafetyCard>
  );
}

const TEMPLATE_CHOICES = [
  ['developer', 'Developer'],
  ['reviewer', 'Reviewer'],
  ['read_only', 'Read-only'],
] as const;
const CEILING_CHOICES = [
  ['none', 'None'],
  ['backlog', 'Backlog'],
  ['todo', 'To Do'],
  ['in-progress', 'In Progress'],
  ['review', 'Review'],
] as const;

function DefaultsCard({ projectId }: { projectId: string }) {
  const q = useWorkspaceDefaults(projectId);
  const toast = useToast();
  const [f, setF] = useState<null | {
    template: string;
    ceiling: string;
    deleteMode: string;
    dailyBudget: string;
    monthlyCap: string;
  }>(null);
  const d = q.data;
  if (!d) return <span className="ai-spin" />;
  const v = f ?? {
    template: d.template,
    ceiling: d.ceiling,
    deleteMode: d.deleteMode,
    dailyBudget: String(d.dailyBudget ?? ''),
    monthlyCap: String(d.monthlyCap ?? ''),
  };
  const set = (patch: Partial<typeof v>) => setF({ ...v, ...patch });
  const num = (x: string) => (x.trim() === '' ? null : Number(x));
  return (
    <SafetyCard
      title="Workspace defaults"
      sub="Start values for every new AI member. Admins may tighten per project, never loosen."
      id="defaults"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="workspace-defaults">
        <div>
          <div className="ai-label ai-label-dark">Role template</div>
          <ChipChoice
            value={v.template}
            options={TEMPLATE_CHOICES}
            onChange={(t) => set({ template: t })}
            disabled={!d.canEdit}
          />
        </div>
        <div>
          <div className="ai-label ai-label-dark">Status ceiling</div>
          <ChipChoice
            value={v.ceiling}
            options={CEILING_CHOICES}
            onChange={(t) => set({ ceiling: t })}
            disabled={!d.canEdit}
          />
        </div>
        <div>
          <div className="ai-label ai-label-dark">Delete tickets</div>
          <RadioRow
            on={v.deleteMode === 'blocked'}
            onClick={() => set({ deleteMode: 'blocked' })}
            title="Blocked"
            disabled={!d.canEdit}
          />
          <div style={{ height: 4 }} />
          <RadioRow
            on={v.deleteMode === 'approval'}
            onClick={() => set({ deleteMode: 'approval' })}
            title="Needs approval (owner-enabled)"
            disabled={!d.canEdit}
          />
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <label className="ai-field" style={{ flex: 1 }}>
            <span className="ai-label ai-label-dark">Budget per day ($)</span>
            <input
              className="ai-input"
              type="number"
              min={0}
              value={v.dailyBudget}
              disabled={!d.canEdit}
              onChange={(e) => set({ dailyBudget: e.target.value })}
            />
          </label>
          <label className="ai-field" style={{ flex: 1 }}>
            <span className="ai-label ai-label-dark">Cap per month ($)</span>
            <input
              className="ai-input"
              type="number"
              min={0}
              value={v.monthlyCap}
              disabled={!d.canEdit}
              onChange={(e) => set({ monthlyCap: e.target.value })}
            />
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!d.canEdit || !f}
            data-testid="defaults-save"
            onClick={async () => {
              try {
                await safetyApi.saveDefaults(projectId, {
                  template: v.template,
                  ceiling: v.ceiling,
                  deleteMode: v.deleteMode,
                  dailyBudget: num(v.dailyBudget),
                  monthlyCap: num(v.monthlyCap),
                });
                toast.success('Defaults saved', 'Existing members are unchanged.');
                setF(null);
                void q.refetch();
              } catch (err) {
                toast.error("Couldn't save", extractError(err));
              }
            }}
          >
            Save defaults
          </button>
          <span className="ai-muted">
            {d.canEdit ? 'Existing members are unchanged.' : 'Only the owner can change the defaults.'}
          </span>
        </div>
      </div>
    </SafetyCard>
  );
}

function RolesCard({ role, onOpenAudit }: { role?: string; onOpenAudit: () => void }) {
  const cols = ['Owner', 'Admin', 'Member', 'Viewer'];
  const mine = role ? role[0].toUpperCase() + role.slice(1) : '';
  return (
    <SafetyCard
      title="Who can do what"
      sub="Owner is the project’s first admin (and the board’s own user). Roles come from the Members board."
    >
      <table className="ai-table">
        <thead>
          <tr>
            <th>Action</th>
            {cols.map((c) => (
              <th key={c} style={{ color: c === mine ? '#2E6F40' : undefined }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROLES.map(([a, ...cells]) => (
            <tr key={a}>
              <td>{a}</td>
              {cells.map((c, i) => (
                <td key={i} style={{ color: c === true ? '#2E6F40' : '#5B6B60' }}>
                  {c === true ? '✓' : c === false ? '—' : c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ai-muted" style={{ marginTop: 6 }}>
        Every permission change is audited.{' '}
        <button type="button" className="ai-link" onClick={onOpenAudit}>
          Open the audit log
        </button>
      </div>
    </SafetyCard>
  );
}
