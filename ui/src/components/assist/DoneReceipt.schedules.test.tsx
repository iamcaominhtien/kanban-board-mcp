// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { appliedWords, proposedWords } from './DoneReceipt';

describe('the Board AI’s schedule changes in words', () => {
  it('says what a made, changed, paused and run schedule did', () => {
    expect(appliedWords({ op: 'schedule_create', ticket: 'KAN-1', when: 'Weekdays at 02:00' })).toBe(
      'scheduled: weekdays at 02:00',
    );
    expect(appliedWords({ op: 'schedule_edit', ticket: 'KAN-1', after: { time: '17:30', review: { on: true } } })).toBe(
      'schedule changed: now at 17:30, AI review on',
    );
    expect(appliedWords({ op: 'schedule_edit', ticket: 'KAN-1', after: {} })).toBe(
      'schedule changed: settings changed',
    );
    expect(appliedWords({ op: 'schedule_pause', ticket: 'KAN-1' })).toBe('schedule paused');
    expect(appliedWords({ op: 'schedule_resume', ticket: 'KAN-1' })).toBe('schedule resumed');
    expect(appliedWords({ op: 'schedule_run', ticket: 'KAN-1' })).toBe('schedule run started');
    expect(appliedWords({ op: 'schedule_delete', ticket: 'KAN-1' })).toBe('schedule deleted');
  });

  it('shows a proposed schedule before it is made, and a delete as a delete', () => {
    const made = proposedWords({
      op: 'schedule_create',
      ticket: 'KAN-1',
      memberName: 'Claude Code · Backend',
      fields: { kind: 'repeat', days: [0, 1, 2, 3, 4], time: '02:00', tz: 'Asia/Ho_Chi_Minh', review: { on: true } },
    });
    const { container } = render(<>{made}</>);
    expect(container.textContent).toContain('New schedule on KAN-1');
    expect(container.textContent).toContain(
      'Mon, Tue, Wed, Thu, Fri at 02:00 (Asia/Ho_Chi_Minh) Claude Code · Backend with AI review',
    );
    const gone = render(<>{proposedWords({ op: 'schedule_delete', ticket: '', schedule: 'sch_1' })}</>);
    expect(gone.container.textContent).toBe('Delete a schedule sch_1');
  });
});
