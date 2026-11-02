// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TagPicker } from './TagPicker';

afterEach(cleanup);

function setup(currentTags: string[] = ['ui']) {
  const onAdd = vi.fn();
  render(<TagPicker projectTags={['ui', 'perf', 'backend', 'perf']} currentTags={currentTags} onAdd={onAdd} />);
  fireEvent.click(screen.getByTestId('tag-add'));
  return { onAdd, input: screen.getByLabelText('Tag name') as HTMLInputElement };
}

describe('TagPicker (Tags 4)', () => {
  it('opens a popover with the project tags the ticket does not have yet', () => {
    setup();
    expect(screen.getByTestId('tag-add').getAttribute('aria-expanded')).toBe('true');
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['backendexisting tag', 'perfexisting tag']);
  });

  it('filters existing tags as you type, and attaches one with a click', () => {
    const { onAdd, input } = setup();
    fireEvent.change(input, { target: { value: 'pe' } });
    expect(screen.getByRole('option', { name: /perf/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Create .pe./ })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /^perf/ }));
    expect(onAdd).toHaveBeenCalledWith('perf');
    expect(screen.queryByTestId('tag-picker')).toBeNull();
  });

  it('creates a new tag with Enter on the Create row', () => {
    const { onAdd, input } = setup();
    fireEvent.change(input, { target: { value: 'Perf-Regression' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('perf-regression');
  });

  it('commits on a comma and stays open; Esc closes without adding', () => {
    const { onAdd, input } = setup();
    fireEvent.change(input, { target: { value: 'dnd' } });
    fireEvent.keyDown(input, { key: ',' });
    expect(onAdd).toHaveBeenCalledWith('dnd');
    expect(screen.getByTestId('tag-picker')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'half' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('tag-picker')).toBeNull();
  });
});
