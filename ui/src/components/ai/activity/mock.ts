/**
 * While the AI activity view is being matched to the canvas design, the ticket's AI activity shows the design's own
 * mock data (`AiActivityDesign`). Set to false to show the board's real runs again (`TicketAiPanel`, `TimelineTab`,
 * `TicketRunsTab`). Connecting the design to real data replaces this switch.
 *
 * TODO(connect to data): the old implementation on `main` is complex (live run card, RAM stream, a Timeline laid out
 * from data, restarts, retries). Do not rewrite it: read it, and port from it. It is in git at the merge base with
 * main (`git merge-base HEAD origin/main`, fcece3a9 when this was written); `git show <base>:<path>`:
 *
 *   design block          | old UI (ui/src/...)                               | old server (server/...)
 *   ----------------------|---------------------------------------------------|------------------------------------
 *   RunCardDesign         | components/ai/RunPanel.tsx  ActiveRunCard,        | api/ai.py  GET /tickets/{id}/ai/runs
 *                         |   RetryLine, TroubleCard (components/ai/trouble/) |
 *   RestartNoticeDesign   | components/ai/RunResources.tsx  RestartNotice,    | services/ai/resources.py  restarts_of
 *                         |   MemoryStopNote                                  |   (still in the tree)
 *   ResourcesDesign       | components/ai/RunResources.tsx  RunResourcesStrip,| api/ai.py  GET /projects/{id}/ai/resources
 *                         |   api/aiResources.ts, types/aiResources.ts        |   and /resources/stream; services/ai/resources.py
 *   NowAndTimelineDesign  | components/aiteam/TimelineTab.tsx (~1700 lines),  | api/ai.py  GET /projects/{id}/ai/team/timeline;
 *                         |   api/aiTeam.ts useTimeline, types/aiTeam.ts      |   services/ai/timeline.py (deleted in v2: restore
 *                         |   (these UI files are already back in this branch)|   and rebuild it on ai_run / ai_run_agent / ai_run_step)
 *   RunPanelDesign        | components/ai/RunView.tsx  RunView, RunSteps,     | api/ai.py  GET /ai/runs/{id}
 *                         |   components/ai/trouble/stepKinds.tsx             |   (v2 has /ai/runs/{id}, the steps by page)
 *   RunHistoryDesign      | components/ai/RunView.tsx  RunHistory             | api/ai.py  GET /tickets/{id}/ai/runs
 *
 * What v2 does not have any more, so the old code uses it in vain: approvals, Pause/Resume, workflow, status changes,
 * context notes. The v2 pieces to keep: the lead's report, a role's steps (`RunTree`), messages to a running lead.
 * Also in this branch, built for v2 before the design was matched: `components/ai/RunView.tsx`, `run/RunTree.tsx`.
 */
export const MOCK_AI_ACTIVITY = true;
