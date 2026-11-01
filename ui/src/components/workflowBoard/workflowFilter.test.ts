import { describe, expect, it } from 'vitest';
import type { WorkflowBoardRow } from '../../types/aiWorkflowBoard';
import { NO_WORKFLOW_FILTER, matchesWorkflowFilter, roleChip, workflowFilterOptions } from './workflowFilter';

const row = (o: Partial<WorkflowBoardRow>): WorkflowBoardRow => ({
  ticketId: 't1',
  templateKey: 'standard',
  templateName: 'Standard feature',
  state: 'running',
  stopReason: null,
  reviewDepth: null,
  step: 'Review',
  stepKind: 'ai',
  role: 'reviewer',
  holderId: 'm1',
  holderName: 'Rev',
  waitsForPerson: false,
  ...o,
});

describe('workflow filter predicate', () => {
  it('lets everything through while no filter is on', () => {
    expect(matchesWorkflowFilter(undefined, NO_WORKFLOW_FILTER)).toBe(true);
    expect(matchesWorkflowFilter(row({}), NO_WORKFLOW_FILTER)).toBe(true);
  });

  it('hides tickets without a workflow once a filter is on', () => {
    expect(matchesWorkflowFilter(undefined, { ...NO_WORKFLOW_FILTER, role: 'dev' })).toBe(false);
  });

  it('filters by waiting, role, workflow and step', () => {
    expect(matchesWorkflowFilter(row({ waitsForPerson: true }), { ...NO_WORKFLOW_FILTER, waitingForMe: true })).toBe(
      true,
    );
    expect(matchesWorkflowFilter(row({}), { ...NO_WORKFLOW_FILTER, waitingForMe: true })).toBe(false);
    expect(matchesWorkflowFilter(row({}), { ...NO_WORKFLOW_FILTER, role: 'reviewer' })).toBe(true);
    expect(matchesWorkflowFilter(row({}), { ...NO_WORKFLOW_FILTER, role: 'dev' })).toBe(false);
    expect(matchesWorkflowFilter(row({}), { ...NO_WORKFLOW_FILTER, template: 'quick' })).toBe(false);
    expect(matchesWorkflowFilter(row({}), { ...NO_WORKFLOW_FILTER, step: 'Review', template: 'standard' })).toBe(true);
  });

  it('builds the options from the rows, and none when there are no workflows', () => {
    expect(workflowFilterOptions([]).templates).toEqual([]);
    const o = workflowFilterOptions([
      row({}),
      row({ ticketId: 't2', role: 'dev', step: 'Build', waitsForPerson: true }),
    ]);
    expect(o).toMatchObject({ roles: ['dev', 'reviewer'], steps: ['Build', 'Review'], waitingCount: 1 });
  });

  it('names role chips', () => {
    expect(roleChip('user_tester')).toBe('UT');
    expect(roleChip(null)).toBeNull();
  });
});
