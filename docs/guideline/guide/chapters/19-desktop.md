---
title: The desktop app, menu and updates
part: 6
audience: [desktop]
summary: What the app’s menus do, the small windows they open, and how updates work.
reading: 8
standalone: desktop-menu
---
The desktop app packages the interface, the local server and the MCP server into one installed application. This chapter describes its menu bar, which is the same on macOS and on Windows apart from where a few items live.

## The menus

| Menu | Items |
| --- | --- |
| **App menu** (macOS only) | About, Check for Updates…, Settings… (⌘,), Services, Hide, Hide Others, Show All, Quit |
| **File** | New Ticket, New Idea, New Doc Page, New Project…, Import Data…, Export Data…. On macOS also New Window and Close Window. On Windows and Linux: Settings… and Exit. |
| **Edit** | The standard Undo, Redo, Cut, Copy, Paste, Paste and Match Style, Select All, and **Find in Board** |
| **View** | Board, List, Timeline, Docs, Schedules, Idea Space (the current one is ticked), Ask AI, zoom, full screen, Toggle Developer Tools |
| **Window** | Minimize, Zoom (Maximize on Windows), Bring All to Front |
| **Help** | Keyboard Shortcuts, Documentation, What’s New, Set Up AI…, Set Up MCP…, Report an Issue…, Request a Feature…, Open Logs Folder, Export Logs…, Open Data Folder, Copy Diagnostics Info. On Windows and Linux also Check for Updates… and About. |

On macOS the Help menu is the system Help menu, so it also has a search box that finds any menu item by name.

@figure menu-macos-app "The macOS app menu: About, Check for Updates…, Settings…, Services, Hide and Quit." width=60

@figure menu-macos-help "The Help menu on macOS. The system adds a search box at the top, which is not drawn here." width=60

@figure menu-windows-help "The Help menu on Windows and Linux. Check for Updates… and About are at the bottom." width=60

@figure menu-macos-view "The View menu. The tick shows the view you are on." width=60

!!! note "About these pictures"
    The menus are native, so they cannot be photographed outside the app. These four are drawn from the app’s own menu definition: the items, their order, shortcuts, separators and the tick are real; the look is only an illustration.

Shortcuts are in the list in {ch:shortcuts}. Items that need data (everything that opens a page) are greyed while the local server is not running; Help keeps working so you can open the logs and report the problem.

!!! note "Developer tools"
    Toggle Developer Tools is a normal menu item (++Mod+Shift+I++) that works only while the app is in front. It used to be a system-wide shortcut.

## The small windows

- **Keyboard Shortcuts** lists every shortcut and searches both commands and keys. It reads the same list as {ch:shortcuts}.

@figure dlg-shortcuts "Help › Keyboard Shortcuts. Type in the box to search by command or by key." width=48
- **What’s New** shows the release notes of the version you are running. **Full changelog** opens the Releases page.

@figure dlg-whats-new "Help › What’s New: the release notes of the running version." width=60
- **Report an Issue…** shows what will be filled in, then opens a new GitHub issue in your browser. The app sends nothing; nothing is sent until you press Create issue on GitHub. Included: the app and server versions, the system, window size and language. Never included: tickets, Docs, file paths, keys or logs. Attach logs yourself with Export Logs…

@figure dlg-report-issue "Help › Report an Issue…: it shows the text first. Nothing is sent until you press Create issue on GitHub." width=70
- **About** is the system About window on macOS and a small window on Windows.

@figure dlg-about "The About window on Windows and Linux." width=45

## Logs and data

- **Open Logs Folder** (Show Logs in Finder on macOS) opens the folder with the log files.
- **Export Logs…** opens Settings › Diagnostics, where you can save the logs to attach to a report.
- **Open Data Folder** opens the folder holding the database ({ch:data}).
- **Copy Diagnostics Info** copies the versions and system facts to the clipboard and shows a short “Copied” message. It never contains tickets, Docs, paths, keys or logs.

## Updates

A few seconds after start, and every 6 hours after that, the app asks GitHub for the latest release. If a newer version has an installer for your system, a card appears in the corner with **Download**, **Later**, **Skip this version** and **What’s new**. The check is silent unless there is an update.

You can also check by hand with {menu:Check for Updates…}. While it runs the item reads “Checking for Updates…” and is greyed. A toast then says **You’re up to date** or, if the check failed, **Couldn’t check for updates** with **Open releases page**. If a newer version exists the corner card comes back, even if you chose Later or Skip before.

@figure toast-up-to-date "The toast after a manual check when you are on the latest version." width=50

@figure update-card "The corner card when a newer version exists." width=50

Downloads come only from this project’s GitHub releases, and the file’s checksum is verified. On macOS the app opens the disk image so you can drag it to Applications; on Windows it closes and starts the installer. When an update has been found, the menu item changes to **Install Update x.y.z…** and opens Settings › Updates.

!!! note "Where the links go"
    All links in the Help menu go to this project’s pages: the README, Releases, Issues and the feature request template. They never go to Electron.
