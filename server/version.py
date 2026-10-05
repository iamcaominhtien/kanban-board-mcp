"""App version info served by GET /version (used by the UI to detect an out-of-date build)."""

import os

# Keep in sync with desktop/package.json and ui/package.json when releasing.
APP_VERSION = "2.2.0"

# The oldest UI build that still works with this server. Raise it when the API changes in a way
# an old, still-open browser tab cannot cope with; that tab then shows "A new version is available".
MIN_SUPPORTED_UI_VERSION = "1.4.0"


def version_info() -> dict[str, str]:
    return {
        "version": APP_VERSION,
        "latest": APP_VERSION,
        # Overridable so a deployment (or a test) can force the update-required screen
        "min_supported_version": os.environ.get("KANBAN_MIN_UI_VERSION", MIN_SUPPORTED_UI_VERSION),
    }
