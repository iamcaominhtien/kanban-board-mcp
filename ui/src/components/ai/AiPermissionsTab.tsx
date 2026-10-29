import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { aiApi, aiKeys, useAiMutation, useAiPermissions } from '../../api/ai';
import { safetyApi } from '../../api/aiSafety';
import { extractError } from '../../api/extractError';
import type { AiMember, PermissionMode } from '../../types/ai';
import { useToast } from '../Toast';
import { LoadError, Toggle, STATUS_NAMES, useAiBoardState } from './aiUi';
import { MODE_LABEL, Pill, SafetyCard, dateTime } from './aiSafetyUi';
import { ProjectsPicker } from './ProjectsPicker';

const CEILING_STEPS = ['none', 'backlog', 'todo', 'in-progress', 'review', 'testing', 'done'];
const RANK: Record<PermissionMode, number> = { allowed: 0, approval: 1, blocked: 2 };
const TEMPLATES = [
  ['developer', 'Developer'],
  ['reviewer', 'Reviewer'],
  ['read_only', 'Read-only'],
  ['custom', 'Custom'],
] as const;
const MODE_STYLE: Record<PermissionMode, { bg: string; color: string }> = {
  allowed: { bg: '#F1F8F3', color: '#2E6F40' },
  approval: { bg: '#FDF5E6', color: '#8A5A12' },
  blocked: { bg: '#FBEEEA', color: '#C4432A' },
};

/** “Preview as this AI” (A1): what it sees, what each action does for it, and the rules it is given. */
export function PreviewDialog({ member, onClose }: { member: AiMember; onClose: () => void }) {
  const q = useQuery({ queryKey: [...aiKeys.all, 'preview', member.id], queryFn: () => safetyApi.preview(member.id) });
  const p = q.data;
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 640, maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Preview as this AI"
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">Preview as {member.name}</h2>
          <div className="ai-hint">What it sees and may do right now. Changes nothing.</div>
        </div>
        <div className="ai-modal-body" style={{ overflow: 'auto' }} data-testid="preview-body">
          {!p && <span className="ai-spin" />}
          {p && (
            <>
              {(p.safeMode || p.paused) && (
                <div className="ai-notice ai-notice-warn">
                  {p.paused ? 'AI is paused: nothing starts.' : 'Safe mode is on: read and comment only.'}
                </div>
              )}
              <div>
                <div className="ai-label ai-label-dark">
                  Tickets it can reach · {p.ticketCount}{' '}
                  {p.scope === 'project' ? '(every open ticket in the project)' : '(assigned to it)'}
                </div>
                {p.tickets.length === 0 && <div className="ai-muted">None right now.</div>}
                {p.tickets.map((t) => (
                  <div key={t.id} style={{ fontSize: 12.5, padding: '2px 0' }}>
                    <span className="ai-mono">{t.id}</span> · {t.title}{' '}
                    <span className="ai-muted">· {STATUS_NAMES[t.status] ?? t.status}</span>
                  </div>
                ))}
                <div className="ai-muted" style={{ marginTop: 4 }}>
                  Outside text:{' '}
                  {p.allowExternal
                    ? 'guest and imported comments are shown, fenced'
                    : 'guest and imported comments are hidden from it'}
                  .
                </div>
              </div>
              <div>
                <div className="ai-label ai-label-dark">What each action does for it</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 4, fontSize: 12.5 }}>
                  {p.may.map((m) => (
                    <div key={m.action} style={{ display: 'contents' }}>
                      <span>{m.label}</span>
                      <Pill bg={MODE_STYLE[m.mode].bg} color={MODE_STYLE[m.mode].color}>
                        {MODE_LABEL[m.mode]}
                      </Pill>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="ai-label ai-label-dark">Statuses it may move a ticket to</div>
                <div className="ai-chips">
                  {p.statusMoves.map((s) => (
                    <Pill
                      key={s.status}
                      bg={s.allowed ? '#F1F8F3' : '#F1F3F2'}
                      color={s.allowed ? '#2E6F40' : '#9AA8A0'}
                    >
                      {s.allowed ? '' : '🔒 '}
                      {s.label}
                    </Pill>
                  ))}
                </div>
              </div>
              <div>
                <div className="ai-label ai-label-dark">The trusted rules it is given</div>
                <div className="ai-term ai-pre">{p.rules}</div>
              </div>
              <div className="ai-muted">
                Web calls by a local runner are limited to: {p.domains.length ? p.domains.join(', ') : 'no domains'}.
              </div>
            </>
          )}
        </div>
        <div className="ai-modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Permissions tab (A1, A3, A4): ceiling, the action matrix with where each mode comes from, template, tester, scope. */
export function Permissions({ member }: { member: AiMember }) {
  const perms = useAiPermissions(member.id);
  const toast = useToast();
  const board = useAiBoardState();
  const [allowDone, setAllowDone] = useState<string | null>(null);
  const [wider, setWider] = useState(false);
  const [ack, setAck] = useState(false);
  const save = useAiMutation((body: Record<string, unknown>) => aiApi.update(member.id, body));
  const decideM = useAiMutation((decision: 'confirm' | 'reject') => aiApi.decidePending(member.id, decision));
  const [tester, setTester] = useState({
    action: 'change_status',
    ticketId: member.assigned[0]?.id ?? '',
    targetStatus: 'done',
  });
  const [verdict, setVerdict] = useState<Awaited<ReturnType<typeof aiApi.testPermission>> | null>(null);
  const [verdictData, setVerdictData] = useState<{ ticket?: { id: string; title: string; status: string } } | null>(
    null,
  );

  async function update(body: Record<string, unknown>) {
    try {
      await save.mutateAsync(body);
      void perms.refetch();
    } catch (err) {
      toast.error("Couldn't change the permission", extractError(err));
    }
  }

  if (perms.isError && !perms.data)
    return <LoadError what="the permissions" error={perms.error} onRetry={() => void perms.refetch()} />;
  if (!perms.data) return <span className="ai-spin" />;
  const data = perms.data;
  const isOwner = data.me.role === 'owner';
  const overrides = Object.fromEntries(data.matrix.filter((r) => r.override).map((r) => [r.action, r.override]));
  const overrideCount = Object.keys(overrides).length;
  const ceilingRank = CEILING_STEPS.indexOf(member.ceiling);
  const project = data.projects[0];
  const tplLabel = TEMPLATES.find((t) => t[0] === member.template)?.[1];

  const pending = member.pendingChange;
  async function decide(decision: 'confirm' | 'reject') {
    try {
      await decideM.mutateAsync(decision);
      void perms.refetch();
      toast.success(decision === 'confirm' ? 'Change confirmed' : 'Change rejected');
    } catch (err) {
      toast.error("Couldn't decide the change", extractError(err));
    }
  }

  return (
    <div className="ai-grid2" style={{ gridTemplateColumns: '1.7fr 1fr' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {pending && (
          <SafetyCard
            title={isOwner ? 'Owner confirmation of a permission change' : 'Waiting for the owner'}
            sub="The old setting stays until the owner confirms; both steps are audited."
          >
            <div data-testid="perm-pending" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13 }}>
                <b>{pending.by}</b> (Admin) wants to change <b>{member.name}</b>
                <span className="ai-muted"> · {dateTime(pending.at)}</span>
              </div>
              {pending.diffs.map((d) => (
                <div key={d.action} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                  <span style={{ minWidth: 150 }}>{d.label}</span>
                  <Pill bg={MODE_STYLE[d.from].bg} color={MODE_STYLE[d.from].color}>
                    {MODE_LABEL[d.from]}
                  </Pill>
                  <span className="ai-muted">→</span>
                  <Pill bg={MODE_STYLE[d.to].bg} color={MODE_STYLE[d.to].color}>
                    {MODE_LABEL[d.to]}
                  </Pill>
                </div>
              ))}
              {isOwner ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="ai-btn ai-btn-sm" onClick={() => void decide('reject')}>
                    Reject
                  </button>
                  <button
                    type="button"
                    className="ai-btn ai-btn-sm ai-btn-primary"
                    onClick={() => void decide('confirm')}
                  >
                    Confirm change
                  </button>
                </div>
              ) : (
                <div className="ai-muted">Only the project owner can confirm it.</div>
              )}
            </div>
          </SafetyCard>
        )}
        <SafetyCard
          title="Status ceiling"
          sub="May move tickets up to. A person decides everything beyond it."
          right={
            <Pill bg="#FDF5E6" color="#8A5A12">
              ⚠ Done needs an extra confirmation
            </Pill>
          }
        >
          <div className="ai-seg" data-testid="ai-ceiling">
            {CEILING_STEPS.map((c, i) => (
              <button
                key={c}
                type="button"
                className={member.ceiling === c ? 'ai-seg-on' : i < ceilingRank ? 'ai-seg-within' : ''}
                onClick={() => (c === 'testing' || c === 'done' ? setAllowDone(c) : void update({ ceiling: c }))}
              >
                {member.ceiling === c && '✓ '}
                {(c === 'testing' || c === 'done') && member.ceiling !== c && '🔒 '}
                {STATUS_NAMES[c]}
              </button>
            ))}
          </div>
          <div className="ai-muted" style={{ marginTop: 8 }}>
            Default for every AI member: <b>Review</b>. Past it, the ticket stays put and the assigner gets the “Move
            blocked” comment.
          </div>
        </SafetyCard>
        <SafetyCard
          title="What it may do"
          sub="Three modes per action. Greyed options are forbidden by the role template or a lock."
          right={
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => update({ permissions: {} })}>
              Reset to template
            </button>
          }
        >
          <div
            className="ai-matrix-head ai-label"
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1.6fr) minmax(0,1fr)',
              gap: 10,
              padding: '4px 0',
            }}
          >
            <span>Action</span>
            <span>Mode</span>
            <span>Where it comes from</span>
          </div>
          {data.matrix.map((row) => {
            const ownerCanEnable = row.action === 'delete_tickets' && isOwner;
            return (
              <div key={row.action} className="ai-matrix-row" data-testid={`perm-${row.action}`}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{row.label}</div>
                  <div className="ai-muted">{row.description}</div>
                </div>
                <div className="ai-seg">
                  {(['allowed', 'approval', 'blocked'] as PermissionMode[]).map((mode) => {
                    const looser =
                      member.template !== 'custom' &&
                      RANK[mode] < RANK[row.templateMode] &&
                      !(ownerCanEnable && mode === 'approval');
                    const locked = row.lockedMin && RANK[mode] < RANK[row.lockedMin];
                    return (
                      <button
                        key={mode}
                        type="button"
                        disabled={!!(looser || locked)}
                        title={
                          locked
                            ? 'Locked: an AI may never be allowed this without approval'
                            : looser
                              ? 'The role template forbids this'
                              : undefined
                        }
                        className={row.mode === mode ? 'ai-seg-on' : ''}
                        onClick={() => void update({ permissions: { ...overrides, [row.action]: mode } })}
                        data-testid={`perm-${row.action}-${mode}`}
                      >
                        {locked ? '🔒 ' : ''}
                        {MODE_LABEL[mode]}
                      </button>
                    );
                  })}
                </div>
                <div className="ai-chips" style={{ alignItems: 'center' }} data-testid={`perm-source-${row.action}`}>
                  {row.ownerEnabled ? (
                    <Pill bg="#F1F8F3" color="#2E6F40" title={row.sourceBy ? `Enabled by ${row.sourceBy}` : undefined}>
                      Owner-enabled
                      {row.sourceAt
                        ? ` ${new Date(row.sourceAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
                        : ''}
                    </Pill>
                  ) : row.override ? (
                    <Pill bg="#E8F1FA" color="#2F6FB0">
                      Override · stricter
                    </Pill>
                  ) : (
                    <Pill>{tplLabel}</Pill>
                  )}
                  {row.ceilingNote && !row.override && (
                    <span className="ai-mono ai-muted" style={{ fontSize: 11.5 }}>
                      ≤ {STATUS_NAMES[row.ceilingNote] ?? row.ceilingNote}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          <div className="ai-matrix-row" style={{ opacity: 0.7 }} data-testid="perm-run-tools">
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Run commands and tools via the runner</div>
              <div className="ai-muted">
                {member.connection === 'local'
                  ? 'Shell, files, network: decided by the CLI (see below)'
                  : 'The API agent only gets the board tools its tool groups allow'}
              </div>
            </div>
            <div className="ai-seg">
              {(['allowed', 'approval', 'blocked'] as PermissionMode[]).map((m) => (
                <button key={m} type="button" disabled>
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
            <div>
              <Pill bg="#FDF0E6" color="#B4571F">
                {member.connection === 'local' ? 'Set in the CLI' : 'Set by tool groups'}
              </Pill>
            </div>
          </div>
        </SafetyCard>
        <SafetyCard
          title="Safe mode for this agent"
          sub="Read and comment only. Every other board action is blocked; a local runner's CLI also loses Edit, Write, Bash and the web."
          right={
            <Toggle
              on={member.safeMode}
              label="Safe mode for this agent"
              testId="agent-safe-mode"
              onChange={(v) => void update({ safeMode: v })}
            />
          }
        >
          {data.safeMode && <div className="ai-muted">Safe mode is also on for the whole project.</div>}
        </SafetyCard>
        {member.connection === 'local' && (
          <SafetyCard
            title="Runner-side permissions"
            sub="What this local runner can and cannot be stopped from doing"
            right={
              <Pill bg="#EEF2F6" color="#34455A">
                Set in the CLI
              </Pill>
            }
          >
            <div className="ai-notice ai-notice-warn">
              <div>
                <b>The board is not a sandbox.</b> It controls only what goes through its MCP server and API. Claude
                Code also has its own tools (shell, files, web) under its own settings. The board writes allow and deny
                rules before each run but cannot check the CLI honours them.
              </div>
            </div>
            <div className="ai-grid2" style={{ marginTop: 10, fontSize: 12.5 }}>
              <div>
                <div className="ai-label ai-label-dark">Board enforces</div>
                {[
                  'Every board action in the matrix',
                  'Status ceiling and approvals',
                  'Runs per day, kill switch',
                  'Cancelling the process',
                ].map((t) => (
                  <div key={t} style={{ color: '#2E6F40', padding: '3px 0' }}>
                    ✓ <span style={{ color: '#1E2A22' }}>{t}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="ai-label ai-label-dark">Only the CLI controls</div>
                {[
                  'Shell commands, git push',
                  `Files in ${member.workingDir ?? 'the working folder'}`,
                  'Network calls by the CLI',
                  'Other MCP servers in the CLI',
                ].map((t) => (
                  <div key={t} style={{ color: '#C4432A', padding: '3px 0' }}>
                    ✕ <span style={{ color: '#1E2A22' }}>{t}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="ai-muted" style={{ marginTop: 8 }}>
              Edit allow / deny rules in Configuration › Permissions (CLI tool rules).
            </div>
          </SafetyCard>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SafetyCard title="Role template" sub="Starting point; workspace defaults are in Safety › Workspace defaults">
          <div className="ai-chips">
            {TEMPLATES.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`ai-choice ${member.template === id ? 'ai-choice-on' : ''}`}
                disabled={id === 'custom' && !isOwner && member.template !== 'custom'}
                title={id === 'custom' && !isOwner ? 'Custom needs an owner' : undefined}
                onClick={() => void update({ template: id, permissions: {} })}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="ai-muted" style={{ marginTop: 8 }} data-testid="template-text">
            <b style={{ color: '#1E2A22' }}>{tplLabel}</b>
            {overrideCount ? ` + ${overrideCount} override${overrideCount === 1 ? '' : 's'}` : ''}
            {overrideCount ? ` (${data.overrideLabels.map((l) => l.toLowerCase()).join(', ')})` : ''}. Custom unlocks
            wider settings and needs an owner.
          </div>
        </SafetyCard>
        <SafetyCard title="Can this AI do X on a ticket?" sub="Effective-permission tester; changes nothing">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="ai-grid2" style={{ gap: 8 }}>
              <label className="ai-field">
                <span className="ai-label">Action</span>
                <select
                  className="ai-select-sm"
                  value={tester.action}
                  onChange={(e) => setTester({ ...tester, action: e.target.value })}
                >
                  {data.matrix.map((r) => (
                    <option key={r.action} value={r.action}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ai-field">
                <span className="ai-label">Ticket</span>
                <select
                  className="ai-select-sm"
                  value={tester.ticketId}
                  onChange={(e) => setTester({ ...tester, ticketId: e.target.value })}
                >
                  <option value="">No ticket</option>
                  {member.assigned.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.id} · {STATUS_NAMES[t.status] ?? t.status}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {tester.action === 'change_status' && (
              <select
                className="ai-select-sm"
                value={tester.targetStatus}
                onChange={(e) => setTester({ ...tester, targetStatus: e.target.value })}
              >
                {CEILING_STEPS.slice(1).map((s) => (
                  <option key={s} value={s}>
                    → {STATUS_NAMES[s]}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              data-testid="tester-check"
              onClick={async () => {
                try {
                  const r = await aiApi.testPermission(member.id, {
                    action: tester.action,
                    ticketId: tester.ticketId || undefined,
                    targetStatus: tester.targetStatus,
                  });
                  setVerdict(r);
                  setVerdictData(r as unknown as { ticket?: { id: string; title: string; status: string } });
                } catch (err) {
                  toast.error('Tester failed', extractError(err));
                }
              }}
            >
              Check
            </button>
          </div>
          {verdict && (
            <div style={{ marginTop: 10 }} data-testid="tester-result">
              <div
                className="ai-notice"
                style={{
                  background: MODE_STYLE[verdict.verdict as PermissionMode]?.bg,
                  color: MODE_STYLE[verdict.verdict as PermissionMode]?.color,
                  flexDirection: 'column',
                  alignItems: 'stretch',
                }}
              >
                <b>{MODE_LABEL[verdict.verdict] ?? verdict.verdict}</b>
                <span style={{ color: '#1E2A22' }}>{verdict.reason}</span>
                {verdictData?.ticket && (
                  <span className="ai-muted">
                    {verdictData.ticket.id} is in {STATUS_NAMES[verdictData.ticket.status] ?? verdictData.ticket.status}
                    .
                  </span>
                )}
              </div>
              {verdict.checks.map((c, i) => (
                <div key={i} className="ai-checkrow" style={{ color: c.ok ? '#2E6F40' : '#C4432A' }}>
                  <span>{c.ok ? '✓' : '✕'}</span>
                  <span style={{ color: '#1E2A22' }}>
                    <b>{c.label}</b>
                    <span className="ai-muted"> · {c.note ?? MODE_LABEL[c.mode] ?? c.mode}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </SafetyCard>
        <SafetyCard title="Scope" sub="Where these permissions apply">
          <div style={{ marginBottom: 8 }}>
            <ProjectsPicker member={member} />
          </div>
          {(
            [
              ['assigned', 'Only tickets assigned to it', ', or where a member @mentions it'],
              ['project', 'Any ticket in these projects', 'wider: owner confirms'],
            ] as const
          ).map(([id, label, sub]) => (
            <button
              key={id}
              type="button"
              className={`ai-option ${member.scope === id ? 'ai-option-active' : ''}`}
              style={{ marginBottom: 6 }}
              onClick={() =>
                id === 'project' && member.scope !== 'project' ? setWider(true) : void update({ scope: id })
              }
              data-testid={`scope-${id}`}
            >
              <span className={`ai-radio ${member.scope === id ? 'ai-radio-on' : ''}`} />
              <span style={{ textAlign: 'left' }}>
                <b style={{ fontSize: 12.5 }}>{label}</b>
                <span className="ai-muted" style={{ color: id === 'project' ? '#B4571F' : undefined }}>
                  {' '}
                  {sub}
                </span>
              </span>
            </button>
          ))}
        </SafetyCard>
        <SafetyCard
          title="Change history"
          right={
            board.openAiTab && (
              <button
                type="button"
                className="ai-link"
                onClick={() => board.openAiTab?.('audit', { memberId: member.id })}
                data-testid="history-open-audit"
              >
                Open in audit log
              </button>
            )
          }
        >
          {data.history.length === 0 && <div className="ai-muted">No changes yet.</div>}
          {data.history.map((h) => (
            <div
              key={h.id}
              style={{ fontSize: 12.5, padding: '6px 0', borderTop: '1px solid #EEF3EF' }}
              data-testid="history-row"
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="ai-muted">{dateTime(h.at)}</span>
                <b>{h.by ?? '—'}</b>
                {h.byRole && <span className="ai-muted">{h.byRole[0].toUpperCase() + h.byRole.slice(1)}</span>}
              </div>
              {h.kind === 'created' ? (
                <div>
                  created with template {TEMPLATES.find((t) => t[0] === h.template)?.[1] ?? h.template ?? ''}
                  {h.ceiling ? ` · Ceiling ${STATUS_NAMES[h.ceiling] ?? h.ceiling}` : ''}
                </div>
              ) : (
                <>
                  {h.diffs.map((d) => (
                    <div key={d.action}>
                      {d.label}: {MODE_LABEL[d.from ?? ''] ?? d.from} → {MODE_LABEL[d.to ?? ''] ?? d.to}
                    </div>
                  ))}
                  {h.other.map((o) => (
                    <div key={o.label}>
                      {o.label}: {String(o.from)} → {String(o.to)}
                    </div>
                  ))}
                </>
              )}
            </div>
          ))}
        </SafetyCard>
      </div>
      {allowDone && (
        <ConfirmDialog
          title={`Allow ${member.name} to move tickets to ${STATUS_NAMES[allowDone]}?`}
          ownerOnly={!isOwner}
          onClose={() => {
            setAllowDone(null);
            setAck(false);
          }}
          confirmLabel={`Allow ${STATUS_NAMES[allowDone]}`}
          disabled={!ack || !isOwner}
          onConfirm={async () => {
            await update({ ceiling: allowDone, confirmDone: true });
            setAllowDone(null);
            setAck(false);
          }}
        >
          <div className="ai-hint">
            A person decides Done by default. If you allow it, tickets can reach Done without anyone checking.
          </div>
          <div className="ai-notice ai-notice-warn">
            Tickets it closes get an <b>AI-completed</b> badge on cards, in the header and in Activity, so it is never
            mistaken for a human approval.
          </div>
          <label style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              data-testid="allow-done-ack"
            />
            I understand nobody reviews these tickets first
          </label>
        </ConfirmDialog>
      )}
      {wider && (
        <ConfirmDialog
          title={`Let ${member.name} work on any ticket in ${project?.name}?`}
          ownerOnly={!isOwner}
          onClose={() => setWider(false)}
          confirmLabel="Allow every ticket"
          disabled={!isOwner}
          onConfirm={async () => {
            await update({ scope: 'project' });
            setWider(false);
          }}
        >
          <div className="ai-hint">
            Today it only touches tickets assigned to it or created by its run. With every ticket in scope, a fooled or
            mistaken run can change any of them, within the matrix above.
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}

function ConfirmDialog({
  title,
  children,
  ownerOnly,
  onClose,
  onConfirm,
  confirmLabel,
  disabled,
}: {
  title: string;
  children: React.ReactNode;
  ownerOnly: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  confirmLabel: string;
  disabled: boolean;
}) {
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 460 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">{title}</h2>
        </div>
        <div className="ai-modal-body">
          {children}
          {ownerOnly && (
            <div className="ai-notice ai-notice-error">
              Only the project owner can confirm this. Ask them to make the change.
            </div>
          )}
        </div>
        <div className="ai-modal-foot">
          <span className="ai-muted" style={{ flex: 1 }}>
            Owners only · audited
          </span>
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={disabled}
            onClick={() => void onConfirm()}
            data-testid="confirm-owner"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
