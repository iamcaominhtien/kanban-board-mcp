// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOUR_STEPS, WhatsNewTour, tourSeen } from './WhatsNewTour';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('the tour of what is new', () => {
  it('walks through the four steps and is not shown again', () => {
    const first = render(<WhatsNewTour />);
    expect(screen.getByText('NEW · 1 OF 4')).toBeTruthy();
    expect(screen.getByText('Colour your words')).toBeTruthy();
    for (let i = 1; i < TOUR_STEPS.length; i++) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Set up the whole page')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('whats-new-tour')).toBeNull();
    expect(tourSeen()).toBe(true);
    first.unmount();
    render(<WhatsNewTour />);
    expect(screen.queryByTestId('whats-new-tour')).toBeNull();
  });

  it('can be skipped at any step, which also counts as seen', () => {
    render(<WhatsNewTour />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(screen.queryByTestId('whats-new-tour')).toBeNull();
    expect(tourSeen()).toBe(true);
  });

  it('is a card at the bottom over a dimmed page on a phone', () => {
    const { container } = render(<WhatsNewTour layout="phone" />);
    expect(screen.getByTestId('whats-new-tour').className).toMatch(/dk-tour-phone/);
    expect(container.querySelector('.dk-tour-scrim')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText(/Choose left or right in a picture’s toolbar\. On a phone/)).toBeTruthy();
  });
});
