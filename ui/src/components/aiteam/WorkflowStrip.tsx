import type { TddEvidence, ViewStep, WorkflowView } from '../../types/aiWorkflow';
import { roleLook, roleName } from '../ai/workflow/wfFormat';
import { fmtClock, fmtShort, fmtTokens, fmtUsd } from './teamFormat';
import { FsIcon } from './ScopeBar';

const PERSON = 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM5 20c0-3.5 3.1-6 7-6s7 2.5 7 6';
const CODE = 'M8 7l-5 5 5 5M16 7l5 5-5 5';
const CHECK = 'M5 12.5l4.5 4.5L19 7.5';
const CROSS = 'M6 6l12 12M18 6L6 18';

/** A role's square glyph (TR, BA, DS, DV...) in its colours. */
export function RoleGlyph({ role, size = 16, title }: { role: string | null; size?: number; title?: string }) {
  const look = roleLook(role);
  return (
    <span
      className="fs-glyph"
      title={title ?? roleName(role)}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(5, Math.round(size * 0.33)),
        background: look.bg,
        color: look.fg,
        borderColor: look.border,
      }}
    >
      {look.glyph}
    </span>
  );
}

function since(a: string | null, b: string | null): number | null {
  if (!a) return null;
  const s = Date.parse(a);
  const e = b ? Date.parse(b) : Date.now();
  return Number.isNaN(s) || Number.isNaN(e) ? null : Math.max(0, Math.round((e - s) / 1000));
}

function clip(t: string, n = 46): string {
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
}

const WENT_BACK = new Set(['changes', 'sent_back']);

/** What a step card says under its name (design J): what it did, or what it is doing, or who it waits for. */
export function stepText(s: ViewStep, steps: ViewStep[]): string {
  const person = s.kind === 'person';
  if (s.state === 'skipped') return 'Skipped';
  if (s.state === 'active' || s.state === 'waiting') {
    if (person) return 'Waits for you';
    const t = fmtShort(since(s.startedAt, null));
    return `Run ${s.attempt || 1}${t !== '–' ? `, ${t}` : ''}`;
  }
  if (s.state === 'done') {
    if (person && s.memberName) return `${s.memberName} approved for you`;
    if (WENT_BACK.has(s.outcome ?? '')) {
      const n = s.attempt || 1;
      return `Returned ${n === 1 ? 'once' : `${n} times`}`;
    }
    if (s.outcome === 'board') return 'The board moved it';
    if (s.note) return clip(s.note);
    if (s.kind === 'code') return s.outcome === 'failed' ? 'Failed' : 'Passed';
    return 'Done';
  }
  if (s.state === 'failed') return s.kind === 'code' ? 'Checks failed' : 'Failed';
  if (s.state === 'blocked') return 'Blocked';
  if (person) return s.key === 'done' || s.idx === steps.length - 1 ? 'You move it' : 'Waits for you';
  if (s.kind === 'code') return 'Lint, types, tests';
  return '';
}

/** Where work went back to: the build step before the step that sent it back (or the step just before). */
export function returnsOf(steps: ViewStep[]): { from: number; to: number; round: number }[] {
  const out: { from: number; to: number; round: number }[] = [];
  steps.forEach((s, i) => {
    if (!WENT_BACK.has(s.outcome ?? '')) return;
    let to = -1;
    for (let k = i - 1; k >= 0; k--) {
      if (steps[k].role === 'dev' || steps[k].key === 'build') {
        to = k;
        break;
      }
    }
    if (to < 0) to = Math.max(0, i - 1);
    out.push({ from: i, to, round: s.outcome === 'changes' ? 1 : 2 });
  });
  // an older answer keeps no outcome on the step that sent it back: a build on its second run was returned once
  if (!out.length) {
    const b = steps.findIndex((s) => (s.role === 'dev' || s.key === 'build') && (s.attempt ?? 1) > 1);
    const r = b >= 0 ? steps.findIndex((s, k) => k > b && s.role === 'reviewer') : -1;
    if (b >= 0 && r >= 0) out.push({ from: r, to: b, round: (steps[b].attempt ?? 2) > 2 ? 2 : 1 });
  }
  return out;
}

const CARD = 76;
const GAP = 6;

/**
 * The steps of one ticket's workflow (design/screens/ai-story-flow.md, J): the real steps in order, who holds each, the
 * approval as its own step, the step at work ringed, and what came back as the brown dashed arc (red after round 1).
 */
export function WorkflowStrip({ view }: { view: WorkflowView }) {
  const steps = [...view.steps].sort((a, b) => a.idx - b.idx);
  const back = returnsOf(steps);
  const cx = (i: number) => 12 + i * (CARD + GAP) + CARD / 2;
  const width = 24 + steps.length * (CARD + GAP);
  return (
    <div className="fs-wf" data-testid="workflow-strip">
      <div className="fs-wf-steps">
        {steps.map((s, i) => {
          const cls =
            s.state === 'done'
              ? 'done'
              : s.state === 'active'
                ? 'active'
                : s.state === 'waiting'
                  ? 'waiting'
                  : s.state === 'failed'
                    ? 'bad'
                    : s.state === 'skipped'
                      ? 'skipped'
                      : '';
          const tdd = (s.result?.tdd ?? null) as TddEvidence | null;
          return (
            <div
              key={s.id}
              className={`fs-wf-step ${cls}`}
              data-testid={`wf-step-${s.key}`}
              title={s.note ?? undefined}
            >
              <div className="fs-wf-n">
                <span>{i + 1}</span>
                <b>{s.label}</b>
              </div>
              {s.kind === 'ai' ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <RoleGlyph role={s.role} title={s.memberName ?? roleName(s.role)} />
                </span>
              ) : (
                <span className="fs-wf-who">
                  <FsIcon d={s.kind === 'person' ? PERSON : CODE} size={10} color="#5B6B60" width={2} />
                  {s.kind === 'person' ? 'a person' : 'code'}
                </span>
              )}
              <div className="fs-wf-sub">{stepText(s, steps)}</div>
              {tdd && 'proven' in tdd && tdd.proven && (
                <span className="fs-mini" style={{ background: '#FEF3D9', color: '#7A5A06' }}>
                  <FsIcon d={CHECK} size={9} color="#7A5A06" width={2.2} />
                  test first
                </span>
              )}
            </div>
          );
        })}
      </div>
      {back.length > 0 && (
        <svg
          width={width}
          height={60}
          viewBox={`0 0 ${width} 60`}
          style={{ display: 'block', marginTop: -4 }}
          aria-hidden="true"
        >
          <defs>
            {[
              ['wf-ahb', '#8A6A12'],
              ['wf-ahr', '#C4432A'],
            ].map(([id, fill]) => (
              <marker
                key={id}
                id={id}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill={fill} />
              </marker>
            ))}
          </defs>
          {back.map((b, k) => {
            const color = b.round === 1 ? '#8A6A12' : '#C4432A';
            const a = cx(b.from);
            const t = cx(b.to);
            const low = 30 + k * 8;
            return (
              <g key={`${b.from}-${b.to}`} data-testid="wf-return">
                <path
                  d={`M${a} 4 C${a} ${low} ${t} ${low} ${t} 6`}
                  stroke={color}
                  strokeWidth="2"
                  strokeDasharray="5 4"
                  fill="none"
                  markerEnd={`url(#${b.round === 1 ? 'wf-ahb' : 'wf-ahr'})`}
                />
                <text x={(a + t) / 2} y={low + 18} fontSize="10.5" fontWeight="700" fill={color} textAnchor="middle">
                  {b.round === 1 ? 'returned in review round 1 (normal)' : 'sent back after round 1'}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/** What the team shows so far: a test that failed before the fix and passed after, and the checks (design J). */
export function EvidenceCard({ view }: { view: WorkflowView | null | undefined }) {
  const tdd = (view?.steps ?? [])
    .map((s) => ({ s, t: (s.result?.tdd ?? null) as TddEvidence | null }))
    .filter((x) => x.t && 'proven' in x.t);
  const checks = (view?.steps ?? []).flatMap((s) => s.result?.checks ?? []);
  return (
    <div className="fs-card" data-testid="evidence-card">
      <div className="fs-card-h">
        <span className="fs-h">Evidence so far</span>
      </div>
      <div className="fs-card-b">
        {tdd.length === 0 && checks.length === 0 && <span className="fs-hint">Nothing to show yet.</span>}
        {tdd.map(({ s, t }) =>
          t && t.proven ? (
            <div key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="fs-mini" style={{ background: '#FDECE8', color: '#A5321E' }}>
                <FsIcon d={CROSS} size={9} color="#A5321E" width={2.2} />
                test failed before the fix
              </span>
              <span className="fs-hint" style={{ fontSize: 11.5 }}>
                {s.memberName ?? roleName(s.role)} {t.red.run}, {fmtClock(t.red.at)} · {t.red.failed} test
                {t.red.failed === 1 ? '' : 's'} red
              </span>
              <span className="fs-mini" style={{ background: '#E6F2EA', color: '#1F5A31' }}>
                <FsIcon d={CHECK} size={9} color="#1F5A31" width={2.2} />
                {t.green.passed} test{t.green.passed === 1 ? '' : 's'} pass
              </span>
              <span className="fs-hint" style={{ fontSize: 11.5 }}>
                {s.memberName ?? roleName(s.role)} {t.green.run}, {fmtClock(t.green.at)}
              </span>
            </div>
          ) : t ? (
            <span key={s.id} className="fs-hint" style={{ fontSize: 11.5 }}>
              No failing test before the fix: {t.why}
            </span>
          ) : null,
        )}
        {checks.length > 0 && (
          <span
            className="fs-mini"
            style={
              checks.every((c) => c.ok)
                ? { background: '#E6F2EA', color: '#1F5A31' }
                : { background: '#FDECE8', color: '#A5321E' }
            }
          >
            <FsIcon d={checks.every((c) => c.ok) ? CHECK : CROSS} size={9} color="currentColor" width={2.2} />
            {checks.filter((c) => c.ok).length} of {checks.length} checks pass
          </span>
        )}
      </div>
    </div>
  );
}

/** What one ticket has cost so far (design J). */
export function CostCard({ usd, tokens, runs }: { usd: number; tokens: number; runs: number }) {
  return (
    <div className="fs-card" data-testid="cost-card">
      <div className="fs-card-h">
        <span className="fs-h">What it has cost</span>
      </div>
      <div className="fs-card-b" style={{ lineHeight: 1.5 }}>
        <b style={{ fontSize: 18 }}>{fmtUsd(usd)}</b>
        <span className="fs-hint">
          {fmtTokens(tokens)} tokens · {runs} run{runs === 1 ? '' : 's'}
        </span>
      </div>
    </div>
  );
}
