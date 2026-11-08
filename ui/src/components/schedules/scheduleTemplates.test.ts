import { describe, expect, it } from 'vitest';
import { SCHEDULE_TEMPLATES } from './scheduleTemplates';
import { normalizeTime } from './schedulesUi';

describe('normalizeTime', () => {
  it('reads the usual ways to type a time of day in 24 h', () => {
    expect(normalizeTime('02:00')).toBe('02:00');
    expect(normalizeTime('2:30')).toBe('02:30');
    expect(normalizeTime('0230')).toBe('02:30');
    expect(normalizeTime('230')).toBe('02:30');
    expect(normalizeTime('18')).toBe('18:00');
    expect(normalizeTime('23:59')).toBe('23:59');
  });

  it('refuses what is not a time', () => {
    for (const bad of ['', '24:00', '12:60', '9am', 'noon', '1:2', '123456']) expect(normalizeTime(bad)).toBeNull();
  });
});

describe('schedule templates', () => {
  it('are repeating schedules with a valid time and at least one day', () => {
    expect(SCHEDULE_TEMPLATES.map((t) => t.id)).toEqual(['nightly-tests', 'weekly-dependencies', 'daily-summary']);
    for (const t of SCHEDULE_TEMPLATES) {
      expect(t.patch.kind).toBe('repeat');
      expect(normalizeTime(t.patch.time ?? '')).toBe(t.patch.time);
      expect(t.patch.days?.length).toBeGreaterThan(0);
      expect(t.patch.instruction).toBeTruthy();
    }
  });

  it('never change the ticket, the AI or the time zone the person chose', () => {
    for (const t of SCHEDULE_TEMPLATES) {
      expect(t.patch).not.toHaveProperty('ticketId');
      expect(t.patch).not.toHaveProperty('memberId');
      expect(t.patch).not.toHaveProperty('tz');
    }
  });
});
