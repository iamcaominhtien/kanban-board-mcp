import { useEffect, useMemo, useState } from 'react';
import { useAiMutation, useAiOverview } from '../../api/ai';
import { safetyApi, useAiApprovalList, useAiInbox, useApprovalBacklog, useTicketGrants } from '../../api/aiSafety';
import { extractError } from '../../api/extractError';
import type { AiApproval, AiMember } from '../../types/ai';
import type { Member } from '../../types';
import { useToast } from '../Toast';
import { AiAvatar, ago, hhmm } from './aiUi';
import { ChipChoice, Pill, RISK, RadioRow, RiskChip, SafetyCard, TrustChip, expiresIn, shown } from './aiSafetyUi';

type InboxTab = 'mentions' | 'questions' | 'approvals';

/** Inbox (B1): Mentions, Questions and Approvals, with filters, bulk approve and the approval rules. */
export function InboxView({
  projectId,
  humans,
  members,
  onOpenTicket,
  initialTab,
}: {
  projectId: string;
  humans: Member[];
  members: AiMember[];
  onOpenTicket: (id: string) => void;
  initialTab?: InboxTab;
}) {
  const inbox = useAiInbox(projectId);
  const [tab, setTab] = useState<InboxTab>(initialTab ?? 'approvals');
  const [rules, setRules] = useState(false);
  const pending = inbox.data?.approvals ?? 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-testid="ai-inbox">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <b style={{ fontSize: 16, flex: 1 }}>Inbox</b>
        <button type="button" className="ai-link" onClick={() => setRules(!rules)} data-testid="approval-rules-link">
          Approval rules
        </button>
      </div>
      {rules && <ApprovalRules projectId={projectId} humans={humans} />}
      <div className="ai-tabs" role="tablist" style={{ marginTop: 0 }}>
        {(
          [
            ['mentions', 'Mentions', inbox.data?.mentions.length ?? 0],
            ['questions', 'Questions', inbox.data?.questions.length ?? 0],
            ['approvals', 'Approvals', pending],
          ] as const
        ).map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`ai-tab ${tab === id ? 'ai-tab-active' : ''}`}
            onClick={() => setTab(id)}
            data-testid={`inbox-tab-${id}`}
          >
            {label}
            <span className="ai-tab-count">{n}</span>
          </button>
        ))}
      </div>
      {tab === 'mentions' && (
        <div className="ai-card">
          {!inbox.data?.mentions.length && (
            <div className="ai-hint" style={{ padding: 18 }}>
              No AI member has @mentioned you in the last two weeks.
            </div>
          )}
          {inbox.data?.mentions.map((m, i) => (
            <div
              key={m.commentId}
              className="ai-arow"
              style={{ gridTemplateColumns: '1fr auto', borderTop: i ? undefined : 0 }}
              onClick={() => onOpenTicket(m.ticketId)}
            >
              <div>
                <div style={{ fontSize: 13 }}>
                  <b>{m.author}</b> mentioned you on <span className="ai-mono">{m.ticketId}</span> · {m.ticketTitle}
                </div>
                <div className="ai-muted">{m.text.replace(/@\[([^\]]+)\]\(member:[^)]+\)/g, '@$1')}</div>
              </div>
              <span className="ai-muted">{ago(m.at)}</span>
            </div>
          ))}
        </div>
      )}
      {tab === 'questions' && (
        <div className="ai-card">
          {!inbox.data?.questions.length && (
            <div className="ai-hint" style={{ padding: 18 }}>
              No AI member is waiting for an answer.
            </div>
          )}
          {inbox.data?.questions.map((q, i) => (
            <div
              key={q.runId}
              className="ai-arow"
              style={{ gridTemplateColumns: '1fr auto', borderTop: i ? undefined : 0 }}
              onClick={() => onOpenTicket(q.ticketId)}
            >
              <div>
                <div style={{ fontSize: 13 }}>
                  <b>{q.memberName}</b> asks on <span className="ai-mono">{q.ticketId}</span> · {q.ticketTitle}
                </div>
                <div className="ai-muted">“{q.text}”</div>
              </div>
              <span className="ai-muted">{ago(q.askedAt)}</span>
            </div>
          ))}
        </div>
      )}
      {tab === 'approvals' && <ApprovalsTab projectId={projectId} members={members} onOpenTicket={onOpenTicket} />}
    </div>
  );
}

/** Filters, bulk bar, the overflow box and the list of approvals. */
function ApprovalsTab({
  projectId,
  members,
  onOpenTicket,
}: {
  projectId: string;
  members: AiMember[];
  onOpenTicket: (id: string) => void;
}) {
  const [show, setShow] = useState<'pending' | 'decided' | 'all'>('pending');
  const [memberId, setMemberId] = useState('');
  const [risk, setRisk] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [denyBulk, setDenyBulk] = useState<string | null>(null);
  const list = useAiApprovalList(projectId, { memberId, risk });
  const backlog = useApprovalBacklog(projectId);
  const toast = useToast();
  const bulk = useAiMutation((v: { ids: string[]; approve: boolean; note?: string }) =>
    safetyApi.bulk(v.ids, v.approve, v.note),
  );
  const items = useMemo(() => list.data ?? [], [list.data]);
  const pending = items.filter((a) => a.status === 'pending');
  const decided = items.filter((a) => a.status !== 'pending');
  const filtered = !!(memberId || risk);

  useEffect(() => {
    // drop ticks of rows that were decided meanwhile
    setSelected((s) => s.filter((id) => pending.some((a) => a.id === id)));
  }, [pending.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (approve: boolean, note?: string) => {
    try {
      const r = await bulk.mutateAsync({ ids: selected, approve, note });
      const ok = r.filter((x) => x.result === (approve ? 'approved' : 'denied')).length;
      const skipped = r.filter((x) => x.result === 'skipped');
      toast.success(
        `${approve ? 'Approved' : 'Denied'} ${ok} of ${r.length}`,
        skipped.length ? (skipped[0].reason ?? 'Some were skipped.') : undefined,
      );
      setSelected([]);
      setDenyBulk(null);
    } catch (err) {
      toast.error("Couldn't decide", extractError(err));
    }
  };

  const full = (backlog.data?.agents ?? []).filter((a) => a.count >= Math.ceil((backlog.data?.agentLimit ?? 10) * 0.8));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="ai-approvals">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="ai-select-sm" value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
          <option value="pending">Pending · {pending.length}</option>
          <option value="decided">Decided or expired · {decided.length}</option>
          <option value="all">All · {items.length}</option>
        </select>
        <select className="ai-select-sm" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
          <option value="">All agents</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <select className="ai-select-sm" value={risk} onChange={(e) => setRisk(e.target.value)}>
          <option value="">Any risk</option>
          <option value="low">Low risk</option>
          <option value="medium">Medium risk</option>
          <option value="high">High risk</option>
        </select>
        {filtered && (
          <button
            type="button"
            className="ai-link"
            onClick={() => {
              setMemberId('');
              setRisk('');
            }}
          >
            Clear filters
          </button>
        )}
        <span className="ai-muted" style={{ marginLeft: 'auto' }}>
          Soonest to expire first
        </span>
      </div>
      {full.map((a) => (
        <div
          key={a.memberId}
          className="ai-notice ai-notice-warn"
          style={{ alignItems: 'center', flexWrap: 'wrap' }}
          data-testid="approval-backlog"
        >
          <div style={{ flex: 1 }}>
            <b>
              {a.count} approvals waiting for {a.name}
            </b>
            <div>
              {a.count >= (backlog.data?.agentLimit ?? 10)
                ? 'It cannot ask for more until you decide some. New requests are skipped and the AI is told “approvals full”. '
                : 'Close to the limit: at the limit new requests are skipped and the AI is told “approvals full”. '}
              Limits: {backlog.data?.agentLimit} per agent, {backlog.data?.projectLimit} per project.
            </div>
          </div>
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => setOpen(a.oldest)}>
            Review oldest
          </button>
          {a.low.length > 0 && (
            <button
              type="button"
              className="ai-btn ai-btn-sm ai-btn-primary"
              onClick={async () => {
                setSelected(a.low.slice(0, 3));
                try {
                  const r = await bulk.mutateAsync({ ids: a.low.slice(0, 3), approve: true });
                  toast.success(`Approved ${r.filter((x) => x.result === 'approved').length} low risk`);
                  setSelected([]);
                } catch (err) {
                  toast.error("Couldn't approve", extractError(err));
                }
              }}
            >
              Approve {Math.min(3, a.low.length)} low risk
            </button>
          )}
        </div>
      ))}
      {selected.length > 0 && (
        <div className="ai-bulkbar" data-testid="approval-bulkbar">
          <b>{selected.length} selected</b>
          <span className="ai-muted">Low and medium risk only. High risk is decided one by one.</span>
          <span style={{ flex: 1 }} />
          {denyBulk === null ? (
            <>
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                disabled={bulk.isPending}
                onClick={() => void run(true)}
              >
                Approve once
              </button>
              <button type="button" className="ai-btn ai-btn-sm ai-btn-plain" onClick={() => setDenyBulk('')}>
                Deny…
              </button>
            </>
          ) : (
            <>
              <input
                className="ai-input"
                style={{ width: 240, height: 30 }}
                placeholder="Reason for the AI"
                value={denyBulk}
                autoFocus
                onChange={(e) => setDenyBulk(e.target.value)}
              />
              <button
                type="button"
                className="ai-btn ai-btn-sm ai-btn-danger"
                onClick={() => void run(false, denyBulk)}
              >
                Deny
              </button>
            </>
          )}
          <button type="button" className="ai-btn ai-btn-sm ai-btn-clear" onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
      )}
      {list.isLoading ? (
        <div className="ai-skel" style={{ height: 120 }} />
      ) : list.isError ? (
        <div className="ai-notice ai-notice-error">
          Couldn’t load approvals.{' '}
          <button type="button" className="ai-link" onClick={() => void list.refetch()}>
            Retry
          </button>
        </div>
      ) : (
        <>
          {show !== 'decided' && (
            <div className="ai-card">
              {pending.length === 0 && (
                <div className="ai-hint" style={{ padding: 18 }}>
                  {filtered
                    ? 'No pending approvals match these filters.'
                    : 'Nothing waits for a decision. When an AI action needs approval it appears here and on its ticket.'}
                </div>
              )}
              {pending.map((a) => (
                <div key={a.id}>
                  <ApprovalRow
                    a={a}
                    members={members}
                    checked={selected.includes(a.id)}
                    onCheck={(on) => setSelected(on ? [...selected, a.id] : selected.filter((x) => x !== a.id))}
                    onOpen={() => setOpen(open === a.id ? null : a.id)}
                    open={open === a.id}
                  />
                  {open === a.id && (
                    <div style={{ padding: '0 14px 14px', background: '#F6FAF7' }}>
                      <ApprovalCard approval={a} onOpenTicket={onOpenTicket} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {show !== 'pending' && decided.length > 0 && (
            <>
              <div className="ai-label ai-label-dark">Decided or expired · {decided.length}</div>
              <div className="ai-card">
                {decided.map((a) => (
                  <ApprovalRow key={a.id} a={a} members={members} decided onOpen={() => undefined} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ApprovalRow({
  a,
  members,
  checked,
  onCheck,
  onOpen,
  open,
  decided,
}: {
  a: AiApproval;
  members: AiMember[];
  checked?: boolean;
  onCheck?: (on: boolean) => void;
  onOpen: () => void;
  open?: boolean;
  decided?: boolean;
}) {
  const m = members.find((x) => x.id === a.memberId);
  const diff = a.diff?.[0];
  const canTick = !decided && a.risk !== 'high' && a.canDecide !== false;
  const status: Record<string, { bg: string; color: string; text: string }> = {
    approved: { bg: '#F1F8F3', color: '#2E6F40', text: `✓ Approved · ${a.decidedBy ?? ''}` },
    denied: { bg: '#FBEEEA', color: '#C4432A', text: `✕ Denied · ${a.decidedBy ?? ''}` },
    expired: { bg: '#EEF1EE', color: '#5B6B60', text: 'Expired · no decision' },
    failed: { bg: '#FDF0E6', color: '#B4571F', text: 'Approved · not applied' },
    run_ended: { bg: '#EEF2F6', color: '#34455A', text: 'Run ended' },
  };
  return (
    <div
      className={`ai-arow ${checked || open ? 'ai-arow-on' : ''}`}
      onClick={onOpen}
      data-testid={`approval-row-${a.id}`}
      style={decided ? { cursor: 'default' } : undefined}
    >
      <span onClick={(e) => e.stopPropagation()}>
        {!decided && (
          <input
            type="checkbox"
            checked={!!checked}
            disabled={!canTick}
            title={a.risk === 'high' ? 'High risk is decided one by one' : undefined}
            onChange={(e) => onCheck?.(e.target.checked)}
          />
        )}
      </span>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
        {m && <AiAvatar provider={m.provider} size={30} />}
        <div style={{ minWidth: 0 }}>
          <div
            style={{ fontSize: 13, fontWeight: 700, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
          >
            <span>{a.summary}</span>
            {a.ticketId && (
              <span className="ai-mono ai-chip" style={{ background: '#F6FAF7' }}>
                {a.ticketId}
              </span>
            )}
            {diff && (
              <span className="ai-muted" style={{ fontWeight: 400 }}>
                {shown(diff.from)} → {shown(diff.to)}
              </span>
            )}
          </div>
          <div className="ai-muted">
            {a.memberName} · on behalf of {a.onBehalfOf ?? '—'} · {decided ? hhmm(a.requestedAt) : ago(a.requestedAt)}
            {decided && a.decisionNote ? ` · “${a.decisionNote}”` : ''}
          </div>
        </div>
      </div>
      {decided ? (
        <Pill bg={(status[a.status] ?? status.expired).bg} color={(status[a.status] ?? status.expired).color}>
          {(status[a.status] ?? status.expired).text}
        </Pill>
      ) : (
        <RiskChip risk={a.risk} />
      )}
      {!decided && (
        <span className="ai-mono ai-muted" style={{ minWidth: 56, textAlign: 'right' }}>
          {expiresIn(a.expiresAt)}
        </span>
      )}
      {decided && <span />}
    </div>
  );
}

/** Approval card (B2, B3, B6): the diff, the AI’s reason, what triggered it, and the decision. */
export function ApprovalCard({
  approval: a,
  onOpenTicket,
  onDone,
}: {
  approval: AiApproval;
  onOpenTicket?: (id: string) => void;
  onDone?: () => void;
}) {
  const [denyOpen, setDenyOpen] = useState(false);
  const [note, setNote] = useState('');
  const [stopRun, setStopRun] = useState(false);
  const toast = useToast();
  const approve = useAiMutation((v: { remember?: boolean; acceptUpdated?: boolean }) => safetyApi.approve(a.id, v));
  const deny = useAiMutation(() => safetyApi.deny(a.id, note, stopRun));
  const stale = a.stale;
  const lead = a.ticketId ? `${a.ticketId}${a.targetTitle ? ` · ${a.targetTitle}` : ''}` : '';
  const decide = async (v: { remember?: boolean; acceptUpdated?: boolean }) => {
    try {
      const r = await approve.mutateAsync(v);
      if (r.error) toast.error('Approved, but it could not be applied', r.error);
      else toast.success('Approved', 'The board applied the change on behalf of the AI.');
      onDone?.();
    } catch (err) {
      toast.error("Couldn't approve", extractError(err));
    }
  };
  const runLine = a.run
    ? ['running', 'starting'].includes(a.run.state)
      ? `Run #${a.run.number} was told this waits for you and goes on with the rest.`
      : a.run.state === 'needs_input'
        ? `Run #${a.run.number} waits for an answer.`
        : `Run #${a.run.number} has ended; the board applies this when you approve.`
    : null;
  return (
    <div
      className="ai-card"
      style={{ padding: 14, borderColor: '#F0D9A8', display: 'flex', flexDirection: 'column', gap: 10 }}
      data-testid={`approval-${a.id}`}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Approval needed</div>
          {runLine && <div className="ai-muted">{runLine}</div>}
        </div>
        <RiskChip risk={a.risk} />
        {a.status === 'pending' && <Pill>Expires in {expiresIn(a.expiresAt)}</Pill>}
        {a.status === 'run_ended' && (
          <Pill bg="#EEF2F6" color="#34455A">
            Run ended
          </Pill>
        )}
      </div>
      <div style={{ fontSize: 13 }}>
        <b>{a.summary}</b>
        {a.ticketId && onOpenTicket && (
          <>
            {' '}
            <button type="button" className="ai-link ai-mono" onClick={() => onOpenTicket(a.ticketId!)}>
              {lead}
            </button>
          </>
        )}
      </div>
      {stale && (
        <div className="ai-stale" data-testid="approval-stale">
          <b style={{ color: '#8A5A12' }}>Ticket changed since the request</b>
          {stale.fields.map((f) => (
            <div key={f.field} style={{ fontSize: 12.5, marginTop: 4 }}>
              {f.label}: asked <b>{shown(f.asked)}</b>, now <b>{shown(f.now)}</b>
              {f.setBy ? ` (set by ${f.setBy}${f.setAt ? ` ${hhmm(f.setAt)}` : ''})` : ''}
            </div>
          ))}
          <div className="ai-muted" style={{ marginTop: 4 }}>
            Approving never applies a stale change: you approve the updated diff, or deny.
          </div>
        </div>
      )}
      {a.diff && a.diff.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {a.diff.map((d) => (
            <div key={d.field} className="ai-diffrow">
              <span className="ai-muted" style={{ minWidth: 70 }}>
                {d.label}
              </span>
              <span className="ai-diff-from">{shown(d.from)}</span>
              <span>→</span>
              <b>{shown(d.to)}</b>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 12.5 }}>
        <span className="ai-label">Asked by</span> <b>{a.memberName}</b> on behalf of {a.onBehalfOf ?? '—'}
      </div>
      {a.reason && (
        <div>
          <span className="ai-label">Its reason</span>
          <div className="ai-reason">“{a.reason}”</div>
          <div className="ai-muted">AI’s words, not verified</div>
        </div>
      )}
      {a.trigger?.label && (
        <div style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="ai-label">Triggered by</span> {a.trigger.label} <TrustChip trust={a.trigger.trust} />
          {a.runId && <span className="ai-muted">Prompt source: audit log › entry trace</span>}
        </div>
      )}
      {a.status === 'pending' || a.status === 'run_ended' ? (
        <>
          {a.canDecide === false && (
            <div className="ai-notice ai-notice-slate">{a.cannotReason || 'You can’t decide this request.'}</div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {a.status === 'pending' && (
              <>
                <button
                  type="button"
                  className="ai-btn ai-btn-sm ai-btn-primary"
                  disabled={approve.isPending || a.canDecide === false || !!stale}
                  onClick={() => void decide({})}
                  data-testid="approval-approve"
                >
                  Approve once
                </button>
                {stale && (
                  <button
                    type="button"
                    className="ai-btn ai-btn-sm ai-btn-primary"
                    disabled={approve.isPending || a.canDecide === false}
                    onClick={() => void decide({ acceptUpdated: true })}
                    data-testid="approval-approve-updated"
                  >
                    Approve updated change
                  </button>
                )}
                {a.rememberAllowed && !stale && (
                  <button
                    type="button"
                    className="ai-btn ai-btn-sm"
                    disabled={approve.isPending || a.canDecide === false}
                    onClick={() => void decide({ remember: true })}
                    data-testid="approval-remember"
                  >
                    Approve &amp; remember for {a.ticketId}
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              disabled={a.canDecide === false}
              onClick={() => setDenyOpen(!denyOpen)}
            >
              Deny…
            </button>
          </div>
          {a.rememberAllowed && a.status === 'pending' && (
            <div className="ai-muted">
              Remember covers this action on this ticket only, until it reaches Done. It is listed on the ticket and can
              be revoked. Decided by: {a.onBehalfOf ?? 'the assigner'} (assigner), the project owner, or a delegate.
            </div>
          )}
        </>
      ) : (
        <div className="ai-muted">
          {a.status[0].toUpperCase() + a.status.slice(1)}
          {a.decidedBy ? ` by ${a.decidedBy}` : ''}
          {a.decisionNote ? ` · “${a.decisionNote}”` : ''}
        </div>
      )}
      {denyOpen && (
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid #EEF3EF', paddingTop: 10 }}
        >
          <span className="ai-label ai-label-dark">
            Deny: reason for the AI (sent as a comment, saved in the audit log)
          </span>
          <input className="ai-input" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          <div className="ai-chips">
            {['Not now', 'Wrong target', 'Out of scope', 'Needs discussion'].map((q) => (
              <button key={q} type="button" className="ai-choice" onClick={() => setNote(q)}>
                {q}
              </button>
            ))}
          </div>
          {a.runId && (
            <label style={{ display: 'flex', gap: 8, fontSize: 12.5, alignItems: 'center' }}>
              <input type="checkbox" checked={stopRun} onChange={(e) => setStopRun(e.target.checked)} /> Also stop this
              run
            </label>
          )}
          <div>
            <button
              type="button"
              className="ai-btn ai-btn-sm ai-btn-danger"
              disabled={deny.isPending}
              onClick={async () => {
                try {
                  await deny.mutateAsync(undefined);
                  toast.success('Denied', 'The reason was sent to the AI as a comment.');
                  onDone?.();
                } catch (err) {
                  toast.error("Couldn't deny", extractError(err));
                }
              }}
              data-testid="approval-deny-confirm"
            >
              Deny
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** “Remembered” approvals listed on a ticket, revocable until it reaches Done (B2). */
export function RememberedApprovals({ ticketId }: { ticketId: string }) {
  const grants = useTicketGrants(ticketId);
  const toast = useToast();
  const revoke = useAiMutation((id: string) => safetyApi.revokeGrant(id));
  if (!grants.data?.length) return null;
  return (
    <div className="ai-root ai-notice ai-notice-info" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <b>Remembered approvals on this ticket</b>
      {grants.data.map((g) => (
        <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1 }}>
            {g.memberName}: {g.action.replace(/_/g, ' ')} · approved by {g.createdBy} until Done
          </span>
          <button
            type="button"
            className="ai-link"
            onClick={async () => {
              try {
                await revoke.mutateAsync(g.id);
              } catch (err) {
                toast.error("Couldn't revoke", extractError(err));
              }
            }}
          >
            Revoke
          </button>
        </div>
      ))}
    </div>
  );
}

const EXPIRY = [
  [1, '1 h'],
  [4, '4 h'],
  [24, '24 h'],
  [72, '3 days'],
] as const;
const ROLE_OPTIONS = [
  ['member', 'Assigner or any Member'],
  ['admin', 'Assigner, Admin or Owner'],
  ['owner', 'Owner only'],
] as const;

/** Timeout and approvers (B5): expiry, what happens on expiry, who approves by risk, delegates. */
export function ApprovalRules({ projectId, humans }: { projectId: string; humans: Member[] }) {
  const overview = useAiOverview(projectId);
  const toast = useToast();
  const s = overview.data?.settings;
  const [error, setError] = useState<string | null>(null);
  const [del, setDel] = useState({ from: '', to: '', until: '' });
  if (!s) return <span className="ai-spin" />;
  const save = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      await safetyApi.updateSettings(projectId, body);
      void overview.refetch();
    } catch (err) {
      setError(extractError(err));
      toast.error("Couldn't save", extractError(err));
    }
  };
  return (
    <SafetyCard title="Timeout and approvers" sub="Invented defaults" id="approval-rules">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div className="ai-label ai-label-dark">Expires after</div>
          <ChipChoice
            value={s.approvalExpiryHours}
            options={EXPIRY}
            onChange={(h) => void save({ approvalExpiryHours: h })}
          />
        </div>
        <div>
          <div className="ai-label ai-label-dark">When it expires</div>
          <RadioRow
            on={s.approvalOnExpiry === 'skip'}
            onClick={() => void save({ approvalOnExpiry: 'skip' })}
            title="Skip the action; the run goes on, the AI is told"
          />
          <div style={{ height: 6 }} />
          <RadioRow
            on={s.approvalOnExpiry === 'stop'}
            onClick={() => void save({ approvalOnExpiry: 'stop' })}
            title="Stop the run"
          />
        </div>
        <div>
          <div className="ai-label ai-label-dark">Who can approve</div>
          {(['low', 'medium', 'high'] as const).map((r) => (
            <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
              <span style={{ width: 110 }}>
                <Pill bg={RISK[r].bg} color={RISK[r].color}>
                  {RISK[r].label}
                </Pill>
              </span>
              <select
                className="ai-select-sm"
                value={s.approvers[r]}
                onChange={(e) => void save({ approvers: { [r]: e.target.value } })}
                data-testid={`approvers-${r}`}
              >
                {ROLE_OPTIONS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <div>
          <div className="ai-label ai-label-dark">Delegates</div>
          {s.delegates.length === 0 && <div className="ai-muted">Nobody stands in for anyone right now.</div>}
          {s.delegates.map((d, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '3px 0' }}>
              <b>{d.to}</b> is delegate for <b>{d.from}</b>
              {d.until ? ` until ${d.until}` : ''}
              <button
                type="button"
                className="ai-link"
                onClick={() => void save({ delegates: s.delegates.filter((_, j) => j !== i) })}
              >
                Remove
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <select className="ai-select-sm" value={del.to} onChange={(e) => setDel({ ...del, to: e.target.value })}>
              <option value="">Delegate…</option>
              {humans.map((h) => (
                <option key={h.id} value={h.name}>
                  {h.name}
                </option>
              ))}
            </select>
            <select
              className="ai-select-sm"
              value={del.from}
              onChange={(e) => setDel({ ...del, from: e.target.value })}
            >
              <option value="">For…</option>
              {humans.map((h) => (
                <option key={h.id} value={h.name}>
                  {h.name}
                </option>
              ))}
            </select>
            <input
              className="ai-input"
              type="date"
              style={{ width: 150, height: 34 }}
              value={del.until}
              onChange={(e) => setDel({ ...del, until: e.target.value })}
            />
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              disabled={!del.from || !del.to || del.from === del.to}
              onClick={async () => {
                await save({ delegates: [...s.delegates, { from: del.from, to: del.to, until: del.until || null }] });
                setDel({ from: '', to: '', until: '' });
              }}
            >
              Add delegate
            </button>
          </div>
        </div>
        {error && <div className="ai-error-text">{error}</div>}
      </div>
    </SafetyCard>
  );
}
