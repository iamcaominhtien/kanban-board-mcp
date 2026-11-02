# Wave 3 fixes — aiteam (AI Team, Timeline, AI paused, Resources, Schedules)

Reports: [ai-2.md](../ai-2.md) (all rows) and the `SCH-` rows of [ai-1.md](../ai-1.md). Before (5174) and after (5173)
screenshots: `/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/w3/aiteam/`
(`<ID>-before.jpg` / `<ID>-after.jpg`; not in the repo). No data was added or changed; no AI was started, paused or
resumed, no schedule was created or run (the New schedule layer was opened and closed).

## AI Team

- AT-1 · Fixed. The header range is the design's white range button with a calendar icon (`MenuSelect`, `testId="at-range"`, same values and onChange; Whole life still offered on a scoped Flow); the Timeline's native select is the same button (`testId="tl-range"`) with the presets plus Custom…; You stepped in "AI: all" / "Person: all" are chips (`MenuSelect variant="chip"`). The range stays on Now (it drives the Now cards' "TODAY / runs" footer; dropping it would lose a feature). `AiTeamView.tsx`, `TimelineTab.tsx`, `SteppedInTab.tsx`, `teamUi.tsx` (calendar glyph from the design).
- AT-2 · Already fixed.
- AT-3 · Fixed (wave 4). In the Now card's footer the sparkline sits on the label row (right of "TODAY"), so the text has the whole width and "0 runs · 0 ok · 0 tokens (input per call)" is no longer squeezed (`NowTab.tsx`). The text itself is unchanged.
- AT-4 · Skipped (Low). The team cards carry no role or template (`TeamCard` has name, colour and provider only), so "RV" for Reviewer needs a server field.
- AT-5 · Fixed (wave 4). The approval button reads "Approve" (and "Approve, don’t ask again"); Deny and the API call are unchanged (`NowTab.tsx`).
- AT-6 · Fixed (wave 4). SENT BACK and PING-PONG are red only above 0, neutral ink at 0 (`FlowTab.tsx`).
- AT-7 · Skipped (Low). The tab badge hover is in `components/Board.tsx`, outside my folders.

## AI Team review: You stepped in, Health

- RV-1 · Already fixed.
- RV-2 · Fixed. Health shows verdict, the five measures, Each AI and What to fix first; Autonomy by Story, Each workflow and Marking the AI team follow. `HealthTab.tsx`.
- RV-3 · Fixed. Too few runs (and no runs) use the design's blue info banner: bg #E8F1FA, border #C9DDF0, (i) icon and title in #244E78 (values from `AiTeamReview.dc.html`, D "Too few runs to judge"). `HealthTab.tsx`, `aiTeam.css`.
- RV-4 · Fixed (wave 4). With no runs the summary says "No runs in this range yet" (never "Only 0"), and the side card hides its title and bars at 0 runs; the "Not enough to judge yet?" note stays (`HealthTab.tsx`).

## Flow, the Timeline view

- TL-1 · Already fixed.
- TL-2 · Fixed. The range button has "Custom…": a popover with From / To days and "Show this range" (checks the order of the days), sent as the existing since/until window; the label then reads "Oct 20 – Oct 22". Nothing stored locally. Test `timelineRange.test.tsx`. `TimelineTab.tsx`, `timeline.css`.
- TL-3 · Fixed. Seven days are one bordered list, a row per day, newest first, with an hourly mini-histogram, a "N runs" column (also "0 runs") and the red/amber chips; the part-day at the start of the range shows only when something ran there. Clicking a day still opens it. `TimelineTab.tsx` (`DayBands`), `timeline.css`.
- TL-4 · Fixed (wave 4). "Widen to 7 days" is the primary button (`TimelineTab.tsx`).
- TL-5 · Fixed. The inspector adds Open the run (any run), Pause / Resume (a run still going, same API as the Now card), Approve / Deny (an approval still waiting) and "Review changes" (a Docs proposal still waiting) next to the existing Answer, Open the ticket, Open ticket flow and Open the page. Code only: the DB has no runs, none of these was pressed. `TimelineTab.tsx`.
- TL-6 · Fixed (wave 4). After 3 s of loading a line says "Still loading the last 24 hours" (or the chosen range) (`TimelineTab.tsx`).
- TL-7 · Skipped: the live column is `ui/src/components/ai/live/LiveFeed.tsx`, outside this area.

## AI paused on every screen

- AP-1 · Already fixed.
- AP-2 · Skipped: the banner is mounted in the app shell (`App.tsx` / `Board.tsx`), outside this area.
- AP-3 · Skipped: `Board.tsx` header order, outside this area.
- AP-4 · Skipped: `ui/src/components/ai/AiKillSwitch.tsx`, outside this area.
- AP-5 · Skipped (Low). The app already sends the signed-in person (`X-Actor`, from `kanbanActor`), and the server stores it (`_by()` falls back to "user" only when no actor is set). Nothing to change in the UI files.
- AP-6 · Skipped: `ui/src/components/notifications/NotificationsHost.tsx`, outside this area.
- AP-7 · Partly fixed (wave 4). The Resume dialog's title names the project ("Resume AI in Kanban Board"), it has a ✕ close, the budget is a full-width strip with a check (or info) icon, and "(read and comment only)" stays on one line (`ai/AiKillSwitch.tsx`). Not done: the initials avatar per member (the member avatar is the same one used everywhere) and hiding "0 actions in the last 10 min" (that is information, so it stays).
- AP-8 · Fixed (wave 4). While paused, a legend line next to the chips ("Orange: paused for the whole project. Grey: paused on its own …"), and the orange "AI paused n" chip carries the pause glyph (`NowTab.tsx`, `teamUi.tsx`).
- AP-9 · Partly fixed (wave 4). The toast now says "AI resumed · n AI members started again, m held runs starting in order" (n from the server's `resumed`), duration 6000. The app's `Toast` turns a plain success into the quiet line by design (`Toast.tsx`, outside my folders), so it is the quiet line with the longer sentence, not a real toast (`ai/AiKillSwitch.tsx`).
- AP-10 · Skipped (Low). The assignee picker is in `components/TicketModal.tsx`, outside my folders.
- AP-11 · Fixed (wave 4). Timeline's paused strip is the same plain strip as the Team map's: "Right now · No AI is running · paused since …" with orange text, no tint and no glyph (`TimelineTab.tsx`).

## Resources

- RS-1 · Fixed. The machine tiles show their 6 px meter (it was there but collapsed to 0 px by `flex: 1` in a column); green under 65 %, amber from 65 %, red from 90 % (RAM also red under 10 % free). `ResourcesTab.tsx`, `resources.css`.
- RS-2 · Already fixed.
- RS-3 · Fixed. The axis always runs up to the limit per run, with the red dashed "limit per run 4 GB" line at its top, as drawn (the line under the chart is gone). `ResourcesTab.tsx`.
- RS-4 · Fixed (wave 4). The live text sits at the right, the verdict has a check (or info) icon, and the x axis has minute ticks 4, 3, 2, 1 (`ResourcesTab.tsx`, `resources.css`).
- RS-5 · Fixed (wave 4). Machine RAM reads "2.1 / 15.7 GB" (one decimal, unit once) (`resourcesFormat.ts` `fmtGbOf`, `ResourcesTab.tsx`).

## Schedules (ai-1)

- SCH-1 · Fixed. Time zone is a custom dropdown with search (new `ZoneSelect` in `MemberSelect.tsx`: search box, arrows, Enter, Esc; `testId="tz"`); Fix rounds, Stop after and Retry on failure are `MenuSelect` fields at the design's widths (90/140/140 px, same values and test ids); the list filters "All AI" / "All tickets" are `MenuSelect` fields (150 px, same `filter-ai` / `filter-ticket`). AI member was already the custom `MemberSelect`. Test `zoneSelect.test.tsx`. `ScheduleEditor.tsx`, `SchedulesTab.tsx`, `MemberSelect.tsx`, `schedules.css`.
- SCH-2 · Already fixed (the AT and allowed-window fields are already 24 h text fields with one clock icon, `TimeField` in `schedulesUi.tsx`).
