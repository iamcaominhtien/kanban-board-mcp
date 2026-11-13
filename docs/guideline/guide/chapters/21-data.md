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

## Workspaces: more than one board on this computer

If you keep a board in one place (the office, say) and another in a second place (home, a client), you do not need to export one and import the other. Give each board its own **workspace** and switch between them.

1. Open {menu:Settings › Storage & backup} and find **Workspaces**. The board you have now is listed as **Default** (rename it if you like).
2. Type a name and press **Add workspace**. You get a new, empty board in its own folder, made in **Kanban Boards** in your home folder. To open a board you already have in a folder (a copy of your other computer's data, say), type that folder too; it must be inside your home folder. To keep the board on a database server instead, choose **A PostgreSQL server** or **A MySQL / MariaDB server** under *Where the board is kept* and fill in the connection, as in the Database card; the server is tested before the workspace is saved, and an empty database gets a new board.
3. Press **Switch** on the workspace you want. The page reloads with that board. From then on, a switcher under the logo lets you change in one click, and the workspace in use is named next to the project title.

Each workspace has its own database and attachments, so nothing is shared and nothing is copied. **Remove** only forgets the entry; the folder and the database stay where they are (the confirmation says where).

!!! note "Good to know"
    - A switch is refused while an AI run is working: wait for it or stop it. The board you are switching to is checked first, so if it cannot be opened (the server does not answer, the password is wrong, it was made by a newer version of the app) nothing changes and you are told why.
    - If the server of a board stops answering (the office server, when you are at home), the reconnect screen lists your other workspaces. Open one; the first is waiting for its server and you can come back to it. The app also opens when that server is down, and starts the board's AI runs and schedules once it answers.
    - Ticket keys such as `ABC-12` can exist in both boards, so nothing keeps working on a board you left. An AI agent in Claude Code or VS Code stays on the board it started on: after a switch it is told the board changed and does nothing more until you switch back or reconnect its MCP server (Claude Code: `/mcp`) (a new session works on the board in use). A window you left open on the other board tells you to reload, and saves nothing until you do.
    - Docs AI jobs and Board AI chats that are in flight are not waited for when you switch.
    - When Settings › Data folder or the Database card's **Move** takes the board in use to another folder or database, its workspace follows it. Connecting the Database card to another board that already exists does not change your workspaces: that board shows as the one in use, with no entry yet (switching away adds it, so you can come back). In the desktop app, Help › Open Data Folder opens the folder of the workspace in use.
    - **Switch** is off only when `KANBAN_DATABASE_URL` is set: the environment then decides the database.
    - Workspaces here are whole boards. They are not the **Workspace** of a ticket (its scratch folder).

## Before an upgrade

When a new version changes how ideas are stored, the app saves a copy of the database next to it first (for example `kanban.before-idea-space-<date>.db`). Take your own export before upgrading anyway; it is one click.
