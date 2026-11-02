/**
 * The short sounds a Needs you notification can make (#270): a choice of three, plus off (the setting, not a name).
 * They are synthesised here, so there is nothing to download. desktop/sounds.js plays the same three notes for the
 * desktop app when its window is closed or in the background: keep the two tables in step.
 */

export type SoundName = 'chime' | 'drop' | 'bell';

export interface SoundNote {
  /** Hz at the start. */
  freq: number;
  /** Hz at the end of the note, when it glides. */
  to?: number;
  /** Seconds after the start of the sound. */
  at: number;
  /** Seconds the note rings. */
  dur: number;
  /** Relative loudness, 1 when left out. */
  gain?: number;
}

export interface SoundSpec {
  label: string;
  wave: OscillatorType;
  gain: number;
  notes: SoundNote[];
}

export const SOUND_NAMES: SoundName[] = ['chime', 'drop', 'bell'];

export const SOUNDS: Record<SoundName, SoundSpec> = {
  // two soft notes going up
  chime: {
    label: 'Chime',
    wave: 'sine',
    gain: 0.16,
    notes: [
      { freq: 659.25, at: 0, dur: 0.35 },
      { freq: 880, at: 0.13, dur: 0.5 },
    ],
  },
  // one note falling, like a drop of water
  drop: { label: 'Drop', wave: 'sine', gain: 0.2, notes: [{ freq: 988, to: 622, at: 0, dur: 0.3 }] },
  // a small bell: a note with its octave above, ringing longer
  bell: {
    label: 'Bell',
    wave: 'triangle',
    gain: 0.14,
    notes: [
      { freq: 784, at: 0, dur: 0.9 },
      { freq: 1568, at: 0, dur: 0.5, gain: 0.35 },
    ],
  },
};

/** Whether a value names one of the sounds. */
export function isSoundName(value: unknown): value is SoundName {
  return typeof value === 'string' && value in SOUNDS;
}

type AudioContextCtor = typeof AudioContext;

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (context) return context;
  const Ctor: AudioContextCtor | undefined =
    typeof window === 'undefined'
      ? undefined
      : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext);
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    context = null;
  }
  return context;
}

/** A browser lets a page make sound only after the person did something on it; the first click or key unlocks it. */
export function unlockAudioOnFirstGesture(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const events = ['pointerdown', 'keydown', 'touchstart'] as const;
  const unlock = () => {
    const ctx = audioContext();
    if (ctx?.state === 'suspended') void ctx.resume().catch(() => undefined);
    for (const e of events) window.removeEventListener(e, unlock);
  };
  for (const e of events) window.addEventListener(e, unlock, { passive: true });
  return () => {
    for (const e of events) window.removeEventListener(e, unlock);
  };
}

const RESUME_WAIT_MS = 300;

/**
 * Plays a sound; resolves true when it was started, false when the browser would not let this page make sound
 * (nobody has clicked on it yet) or there is no audio at all. It never throws.
 */
export async function playNotificationSound(name: string): Promise<boolean> {
  const spec = isSoundName(name) ? SOUNDS[name] : SOUNDS.chime;
  const ctx = audioContext();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') {
      // without a gesture resume() can wait for ever: do not make the notification wait for it
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, RESUME_WAIT_MS))]);
    }
    if (ctx.state !== 'running') return false;
    const start = ctx.currentTime + 0.02;
    for (const note of spec.notes) {
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      const from = start + note.at;
      const peak = spec.gain * (note.gain ?? 1);
      osc.type = spec.wave;
      osc.frequency.setValueAtTime(note.freq, from);
      if (note.to) osc.frequency.exponentialRampToValueAtTime(note.to, from + note.dur);
      amp.gain.setValueAtTime(0.0001, from);
      amp.gain.exponentialRampToValueAtTime(peak, from + 0.015);
      amp.gain.exponentialRampToValueAtTime(0.0001, from + note.dur);
      osc.connect(amp).connect(ctx.destination);
      osc.start(from);
      osc.stop(from + note.dur + 0.05);
    }
    return true;
  } catch {
    return false;
  }
}
