# AI v2: đội AI trên Claude Code, điều phối bởi Claude Code

Tài liệu thiết kế cho đợt **refactor hoàn toàn** phần AI (đội AI, Docs AI, Idea AI, Board AI, lịch chạy). Thay cho phần kiến trúc
của [`ai-claude-code-plan.md`](ai-claude-code-plan.md); các quyết định cũ còn giữ được liệt kê ở mục 10. Quyết định chốt ngày
2026-11-04 và 2026-11-05. Mỗi khi chốt thêm, cập nhật ở đây.

- **Phạm vi:** chỉ Claude Code CLI. Antigravity, API key và các provider khác bị bỏ khỏi v2 (code cũ giữ trong git).
- **Người dùng ở gói subscription:** tối ưu cho quota, không phải tiền.
- **"Ngon" hay không do người dùng đánh giá.** Không có bộ bài kiểm tra tự động trong v2.
- **Không cờ sống chung:** v2 thay hẳn đường cũ. Có git.

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

Báo cáo cuối của run bằng `--json-schema` (trạng thái, tóm tắt, nhánh, PR, việc dở, bài học đề xuất). Hết bóc text.

### 4.6 Memory (kiểu b, board sở hữu)

Ba lớp của D18 giữ nguyên: chỉ dẫn project (luôn trong prompt), **bài học** (ngắn, người sửa được, nạp vào prompt), kho kiến thức
(tool tìm khi cần, không embedding mặc định). Bài học do lead đề xuất trong JSON báo cáo cuối (hoặc tool `remember`), người duyệt
hoặc tự nhận theo cài đặt project, có giới hạn độ dài. Dùng `--system-prompt-snapshot off` để bài học mới nạp được vào ticket đang
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
  phần đã có trong `ai-provider-config`); trang memory của project; cây tiến trình trong run. Làm từ `design/source/*.dc.html`.

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
- Cách tắt plugin đã đồng bộ của tài khoản trong run của board (hiện nạp 7 plugin vào mọi run).
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
