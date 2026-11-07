"""Paths and tools shared by the demo-video scripts: the Python packages it needs (installed once, outside the repo),
the headless Chromium Playwright already has, and an ffmpeg."""
import glob, importlib, os, shutil, subprocess, sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
HOME = Path(os.environ.get("KB_DEMO_HOME", Path.home() / ".cache" / "kanban-demo-video"))
LIB = HOME / "pylib"
ASSETS = Path(os.environ.get("KB_DEMO_ASSETS", SKILL / "assets"))
sys.path.insert(0, str(LIB))

def ensure_deps():
    """numpy, playwright, imageio-ffmpeg, edge-tts: whatever is missing is installed into LIB (never into the repo)."""
    need = []
    for mod, pkg in (("numpy", "numpy"), ("playwright", "playwright"), ("imageio_ffmpeg", "imageio-ffmpeg"), ("edge_tts", "edge-tts")):
        try: __import__(mod)
        except ImportError: need.append(pkg)
    if need:
        LIB.mkdir(parents=True, exist_ok=True)
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--target", str(LIB), *need], check=True)
        sys.path.insert(0, str(LIB)); importlib.invalidate_caches()

def chromium_exe() -> str:
    """The headless Chromium Playwright downloaded (or the one named by KB_DEMO_CHROMIUM)."""
    if os.environ.get("KB_DEMO_CHROMIUM"): return os.environ["KB_DEMO_CHROMIUM"]
    roots = [Path.home() / "Library/Caches/ms-playwright", Path.home() / ".cache/ms-playwright", Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/nonexistent"))]
    for r in roots:
        for pat in ("chromium_headless_shell-*/*/chrome-headless-shell", "chromium-*/*/chrome", "chromium-*/*/Chromium.app/Contents/MacOS/Chromium"):
            hits = sorted(glob.glob(str(r / pat)))
            if hits: return hits[-1]
    raise SystemExit("No Chromium for Playwright. Run: python3 -m playwright install chromium-headless-shell (a download), "
                     "or set KB_DEMO_CHROMIUM to a Chromium binary.")

def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return shutil.which("ffmpeg") or sys.exit("No ffmpeg: run scripts/setup.py")
