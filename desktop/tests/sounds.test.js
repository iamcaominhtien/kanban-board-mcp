const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SOUNDS,
  NAMES,
  SAMPLE_RATE,
  soundNameOf,
  renderWav,
  playersFor,
  createSoundPlayer,
} = require("../sounds");

test("three sounds, the chime for a name nobody knows", () => {
  assert.deepStrictEqual(NAMES, ["chime", "drop", "bell"]);
  assert.strictEqual(soundNameOf("bell"), "bell");
  assert.strictEqual(soundNameOf("airhorn"), "chime");
  assert.strictEqual(soundNameOf(undefined), "chime");
  assert.strictEqual(soundNameOf("toString"), "chime");
});

test("the notes are the ones the browser plays (ui/src/utils/notificationSound.ts)", () => {
  const ts = fs.readFileSync(
    path.join(__dirname, "..", "..", "ui", "src", "utils", "notificationSound.ts"),
    "utf8",
  );
  for (const [name, spec] of Object.entries(SOUNDS)) {
    assert.ok(ts.includes(`wave: '${spec.wave}'`), `${name}: wave`);
    for (const note of spec.notes) {
      assert.ok(ts.includes(`freq: ${note.freq}`), `${name}: ${note.freq} Hz`);
      if (note.to) assert.ok(ts.includes(`to: ${note.to}`), `${name}: to ${note.to}`);
    }
  }
});

for (const name of NAMES) {
  test(`${name} renders a short, audible, valid WAV`, () => {
    const wav = renderWav(name);
    assert.strictEqual(wav.toString("ascii", 0, 4), "RIFF");
    assert.strictEqual(wav.toString("ascii", 8, 12), "WAVE");
    assert.strictEqual(wav.readUInt32LE(24), SAMPLE_RATE);
    assert.strictEqual(wav.readUInt16LE(34), 16);
    const dataBytes = wav.readUInt32LE(40);
    assert.strictEqual(wav.length, 44 + dataBytes);
    assert.strictEqual(wav.readUInt32LE(4), 36 + dataBytes);
    const seconds = dataBytes / 2 / SAMPLE_RATE;
    assert.ok(seconds > 0.3 && seconds < 1.2, `${seconds} s is short`);
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    assert.ok(peak > 2000, "audible");
    assert.ok(peak < 20000, "not loud");
    // it ends in silence, so the player does not click
    assert.ok(Math.abs(wav.readInt16LE(wav.length - 2)) < 50);
  });
}

test("an unknown name renders the chime", () => {
  assert.deepStrictEqual(renderWav("nope"), renderWav("chime"));
});

test("each platform has its own player", () => {
  assert.deepStrictEqual(playersFor("darwin", "/t/a.wav"), [["afplay", ["/t/a.wav"]]]);
  const [[cmd, args]] = playersFor("win32", "C:\\it's\\a.wav");
  assert.strictEqual(cmd, "powershell.exe");
  assert.match(args.at(-1), /SoundPlayer 'C:\\it''s\\a\.wav'\)\.PlaySync\(\)/);
  assert.deepStrictEqual(
    playersFor("linux", "/t/a.wav").map(([c]) => c),
    ["paplay", "aplay"],
  );
});

function fakeSpawn({ missing = [] } = {}) {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    const child = {
      handlers: {},
      on(ev, fn) {
        this.handlers[ev] = fn;
        return this;
      },
      unref() {},
    };
    if (missing.includes(command)) setImmediate(() => child.handlers.error?.(new Error("ENOENT")));
    return child;
  };
  return { spawn, calls };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kanban-sound-test-"));
}

test("plays the file of the sound with the platform's player, writing it once", () => {
  const dir = tmp();
  const { spawn, calls } = fakeSpawn();
  const player = createSoundPlayer({ platform: "darwin", dir, spawn });
  player.play("bell");
  player.play("bell");
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[0], ["afplay", [path.join(dir, "bell.wav")]]);
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, "bell.wav")), renderWav("bell"));
  assert.ok(player.usable());
  fs.rmSync(dir, { recursive: true });
});

test("linux tries the next player when the first is missing, and says unusable when none exists", async () => {
  const dir = tmp();
  const { spawn, calls } = fakeSpawn({ missing: ["paplay"] });
  const player = createSoundPlayer({ platform: "linux", dir, spawn });
  player.play("chime");
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(calls.map(([c]) => c), ["paplay", "aplay"]);
  assert.ok(player.usable());

  const none = fakeSpawn({ missing: ["paplay", "aplay"] });
  const bare = createSoundPlayer({ platform: "linux", dir, spawn: none.spawn });
  bare.play("chime");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(bare.usable(), false);
  fs.rmSync(dir, { recursive: true });
});

test("never throws: a spawn that throws, a folder that cannot be written", () => {
  const dir = tmp();
  const boom = createSoundPlayer({
    platform: "darwin",
    dir,
    spawn: () => {
      throw new Error("spawn failed");
    },
  });
  assert.doesNotThrow(() => boom.play("chime"));
  const blocked = createSoundPlayer({
    platform: "darwin",
    dir: path.join(dir, "bell.wav", "x"),
    fs: {
      mkdirSync() {
        throw new Error("read-only");
      },
      writeFileSync() {},
    },
    spawn: fakeSpawn().spawn,
  });
  assert.doesNotThrow(() => blocked.play("chime"));
  fs.rmSync(dir, { recursive: true });
});
