# Wave 3 fixes — aiteam (AI Team, Timeline, AI paused, Resources, Schedules)

Reports: [ai-2.md](../ai-2.md) (all rows) and the `SCH-` rows of [ai-1.md](../ai-1.md). Before (5174) and after (5173)
screenshots: `/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/w3/aiteam/`
(`<ID>-before.jpg` / `<ID>-after.jpg`; not in the repo). No data was added or changed; no AI was started, paused or
resumed, no schedule was created or run (the New schedule layer was opened and closed).

## AI Team

- AT-1 · Fixed. The header range is the design's white range button with a calendar icon (`MenuSelect`, `testId="at-range"`, same values and onChange; Whole life still offered on a scoped Flow); the Timeline's native select is the same button (`testId="tl-range"`) with the presets plus Custom…; You stepped in "AI: all" / "Person: all" are chips (`MenuSelect variant="chip"`). The range stays on Now (it drives the Now cards' "TODAY / runs" footer; dropping it would lose a feature). `AiTeamView.tsx`, `TimelineTab.tsx`, `SteppedInTab.tsx`, `teamUi.tsx` (calendar glyph from the design).
- AT-2 · Already fixed.
- AT-3 · Skipped — Low.
- AT-4 · Skipped — Low.
- AT-5 · Skipped — Low.
- AT-6 · Skipped — Low.
- AT-7 · Skipped — Low (and in `Board.tsx`, outside this area).

## AI Team review: You stepped in, Health

- RV-1 · Already fixed.
- RV-2 · Fixed. Health shows verdict, the five measures, Each AI and What to fix first; Autonomy by Story, Each workflow and Marking the AI team follow. `HealthTab.tsx`.
- RV-3 · Fixed. Too few runs (and no runs) use the design's blue info banner: bg #E8F1FA, border #C9DDF0, (i) icon and title in #244E78 (values from `AiTeamReview.dc.html`, D "Too few runs to judge"). `HealthTab.tsx`, `aiTeam.css`.
- RV-4 · Skipped — Low.

## Flow, the Timeline view

- TL-1 · Already fixed.
- TL-2 · Fixed. The range button has "Custom…": a popover with From / To days and "Show this range" (checks the order of the days), sent as the existing since/until window; the label then reads "Oct 20 – Oct 22". Nothing stored locally. Test `timelineRange.test.tsx`. `TimelineTab.tsx`, `timeline.css`.
- TL-3 · Fixed. Seven days are one bordered list, a row per day, newest first, with an hourly mini-histogram, a "N runs" column (also "0 runs") and the red/amber chips; the part-day at the start of the range shows only when something ran there. Clicking a day still opens it. `TimelineTab.tsx` (`DayBands`), `timeline.css`.
- TL-4 · Skipped — Low.
- TL-5 · Fixed. The inspector adds Open the run (any run), Pause / Resume (a run still going, same API as the Now card), Approve / Deny (an approval still waiting) and "Review changes" (a Docs proposal still waiting) next to the existing Answer, Open the ticket, Open ticket flow and Open the page. Code only: the DB has no runs, none of these was pressed. `TimelineTab.tsx`.
- TL-6 · Skipped — Low.
- TL-7 · Skipped: the live column is `ui/src/components/ai/live/LiveFeed.tsx`, outside this area.

## AI paused on every screen

- AP-1 · Already fixed.
- AP-2 · Skipped: the banner is mounted in the app shell (`App.tsx` / `Board.tsx`), outside this area.
- AP-3 · Skipped: `Board.tsx` header order, outside this area.
- AP-4 · Skipped: `ui/src/components/ai/AiKillSwitch.tsx`, outside this area.
- AP-5 · Skipped — Low.
- AP-6 · Skipped: `ui/src/components/notifications/NotificationsHost.tsx`, outside this area.
- AP-7 · Skipped — Low.
- AP-8 · Skipped — Low.
- AP-9 · Skipped — Low.
- AP-10 · Skipped — Low.
- AP-11 · Skipped — Low.

## Resources

- RS-1 · Fixed. The machine tiles show their 6 px meter (it was there but collapsed to 0 px by `flex: 1` in a column); green under 65 %, amber from 65 %, red from 90 % (RAM also red under 10 % free). `ResourcesTab.tsx`, `resources.css`.
- RS-2 · Already fixed.
- RS-3 · Fixed. The axis always runs up to the limit per run, with the red dashed "limit per run 4 GB" line at its top, as drawn (the line under the chart is gone). `ResourcesTab.tsx`.
- RS-4 · Skipped — Low.
- RS-5 · Skipped — Low.

## Schedules (ai-1)

- SCH-1 · Fixed. Time zone is a custom dropdown with search (new `ZoneSelect` in `MemberSelect.tsx`: search box, arrows, Enter, Esc; `testId="tz"`); Fix rounds, Stop after and Retry on failure are `MenuSelect` fields at the design's widths (90/140/140 px, same values and test ids); the list filters "All AI" / "All tickets" are `MenuSelect` fields (150 px, same `filter-ai` / `filter-ticket`). AI member was already the custom `MemberSelect`. Test `zoneSelect.test.tsx`. `ScheduleEditor.tsx`, `SchedulesTab.tsx`, `MemberSelect.tsx`, `schedules.css`.
- SCH-2 · Already fixed (the AT and allowed-window fields are already 24 h text fields with one clock icon, `TimeField` in `schedulesUi.tsx`).
