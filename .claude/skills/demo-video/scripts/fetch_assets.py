"""The stock sounds the video uses (Mixkit, free to use): a mouse click and a stretch of laptop-keyboard typing. They are
fetched here, not kept in the repo."""
import subprocess
import common

SOUNDS = {
    "mk_click.wav": ("https://assets.mixkit.co/active_storage/sfx/275/275-preview.mp3", "Mixkit: Fast double click on mouse"),
    "mk_typing.wav": ("https://assets.mixkit.co/active_storage/sfx/2531/2531-preview.mp3", "Mixkit: Typing on a laptop keyboard"),
}

def main():
    common.ensure_deps()
    common.ASSETS.mkdir(parents=True, exist_ok=True)
    ff = common.ffmpeg_exe()
    for name, (url, label) in SOUNDS.items():
        out = common.ASSETS / name
        if out.exists(): continue
        mp3 = common.ASSETS / (name + ".mp3")
        try:
            subprocess.run(["curl", "-fsSL", "-A", "Mozilla/5.0", "-o", str(mp3), url], check=True)   # curl: the Python on macOS may lack CA certificates
            subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(mp3), "-ar", "44100", "-ac", "1", str(out)], check=True)
        except subprocess.CalledProcessError as e:
            # A blocked network is not fatal: the build skips a sound that is missing.
            print(f"COULD NOT FETCH {label} ({url}): {e}; the build will skip this sound", flush=True)
            mp3.unlink(missing_ok=True)
            continue
        mp3.unlink()
        print("fetched", label, "->", out)

if __name__ == "__main__":
    main()
