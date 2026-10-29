import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { aiApi, useAiMutation, useAiOverview } from '../../api/ai';
import {
  auditExportQuery,
  fetchAudit,
  safetyApi,
  type AuditFilters,
  type RevertPreviewRow,
  type WhyBlocked,
} from '../../api/aiSafety';
import { extractError } from '../../api/extractError';
import { resolveOrigin } from '../../api/resolveOrigin';
import type { AiAuditEntry, AiMember } from '../../types/ai';
import { useToast } from '../Toast';
import { AiAvatar } from './aiUi';
import {
  ACTION_LABEL,
  ChipChoice,
  Pill,
  ResultChip,
  RESULT_STYLE,
  SafetyCard,
  TrustChip,
  dateTime,
  shown,
  snake,
  usd,
} from './aiSafetyUi';

const ACTIONS = [
  'change_status',
  'edit_fields',
  'change_assignee',
  'create_tickets',
  'delete_tickets',
  'edit_docs',
  'comment',
  'manage_test_cases',
  'create_branches',
  'raise_cap',
  'mention',
  'kill_switch',
  'resume_all',
  'member_updated',
];
const DATES = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['all', 'All time'],
] as const;
const RETENTION = [
  [30, '30 days'],
  [90, '90 days'],
  [365, '1 year'],
  [0, 'Forever'],
] as const;

function localDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function targetText(e: AiAuditEntry): string {
  const d = e.detail as { after?: Record<string, unknown>; request?: Record<string, unknown> };
  if (d.after)
    return Object.entries(d.after)
      .map(([k, v]) => (k === 'status' || k === 'assignee' ? `→ ${shown(v)}` : k))
      .join(', ');
  const status = d.request?.status;
  if (typeof status === 'string') return `→ ${status}`;
  return '';
}

function isRevertable(e: AiAuditEntry): boolean {
  return !!(e.detail as { before?: unknown }).before && !e.revertedAt && ['allowed', 'approved'].includes(e.result);
}

function useAuditPages(projectId: string, f: AuditFilters) {
  const first = useQuery({
    queryKey: ['ai', 'audit', projectId, 'page', f],
    queryFn: () => fetchAudit(projectId, f),
    enabled: !!projectId,
    refetchInterval: 12000,
  });
  const [older, setOlder] = useState<AiAuditEntry[]>([]);
  const [more, setMore] = useState<{ has: boolean; before: number | null } | null>(null);
  const key = JSON.stringify(f);
  useEffect(() => {
    setOlder([]);
    setMore(null);
  }, [key]);
  const entries = useMemo(() => {
    const ids = new Set((first.data?.entries ?? []).map((e) => e.id));
    return [...(first.data?.entries ?? []), ...older.filter((e) => !ids.has(e.id))];
  }, [first.data, older]);
  const has = more ? more.has : (first.data?.hasMore ?? false);
  const before = more ? more.before : (first.data?.nextBefore ?? null);
  const [loading, setLoading] = useState(false);
  const loadOlder = async () => {
    if (before == null) return;
    setLoading(true);
    try {
      const page = await fetchAudit(projectId, f, before);
      setOlder((o) => [...o, ...page.entries]);
      setMore({ has: page.hasMore, before: page.nextBefore });
    } finally {
      setLoading(false);
    }
  };
  return { first, entries, has, loadOlder, loading };
}

/** Full audit log page (E1): filters, counters, bulk revert, the drawer, retention and filtered export. */
export function AuditView({
  projectId,
  members,
  onOpenTicket,
  initial,
}: {
  projectId: string;
  members: AiMember[];
  onOpenTicket: (id: string) => void;
  initial?: Partial<AuditFilters> & { date?: string };
}) {
  const [memberId, setMemberId] = useState(initial?.memberId ?? '');
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const [date, setDate] = useState<'today' | '7d' | '30d' | 'all'>('all');
  const [result, setResult] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [showRetention, setShowRetention] = useState(false);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; brokenAt: string | null; checked: number } | null>(null);
  const since = date === 'all' ? undefined : localDay(date === 'today' ? 0 : date === '7d' ? 6 : 29);
  const filters: AuditFilters = {
    memberId,
    actions: action || undefined,
    q: q.trim() || undefined,
    since,
    runId: initial?.runId,
  };
  const { first, entries, has, loadOlder, loading } = useAuditPages(projectId, { ...filters, result });
  const counts = first.data?.counts ?? {};
  const total = first.data?.total ?? 0;
  const filtered = !!(memberId || action || q || date !== 'all' || result);
  const revertable = entries.filter(isRevertable);
  const selectedRuns = new Set(entries.filter((e) => selected.includes(e.id)).map((e) => e.runId));
  const clear = () => {
    setMemberId('');
    setAction('');
    setQ('');
    setDate('all');
    setResult('');
  };
  const exportQs = auditExportQuery({ ...filters, result }, 'csv');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="ai-audit">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <b style={{ fontSize: 16 }}>AI audit log</b>
          <div className="ai-muted">append-only · secrets redacted · hash-chained</div>
        </div>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          onClick={async () => setVerify(await aiApi.verifyAudit(projectId))}
        >
          Check integrity
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          onClick={() => setShowRetention(!showRetention)}
          data-testid="audit-retention"
        >
          Retention:{' '}
          {first.data?.retentionDays
            ? `${first.data.retentionDays === 365 ? '1 year' : `${first.data.retentionDays} days`}`
            : 'Forever'}
        </button>
        <a
          className="ai-btn ai-btn-sm"
          href={`${resolveOrigin()}/projects/${projectId}/ai/audit/export?${exportQs}`}
          data-testid="audit-export"
        >
          Export{filtered ? ' filtered' : ''}
        </a>
      </div>
      {showRetention && <RetentionCard projectId={projectId} exportQs={exportQs} />}
      {verify && (
        <div className={`ai-notice ${verify.ok ? 'ai-notice-info' : 'ai-notice-error'}`}>
          {verify.ok
            ? `Chain intact: ${verify.checked} entries checked.`
            : `Tampering detected at entry ${verify.brokenAt}.`}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          className="ai-select-sm"
          value={memberId}
          onChange={(e) => setMemberId(e.target.value)}
          data-testid="audit-agent"
        >
          <option value="">All agents</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <select
          className="ai-select-sm"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          data-testid="audit-action"
        >
          <option value="">Any action</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {ACTION_LABEL[a] ?? a}
            </option>
          ))}
        </select>
        <input
          className="ai-input"
          style={{ width: 130, height: 34 }}
          placeholder="KAN-…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="audit-ticket"
        />
        <select
          className="ai-select-sm"
          value={date}
          onChange={(e) => setDate(e.target.value as typeof date)}
          data-testid="audit-date"
        >
          {DATES.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <div className="ai-chips">
          {[
            ['', 'All'],
            ['allowed', 'Allowed'],
            ['approved', 'Approved'],
            ['denied', 'Denied'],
            ['blocked', 'Blocked'],
            ['reverted', 'Reverted'],
          ].map(([r, label]) => (
            <button
              key={r || 'all'}
              type="button"
              className={`ai-choice ${result === r ? 'ai-choice-on' : ''}`}
              onClick={() => setResult(r)}
            >
              {label} <span className="ai-muted">{r ? (counts[r] ?? 0) : total}</span>
            </button>
          ))}
        </div>
      </div>
      {selected.length > 0 && (
        <div className="ai-bulkbar" data-testid="audit-bulkbar">
          <b>{selected.length} selected</b>
          <span className="ai-muted">
            by {selectedRuns.size} run{selectedRuns.size === 1 ? '' : 's'}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            onClick={() => setPreview(selected)}
            data-testid="audit-revert-selected"
          >
            Revert selected…
          </button>
          <button type="button" className="ai-btn ai-btn-sm ai-btn-clear" onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
      )}
      {first.isLoading ? (
        <div className="ai-card" style={{ padding: 16 }} aria-busy="true">
          <div className="ai-skel" style={{ height: 14, width: '60%', marginBottom: 10 }} />
          <div className="ai-skel" style={{ height: 14, width: '80%' }} />
        </div>
      ) : first.isError ? (
        <div className="ai-notice ai-notice-error">
          <div style={{ flex: 1 }}>
            <b>Couldn’t load the audit log</b>
            <div>The entries are safe; only this view failed.</div>
          </div>
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => void first.refetch()}>
            Retry
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: open ? 'minmax(0,1fr) 380px' : '1fr', gap: 14 }}>
          <div className="ai-card" style={{ overflow: 'auto' }}>
            <EntryTable
              entries={entries}
              members={members}
              onOpenTicket={onOpenTicket}
              selected={selected}
              onSelect={setSelected}
              open={open}
              onOpen={setOpen}
              revertableIds={revertable.map((e) => e.id)}
              empty={
                <div style={{ padding: 18 }} data-testid="audit-empty">
                  <b>No AI actions match</b>
                  <div className="ai-hint">
                    Try another range or clear filters. With no filters it means no AI has acted yet.
                  </div>
                  {filtered && (
                    <button type="button" className="ai-link" onClick={clear}>
                      Clear filters
                    </button>
                  )}
                </div>
              }
            />
            <div
              style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', borderTop: '1px solid #EEF3EF' }}
            >
              <span className="ai-muted">
                Showing {entries.length} of {result ? (counts[result] ?? 0) : total}
              </span>
              <span style={{ flex: 1 }} />
              {has && (
                <button
                  type="button"
                  className="ai-link"
                  disabled={loading}
                  onClick={() => void loadOlder()}
                  data-testid="audit-load-older"
                >
                  {loading ? 'Loading…' : 'Load older'}
                </button>
              )}
            </div>
          </div>
          {open && (
            <AuditDrawer
              entryId={open}
              onClose={() => setOpen(null)}
              onOpenTicket={onOpenTicket}
              onRevertRun={(ids) => setPreview(ids)}
            />
          )}
        </div>
      )}
      {preview && (
        <RevertPreviewDialog
          ids={preview}
          onClose={() => setPreview(null)}
          onDone={() => {
            setPreview(null);
            setSelected([]);
          }}
        />
      )}
    </div>
  );
}

function EntryTable({
  entries,
  members,
  onOpenTicket,
  selected,
  onSelect,
  open,
  onOpen,
  revertableIds,
  empty,
}: {
  entries: AiAuditEntry[];
  members: AiMember[];
  onOpenTicket: (id: string) => void;
  selected?: string[];
  onSelect?: (ids: string[]) => void;
  open: string | null;
  onOpen: (id: string | null) => void;
  revertableIds: string[];
  empty: React.ReactNode;
}) {
  if (!entries.length) return <>{empty}</>;
  const allOn = revertableIds.length > 0 && revertableIds.every((id) => selected?.includes(id));
  return (
    <table className="ai-table" data-testid="audit-table">
      <thead>
        <tr>
          {onSelect && (
            <th style={{ width: 28 }}>
              <input
                type="checkbox"
                checked={allOn}
                disabled={!revertableIds.length}
                onChange={(e) => onSelect(e.target.checked ? revertableIds : [])}
                aria-label="Select all revertable"
              />
            </th>
          )}
          <th>Time</th>
          <th>AI · on behalf of</th>
          <th>Action</th>
          <th>Target</th>
          <th>Result</th>
          <th>Run</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const m = members.find((x) => x.id === e.memberId);
          return (
            <tr
              key={e.id}
              onClick={() => onOpen(open === e.id ? null : e.id)}
              style={{ cursor: 'pointer', background: open === e.id ? '#F6FAF7' : undefined }}
              data-testid={`audit-row-${e.id}`}
            >
              {onSelect && (
                <td onClick={(ev) => ev.stopPropagation()}>
                  <input
                    type="checkbox"
                    disabled={!isRevertable(e)}
                    checked={selected?.includes(e.id) ?? false}
                    onChange={(ev) =>
                      onSelect(
                        ev.target.checked ? [...(selected ?? []), e.id] : (selected ?? []).filter((x) => x !== e.id),
                      )
                    }
                  />
                </td>
              )}
              <td className="ai-mono" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                {new Date(e.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false,
                })}
              </td>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {m && <AiAvatar provider={m.provider} size={22} />}
                  <div>
                    <div style={{ fontWeight: 600 }}>{e.memberName || '—'}</div>
                    {e.onBehalfOf && <div className="ai-muted">on behalf of {e.onBehalfOf}</div>}
                  </div>
                </div>
              </td>
              <td>{ACTION_LABEL[e.action] ?? e.action}</td>
              <td>
                {e.target && (
                  <button
                    type="button"
                    className="ai-link ai-mono"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onOpenTicket(e.target!);
                    }}
                  >
                    {e.target}
                  </button>
                )}{' '}
                <span className="ai-muted">{targetText(e)}</span>
              </td>
              <td>
                <ResultChip result={e.result} reverted={!!e.revertedAt} />
              </td>
              <td className="ai-mono">{e.runNumber ? `#${e.runNumber}` : '—'}</td>
              <td className="ai-mono">{e.runCost ? usd(e.runCost) : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Audit rows for a list of entries without filters (the profile’s Activity tab). */
export function AuditTable({
  entries,
  onOpenTicket,
  selected,
  onSelect,
}: {
  entries: AiAuditEntry[];
  onOpenTicket: (id: string) => void;
  selected?: string[];
  onSelect?: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: open ? 'minmax(0,1fr) 380px' : '1fr', gap: 14 }}>
      <div className="ai-card" style={{ overflow: 'auto' }}>
        <EntryTable
          entries={entries}
          members={[]}
          onOpenTicket={onOpenTicket}
          selected={selected}
          onSelect={onSelect}
          open={open}
          onOpen={setOpen}
          revertableIds={entries.filter(isRevertable).map((e) => e.id)}
          empty={
            <div style={{ padding: 18 }}>
              <b>No AI actions match</b>
              <div className="ai-hint">Nothing was recorded for this AI member yet.</div>
            </div>
          }
        />
      </div>
      {open && (
        <AuditDrawer
          entryId={open}
          onClose={() => setOpen(null)}
          onOpenTicket={onOpenTicket}
          onRevertRun={() => undefined}
        />
      )}
    </div>
  );
}

/** The detail drawer (E1): request as received, before and after, approval line, prompt-source trace. */
function AuditDrawer({
  entryId,
  onClose,
  onOpenTicket,
  onRevertRun,
}: {
  entryId: string;
  onClose: () => void;
  onOpenTicket: (id: string) => void;
  onRevertRun: (ids: string[]) => void;
}) {
  const q = useQuery({ queryKey: ['ai', 'audit-entry', entryId], queryFn: () => safetyApi.auditEntry(entryId) });
  const toast = useToast();
  const revert = useAiMutation(() => aiApi.revertEntries([entryId]));
  const [runPreview, setRunPreview] = useState<{ ids: string[] } | null>(null);
  const e = q.data;
  if (!e)
    return (
      <div className="ai-card ai-drawer">
        <span className="ai-spin" />
      </div>
    );
  const d = e.detail as {
    request?: Record<string, unknown>;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    reason?: string;
    code?: string;
  };
  const canRevert = isRevertable(e);
  return (
    <div className="ai-card ai-drawer" data-testid="audit-drawer">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ flex: 1, fontSize: 15 }}>{ACTION_LABEL[e.action] ?? e.action}</b>
        <ResultChip result={e.result} reverted={!!e.revertedAt} />
        <button type="button" className="ai-icobtn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="ai-muted">
        {e.target && (
          <button type="button" className="ai-link ai-mono" onClick={() => onOpenTicket(e.target!)}>
            {e.target}
          </button>
        )}{' '}
        {new Date(e.createdAt).toLocaleTimeString([], { hour12: false })} · entry {e.id}
      </div>
      {d.request && (
        <>
          <div className="ai-label ai-label-dark">Request, as received</div>
          <div className="ai-term" style={{ fontSize: 11 }}>
            {Object.entries(d.request)
              .map(([k, v]) => `${snake(k).padEnd(10)} ${typeof v === 'string' ? v : JSON.stringify(v)}`)
              .join('\n')}
          </div>
        </>
      )}
      {!!e.redactions && (
        <Pill>
          🛡 {e.redactions} secret{e.redactions === 1 ? '' : 's'} redacted
        </Pill>
      )}
      {d.before && d.after && (
        <>
          <div className="ai-label ai-label-dark">Before and after</div>
          {Object.keys(d.before).map((k) => (
            <div key={k} className="ai-diffrow">
              <span className="ai-muted" style={{ minWidth: 64 }}>
                {k}
              </span>
              <span className="ai-diff-from">{shown(d.before![k])}</span>
              <span>→</span>
              <b>{shown(d.after![k])}</b>
            </div>
          ))}
        </>
      )}
      {e.approval && (
        <div style={{ fontSize: 12.5 }} data-testid="audit-approval-line">
          {e.approval.status === 'remembered' ? (
            <>Approved earlier with “approve &amp; remember” for this ticket</>
          ) : e.approval.decidedBy ? (
            <>
              {e.approval.status[0].toUpperCase() + e.approval.status.slice(1)} once by <b>{e.approval.decidedBy}</b>
              {e.approval.decidedAt ? ` · ${dateTime(e.approval.decidedAt)}` : ''}
            </>
          ) : (
            <>Waiting for a decision ({e.approval.status.replace('_', ' ')})</>
          )}
          {e.runNumber ? ` · Run #${e.runNumber}${e.target ? `, ${e.target}` : ''}` : ''}{' '}
          {e.target && (
            <button type="button" className="ai-link" onClick={() => onOpenTicket(e.target!)}>
              Open run
            </button>
          )}
        </div>
      )}
      {e.result === 'blocked' && d.reason && <WhyBlockedCard entryId={e.id} />}
      {e.trace.length > 0 && (
        <>
          <div className="ai-label ai-label-dark">Why it did this: prompt-source trace</div>
          <div className="ai-trace" data-testid="audit-trace">
            {e.trace.map((s, i) => (
              <div key={i} className="ai-trace-row">
                <span className="ai-trace-n">{i + 1}</span>
                <span style={{ flex: 1 }}>{s.text}</span>
                {s.chip ? (
                  <Pill
                    bg={(RESULT_STYLE[s.chip.toLowerCase()] ?? RESULT_STYLE.approved).bg}
                    color={(RESULT_STYLE[s.chip.toLowerCase()] ?? RESULT_STYLE.approved).color}
                  >
                    {s.chip}
                  </Pill>
                ) : (
                  <TrustChip trust={s.trust} />
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <div className="ai-muted">
        Secrets are redacted before an entry is written. Entries are append-only and hash-chained.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {canRevert && (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            onClick={async () => {
              try {
                const [r] = await revert.mutateAsync(undefined);
                if (r?.result === 'reverted') toast.success('Change reverted', 'Recorded in Activity under your name.');
                else toast.error('Skipped', r?.reason ?? 'Nothing to revert');
              } catch (err) {
                toast.error("Couldn't revert", extractError(err));
              }
            }}
          >
            Revert this change
          </button>
        )}
        {e.runId && e.runNumber && (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            onClick={() => setRunPreview({ ids: [] })}
            data-testid="audit-revert-run"
          >
            Revert run #{e.runNumber}…
          </button>
        )}
      </div>
      {runPreview && e.runId && (
        <RunRevertDialog
          runId={e.runId}
          number={e.runNumber ?? 0}
          onClose={() => setRunPreview(null)}
          onDone={() => {
            setRunPreview(null);
            onRevertRun([]);
          }}
        />
      )}
    </div>
  );
}

/** “Why was this blocked?” (I2). */
function WhyBlockedCard({ entryId }: { entryId: string }) {
  const q = useQuery({ queryKey: ['ai', 'why', entryId], queryFn: () => safetyApi.why(entryId) });
  const toast = useToast();
  const [sent, setSent] = useState(false);
  const w: WhyBlocked | undefined = q.data;
  if (!w) return null;
  return (
    <div className="ai-card" style={{ padding: 12, borderColor: '#F0D9A8' }} data-testid="why-blocked">
      <b>Why was this blocked?</b>
      <div style={{ fontSize: 12.5, marginTop: 6, display: 'grid', gridTemplateColumns: '90px 1fr', gap: 4 }}>
        <span className="ai-label">Action</span>
        <span>{w.actionText}</span>
        <span className="ai-label">Blocked by</span>
        <span>{w.blockedBy}</span>
        <span className="ai-label">Who can change</span>
        <span>{w.whoCanChange}</span>
      </div>
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-btn-primary"
          disabled={sent}
          onClick={async () => {
            try {
              const r = await safetyApi.askAccess(entryId);
              setSent(true);
              toast.success(
                'Sent',
                `${r.to ?? 'The owner'} got this context. Nothing changes until an owner confirms.`,
              );
            } catch (err) {
              toast.error("Couldn't send", extractError(err));
            }
          }}
        >
          {sent ? 'Sent' : 'Ask owner for access'}
        </button>
        <span className="ai-muted">
          Sends {w.owner ?? 'an owner'} this context. Nothing changes until an owner confirms.
        </span>
      </div>
    </div>
  );
}

/** Bulk revert preview (E2): conflicts are skipped, not forced. */
function RevertPreviewDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const q = useQuery({ queryKey: ['ai', 'revert-preview', ids], queryFn: () => safetyApi.revertPreview(ids) });
  const toast = useToast();
  const revert = useAiMutation((entryIds: string[]) => aiApi.revertEntries(entryIds));
  const rows: RevertPreviewRow[] = q.data ?? [];
  const ok = rows.filter((r) => r.result === 'revert');
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 520 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Revert selected changes"
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">
            Revert {ids.length} selected change{ids.length === 1 ? '' : 's'}?
          </h2>
        </div>
        <div className="ai-modal-body">
          {!q.data && <span className="ai-spin" />}
          {rows.map((r) => (
            <div key={r.entryId} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
              <span
                className="ai-dot"
                style={{ background: r.result === 'revert' ? '#2E6F40' : '#B4571F', marginTop: 5 }}
              />
              <span style={{ flex: 1 }}>
                <b className="ai-mono">{r.target}</b> {r.line ?? r.fields.join(', ')}
                <span className="ai-muted"> · {r.result === 'revert' ? 'untouched since' : r.reason}</span>
              </span>
              <span style={{ color: r.result === 'revert' ? '#2E6F40' : '#B4571F', fontWeight: 600 }}>
                {r.result === 'revert' ? 'will revert' : 'skipped'}
              </span>
            </div>
          ))}
          <div className="ai-muted">
            Recorded in Activity under your name. Comments, run logs and branches stay as history; git is never touched.
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
            disabled={!ok.length || revert.isPending}
            data-testid="revert-confirm"
            onClick={async () => {
              try {
                const r = await revert.mutateAsync(ok.map((x) => x.entryId));
                const n = r.filter((x) => x.result === 'reverted').length;
                toast.success(`Reverted ${n} of ${ids.length}`, 'Conflicts are skipped, not forced.');
                onDone();
              } catch (err) {
                toast.error("Couldn't revert", extractError(err));
              }
            }}
          >
            Revert {ok.length} of {ids.length}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Revert a whole run (its changes, newest first). */
function RunRevertDialog({
  runId,
  number,
  onClose,
  onDone,
}: {
  runId: string;
  number: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const q = useQuery({ queryKey: ['ai', 'run-revert-preview', runId], queryFn: () => aiApi.revertPreview(runId) });
  const toast = useToast();
  const revert = useAiMutation(() => aiApi.revertRun(runId));
  const rows = q.data ?? [];
  const ok = rows.filter((r) => !r.conflict);
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 520 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Revert run"
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">Revert run #{number}?</h2>
        </div>
        <div className="ai-modal-body">
          {!q.data && <span className="ai-spin" />}
          {q.data && rows.length === 0 && (
            <div className="ai-hint">This run made no field or status changes that can be reverted.</div>
          )}
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, fontSize: 13 }}>
              <span className="ai-dot" style={{ background: r.conflict ? '#B4571F' : '#2E6F40', marginTop: 5 }} />
              <span style={{ flex: 1 }}>
                <b className="ai-mono">{r.ticketId}</b> {r.field} → {shown(r.to)}
                <span className="ai-muted"> · {r.conflict ? 'changed again since, skipped' : 'untouched since'}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="ai-modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!ok.length || revert.isPending}
            onClick={async () => {
              try {
                await revert.mutateAsync(undefined);
                toast.success(`Reverted run #${number}`, 'Conflicts were skipped.');
                onDone();
              } catch (err) {
                toast.error("Couldn't revert", extractError(err));
              }
            }}
          >
            Revert {ok.length} of {rows.length}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Retention, export, tamper-evidence (E3). */
function RetentionCard({ projectId, exportQs }: { projectId: string; exportQs: string }) {
  const overview = useAiOverview(projectId);
  const toast = useToast();
  const days = overview.data?.settings.auditRetentionDays ?? 0;
  return (
    <SafetyCard title="Retention, export and integrity" sub="Retention options are invented">
      <div className="ai-label ai-label-dark">Keep entries for</div>
      <ChipChoice
        value={days ?? 0}
        options={RETENTION}
        onChange={async (v) => {
          try {
            await safetyApi.updateSettings(projectId, { auditRetentionDays: v });
            void overview.refetch();
          } catch (err) {
            toast.error("Couldn't save", extractError(err));
          }
        }}
      />
      <div className="ai-muted" style={{ margin: '6px 0 10px' }}>
        Blocked, denied and injection entries are kept at least 1 year. Cost totals outlive the entries.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <a className="ai-btn ai-btn-sm" href={`${resolveOrigin()}/projects/${projectId}/ai/audit/export?${exportQs}`}>
          Export CSV
        </a>
        <a
          className="ai-btn ai-btn-sm"
          href={`${resolveOrigin()}/projects/${projectId}/ai/audit/export?${exportQs.replace('format=csv', 'format=json')}`}
        >
          Export JSON
        </a>
      </div>
      <div className="ai-hint" style={{ marginTop: 8 }}>
        <b>Append-only.</b> Entries cannot be edited or deleted, not even by owners; each one carries the hash of the
        one before it, so tampering is detectable (Check integrity).
      </div>
      <div className="ai-chips" style={{ marginTop: 6 }}>
        <span className="ai-muted">Redacted before saving:</span>
        {['sk-… keys', 'Bearer tokens', 'secret env values', '.env content'].map((c) => (
          <Pill key={c}>{c}</Pill>
        ))}
      </div>
    </SafetyCard>
  );
}
