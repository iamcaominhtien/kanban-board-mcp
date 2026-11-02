// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowFilterState } from '../../types/aiWorkflowBoard';
import { NO_WORKFLOW_FILTER, type WorkflowFilterOptions } from './workflowFilter';
import { WorkflowFilters } from './WorkflowFilters';

const options: WorkflowFilterOptions = {
  roles: ['dev', 'qa'],
  templates: [
    { key: 'feature', name: 'Feature' },
    { key: 'bug', name: 'Bug fix' },
  ],
  steps: ['Build', 'Review'],
  waitingCount: 3,
};

afterEach(cleanup);

function setup(value: WorkflowFilterState = NO_WORKFLOW_FILTER, opts = options) {
  const onChange = vi.fn();
  render(<WorkflowFilters options={opts} value={value} onChange={onChange} />);
  return onChange;
}

describe('WorkflowFilters', () => {
  it('renders nothing when no ticket is on a workflow', () => {
    const { container } = render(
      <WorkflowFilters
        options={{ roles: [], templates: [], steps: [], waitingCount: 0 }}
        value={NO_WORKFLOW_FILTER}
        onChange={() => {}}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('shows the waiting count and toggles Waiting for me', () => {
    const onChange = setup();
    const btn = screen.getByTestId('workflow-filter-waiting');
    expect(btn.textContent).toMatch(/Waiting for me\s*3/);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(onChange).toHaveBeenCalledWith({ ...NO_WORKFLOW_FILTER, waitingForMe: true });
    expect(screen.queryByText('Clear')).toBeNull();
  });

  it('opens the role menu with display names and picks one', () => {
    const onChange = setup();
    fireEvent.click(screen.getByTestId('workflow-filter-role'));
    expect(screen.getByTestId('workflow-filter-role').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'QA' }));
    expect(onChange).toHaveBeenCalledWith({ ...NO_WORKFLOW_FILTER, role: 'qa' });
    expect(screen.getByTestId('workflow-filter-role').getAttribute('aria-expanded')).toBe('false');
  });

  it('picks a workflow and a step, and closes a menu by clicking its button again', () => {
    const onChange = setup();
    fireEvent.click(screen.getByTestId('workflow-filter-template'));
    fireEvent.click(screen.getByRole('button', { name: 'Bug fix' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_WORKFLOW_FILTER, template: 'bug' });
    fireEvent.click(screen.getByTestId('workflow-filter-step'));
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('workflow-filter-step'));
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    fireEvent.click(screen.getByTestId('workflow-filter-step'));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_WORKFLOW_FILTER, step: 'Review' });
  });

  it('labels the active selections and clears them all', () => {
    const onChange = setup({ waitingForMe: true, role: 'dev', template: 'feature', step: 'Build' });
    expect(screen.getByTestId('workflow-filter-waiting').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('workflow-filter-role').textContent).toContain('Dev');
    expect(screen.getByTestId('workflow-filter-template').textContent).toContain('Feature');
    expect(screen.getByTestId('workflow-filter-step').textContent).toContain('Build');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenCalledWith(NO_WORKFLOW_FILTER);
  });

  it('shows All and the unknown key when a stale workflow is selected', () => {
    setup({ ...NO_WORKFLOW_FILTER, template: 'gone' });
    expect(screen.getByTestId('workflow-filter-template').textContent).toContain('gone');
    expect(screen.getByTestId('workflow-filter-role').textContent).toContain('All');
  });

  it('keeps Role, Workflow and Step directly on the bar, each showing its value, with no More filters control', () => {
    setup({ ...NO_WORKFLOW_FILTER, role: 'dev', step: 'Build' });
    expect(screen.queryByTestId('workflow-filter-more')).toBeNull();
    expect(screen.getByTestId('workflow-filter-role').textContent).toContain('Dev');
    expect(screen.getByTestId('workflow-filter-template').textContent).toContain('All');
    expect(screen.getByTestId('workflow-filter-step').textContent).toContain('Build');
  });

  it('hides the role and step menus when there is nothing to choose', () => {
    setup(NO_WORKFLOW_FILTER, { ...options, roles: [], steps: [] });
    expect(screen.queryByTestId('workflow-filter-role')).toBeNull();
    expect(screen.queryByTestId('workflow-filter-step')).toBeNull();
    expect(screen.getByTestId('workflow-filter-template')).toBeTruthy();
  });
});
