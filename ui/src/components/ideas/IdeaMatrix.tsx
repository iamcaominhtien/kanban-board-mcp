import { useMemo, useState } from 'react';
import { ideaRuleError, useEditAssumption } from '../../api/ideas';
import type { AssumptionImpact, AssumptionState, IdeaRow } from '../../types/idea';
import { useToast } from '../Toast';
import { plural } from '../docs/docsShared';

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
        });
      });
    });
    return out;
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
        <div className="is-quad is-quad-tl">TEST THESE FIRST</div>
        <div className="is-quad is-quad-tr">WELL SUPPORTED</div>
        <div className="is-quad is-quad-bl">LOW STAKES, LOW PROOF</div>
        <div className="is-quad is-quad-br">FINE</div>
        {dots.map((d) => (
          <button
            key={d.key}
            type="button"
            className={`is-dot-btn ${selected === d.key ? 'is-dot-sel' : ''} is-dot-${d.state}`}
            style={{ left: `${d.x * 100}%`, bottom: `${d.y * 100}%`, background: d.color }}
            title={`${d.text} (${d.idea.title})`}
            aria-label={`${d.text}. ${d.impact} impact, ${d.state}`}
            data-testid="matrix-dot"
            onClick={() => setSelected(d.key)}
          />
        ))}
        <div className="is-axis-y">IMPACT IF WRONG →</div>
        <div className="is-axis-x">EVIDENCE →</div>
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
              <dt>Test</dt>
              <dd>{current.testTicketId ?? 'No test yet'}</dd>
            </dl>
            <div className="is-side-actions">
              <button type="button" className="is-btn" onClick={() => onOpen(current.idea.id)}>
                Open the idea
              </button>
              {current.state !== 'validated' && (
                <button type="button" className="is-btn is-btn-primary" onClick={() => setState(current, 'validated')}>
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
