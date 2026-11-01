import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { aiApi, aiKeys } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { Health, HealthSuggestion, TeamRange, Verdict } from '../../types/aiTeam';
import { useToast } from '../Toast';
import { useDismissSuggestion, useTeamHealth } from '../../api/aiTeam';
import { Badge, ICONS, Icon, Spark, TicketChip } from './teamUi';
import { deltaOf, fmtShort, fmtTokens, fmtUsd } from './teamFormat';

export interface HealthActions {
  onOpenTicket: (ticketId: string) => void;
  onOpenMember: (memberId: string) => void;
  onOpenDocsPage: (pageId: string) => void;
  onOpenFlow: (ticketId: string) => void;
}

const V: Record<Verdict, { bg: string; fg: string; label: string; line: string }> = {
  good: { bg: '#E6F2EA', fg: '#1F5A31', label: 'Good', line: '#2E6F40' },
  watch: { bg: '#FEF3D9', fg: '#7A5A06', label: 'Watch', line: '#2E6F40' },
  fix: { bg: '#FDECE8', fg: '#A5321E', label: 'Fix', line: '#C4432A' },
};
const STATE_TITLE = {
  good: 'Healthy',
  watch: 'Needs attention',
  fix: 'Needs fixing',
  unknown: 'Not enough to judge yet',
};

function VerdictChip({ v }: { v: Verdict | null }) {
  if (!v) return null;
  return (
    <span className="at-chip" style={{ background: V[v].bg, color: V[v].fg }}>
      {V[v].label}
    </span>
  );
}

function summary(h: Health): string {
  if (!h.canJudge) {
    return `Only ${h.runs} run${h.runs === 1 ? '' : 's'} in this range. The numbers show, the verdict waits for 10 runs.`;
  }
  const m = h.measures;
  const rel = m.reliability.verdict;
  const reliable = rel === 'good' ? 'reliable' : rel === 'watch' ? 'mostly reliable' : 'not reliable yet';
  const faster =
    m.speed.deltaS == null
      ? ''
      : m.speed.deltaS < 0
        ? ' and getting faster'
        : m.speed.deltaS > 0
          ? ' and getting slower'
          : '';
  const lead = `The team is ${reliable}${faster}`;
  const sentences: string[] = [];
  if (m.autonomy.verdict && m.autonomy.verdict !== 'good') {
    sentences.push(
      `people still step in too often${h.touches.avoidable ? `: ${h.touches.avoidable} of the ${h.touches.total} touches were avoidable` : ''}`,
    );
  }
  const top = h.suggestions.slice(0, 2).map((s) => s.title);
  if (!sentences.length && !top.length) return `${lead}.`;
  return `${lead}${sentences.length ? `, but ${sentences[0]}` : ''}.${top.length ? ` ${top.map((t) => `${t}.`).join(' ')}` : ''}`;
}

function Tile({
  name,
  verdict,
  value,
  spark,
  delta,
  hint,
}: {
  name: string;
  verdict: Verdict | null;
  value: string;
  spark: number[];
  delta: ReturnType<typeof deltaOf>;
  hint: string;
}) {
  const color = delta.better === null ? '#5B6B60' : delta.better ? '#2E6F40' : '#C4432A';
  return (
    <div className="at-measure" data-testid={`measure-${name.toLowerCase()}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="at-label" style={{ flex: 1, fontSize: 11 }}>
          {name}
        </span>
        <VerdictChip v={verdict} />
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <span className="at-measure-n">{value}</span>
        <span style={{ flex: 1 }} />
        <Spark values={spark.length ? spark : [0, 0]} color={delta.better === false ? '#C4432A' : '#2E6F40'} />
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color, whiteSpace: 'nowrap' }}>{delta.text}</div>
      <div className="at-hint-sm">{hint}</div>
    </div>
  );
}

/** “You confirm before anything is saved”: the text to add, editable, and what the instructions will read. */
function InstructionsDialog({
  draft,
  onClose,
  onSaved,
}: {
  draft: NonNullable<HealthSuggestion['draft']>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(draft.text);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const next = draft.current.trim() ? `${draft.current.trim()}\n\n${text.trim()}` : text.trim();
  const over = next.length > draft.limit;
  const save = async () => {
    setBusy(true);
    try {
      await aiApi.update(draft.memberId, { persona: next });
      await qc.invalidateQueries({ queryKey: aiKeys.all });
      toast.success('Instructions saved', `${draft.memberName} reads it from its next run.`);
      onSaved();
    } catch (err) {
      toast.error("Couldn't save", extractError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 560 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Change ${draft.memberName}’s instructions`}
        data-testid="instructions-dialog"
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">Add to {draft.memberName}’s instructions</h2>
          <div className="ai-hint">Nothing is saved until you confirm. You can edit the text first.</div>
        </div>
        <div className="ai-modal-body">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            aria-label="Text to add"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1.5px dashed #7C5CD6',
              background: '#FAF7FF',
              borderRadius: 8,
              padding: '8px 11px',
              font: 'inherit',
              fontSize: 12.5,
              lineHeight: 1.5,
              resize: 'vertical',
            }}
          />
          <div className="at-hint-sm" style={{ color: over ? '#C4432A' : undefined }}>
            The instructions will be {next.length} of {draft.limit} characters.
            {over ? ' That is too long: shorten the text above or the current instructions first.' : ''}
          </div>
        </div>
        <div className="ai-modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="st-btn st-btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary st-btn-sm"
            disabled={busy || over || !text.trim()}
            onClick={() => void save()}
          >
            Save to instructions
          </button>
        </div>
      </div>
    </div>
  );
}

function Fix({
  n,
  s,
  actions,
  onDismiss,
}: {
  n: number;
  s: HealthSuggestion;
  actions: HealthActions;
  onDismiss: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const open = () => {
    if (s.draft) {
      setConfirm(true);
      return;
    }
    if (s.target.type === 'member' && s.target.id) actions.onOpenMember(s.target.id);
    else if (s.target.type === 'ticket' && s.target.id) actions.onOpenFlow(s.target.id);
    else if (s.target.type === 'page' && s.target.id) actions.onOpenDocsPage(s.target.id);
  };
  const look = V[s.severity];
  return (
    <div className="at-fix" data-testid="health-fix">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="at-num">{n}</span>
        <b style={{ fontSize: 14, flex: 1 }}>{s.title}</b>
        <span className="at-chip" style={{ background: look.bg, color: look.fg }}>
          {look.label}
        </span>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
        <span className="at-label">Evidence</span> {s.evidence}{' '}
        {s.tickets.map((t) => (
          <span key={t} style={{ marginRight: 4 }}>
            <TicketChip id={t} onOpen={actions.onOpenTicket} />
          </span>
        ))}
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
        <span className="at-label" style={{ color: '#2E6F40' }}>
          Suggestion
        </span>{' '}
        {s.suggestion}
      </div>
      {s.draft && (
        <div
          style={{
            padding: '8px 11px',
            borderRadius: 8,
            border: '1.5px dashed #7C5CD6',
            background: '#FAF7FF',
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          <span className="at-label" style={{ color: '#5B3AA6' }}>
            Text to add to {s.draft.memberName}’s instructions
          </span>
          <br />“{s.draft.text}”
        </div>
      )}
      <div className="at-actions">
        <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={open}>
          {s.button}
        </button>
        <button type="button" className="st-btn st-btn-sm" onClick={onDismiss}>
          {s.dismiss ?? 'Dismiss'}
        </button>
      </div>
      {confirm && s.draft && (
        <InstructionsDialog
          draft={s.draft}
          onClose={() => setConfirm(false)}
          onSaved={() => {
            setConfirm(false);
            onDismiss();
          }}
        />
      )}
    </div>
  );
}

/** Health: is the AI feature working? A verdict, five measures, a row per AI and what to fix. */
export function HealthTab({
  projectId,
  range,
  actions,
}: {
  projectId: string;
  range: TeamRange;
  actions: HealthActions;
}) {
  const q = useTeamHealth(projectId, range);
  const dismiss = useDismissSuggestion(projectId);
  const h = q.data;
  if (!h)
    return <div className="at-hint">{q.isError ? "Couldn't load the health page." : 'Working out the numbers…'}</div>;
  const m = h.measures;
  const pct = (v: number | null) => (v == null ? '–' : `${Math.round(v * 100)}%`);
  const bannerClass = h.state === 'good' ? 'good' : h.state === 'fix' ? 'fix' : h.state === 'unknown' ? 'unknown' : '';
  const rest = h.runs < 20 && h.canJudge ? ' Too few runs to be sure about a change.' : '';
  const maxNotOk = Math.max(...h.notOk.map((x) => x.count), 1);
  const dayPart = new Date(h.since).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const endPart = new Date(h.until).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return (
    <>
      <div className={`at-banner ${bannerClass}`} data-testid="health-banner">
        <span
          className="at-banner-ico"
          style={{ borderColor: h.state === 'good' ? '#2E6F40' : h.state === 'fix' ? '#C4432A' : undefined }}
        >
          <Icon color={h.state === 'good' ? '#2E6F40' : h.state === 'fix' ? '#C4432A' : '#B8860B'} size={22}>
            {h.state === 'good' ? ICONS.check : <path d="M12 4l9 16H3L12 4zM12 10v4M12 17v.5" />}
          </Icon>
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <b style={{ fontSize: 18 }}>{STATE_TITLE[h.state]}</b>
            <span className="at-hint">
              {h.runs} runs on {h.tickets} tickets · {dayPart} to {endPart}
            </span>
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 3 }}>
            {summary(h)}
            {rest}
          </div>
        </div>
        {h.canJudge && (
          <span className="at-chip" style={{ background: '#E6F2EA', color: '#1F5A31' }}>
            {h.counts.good} good · {h.counts.watch} watch · {h.counts.fix} fix
          </span>
        )}
      </div>

      <div className="at-measures">
        <Tile
          name="Reliability"
          verdict={m.reliability.verdict}
          value={pct(m.reliability.value)}
          spark={m.reliability.spark}
          delta={deltaOf('pts', m.reliability.delta, 'up')}
          hint={`runs that finished OK: ${m.reliability.ok} of ${m.reliability.total}`}
        />
        <Tile
          name="Autonomy"
          verdict={m.autonomy.verdict}
          value={pct(m.autonomy.value)}
          spark={m.autonomy.spark}
          delta={deltaOf('pts', m.autonomy.delta, 'up')}
          hint={`tickets completed with no needed or avoidable touch: ${m.autonomy.clean} of ${m.autonomy.total}. Goal ${Math.round(m.autonomy.goal * 100)}%`}
        />
        <Tile
          name="Speed"
          verdict={m.speed.verdict}
          value={fmtShort(m.speed.medianS)}
          spark={m.speed.spark}
          delta={deltaOf('seconds', m.speed.deltaS, 'down')}
          hint={`median, start to completed${m.speed.waitingShare != null ? `. ${Math.round(m.speed.waitingShare * 100)}% of it waiting for you` : ''}`}
        />
        <Tile
          name="Quality"
          verdict={m.quality.verdict}
          value={pct(m.quality.value)}
          spark={m.quality.spark}
          delta={deltaOf('pts', m.quality.delta, 'down')}
          hint={`hand-offs sent back: ${m.quality.sentBack} of ${m.quality.handoffs}. Report backs and first review rounds are not counted`}
        />
        <Tile
          name="Cost"
          verdict={m.cost.verdict}
          value={fmtUsd(m.cost.usd)}
          spark={m.cost.spark}
          delta={deltaOf('usd', m.cost.deltaUsd, 'down')}
          hint={`${m.cost.perTicket != null ? `${fmtUsd(m.cost.perTicket)} per ticket on priced runs. ` : ''}${m.cost.tokensOnly ? `${m.cost.tokensOnly} runs report tokens only. ` : ''}${m.cost.cap ? `${Math.round((m.cost.capShare ?? 0) * 100)}% of the ${fmtUsd(m.cost.cap)} cap` : 'No monthly cap set'}`}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', marginTop: 4 }}>
        <b style={{ fontSize: 14, flex: 1 }}>Each AI</b>
        <span className="at-hint">
          Compared with the previous range. Where a runner reports no dollars, tokens are shown, never $0
        </span>
      </div>
      <div className="at-table at-aitable" data-testid="health-per-ai">
        <div className="at-trow head">
          {[
            'AI',
            'Runs',
            'Finished OK',
            'Asked you',
            'Touches /10 runs',
            'Avg run',
            'Cost /ticket',
            'Sent back to it',
            '',
          ].map((c) => (
            <span key={c} className="at-label" style={{ fontSize: 11 }}>
              {c}
            </span>
          ))}
        </div>
        {h.perAi.map((r) => (
          <div key={r.id} className="at-trow">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Badge name={r.name} color={r.color} size={24} />
              <b>{r.name}</b>
            </span>
            <span>{r.runs}</span>
            <b>{pct(r.okShare)}</b>
            <span>{r.runs ? `${r.asked} (${pct(r.askedShare)})` : '–'}</span>
            <b>{r.touchesPer10 ?? '–'}</b>
            <span>{fmtShort(r.avgRunS)}</span>
            <span>
              {r.costPerTicket != null ? fmtUsd(r.costPerTicket) : r.tokens ? `${fmtTokens(r.tokens)} tokens` : '–'}
            </span>
            <span>{r.sentBackTo}</span>
            <span style={{ textAlign: 'right' }}>
              {r.status === 'idle' ? null : (
                <span
                  className="at-chip"
                  style={
                    r.status === 'healthy'
                      ? { background: '#E6F2EA', color: '#1F5A31' }
                      : { background: V[r.status].bg, color: V[r.status].fg }
                  }
                >
                  {r.status === 'healthy' ? 'Healthy' : V[r.status].label}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="at-hint-sm">
        Tokens are counted differently by each runner: Claude Code counts cached context on every call (shown as new and
        cached), Antigravity counts input per model call. Compare tokens only within one runner.
      </div>

      <div className="at-two" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <b style={{ fontSize: 14, flex: 1 }}>What to fix · {h.suggestions.length}</b>
            <span className="at-hint">Worked out from rules, shown only with 3 or more cases</span>
          </div>
          {h.suggestions.length === 0 ? (
            <div className="at-empty">
              {h.canJudge ? 'Nothing to fix in this range.' : 'What to fix waits for 10 runs in the range.'}
            </div>
          ) : (
            <div className="at-fixgrid">
              {h.suggestions.map((s, i) => (
                <Fix key={s.key} n={i + 1} s={s} actions={actions} onDismiss={() => dismiss.mutate(s.key)} />
              ))}
            </div>
          )}
        </div>
        <div className="at-box" style={{ width: 300, flexShrink: 0 }}>
          <b style={{ fontSize: 13.5, display: 'block', marginBottom: 6 }}>
            Why {h.notOkTotal} run{h.notOkTotal === 1 ? '' : 's'} did not finish OK
          </b>
          {h.notOk.length === 0 && <div className="at-hint">Every run in this range finished OK.</div>}
          {h.notOk.map((x) => (
            <button
              key={x.label}
              type="button"
              className="at-barrow"
              style={{
                gridTemplateColumns: '130px 1fr 22px',
                width: '100%',
                background: 'none',
                border: 'none',
                textAlign: 'left',
                cursor: 'pointer',
                font: 'inherit',
              }}
              onClick={() => x.ticketIds[0] && actions.onOpenTicket(x.ticketIds[0])}
              title="Open the first ticket behind this"
            >
              <span>{x.label}</span>
              <div className="at-bar" style={{ height: 8 }}>
                <i style={{ width: `${(x.count / maxNotOk) * 100}%`, background: '#C4432A' }} />
              </div>
              <b style={{ textAlign: 'right' }}>{x.count}</b>
            </button>
          ))}
          <div className="at-hint-sm" style={{ marginTop: 8 }}>
            Each bar opens a ticket behind it.
          </div>
          <div className="at-hint-sm" style={{ marginTop: 12, lineHeight: 1.5 }}>
            <b>Not enough to judge yet?</b>
            <br />
            The verdict needs at least 10 runs in the range. Below that, the numbers show without a verdict. A single
            bad run never turns a measure red.
          </div>
        </div>
      </div>
    </>
  );
}
