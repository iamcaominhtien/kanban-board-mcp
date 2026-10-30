---
title: Data, backup and restore
part: 7
audience: [admin]
summary: Where everything is kept, how to back it up, and how to restore it.
reading: 6
standalone: administration
---
Everything you care about is in the data folder. A backup is one file you can keep anywhere.

## Where the data is

| What | Where |
| --- | --- |
| Database (tickets, Docs, ideas, AI members) | `kanban.db` in the data folder (`KANBAN_DB_PATH`) |
| Attachments, sketches, Docs images | The uploads folder, `uploads` in the data folder by default (`KANBAN_UPLOADS_DIR`) |
| Workspace folders (ticket and idea scratch folders) | A folder outside the data folder, set in Settings › Storage & backup |
| Logs | `~/.kanban-board/logs` (`KANBAN_LOG_DIR`) |
| API keys of AI members | The system keychain on the desktop app (`KANBAN_SECRET_STORE`) |

In the desktop app, {menu:Help › Open Data Folder} opens the data folder. You can move it in {menu:Settings › Storage & backup}.

@figure settings-storage "Settings › Storage & backup: the data folder, the workspace folder, and import and export."

## Back up your data

1. Open {menu:Settings › Storage & backup} (or {menu:File › Export Data…} in the desktop app).
2. Press **Export data**. You get one ZIP with the database and the attachments.
3. Keep the file somewhere safe.

!!! warning "Workspace files are not included"
    Workspace folders live outside the data folder on purpose, so the ZIP does not contain them. Back them up yourself.

## Restore

1. Open the same page and press **Import data…**, then choose the ZIP. Only `.zip` files are accepted.
2. Confirm. The import **fully replaces** the database and the uploads. The server checks the ZIP before touching anything, keeps a copy of the current database while it works, and puts it back if the import fails.
3. The page reloads when the import is done.

!!! caution
    An import replaces what you have now. Export first if you might want it back.

## Before an upgrade

When a new version changes how ideas are stored, the app saves a copy of the database next to it first (for example `kanban.before-idea-space-<date>.db`). Take your own export before upgrading anyway; it is one click.
