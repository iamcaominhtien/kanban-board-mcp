import { useMemo, useState } from 'react';
import { ideaRuleError, useEditAssumption } from '../../api/ideas';
import type { AssumptionImpact, AssumptionState, IdeaRow } from '../../types/idea';
import { useToast } from '../Toast';
import { plural } from '../docs/docsShared';
import { IdeaIcon } from './ideaIcons';

const IMPACT_Y: Record<AssumptionImpact, number> = { high: 0.82, medium: 0.5, low: 0.18 };
const PALETTE = ['#2f6fb0', '#e2793d', '#6d5dd3', '#2e6f40', '#c4432a', '#b4791e', '#b0446e', '#3a8f8f'];

interface Dot {
  key: string;
  idea: IdeaRow;
  assumptionId: string;
  text: string;
  impact: AssumptionImpact;
  state: AssumptionState;
  evidence: number;
  testTicketId: string | null;
  x: number;
  y: number;
  color: string;
  /** The label sits on the left of the dot near the right edge, so it is not cut off. */
  labelLeft: boolean;
}

/** Room a label takes, as a share of the plot: about 240 px wide and 22 px high on the usual plot. */
const LABEL_W = 0.26;
const LABEL_H = 0.055;

/**
 * Moves dots apart so that no two labels sit on top of each other: a dot whose label would cover one already placed
 * steps down (then up) by one label height, staying inside the plot. A label runs right of its dot, or left of it
 * near the right edge (`labelLeft`).
 */
export function spreadDots<T extends { x: number; y: number; labelLeft: boolean }>(dots: T[]): T[] {
  const placed: T[] = [];
  const span = (d: T): [number, number] => (d.labelLeft ? [d.x - LABEL_W, d.x + 0.02] : [d.x - 0.02, d.x + LABEL_W]);
  const sorted = [...dots].sort((a, b) => b.y - a.y || a.x - b.x);
  for (const d of sorted) {
    const [l, r] = span(d);
    const hits = (y: number) =>
      placed.some((p) => {
        const [pl, pr] = span(p);
        return l < pr && pl < r && Math.abs(p.y - y) < LABEL_H;
      });
    let y = d.y;
    for (let step = 1; hits(y) && step < 40; step++) {
      const next = d.y - Math.ceil(step / 2) * LABEL_H * (step % 2 ? 1 : -1);
      if (next > 0.04 && next < 0.96) y = next;
    }
    placed.push({ ...d, y });
  }
  return placed;
}

/** How well supported an assumption is, 0 to 1: tested ones count most, evidence adds a little. */
export function evidenceStrength(state: AssumptionState, evidence: number): number {
  const base = { untested: 0.05, testing: 0.4, validated: 0.8, disproved: 0.8 }[state];
  return Math.min(0.96, base + Math.min(evidence, 4) * 0.04);
}

/** Matrix: each dot is one assumption of an open idea. Top-left is where the risk is. */
export function IdeaMatrix({ ideas, onOpen }: { ideas: IdeaRow[]; onOpen: (id: string) => void }) {
  const toast = useToast();
  const edit = useEditAssumption();
  const [selected, setSelected] = useState<string | null>(null);

  const dots = useMemo<Dot[]>(() => {
    const out: Dot[] = [];
    ideas.forEach((idea, n) => {
      idea.assumptions.forEach((a, k) => {
        // a small fixed offset keeps dots of the same position apart without moving them between renders
        const jitter = ((n * 7 + k * 13) % 9) / 100;
        out.push({
          key: `${idea.id}/${a.id}`,
          idea,
          assumptionId: a.id,
          text: a.text,
          impact: a.impact,
          state: a.state,
          evidence: a.evidence.length,
          testTicketId: a.testTicketId ?? null,
          x: Math.min(0.97, evidenceStrength(a.state, a.evidence.length) + jitter),
          y: Math.min(0.95, IMPACT_Y[a.impact] + jitter / 2),
          color: PALETTE[n % PALETTE.length],
          labelLeft: false,
        });
      });
    });
    return spreadDots(out.map((d) => ({ ...d, labelLeft: d.x > 0.62 })));
  }, [ideas]);

  const current = dots.find((d) => d.key === selected) ?? null;

  if (dots.length === 0) {
    return (
      <div className="is-empty">
        <h3>No assumptions to plot</h3>
        <div>Write what must be true for an idea to work. Each assumption becomes a dot here.</div>
      </div>
    );
  }

  async function setState(d: Dot, status: AssumptionState) {
    try {
      await edit.mutateAsync({ id: d.idea.id, assumptionId: d.assumptionId, status });
      toast.success(status === 'validated' ? 'Marked validated' : 'Marked disproved');
    } catch (e) {
      toast.error('Could not change the assumption', ideaRuleError(e).message);
    }
  }

  return (
    <div className="is-matrix-wrap">
      <div className="is-matrix" role="group" aria-label="Assumptions by impact and evidence">
        <div className="is-quad is-quad-tl">
          <span>Test these first</span>
        </div>
        <div className="is-quad is-quad-tr">
          <span>Well supported</span>
        </div>
        <div className="is-quad is-quad-bl">
          <span>Low stakes, low proof</span>
        </div>
        <div className="is-quad is-quad-br">
          <span>Fine</span>
        </div>
        {dots.map((d) => (
          <div
            key={d.key}
            className={`is-dot-at ${d.labelLeft ? 'is-dot-at-left' : ''}`}
            style={{ left: `${d.x * 100}%`, bottom: `${d.y * 100}%` }}
          >
            <button
              type="button"
              className={`is-dot-btn ${selected === d.key ? 'is-dot-sel' : ''} is-dot-${d.state}`}
              style={{ background: d.color }}
              title={`${d.text} (${d.idea.title})`}
              aria-label={`${d.text}. ${d.impact} impact, ${d.state}`}
              data-testid="matrix-dot"
              onClick={() => setSelected(d.key)}
            />
            <button
              type="button"
              className={`is-dot-label ${selected === d.key ? 'is-dot-label-sel' : ''}`}
              tabIndex={-1}
              aria-hidden="true"
              title={`${d.text} (${d.idea.title})`}
              onClick={() => setSelected(d.key)}
            >
              {d.text}
              {d.state === 'disproved' ? ' (disproved)' : ''}
            </button>
          </div>
        ))}
        <div className="is-axis-y">IMPACT IF WRONG → higher</div>
        <div className="is-axis-x">EVIDENCE → stronger</div>
      </div>
      <aside className="is-matrix-side" aria-label="Selected assumption">
        {current ? (
          <>
            <div className="is-label">Selected assumption</div>
            <p className="is-matrix-text">{current.text}</p>
            <dl className="is-dl">
              <dt>Idea</dt>
              <dd>{current.idea.title}</dd>
              <dt>Impact if wrong</dt>
              <dd>{current.impact[0].toUpperCase() + current.impact.slice(1)}</dd>
              <dt>Evidence</dt>
              <dd>{current.evidence ? plural(current.evidence, 'piece') : 'None'}</dd>
              <dt>Status</dt>
              <dd>{current.state[0].toUpperCase() + current.state.slice(1)}</dd>
            </dl>
            <div className="is-matrix-test">
              Test:{' '}
              {current.testTicketId ? (
                <span className="is-ticket-chip">{current.testTicketId}</span>
              ) : (
                <span className="is-muted">No test yet</span>
              )}
            </div>
            <div className="is-side-actions">
              <button type="button" className="is-btn is-btn-primary" onClick={() => onOpen(current.idea.id)}>
                <IdeaIcon name="arrowUpRight" size={14} />
                Open the idea
              </button>
              {current.state !== 'validated' && (
                <button type="button" className="is-btn" onClick={() => setState(current, 'validated')}>
                  <IdeaIcon name="check" size={14} />
                  Mark validated
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="is-muted">
            Pick a dot to see what the assumption is, how it is being tested and which idea it belongs to. Colour shows
            the idea.
          </div>
        )}
      </aside>
    </div>
  );
}
