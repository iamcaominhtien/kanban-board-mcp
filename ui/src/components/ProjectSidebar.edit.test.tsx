// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectSidebar } from './ProjectSidebar';
import type { Project } from '../types';

const projects: Project[] = [
  { id: 'p1', name: 'Alpha', prefix: 'ALP', color: '#AACC2E', ticketCounter: 0 },
  { id: 'p2', name: 'Beta', prefix: 'BET', color: '#F472B6', ticketCounter: 0 },
];

function renderSidebar(over: Partial<Parameters<typeof ProjectSidebar>[0]> = {}) {
  const props = {
    projects,
    currentProjectId: 'p1',
    onSelectProject: vi.fn(),
    onCreateProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onUpdateProject: vi.fn().mockResolvedValue(undefined),
    onOpenRecycleBin: vi.fn(),
    onOpenMembers: vi.fn(),
    onOpenSettings: vi.fn(),
    wontDoCount: 0,
    activeBoard: 'main' as const,
    onBoardChange: vi.fn(),
    ...over,
  };
  render(<ProjectSidebar {...props} />);
  return props;
}

describe('ProjectSidebar edit and delete', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('edits the name and colour of a project; the prefix stays', async () => {
    const props = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Beta' }));
    expect(screen.getByText('Edit Project')).toBeTruthy();
    const prefix = screen.getByPlaceholderText('Prefix (e.g. PROJ)') as HTMLInputElement;
    expect(prefix.value).toBe('BET');
    expect(prefix.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Project name'), { target: { value: 'Beta Two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Color #5BB8F5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(props.onUpdateProject).toHaveBeenCalledWith('p2', { name: 'Beta Two', color: '#5BB8F5' }),
    );
    await waitFor(() => expect(screen.queryByText('Edit Project')).toBeNull());
    expect(props.onSelectProject).not.toHaveBeenCalled();
  });

  it('shows the save error in the form and keeps it open', async () => {
    renderSidebar({ onUpdateProject: vi.fn().mockRejectedValue(new Error('boom')) });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Error: boom/);
    expect(screen.getByText('Edit Project')).toBeTruthy();
  });

  it('Cancel leaves the edit; New Project then starts empty', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByTitle('New Project'));
    expect(screen.getByText('New Project')).toBeTruthy();
    expect((screen.getByPlaceholderText('Project name') as HTMLInputElement).value).toBe('');
  });

  it('offers Delete on the open project and on the last one, after a confirm', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const props = renderSidebar({ projects: [projects[0]] });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha' }));
    expect(window.confirm).toHaveBeenCalled();
    expect(props.onDeleteProject).toHaveBeenCalledWith('p1');
  });
});
