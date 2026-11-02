// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowBoardRow } from '../../types/aiWorkflowBoard';
import { WorkflowBoardProvider, WorkflowCardChip, useWorkflowRow } from './WorkflowBoardContext';

const row = (over: Partial<WorkflowBoardRow> = {}): WorkflowBoardRow => ({
  ticketId: 'KAN-1',
  templateKey: 'feature',
  templateName: 'Feature',
  state: 'running',
  stopReason: null,
  reviewDepth: null,
  step: 'Build',
  stepKind: 'ai',
  role: 'dev',
  holderId: 'm1',
  holderName: 'Dev An',
  waitsForPerson: false,
  ...over,
});

afterEach(cleanup);

function Probe({ id }: { id: string }) {
  const r = useWorkflowRow(id);
  return <span data-testid="probe">{r ? r.step : 'none'}</span>;
}

describe('WorkflowBoardContext', () => {
  it('finds the row of a ticket by id', () => {
    render(
      <WorkflowBoardProvider rows={[row(), row({ ticketId: 'KAN-2', step: 'Review' })]}>
        <Probe id="KAN-2" />
      </WorkflowBoardProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('Review');
  });

  it('is empty without a provider, without rows, and for an unknown ticket', () => {
    const { unmount } = render(<Probe id="KAN-1" />);
    expect(screen.getByTestId('probe').textContent).toBe('none');
    unmount();
    const second = render(
      <WorkflowBoardProvider rows={undefined}>
        <Probe id="KAN-1" />
      </WorkflowBoardProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('none');
    second.unmount();
    render(
      <WorkflowBoardProvider rows={[row()]}>
        <Probe id="KAN-9" />
      </WorkflowBoardProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('none');
  });
});

describe('WorkflowCardChip', () => {
  const chip = (r: WorkflowBoardRow[] | undefined, id = 'KAN-1') =>
    render(
      <WorkflowBoardProvider rows={r}>
        <WorkflowCardChip ticketId={id} />
      </WorkflowBoardProvider>,
    );

  it('draws the role chip, the step and a full tooltip', () => {
    chip([row()]);
    const el = screen.getByTestId('card-workflow-chip');
    expect(el.textContent).toBe('DVBuild');
    expect(el.getAttribute('title')).toBe('Feature · Build · Dev · held by Dev An');
  });

  it('says when the ticket waits for you', () => {
    chip([row({ waitsForPerson: true, holderName: null })]);
    const el = screen.getByTestId('card-workflow-chip');
    expect(el.textContent).toContain('· waits for you');
    expect(el.getAttribute('title')).toBe('Feature · Build · Dev · waits for you');
  });

  it('draws no role chip for a step without a role', () => {
    chip([row({ role: null, holderName: null })]);
    const el = screen.getByTestId('card-workflow-chip');
    expect(el.textContent).toBe('Build');
    expect(el.getAttribute('title')).toBe('Feature · Build');
  });

  it('draws nothing for a ticket with no row or no step', () => {
    const { container, unmount } = chip([row()], 'KAN-9');
    expect(container.textContent).toBe('');
    unmount();
    const second = chip([row({ step: null })]);
    expect(second.container.textContent).toBe('');
  });
});
