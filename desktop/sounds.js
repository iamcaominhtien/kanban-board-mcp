// The sound of a Needs you notice (#270). The window may be closed (macOS keeps the app running), so nothing here
// needs a page: the three sounds are rendered to a small WAV file once and handed to the system's own player
// (afplay on macOS, the Windows media player through PowerShell, paplay or aplay on Linux).
//
// The notes are the same as ui/src/utils/notificationSound.ts plays in the browser and in the window: keep the two
// tables in step (tests/sounds.test.js pins the names and the notes of the first).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SAMPLE_RATE = 22050;

const SOUNDS = {
  chime: {
    wave: 'sine',
    gain: 0.16,
    notes: [
      { freq: 659.25, at: 0, dur: 0.35 },
      { freq: 880, at: 0.13, dur: 0.5 },
    ],
  },
  drop: { wave: 'sine', gain: 0.2, notes: [{ freq: 988, to: 622, at: 0, dur: 0.3 }] },
  bell: {
    wave: 'triangle',
    gain: 0.14,
    notes: [
      { freq: 784, at: 0, dur: 0.9 },
      { freq: 1568, at: 0, dur: 0.5, gain: 0.35 },
    ],
  },
};

const NAMES = Object.keys(SOUNDS);

/** The sound's name, or the chime for a name it does not know. */
function soundNameOf(name) {
  return Object.hasOwn(SOUNDS, name) ? name : 'chime';
}

function wave(kind, phase) {
  if (kind === 'triangle') return 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1;
  return Math.sin(2 * Math.PI * phase);
}

/** The sound as a mono 16-bit PCM WAV (a Buffer), with the same attack and decay as the browser's envelope. */
function renderWav(name) {
  const spec = SOUNDS[soundNameOf(name)];
  const total = Math.max(...spec.notes.map((n) => n.at + n.dur)) + 0.05;
  const count = Math.ceil(total * SAMPLE_RATE);
  const mix = new Float64Array(count);
  for (const note of spec.notes) {
    const start = Math.floor(note.at * SAMPLE_RATE);
    const length = Math.floor(note.dur * SAMPLE_RATE);
    const peak = spec.gain * (note.gain ?? 1);
    let phase = 0;
    for (let i = 0; i < length && start + i < count; i += 1) {
      const t = i / length;
      const freq = note.to ? note.freq * (note.to / note.freq) ** t : note.freq;
      phase += freq / SAMPLE_RATE;
      // 15 ms attack, then an exponential fall to silence over the rest of the note
      const attack = Math.min(1, i / (0.015 * SAMPLE_RATE));
      const decay = 0.0001 ** t;
      mix[start + i] += wave(spec.wave, phase) * peak * attack * decay;
    }
  }
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix[i])) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The players to try, in order, for a platform: [command, args]. */
function playersFor(platform, file) {
  if (platform === 'darwin') return [['afplay', [file]]];
  if (platform === 'win32') {
    const quoted = `'${file.replaceAll("'", "''")}'`;
    return [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer ${quoted}).PlaySync()`]]];
  }
  return [
    ['paplay', [file]],
    ['aplay', ['-q', file]],
  ];
}

/**
 * The player the notifier uses. `play(name)` never throws and never waits; `usable()` is false once every player
 * of the platform was found missing, so the notice can fall back to the system's own sound.
 *
 * deps (for tests): { platform, dir, spawn, fs }.
 */
function createSoundPlayer(deps = {}) {
  const platform = deps.platform || process.platform;
  const run = deps.spawn || spawn;
  const fsx = deps.fs || fs;
  const dir = deps.dir || path.join(os.tmpdir(), 'kanban-board-sounds');
  const written = new Map(); // name -> file
  let missing = 0; // players found missing (ENOENT) in a row

  function fileFor(name) {
    if (written.has(name)) return written.get(name);
    fsx.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.wav`);
    fsx.writeFileSync(file, renderWav(name));
    written.set(name, file);
    return file;
  }

  function attempt(players, index) {
    if (index >= players.length) {
      missing = players.length;
      return;
    }
    const [command, args] = players[index];
    let child;
    try {
      child = run(command, args, { stdio: 'ignore', windowsHide: true });
    } catch {
      attempt(players, index + 1);
      return;
    }
    child.on?.('error', () => attempt(players, index + 1)); // ENOENT: try the next one
    child.unref?.();
  }

  return {
    usable() {
      return missing < playersFor(platform, 'x').length;
    },
    play(name) {
      try {
        attempt(playersFor(platform, fileFor(soundNameOf(name))), 0);
      } catch (err) {
        console.error('[notifier] sound:', err.message);
      }
    },
  };
}

module.exports = { SOUNDS, NAMES, SAMPLE_RATE, soundNameOf, renderWav, playersFor, createSoundPlayer };
