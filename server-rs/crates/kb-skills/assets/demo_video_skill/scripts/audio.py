"""Everything the demo hears: the narration (a neural voice from Edge TTS), the click and typing from the stock sounds,
a whoosh and a chime made by code, a soft lo-fi loop made by code, and the mix (the music ducks under the voice)."""
import os, subprocess, time, wave
import numpy as np
import common

SR = 44100

def read(path):
    with wave.open(str(path)) as w:
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        if w.getnchannels() == 2: a = a.reshape(-1, 2).mean(axis=1)
    return a

def write(path, stereo):
    pk = np.max(np.abs(stereo)) or 1
    a = (stereo / max(pk, 1.0) * 32767 * 0.97).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(a.tobytes())

def tts(text, name, voice="vi-VN-HoaiMyNeural", tempo=1.08):
    """Narration: a neural voice from Edge TTS (needs the network; only the narration text is sent). Silence at both
    ends is trimmed so a scene starts on the first word. Retries, because the service sometimes answers nothing."""
    mp3, wav = f"{name}.mp3", f"{name}.wav"
    env = {**os.environ, "PYTHONPATH": str(common.LIB) + os.pathsep + os.environ.get("PYTHONPATH", "")}
    for _ in range(10):
        r = subprocess.run([common.sys.executable, "-m", "edge_tts", "--voice", voice, "--text", text, "--write-media", mp3], env=env, capture_output=True)
        if r.returncode == 0 and os.path.exists(mp3) and os.path.getsize(mp3) > 1000: break
        time.sleep(1.5)
    else:
        raise RuntimeError(f"Edge TTS did not answer for {name}")
    trim = "silenceremove=start_periods=1:start_threshold=-45dB"
    subprocess.run([common.ffmpeg_exe(), "-y", "-loglevel", "error", "-i", mp3, "-af",
                    f"{trim},areverse,{trim},areverse,atempo={tempo},aresample={SR},aformat=channel_layouts=mono", wav], check=True)
    return read(wav)

def _norm(x, peak):
    return x / (np.max(np.abs(x)) or 1) * peak

def _lp(sig, f):
    k = 1 - np.exp(-2 * np.pi * f / SR); y = np.zeros_like(sig); acc = 0.0
    for n in range(len(sig)):
        acc += k * (sig[n] - acc); y[n] = acc
    return y

def _sample(name):
    p = common.ASSETS / name
    if not p.exists(): raise SystemExit(f"{p} is missing: run scripts/fetch_assets.py")
    return read(p)

def click():
    """The stock mouse click (Mixkit "Fast double click on mouse"): its first click only."""
    x = _sample("mk_click.wav")[int(SR * 0.106):int(SR * 0.200)].copy()
    x *= np.minimum(np.arange(len(x)) / (SR * 0.001), 1) * np.minimum((len(x) - np.arange(len(x))) / (SR * 0.02), 1)
    return _norm(x, 0.95).astype(np.float32)

def typing(duration):
    """The stretch of the stock "Typing on a laptop keyboard" clip (Mixkit) with the most keys in `duration` seconds."""
    s = _sample("mk_typing.wav"); n = int(SR * duration)
    sm = np.convolve(np.abs(s), np.ones(int(SR * 0.003)) / int(SR * 0.003), mode="same")
    hits = np.flatnonzero((sm[1:] > sm.max() * 0.2) & (sm[:-1] <= sm.max() * 0.2))
    best, start = -1, 0
    for h in hits:
        c = np.sum((hits >= h) & (hits < h + n))
        if c > best and h + n <= len(s): best, start = c, h
    x = s[max(start - int(SR * 0.02), 0):][:n].copy()
    x *= np.minimum(np.arange(len(x)) / (SR * 0.03), 1) * np.minimum((len(x) - np.arange(len(x))) / (SR * 0.15), 1)
    return _norm(x, 0.75).astype(np.float32)

def whoosh(dur=0.7):
    n = int(SR * dur); t = np.arange(n) / SR
    noise = np.random.default_rng(7).standard_normal(n); out = np.zeros(n); y = 0.0
    for i in range(n):
        y += (0.02 + 0.5 * np.sin(np.pi * i / n) ** 2) * (noise[i] - y); out[i] = y
    return _norm(out * np.sin(np.pi * t / dur) ** 2, 0.8).astype(np.float32)

def chime():
    n = int(SR * 1.2); out = np.zeros(n)
    for i, f in enumerate([783.99, 1174.66, 1567.98]):
        s = int(SR * 0.09 * i); tt = np.arange(n - s) / SR
        out[s:] += np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.35) * (0.5 / (i + 1))
    return out.astype(np.float32)

def _rhodes(f, dur, vel=1.0):
    n = int(SR * dur); t = np.arange(n) / SR
    mod = np.sin(2 * np.pi * f * t) * (2.2 * np.exp(-t / 0.18) + 0.35)
    x = np.sin(2 * np.pi * f * t + mod) + 0.25 * np.sin(2 * np.pi * 2 * f * t + 0.5 * mod) * np.exp(-t / 0.4)
    return (x * np.minimum(t / 0.004, 1) * np.minimum((dur - t) / 0.25, 1) * (1 + 0.08 * np.sin(2 * np.pi * 4.6 * t)) * np.exp(-t / (dur * 0.9)) * vel).astype(np.float32)

def music(seconds, bpm=76):
    """A calm lo-fi loop: electric-piano chords, a round bass, a soft swung beat, a little tape hiss."""
    n = int(SR * seconds); out = np.zeros(n, dtype=np.float32); beat = 60 / bpm; bar = beat * 4
    roots = {"C": 130.81, "A": 110.0, "F": 87.31, "G": 98.0}
    chords = [("C", [261.63, 329.63, 392.0, 493.88, 587.33]), ("A", [220.0, 261.63, 329.63, 392.0, 493.88]),
              ("F", [174.61, 261.63, 329.63, 440.0, 523.25]), ("G", [196.0, 261.63, 329.63, 349.23, 440.0])]
    rng = np.random.default_rng(5)
    def add(arr, s):
        e = min(len(arr), n - s)
        if s < n and e > 0: out[s:s + e] += arr[:e]
    def band(x, lo, hi): return _lp(x, hi) - _lp(x, lo)
    for b in range(int(seconds / bar) + 1):
        root, ch = chords[b % 4]; s0 = int(b * bar * SR)
        for k, f in enumerate(ch): add(_rhodes(f, bar * 1.7, 0.16), s0 + int(k * 0.018 * SR))
        for hit, vel in ((1.5, 0.5), (2.5, 0.45), (3.5, 0.38)):
            for f in ch[1:4]: add(_rhodes(f, beat * 1.2, 0.07 * vel / 0.45), s0 + int((hit + 0.12) * beat * SR))
        m = int(SR * beat * 1.4); bass = np.sin(2 * np.pi * roots[root] * np.arange(m) / SR) * np.exp(-np.arange(m) / (SR * 0.55))
        add(bass * 0.32, s0); add(bass * 0.26, s0 + int(beat * 2.5 * SR))
        for k in range(8):
            m = int(SR * 0.05); h = rng.standard_normal(m); h = h - _lp(h, 6500)
            add(h * np.exp(-np.arange(m) / SR / 0.012) * (0.055 if k % 2 else 0.035), s0 + int((k * beat / 2 + (0.09 * beat if k % 2 else 0)) * SR))
        for hit in (0.0, 2.5):
            m = int(SR * 0.22); t = np.arange(m) / SR
            add(np.sin(2 * np.pi * (45 + 75 * np.exp(-t / 0.035)) * t) * np.exp(-t / 0.09) * 0.55, s0 + int(hit * beat * SR))
        for hit in (1.0, 3.0):
            m = int(SR * 0.2); t = np.arange(m) / SR
            add((band(rng.standard_normal(m), 900, 6000) * np.exp(-t / 0.07) * 0.9 + np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05) * 0.25) * 0.22, s0 + int((hit + 0.03) * beat * SR))
    out = _lp(out, 4200) + _lp(rng.standard_normal(n), 5000) * 0.004
    out = out * np.minimum(np.arange(n) / (SR * 1.2), 1) * np.minimum((n - np.arange(n)) / (SR * 2.5), 1)
    return _norm(out, 0.5).astype(np.float32)

def mix(total, voice, sfx, music_arr, path):
    """voice / sfx: lists of (time_s, mono array). The music is ducked wherever the voice speaks."""
    n = int(SR * total); v = np.zeros(n, dtype=np.float32); f = np.zeros(n, dtype=np.float32)
    for t, a in voice:
        s = int(t * SR); e = min(n, s + len(a))
        if s < n: v[s:e] += a[:e - s]
    for t, a in sfx:
        s = int(t * SR); e = min(n, s + len(a))
        if s < n: f[s:e] += a[:e - s]
    m = np.zeros(n, dtype=np.float32); mm = music_arr[:n]; m[:len(mm)] = mm
    k = int(SR * 0.25); sm = np.convolve(np.abs(v), np.ones(k) / k, mode="same")
    duck = 1 - 0.7 * np.clip(sm / 0.08, 0, 1)
    out = v + f + m * 0.6 * duck
    write(path, np.stack([out, out], axis=1))
