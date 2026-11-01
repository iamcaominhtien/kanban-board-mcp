// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';

let api: ReturnType<typeof useToast>;
function Grab() {
  api = useToast();
  return null;
}
const mount = () =>
  render(
    <ToastProvider>
      <Grab />
    </ToastProvider>,
  );

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('at most three toasts, a fourth collapses the oldest into "+N more" that opens the panel', () => {
  mount();
  act(() => {
    for (let i = 1; i <= 5; i++) api.error(`Problem ${i}`);
  });
  expect(screen.getAllByRole('alert')).toHaveLength(3);
  expect(screen.queryByText('Problem 1')).toBeNull();
  expect(screen.getByText('Problem 5')).toBeTruthy();
  expect(screen.getByText('+2 more')).toBeTruthy();
  const seen: unknown[] = [];
  const on = (e: Event) => seen.push((e as CustomEvent).detail);
  window.addEventListener('kanban:notifications', on);
  fireEvent.click(screen.getByText('Open'));
  window.removeEventListener('kanban:notifications', on);
  expect(seen).toEqual([{ open: 'panel' }]);
  expect(screen.queryByTestId('toast-more')).toBeNull();
});

test('success and info without a second action become one quiet line that a new one replaces', () => {
  mount();
  const undo = vi.fn();
  act(() => {
    api.success('Saved');
    api.info('Moved to Done', undefined, undefined, { label: 'Undo', onClick: undo });
  });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('Saved')).toBeNull();
  expect(screen.getAllByRole('status')).toHaveLength(1);
  fireEvent.click(screen.getByText('Undo'));
  expect(undo).toHaveBeenCalled();
  act(() => {
    api.quiet('Copied');
  });
  expect(screen.getByText('Copied')).toBeTruthy();
  act(() => void vi.advanceTimersByTime(2100));
  expect(screen.queryByRole('status')).toBeNull();
});

test('errors, warnings and two-action toasts stay real toasts', () => {
  mount();
  act(() => {
    api.error('Could not save');
    api.showToast({
      variant: 'info',
      title: 'Approval',
      action: { label: 'Review', onClick: () => undefined },
      secondaryAction: { label: 'Deny', onClick: () => undefined },
    });
  });
  expect(screen.getAllByRole('alert')).toHaveLength(2);
  expect(screen.queryByRole('status')).toBeNull();
});

test('hovering a toast stops its timer', () => {
  mount();
  act(() => {
    api.error('Hold on', undefined, 1000);
  });
  const toast = screen.getByRole('alert');
  act(() => void vi.advanceTimersByTime(600));
  fireEvent.mouseEnter(toast);
  act(() => void vi.advanceTimersByTime(5000));
  expect(screen.queryByText('Hold on')).toBeTruthy();
  fireEvent.mouseLeave(toast);
  act(() => void vi.advanceTimersByTime(500));
  expect(screen.queryByText('Hold on')).toBeNull();
});

test('removeToast closes a toast by id', () => {
  mount();
  let id = '';
  act(() => {
    id = api.warning('Closes itself', undefined, 0);
  });
  expect(screen.getByText('Closes itself')).toBeTruthy();
  act(() => api.removeToast(id));
  expect(screen.queryByText('Closes itself')).toBeNull();
});
