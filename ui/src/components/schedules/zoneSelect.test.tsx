// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZoneSelect } from './MemberSelect';

const ZONES = [
  { id: 'America/New_York', label: 'America/New_York · UTC−4' },
  { id: 'Asia/Ho_Chi_Minh', label: 'Asia/Ho_Chi_Minh · UTC+7' },
  { id: 'UTC', label: 'UTC · UTC+0' },
];

describe('ZoneSelect', () => {
  it('searches the zones and picks one with a click', () => {
    const onChange = vi.fn();
    render(<ZoneSelect zones={ZONES} value="UTC" onChange={onChange} testId="tz" />);
    fireEvent.click(screen.getByTestId('tz'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search time zones' }), { target: { value: 'ho chi' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: /Ho_Chi_Minh/ }));
    expect(onChange).toHaveBeenCalledWith('Asia/Ho_Chi_Minh');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('picks with the keyboard and closes on Escape', () => {
    const onChange = vi.fn();
    render(<ZoneSelect zones={ZONES} value="America/New_York" onChange={onChange} testId="tz" />);
    fireEvent.click(screen.getByTestId('tz'));
    const box = screen.getByRole('textbox', { name: 'Search time zones' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('Asia/Ho_Chi_Minh');
    fireEvent.click(screen.getByTestId('tz'));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search time zones' }), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

afterEach(cleanup);
