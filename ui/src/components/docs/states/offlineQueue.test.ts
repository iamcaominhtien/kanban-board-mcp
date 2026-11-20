// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('../../../api/client', () => ({ client: { request: (...a: unknown[]) => request(...a) } }));

import { flushQueue, isNoConnection, queuedWrites, resetQueueForTests, sendOrQueue } from './offlineQueue';

const setOnline = (on: boolean) => Object.defineProperty(navigator, 'onLine', { value: on, configurable: true });
const noNet = Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
const hl = (n: number) => ({
  method: 'post' as const,
  path: '/docs/pages/p1/highlights',
  data: { n },
  pageId: 'p1',
  label: 'Highlight',
});

beforeEach(() => {
  resetQueueForTests();
  request.mockReset();
  setOnline(true);
});
afterEach(() => setOnline(true));

describe('the offline queue (Docs states D 21-25)', () => {
  it('sends at once when online', async () => {
    request.mockResolvedValueOnce({ data: { id: 'h1' } });
    const r = await sendOrQueue(hl(1));
    expect(r).toEqual({ sent: true, data: { id: 'h1' } });
    expect(queuedWrites()).toHaveLength(0);
  });

  it('queues offline, keeps it in the browser, and sends in order when back', async () => {
    setOnline(false);
    const a = await sendOrQueue(hl(1));
    const b = await sendOrQueue(hl(2));
    expect(a.sent || b.sent).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('docsOfflineQueue') ?? '[]')).toHaveLength(2);
    expect(queuedWrites('p1').map((w) => (w.data as { n: number }).n)).toEqual([1, 2]);
    setOnline(true);
    request.mockResolvedValue({ data: {} });
    expect(await flushQueue()).toBe(2);
    expect(request.mock.calls.map((c) => (c[0] as { data: { n: number } }).data.n)).toEqual([1, 2]);
    expect(localStorage.getItem('docsOfflineQueue')).toBeNull();
  });

  it('queues a write whose request finds no connection, and after one waits, keeps the order', async () => {
    request.mockRejectedValueOnce(noNet);
    expect((await sendOrQueue(hl(1))).sent).toBe(false);
    // the first still waits: the next is queued behind it, not sent ahead
    expect((await sendOrQueue(hl(2))).sent).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not queue a refusal, and drops a refused write while flushing', async () => {
    const refused = Object.assign(new Error('400'), { response: { status: 400 } });
    request.mockRejectedValueOnce(refused);
    await expect(sendOrQueue(hl(1))).rejects.toBe(refused);
    setOnline(false);
    await sendOrQueue(hl(2));
    await sendOrQueue(hl(3));
    setOnline(true);
    request.mockRejectedValueOnce(refused).mockRejectedValueOnce(noNet);
    expect(await flushQueue()).toBe(0);
    // 2 was refused and dropped; 3 found no connection and still waits
    expect(queuedWrites().map((w) => (w.data as { n: number }).n)).toEqual([3]);
  });

  it('tells a lost connection from an answer', () => {
    expect(isNoConnection(noNet)).toBe(true);
    expect(isNoConnection({ response: { status: 500 } })).toBe(false);
  });
});
