// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Param = {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
};
const param = (): Param => ({ value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });

function installAudio(state: 'running' | 'suspended', resume?: () => Promise<void>) {
  const oscillators: { frequency: Param; start: ReturnType<typeof vi.fn>; type: string }[] = [];
  class FakeContext {
    state = state;
    currentTime = 0;
    destination = {};
    resume = vi.fn(resume ?? (async () => undefined));
    createOscillator() {
      const o = { frequency: param(), start: vi.fn(), stop: vi.fn(), type: 'sine', connect: (n: unknown) => n };
      oscillators.push(o);
      return o;
    }
    createGain() {
      return { gain: param(), connect: (n: unknown) => n };
    }
  }
  vi.stubGlobal('AudioContext', FakeContext);
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
  return oscillators;
}

describe('notificationSound', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it('has three sounds, each with notes', async () => {
    const { SOUNDS, SOUND_NAMES, isSoundName } = await import('./notificationSound');
    expect(SOUND_NAMES).toEqual(['chime', 'drop', 'bell']);
    for (const name of SOUND_NAMES) expect(SOUNDS[name].notes.length).toBeGreaterThan(0);
    expect(isSoundName('chime')).toBe(true);
    expect(isSoundName('airhorn')).toBe(false);
    expect(isSoundName(undefined)).toBe(false);
  });

  it('plays the notes of the sound it was asked for', async () => {
    const oscillators = installAudio('running');
    const { playNotificationSound } = await import('./notificationSound');
    expect(await playNotificationSound('chime')).toBe(true);
    expect(oscillators.map((o) => o.frequency.setValueAtTime.mock.calls[0][0])).toEqual([659.25, 880]);
    oscillators.length = 0;
    expect(await playNotificationSound('drop')).toBe(true);
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(622, expect.any(Number));
  });

  it('falls back to the chime for a name it does not know', async () => {
    const oscillators = installAudio('running');
    const { playNotificationSound } = await import('./notificationSound');
    await playNotificationSound('airhorn');
    expect(oscillators).toHaveLength(2);
  });

  it('says false, and does not wait for ever, when the browser keeps the page silent', async () => {
    const oscillators = installAudio('suspended', () => new Promise(() => undefined));
    const { playNotificationSound } = await import('./notificationSound');
    expect(await playNotificationSound('bell')).toBe(false);
    expect(oscillators).toHaveLength(0);
  });

  it('says false when there is no audio at all', async () => {
    const { playNotificationSound } = await import('./notificationSound');
    expect(await playNotificationSound('bell')).toBe(false);
  });

  it('unlocks the audio on the first click', async () => {
    installAudio('suspended');
    const { unlockAudioOnFirstGesture } = await import('./notificationSound');
    const off = unlockAudioOnFirstGesture();
    window.dispatchEvent(new Event('pointerdown'));
    off();
    // a second gesture does nothing more: the listeners are gone (no throw)
    window.dispatchEvent(new Event('pointerdown'));
  });
});
