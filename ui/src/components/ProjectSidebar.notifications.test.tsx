// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectSidebar } from './ProjectSidebar';

type Props = Parameters<typeof ProjectSidebar>[0];

function renderSidebar(notifications: Props['notifications']) {
  return render(
    <ProjectSidebar
      projects={[]}
      currentProjectId=""
      onSelectProject={vi.fn()}
      onCreateProject={vi.fn()}
      onDeleteProject={vi.fn()}
      onOpenRecycleBin={vi.fn()}
      onOpenMembers={vi.fn()}
      onOpenSettings={vi.fn()}
      notifications={notifications}
      wontDoCount={0}
      activeBoard="main"
      onBoardChange={vi.fn()}
    />,
  );
}

describe('ProjectSidebar notifications entry', () => {
  afterEach(cleanup);

  it('is hidden when nothing needs you', () => {
    renderSidebar({ onClick: vi.fn(), needs: 0 });
    expect(screen.queryByTestId('sidebar-notifications')).toBeNull();
  });

  it('is hidden without the prop', () => {
    renderSidebar(null);
    expect(screen.queryByTestId('sidebar-notifications')).toBeNull();
  });

  it('shows the count and calls onClick', () => {
    const onClick = vi.fn();
    renderSidebar({ onClick, needs: 3 });
    const btn = screen.getByTestId('sidebar-notifications');
    expect(btn.textContent).toContain('Notifications');
    expect(btn.textContent).toContain('3');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
