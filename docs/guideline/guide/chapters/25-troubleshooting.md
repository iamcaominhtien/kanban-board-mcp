---
title: Troubleshooting
part: 7
audience: [everyone]
summary: Find the symptom, then follow the fix. If nothing helps, send a report.
reading: 6
standalone: troubleshooting
---
## Common problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| The app shows **Connecting…** and never opens | The local server did not start | Press **Try again**. If it fails again, open {menu:Help › Open Logs Folder} and look at the newest file, then send a report (below). |
| Settings › Updates or **Check for Updates…** says it could not check | No network, or GitHub’s rate limit | Try again later, or use **Open releases page**. |
| “`claude` was not found on this computer” | The CLI is not installed, or the app cannot see its folder | Run `where claude` (Windows) or `which claude` to find it. Install it ({ch:ai-members}), then restart the app so it sees the new PATH. |
| An AI shows “not signed in” | The CLI is installed but you have not signed in | Run `claude` in a terminal, sign in, then press **Test connection** in the app. |
| The Board AI card says “Currently not chosen” | The project has no Board AI | Add an AI member ({ch:ai-members}), then Settings › AI › **Change**. The AI must be online. |
| “Choose a project folder inside your home folder…” | The working folder is outside the allowed area | Move the repository into your home folder, or list its folder in `KANBAN_AI_ROOTS` and restart the app ({ch:self-hosting}). |
| An AI cannot run your test command | The command is not on the allow list | AI member › Configuration › Permissions › add a rule such as `Bash(go test:*)` ({ch:ai-members}). |
| A run stops at **Needs input** | The AI is waiting for your answer | Answer the question card on the ticket or in the Inbox. |
| “Rate limited”, then runs again | The provider limits speed | Wait, or press **Retry now**. |
| “Key invalid” | The API key is wrong, expired or revoked | Edit the AI member, enter a new key, press **Test key**. |
| A run failed with “the board restarted…” | The app was closed or crashed during the run | Press **Retry** to start a new run. |
| An AI is paused for hitting a limit | Daily budget, monthly cap or runs per day | Wait for the next day, or raise the limit ({ch:safety}). The owner can allow more runs for one ticket. |
| An AI did the wrong thing | The ticket lacked criteria or scope | Write a clear comment and **Request changes**. Check the Run tab to see where it went wrong ({ch:safety}). |
| An image is not shown in a page | The attachment was removed from the uploads folder | Restore from a backup ({ch:data}). |

## Send a report

1. Choose {menu:Help › Report an Issue…}. A window shows what will be filled in: versions, system, window size and language. Never tickets, Docs, paths, keys or logs.
2. Press **Open GitHub**. A new issue opens in your browser. Describe what you did, what you saw and what you expected.
3. If logs may help, choose {menu:Help › Export Logs…}, save the file and attach it yourself.

@figure settings-diagnostics "Settings › Diagnostics, where the logs can be exported."

!!! tip
    **Copy Diagnostics Info** in the Help menu copies the same facts as text, for an email or a chat.
