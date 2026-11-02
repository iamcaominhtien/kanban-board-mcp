# AI 2 (AI Team, Timeline, AI paused, Resources) — design audit

Demo video: `/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/audit/videos/ai-2.mp4` (not committed, too large)

Summary: 34 findings (1 critical, 2 high, 15 medium, 16 low). The database has **no AI runs at all** (0 rows in `ai_run`, in every project) and one AI member, so every frame that needs a run, a hand-off, a question or an approval was audited from the code. The empty, idle and paused states were checked in the running app. Three main patterns: (1) range pickers and filters are native `<select>`s where the design draws a calendar button or a row of chips, and Flow shows two range controls that disagree; (2) the paused state is drawn in the wrong place: the banner sits above the top bar, and the wider paused label pushes the top bar until New Ticket is cut off; (3) empty and too-few-runs states use the wrong copy and the wrong state (Health says "Only 0 runs", the Resources chart mislabels its axis).

Pausing AI for KAN was done once through the UI (reason "Design audit (ai-2), resumes shortly", 16:40) and resumed through the Resume dialog with **Normal** and the one member ticked. Checked afterwards: `paused_all=false`, `safe_mode=false`, Reviewer `idle` and not paused.

## AI Team (`design/screens/ai-team.md`)

Extended by ai-operations, ai-team-process and ai-story-flow (scope bar, Story, live column). Those docs win where they change the frames: the extra tabs (Decided for you, Resources, Run history), the scope bar in place of Team map / One ticket, and the live commentary column are not findings.

Coverage: frames checked in the app: B (Now, idle, one AI), C (Team map, empty, "need at least two AI members"); from code only: B needs-you cards, working/waiting/offline cards, recent hand-offs (no runs), D, E and F (need runs and a parent ticket with AI work); not built as drawn: D/E/F are replaced by the Flow scope bar (ai-story-flow).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| AT-1 | B, C, D, review A/B, timeline B | High | component | The range is a white button with a calendar icon, "Last 7 days" and a chevron, at the right of the tab row. Now shows only "Live · updated 4 s ago". The Timeline uses a "Today" button and a row of chips (Last hour, Today, Last 24 h, 7 days, Custom…). The touch filters are pill dropdowns | Native `<select>` on every tab, including Now ("Today"). A second native select sits in the Timeline toolbar. "AI: all" and "Person: all" in You stepped in are native selects too | `ui/src/components/aiteam/AiTeamView.tsx:221`, `TimelineTab.tsx:472`, `SteppedInTab.tsx` | Use the app's custom dropdown with the calendar icon. Use chips on the Timeline. Drop the range from Now |
| AT-2 | Flow › Timeline | Medium | behavior | One range on the Timeline | Two controls, both labelled "Range", show different values (header "Last 7 days", Timeline "Today"). The header one does nothing there, and the hint says "the range is set on the Timeline" | `AiTeamView.tsx:221`, `TimelineTab.tsx:472` | Hide the header range while Flow › Timeline is open |
| AT-3 | B | Low | layout | "TODAY / 5 runs · 5 ok · $0.41" on one line beside the sparkline | "0 runs · 0 ok · 0 tokens (input per call)" wraps to two lines in a 300 px card | `NowTab.tsx` (card footer, ~570) | Give the text the full width and put the sparkline after it, or shorten the token label to "0 tokens" |
| AT-4 | B | Low | copy | Avatar code "RV" for Reviewer (two letters from the role) | "RE" | `teamUi.tsx` (`initials`) | Use the role code (PM, BA, DS, DV, TS, RV) when the member has a template |
| AT-5 | B | Low | copy | Needs you approval buttons "Approve" / "Deny" | "Allow" / "Deny" | `NowTab.tsx:187` | Rename to "Approve" |
| AT-6 | C | Low | color | Red numbers only for real sent-backs (9) | SENT BACK "0" and PING-PONG "0" are red | `FlowTab.tsx` (tiles) | Use the neutral ink at 0 |
| AT-7 | review C1 | Low | copy | Tab badge hover: "4 need you: 1 question, 1 approval, 1 offline, 1 budget" | Hover text: "Things waiting for you" | `ui/src/components/Board.tsx:262` | Build the hover text from the needs-you kinds |

Images: [design B](../../../design/images/ai-team/04-b-now-what-each-ai-is-doing.png) · [now B](shots/ai-2/ai-team-B.jpg) · [design C](../../../design/images/ai-team/06-c-flow-team-map-how-work-moves-between-the-ais.png) · [now C](shots/ai-2/ai-team-C.jpg)

## AI Team review: You stepped in, Health (`design/screens/ai-team-review.md`)

Extended by ai-team-process (Each workflow grouping) and ai-board-wave3 (sandbox marks). Their sections are not findings in themselves, but where they sit is (RV-2).

Coverage: frames checked in the app: A (empty), B (no runs), D "a team but no runs", "Only one AI member"; from code only: A rows, B verdict/what-to-fix cards (need 10+ runs), D viewer/shared/cost-unknown; not built: D "No AI members yet" with Add a team / Add one AI member (the AI Team tab is hidden when a project has no AI members, and NowTab shows a plain sentence, `NowTab.tsx:735`). Not counted as a finding, because the tab cannot be reached in that case.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| RV-1 | D (no runs) on A and B | Medium | state | "A team, but no runs in this range": Flow, You stepped in and Health say "No AI work between Oct 23 and Oct 29" with a button to widen to 30 days | Health shows the too-few-runs verdict "Not enough to judge yet · Only 0 runs in this range". You stepped in says "Nobody had to step in during this range". Neither has a widen button | `HealthTab.tsx`, `SteppedInTab.tsx` | At 0 runs show the no-work state with "Widen to 30 days" |
| RV-2 | B | Medium | layout | Verdict, then the five measure tiles, then Each AI, then What to fix | Each workflow tiles and the table, then "Marking the AI team" (8 suite rows) come first. The five measures start about 1300 px down the page | `HealthTab.tsx` | Keep verdict, five measures, Each AI and What to fix first. Put the extensions after them |
| RV-3 | B, D (too few runs) | Medium | color | Too-few-runs: a blue info banner with an (i) icon. Needs attention: an amber-tinted banner | A white box with an amber warning triangle in a circle | `HealthTab.tsx` (verdict) | Use the blue info banner (bg #EAF1FB, border #C9DBF2, "i" icon) for too-few-runs |
| RV-4 | B | Low | copy | "Only 6 runs in this range" | "Only 0 runs in this range". The side card says "Why 0 runs did not finish OK · Every run in this range finished OK" when nothing ran | `HealthTab.tsx` | Hide the failure card at 0 runs, and never write "Only 0" |

Images: [design B](../../../design/images/ai-team-review/04-b-health-is-the-ai-feature-working.png) · [now B](shots/ai-2/ai-team-review-B.jpg) · [now B lower](shots/ai-2/ai-team-review-B-lower.jpg) · [design D](../../../design/images/ai-team-review/08-d-states.png) · [now A](shots/ai-2/ai-team-review-A.jpg)

## Flow, the Timeline view (`design/screens/ai-team-timeline.md`, `design/screens/ai-team-timeline-cases.md`)

Extended by ai-story-flow: the scope button is replaced by the Flow scope bar, and "Open ticket story" is renamed "Open ticket flow". Both were applied.

Coverage: frames checked in the app: timeline B toolbar and the empty diagram, cases E5 (7-day bands, empty), I "Nothing in this range", I "All AI is paused"; from code only: B diagram, C symbols, D hover and inspector, E1–E4, F, G motion, H, I loading/errors/lots/narrow/not metered (all need runs).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| TL-1 | B toolbar | Medium | behavior | One Copy link (in the scope bar) | Two "Copy link" buttons, one in the scope bar and one in the Timeline toolbar. `hidden={scopeBar}` is overridden by `.tl-btn { display: inline-flex }` | `TimelineTab.tsx:444`, `timeline.css:21` | Add `.tl-btn[hidden] { display: none }` |
| TL-2 | E4 | Medium | missing | Range chips: Last hour, Today, Last 24 h, 7 days, **Custom…** | No Custom range: the select offers only the four presets | `TimelineTab.tsx:42` | Add Custom… with a date-range popover |
| TL-3 | E5 | Medium | layout | One table with a row per day, newest first (Thu Oct 30 at the top), 7 rows, the run count in a right column, red "N failed" and amber "N waited long" chips | Eight separate bordered boxes (Oct 26 to Nov 2), oldest first. An empty day shows only "nothing ran", with no "0 runs" column | `TimelineTab.tsx` (`DayBands`, ~730) | Render one bordered list, newest first, 7 days, with the runs column |
| TL-4 | I, Nothing in this range | Low | component | "Widen to 7 days" is the primary green button | Both buttons secondary (outline) | `TimelineTab.tsx:711` | Give "Widen to 7 days" the `tl-btn primary` class |
| TL-5 | D (code) | Medium | missing | Run inspector: Open the run, Open the ticket, Pause. Approval hover: Approve / Deny. Docs node: Review changes | The inspector has only Answer (questions), Open the ticket, Open ticket flow and Open the page. No Open the run, no Pause, no Approve/Deny, no Review changes | `TimelineTab.tsx:1425` | Add the actions per kind, reusing the run-link and approval mutations from NowTab |
| TL-6 | I, Loading (code) | Low | missing | After 3 s: "Still loading the last 24 hours" | The skeleton has no slow-load line | `TimelineTab.tsx:276` | Add the line after a 3 s timer |
| TL-7 | I, All AI is paused; paused D4 | Medium | state | While the team is paused nothing animates, and the view says why | The live column beside Flow keeps a pulsing red "LIVE" badge and says "It's quiet. When an AI picks up work…", which suggests work could start | `ui/src/components/ai/live/LiveFeed.tsx` | When `pausedAll`, grey the badge and say "AI is paused since 16:40" |

Images: [design B](../../../design/images/ai-team-timeline/04-b-the-timeline-whole-team-live.png) · [now B (empty)](shots/ai-2/ai-team-timeline-B.jpg) · [design E](../../../design/images/ai-team-timeline-cases/02-e-long-spans-and-quiet-stretches.png) · [now E5](shots/ai-2/ai-team-timeline-cases-E5.jpg) · [design I](../../../design/images/ai-team-timeline-cases/10-i-states.png)

## AI paused on every screen (`design/screens/ai-paused.md`)

This board replaces D1 of the Safety & cost screens (as its header says).

Coverage: frames checked in the app: B1 (paused label, hover), B2 (default banner, folded), C (Resume dialog), D1, D2, D4, E2 (assignee picker), F "Right after Resume"; from code only: B2 with cancelled or held runs and revoked tokens (nothing was running), D3, E1 cards (no ticket is assigned to an AI, and assigning one would queue a run), E2 AI work panel and the mention note, F auto-trip and safe-mode neighbours.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| AP-1 | B1, every screen | Critical | layout | Top bar on one line: title, tabs, then at the right "AI paused since 10:41 \| Resume…" and New Ticket | At 1440 px when paused, "Kanban Board" wraps to 2 lines, the "AI Team" tab wraps, and **New Ticket** wraps and is cut off at the right edge | `ui/src/components/Board.tsx` (header), `ui/src/components/ai/AiKillSwitch.tsx:63` | Let the header row shrink: no-wrap title, collapse Ask AI to its icon or move the paused pair to the right group, so nothing leaves the viewport |
| AP-2 | B2, D1–D4 | High | layout | The banner sits **under** the top bar and pushes the page down | The banner is the first thing on the page, **above** the project title and tabs | App shell where the pause banner is mounted | Mount the banner after the top bar |
| AP-3 | B1 | Medium | layout | The paused label and Resume… take the place of Pause all AI, at the right next to New Ticket | At the left, after Board health and before Ask AI | `Board.tsx` header order | Move `PauseAllButton` to the right action group |
| AP-4 | B1 hover | Medium | component | Hover or focus on the label shows a card: "Paused by An Nguyen at 10:41", the counts, the reason, "Nothing new starts until an owner or admin resumes." | A native `title` tooltip. Nothing shows on keyboard focus | `AiKillSwitch.tsx:68` | Use the app tooltip/popover card on hover and focus |
| AP-5 | B2 | Low | copy | "by An Nguyen at 10:41" | "by **user** at 16:40": a pause from the browser is saved without a person's name | `ui/src/api` pause call / `server/api/ai.py:1184` (`_by()`) | Send the signed-in person as the actor |
| AP-6 | B2 | Medium | state | Facts appear once, in the banner. Zero is never shown | An extra red error toast (× icon) says "user paused all AI. 0 runs cancelled, 0 queued runs held. Reason: …" | `ui/src/components/notifications/NotificationsHost.tsx` | Drop the toast for the person who paused (the banner says it), or use an info toast without zero counts |
| AP-7 | C | Low | component | Title "Resume AI in Kanban Board" with a close ×. Full-width green strip with a check icon for the budget. Initials chips per member. "Safe mode first" with "read and comment only" inline | Title "Resume AI", no ×. A small budget pill without an icon. "0 actions in the last 10 min". A sparkle avatar for Reviewer. "Safe mode first (read and comment only)" wraps to 3 lines | `AiKillSwitch.tsx:383–540` | Match the D3 dialog values: title with the project name, close button, budget strip, initials avatar, hide the 0-actions link |
| AP-8 | D1 | Low | missing | Next to the chips: "Orange: paused for the whole project. Grey: paused on its own (budget, rate limit, or by a person)." The chip "AI paused 3" carries a pause glyph | No legend line. The chip uses a dot | `NowTab.tsx` (state chips) | Add the legend line while paused, and use `PauseGlyph` in the chip |
| AP-9 | F, Right after Resume | Low | state | Toast "AI resumed · N AI members started again…" stays 6 s | `toast.success('AI resumed')` becomes the quiet line, and nothing was visible 2.5 s after resuming | `AiKillSwitch.tsx:557` | Use a real toast with duration 6000 and the members/held-runs sentence |
| AP-10 | E2 | Low | copy | Assignee picker: each AI member is off with "AI is paused" (the design calls out repeating the word) | "AI paused · AI is paused" | assignee picker (TicketModal) | Show one phrase: "AI is paused" |
| AP-11 | D2, D4 | Low | color | The same "Right now · No AI is running · paused since" strip on Team map and Timeline | Team map strip is white; Timeline strip is orange-tinted with a pause glyph | `FlowTab.tsx:66`, `TimelineTab.tsx:315` | Use one style in both (the design's plain strip with orange text) |

Images: [design B1](../../../design/images/ai-paused/04-b1-the-top-bar.png) · [design B2](../../../design/images/ai-paused/06-b2-the-banner.png) · [now B2](shots/ai-2/ai-paused-B2-board.jpg) · [now B2 folded](shots/ai-2/ai-paused-B2-folded.jpg) · [now B1 hover](shots/ai-2/ai-paused-B1-hover.jpg) · [design C](../../../design/images/ai-paused/08-c-resume-pick-which-ai-members-start-again.png) · [now C](shots/ai-2/ai-paused-C-resume.jpg) · [design D1](../../../design/images/ai-paused/10-d1-now.png) · [now D1](shots/ai-2/ai-paused-D1-now.jpg) · [now D2](shots/ai-2/ai-paused-D2-teammap.jpg) · [now D4](shots/ai-2/ai-paused-D4-timeline.jpg) · [now E2](shots/ai-2/ai-paused-E2-assignee.jpg) · [now F](shots/ai-2/ai-paused-F-after-resume.jpg)

## Resources (`design/screens/ai-resources.md`)

Extended by ai-operations (a memory stop goes into Needs you). That is code-only here.

Coverage: frames checked in the app: F1 (nothing running); from code only: B, B2, C, D (need a running CLI), E (settings card, owned by the settings audit), F2.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| RS-1 | F1, B | Medium | missing | Each machine tile has a meter bar (RAM used, load, runs in use) | Number tiles only, no bars | `ResourcesTab.tsx` (tiles) | Add the 6 px bar, green under 65 %, amber from 65 %, red from 90 % |
| RS-2 | F1, B | Medium | behavior | Y axis 0.0, 0.5, 1.0, 1.5, 2.0 GB | Y axis reads 0.0, 0.1, 0.3, 0.4, 0.5 GB: ticks are at 128 MB steps, rounded to 1 decimal, so 0.2 is missing and the labels are wrong | `ResourcesTab.tsx:78` | Use round steps (0.5 GB, or 128/256/384 MB labelled in MB) |
| RS-3 | F1, B | Medium | layout | The chart runs up to the limit, with a red dashed "limit per run 2 GB" line | When the limit is far above the lines, it is written under the chart ("Limit per run: 4 GB, above the top of this chart"), with no dashed line | `ResourcesTab.tsx:72` | Keep the dashed limit line at the top of the axis, as drawn |
| RS-4 | F1 | Low | layout | "● Live · every 2 s" at the right of the tab row. A check icon in the verdict. Minute ticks 4, 3, 2, 1 on the x axis | Live text on the left under the title. No icon. Only "5 min ago" and "now" | `ResourcesTab.tsx` | Move the live text, add the icon and the minute ticks |
| RS-5 | F1 | Low | type | "5.0 / 16 GB" (one decimal on both) | "2 GB / 15.7 GB" (the unit twice, mixed decimals) | `resourcesFormat.ts:22` | Write "2.0 / 15.7 GB" |

Images: [design F1](../../../design/images/ai-resources/14-f1-nothing-is-running.png) · [now F1](shots/ai-2/ai-resources-F1.jpg) · [design B](../../../design/images/ai-resources/04-b-resources-every-running-ai-and-the-machine.png)

## Patterns

- **Native selects instead of the designed range button or chips** on every AI Team tab, in the Timeline toolbar and in the touch filters (AT-1, AT-2, TL-2).
- **Empty and zero states use the wrong state or show zero**: "Only 0 runs", "Why 0 runs did not finish OK", "0 actions in the last 10 min", "0 runs cancelled" in the toast, and red "0" tiles (RV-1, RV-4, AP-6, AP-7, AT-6).
- **The paused state is placed wrongly in the shell**: the banner sits above the top bar, and the paused pair sits on the left and overflows the top bar (AP-1, AP-2, AP-3). The live column ignores the pause (TL-7).
- **Hover cards are native `title` tooltips**, with nothing on keyboard focus (AP-4; the same pattern appears on the AI Team tab badge, AT-7).
- **Every run-dependent frame is code-only**: the database has no AI runs, so B/D/E/F of AI Team, the Timeline diagram, the inspector and Resources B–D were read from code.
