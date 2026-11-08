# AI v2: kế hoạch thực hiện trong một PR

Kế hoạch làm toàn bộ [`ai-v2.md`](ai-v2.md) trong **một PR**, trên nhánh `claude/ai-team-architecture-7a1efc`. Chốt ngày 2026-11-05:

- **UI tối thiểu**, dựng bằng component sẵn có; thiết kế `design/source/*.dc.html` và làm đẹp ở PR sau.
- **Xoá sạch dữ liệu AI cũ**: migration drop mọi bảng AI và tạo lại; người dùng tạo lại đội và tài khoản (thư mục đăng nhập
  `~/.kanban-board/ai-accounts/*` trên đĩa vẫn còn, bảng tài khoản dựng lại từ "accounts on this computer").
- **Runner tách tiến trình** và **`--permission-mode auto`** (tuỳ chọn project) đều trong PR.
- **Xoá hết provider khác** (Antigravity, API key, Codex, OpenCode, adapter). Chỉ còn Claude Code.

> **2026-11-08:** đây là kế hoạch của ngày 2026-11-05. Mục 1 và 2 mô tả hình dạng đích và các giai đoạn **như đã lên kế hoạch**; mục
> 6 ghi cái đã làm, và mục 7 ghi cái đã làm sau giai đoạn 9. Chỗ nào kế hoạch không còn đúng với code, nó được đánh dấu
> **(đã khác)** kèm lời chỉ sang mục 7 và [`ai-v2.md` mục 11](ai-v2.md#11-đã-xây-khác-hoặc-thêm-so-với-thiết-kế).

Khảo sát ngày 2026-11-05 (ba agent, chi tiết trong lịch sử phiên): `services/ai` 64 nghìn dòng trong 80 module cộng `assist/`
11 nghìn; `docs_ai` 9,6 nghìn; `api/ai*` 8 nghìn; `kanban_mcp` 10 nghìn; UI `components/ai` 17,6 nghìn cộng `aiteam` 15 nghìn;
931 test `test_ai*`, 147 test Docs AI.

## 0. Nguyên tắc làm

- Một PR, nhiều commit theo giai đoạn (mục 2). Mỗi giai đoạn kết thúc ở trạng thái **server khởi động được và test liên quan xanh**,
  kể cả khi UI chưa khớp (UI khớp lại ở giai đoạn 8).
- **Xoá trước, xây sau.** Giai đoạn 1 xoá phần lớn code cũ để phần còn lại nhỏ và rõ; không giữ "cho chắc".
- Tên bảng mới cho những thứ đổi hình dạng (`ai_team`, `ai_run_step`, `ai_run_agent`), tên cũ cho những bảng giữ nguyên.
- Mọi cấu hình đi theo cờ CLI từng run; không ghi gì vào repo người dùng (bỏ hẳn `config_service.sync_for_run`).
- Test: xoá theo module xoá; viết mới cho stream, step, launcher, hook endpoint, tin nhắn, SSE, migration. Chạy test liên quan,
  không chạy cả bộ (CLAUDE.md).

## 1. Hình dạng đích

### 1.1 Backend: `server/services/ai/` sau refactor

```
ai/
  accounts.py profiles.py signin.py quota.py usage.py budget.py       # giữ, cắt phần API key
  worktrees.py paths.py project_env.py secrets.py audit.py            # giữ
  transcripts.py run_retention.py resources.py power.py               # giữ   (đã khác: run_retention.py đã xoá, `aa4cbf44`)
  schedules.py github.py repo_scan.py kb.py knowledge.py memory.py    # giữ, sửa import
  library.py plugins.py packs.py board_skills.py own_claude.py mcp_sources.py  # giữ; packs → vai
  ops.py store.py injection.py                                        # giữ
  teams.py            # mới: đội (thay members.py): CRUD, health (runner có chạy được, tài khoản đăng nhập), pause
  roles.py            # mới: vai của pack → agents JSON (--agents) và agents/*.md; persona, model, effort, tool cấm
  launch.py           # mới: bộ cờ CLI (mục 5 của spec), plugin của board (hooks.json + skills), prompt files, schema báo cáo
  stream.py           # mới: parse stream-json → step rows: tool_use/tool_result (kể cả parent_tool_use_id), text của subagent,
                      #       hook events, rate_limit_event, result + structured_output
  steps.py            # mới: append-only ai_run_step, ai_run_agent; đọc theo trang; counters
  runs.py             # viết lại, nhỏ: create_run, hàng đợi, scheduler (quota theo tài khoản, không hold), start/cancel/answer,
                      #       resume theo ticket, _end, lessons từ báo cáo
  messaging.py        # mới: primitive "gửi tin tới ticket/trang": chen stdin nếu đang chạy, --resume nếu nghỉ; độ sâu chuỗi
  hooks_api.py        # mới: nhận POST từ hook script (token run), ghi step/agent, SubagentStart/Stop
  events.py (server/) # thêm publish_typed(kind, payload) cho SSE có kiểu
  runner/             # mới: tiến trình runner (mục 2, giai đoạn 6)
  cli.py              # giữ CliProcess, find_cli, detect, kill_tree, spill_long_args; bỏ Antigravity, bỏ claude_args cũ
  context.py          # cắt còn RunContext + fencing
  guard.py            # cắt còn: token → RunContext, enter/actor, duplicate-write sau resume
  config_model.py     # cắt còn hình dạng cấu hình đội (MCP servers, skills bật, hook người dùng); bỏ permission
  run_config.py       # gộp vào launch.py
```

Xoá: `permissions approvals tool_asks tool_rules hints blocks safety autotrip pause_log touches handoff mentions autopilot manager
orders hold workflow flow flow_view scope decisions flags signals awareness evals health multiproject adapters api_agent api_prompt
api_tools custom_tools mcp_remote dry_run providers live_feed history team away timeline watchdog failures comment_view
config_service config_sync members`. (`history/team/away/timeline/live_feed` viết lại rất mỏng trên bảng step: mục 1.5.)

### 1.2 Bảng dữ liệu (migration `ai_v2_reset`)

Drop: `ai_approval ai_grant ai_notification ai_decision ai_standing_order ai_order_firing ai_workflow_template ai_ticket_workflow
ai_ticket_pace ai_ticket_step ai_ticket_flag ai_eval_mark ai_workspace_defaults ai_member ai_run ai_project_settings ai_draft
docs_ai_proposal docs_ai_check` cộng mọi index của chúng. `DELETE FROM` các bảng giữ nhưng trỏ tới member/run cũ: `ai_usage`,
`ai_run_transcript`, `ai_skill_use`, `ai_schedule`, `ai_schedule_run`, `ai_worktree`, `ai_watched_pr`, `ai_account`,
`ai_account_state`, `ai_chat`, `ai_chat_message`, `docs_ai_job`, `docs_ai_session`, `ai_audit` (bắt đầu chuỗi hash mới).

Tạo mới:

| Bảng | Cột chính |
|---|---|
| `ai_team` | id, project_id, name, account_id, model, effort, persona, pack_id, config JSON (mcp servers, skills bật, plugins bật, hook người dùng), permission_mode `bypass|auto`, paused, health, health_detail, created_at |
| `ai_run` | id, project_id, team_id, kind `team|assistant|schedule`, ticket_id?, target (page id, `board`, idea id), number, state `queued|starting|running|needs_input|finished|failed|cancelled`, trigger, started_by, instruction, session_id, session_name, worktree_id?, account_id, model, effort, token_hash, pid, queued_at/started_at/ended_at/last_output_at, ended_reason, report JSON (structured_output), question, answer, tokens_in/out/cached, cost_usd, context_used/window, peak_rss_mb, restarts JSON, debug_log path |
| `ai_run_step` | id, run_id, seq, at, agent_id? (null = lead), kind `tool|edit|create|read|command|search|skill|subagent|board|text|hook|rate_limited|start|end|error`, tool, title, detail JSON (path, added/removed, command, exit_code, tests), output TEXT (chỉ tải khi mở), parent_tool_id |
| `ai_run_agent` | id (agent_id của Claude Code), run_id, agent_type (tên vai), started_at, ended_at, steps_count, last_text |
| `ai_run_message` | id, run_id, direction `in|out`, peer (tên phiên hoặc người), text, at (tin AI–AI và tin người gửi vào run) |
| `ai_project_settings` | project_id, paused_all, concurrency theo tài khoản, live_messages (mặc định bật), permission_mode mặc định, deny_list JSON, lessons_mode `auto|review`, lessons_max, caps/quota |

Giữ nguyên: `ai_account*`, `ai_usage`, `ai_audit`, `ai_run_transcript`, `ai_skill_use`, `ai_worktree`, `ai_watched_pr`, `ai_plugin`,
`ai_role_pack` (thêm cột `roles` JSON), `ai_library_item`, `ai_config_state`, `ai_project_knowledge`, `ai_lesson`, `ai_memory_note`,
`ai_knowledge_doc`, `ai_repo_scan`, `ai_schedule*` (cột member_id → team_id), `ai_assist_settings`, `ai_chat*`, `ai_insight`,
`ai_digest`, `docs_ai_settings` (bỏ edits_mode/read_scope), `docs_ai_session`, `docs_ai_job`, `docs_ai_health`, `docs_ai_ignore`,
`idea_ai_settings`, `idea_advice`, `idea_digest`.

Migration viết theo mẫu `alembic/versions/a7c1e3f5b9d2_ai_accounts.py` (drop) và `a3c5e7f9b1d4_ai_ticket_pace.py` (create),
`render_as_batch` cho SQLite, head hiện tại `f1c3e5a7b9d2`. `downgrade` chỉ tạo lại bảng rỗng.

### 1.3 Một run của đội

1. `runs.create_run(team, ticket, instruction, trigger)` → hàng đợi. Scheduler (`tick` 2 giây hoặc wake) chỉ kiểm tra: pause
   project/đội, tài khoản cần đăng nhập, quota (`quota.key_for`), số run song song theo tài khoản, run khác của cùng ticket.
2. `launch.prepare(run)`:
   - worktree theo ticket (`worktrees.ensure`), cwd = worktree;
   - **plugin của board** (sinh một lần, cache theo version): `.claude-plugin/plugin.json`, `hooks/hooks.json` (mục 1.4),
     `hooks/post.sh` và `hooks/post.cmd`, `skills/*` (các skill từ Python string chuyển thành thư mục `SKILL.md` thật trong
     `server/services/skills/<name>/`, đóng gói PyInstaller);
   - **plugin của đội**: `agents/<role>.md` từ `roles.py`, skills bật, plugin cài thêm (`plugins.dirs_for`);
   - file `--agents` JSON (cùng nội dung agents), `--append-system-prompt-file` (persona + luật board + bài học + chỉ dẫn project),
     `--append-subagent-system-prompt-file` (luật board cho vai), `--settings` JSON (deny rules), `--mcp-config` (kanban HTTP +
     Bearer token + MCP của đội), `--json-schema` (schema báo cáo: `status`, `summary`, `branch`, `pr_url`, `open_items[]`,
     `lessons[]`, `asks[]`), `--name <KEY>`, `--session-id|--resume`, `--debug-file`;
   - env: `KANBAN_URL`, `KANBAN_RUN_TOKEN`, `CLAUDE_CONFIG_DIR` của tài khoản, `--setting-sources ""`.
3. Chạy `cli.CliProcess` ở chế độ live (stdin mở) khi project bật `live_messages` (mặc định), prompt đầu đi qua stdin.
4. `stream.parse(line)` → `steps.append(run, rows)` theo lô 250 ms, mỗi lô một `events.publish_typed("ai.step", ...)`.
5. Kết thúc: `result.structured_output` → `ai_run.report`; `lessons[]` → `ai_lesson` (auto hoặc chờ duyệt); `asks[]` → câu hỏi
   trên ticket; nhánh/PR → `worktrees.handover`; `transcripts.finish`; `events.publish_typed("ai.run", state)`.
6. Tin đến khi run nghỉ (comment, review PR, CI đỏ, tin AI khác): `messaging.send(ticket, text)` → `create_run(..., resume=True)`.

### 1.4 Hook của board (trong plugin)

`hooks.json`: `PostToolUse` (Edit|Write|MultiEdit|NotebookEdit, TaskCreate|TaskUpdate|TodoWrite), `SubagentStart`, `SubagentStop`,
`Stop`, `PreToolUse` (Bash: chặn `git push --force|-f` lên nhánh chính và `rm -rf` ngoài worktree; exit 2 kèm lý do). Mỗi hook là
`${CLAUDE_PLUGIN_ROOT}/hooks/post.sh` (macOS/Linux) hoặc `post.cmd` (Windows), đọc stdin, `curl -s -X POST $KANBAN_URL/ai/hooks
-H "Authorization: Bearer $KANBAN_RUN_TOKEN" --data-binary @-`. `hooks_api.py` nhận, ghi `ai_run_agent` (start/stop), step
`edit/create` từ PostToolUse, sub-task từ TaskCreate/TaskUpdate, và publish SSE. Hook bị lỗi không chặn AI (exit 0) trừ hook cấm.
Stream vẫn là nguồn chính; hook là nguồn thứ hai cho thứ stream không có (TaskCreate, Stop của subagent kèm transcript path).

### 1.5 API

Giữ: `ai_accounts.py`, `ai_code.py` (worktree, handover, conflict), `ai_tools.py` (catalogue, plugins, packs, repo scan),
`ai_knowledge.py`, `ai_history.py` (đổi sang đọc bảng step), `schedules.py`, `ai_power.py`, phần `pulls` và `kb` của
`ai_board.py`, phần audit và inbox (câu hỏi) của `ai_safety.py`.

Viết lại `api/ai.py` còn:

| Endpoint | Mục đích |
|---|---|
| `GET/POST /projects/{id}/ai/teams`, `GET/PATCH/DELETE /ai/teams/{id}`, `pause`, `resume`, `test` | đội |
| `GET /projects/{id}/ai/overview` | đếm run theo trạng thái, quota, đội; **không steps** |
| `GET /projects/{id}/ai/board` | mỗi ticket: run đang chạy (state, vai đang hoạt động, bước cuối), **không steps** |
| `GET /tickets/{id}/ai/runs` | danh sách run của ticket, tóm tắt |
| `GET /ai/runs/{id}` | run + agents + 50 step cuối; `GET /ai/runs/{id}/steps?after=seq&agent=` trang; `GET .../steps/{seq}/output` |
| `POST /tickets/{id}/ai/run` `{team_id?, instruction?}`; `POST /ai/runs/{id}/{cancel,answer,message,restart,retry}` | điều khiển; `message` = gửi tin vào run |
| `POST /ai/hooks` | từ hook script (Bearer token run) |
| `GET /projects/{id}/ai/settings`, `PATCH` | cài đặt v2 |
| `GET /projects/{id}/ai/lessons`, `PATCH/DELETE /ai/lessons/{id}` | memory (b) |
| `GET /projects/{id}/ai/live` | 100 step mới nhất của mọi run đang chạy (thay live-feed) |

Xoá router: `ai_workflow.py`, phần orders/signals/evals của `ai_board.py`, phần permissions/grants/chain/blocks/checklist/
run-limit/keys của `ai_safety.py`, `ai_ops.py` (trouble/hand-to/tell/move-account: `tell` thành `message`, `move-account`
giữ ở teams), `ai_live_feed.py`, `ai_config.py` (dry-run, prompt preview; member config chuyển vào teams).

SSE: `events.publish_typed(kind, payload)` phát `{"type":"ai.step","run_id","steps":[...]}`, `{"type":"ai.run", run}`,
`{"type":"ai.agent", ...}`, `{"type":"ai.message", ...}`; `invalidate` chỉ còn cho thay đổi ngoài AI. `runs._publish` cũ bỏ.

### 1.6 MCP (`kanban_mcp`)

- `ai_run`: còn `ask` (hỏi người), `report` (bỏ, thay bằng `--json-schema`), `message` (tới ticket/trang; mục 4.3 spec), `team`
  (đọc đội mình). Bỏ `handoff contact decide answer`. **(đã khác)** `report` còn (ghi báo cáo sớm); thêm `reply`, `history`, `runs`.
- `ai_team`: còn `runs run cancel answer message resources restart accounts guide`. Bỏ workflow, stories, approvals, members
  CRUD (người làm trên UI). **(đã khác)** không có tool `ai_team` (`4c5c831b`).
- `ticket_items(comment)` thêm tham số `role`.
- `board_wait` giữ.
- `guard`: `guarded` chỉ còn resolve token + actor + duplicate-write sau resume; bỏ `check`, approvals, permissions, `_hide_from_ai`.
- `instructions.py` viết lại: không còn handoff/mention/chain; nói về đội, vai, `message`, báo cáo JSON.
- `operations/ai_work.py` xoá; `team_guide.py` viết lại.

### 1.7 Trợ lý (Docs, Board, Idea)

`services/assistant/` mới (thay `docs_ai` phần lớn, `assist/chat`, `idea_ai`):

- `sessions.py`: phiên theo tên `docs:<page>`, `board`, `idea:<id>`, `ticket:<KEY>:chat`; lock theo tên; `--resume` theo tên.
- `launch.py` dùng chung `ai.launch` với `kind=assistant`: quyền người dùng (token người, không token run), bypass, MCP Docs/board
  đầy đủ, plugin board (skills: `docs-pages`, `drawio-diagrams`, `sketches`, `canvas-design`, cộng skill tính năng mới:
  `docs-check`, `docs-write`, `docs-freshness`, `docs-tidy`, `docs-tickets`, `docs-summarise`, `docs-explain`, `docs-translate`,
  `docs-ask`, `docs-diagram`, `docs-history`, `board-health`, `idea-triage`, `idea-shape`, `idea-ask`, `idea-prepare-ticket`).
- Mỗi endpoint tính năng cũ giữ đường dẫn (UI không đổi) nhưng thân chỉ còn: `jobs.start(kind)` → `assistant.run(session,
  skill, args)` → kết quả JSON theo `--json-schema` của skill → trả về như cũ. `docs_ai/{ask,check,reader,write,tickets,diagram,
  history,freshness(model part)}.py` xoá; `tidy.py`, `health.py`, `freshness.py` phần quét máy móc, `jobs.py`, `settings.py`,
  `threads.py` phần hiển thị, `handoff.py` giữ.
- Sửa trực tiếp kèm Hoàn tác: `docs_write` của trợ lý ghi version mới; UI Docs đã có lịch sử version và nút revert; thêm banner
  "AI vừa sửa · xem diff · hoàn tác" (dùng `history` của trang). Bỏ `proposals`, `access`, `tiers`, `drafts` (Board AI vẽ ticket
  thì tạo thẳng ticket, `RevertChange` hoàn tác), `prompts.parse kanban-actions`.
- `llm.py` xoá (không còn one-shot). `assist/settings.py` (caps, record_usage) giữ, đổi tên `assistant/usage.py`.

### 1.8 Runner tách tiến trình

`server/runner/` chạy như tiến trình con của API (`python main.py --runner` trong dev; PyInstaller: cùng binary `kanban-server`
với cờ `--runner`, hoặc entry riêng `kanban-runner` thêm vào `desktop/kanban-backend.spec`):

- API ghi `ai_run.state=queued` và một dòng `ai_run_command` (`start|cancel|message|answer`); runner poll bảng lệnh mỗi 0,5 giây
  (hoặc nhận wake qua một unix socket/named pipe cục bộ).
- Runner sở hữu mọi `CliProcess`, đọc stream, ghi `ai_run_step`/`ai_run_agent`/`ai_run` trực tiếp vào DB (SQLite WAL; Postgres/
  MySQL cùng engine), và POST sự kiện có kiểu tới `POST /internal/ai/events` của API (token nội bộ) để API phát SSE. API chết thì
  runner vẫn ghi DB; FE reconnect thì refetch.
- Hook script POST tới API như cũ (API ghi DB, phát SSE).
- Watchdog RAM (`resources.MON`) chạy trong runner; API đọc snapshot qua bảng hoặc endpoint của runner.
- Khởi động lại: API khởi động → spawn runner; runner khởi động → `recover_on_startup` (run `running` không còn pid → requeue với
  `--resume`).
- Mã launcher/stream/steps viết sao cho chạy được **trong tiến trình API** (giai đoạn 3) và **trong runner** (giai đoạn 6) chỉ
  bằng cách đổi nơi gọi `events.publish_typed` (trực tiếp hay qua HTTP).

### 1.9 UI tối thiểu

Xoá: `AiPermissionsTab/Cards`, `AiTicketSafety`, `AiSafetyPage/aiSafetyUi/AiSafetyViews` (giữ `AiKillSwitch`), `ReviewGate`,
`AutopilotCard`, `MentionPlan`, `MentionIntent`, `TicketHold`, `TicketPlan`, `handoff/`, `evidence/`, `workflow/`, `talk/`,
`board/orders`, `limits/` (trừ phần quota), `trouble/HandToDialog`, `settings/` phần autonomy, `aiteam/` các tab Flow, Timeline,
Stepped in, Decided, Health **(đã khác: Timeline quay lại, Flow / Stepped in / Health / Resources đang làm lại, KBM-19 đến 22; mục 7)**; `api/aiSafety.ts` phần tương ứng, `aiWorkflow*.ts`, `aiOrders.ts`, `aiOps.ts`, `aiLiveFeed.ts`,
`aiEvals.ts`; types tương ứng.

Viết lại (dùng component sẵn có, không màn mới ngoài bốn màn tối thiểu):

- `AiMembersPage` → `AiTeamsPage`: danh sách đội; `AddAiMemberModal` → `AddTeamModal` ba bước: tên + tài khoản, model/effort,
  pack (chọn từ `packs`). `AiProfile` → trang đội: vai (từ pack, sửa persona/model/tool cấm từng vai = **trình sửa pack tối
  thiểu**), skill/plugin bật (tái dùng `config/` phần skills và `tools/`), cài đặt `permission_mode`.
- `AssigneePicker`: người hoặc đội; dòng phụ vai đang hoạt động từ `ai.agent`.
- `RunView`/`RunPanel`: cây hai tầng (lead → agents), step tải theo trang, output mở lazily, chip skill; `CardAiFooter` đọc
  `/ai/board` không steps.
- `ComposerAi`: "Gửi cho đội" (POST `message` nếu run đang chạy, else tạo run); bỏ intent ask/work/notify.
- `AiThread`: nhãn `role` trên comment của AI.
- `QuestionCard`: chỉ câu hỏi và trả lời.
- `LiveFeed` → `AiLivePanel` mỏng trên `/ai/live` cộng `ai.step` SSE.
- **Memory của project**: trang danh sách bài học (sửa, xoá, duyệt) trong `knowledge/` (đã có lessons UI, mở rộng).
- Live: `useSSEInvalidation.ts` thêm nhánh `ai.*` → `setQueryData` vào `['ai','run',id]`, `['ai','board',pid]`,
  `['ai','overview',pid]`; `invalidationTopics` bỏ `ai`; `pollIntervals` cho AI còn 30 giây an toàn.
- Docs/Board/Idea: giữ nguyên điểm vào; bỏ `ProposalBanner`, `ProposalReview`, `SuggestedEdits`, `PageAiFlags` (ai_hidden),
  `DocsAiSettings` phần edits_mode/read_scope, `assist/DraftWithAi|DraftChanges|DraftAiMembers` (thay bằng tạo thẳng + revert),
  `BoardAiSection` phần orders/tiers.

## 2. Giai đoạn và commit

| # | Giai đoạn | Việc chính | Test liên quan |
|---|---|---|---|
| 0 | Chuẩn bị | Chuyển helper `env/_project/_runner/_ticket/_wait` từ `tests/test_ai.py` sang `tests/ai_helpers.py`; ghi lại danh sách test xoá/viết lại | `tests/test_ai_accounts.py` chạy được qua helper mới |
| 1 | Xoá | Xoá module, router, MCP action, bảng, UI, test theo mục 1; stub tạm cho import còn sót (`services/stories.py`, `services/tickets.py`, `services/notifications.py`, `main.py`); migration `ai_v2_reset` | server khởi động; `test_ai_accounts`, `test_ai_worktrees`, `test_ai_schedules`, `test_data_import_and_legacy_db` |
| 2 | Dữ liệu và đội | Model mới (`ai_team`, `ai_run`, `ai_run_step`, `ai_run_agent`, `ai_run_message`, `ai_project_settings`); `teams.py`, `roles.py`, `packs` → vai; API teams/settings/lessons | `test_ai_teams.py` (mới), `test_ai_packs` |
| 3 | Run v2 | `launch.py`, `stream.py`, `steps.py`, `runs.py`, `hooks_api.py`, plugin board + skill thư mục thật, schema báo cáo, lessons; MCP cắt gọn; `guard` cắt; `instructions` mới; `cli.claude_args` mới | `test_ai_launch.py`, `test_ai_stream.py` (fixture stream thật từ spike: `tests/fixtures/streams/*.jsonl`), `test_ai_steps.py`, `test_ai_hooks_api.py`, `test_ai_runners` viết lại, `test_mcp_ai_team` viết lại, `test_mcp_tool_quality` |
| 4 | Live và tin nhắn | live mode mặc định, `messaging.py`, `/ai/runs/{id}/message`, tin AI–AI (ghi `ai_run_message` từ stream), độ sâu chuỗi, review PR/CI đỏ qua `github.py` → `messaging` | `test_ai_messaging.py`, `test_ai_github` |
| 5 | SSE có kiểu | `events.publish_typed`, `/ai/live`, `/ai/board` không steps, trang step, output lazily | `test_events_typed.py`, `test_ai_history` |
| 6 | Runner | `server/runner/`, bảng `ai_run_command`, `/internal/ai/events`, spawn từ `main.py`, recover, RAM watchdog trong runner; `desktop/kanban-backend.spec` | `test_runner.py` (chạy runner in-process với fake CLI), `test_ai_reliability` viết lại |
| 7 | Trợ lý | `services/assistant/`, skill tính năng (SKILL.md), endpoint Docs/Board/Idea đổi thân, bỏ proposals/access/tiers/drafts/llm, lịch chạy gọi đội/trợ lý | `test_docs_ai_*` viết lại theo skill (fake CLI trả JSON theo schema), `test_ai_assist`, `test_idea_ai`, `test_ai_schedules` |
| 8 | UI | Mục 1.9; `tsc`, eslint, prettier, vitest cho thư mục sửa | `ui/src/components/ai`, `aiteam`, `docs/ai`, `hooks` |
| 9 | Auto mode và dọn | `permission_mode` project/đội; `--permission-mode auto`; xoá stub tạm; CLAUDE.md mục Tests cập nhật tên suite; `ai-v2.md` cập nhật "đã làm" | toàn bộ suite liên quan AI một lần trước khi mở PR |

Mỗi giai đoạn một hoặc vài commit; thông điệp commit nêu giai đoạn. Giai đoạn 1 là commit xoá lớn nhất (dự kiến −60 nghìn dòng).

## 3. Fake CLI và kiểm thử

- `tests/fixtures/fake_claude.py` cắt bỏ các mode của provider khác; thêm mode `v2`: phát `system/init` (có `agents`, `plugins`),
  tool_use của lead, `Agent` → sự kiện subagent với `parent_tool_use_id` (`tests/fixtures/streams/subagent.jsonl` ghi từ spike
  2026-11-05), `rate_limit_event`, `result` kèm `structured_output` theo schema; mode `v2_live` đọc stdin như hiện tại; mode
  `v2_ask` kết thúc bằng `asks[]`.
- Hook: test gọi thẳng `POST /ai/hooks` với payload mẫu (`tests/fixtures/hooks/*.json` ghi từ spike). Fake CLI không chạy hook.
- Stream parser test bằng file jsonl thật.
- Migration test: DB cũ (fixture của `test_data_import_and_legacy_db`) chạy `ai_v2_reset` xong khởi động được.
- UI: vitest cho `useSSEInvalidation` nhánh `ai.*`, `RunView` cây hai tầng, `AddTeamModal`.

## 4. Kiểm tra tay trước khi mở PR

1. Server demo với fake CLI mode `v2`: tạo đội, giao ticket, xem cây run, step tải theo trang, SSE vá cache (đếm request/giây bằng
   cách đo ở `todo-ai-run-load-optimize`: mục tiêu dưới 1 request/giây khi 3 run chạy).
2. Một run thật bằng Haiku trên project sandbox với tài khoản `cmtienc2` (thoả thuận trước): lead sinh Reviewer, hook post lên board,
   báo cáo JSON, lesson đề xuất, worktree và nhánh.
3. Gửi comment vào run đang chạy; gửi khi run nghỉ (resume).
4. Docs: "Check this page" và "Write from ticket" qua trợ lý, hoàn tác.
5. Runner: kill tiến trình runner giữa chừng, API tự spawn lại, run `--resume`.
6. Windows: build desktop và chạy một ticket với fake CLI (hook `post.cmd`), đo POST comment bằng curl.

## 5. Rủi ro và cách xử lý

- **`services/stories.py`, `services/tickets.py`, `services/notifications.py`, `main.py`** dính `decisions/workflow/manager/flags/
  safety`: cắt phần AI, giữ phần ticket. Làm ở giai đoạn 1 với stub rồi xoá stub ở giai đoạn 9.
- **`tests/test_ai.py` là fixture của 101 module test**: giai đoạn 0 trước mọi thứ.
- **Plugin đồng bộ của tài khoản nạp vào mọi run**: thử `--setting-sources ""` và, nếu không đủ, một `CLAUDE_CONFIG_DIR` riêng cho
  run (symlink credentials của tài khoản); quyết ở giai đoạn 3.
- **Trả lời của subagent được gọi lại không về lead trong lượt**: luật trong system prompt của lead ("cần câu trả lời thì sinh
  subagent mới, đồng bộ"); board hiện text của subagent từ stream.
- **Windows**: hook `post.cmd` dùng `curl.exe` có sẵn từ Win10; `spill_long_args` giữ; test trên máy Windows của người dùng ở mục 4.6.
- **Khối lượng**: giai đoạn 3, 7, 8 lớn nhất; mỗi giai đoạn nên là một phiên làm việc riêng, cùng nhánh, commit xong mới sang
  giai đoạn kế.

## 6. Tiến độ

| Giai đoạn | Trạng thái | Ghi chú |
|---|---|---|
| 0 | xong (`5ed89997`) | `tests/ai_helpers.py` |
| 1 | backend xong | Xoá 46 module `services/ai`, `assist/`, 14 module `docs_ai`, 12 router, 4 tool MCP, stories, canvas proposals/replies, `idea_ai`, `llm`; `guard.py` cắt còn token + duplicate-write; `runs.py` là stub; `providers.py` chỉ Claude Code; 16 bảng bỏ khỏi `models.py` (migration `ai_v2_reset` ở giai đoạn 2). Test: 92 file xoá, còn 60 (825 test). Các suite cần member/run (`test_ai_accounts` phần member, `test_ai_knowledge`, `test_ai_packs`, `test_mcp_batch` 3 test) đỏ tới giai đoạn 2–3. Chưa có audit cho write của AI (guard.after cũ): giai đoạn 3. |
| 2 | xong | `models.py`: `AiTeam` (thay `AiMember`), `AiRun` gọn, `AiRunStep`, `AiRunAgent`, `AiRunMessage`, `AiRunCommand`, `AiProjectSettings` v2, `AiRolePack.roles`; migration `a2b4c6d8e0f1_ai_v2_reset` (đã chạy thử trên DB cũ); `services/ai/teams.py`, `roles.py` (12 vai sẵn có thành subagent, 6 team pack); `api/ai.py` mới (teams, settings, pause-all, overview, board); `tests/test_ai_teams.py` (12 xanh). Còn đỏ tới giai đoạn 3: 8 test tài khoản cần run hoặc tool MCP `ai_team`, `test_ai_knowledge`, `test_ai_memory`, 3 test `test_mcp_batch`. |
| 3 | xong | `launch.py` (plugin board với hook curl `post.sh`/`post.cmd`, `--agents` từ vai, hai file system prompt, `--settings` deny, `--json-schema` báo cáo, `--name`, `--debug-file`, `--system-prompt-snapshot off`), `stream.py` (subagent qua `parent_tool_use_id`, SendMessage, StructuredOutput, hook, cross-session message), `steps.py` (dòng append-only theo lô 250 ms, SSE `ai.step`), `runs.py` mới (hàng đợi, scheduler, resume theo ticket, câu hỏi, trả lời, cancel, retry, tin nhắn live, `deliver_to_ticket`), `api/ai_hooks.py`, route run trong `api/ai.py`, tool MCP `ai_run` (ask, message, team, runs, report), comment có `role`, instructions MCP mới, `events.publish_typed`. CLI giả có mode `v2`, `v2_ask`, `FAKE_CLAUDE_V2_WAIT_MESSAGE`. `tests/test_ai_runs_v2.py` (7 xanh). Xoá 22 test cũ về cơ chế run (accounts×run, knowledge, memory): viết lại ở giai đoạn 9 cho tính năng còn giữ. Chưa có: audit cho write của AI qua MCP, `--add-dir` workspace, tự thử lại khi 429. |
| 4 | backend xong | live mặc định (`ops.live_messages = True`), `send_message`, `deliver_to_ticket`, `messaging.deliver_to_page` (tạm là comment trên trang), tin AI–AI ghi `ai_run_message` từ stream, CI đỏ và review PR đi qua `deliver_to_ticket`. Chưa có giới hạn độ sâu chuỗi. |
| 5 | backend xong | SSE có kiểu (`ai.step`, `ai.run`, `ai.agent`, `ai.message`), `/ai/board` và `/ai/overview` không steps, `/ai/runs/{id}/steps` theo trang, `/steps/{seq}/output`, `/ai/live`. FE vá cache: giai đoạn 8. |
| 6 | xong | Runner là tiến trình riêng (`server/runner/`, `main.py --runner`; bản chạy thật mặc định `KANBAN_RUNNER=process`, test và dev dùng `inprocess`). API chỉ xếp hàng run và gửi lệnh qua `ai_run_command` (cancel, message, answer, wake, start); runner gửi sự kiện về `POST /internal/ai/events`. `services/ai/runner_link.py` khởi động, theo dõi và khởi động lại runner (tối đa 5 lần / 10 phút), truyền cho nó đúng thư mục config của API. `ai_run.live` và `ai_run.waiting_reason` nằm trong hàng để API đọc được trạng thái mà runner giữ. Test: `test_runner.py` (3). **Sự cố 2026-11-05**: test có sẵn `test_mcp_clients.py::test_test_connection_starts_the_real_server` khởi động server MCP thật với môi trường trần, nên server đó đọc `~/.kanban-board/config.json` của máy và chạy migration reset của nhánh này lên database thật. Đã vá: `tests/conftest.py` đặt `KANBAN_CONFIG_DIR` và `KANBAN_LOG_DIR` tạm cho mọi test (tiến trình con thừa hưởng), test kia có database riêng. Chưa kiểm: bản đóng gói PyInstaller có chạy được `--runner` hay không. |
| 7 | xong (`32b7328a`) | `services/assistant/`: một lượt Claude Code cho mỗi yêu cầu, skill tính năng là SKILL.md trong plugin. Docs AI (ask, page, write, tickets, threads), Board AI, Idea AI, AI của editor và sketch, sửa DB của `dbkit` chạy trên nó. Proposals và drafts trả 410 Gone. Tin từ đội ticket tới trang Docs vào thread của trang, trợ lý trả lời. Giới hạn: Sketch AI chỉ trả lời bằng chữ (không vẽ); action `diagram` của editor bị bỏ; Idea AI nhận ý tưởng trong prompt (MCP chưa có tool idea). Chưa chạy thật với CLI. |
| 8 | xong (`db394e20`) | Đội thay AI member; run hiện dạng cây lead + vai, step theo trang, output mở khi cần; cache vá từ `ai.step`, `ai.run`, `ai.message`, poll AI 30 s; Settings có permission mode, deny list, lessons, giới hạn, tạm dừng tất cả. Đã bỏ màn audit, usage, inbox, config, wizard pack. 4 test UI hỏng sẵn trên `main` (`Composer.draft`, `Story` Group by). |
| 9 | xong | Xong: test chất lượng tool MCP trở lại; `canvas_update` thay `canvas_propose`; `docs_write(tickets)` trở lại (`services/docs_checklist.py`); test cho launch, stream, power, audit/ops, quota/budget, transcripts, worktrees; test cũ chuyển sang v2. Sửa nhờ test: CLI nhận lại `PORT` của worktree; bàn giao Review chờ run xong được giao khi run kết thúc; `worktrees.merge` hết lỗi import; giao trang Docs cho đội gán ticket cho đội; hook của subagent khớp hàng agent của stream. Xoá `services/ai/usage.py`. `permission_mode` auto: trường của đội và project, ra `--permission-mode auto`. UI không còn gọi route đã xoá (stories, canvas proposals, windows, signals, resources, send-to-AI, ticket flags, pulls, drafts); các hành động Docs AI tạo draft giờ hỏi trợ lý của trang. Kiểm tay đạt: server thật ở chế độ process với fake CLI (giao ticket chạy hết, kill runner thì tự khởi động lại, không sót tiến trình). Chưa kiểm: một run thật bằng Haiku, đo request/giây với 3 run, hook trên Windows. |

## AI activity: giao diện theo design trước, nối logic sau

> **(đã xong, 2026-11-08)** Tab AI activity đã nối dữ liệu thật (`4b3f0323`, `59260fba`, `d1383bed`); công tắc `MOCK_AI_ACTIVITY`
> và đoạn dưới là lịch sử của cách làm, giữ để biết bản cũ trên `main` ở đâu. `services/ai/timeline.py` đã được dựng lại trên
> `ai_run`, `ai_run_agent`, `ai_run_step`, `ai_run_message`.

Tab AI activity của ticket đang hiện **mock theo đúng canvas design** (`ui/src/components/ai/activity/`, công tắc `MOCK_AI_ACTIVITY`).
Khi nối dữ liệu thật **không viết lại**: bản cũ trên `main` đã làm hết (thẻ run, RAM stream, Timeline vẽ từ dữ liệu, khởi động lại, thử lại)
và khá phức tạp, nên đọc rồi bê sang. Bảng "khối design ↔ file cũ ↔ route/service cũ" nằm ở `ui/src/components/ai/activity/mock.ts`
(đọc bản cũ bằng `git show $(git merge-base HEAD origin/main):<đường dẫn>`). `server/services/ai/timeline.py` đã bị xoá ở v2: khôi phục
rồi dựng lại trên `ai_run`, `ai_run_agent`, `ai_run_step`. Phần v2 giữ: báo cáo của lead, bước của từng vai (`RunTree`), tin nhắn cho lead đang chạy.

## 7. Sau giai đoạn 9 (2026-11-05 đến 2026-11-08)

Người dùng chạy app thật (Electron, dữ liệu thật) và báo từng lỗi một; mỗi lỗi một hoặc vài commit, việc theo dõi nằm ở project KBM
của board, Story KBM-1. Bảng dưới theo chủ đề; commit và lý do ở [`ai-v2.md` mục 11](ai-v2.md#11-đã-xây-khác-hoặc-thêm-so-với-thiết-kế).
Cách kiểm ghi ở cột cuối **chỉ khi tôi có bằng chứng**; chỗ để trống nghĩa là không có ghi chép ở đây, xem work log của ticket.

| Chủ đề | Việc chính | Ticket | Cách đã kiểm |
|---|---|---|---|
| Hoàn thiện run | vai là một dòng nối với id của Claude Code; vòng đời lấy từ stream; board chờ vai xong mới đóng CLI; hook chạy khi đường dẫn có dấu cách; `--setting-sources ""` | | run thật trên bảng tạm (ghi trong thân commit `2f4a6669`) |
| Dọn nốt v1 | chỉ Claude Code; vai không allow-list; lịch chạy chỉ mở run; bỏ model nhẹ sau mỗi run; bỏ text handoff, mention, workflow trong prompt | | |
| Timeline và AI activity | Timeline dựng lại từ dữ liệu v2; thẻ run, panel run, lịch sử run, Resources trên ticket | | |
| Ticket chat | chat nói với đội; History, `/new` `/history` `/compact` `/report` `/stop` `/cost`; tự nén; thanh ngữ cảnh | | |
| Báo cáo và bình luận | báo cáo cuối là bình luận đóng; `comment_needed` | | 14 trường hợp của hàm chặn trên bản sao DB của bảng tạm, 5 kịch bản chạy thật bằng Haiku và Sonnet, tài khoản `cmtienc2` |
| Thông báo | không báo "AI finished" khi chat đang mở và ở phía trước (`ai_chat.seen_at`, nhịp 15 giây, hạn 45 giây) | | 6 trường hợp của `on_run_ended` trên bản sao DB của bảng tạm; **chưa** thử với thông báo của Electron |
| Câu hỏi của đội | trả lời ở thread và ở chat; Answer của thông báo chạy được khi ticket mở ở tab khác | KBM-3 | video demo trên ticket |
| Skill và tệp | demo-video thành skill của board; `attachment post=false`; sha256; ảnh dán trong bình luận | | |
| Thư mục uploads | thứ tự tìm thư mục, `stored_in`, `warning`, desktop ghi `uploads_dir` | KBM-18 | video demo trên ticket |
| Story | trang Story, Group by Story, thanh sub-task trên thẻ cha, Open in Timeline | KBM-16 và các commit `fa173822` đến `2ce08974` | |
| Trang AI Team v2 | Needs you, thẻ đội và thẻ vai, Recent, Spend today; `activity.py` và ba route | KBM-17 | video demo; trạng thái "giữ vì giới hạn" kiểm bằng dữ liệu giả, **chưa** với giới hạn thật |
| MCP | `ticket_branches add adopt` | | |
| Còn lại, đang làm trên cloud | Resources (KBM-19), Flow (KBM-20), You stepped in (KBM-21), Health (KBM-22) | KBM-19 đến 22 | chưa có |

Ghi chú:

- Test đã dừng theo yêu cầu của người dùng cho đến khi refactor và sửa lỗi xong: không chạy pytest, vitest, và không viết test mới
  sau giai đoạn 9. Một số test cũ có thể còn đòi text hay thứ tự cũ (`test_mcp_tool_quality`, `test_ai_launch_v2`, thứ tự thư mục
  uploads). Việc chạy lại và sửa chúng là bước kế tiếp sau khi người dùng nói xong.
- Những gì giai đoạn 9 ghi "chưa kiểm" và còn đúng: đo request mỗi giây với 3 run, hook trên Windows, `--runner` trong bản đóng
  gói PyInstaller. "Một run thật bằng Haiku" thì đã làm nhiều lần, trên bảng tạm.
