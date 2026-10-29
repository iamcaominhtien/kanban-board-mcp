import os
import tempfile

# `main` starts file logging when imported; keep test runs out of the developer's real log folder.
os.environ.setdefault("KANBAN_LOG_DIR", tempfile.mkdtemp(prefix="kanban-test-logs-"))
# a diagram save must not start a browser during tests; the export tests switch it back on
os.environ.setdefault("KANBAN_DIAGRAM_EXPORT", "off")
