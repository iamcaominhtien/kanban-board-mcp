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
