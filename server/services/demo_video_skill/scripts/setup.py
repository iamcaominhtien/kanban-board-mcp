"""One-time setup: installs the Python packages (outside the repo) and fetches the two stock sounds. Safe to run again."""
import common
common.ensure_deps()
print("chromium:", common.chromium_exe())
print("ffmpeg:", common.ffmpeg_exe())
import fetch_assets
fetch_assets.main()
print("ready")
