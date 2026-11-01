# Kế hoạch implement AI cho Claude Code CLI

Đi kèm [`ai-claude-code-plan.md`](ai-claude-code-plan.md) (quyết định D1–D26) và ba đợt thiết kế:
[`ai-operations`](../../design/screens/ai-operations.md) (đợt 1), [`ai-team-process`](../../design/screens/ai-team-process.md) (đợt 2),
[`ai-board-wave3`](../../design/screens/ai-board-wave3.md) (đợt 3). Viết ngày 2026-11-02, sau khi khảo sát code trên `main` (3.19.0, đã có
trung tâm thông báo của #251).

**Trạng thái (2026-11-02):** cả 9 giai đoạn đã làm trong một PR (người dùng yêu cầu một PR). Kết quả thử nghiệm S1–S6 ở mục 4 của
`ai-claude-code-plan.md`. Lệch so với kế hoạch: per-run config (4b) là một công tắc project (`per_run_config`), tự bật khi dùng worktree;
gửi tin nhắn trực tiếp (6c) là công tắc `live_messages`; Board AI "làm luôn theo mức" (D23) mặc định bật, tắt được trong cài đặt.

## 1. Hiện trạng code liên quan (khảo sát 2026-11-02)

| Mảng | Chỗ trong code | Điều quan trọng cho kế hoạch |
|---|---|---|
| Chạy CLI | `services/ai/cli.py` `claude_args` (:830), `runs.py` `_execute_cli_held` (:1754) | Prompt truyền bằng `-p`; system prompt qua `--append-system-prompt` (đã đổi thành file khi dài). Stream đọc từng dòng; `parse_stream_line` (:698) không nhận diện `Skill`/`Task` |
| Bước của run | `runs.py` `_append_now` (:1162) | `AiRun.steps` là JSON, **chỉ giữ 400 bước cuối**, output lệnh cắt 4000 ký tự. Không có transcript. Không xoá run cũ |
| Hàng chờ | `runs.py` `tick` (:808), `_blocking_reason` (:699) | Giới hạn song song (:743, :765) **chỉ áp cho `api_key`**; CLI không có giới hạn theo member/project/tài khoản |
| Treo | `runs.py` vòng đọc (:2069) | Chỉ timeout lúc khởi động (4 × 30 s). Sau đó CLI im lặng thì chờ mãi; `last_output_at` có ghi nhưng không ai đọc; `limit_min` không được áp |
| Lỗi | `cli.py` `_RATE_LIMITED` (:288), `rate_limit_wait` (:355); `runs.py` `requeue_rate_limited` (:967), `_memory_breach` (:2272), `resume_interrupted` (:527) | Chạm khung giờ = xếp lại tối đa 3 lần (bị đếm như lỗi). Mất mạng/5xx/crash: run hỏng luôn. Auto-trip bỏ qua member CLI |
| Thư mục làm việc | `runs.py` :1792 (`profile.working_dir`); `services/git_repo.py` `add_worktree` (:141) | Mọi run của một member dùng chung một thư mục. Worktree đã có cho người (project `worktree_template`), chưa dùng cho AI |
| Cấu hình member | `config_sync.py` `desired_specs` (:186), `config_service.sync_for_run` (:357) | Board ghi CLAUDE.md, `.claude/skills|agents|settings.json`, `.mcp.json` vào thư mục; merge 3 chiều; xung đột thì run không chạy |
| Prompt | `runs.py` :1395–1470, `context.py` `rules_block` (:316) | Chỉ dẫn của project chỉ vào prompt với provider khác Claude Code; với Claude Code nằm trong CLAUDE.md. Không có khái niệm trí nhớ/bài học |
| Handoff | `runs.py` `record_handoff` (:3994) | **Ghi đè `ticket.assignee`**; ticket không có ô Reviewer |
| Hướng dẫn MCP | `kanban_mcp/instructions.py` :50 | Nói mention "does NOT wake" AI, sai với run (`mentions.from_ai_comment` có đánh thức) |
| Thông báo | `services/notifications.py`: `KINDS` (:59), `emit` (:716), `reconcile` (:1240), `_actions` (:1775) | Thêm một loại Needs you = 4 chỗ: `KINDS`, `_why_closed_by_kind`, `_actions`, xử lý nút ở `useNotificationActions.ts`. `/notifications/log` có sẵn; chưa có `wait` |
| Board AI | `services/ai/assist/drafts.py` (`apply` :1537, `undo` :1619), `assist/health.py` `compute` (:80) | Nháp + Apply + Undo theo nháp. Insight là hàm thuần chạy hằng ngày. Chưa có engine luật |
| Hoàn tác run | `approvals.py` `revert_run` (:937–1050) | Dựa trên audit; tách biệt với undo nháp |
| Tìm kiếm | `services/docs_search.py` (`docs_fts`) | FTS5 do code app tự đồng bộ, có đường lui LIKE |
| Migration | `server/alembic/versions/`, head `a1b2c3d4e5f7` (notifications) | Chạy `upgrade head` khi khởi động |

## 2. Nguyên tắc chia việc

- **Mỗi giai đoạn là một issue và một PR.** Giai đoạn lớn thì chia thành nhiều PR nối tiếp (a, b, c). Mỗi PR chạy được một mình, có migration riêng,
  test, mục `## [Unreleased]` trong CHANGELOG, không bump version; giao diện thì kèm PDF demo như #253.
- **`runs.py` là nút thắt:** giai đoạn 1, 2, 4 và 6 đều sửa nó. Các PR đụng `runs.py` đi **lần lượt**, không song song. Việc chạy song song được:
  sửa hướng dẫn MCP, kho kiến thức (8a), bộ đánh giá (8c), phần giao diện thuần.
- **Migration nối tiếp:** mỗi PR rebase lên `main` trước khi merge để migration của nó trỏ đúng head, tránh hai head.
- **Theo thiết kế, không tự nghĩ thêm:** mỗi PR ghi rõ mục thiết kế nó làm (ví dụ "đợt 1, C và D"); chỗ thiết kế để ngỏ ("What the build still has to settle")
  thì làm bản đơn giản nhất và ghi trong PR.

## 3. Các giai đoạn

### Giai đoạn 0 — Thử nghiệm (S1–S6), không có code sản phẩm

Chạy Claude Code 2.1.316 thật, bằng Haiku, trong một thư mục nháp; ghi kết quả vào mục 4 của `ai-claude-code-plan.md`.

| Thử | Quyết định nó mở khoá | Nếu thất bại |
|---|---|---|
| S1 skill qua `--plugin-dir` dùng được trong `-p` | Giai đoạn 4b, 5 | Giữ cách ghi `.claude/skills` vào worktree (worktree riêng mỗi ticket nên không còn đụng nhau) |
| S2 `--resume` với danh sách plugin khác | Đổi plugin có phải bắt đầu hội thoại mới | Mặc định bắt đầu mới khi danh sách đổi (thiết kế đã giả định vậy) |
| S3 hook trong plugin có chạy | Hook theo member | Hook vẫn đi qua `--settings` |
| S4 thời gian khởi động với 5–10 plugin | Giới hạn số plugin mặc định | Cảnh báo trên trang member |
| S5 đọc quota còn lại | Thanh quota là số thật hay ước tính | Giữ ước tính có ghi nhãn (thiết kế đã vẽ) |
| S6 tin nhắn qua `--input-format stream-json` khi đang chạy | Giai đoạn 6c (gửi cho AI đang chạy), nút "nhắn AI" trong chẩn đoán treo | Ẩn nút; tin nhắn vào lượt kế tiếp |

### Giai đoạn 1 — Lưu log của board (đợt 1: F, G) — **làm trước tiên**

Lý do đưa lên đầu: Claude Code xoá transcript sau ~30 ngày, mỗi ngày chờ là mất dữ liệu; và chẩn đoán treo ở giai đoạn 2 cần đọc các bước cuối đầy đủ.

- **1a. Ghi transcript (chỉ server).** Mỗi sự kiện stream ghi nối vào `<data>/runs/<yyyy-mm>/<run_id>.jsonl` trong lúc chạy, nén `.gz` khi run kết thúc.
  Ghi cả prompt đã gửi (system + user), tin nhắn người gửi giữa chừng. Che bí mật bằng bộ che đang dùng cho `steps`. Bảng mới `AiRunTranscript`
  (run, đường dẫn, kích thước, số sự kiện, `pinned`, `expires_at`). Nhận diện `Skill`/`Task` trong `parse_stream_line` → bảng đếm `AiSkillUse`.
  Hạn lưu: dùng chung cài đặt 90 ngày của thông báo; tóm tắt run (`AiRun`) giữ mãi; dọn trong `_housekeeping`.
- **1b. Tìm và xem.** FTS5 `ai_run_fts` (tóm tắt, câu hỏi/trả lời, comment của AI, tên tool, đường dẫn file, lỗi), đồng bộ bằng code như `docs_search`.
  API lịch sử run có lọc (project, member, ticket, thời gian, trạng thái, skill). Giao diện: lịch sử run (F), màn chi tiết run "nó được đưa gì / đã làm gì" (G),
  ghim run, xuất Markdown/JSON.

### Giai đoạn 2 — Độ bền (đợt 1: C, D, E; plan mục 8 "Độ bền", "AI treo")

- **2a. Giới hạn song song cho CLI.** Theo tài khoản Claude (mặc định 2, chỉnh được) và theo project; xếp hàng theo ưu tiên ticket. Sửa `_blocking_reason`
  để áp cho mọi kết nối; hiện lý do chờ.
- **2b. Lỗi theo loại** (bảng C5 của thiết kế):
  - chạm khung giờ = **giữ**, không đếm lần thử, không hỏng run; ghi giờ mở lại theo tài khoản; ticket High/Urgent chuyển sang tài khoản còn chỗ;
  - mất mạng / 5xx: thử lại bằng `--resume` sau 30 giây, 2 phút, 10 phút;
  - CLI crash: chạy tiếp một lần, lần hai đọc stderr rồi vào Needs you;
  - compact lỗi: hội thoại mới kèm ghi chú bàn giao;
  - đăng nhập lại: tự chạy tiếp các run đang giữ;
  - app/máy khởi động lại: chạy tiếp **mọi** run bị ngắt;
  - không làm hai lần: bỏ qua thao tác MCP trùng hệt từ cùng run trong khoảng ngắn.
- **2c. Treo: phát hiện → chẩn đoán → xử lý.** Watchdog dựa trên `last_output_at`, CPU và RAM (từ `resources.MON`) và lời gọi tool đang mở. Chẩn đoán bằng code
  trước (lệnh server ở tiền cảnh, lệnh chờ bàn phím, tool MCP mở quá 15 phút, build vẫn ra output), Haiku chỉ khi code không kết luận được.
  Xử lý: chờ thêm, dừng đúng tiến trình con, chạy tiếp bằng `--resume` kèm ghi chú (hội thoại mới nếu file phiên đã mất hoặc trí nhớ/cấu hình đã đổi),
  hoặc vào Needs you. `AiRun.diagnosis` (JSON: kết luận, đã thử gì, lúc nào): **một bản**, hiện ở run, ở Needs you và trong thông báo.
- **2d. Needs you.** Thêm các loại thông báo: `board_fault`, `run_stuck`, `run_stopped`, `merge_conflict` (dùng ở giai đoạn 4), `waiting_arbitration`
  (giai đoạn 6), mỗi loại có điều kiện tự đóng trong `reconcile` và bộ nút theo bảng "Which rows get which actions" (Thử lại / Chạy tiếp kèm ghi chú /
  Giao AI khác / Huỷ). Sáu bộ lọc của Needs you.
- **2e. Việc nhỏ đi kèm.** Sửa `kanban_mcp/instructions.py` (mention trong run có đánh thức AI; nhắc `ai_run(handoff)`); bản desktop có tuỳ chọn
  "giữ máy thức khi AI đang chạy" (`powerSaveBlocker`); thanh quota theo tài khoản (E), có nhãn "ước tính" nếu S5 không tìm được nguồn thật.

### Giai đoạn 3 — Kiến thức dự án: chỉ dẫn và trí nhớ (đợt 1: H)

- Chỉ dẫn cấp project (một văn bản) và bài học (mỗi bài một hàng: nội dung, ticket nguồn, số lần dùng, ai giữ).
- Cuối mỗi ticket, Haiku đọc transcript (giai đoạn 1) để **đề xuất** bài học; không thêm gì nếu người không giữ. Lần treo ở giai đoạn 2c cũng đề xuất bài học.
- Đưa vào run qua `--append-system-prompt-file`, cùng với persona và luật board. Khối CLAUDE.md board đang ghi vào thư mục **ngừng ghi** cho phần chỉ dẫn;
  bước chuyển đổi một lần gỡ khối cũ (không đụng phần người viết).
- Ước lượng token của prompt nền hiện trên thẻ member ("base prompt 3,140 tokens", đợt 2 B).

### Giai đoạn 4 — Worktree theo ticket và bàn giao code (đợt 1: I, J, K)

- **4a. Worktree.** Mỗi ticket một worktree **cạnh** repo (`~/code/kanban.worktrees/<KEY>`), nhánh `ai/<KEY>-<slug>`, cổng riêng, lệnh chuẩn bị của project.
  Bảng `AiWorktree` (ticket, đường dẫn, nhánh, cổng, trạng thái); dung lượng và "còn thay đổi chưa commit" đọc từ git khi cần. Không xoá khi còn thay đổi.
  Thư mục không phải git: dùng chung như cũ + cảnh báo. Dùng lại `git_repo.add_worktree`.
- **4b. Cấu hình theo run (D5), sau S1–S4.** Skill/agent/hook/quyền đi qua `--plugin-dir`, `--agents`, `--settings` thay vì ghi vào thư mục.
  Bước chuyển đổi một lần cho `.claude/skills` cũ (liệt kê, đề nghị gỡ, cảnh báo run kế tiếp là hội thoại mới).
- **4c. Bàn giao.** Cài đặt project: mở PR / merge trên máy / để nguyên nhánh, tự đoán mặc định. Merge chỉ khi người kích hoạt; xung đột thì
  quay lại sạch và tạo Needs you `merge_conflict` ("Giao AI xử lý" / "Tự xử lý").

### Giai đoạn 5 — Skills & plugins, role pack, bộ quét repo (đợt 2: B, C, D)

- **5a. Plugin.** Plugin như một loại mục bên cạnh thư viện hiện có: nguồn (git, marketplace, thư mục), commit, version, ghim, các skill bên trong.
  Trang Skills & plugins (Gợi ý theo vai / Thêm từ nguồn / Đã cài), Reload / Reset / Gỡ, số lần dùng thật từ `AiSkillUse` (giai đoạn 1a).
- **5b. Role pack.** Thay `memberPresets.json` bằng pack (persona, model + effort, đồ nghề, quyền + trạng thái tối đa, phạm vi ghi, phải nộp gì, giới hạn);
  bốn preset cũ thành bốn pack đầu, thêm Triage, BA, Designer, User tester (persona, Playwright MCP, trình duyệt riêng mỗi run). Export/import.
- **5c. Bộ quét repo.** Quét máy móc → AI nhẹ đề xuất → chạy thử lệnh chuẩn bị + test trong worktree nháp → người duyệt một màn → bấm Create mới tạo.

### Giai đoạn 6 — Quy trình và đội (đợt 2: E–L)

- **6a. Quy trình.** Mẫu quy trình có version (4 mẫu dựng sẵn + trình chỉnh sửa); quy trình trên ticket, mỗi bước một hàng (không bao giờ ghi đè);
  assignee = người đang cầm bóng, đặt theo bước; `record_handoff` đổi thành "sang bước kế". Bước **Checks** chạy bằng code (test, lint, build) trước mọi AI review.
  Bước gọi theo vai, chọn member rảnh, ưu tiên member đã làm ticket đó. Người chỉ duyệt hai lần (thiết kế và bước cuối).
- **6b. Review và phân xử.** Mức review Nhẹ / Chuẩn / Sâu (Triage chọn, người đổi; tự nâng chỉ khi Triage chọn). Phát hiện "không tiến triển"
  (đổi chiều 3 lần và diff đổi dưới 5%, hoặc lặp lại phản đối cũ) → PM phân xử (một run có ghim) → lần hai tới người, kèm phán quyết. Ba trạng thái dừng.
  Bằng chứng TDD: cặp run đỏ/xanh ghép theo lệnh, file, tên test và lý do lỗi (chỉ tính lỗi assertion).
- **6c. Can thiệp giữa chừng (sau S6).** Ô "Gửi cho AI" trên ticket và trong khung run; chạy CLI bằng `--input-format stream-json`.
- Chỉ số theo mẫu quy trình (L) và bộ lọc theo vai (K).

### Giai đoạn 7 — Board AI hành động thay người dùng (đợt 3: A–H)

- **7a. Ba mức và hoàn tác.** Bảng mức của mọi hành động trong code, có cờ khoá do server kiểm; bỏ nguyên tắc "chỉ nháp" ở 10 chỗ đợt 3 B liệt kê.
  Nhóm thao tác có thao tác ngược (mở rộng cách `drafts.undo` đang làm), ghi audit "bạn, qua Board AI". Quá 3 ticket hoặc nhiều project = hỏi trước.
- **7b. Tín hiệu.** Năm tín hiệu mới (AI treo, run lỗi liên tiếp, quota gần chạm, hàng chờ dài, chờ phân xử) chạy bằng code cạnh `assist/health.py`.
- **7c. Lệnh thường trực.** Luật viết bằng lời → luật có cấu trúc → chạy thử (chỉ ghi "lẽ ra") → bật. Chỉ được làm việc ở mức giữa (server từ chối việc khác);
  mỗi lần chạy có nhóm Hoàn tác; giới hạn tần suất; Pause all dừng cả luật. Vòng lặp mới trong `main.py` cạnh schedules/autopilot.

### Giai đoạn 8 — Mở rộng (đợt 3: I, J, K)

- **8a. Kho kiến thức.** Tải lên → text (PDF, ảnh được Haiku mô tả một lần) → tóm tắt + từ khoá → FTS5 → ba tool MCP `knowledge_index/search/read`.
  Kho theo project + kho chung; trang Docs riêng tư không lộ qua kho chung; nội dung tải lên được rào như dữ liệu không tin cậy. Không embedding.
- **8b. GitHub.** Chỉ PR do board mở; hỏi `gh` 5 phút một lần khi PR còn mở; CI đỏ (kiểm với nhánh gốc trước) và comment review → run của Dev trên worktree;
  push vào nhánh của PR đó và trả lời thread của nó không cần hỏi.
- **8c. Đánh giá đội AI.** Project sandbox + repo mẫu cố định, 7 bộ bài, Haiku là chính, điểm theo thời gian.
- Lệnh `wait` cho AI bên ngoài (đọc `/notifications/log`, chờ tới khi có sự kiện) có thể làm bất cứ lúc nào.

## 4. Thứ tự, phụ thuộc và cách chạy

```
0 thử nghiệm ──────────────┬──────────────► 4b, 5, 6c
1a transcript ─► 1b tìm/xem │
1a ─► 2a ─► 2b ─► 2c ─► 2d ─┴► 3 trí nhớ ─► 4a ─► 4c ─► 5 ─► 6a ─► 6b ─► 7a ─► 7b ─► 7c
2e, 8a, 8c, wait: song song bất cứ lúc nào (không đụng runs.py)
```

- Mốc 1 (dùng được hằng ngày): 1a, 2a, 2b, 2c, 2d, 2e. Mốc 2: 1b, 3, 4. Mốc 3: 5, 6. Mốc 4: 7, 8.
- Mỗi issue theo khuôn của #253: mục tiêu, thiết kế nào là đặc tả, các quyết định đã chốt, phạm vi, trạng thái cần có, test, demo, tự review bằng
  subagent trước khi nhờ review, không bump version.

## 5. Rủi ro

- **Dung lượng transcript:** con số 2,1 GB trong thiết kế là ước tính. Đo sau 1a một tuần; nếu lớn hơn nhiều thì giảm hạn lưu mặc định, không bỏ tính năng.
- **Đổi cách chạy CLI (S6):** chuyển từ `-p` sang `stream-json` đụng toàn bộ vòng đọc của `runs.py`; để riêng ở 6c, sau khi 2c đã ổn định.
- **Ngừng ghi CLAUDE.md và `.claude/skills`:** người dùng có thể đã sửa các file này; bước chuyển đổi phải chỉ gỡ phần board viết (đã có `AiConfigState.files`
  làm gốc so sánh).
- **Bỏ "chỉ nháp" của Board AI** là thay đổi lớn về an toàn: cờ khoá phải do server kiểm, có test cho từng hành động bị khoá.
