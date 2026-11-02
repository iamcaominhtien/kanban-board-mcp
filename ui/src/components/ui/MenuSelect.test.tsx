// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MenuSelect } from './MenuSelect';

const OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days', hint: 'The default' },
  { value: 'off', label: 'Turned off', disabled: true },
  { value: '30d', label: 'Last 30 days' },
] as const;

function setup(value: string = '7d') {
  const onChange = vi.fn();
  render(<MenuSelect value={value as never} options={OPTIONS} onChange={onChange} label="Range" variant="button" />);
  return { onChange, trigger: screen.getByRole('button', { name: 'Range' }) };
}

afterEach(cleanup);

describe('MenuSelect', () => {
  it('shows the chosen option and opens a listbox with it selected', () => {
    const { trigger } = setup();
    expect(trigger.textContent).toContain('Last 7 days');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    // a screen reader hears the chosen value after the name
    expect(document.getElementById(trigger.getAttribute('aria-describedby')!)?.textContent).toBe('Last 7 days');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const selected = screen.getByRole('option', { selected: true });
    expect(selected.textContent).toContain('Last 7 days');
    expect(selected.textContent).toContain('The default');
  });

  it('picks an option with the mouse and closes', () => {
    const { trigger, onChange } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /Last 30 days/ }));
    expect(onChange).toHaveBeenCalledWith('30d');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('moves with the arrow keys, skips disabled options and picks with Enter', () => {
    const { trigger, onChange } = setup('7d');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // opens on 7d
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // skips "Turned off"
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('30d');
  });

  it('closes on Esc without choosing, and does nothing for the current value', () => {
    const { trigger, onChange } = setup('7d');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /Last 7 days/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('jumps to an option by typing its first letters', () => {
    const { trigger, onChange } = setup('7d');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.keyDown(trigger, { key: 't' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('today');
  });

  it('does not open while disabled', () => {
    const onChange = vi.fn();
    render(<MenuSelect value="7d" options={OPTIONS} onChange={onChange} label="Range" disabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Range' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
