import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { assistApi, useAssistState, useHealth } from '../../api/assist';
import { extractError } from '../../api/extractError';
import type { HealthConfig, Insight, InsightChip } from '../../types/assist';
import { Toggle } from '../ai/aiUi';
import { useAssist } from './AssistContext';
import { BoardAiAvatar, DraftTag, TicketPill, usd } from './assistUi';
import { DraftChanges } from './DraftChanges';
import './assist.css';

const KIND: Record<Insight['kind'], { label: string; bg: string; color: string }> = {
  stuck: { label: 'Stuck', bg: '#FFF1E2', color: '#B4541A' },
  wip: { label: 'WIP overload', bg: '#FDECEA', color: '#B23A28' },
  chain: { label: 'Blocked chain', bg: '#FDECEA', color: '#B23A28' },
  unassigned: { label: 'Unassigned', bg: '#EAF1FB', color: '#2F5FA8' },
  at_risk: { label: 'At risk', bg: '#FFF1E2', color: '#B4541A' },
  priority: { label: 'Priority', bg: '#F1EEFB', color: '#6B5BD2' },
};

const SEEN_KEY = (pid: string) => `kb-health-toast-${pid}`;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Text with ticket keys turned into pills. */
export function WithPills({ text, prefix }: { text: string; prefix?: string }) {
  const re = new RegExp(`\\b(${prefix ?? '[A-Z][A-Z0-9]{1,5}'}-\\d+)\\b`, 'g');
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<TicketPill key={`${m.index}`} id={m[1]} />);
    last = m.index + m[1].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function Pills({ ids, red, max = 3 }: { ids: string[]; red?: boolean; max?: number }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {ids.slice(0, max).map((id) => (
        <TicketPill key={id} id={id} red={red} />
      ))}
      {ids.length > max && <span className="ai-muted">+{ids.length - max}</span>}
    </div>
  );
}

function SnoozeMenu({ onPick }: { onPick: (hours: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative' }}>
      <button type="button" className="ai-btn ai-btn-sm" aria-label="Snooze" onClick={() => setOpen((v) => !v)}>
        🕒 ▾
      </button>
      {open && (
        <div className="as-menu" style={{ right: 0, top: 34 }}>
          {(
            [
              [1, '1 hour'],
              [4, '4 hours'],
              [24, 'Until tomorrow'],
              [168, 'For a week'],
            ] as const
          ).map(([h, label]) => (
            <button
              key={h}
              type="button"
              onClick={() => {
                setOpen(false);
                onPick(h);
              }}
            >
              Snooze {label.toLowerCase()}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function InsightRow({ ins, draftId, onChanged }: { ins: Insight; draftId: string | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const k = KIND[ins.kind];
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };
  const restorable = ins.state === 'snoozed' || ins.state === 'dismissed';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '130px 1fr',
        gap: 12,
        padding: '14px 18px',
        borderTop: '1px solid #EDF1EE',
      }}
      data-testid={`insight-${ins.kind}`}
    >
      <div>
        <span className="as-kind" style={{ background: k.bg, color: k.color }}>
          {k.label}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.6 }}>
              <WithPills text={ins.title} />
            </div>
            <div className="ai-hint" style={{ fontSize: 13 }}>
              {ins.detail}
            </div>
          </div>
          {restorable ? (
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              disabled={busy}
              onClick={() => void run(() => assistApi.insight(ins.id, 'restore'))}
            >
              Restore
            </button>
          ) : (
            <>
              {!draftId && (
                <button
                  type="button"
                  className="ai-btn ai-btn-sm"
                  style={{ borderColor: '#BFDCC7', background: '#F6FAF7' }}
                  disabled={busy}
                  onClick={() => void run(() => assistApi.insight(ins.id, 'act'))}
                  data-testid="insight-act"
                >
                  ✎ {String(ins.data.action ?? 'Draft')}
                </button>
              )}
              <SnoozeMenu onPick={(h) => void run(() => assistApi.insight(ins.id, 'snooze', h))} />
              <button
                type="button"
                className="ai-icobtn"
                aria-label="Dismiss"
                title="Dismiss"
                disabled={busy}
                onClick={() => void run(() => assistApi.insight(ins.id, 'dismiss'))}
              >
                ✕
              </button>
            </>
          )}
        </div>
        {draftId && !restorable && (
          <div>
            <DraftChanges draftId={draftId} compact />
            <div className="ai-muted" style={{ marginTop: 4 }}>
              Posted as the person who applies it, not as the AI.
            </div>
          </div>
        )}
        {error && <div className="ai-error-text">{error}</div>}
      </div>
    </div>
  );
}

function ScheduleSettings({ projectId, cfg }: { projectId: string; cfg: HealthConfig }) {
  const [error, setError] = useState<string | null>(null);
  const save = async (health: Partial<HealthConfig>) => {
    setError(null);
    try {
      await assistApi.updateSettings(projectId, { health });
    } catch (e) {
      setError(extractError(e));
    }
  };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const row = (label: string, on: boolean, key: keyof HealthConfig) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ flex: 1, fontSize: 13 }}>{label}</span>
      <Toggle on={on} label={label} onChange={(v) => void save({ [key]: v })} />
    </div>
  );
  return (
    <div
      style={{
        padding: '14px 18px',
        borderTop: '1px solid #EDF1EE',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
      data-testid="health-settings"
    >
      <div style={{ fontWeight: 700 }}>Schedule and delivery</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="ai-hint">Daily at</span>
        <input
          type="time"
          className="ai-input"
          style={{ width: 110 }}
          defaultValue={cfg.time}
          onBlur={(e) => void save({ time: e.target.value })}
          aria-label="Time"
        />
        <div className="ai-seg">
          {DAYS.map((d, i) => (
            <button
              key={d}
              type="button"
              className={cfg.days.includes(i) ? 'ai-seg-on' : ''}
              onClick={() =>
                void save({ days: cfg.days.includes(i) ? cfg.days.filter((x) => x !== i) : [...cfg.days, i].sort() })
              }
            >
              {d}
            </button>
          ))}
        </div>
        <span className="ai-muted">{tz}</span>
      </div>
      <div className="as-label" style={{ margin: 0 }}>
        Delivery
      </div>
      <div className="ai-hint">Board health panel · always</div>
      {row('Badge on the sidebar item and a toast when new insights arrive', cfg.badgeToast, 'badgeToast')}
      {row('Offer a draft comment on the ticket (posted by a person, never by the AI)', cfg.offerDraft, 'offerDraft')}
      <div className="as-label" style={{ margin: 0 }}>
        Noise controls
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="ai-hint">
          Stuck after{' '}
          <input
            className="ai-input"
            type="number"
            min={1}
            max={60}
            style={{ width: 64 }}
            defaultValue={cfg.stuckDays}
            onBlur={(e) => void save({ stuckDays: Number(e.target.value) })}
          />{' '}
          days
        </label>
        <label className="ai-hint">
          WIP limit{' '}
          <input
            className="ai-input"
            type="number"
            min={1}
            max={20}
            style={{ width: 64 }}
            defaultValue={cfg.wipLimit}
            onBlur={(e) => void save({ wipLimit: Number(e.target.value) })}
          />{' '}
          per person
        </label>
        <label className="ai-hint">
          At most{' '}
          <input
            className="ai-input"
            type="number"
            min={1}
            max={20}
            style={{ width: 64 }}
            defaultValue={cfg.maxInsights}
            onBlur={(e) => void save({ maxInsights: Number(e.target.value) })}
          />{' '}
          insights a day, highest impact first
        </label>
      </div>
      {row('A dismissed insight returns only if it gets worse', cfg.returnIfWorse, 'returnIfWorse')}
      {row('Send a weekend digest', cfg.weekend, 'weekend')}
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}

/** Board health panel with the standup digest and insights; each insight: Act (draft), Snooze, Dismiss (F1, F2). */
export function BoardHealthPanel({ onClose }: { onClose: () => void }) {
  const ctx = useAssist();
  const projectId = ctx?.projectId ?? '';
  const st = useAssistState(projectId);
  const panel = useHealth(projectId);
  const [tab, setTab] = useState<'needs' | 'snoozed' | 'dismissed'>('needs');
  const [settings, setSettings] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    void assistApi.healthSeen(projectId);
    try {
      localStorage.setItem(SEEN_KEY(projectId), new Date().toISOString());
    } catch {
      /* storage unavailable */
    }
  }, [projectId]);

  const p = panel.data;
  const list = tab === 'needs' ? p?.needsAction : tab === 'snoozed' ? p?.snoozed : p?.dismissed;
  const updated = p?.digest ? new Date(p.digest.createdAt) : null;
  return (
    <div className="ai-overlay" style={{ zIndex: 1050 }} onClick={onClose} role="presentation">
      <div
        className="ai-modal ai-root"
        style={{ width: 'min(960px, 94vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', padding: 0 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Board health"
        data-testid="board-health"
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '16px 18px',
            borderBottom: '1px solid #EDF1EE',
          }}
        >
          <BoardAiAvatar provider={st.data?.boardAi.provider} size={34} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>Board health</div>
            <div className="ai-muted" style={{ fontSize: 12 }}>
              {updated
                ? `Updated ${updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} ${
                    updated.toDateString() === new Date().toDateString() ? 'today' : updated.toLocaleDateString()
                  }`
                : 'Not checked yet'}{' '}
              · {p?.boardAi ?? 'Board AI'} · {ctx?.projectName}
            </div>
          </div>
          {(
            [
              ['needs', `Needs action ${p?.needsAction.length ?? 0}`],
              ['snoozed', `Snoozed ${p?.snoozed.length ?? 0}`],
              ['dismissed', `Dismissed ${p?.dismissed.length ?? 0}`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className="ai-btn ai-btn-sm"
              style={
                tab === k ? { borderColor: '#2E6F40', background: '#F1F8F3', color: '#1E2A22' } : { borderRadius: 999 }
              }
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={running}
            onClick={async () => {
              setRunning(true);
              setError(null);
              try {
                await assistApi.runHealth(projectId);
                await panel.refetch();
              } catch (e) {
                setError(extractError(e));
              } finally {
                setRunning(false);
              }
            }}
          >
            {running ? 'Checking…' : 'Check now'}
          </button>
          <button
            type="button"
            className="ai-icobtn"
            aria-label="Schedule and noise controls"
            onClick={() => setSettings((v) => !v)}
          >
            ⚙
          </button>
          <button type="button" className="ai-icobtn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {settings && p && <ScheduleSettings projectId={projectId} cfg={p.schedule} />}
          {p?.digest && tab === 'needs' && (
            <div
              style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}
              data-testid="health-digest"
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontWeight: 700 }}>
                  ✦ Standup summary ·{' '}
                  {new Date(p.digest.day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
                </span>
                {p.digest.text && <DraftTag>AI summary</DraftTag>}
                <span style={{ flex: 1 }} />
                <span className="as-cost">
                  {st.data?.boardAi.metered ? usd(p.digest.cost) : 'Not metered'} · {p.digest.tickets} tickets
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                {(
                  [
                    ['Done yesterday', p.digest.done, '#2E6F40', false],
                    ['In progress', p.digest.inProgress, '#3B6FB6', false],
                    ['Blocked', p.digest.blocked, '#C4432A', true],
                  ] as const
                ).map(([label, ids, color, red]) => (
                  <div key={label} className="as-tile">
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontSize: 26, fontWeight: 800, color }}>{ids.length}</span>
                      <span style={{ fontSize: 14 }}>{label}</span>
                    </div>
                    <Pills ids={[...ids]} red={red} />
                  </div>
                ))}
              </div>
              {p.digest.text && (
                <div className="ai-hint" style={{ fontSize: 13 }}>
                  {p.digest.text}
                </div>
              )}
            </div>
          )}
          {!p?.digest && tab === 'needs' && (
            <div className="ai-hint" style={{ padding: '14px 18px' }}>
              The first check runs at {p?.schedule.time ?? '09:00'} on the chosen days, or press Check now.
            </div>
          )}
          {list?.map((ins) => (
            <InsightRow key={ins.id} ins={ins} draftId={ins.draftId} onChanged={() => void panel.refetch()} />
          ))}
          {list && !list.length && (
            <div className="ai-muted" style={{ padding: '18px' }}>
              {tab === 'needs' ? 'Nothing needs attention right now.' : `No ${tab} insights.`}
            </div>
          )}
          {error && (
            <div className="ai-error-text" style={{ padding: '0 18px 14px' }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** "Board health is ready" toast with Open Board health and Snooze all (F3). */
export function BoardHealthToast() {
  const ctx = useAssist();
  const projectId = ctx?.projectId ?? '';
  const st = useAssistState(projectId);
  const [hidden, setHidden] = useState(false);
  const last = st.data?.lastCheck ?? null;
  const unseen = st.data?.unseenInsights ?? 0;
  const enabled = !!st.data?.health.badgeToast;
  let seenAt: string | null = null;
  try {
    seenAt = localStorage.getItem(SEEN_KEY(projectId));
  } catch {
    seenAt = null;
  }
  if (!ctx || ctx.healthOpen || !enabled || hidden || !last || !unseen || (seenAt && seenAt >= last)) return null;
  const done = () => {
    try {
      localStorage.setItem(SEEN_KEY(projectId), last);
    } catch {
      /* storage unavailable */
    }
    setHidden(true);
  };
  return (
    <div
      className="ai-root as-tile"
      style={{
        position: 'fixed',
        right: 24,
        bottom: 24,
        zIndex: 1200,
        width: 380,
        boxShadow: '0 12px 32px rgba(30,42,34,0.18)',
      }}
      role="status"
      data-testid="health-toast"
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ color: '#2E6F40', fontWeight: 800 }}>✓</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700 }}>Board health is ready</div>
          <div className="ai-hint">
            {unseen} thing{unseen !== 1 ? 's need' : ' needs'} attention. Nothing has been changed.
          </div>
        </div>
        <button type="button" className="ai-icobtn" aria-label="Close" onClick={done}>
          ✕
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="ai-btn ai-btn-primary ai-btn-sm"
          onClick={() => {
            done();
            ctx.setHealthOpen(true);
          }}
        >
          Open Board health
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          onClick={async () => {
            done();
            await assistApi.snoozeAll(projectId);
          }}
        >
          Snooze all
        </button>
      </div>
    </div>
  );
}

const ChipsContext = createContext<Record<string, InsightChip>>({});

/** Insight chips by ticket, for board cards. */
export function InsightChipsProvider({ chips, children }: { chips: InsightChip[]; children: ReactNode }) {
  const map: Record<string, InsightChip> = {};
  for (const c of chips) map[c.ticketId] = c;
  return <ChipsContext.Provider value={map}>{children}</ChipsContext.Provider>;
}

/** The insight chip on a card ("Stuck 6 days"; hover shows why) (A1). */
export function CardInsightChip({ ticketId }: { ticketId: string }) {
  const chip = useContext(ChipsContext)[ticketId];
  const ctx = useAssist();
  if (!chip) return null;
  return (
    <div style={{ display: 'flex' }}>
      <button
        type="button"
        className="as-insight-chip"
        title={chip.why}
        data-testid="card-insight-chip"
        onClick={(e) => {
          e.stopPropagation();
          ctx?.setHealthOpen(true);
        }}
      >
        ✦ {chip.label}
      </button>
    </div>
  );
}
