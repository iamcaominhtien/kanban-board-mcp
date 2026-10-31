---
title: Schedules
part: 5
audience: [ai]
summary: Let an AI member work on a ticket at a set time, and check the result by rules you choose.
reading: 6
---
Use a schedule for work that repeats or takes a long time and can be checked by a machine: fixing red tests every night, updating dependencies, writing a weekly report. Do not schedule work that needs a design decision.

## Create a schedule

Open a ticket’s Run menu and choose **Schedule a run…**, or open the **Schedules** tab (list and week views) and press **New schedule**. The editor has these parts:

| Part | What it means |
| --- | --- |
| **Task** | The ticket the AI will work on. |
| **When** | Once or repeating: days, time, time zone, an end rule and an allowed time window. |
| **Who runs it** | The main AI member and a backup. The AI must be allowed to take this ticket. |
| **Done when** | Checks that must all pass: every acceptance criterion ticked, tests pass (a command and a folder), a summary comment, a branch or PR linked, or a check you describe in words. |
| **AI review** | A second AI checks the result and can ask for a few fix rounds. |
| **Limits** | When to stop a run. |
| **If it cannot run on time** | What to do if the computer was off or the AI was busy or paused. |
| **Tell me when** | Who is told, and about what. |
| **Instruction** | Extra text for the AI, like an extra instruction on a run. |

## Three recipes

- **Clear red tests every night.** A ticket “Fix failing tests”, repeating Monday to Friday at 02:00, AI Dev, Done when “Tests pass” with `pytest -q` plus a summary comment, AI review by Reviewer with one fix round. In the morning you read the ticket in Review.
- **Weekly report.** A ticket “Weekly progress report”, repeating Friday at 16:00, AI PM (read-only for code), Done when a summary comment. The instruction: summarise the week’s tickets as done, in progress, blocked and risks, and propose three things for next week.
- **One long job after hours.** Run once tonight at 22:00 for a long refactor ticket. Allow the window 22:00 to 06:00, set a time and run limit, and pick a backup AI in case the main one is busy.

!!! note "Good to know"
    A schedule runs with the AI member’s own permissions and status ceiling. When every check passes, the ticket goes to Review, never to Done. Three failures in a row pause the schedule. The app must be open when a run is due.
