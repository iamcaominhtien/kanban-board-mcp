# AI v2: đội AI trên Claude Code, điều phối bởi Claude Code

Tài liệu thiết kế cho đợt **refactor hoàn toàn** phần AI (đội AI, Docs AI, Idea AI, Board AI, lịch chạy). Thay cho phần kiến trúc
của [`ai-claude-code-plan.md`](ai-claude-code-plan.md); các quyết định cũ còn giữ được liệt kê ở mục 10. Quyết định chốt ngày
2026-11-04 và 2026-11-05. Mỗi khi chốt thêm, cập nhật ở đây.

- **Phạm vi:** chỉ Claude Code CLI. Antigravity, API key và các provider khác bị bỏ khỏi v2 (code cũ giữ trong git).
- **Người dùng ở gói subscription:** tối ưu cho quota, không phải tiền.
- **"Ngon" hay không do người dùng đánh giá.** Không có bộ bài kiểm tra tự động trong v2.
- **Không cờ sống chung:** v2 thay hẳn đường cũ. Có git.
- **Trạng thái (2026-11-08):** đã làm xong 9 giai đoạn trong một PR (2026-11-05), rồi người dùng thử tay trên dữ liệu thật và sửa
  tiếp. Phần đã xây **khác hoặc thêm** so với bản thiết kế dưới đây nằm ở [mục 11](#11-đã-xây-khác-hoặc-thêm-so-với-thiết-kế);
  khi một câu ở mục 1 đến 10 mâu thuẫn với mục 11 thì mục 11 đúng. Chi tiết, giới hạn và những gì chưa kiểm ở bảng tiến độ của
  [`ai-v2-implementation.md`](ai-v2-implementation.md#6-tiến-độ).

## 1. Vì sao làm lại

Khảo sát code ngày 2026-11-04 (`server/services/ai`, hơn 50 nghìn dòng; `server/services/docs_ai`, 9.600 dòng):

1. **AI bị trói.** Run chạy `--permission-mode dontAsk` cộng `--allowedTools`: mọi tool ngoài danh sách bị từ chối im lặng, AI
   không được hỏi, chỉ thấy "denied" rồi xoay. Thêm ma trận quyền theo action, duyệt thao tác, trần trạng thái.
2. **Board điều phối thay Claude Code.** Mỗi vai là một tiến trình CLI; board chuyền bóng bằng handoff, mention, autopilot,
   manager, orders. Các vai mất context của nhau, mỗi lớp là một chỗ AI bị chặn hoặc phải chờ người.
3. **Docs AI là đường ống prompt**, không phải agent: board lấy text trang, rào lại, ghép prompt, gọi một lượt, tự bóc kết quả
   thành nháp. Mỗi tính năng là một module Python.

Hạ tầng cần cho v2 phần lớn **đã có và đã thử** (`--plugin-dir`, hook, `--resume`, worktree, stream-json, quota từ
`rate_limit_event`, tin nhắn giữa chừng qua stdin). Refactor này chủ yếu là **bỏ bớt**.

## 2. Nguyên tắc

- **Claude Code điều phối.** Board chỉ: mở phiên, đưa việc, nghe tiến trình, nhận báo cáo, đánh thức khi cần.
- **Bypass cộng danh sách cấm ngắn**, thay cho allowlist. An toàn tối thiểu từ ngày đầu chỉ gồm thứ **không làm giảm chất lượng**:
  worktree riêng cho mỗi ticket, cấm `git push --force` lên nhánh chính và `rm -rf` ngoài worktree (một hook `PreToolUse`),
  token MCP theo run. Mọi lớp khác (ma trận quyền, duyệt, trần trạng thái) bỏ. Security làm sau khi kết quả ổn.
- **Không ghi gì vào repo của người dùng.** Mọi cấu hình đi theo cờ CLI từng run.
- **Ticket là bộ nhớ chung của đội.** Tiêu chí, kế hoạch, work log, kết quả review ghi lên board, không nằm trong trí nhớ subagent.
- **Cây phẳng.** Lead nói chuyện trực tiếp với các vai; vai không sinh con dài hơi.

## 3. Những gì đã xác nhận bằng thử nghiệm

Claude Code 2.1.316 và 2.1.317, tài khoản CLI của board (`cmtienc2`), Haiku và Sonnet.

| Điều | Tương tác (2026-11-04) | `-p` như board chạy (2026-11-04, 11-05) |
|---|---|---|
| Subagent có tool Agent (lồng nhau) | Có: Sonnet sinh được Haiku | Có |
| Gọi lại subagent đã xong bằng `SendMessage` + agentId | Có, nhớ nguyên context | Có, cả sau `--resume` của lead; nó chạy tool và nhớ từ khoá cũ |
| Trả lời của subagent được gọi lại về tới cha | Về tới phiên chính; **không** về tới subagent cha đã hết lượt | **Không** về tới lead trong lượt đó; board thấy trong stream |
| Stream mang `parent_tool_use_id` cho sự kiện của subagent | n/a | Có; `--forward-subagent-text` thêm text và thinking |
| Hook từ `--plugin-dir` chạy trong subagent | n/a | Có: `PreToolUse` kèm `agent_id`, `agent_type`; có `SubagentStart`/`SubagentStop` |
| Hai phiên nhắn cho nhau | n/a | Có, hai chiều, theo `--name`, qua unix socket `/tmp/cc-socks/<pid>.sock`; chỉ khi cả hai còn chạy |
| `--json-schema` | n/a | Có: tool `StructuredOutput`, trường `structured_output` trong `result` |
| `--brief` (tool SendUserMessage) | n/a | **Không** có tool ở `-p` |
| `--permission-mode auto` | n/a | Chạy Bash và Write, không từ chối gì; chưa biết nó chặn gì |
| Resume subagent **từ ngoài** (board) | Không: `--resume` chỉ nhận session id; transcript subagent nằm trong thư mục phiên cha | như bên |
| Plugin đã đồng bộ của tài khoản | n/a | Nạp vào **mọi** run (7 plugin); cần cách tắt |

Chưa thử: hai tài khoản khác `CLAUDE_CONFIG_DIR` có thấy nhau trong `ListAgents` không (phiên tương tác của Desktop không hiện
trong danh sách của phiên `-p`).

Hệ quả thiết kế: subagent "sống" là **transcript cộng id**, không phải tiến trình. Gọi lại để nó *làm tiếp* thì được; cần *câu trả
lời* thì sinh subagent mới, đồng bộ, hoặc để board đọc từ stream.

## 4. Kiến trúc

### 4.1 Ba loại chạy, một nền

| Loại | Gắn với | Phiên | Tên phiên (`--name`) |
|---|---|---|---|
| **Đội** | một ticket | lead của ticket, `--resume` theo ticket | `<KEY>` (ví dụ `IAM-12`) |
| **Trợ lý** | Docs, Board, Idea | phiên chính riêng, không gắn ticket; theo trang hoặc theo khu | `docs:<page>`, `board`, `idea:<id>` |
| **Lịch chạy** | giờ | gọi một đội hoặc trợ lý | theo đích |

Tất cả là `claude -p --output-format stream-json` với cùng một bộ cờ (mục 5).

### 4.2 Đội và lead

- **Member = đội**, không còn là một vai. Một đội có: tên, tài khoản Claude, model mặc định, pack vai, persona. Hầu hết project
  có một đội; có hai khi cần hai tài khoản (chạy song song nhiều ticket hơn) hoặc hai pack (backend, UI).
- **Assignee của ticket = đội**, tức lead của ticket. Giao ticket là mở phiên của ticket. Đổi assignee = đổi đội, lead mới mở phiên
  mới với lịch sử ticket.
- **Vai = subagent** của lead, định nghĩa qua `--agents` (file JSON board sinh) hoặc `agents/*.md` trong plugin: PM/BA, Dev,
  Reviewer, QA, Designer, User tester… Mỗi vai có model, effort, persona, tool bị cấm riêng. Lead quyết gọi ai, khi nào, song song
  hay lần lượt.
- Vai cần nhớ (Dev) thì lead **gọi lại cùng agentId**; vai nên sạch (Reviewer) thì **sinh mới mỗi vòng**, nhận diff cộng danh sách
  lỗi vòng trước dạng text. Dặn trong định nghĩa vai.
- Lead là vai điều phối mỏng hay chính Dev: để lead tự quyết theo ticket; mặc định của pack "Tính năng chuẩn" là lead tự code và
  gọi Reviewer, QA.
- Trên ticket: assignee hiện tên đội; dòng phụ hiện vai đang hoạt động (từ hook `SubagentStart`/`SubagentStop`); comment do vai viết
  đi qua token của lead, kèm trường `role` để UI hiện "Reviewer · Đội An".
- Các cơ chế bỏ: handoff, mention giữa member, chuỗi mention chống lặp, ghi đè assignee khi bàn giao, autopilot, manager, orders,
  approvals, ma trận quyền theo action, trần trạng thái, hold.

### 4.3 Liên hệ giữa AI

Hai tầng, một primitive: **gửi một tin tới ticket** (hoặc trang Docs).

1. Cả hai cùng chạy: nhắn thẳng bằng `SendMessage` theo tên phiên, không qua board. Board vẫn thấy cả hai chiều trong stream
   (`SendMessage` gửi đi, `<cross-session-message>` nhận về) và hiện lên thread ticket.
2. Bên nhận đã nghỉ: gửi qua tool board; board ghi comment, `--resume` bên nhận với tin đó (hoặc chen vào stdin nếu đang chạy).

Lead có thể tự thử cách 1 (`ListAgents`) rồi rơi về cách 2; hoặc board gói cả hai vào một tool `message(to=ticket)`. Hai kiểu chờ
cho bên gửi: hỏi rồi chờ (`board_wait`), hỏi rồi đi (trả lời về thread). Giữ giới hạn độ sâu chuỗi AI gửi AI.

Chiều ticket → Docs gần như không cần: lead tự sửa trang bằng tool Docs. Chiều chính là Docs hỏi ticket.

### 4.4 Giữ sống có chủ đích

Ticket đang làm thì lead chạy ở chế độ live (stdin mở, `--input-format stream-json --replay-user-messages`): nhận tin người, tin
AI khác, CI đỏ, comment review PR. Đây là `live_messages` hiện có, đổi thành mặc định cho ticket đang hoạt động. Ticket nghỉ thì
tiến trình kết thúc; việc đến thì `--resume`.

### 4.5 Tiến trình lên board

Ba kênh, rẻ nhất trước, không cần pub/sub mới:

1. **stream-json** của lead (đã đọc): mọi tool call, kể cả của subagent (`parent_tool_use_id`), text của subagent
   (`--forward-subagent-text`), sự kiện hook (`--include-hook-events`), `rate_limit_event`.
2. **Hook trong plugin**: `PostToolUse` Edit/Write, `SubagentStart`/`SubagentStop`, `Stop`, hook trên tool TaskCreate/TaskUpdate
   (kế hoạch của chính Claude Code thành sub-task trên ticket). Script hook chỉ `curl` API board với token run từ biến môi trường.
   Không tốn token.
3. **Tool MCP**, cắt còn năm sáu: comment (có `role`), work log, hỏi người, gửi tin tới ticket/trang, `board_wait`, Docs.
   *(Đã xây: các tool ticket và Docs như cũ cộng một tool `ai_run` chỉ chạy trong run do board mở, với bảy action `ask`, `message`,
   `reply`, `history`, `team`, `runs`, `report`; không có tool `ai_team`. Xem mục 11.2.)*

Báo cáo cuối của run bằng `--json-schema` (trạng thái, tóm tắt, nhánh, PR, việc dở, bài học đề xuất, và `comment_needed`: có cần
bình luận trên ticket không). Hết bóc text. Báo cáo cuối **chính là bình luận đóng của ticket** (mục 11.1).

### 4.6 Memory (kiểu b, board sở hữu)

Ba lớp của D18 giữ nguyên: chỉ dẫn project (luôn trong prompt), **bài học** (ngắn, người sửa được, nạp vào prompt), kho kiến thức
(tool tìm khi cần, không embedding mặc định). Bài học do lead đề xuất trong JSON báo cáo cuối (hoặc tool `remember`), người duyệt
hoặc tự nhận theo cài đặt project, có giới hạn độ dài (`lessons_max` là số bài học giữ cùng lúc). Board **không** gọi model nhẹ sau
mỗi run để rút ghi chú (đã bỏ, commit `8d65b684`). Dùng `--system-prompt-snapshot off` để bài học mới nạp được vào ticket đang
chạy mà không mất hội thoại.

### 4.7 Trợ lý (Docs AI, Board AI, Idea AI)

- Một loại phiên chính không gắn ticket, chạy với quyền của người dùng (D23), bypass, tool MCP Docs/board đầy đủ, skill
  `docs-pages` và `drawio-diagrams` sẵn có.
- **Mỗi tính năng là một skill**, không phải module Python: Check this page, Write from ticket, Freshness, Tidy, Create tickets
  from page, Summarise, Translate view… Sửa skill không đụng server.
- **Sửa trực tiếp kèm Hoàn tác** (trang có version). Chế độ "đề xuất trước" là tuỳ chọn, mặc định tắt. Bỏ hệ `proposals`.
- Bỏ lớp `access` riêng: trợ lý đọc những gì người dùng đọc được.
- Giữ: `jobs` (ghi mọi lần gọi, quota), phiên theo trang (`--resume` theo tên `docs:<page>`), `history`, phần hiển thị của
  `threads`, phần quét máy móc của `freshness`/`health` (link hỏng, ticket Done mà trang còn nói "chưa làm").
- Điểm vào trên UI giữ nguyên: menu AI trên trang, Ask trong palette, `/ai` trong editor, Ask the Board AI, Idea AI.

### 4.8 Những gì giữ từ bản cũ

Worktree theo ticket (D4), bàn giao code PR / merge máy / để nhánh (D6, D7), quota theo tài khoản và model theo bước (D17), kho
kiến thức (D18c), bộ quét repo (D19), gắn GitHub (D21), lịch chạy, tài khoản Claude (`~/.kanban-board/ai-accounts`), token MCP
theo run, audit, lưu transcript, tài nguyên RAM/CPU (Resources).

## 5. Bộ cờ CLI của một run

```
claude -p [prompt | --input-format stream-json --replay-user-messages]
  --output-format stream-json --verbose
  --forward-subagent-text --include-hook-events
  --permission-mode bypassPermissions            # thử `auto` sau khi kết quả ổn
  --disallowedTools "<danh sách cấm ngắn>"       # cộng deny rules trong --settings
  --settings <json>  --setting-sources ""        # settings của người dùng không chen vào run của board
  --plugin-dir <plugin của đội>  [--plugin-dir <plugin cài thêm>…]
  --agents <file JSON các vai>
  --append-system-prompt-file <persona + luật board>
  --append-subagent-system-prompt-file <luật board cho mọi vai>
  --mcp-config <json> --strict-mcp-config
  --json-schema <schema báo cáo>
  --system-prompt-snapshot off
  --name <KEY|docs:<page>|board>  --session-id <uuid> | --resume <uuid|tên>
  --model <model> --effort <effort>
  --debug-file <log của run>
  [--no-session-persistence]                     # run dùng một lần: triage, tóm tắt
  [--add-dir <workspace của ticket>]
```

Không dùng: `--bare` (chỉ API key), `--restricted`, `--max-budget-usd`, `--brief` (không có tool ở `-p`).
Còn mở: `--bg` và bộ `agents/attach/logs/stop/respawn/rm` (quản lý phiên nền của Claude Code; `logs` là terminal, chưa chắc hợp
stream-json); `-w/--worktree` (Claude Code tự tạo worktree, nhưng board mất quyền quyết đường dẫn); `--fallback-model` (có bắt
429 quota không); `--from-pr`; `--autocompact`.

## 6. Đường dữ liệu và hiệu năng

Đo ngày 2026-11-04 trên Mac, CLI giả stream như run thật (3 run, mỗi run 4 lệnh Bash một giây kèm 3 KB output):

| Phép đo | Kết quả |
|---|---|
| POST comment, lúc rảnh / 3 run stream / cộng refetch | p50 6 ms / 5 ms / 6 ms, max 20 ms |
| Bấm Comment trên UI thật đến khi hiện | 127 ms |
| Một tab UI mở trang ticket khi run chạy | **10 request/giây**, khoảng 25 endpoint kéo lại mỗi 2,4 giây |
| GET `ai/overview` một mình / 8 cái song song | 30 ms / tất cả xong ở ~140 ms (nối đuôi) |
| GET `ai/overview`, `ai/team/now` khi tab đang mở | 250–730 ms trung bình, đỉnh 1,0–1,6 s |
| CPU server | 8–11 % chỉ run; 36 % khi có một tab |
| Renderer | 1 long task 75 ms trong 36 giây |
| GET `ai/runs?limit=60` | 2,4 MB (steps nhúng trong danh sách) |

Kết luận: server là một event loop Python, handler là CPU work, nên request **nối đuôi nhau**; FE bắn 10 request/giây cộng mỗi
step phải parse và ghi lại cả blob `steps` nên hàng đợi dài ra. POST comment rẻ, nó chậm vì **đứng sau hàng đợi**. Trên Windows
cộng thêm tiến trình `claude` thật ăn CPU và SQLite chậm vì antivirus nên thành vài giây (chưa đo ở đó; đo bằng curl POST khi team
đang chạy: trên 1 giây là server, dưới 100 ms mà app chậm là Electron).

Thiết kế v2:

1. **Step là một dòng riêng** (bảng append-only), output lệnh ở cột riêng, chỉ tải khi mở panel. Hook ghi vào cùng bảng.
2. **SSE mang payload có kiểu** (step, đổi trạng thái); client vá cache, không refetch. Chỉ run bắt đầu hay kết thúc mới làm danh
   sách refetch. Endpoint danh sách không nhúng steps.
3. **FE chỉ vẽ cái đang mở**: cây run và subagent của run đang mở; run khác chỉ nhận bộ đếm.
4. **Runner tách tiến trình** (giai đoạn sau): đọc stream CLI và ghi step ở một process riêng, API không chia loop với run; chết
   thì restart riêng. Multiprocessing, không phải thread: handler là CPU-bound Python, GIL.
5. **Fire-and-forget có hàng đợi bền** cho mọi API sinh ra việc (gửi cho AI, start run, job trợ lý): ghi một dòng "ý định" vào DB
   rồi trả 202, worker nhặt lên, khởi động lại thì nhặt tiếp. Trạng thái `queued` của run đã đúng mẫu này. API ghi một dòng thì
   giữ đồng bộ (vài ms). FE không chờ SSE cho thao tác của chính mình.

## 7. Giao diện

Bỏ nhiều hơn xây. Phần AI của UI hiện ~20 nghìn dòng, 68 file cộng thư mục con, hơn 20 màn thiết kế `ai-*.md`.

- **Bỏ:** quyền theo action và template (`AiPermissionsTab`, `AiPermissionsCards`, `AiTicketSafety`, phần lớn `AiSafetyPage`);
  duyệt và cổng review (`ReviewGate`, phần duyệt của `QuestionCard`, `AutopilotCard`); bàn giao và mention (`handoff/`,
  `MentionPlan`, `MentionIntent`, `TicketHold`); thiết kế `ai-team-review`, `ai-safety-cost`, phần handoff của `ai-team`,
  `ai-team-process`.
- **Sửa:** `AiMembersPage`, `AddAiMemberModal` (member thành đội: lead, tài khoản, model, pack); `AssigneePicker` và ngữ cảnh
  ticket (đội cộng vai đang hoạt động); `RunView`, `RunPanel` (cây hai tầng, chip skill đã dùng; màn sửa nhiều nhất); `ComposerAi`,
  `AiThread` (gửi cho lead đang chạy, comment có nhãn vai).
- **Giữ:** `accounts`, `AiUsage` và quota, `schedules`, `AiInbox`, `AiAuditLog`, Docs AI điểm vào, `knowledge`, `AiKillSwitch`,
  Resources.
- **Mới, cần thiết kế:** trình sửa pack (vai, persona, model, skill, lệnh cấm); trang Skills & plugins theo project (D3, một
  phần đã có trong `ai-provider-config`, bảng này sau đó bị xoá khỏi `design/`: xem `ai-project-settings`); trang memory của project; cây tiến trình trong run. Làm từ `design/source/*.dc.html`.

> **Đã xây khác (cập nhật KBM-39):** danh sách "Bỏ" ở trên là kế hoạch đầu. Khi thử tay, **Timeline đã quay lại** (dựng từ run, vai và
> câu hỏi của v2), cùng trang **AI Team**, trang **Story** và nhóm **Group by Story**. Trang AI Team nay có **bảy tab**: **Now**,
> **Flow** (một Map hoặc một Timeline, theo phạm vi chọn), **Run history**, **You stepped in**, **Health**, **Resources** và
> **Memory**. Timeline không còn là tab riêng: là một cách xem của Flow. **Docs AI** cũng đã quay lại (hỏi, kiểm tra trang, sức khoẻ
> Docs, Send to AI) trên đường ống của `services/assistant/`. Vẫn **không** có tầng duyệt, quyền theo action, bàn giao do board giữ
> hay ngân sách v1. Xem mục 11.4.

## 8. Lát cắt đầu tiên và thứ tự

> **2026-11-05:** chốt làm **toàn bộ trong một PR**, kế hoạch chi tiết ở [`ai-v2-implementation.md`](ai-v2-implementation.md)
> (UI tối thiểu, xoá sạch dữ liệu AI cũ, runner tách tiến trình và auto mode đều trong PR, xoá hết provider khác).

**Lát cắt 1 (chứng minh "ngon"):** một project, một đội, một ticket. Lead `-p` với bộ cờ mục 5, plugin của board, vai là subagent,
worktree riêng, báo cáo bằng `--json-schema`, tiến trình bằng stream cộng hook, bảng step mới và SSE có kiểu. Không handoff,
không duyệt, không ma trận quyền. Người dùng đánh giá trên lát cắt này trước khi làm tiếp.

Sau đó: (2) live mode mặc định, tin giữa chừng, liên hệ AI với AI; (3) memory kiểu b, báo cáo bài học; (4) trợ lý Docs với skill
thay module, rồi Board AI và Idea AI; (5) lịch chạy gọi đội/trợ lý; (6) UI mới (pack, Skills & plugins, memory, cây run); (7) runner
tách tiến trình; (8) thử `--permission-mode auto` và hàng rào an toàn thêm khi kết quả đã ổn.

## 9. Còn mở

- Hai tài khoản khác `CLAUDE_CONFIG_DIR` có nhắn được cho nhau không. Nếu không, liên hệ giữa đội khác tài khoản luôn đi tầng 2.
- ~~Cách tắt plugin đã đồng bộ của tài khoản trong run của board~~ **Đã xử lý:** run chạy với `--setting-sources ""` (không đọc file
  settings nào; `CLAUDE.md` và skill của `--plugin-dir` vẫn nạp, đã đo; commit `1e49b572`) và plugin riêng của tài khoản không vào
  run (`873a51c6`, `087bd152`).
- `--permission-mode auto` thực sự chặn gì.
- Trả lời của subagent được gọi lại không về lead trong lượt: board có nên đưa nó vào lượt kế của lead qua stdin không.
- Đo độ trễ trên Windows với team thật (lệnh curl ở mục 6).
- `--bg` có dùng được với stream-json không; nếu có thì bớt được phần quản lý tiến trình của `runs.py`.

## 10. Quyết định cũ: giữ và bỏ

Giữ: D1–D3 (skill và plugin, catalog, trang Skills & plugins), D4 (worktree), D5 (cấu hình theo run qua cờ), D6–D7 (bàn giao
code), D9 (ít bước, người kiểm tra độc lập nhận diff không nhận transcript), D10, D15–D16 (pack, User tester với Playwright), D17
(quota), D18 (ba lớp kiến thức), D19–D21, D23 (Board AI với quyền người dùng), D25, S1–S6.

Bỏ hoặc đổi: D8 (quy trình gắn ticket: Claude Code tự điều phối, pack chỉ gợi ý), D11–D13 (vòng làm lại, phân xử, mức review: lead
và vai tự xử; chỉ giữ "không tiến triển thì hỏi người"), D14 (vai theo bước: thay bằng vai đang hoạt động từ hook), D22 (đánh giá
đội AI: người dùng tự đánh giá), ma trận quyền và duyệt của `ai-safety-cost`, handoff/mention/autopilot/manager/orders, `proposals`
và `access` của Docs AI.

## 11. Đã xây khác hoặc thêm so với thiết kế

Từ 2026-11-05 đến 2026-11-08 người dùng thử tay trên dữ liệu thật và sửa tiếp (khoảng 110 commit sau giai đoạn 9). Mục này liệt
kê **từng điểm khác với mục 1 đến 10**, kèm commit (`abcd1234`) hoặc ticket board (KBM-n). Mỗi dòng đã đối chiếu với code ở đầu
nhánh `claude/ai-team-architecture-7a1efc`; chỗ chưa kiểm được ghi rõ.

### 11.1 Ticket chat, báo cáo và bình luận

| Thiết kế ban đầu | Đã xây |
|---|---|
| Không nói về chat trên ticket (Board AI trả lời một lượt) | **Chat trên ticket nói với đội của ticket**, không có chế độ (`1904ec7f`). Lead đang chạy thì trả lời trong chat rồi làm tiếp (tin đến qua stdin); đội đang nghỉ thì tin là việc kế của nó: board mở run với `trigger="message"`. Lead trả lời bằng `ai_run(action="reply")`, lời đáp điền vào tin chat đang chờ. |
| Phiên của ticket chạy mãi | Người dùng có thể **làm lại từ đầu**: `POST /tickets/{id}/ai/sessions/new` đóng cuộc trò chuyện hiện tại thành một dòng **History** (`ai_session_history`: tiêu đề, tóm tắt, các session id, các run; migration `c4e6a8b0d2f3`), `GET /tickets/{id}/ai/sessions` liệt kê, mọi AI đọc bằng `ai_run(action="history")` (`5821b996`). `POST /tickets/{id}/ai/compact` nén phiên; cài đặt project có mức tự nén (`auto_compact_pct`, đặt qua env của CLI) và chat có thanh ngữ cảnh (`348aa0fe`). |
| (không có) | Lệnh gạch chéo trong khung chat của đội: `/compact`, `/new`, `/history`, `/report`, `/stop`, `/cost` (sáu lệnh trong `ScopedChat.tsx`; `/cost` cộng tiền các run của đội). |
| Bình luận do vai viết | **Báo cáo cuối của lead là bình luận đóng của ticket**; AI được dặn không viết bình luận thứ hai (`a41f9a7c`). |
| (không có) | Chat dùng để nói chuyện, bình luận dùng cho tin về công việc. Báo cáo có trường **`comment_needed`**; với run do một tin chat mở, nếu đội báo `false`, run không bị `blocked`, không tạo nhánh và đã thật sự trả lời trong chat thì board **không** đăng bình luận đóng (`6d2bba47`, `runs._chat_was_enough`). Mọi run khác vẫn đăng. |
| Thông báo "AI finished" cho mọi run | Với run do tin chat mở, **không báo** khi người đó đang mở và nhìn khung chat của ticket. Trang chat báo `POST /ai/assist/chats/{id}/seen` mỗi 15 giây (cột `ai_chat.seen_at`, migration `d5f7b9c1e3a4`); run kết thúc trong 45 giây kể từ nhịp cuối thì không báo. Chat đóng, cửa sổ ở nền, hoặc run lỗi thì vẫn báo (`cf5b6da6`). |
| Câu hỏi của đội hiện ở thread | Câu hỏi hiện **ở chỗ người đang ở**: trong thread bình luận và trong chat AI của ticket; nút Answer của thông báo đưa thẻ câu hỏi ra trước, kể cả khi ticket đang mở ở tab khác (`82b29e19`, KBM-3 `bd13d662`). |
| Gửi tin cho đội | Một bình luận gửi cho đội được giữ lại và thread hiện đội đang làm (`4098008b`). |

### 11.2 Tool MCP và luật cho AI

- **`ai_run`** (chỉ trong run do board mở, nhận ra qua bearer token): `ask` (hỏi người rồi dừng), `message` (tới ticket `IAM-12` hoặc
  `docs:<page id>`; ticket chính mình thì bị từ chối), `reply` (trả lời tin chat), `history`, `team`, `runs`, `report` (ghi báo cáo
  sớm; báo cáo JSON cuối vẫn là đường chính). Kế hoạch triển khai mục 1.6 nói bỏ `report`; thực tế còn.
- **Không có tool `ai_team`** (`4c5c831b`): danh sách tool của spec không có nó, và mọi chỗ nhắc tới đã bị xoá.
- `ticket_branches add` có `adopt` để ghi một nhánh đã có sẵn trong repo (`0f769197`). `ticket_items attachment post=false` giữ file mà
  không tạo bình luận riêng, để AI gom file vào một báo cáo (`92f1e037`). Kết quả đính kèm có kích thước và `sha256` của bản board
  giữ, nên AI không đi tìm file trên đĩa (`5154e62a`); từ KBM-18 nó còn có `stored_in` (file nằm ở đâu) và `warning` khi file rơi vào
  thư mục dự phòng.
- Mọi AI được báo **Workspace của ticket** ở đâu (`35645a14`). Skill `working-a-ticket` bắt buộc cho lead và mọi vai, và nói cách
  rời ticket: trạng thái, tiêu chí, bình luận đóng (`68cf6700`). Kết quả viết cho người (nghiên cứu, spec, quyết định, hướng dẫn) là
  **một trang Docs gắn vào ticket**, không phải file Markdown trong thư mục; chỉ đội có vai dev hoặc devops (hoặc lead không có vai)
  nhận luật nhánh, commit, test (`7a0b7392`). Lệnh trong skill dùng `${CLAUDE_SKILL_DIR}` (`5db2acbd`).
- Skill **demo-video** là skill của board (`kanban-board:demo-video`) cho mọi đội có vai làm việc (`524f72d1`, `f1bb02b7`); video đăng
  trên ticket phát ngay trong bình luận (`15013500`). Hotfix 3.37.2 (`fcece3a9`, vào nhánh qua `ba693dbc`): AI nhìn được ảnh dán trong
  bình luận và mô tả.

### 11.3 Run, vai, lịch chạy

- **Tài khoản chỉ Claude Code** (`7d1324ba`, `cf714b55`): không còn mã Codex, opencode, Antigravity, màn tài khoản chỉ nói Claude Code.
- **Vai không có allow-list tool**, giữ mọi tool của run (`50b5887e`); một vai bị giới hạn vài tool vẫn có `Skill` để mở hướng dẫn của
  nó. Pack không còn mẫu quyền, trần trạng thái, allow list hay permission mode (`defda10a`).
- **Một vai là một dòng**, nối với id của Claude Code qua kết quả của lệnh `Agent` ("Async agent launched … agentId"); vai chạy
  foreground kết thúc ngay ở đó; hook `SubagentStart/Stop` không khớp dòng nào thì bỏ (`2f4a6669`). Kết thúc của vai còn đọc được từ
  task notification, và vai còn mở khi CLI thoát thì được đóng (`76f9b6b2`). Vòng đời của run lấy từ chính stream của CLI
  (`750311cb`); board **chờ các vai xong rồi mới đóng CLI** (`b4751888`); một lượt trống khi resume không tính là câu trả lời của lead
  (`31c50bcd`).
- Hook của board chạy được khi thư mục dữ liệu có dấu cách (`025562cb`); hook `PreToolUse` cấm `git push --force` lên nhánh chính (kể cả
  khi cờ nằm cuối) và `rm -rf` ngoài thư mục của run (`22496c58`, `459ebe81`).
- **Lịch chạy** chỉ mở một run; lead tự quyết và báo cáo. Board không còn kiểm "done when", chạy lệnh test, nhờ AI khác review hay
  chạy lại ở trạng thái "fixing"; còn giữ giới hạn thời gian, thử lại khi chết, tự tạm dừng sau ba lần lỗi, và luật bù giờ
  (`66f65774`). Các cột `checks`, `review` còn trong bảng nhưng không ai đọc ghi.
- **Giao mà chưa chạy** (Assign only): `PATCH /tickets/{id}?start=false` (`6f936276`).
- **Runner** là tiến trình riêng, bản chạy thật mặc định `KANBAN_RUNNER=process`; API chỉ xếp hàng, runner đọc stream và ghi thẳng DB
  (giai đoạn 6, không đổi). Migration sửa bù `b3d5f7a9c1e4` thêm cột cho DB đã chạy bản `ai_v2_reset` sớm (`4aa43dbf`); API khởi động
  runner sau khi DB đã lên đời (`40c8797d`).
- Đã bỏ: `run_retention.py` cùng cài đặt của nó; `lessons_max` giờ là số bài học giữ cùng lúc (`aa4cbf44`); `propose_from_diagnosis`
  (`d71c0337`); mọi nhắc tới chuỗi mention, standing orders, handoff, workflow trong text AI đọc (`9352034b`, `9502d062`); nhánh
  prompt cũ ở `context.py` (`ebefa3b6`); thẻ "own plugins" của tài khoản (`087bd152`).

### 11.4 Giao diện

- **Timeline quay lại**, dựng từ `ai_run`, `ai_run_agent` (kèm marker của `ai_run_step`) và `ai_run_message`: một đường cho người,
  một cho lead, một cho mỗi vai, thanh cho mỗi run và mỗi đoạn làm việc, mũi tên cho bàn giao, câu hỏi và trả lời, khoảng project bị
  tạm dừng. Route `GET /projects/{id}/ai/team/timeline`, `services/ai/timeline.py`, `TicketTimeline` trên ticket (`d1383bed`,
  `fd98bde9`, `2f4a6669`). Spec mục 7 đã đánh dấu Timeline là "bỏ"; điều đó không còn đúng. Trên trang AI Team, Timeline là một
  **cách xem của tab Flow** (cạnh Map), không còn là tab riêng (KBM-29).
- **Tab AI activity của ticket** vẽ từ run của ticket: thẻ run, panel run (mở một bước ra toàn bộ lệnh hay câu, tải các bước trước
  50 bước mới nhất), lịch sử run (mỗi run bắt đầu bằng yêu cầu đã mở nó và kết thúc bằng báo cáo; "Full history" xếp mọi run liền
  nhau), cụm bước của subagent gập dưới dòng đã giao việc (`ab4837a6`, `b5d04a6d`, `a7348bc3`, `ffb8733a`, `e2767c3c`); thẻ Resources và
  thông báo khởi động lại của ticket đã nối dữ liệu thật (`59260fba`). Mock theo canvas (`MOCK_AI_ACTIVITY`) đã thay bằng dữ liệu thật.
- **Trang AI Team** (KBM-17 và các commit `7e2205b1`, `23175f0f`, `4ba20799`): tab **Now** có dải **Needs you**, thẻ đội với thẻ cho
  từng vai (đang làm gì, lần làm gần nhất, số bước và run hôm nay), Recent (run vừa xong kèm dòng đầu của báo cáo) và Spend today.
  Dữ liệu từ `services/ai/activity.py`, tính từ `ai_run`, `ai_run_agent`, `ai_run_step`, `ai_run_message`, không migration, **không có
  tiền theo từng vai** (tiền thuộc về run). Route `GET /ai/teams/{id}/activity`, `GET /projects/{id}/ai/team/activity`,
  `GET /projects/{id}/ai/recent`. Bảy tab hiện có: Now, Flow, Run history, You stepped in, Health, Resources, Memory (xem bên dưới).
- **Story**: một Story mở thành **trang Story** (tiến độ, ticket con theo thứ tự đợt kèm đội đang giữ và run, tiêu chí, token và tiền,
  "Open in Flow" giới hạn vào Story; menu ⋯ có "Open as ticket") (`fa173822`, `8a73b0a3`, `2ce08974`); bảng đặt **Group by Story**
  trở lại, mỗi Story một làn (`610a91df`). Thẻ ticket cha có lại thanh sub-task (KBM-16, `0b4f2863`). Phần PM của v1 (Run by PM, Flow,
  Pause, phiên bản kế hoạch, Decided for you, Autonomy, ngân sách token) vẫn ra ngoài.
- **Đã quay lại** (trước đây ghi "chưa quay lại", ticket KBM-19 đến KBM-22; dựng theo thiết kế ở KBM-28 và KBM-29), mỗi cái là một tab của
  `AiTeamView`: **Flow** (`FlowTab`; Map và Timeline, thanh phạm vi: cả project, một đội, một Story hay một ticket; `GET /projects/{id}/ai/team/flow`,
  `.../flow/scopes`, `.../timeline`; "Open in Flow" trên ticket và trang Story mở nó), **You stepped in** (`SteppedInTab`: mỗi lần một người
  phải chạm vào việc trong 7 ngày, có thể thành bài học; `GET .../ai/team/touches`, `POST .../touches/lesson`; `services/ai/touches.py`),
  **Health** (`HealthTab`: mỗi đội có ổn không; `GET .../ai/team/health`; `services/ai/health.py`) và **Resources** (`ResourcesTab`: máy,
  các run đang chạy trên nó và giới hạn; `GET /projects/{id}/ai/resources`; `services/ai/resources.py`). Các tab này chỉ
  hiện số liệu; board không chặn AI vì chúng.
- **Docs AI đã quay lại** (KBM-24, KBM-38): menu AI trên trang, Ask, kiểm tra trang, sức khoẻ Docs (`services/docs_ai/health.py`, màn `DocsHealthView`), Send to AI (`services/docs_ai/handoff.py`: gửi bình luận của trang tới AI của ticket), dọn trang (`tidy.py`). Chúng chạy
  trên `services/assistant/` và `docs_ai/jobs.py`; không có `proposals` hay lớp `access` riêng (mọi trang AI đọc được là trang người đọc được).
- **Trạng thái "Rate-limited" của đội** (KBM-39): một run kết thúc vì giới hạn gói (429, `stop_code="rate_limited"`) đặt `health =
  "rate_limited"` cho đội (`teams.note_run_outcome`, gọi trong `runs._end`); run kế tiếp kết thúc `finished` xoá nó. Đội vẫn nhận ticket
  và xếp hàng; hàng của đội hiện nhãn "Rate-limited".
- **Tiền chỉ hiện khi run báo chi phí thật**; run dùng gói thuê bao (không đo) hiện "Not metered". Hàng đội ở Members và trang đội dùng cùng
  luật này (KBM-39). Không có tầng duyệt trong v2.
- Chat `+` có biểu tượng cho mục menu; thẻ History có đồng hồ (`0e1cddde`).

### 11.5 Nơi lưu file và thứ ngoài AI

- **Thư mục uploads** tìm theo thứ tự: `KANBAN_UPLOADS_DIR`, `data_folder` trong config, thư mục của `KANBAN_DB_PATH`, `uploads_dir` do
  app desktop ghi vào config lúc khởi động, rồi `server/uploads` cạnh code (kèm cảnh báo và `stored_in` trong kết quả đính kèm) (KBM-18,
  `34cdd4c3`, `17a7b02d`). Nguyên nhân gốc: phiên MCP stdio của AI ngoài app lưu file vào worktree của nó chứ không vào thư mục app
  phục vụ.
- Xem trước file: PowerPoint, PDF, Excel được vẽ như chúng hiện (`8b0dcef8`, `0902f491`, `132e1e8a`, gộp qua `75cdcc94`). Không thuộc
  AI, nằm trong cùng PR.

### 11.6 Còn mở và chưa kiểm

- Tất cả mục trên được đối chiếu với code ở đầu nhánh, **không** chạy lại test (vòng này không chạy pytest hay vitest theo yêu cầu
  của người dùng). Test cũ có thể còn đòi hành vi cũ (`test_mcp_tool_quality`, `test_ai_launch_v2`, thứ tự thư mục uploads).
- Các run thật bằng Haiku và Sonnet đã chạy trên bảng tạm cho chat, bình luận đóng và thông báo; **chưa** đo số request mỗi giây với
  3 run cùng lúc, **chưa** thử hook trên Windows, **chưa** kiểm bản đóng gói PyInstaller chạy `--runner`.
- Giới hạn độ sâu chuỗi AI gửi AI (mục 4.3) **có**: `MAX_DEPTH = 3` ở `services/ai/runs.py`. Mỗi run giữ `depth` (cột `ai_run.depth`,
  migration `f7b9d1e3a5c7`, KBM-24); một tin do AI gửi (`ai_run message`, Board AI chuyển thread Docs, đội của ticket nhắn một trang) mở
  run sâu hơn một bậc, và ở độ sâu 3 tin bị từ chối ("Too many hand-offs between AIs"). Người mở run thì độ sâu là 0.
- Các mục "Còn mở" ở mục 9 khác (hai tài khoản có nhắn nhau không, `--permission-mode auto` chặn gì, đưa trả lời của subagent vào lượt
  kế của lead, `--bg`) chưa được thử lại.
