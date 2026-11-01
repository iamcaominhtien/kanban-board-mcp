import { useState } from 'react';
import type { SteppedFilters, SteppedIn, TeamRange, Touch, TouchMark } from '../../types/aiTeam';
import { useTeamStepped } from '../../api/aiTeam';
import { Icon, TicketChip } from './teamUi';

const MARK_LOOK: Record<TouchMark, { bg: string; fg: string; label: string; bar: string }> = {
  by_rule: { bg: '#E8F1FA', fg: '#244E78', label: 'By rule', bar: '#2F6FB0' },
  needed: { bg: '#FEF3D9', fg: '#7A5A06', label: 'Needed', bar: '#E8B93A' },
  avoidable: { bg: '#FDECE8', fg: '#A5321E', label: 'Avoidable', bar: '#C4432A' },
};

const PERSON_TINTS = [
  ['#E6E9F5', '#5B5FA8'],
  ['#FDE9D8', '#9A4B12'],
  ['#FBE4E9', '#B0446E'],
  ['#DFF3F3', '#0B5F61'],
  ['#E6F2EA', '#1F5A31'],
];

function personTint(name: string): [string, string] {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 997;
  return PERSON_TINTS[h % PERSON_TINTS.length] as [string, string];
}

function initials(name: string): string {
  const w = name.trim().split(/\s+/);
  return (w.length > 1 ? w[0][0] + w[1][0] : name.slice(0, 2)).toUpperCase();
}

/** "Today 09:20", "Yesterday 17:40", "Oct 28 14:03". */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const clock = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return `Today ${clock}`;
  if (days === 1) return `Yesterday ${clock}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock}`;
}

function csv(items: Touch[]): string {
  const cell = (v: string | null) => `"${(v ?? '').replace(/"/g, '""')}"`;
  const rows = items.map((t) =>
    [t.at, t.who, t.via ?? '', t.what, t.memberName, t.ticketId, t.details, t.why, MARK_LOOK[t.mark].label]
      .map((v) => cell(v as string | null))
      .join(','),
  );
  return ['When,Who,Via,What,AI,Ticket,Details,Why,Kind', ...rows].join('\n');
}

export interface SteppedActions {
  onOpenTicket: (ticketId: string) => void;
  onOpenDocsPage: (pageId: string) => void;
  onOpenAudit: (memberId: string | null) => void;
}

function Row({ t, actions }: { t: Touch; actions: SteppedActions }) {
  const [bg, fg] = personTint(t.who);
  const look = MARK_LOOK[t.mark];
  const open = () => {
    if (t.ref.type === 'page' && t.ref.id) actions.onOpenDocsPage(t.ref.id);
    else if (t.ticketId) actions.onOpenTicket(t.ticketId);
    else if (t.ref.type === 'audit') actions.onOpenAudit(t.memberId);
  };
  return (
    <div className="at-trow click" onClick={open} data-testid="touch-row">
      <span className="at-hint">{when(t.at)}</span>
      <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            className="at-avatar"
            style={{ width: 20, height: 20, borderRadius: '50%', background: bg, color: fg, fontSize: 8.5 }}
          >
            {initials(t.who)}
          </span>
          {t.who}
        </span>
        {t.via === 'mcp' && (
          <span
            className="at-chip"
            style={{ background: '#EFE8FB', color: '#5B3AA6', height: 17, fontSize: 10, marginLeft: 4 }}
          >
            via MCP
          </span>
        )}
      </span>
      <span style={{ fontWeight: 600 }}>{t.what}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {t.memberName && (
          <span style={{ fontSize: 11.5, fontWeight: 700, color: '#244E78' }} title={t.memberName}>
            {t.memberName}
          </span>
        )}
        {t.ticketId && <TicketChip id={t.ticketId} onOpen={actions.onOpenTicket} />}
      </span>
      <span>
        <span>{t.details}</span>
        <div className="at-hint-sm" style={{ marginTop: 2 }}>
          {t.why}
        </div>
      </span>
      <span>
        <span className="at-chip" style={{ background: look.bg, color: look.fg }}>
          {look.label}
        </span>
      </span>
    </div>
  );
}

/** You stepped in: every touch by a person, with the mark that says whether it was needed. */
export function SteppedInTab({
  projectId,
  range,
  actions,
}: {
  projectId: string;
  range: TeamRange;
  actions: SteppedActions;
}) {
  const [filters, setFilters] = useState<SteppedFilters>({});
  const all = useTeamStepped(projectId, range);
  const shown = useTeamStepped(projectId, range, filters);
  const d: SteppedIn | undefined = all.data;
  if (!d) return <div className="at-hint">{all.isError ? "Couldn't load the touches." : 'Loading the touches…'}</div>;
  const t = d.totals;
  const maxKind = Math.max(...d.kinds.map((k) => k.total), 1);
  const maxPer = Math.max(...d.perAi.map((r) => r.per10Runs ?? 0), 1);
  const items = shown.data?.items ?? [];
  const top = d.perAi.find((r) => r.touches > 0 && r.touches === Math.max(...d.perAi.map((x) => x.touches)));
  const opt = (label: string, count: number, f: SteppedFilters) => {
    const on =
      JSON.stringify({ mark: filters.mark, via: filters.via }) === JSON.stringify({ mark: f.mark, via: f.via });
    return (
      <button
        key={label}
        type="button"
        className={`at-opt${on ? ' on' : ''}`}
        onClick={() => setFilters({ ...filters, mark: f.mark, via: f.via })}
      >
        {label} <b>{count}</b>
      </button>
    );
  };
  return (
    <>
      <div className="at-tiles">
        <div className="at-tile">
          <div className="at-label">Touches</div>
          <span className="at-total-n">{t.touches}</span>
          <div className="at-hint-sm">
            {t.tickets} ticket{t.tickets === 1 ? '' : 's'} with AI work
            {t.perTicket != null ? ` · ${t.perTicket} per ticket` : ''}
          </div>
        </div>
        <div className="at-tile">
          <div className="at-label">By rule</div>
          <span className="at-total-n" style={{ color: '#244E78' }}>
            {t.byRule}
          </span>
          <div className="at-hint-sm">approvals and Done, as configured</div>
        </div>
        <div className="at-tile">
          <div className="at-label">Needed</div>
          <span className="at-total-n" style={{ color: '#7A5A06' }}>
            {t.needed}
          </span>
          <div className="at-hint-sm">only a person could supply it</div>
        </div>
        <div className="at-tile">
          <div className="at-label">Avoidable</div>
          <span className="at-total-n" style={{ color: '#A5321E' }}>
            {t.avoidable}
          </span>
          <div className="at-hint-sm">could be removed by a setting</div>
        </div>
      </div>

      <div className="at-two">
        <div className="at-box" style={{ flex: 1.3 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <b style={{ fontSize: 13.5, flex: 1 }}>What you did</b>
            <span className="at-hint-sm">
              <b style={{ color: '#2F6FB0' }}>■</b> by rule <b style={{ color: '#E8B93A' }}>■</b> needed{' '}
              <b style={{ color: '#C4432A' }}>■</b> avoidable
            </span>
          </div>
          {d.kinds.length === 0 && <div className="at-hint">No touches in this range.</div>}
          {d.kinds.map((k) => (
            <div key={k.key} className="at-barrow" style={{ gridTemplateColumns: '230px 1fr 26px' }}>
              <span>{k.label}</span>
              <div className="at-bar" style={{ height: 10 }}>
                {(['byRule', 'needed', 'avoidable'] as const).map((m, i) =>
                  k[m] ? (
                    <i
                      key={m}
                      style={{
                        width: `${(k[m] / maxKind) * 100}%`,
                        background: MARK_LOOK[(['by_rule', 'needed', 'avoidable'] as const)[i]].bar,
                      }}
                    />
                  ) : null,
                )}
              </div>
              <b style={{ textAlign: 'right' }}>{k.total}</b>
            </div>
          ))}
        </div>
        <div className="at-box" style={{ flex: 1 }}>
          <b style={{ fontSize: 13.5, display: 'block', marginBottom: 6 }}>Touches per 10 runs, by AI</b>
          {d.perAi.map((r) => (
            <div key={r.id} className="at-barrow" style={{ gridTemplateColumns: '110px 1fr 34px' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
              <div className="at-bar" style={{ height: 8 }}>
                <i
                  style={{
                    width: `${((r.per10Runs ?? 0) / maxPer) * 100}%`,
                    background: (r.per10Runs ?? 0) >= 3 ? '#C4432A' : '#9AA8A0',
                  }}
                />
              </div>
              <b style={{ textAlign: 'right' }}>{r.per10Runs ?? '–'}</b>
            </div>
          ))}
          {top && (
            <div className="at-hint-sm" style={{ marginTop: 4 }}>
              {top.name} has the most touches ({top.touches} of {t.touches}).
              {d.docsProposalsHeld ? '' : ' Docs proposal rows appear only where Docs AI holds AI edits.'}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {opt('All', t.touches, {})}
        {opt('Avoidable', t.avoidable, { mark: 'avoidable' })}
        {opt('Needed', t.needed, { mark: 'needed' })}
        {opt('By rule', t.byRule, { mark: 'by_rule' })}
        {opt('Via MCP', t.viaMcp, { via: 'mcp' })}
        <span style={{ flex: 1 }} />
        <select
          className="at-select"
          aria-label="AI"
          value={filters.memberId ?? ''}
          onChange={(e) => setFilters({ ...filters, memberId: e.target.value || undefined })}
        >
          <option value="">AI: all</option>
          {d.perAi.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select
          className="at-select"
          aria-label="Person"
          value={filters.person ?? ''}
          onChange={(e) => setFilters({ ...filters, person: e.target.value || undefined })}
        >
          <option value="">Person: all</option>
          {d.people.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="st-btn st-btn-sm"
          disabled={!items.length}
          onClick={() => {
            const url = URL.createObjectURL(new Blob([csv(items)], { type: 'text/csv' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `ai-touches-${range}.csv`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Icon>
            <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
          </Icon>
          Export CSV
        </button>
      </div>

      <div className="at-table" data-testid="touch-table">
        <div className="at-trow head">
          {['When', 'Who', 'What they did', 'AI and ticket', 'Details and why', 'Kind'].map((h) => (
            <span key={h} className="at-label" style={{ fontSize: 11 }}>
              {h}
            </span>
          ))}
        </div>
        {items.length === 0 ? (
          <div className="at-hint" style={{ padding: '16px' }}>
            {t.touches === 0 ? 'Nobody had to step in during this range.' : 'No touch matches these filters.'}
          </div>
        ) : (
          items.map((x, i) => <Row key={`${x.at}-${x.kind}-${i}`} t={x} actions={actions} />)
        )}
      </div>
    </>
  );
}
