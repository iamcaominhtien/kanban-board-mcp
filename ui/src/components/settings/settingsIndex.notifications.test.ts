import { describe, expect, it } from 'vitest';
import { SETTINGS_INDEX, SETTINGS_PAGES, isSettingsPageId, searchSettings } from './settingsIndex';

describe('settings index: notifications', () => {
  it('has the notifications page', () => {
    const page = SETTINGS_PAGES.find((p) => p.id === 'notifications');
    expect(page?.label).toBe('Notifications');
    expect(isSettingsPageId('notifications')).toBe(true);
    expect(isSettingsPageId('nope')).toBe(false);
  });

  it('has its search entries', () => {
    const ids = SETTINGS_INDEX.filter((e) => e.page === 'notifications').map((e) => e.id);
    expect(ids).toEqual([
      'notif-events',
      'notif-desktop',
      'notif-quiet',
      'notif-dnd',
      'notif-sound',
      'notif-remind',
      'notif-daycard',
      'notif-retention',
      'notif-muted',
    ]);
  });

  it('finds them by name, keyword and description', () => {
    expect(searchSettings('quiet hours', true).map((e) => e.id)).toContain('notif-quiet');
    expect(searchSettings('unmute', false).map((e) => e.id)).toContain('notif-muted');
    expect(searchSettings('retention days', false).map((e) => e.id)).toContain('notif-retention');
    expect(searchSettings('', true)).toEqual([]);
    expect(searchSettings('zzzznothing', true)).toEqual([]);
  });
});
