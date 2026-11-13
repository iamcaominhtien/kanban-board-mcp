import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('apiSecretOf', () => {
  it('is the secret the desktop app gave the window, read once', async () => {
    const made = crypto.randomUUID(); // made up for this test
    const getApiSecret = vi.fn(() => made);
    vi.stubGlobal('window', { electronAPI: { getApiSecret } });
    const { apiSecretOf } = await import('./client');
    expect(apiSecretOf()).toBe(made);
    expect(apiSecretOf()).toBe(made);
    expect(getApiSecret).toHaveBeenCalledTimes(1);
  });

  it('is null outside the app, where the server checks nothing', async () => {
    vi.stubGlobal('window', {});
    const { apiSecretOf } = await import('./client');
    expect(apiSecretOf()).toBeNull();
  });

  it('is null when the page cannot ask for it', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        getApiSecret: () => {
          throw new Error('no channel');
        },
      },
    });
    const { apiSecretOf } = await import('./client');
    expect(apiSecretOf()).toBeNull();
  });
});

describe('the board of this window', () => {
  it('is sent with every request once known, and a refusal for another board is reported', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:1' } });
    const { client } = await import('./client');
    const board = await import('./boardOfWindow');
    const seen: (string | undefined)[] = [];
    let answer: 'ok' | 'switched' = 'ok';
    client.defaults.adapter = async (config) => {
      seen.push(config.headers.get('X-Kanban-Board') as string | undefined);
      if (answer === 'switched') {
        const response = {
          status: 409,
          data: { detail: { code: 'board_switched' } },
          headers: {},
          config,
          statusText: '',
        };
        throw Object.assign(new Error('409'), { response, config, isAxiosError: true });
      }
      return { status: 200, data: {}, headers: {}, config, statusText: 'OK' };
    };
    await client.get('/projects');
    board.noteBoard('board-a');
    board.noteBoard('board-b'); // only the first board named is the window's
    await client.patch('/tickets/KAN-1', { title: 'x' });
    expect(seen).toEqual([undefined, 'board-a']);
    expect(board.changeWasRefused()).toBe(false);
    answer = 'switched';
    await expect(client.patch('/tickets/KAN-1', { title: 'y' })).rejects.toThrow();
    expect(board.changeWasRefused()).toBe(true);
  });
});
