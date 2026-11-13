// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectSidebar, workspaceInitials } from './ProjectSidebar';

type Props = Parameters<typeof ProjectSidebar>[0];

const items = [
  { id: 'a1', name: 'Office', active: true },
  { id: 'b2', name: 'Home', active: false },
];

function renderSidebar(workspaces: Props['workspaces']) {
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
      wontDoCount={0}
      activeBoard="main"
      onBoardChange={vi.fn()}
      workspaces={workspaces}
    />,
  );
}

describe('ProjectSidebar workspace switcher', () => {
  afterEach(cleanup);

  it('is hidden with one workspace or none', () => {
    renderSidebar({ items: items.slice(0, 1), switchable: true, onSwitch: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Workspace: Office' })).toBeNull();
    cleanup();
    renderSidebar(null);
    expect(screen.queryByRole('menu', { name: 'Workspaces' })).toBeNull();
  });

  it('names the workspace in use and switches to another one', () => {
    const onSwitch = vi.fn();
    renderSidebar({ items, switchable: true, onSwitch });
    fireEvent.click(screen.getByRole('button', { name: 'Workspace: Office' }));
    const current = screen.getByRole('menuitemradio', { name: 'Office' }) as HTMLButtonElement;
    expect(current.disabled).toBe(true);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Home' }));
    expect(onSwitch).toHaveBeenCalledWith('b2');
    expect(screen.queryByRole('menu', { name: 'Workspaces' })).toBeNull();
  });

  it('turns the rows off while a switch is not possible, and shows the last refusal', () => {
    const onSwitch = vi.fn();
    renderSidebar({ items, switchable: false, onSwitch, error: '2 AI run(s) are working on this board.' });
    fireEvent.click(screen.getByRole('button', { name: 'Workspace: Office' }));
    const home = screen.getByRole('menuitemradio', { name: 'Home' }) as HTMLButtonElement;
    expect(home.disabled).toBe(true);
    expect(screen.getByText('2 AI run(s) are working on this board.')).toBeTruthy();
  });

  it('shows a refusal under the switcher after the menu has closed, until it is dismissed', () => {
    const onDismissError = vi.fn();
    renderSidebar({
      items,
      switchable: true,
      onSwitch: vi.fn(),
      error: 'That board was made by a newer version of the app.',
      onDismissError,
    });
    // the menu is closed, and the person still sees why nothing happened
    expect(screen.queryByRole('menu', { name: 'Workspaces' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('newer version');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissError).toHaveBeenCalledTimes(1);
  });

  it('says it is switching and cannot be started twice', () => {
    renderSidebar({ items, switchable: true, onSwitch: vi.fn(), switching: true });
    const button = screen.getByRole('button', { name: 'Switching workspace' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('closes the menu with Escape and with a click elsewhere', () => {
    renderSidebar({ items, switchable: true, onSwitch: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Workspace: Office' }));
    expect(screen.getByRole('menu', { name: 'Workspaces' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Workspaces' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Workspace: Office' }));
    expect(screen.getByRole('menu', { name: 'Workspaces' })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu', { name: 'Workspaces' })).toBeNull();
  });

  it('moves the focus with the arrow keys and gives it back to the switcher on Escape', () => {
    const three = [...items, { id: 'c3', name: 'Lab', active: false }];
    renderSidebar({ items: three, switchable: true, onSwitch: vi.fn() });
    const switcher = screen.getByRole('button', { name: 'Workspace: Office' });
    fireEvent.click(switcher);
    // the workspace in use cannot be opened: the first one that can has the focus
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Home' }));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Lab' }));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Home' }));
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Lab' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(switcher);
  });

  it('keeps the first letters of the board in use visible for the collapsed rail', () => {
    renderSidebar({ items, switchable: true, onSwitch: vi.fn() });
    expect(screen.getByRole('button', { name: 'Workspace: Office' }).textContent).toContain('OF');
    expect(workspaceInitials('Home Office')).toBe('HO');
    expect(workspaceInitials('  ')).toBe('?');
    expect(workspaceInitials('Đặng')).toBe('ĐẶ');
  });
});
