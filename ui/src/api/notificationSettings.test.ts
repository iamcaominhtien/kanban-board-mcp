// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const c = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('./client', () => ({ client: c }));

import {
  deleteFollow,
  followKey,
  getFollow,
  getNotificationSettings,
  patchNotificationSettings,
  putFollow,
} from './notificationSettings';

describe('notificationSettings api', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the settings', async () => {
    c.get.mockResolvedValue({ data: { sound: true } });
    expect(await getNotificationSettings()).toEqual({ sound: true });
    expect(c.get).toHaveBeenCalledWith('/notifications/settings');
  });

  it('patches the settings', async () => {
    c.patch.mockResolvedValue({ data: { dnd: true } });
    expect(await patchNotificationSettings({ dnd: true })).toEqual({ dnd: true });
    expect(c.patch).toHaveBeenCalledWith('/notifications/settings', { dnd: true });
  });

  it('maps a patch error to the server message', async () => {
    c.patch.mockRejectedValue({ response: { data: { detail: 'Bad time' } } });
    await expect(patchNotificationSettings({ sound: false })).rejects.toThrow('Bad time');
  });

  it('reads a follow state with scope params', async () => {
    c.get.mockResolvedValue({ data: { level: 'follow' } });
    expect(await getFollow('ticket', 'KAN-1')).toEqual({ level: 'follow' });
    expect(c.get).toHaveBeenCalledWith('/notifications/follow', { params: { scope: 'ticket', scope_id: 'KAN-1' } });
  });

  it('puts a follow', async () => {
    c.put.mockResolvedValue({ data: { level: 'mute' } });
    const body = { scope: 'page' as const, scopeId: 'p1', level: 'mute' as const, minutes: 60 };
    expect(await putFollow(body)).toEqual({ level: 'mute' });
    expect(c.put).toHaveBeenCalledWith('/notifications/follow', body);
  });

  it('deletes a follow', async () => {
    c.delete.mockResolvedValue({});
    await deleteFollow('f1');
    expect(c.delete).toHaveBeenCalledWith('/notifications/follow/f1');
  });

  it('builds the follow key', () => {
    expect(followKey('page', 'x')).toEqual(['notifications', 'follow', 'page', 'x']);
  });
});
