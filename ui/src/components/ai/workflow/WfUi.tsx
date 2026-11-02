import type { ReactNode } from 'react';
import type { WorkflowStep } from '../../../types/aiWorkflow';
import { roleLook, stepChainLabel } from './wfFormat';
import './workflow.css';

/** The two-letter chip of a role (TR, PM, BA, DS, DV, QA, UT, RV). */
export function RoleChip({ role, title }: { role: string | null; title?: string }) {
  const l = roleLook(role);
  return (
    <span
      className="wf-role"
      title={title ?? role ?? ''}
      aria-hidden="true"
      style={{ background: l.bg, color: l.fg, borderColor: l.border }}
    >
      {l.glyph}
    </span>
  );
}

/** "Triage › Fix (Dev) › Checks › Review (Light) › Done". The step done by code is italic; a stop for you is amber. */
export function StepChain({
  steps,
  names,
  selected,
  onSelect,
}: {
  steps: WorkflowStep[];
  names?: Record<string, string>;
  selected?: number;
  onSelect?: (i: number) => void;
}) {
  const out: ReactNode[] = [];
  steps.forEach((s, i) => {
    // The "›" stays with the chip after it, so a line never ends on a dangling separator (design E)
    const sep =
      i > 0 ? (
        <span className="wf-sep" aria-hidden="true">
          &rsaquo;
        </span>
      ) : null;
    const text = stepChainLabel(s, names);
    const inner =
      s.kind === 'code' ? <i>{text}</i> : s.kind === 'person' && i < steps.length - 1 ? <b>{text}</b> : text;
    const cls = `wf-pill${s.kind === 'person' && i < steps.length - 1 ? ' wf-pill-you' : ''}${selected === i ? ' on' : ''}`;
    const pill = onSelect ? (
      <button
        key={`${s.key}${i}`}
        type="button"
        className={cls}
        aria-pressed={selected === i}
        data-testid={`chain-step-${i}`}
        onClick={() => onSelect(i)}
      >
        {inner}
      </button>
    ) : (
      <span key={`${s.key}${i}`} className={cls} data-testid="chain-step">
        {inner}
      </span>
    );
    out.push(
      <span key={`${s.key}${i}`} className="wf-chain-item">
        {sep}
        {pill}
      </span>,
    );
  });
  return <div className="wf-chain">{out}</div>;
}
