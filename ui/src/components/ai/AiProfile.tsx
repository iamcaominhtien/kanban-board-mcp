import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { client } from '../../api/client';
import { aiApi, aiKeys, useAiAudit, useAiMutation, useAiUsage, useRunnerInfo } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiMember, AiRun } from '../../types/ai';
import type { Member } from '../../types';
import { useToast } from '../Toast';
import { RemoveAiDialog } from './AiDialogs';
import { AuditTable } from './AiSafetyViews';
import { Permissions, PreviewDialog } from './AiPermissionsTab';
import { SafeModeChip } from './AiKillSwitch';
import { RunSteps } from './RunPanel';
import { ConfigTab } from './config/ConfigTab';
import { ConnectionStateCard, type ConfigFocus } from './ConnectionState';
import { ProjectsPicker } from './ProjectsPicker';
import {
  AiAvatar,
  AvatarPicker,
  CeilingChip,
  ConnectionChip,
  PROVIDERS,
  ProviderChip,
  RunStateChip,
  STATUS_NAMES,
  StatusLabel,
  ago,
  fmtElapsed,
  money,
  secondsSince,
  useNow,
  whenWords,
  LoadError,
} from './aiUi';

type Tab = 'overview' | 'configuration' | 'permissions' | 'usage' | 'activity';

/** One AI member's profile page. */
export function AiProfile({
  member,
  projectId,
  humans,
  onOpenTicket,
  onRemoved,
  initialTab,
  onViewOnBoard,
  onOpenAudit,
}: {
  member: AiMember;
  projectId: string;
  humans: Member[];
  onOpenTicket: (id: string) => void;
  onRemoved: () => void;
  /** Open on Configuration (the row menu's “Edit”). */
  initialTab?: Tab;
  /** Show the board filtered to this member's tickets. */
  onViewOnBoard?: (memberId: string) => void;
  /** “Full usage & audit log”: the page's Audit log tab. */
  onOpenAudit?: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'overview');
  // A state's action can send the person to the field that fixes it (Replace key, Raise daily budget…)
  const [focus, setFocus] = useState<ConfigFocus | undefined>(undefined);
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState(false);
  const [pauseDialog, setPauseDialog] = useState(false);
  const [removing, setRemoving] = useState(false);
  const toast = useToast();
  const resume = useAiMutation(() => aiApi.resume(member.id));
  const test = useAiMutation(() => aiApi.test(member.id));

  return (
    <div data-testid="ai-profile">
      <div className="ai-profile-head">
        <AiAvatar provider={member.provider} color={member.color} glyph={member.glyph} size={52} dim={member.paused} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 className="ai-h1">{member.name}</h1>
            <StatusLabel status={member.status} sub={null} />
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <ProviderChip provider={member.provider} />
            <ConnectionChip connection={member.connection} />
            <CeilingChip ceiling={member.ceiling} />
            {member.safeMode && <SafeModeChip />}
            {member.isBoardAi && (
              <span className="ai-chip" style={{ background: '#1E2A22', color: '#fff' }}>
                ✦ Board AI
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          className="ai-btn"
          disabled={testing}
          onClick={async () => {
            setTesting(true);
            try {
              const r = await test.mutateAsync(undefined);
              if (r.ok) toast.success('Connection OK', r.message);
              else toast.error('Connection failed', r.message);
            } catch (err) {
              toast.error('Test failed', extractError(err));
            } finally {
              setTesting(false);
            }
          }}
          data-testid="ai-test-connection"
        >
          {testing && <span className="ai-spin" />} Test connection
        </button>
        {member.paused ? (
          <button type="button" className="ai-btn ai-btn-primary" onClick={() => resume.mutate(undefined)}>
            Resume
          </button>
        ) : (
          <button type="button" className="ai-btn" onClick={() => setPauseDialog(true)}>
            Pause
          </button>
        )}
        <button type="button" className="ai-btn" onClick={() => setPreview(true)} data-testid="ai-preview-as">
          Preview as this AI
        </button>
        <button type="button" className="ai-btn ai-btn-danger-outline" onClick={() => setRemoving(true)}>
          Remove…
        </button>
      </div>
      {member.paused && member.pausedReason && (
        <div className="ai-notice ai-notice-slate" style={{ marginTop: 12 }}>
          {member.pausedReason}. Assigned tickets stay assigned and @mentions are queued, but no run starts.
        </div>
      )}
      <div className="ai-tabs">
        {(['overview', 'configuration', 'permissions', 'usage', 'activity'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`ai-tab ${tab === t ? 'ai-tab-active' : ''}`}
            onClick={() => setTab(t)}
            data-testid={`ai-profile-tab-${t}`}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 18 }}>
        {tab === 'overview' && (
          <Overview
            member={member}
            onOpenTicket={onOpenTicket}
            onEdit={() => setTab('configuration')}
            onPermissions={() => setTab('permissions')}
            onViewOnBoard={onViewOnBoard}
            onConfigure={(f) => {
              setFocus(f);
              setTab('configuration');
            }}
          />
        )}
        {tab === 'configuration' && <Configuration member={member} focus={focus} />}
        {tab === 'permissions' && <Permissions member={member} />}
        {tab === 'usage' && <Usage member={member} onOpenTicket={onOpenTicket} onOpenAudit={onOpenAudit} />}
        {tab === 'activity' && <Activity member={member} projectId={projectId} onOpenTicket={onOpenTicket} />}
      </div>
      {preview && <PreviewDialog member={member} onClose={() => setPreview(false)} />}
      {pauseDialog && <PauseOneDialog member={member} onClose={() => setPauseDialog(false)} />}
      {removing && (
        <RemoveAiDialog member={member} humans={humans} onClose={() => setRemoving(false)} onRemoved={onRemoved} />
      )}
    </div>
  );
}

function PauseOneDialog({ member, onClose }: { member: AiMember; onClose: () => void }) {
  const [cancel, setCancel] = useState(false);
  const pause = useAiMutation(() => aiApi.pause(member.id, { cancelCurrent: cancel }));
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div className="ai-modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">Pause {member.name}</h2>
        </div>
        <div className="ai-modal-body" style={{ gap: 8 }}>
          <button
            type="button"
            className={`ai-option ${!cancel ? 'ai-option-active' : ''}`}
            onClick={() => setCancel(false)}
          >
            <span className={`ai-radio ${!cancel ? 'ai-radio-on' : ''}`} /> Finish the current run, then pause
          </button>
          <button
            type="button"
            className={`ai-option ${cancel ? 'ai-option-active' : ''}`}
            onClick={() => setCancel(true)}
          >
            <span className={`ai-radio ${cancel ? 'ai-radio-on' : ''}`} /> Cancel the current run now
          </button>
          <div className="ai-hint">
            Assigned tickets stay assigned. New work queues. The other agents are not affected.
          </div>
        </div>
        <div className="ai-modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            onClick={async () => {
              await pause.mutateAsync(undefined);
              onClose();
            }}
          >
            Pause
          </button>
        </div>
      </div>
    </div>
  );
}

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="ai-card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10, gap: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, flex: 1 }}>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function Overview({
  member,
  onOpenTicket,
  onEdit,
  onPermissions,
  onConfigure,
  onViewOnBoard,
}: {
  member: AiMember;
  onOpenTicket: (id: string) => void;
  onEdit: () => void;
  onPermissions: () => void;
  onConfigure: (focus: ConfigFocus) => void;
  onViewOnBoard?: (memberId: string) => void;
}) {
  const current = member.running.find((r) => r.state === 'running' || r.state === 'starting');
  const run = useQuery({
    queryKey: aiKeys.run(current?.runId ?? ''),
    queryFn: async () => (await client.get<AiRun>(`/ai/runs/${current?.runId}`)).data,
    enabled: !!current,
    refetchInterval: 1500,
  });
  const runner = useRunnerInfo();
  // “Started 3m 12s ago” counts every second
  useNow(1000, !!current);
  const cancel = useAiMutation((id: string) => aiApi.cancel(id));
  const desktop = !!(window as unknown as { electronAPI?: unknown }).electronAPI;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ConnectionStateCard member={member} onOpenTicket={onOpenTicket} onConfigure={onConfigure} />
      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card
            title="Running now"
            right={
              current && (
                <button
                  type="button"
                  className="ai-btn ai-btn-sm ai-btn-danger-outline"
                  onClick={() => cancel.mutate(current.runId)}
                >
                  Cancel run
                </button>
              )
            }
          >
            {current && run.data ? (
              <>
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
                  data-testid="running-ticket"
                >
                  <button
                    type="button"
                    className="ai-link"
                    style={{ textDecoration: 'none' }}
                    onClick={() => onOpenTicket(current.ticketId)}
                  >
                    <span className="ai-mono">{current.ticketId}</span>
                  </button>
                  {current.ticketTitle && <b style={{ fontSize: 13 }}>{current.ticketTitle}</b>}
                  {current.ticketStatus && (
                    <span className="ai-chip" style={{ background: '#EEF1EE', color: '#5B6B60' }}>
                      {STATUS_NAMES[current.ticketStatus] ?? current.ticketStatus}
                    </span>
                  )}
                  <RunStateChip state={run.data.state} />
                </div>
                <div style={{ marginTop: 10 }}>
                  <RunSteps run={run.data} compact />
                </div>
                <div className="ai-muted" style={{ marginTop: 8 }}>
                  Started {fmtElapsed(secondsSince(run.data.startedAt))} ago by{' '}
                  {run.data.trigger === 'assign' ? 'an assignment from' : 'a request from'} {run.data.startedBy}. Output
                  is trimmed to what the CLI prints; secrets are never logged.
                </div>
              </>
            ) : (
              <div className="ai-hint">
                Nothing right now.
                {member.lastRun && (
                  <>
                    {' '}
                    Last run: <span className="ai-mono">{member.lastRun.ticketId}</span> #{member.lastRun.number},{' '}
                    {member.lastRun.state.replace('_', ' ')} {ago(member.lastRun.endedAt)}.
                  </>
                )}
              </div>
            )}
          </Card>
          <Card
            title={`Assigned tickets  ${member.assigned.length}`}
            right={
              onViewOnBoard && (
                <button
                  type="button"
                  className="ai-link"
                  onClick={() => onViewOnBoard(member.id)}
                  data-testid="view-on-board"
                >
                  View on board
                </button>
              )
            }
          >
            {member.assigned.length === 0 && <div className="ai-hint">No open tickets are assigned to it.</div>}
            {member.assigned.map((t) => (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  gap: 10,
                  padding: '6px 0',
                  borderTop: '1px solid #EEF3EF',
                  alignItems: 'center',
                }}
              >
                <button type="button" className="ai-link ai-mono" onClick={() => onOpenTicket(t.id)}>
                  {t.id}
                </button>
                <span style={{ fontSize: 12.5, flex: 1 }}>{t.title}</span>
                <span className="ai-muted">{STATUS_NAMES[t.status] ?? t.status}</span>
              </div>
            ))}
          </Card>
          <Card title="Limits">
            <dl className="ai-kv">
              <dt>Parallel runs</dt>
              <dd>
                {member.slotsInUse} of {member.maxParallel} in use
                {member.queued ? ` · ${member.queued} queued` : ''}
              </dd>
              {member.connection === 'local' ? (
                <>
                  <dt>Runs today</dt>
                  <dd>
                    {member.usage.runsToday} of {member.maxRunsPerDay ?? '∞'}
                  </dd>
                  <dt>Cost</dt>
                  <dd>Not metered (subscription)</dd>
                </>
              ) : (
                <>
                  <dt>Cost today</dt>
                  <dd>
                    {money(member.usage.costToday)} of {money(member.dailyBudget)}
                  </dd>
                  <dt>This month</dt>
                  <dd>
                    {money(member.usage.costMonth)}
                    {member.monthlyCap != null ? ` of ${money(member.monthlyCap)}` : ''}
                  </dd>
                </>
              )}
            </dl>
          </Card>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title="Connection">
            <dl className="ai-kv">
              <dt>Type</dt>
              <dd>
                {member.connection === 'local' ? 'Local runner' : member.connection === 'api_key' ? 'API key' : 'Inbox'}{' '}
                · {PROVIDERS[member.provider].label}
              </dd>
              {member.connection === 'local' && (
                <>
                  <dt>CLI</dt>
                  <dd>
                    {member.cliVersion
                      ? `${PROVIDERS[member.provider].binary} ${member.cliVersion.split(' ')[0]}`
                      : 'not checked yet'}
                  </dd>
                  <dt>Signed in as</dt>
                  <dd>{member.account ?? '—'}</dd>
                  <dt>Folder</dt>
                  <dd className="ai-mono" style={{ fontSize: 12 }}>
                    {member.workingDir ?? '—'}
                  </dd>
                  {runner.data && (
                    <>
                      <dt>Runner host</dt>
                      <dd data-testid="runner-host">
                        {runner.data.local
                          ? `${runner.data.host} · this computer · ${desktop ? 'desktop app' : 'board server'} ${runner.data.appVersion}`
                          : `${runner.data.host} · desktop app ${runner.data.appVersion}`}
                      </dd>
                    </>
                  )}
                </>
              )}
              {member.connection === 'api_key' && (
                <>
                  <dt>Key</dt>
                  <dd className="ai-mono">••••{member.keyLast4}</dd>
                </>
              )}
              <dt>Model</dt>
              <dd>{member.model ?? '—'}</dd>
            </dl>
            <div className="ai-muted" style={{ marginTop: 8 }}>
              {member.connection === 'local'
                ? 'Uses the CLI’s own login. Kanban holds no token for this AI member.'
                : 'The key is encrypted; only its last 4 characters are ever shown.'}
            </div>
          </Card>
          <Card
            title="Role / persona"
            right={
              <button type="button" className="ai-link" onClick={onEdit}>
                Edit persona
              </button>
            }
          >
            <div className="ai-hint" style={{ whiteSpace: 'pre-wrap' }}>
              {member.persona || 'No persona yet.'}
            </div>
          </Card>
          <Card
            title="Permissions"
            right={
              <button type="button" className="ai-link" onClick={onPermissions}>
                Open Permissions
              </button>
            }
          >
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <CeilingChip ceiling={member.ceiling} />
              <span className="ai-chip" style={{ background: '#EEF2F6', color: '#34455A' }}>
                {member.template.replace('_', '-')} template
              </span>
            </div>
            <div style={{ fontSize: 12.5, marginTop: 8 }} data-testid="approvals-list">
              {member.approvals.length > 0 ? (
                <>
                  <b>Approval:</b> {member.approvals.map((a) => a.label.toLowerCase()).join(', ')}
                </>
              ) : (
                <span className="ai-hint">Nothing waits for a person’s approval.</span>
              )}
            </div>
            <div className="ai-muted" style={{ marginTop: 8 }}>
              Editing rules, approvals and the audit log live in the AI safety & cost views.
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Configuration tab (design/screens/ai-provider-config.md)
// ---------------------------------------------------------------------------

function Configuration({ member, focus }: { member: AiMember; focus?: ConfigFocus }) {
  const toast = useToast();
  const initial = useMemo(
    () => ({
      name: member.name,
      color: member.color,
      glyph: member.glyph,
      persona: member.persona,
      description: member.description,
      workingDir: member.workingDir ?? '',
      model: member.model ?? '',
      maxParallel: member.maxParallel,
      maxRunsPerDay: member.maxRunsPerDay ?? 20,
      dailyBudget: member.dailyBudget ?? 5,
      monthlyCap: member.monthlyCap ?? 0,
      config: member.config,
    }),
    [member],
  );
  const [form, setForm] = useState(initial);
  const [newKey, setNewKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  useEffect(() => setForm(initial), [initial]);
  // Replace key / Raise budget / Choose a model land on the field that fixes the state
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(`cfg-${focus}`);
    el?.scrollIntoView({ block: 'center' });
    el?.focus();
  }, [focus]);
  // Rename: the name is checked against people and the other AI members while typing (case and spaces ignored)
  useEffect(() => {
    const name = form.name.trim();
    if (name === member.name) {
      setNameError(null);
      return;
    }
    if (!name) {
      setNameError('Give it a name');
      return;
    }
    const t = setTimeout(() => {
      aiApi
        .checkName(member.projectId, name, member.id)
        .then((r) => setNameError(r.ok ? null : r.message))
        .catch(() => setNameError(null));
    }, 250);
    return () => clearTimeout(t);
  }, [form.name, member.id, member.name, member.projectId]);
  const save = useAiMutation((body: Record<string, unknown>) => aiApi.update(member.id, body));
  const local = member.connection === 'local';
  const api = member.connection === 'api_key';
  const blocked = !!nameError;

  async function onSave() {
    setError(null);
    try {
      await save.mutateAsync({
        name: form.name.trim() !== member.name ? form.name.trim() : undefined,
        color: form.color !== member.color ? form.color : undefined,
        glyph: form.glyph !== member.glyph ? form.glyph : undefined,
        persona: form.persona,
        description: form.description,
        workingDir: local ? form.workingDir : undefined,
        model: form.model,
        maxParallel: form.maxParallel,
        maxRunsPerDay: local ? form.maxRunsPerDay : undefined,
        dailyBudget: api ? Number(form.dailyBudget) : undefined,
        monthlyCap: api ? Number(form.monthlyCap) || null : undefined,
        apiKey: newKey || undefined,
        config: form.config,
      });
      setNewKey('');
      toast.success('Configuration saved', `${member.name} uses it from its next run.`);
    } catch (err) {
      setError(extractError(err));
    }
  }

  // The groups of the tab come from the adapter (design/screens/ai-provider-config.md); identity stays here
  return (
    <ConfigTab
      member={member}
      form={form}
      initial={initial}
      setForm={setForm}
      newKey={newKey}
      setNewKey={setNewKey}
      onSave={() => void onSave()}
      onDiscard={() => {
        setForm(initial);
        setNewKey('');
      }}
      saving={save.isPending}
      error={error}
      blocked={blocked}
      identity={
        <Card title="Identity">
          <div className="ai-field">
            <span className="ai-label ai-label-dark">Name</span>
            <input
              className={`ai-input ${nameError ? 'ai-input-error' : ''}`}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              data-testid="cfg-name"
            />
            {nameError ? (
              <span className="ai-error-text">{nameError}</span>
            ) : (
              <span className="ai-hint">
                Used for @mentions; unique in this project. Past comments keep the old name.
              </span>
            )}
          </div>
          <div style={{ marginTop: 12 }}>
            <AvatarPicker
              provider={member.provider}
              color={form.color}
              glyph={form.glyph}
              onChange={(look) => setForm({ ...form, ...look })}
            />
          </div>
          <div style={{ marginTop: 12 }}>
            <div className="ai-label">Projects it can work in</div>
            <ProjectsPicker member={member} />
          </div>
        </Card>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Usage and Activity tabs
// ---------------------------------------------------------------------------

function Usage({
  member,
  onOpenTicket,
  onOpenAudit,
}: {
  member: AiMember;
  onOpenTicket: (id: string) => void;
  onOpenAudit?: () => void;
}) {
  const usage = useAiUsage(member.id);
  const u = usage.data;
  if (usage.isError && !u)
    return (
      <div
        className="ai-card"
        style={{ padding: '28px 24px', textAlign: 'center' }}
        role="alert"
        data-testid="usage-error"
      >
        <div style={{ fontSize: 15, fontWeight: 800 }}>Could not load usage</div>
        <div className="ai-hint" style={{ margin: '6px auto 14px', maxWidth: 420 }}>
          The numbers for {member.name} could not be fetched. Nothing was changed.
        </div>
        <button type="button" className="ai-btn" onClick={() => void usage.refetch()}>
          Try again
        </button>
      </div>
    );
  if (!u) return <span className="ai-spin" />;
  const metered = u.metered;
  const max = Math.max(
    ...u.days.map((d) => (metered ? d.costUsd : d.runs)),
    metered ? (u.dailyBudget ?? 0) : 1,
    0.0001,
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="ai-tiles">
        <Tile label="Runs today" value={String(u.runsToday)} sub={`${u.runsLastHour} in the last hour`} />
        <Tile
          label={metered ? 'Tokens today' : 'Run time today'}
          value={
            metered ? `${Math.round((u.tokensInToday + u.tokensOutToday) / 1000)}k` : fmtElapsed(u.secondsToday) || '0s'
          }
          sub={
            metered
              ? `in ${Math.round(u.tokensInToday / 1000)}k · out ${Math.round(u.tokensOutToday / 1000)}k`
              : 'Not metered'
          }
        />
        <Tile
          label="Cost today"
          value={metered ? money(u.costToday) : '—'}
          sub={metered ? `of ${money(u.dailyBudget)} daily budget` : 'Subscription'}
        />
        <Tile
          label="Cost this month"
          value={metered ? money(u.costMonth) : '—'}
          sub={metered && u.monthlyCap ? `of ${money(u.monthlyCap)} cap` : ''}
        />
        <Tile
          label="Success rate"
          value={u.successRateWeek == null ? '—' : `${u.successRateWeek}%`}
          sub="last 7 days"
        />
      </div>
      <Card
        title={metered ? 'Daily cost, last 14 days' : 'Runs per day, last 14 days'}
        right={
          metered && u.dailyBudget ? <span className="ai-muted">Daily budget {money(u.dailyBudget)}</span> : undefined
        }
      >
        <div className="ai-bars">
          {metered && u.dailyBudget ? (
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: `${(u.dailyBudget / max) * 100}%`,
                borderTop: '1.5px dashed #C4432A',
              }}
            />
          ) : null}
          {u.days.map((d) => {
            const v = metered ? d.costUsd : d.runs;
            return (
              <div
                key={d.date}
                className="ai-bar"
                title={`${d.date}: ${metered ? money(v) : `${v} runs`}`}
                style={{ height: `${(v / max) * 100}%` }}
              />
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          {u.days.map((d) => (
            <span key={d.date} className="ai-muted" style={{ flex: 1, textAlign: 'center' }}>
              {Number(d.date.slice(8))}
            </span>
          ))}
        </div>
      </Card>
      <Card
        title="Recent runs"
        right={
          onOpenAudit && (
            <button type="button" className="ai-link" onClick={onOpenAudit} data-testid="full-audit-link">
              Full usage & audit log
            </button>
          )
        }
      >
        <RecentRuns runs={u.recentRuns} metered={metered} onOpenTicket={onOpenTicket} />
      </Card>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="ai-tile">
      <div className="ai-label">{label}</div>
      <div className="ai-tile-v">{value}</div>
      <div className="ai-muted">{sub}</div>
    </div>
  );
}

const k = (n: number) => `${(Math.round(n / 100) / 10).toFixed(1)}k`;

/** A run's failure in a few words for the usage column: “call failed 429”, “timed out”. */
function failureWords(r: AiRun): string {
  const reason = r.endedReason ?? '';
  const code = /\b(4\d\d|5\d\d)\b/.exec(reason)?.[1];
  if (code) return `call failed ${code}`;
  if (r.state === 'timed_out') return 'timed out';
  return reason.replace(/\.$/, '').slice(0, 48) || 'failed';
}

/** Recent runs of a member (Usage tab): when, ticket, what it did, tokens, cost and how it ended. */
function RecentRuns({
  runs,
  metered,
  onOpenTicket,
}: {
  runs: AiRun[];
  metered: boolean;
  onOpenTicket: (id: string) => void;
}) {
  if (!runs.length) return <div className="ai-muted">No runs yet.</div>;
  return (
    <div data-testid="recent-runs">
      {runs.map((r, i) => {
        const failed = r.state === 'failed' || r.state === 'timed_out';
        return (
          <div
            key={r.id}
            data-testid={`recent-run-${r.number}`}
            style={{
              display: 'grid',
              gridTemplateColumns: '96px 78px minmax(0, 1fr) 170px 56px 96px',
              gap: 10,
              alignItems: 'center',
              padding: '9px 0',
              borderTop: i ? '1px solid #EEF3EF' : undefined,
              fontSize: 12.5,
            }}
          >
            <span className="ai-muted">{whenWords(r.startedAt ?? r.queuedAt)}</span>
            <button type="button" className="ai-link ai-mono" onClick={() => onOpenTicket(r.ticketId)}>
              {r.ticketId}
            </button>
            <span
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={r.summary ?? undefined}
            >
              {(r.summary ?? '').split('\n')[0] ||
                `Run #${r.number} · ${r.mode === 'ask' ? 'Ask' : r.trigger.replace('_', ' ')}`}
            </span>
            <span className="ai-muted" style={failed ? { color: '#C4432A' } : undefined}>
              {failed
                ? `— (${failureWords(r)})`
                : metered
                  ? `${k(r.tokensIn)} in · ${k(r.tokensOut)} out`
                  : `${fmtElapsed(r.elapsedS) || '0s'} · not metered`}
            </span>
            <span className="ai-mono">{metered ? money(r.costUsd) : '—'}</span>
            <span>
              <RunStateChip state={r.state} label={r.state === 'finished' ? 'Completed' : undefined} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Activity({
  member,
  projectId,
  onOpenTicket,
}: {
  member: AiMember;
  projectId: string;
  onOpenTicket: (id: string) => void;
}) {
  const audit = useAiAudit(projectId, { memberId: member.id });
  if (audit.isError && !audit.data)
    return <LoadError what="the activity" error={audit.error} onRetry={() => void audit.refetch()} />;
  if (!audit.data) return <span className="ai-spin" />;
  return <AuditTable entries={audit.data.entries} onOpenTicket={onOpenTicket} />;
}
