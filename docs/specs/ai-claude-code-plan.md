# Kế hoạch AI cho Claude Code CLI: quyết định, câu hỏi, thiết kế

Tài liệu làm việc của đợt thảo luận về AI (điều phối, quy trình, skill/plugin, Board AI). **Chưa implement gì.**
Mỗi khi chốt thêm một điểm, cập nhật mục Quyết định; khi một câu hỏi được trả lời, chuyển nó lên Quyết định.

- **Phạm vi:** chỉ AI member dùng **Claude Code CLI**. Provider khác (API key, Antigravity…) làm sau, theo cùng khuôn.
- **Bối cảnh:** người dùng dùng **gói subscription**, nên tối ưu cho **quota theo khung giờ/tuần**, không phải cho tiền.
  Con số đô la trên board chỉ là ước tính.
- **Liên quan:** thiết kế thông báo (PR #251), issue thông báo (#253).

## 1. Hiện trạng (khảo sát code, 2026-11-01)

| Mảng | Đã có | Yếu / thiếu |
|---|---|---|
| Chạy CLI | `claude -p … --output-format stream-json`, `--mcp-config --strict-mcp-config`, `--append-system-prompt`, `--resume`, model/effort theo member (`server/services/ai/cli.py`, `runs.py`) | Không có giới hạn thời gian hay phát hiện treo ("no time limit", `runs.py`) |
| Skill/plugin | Ghi CLAUDE.md, `.claude/skills`, `.claude/agents`, `.mcp.json`, hooks vào thư mục làm việc của member, có merge 3 chiều (`config_sync.py`); thư viện dùng chung có version (`library.py`) | Không cài được từ internet; không biết skill có được dùng (stream không nhận diện tool `Skill`/`Task`); các member **dùng chung thư mục** nên skill không tách theo member |
| Pack | 4 preset PM, Dev, Reviewer, QA (`ui/src/components/ai/memberPresets.json`); mẫu quyền developer/reviewer/read_only (`permissions.py`) | TDD/QA chỉ là lời dặn trong persona; không có Designer, BA, User tester; không export/import |
| Điều phối | Handoff, report back, mention có chặn vòng lặp, Autopilot (trả lời phê duyệt bị bỏ quên), lịch chạy có vòng worker + reviewer | Không có khái niệm quy trình; **không giới hạn số run song song cho CLI** (chỉ áp cho API key); model cố định theo member |
| Ticket | `created_by`, `assignee` | Không có vai review/test; handoff **ghi đè assignee** |
| Tool MCP | Gần đủ: ticket, comment, mention (có đánh thức), workspace, Docs/diagram/sketch/canvas, branch, hỏi người, báo cáo | Không có tool đính kèm file; `ai_team(ask)` bị chặn trong run; `instructions.py` nói mention qua MCP không đánh thức AI, sai với hành vi trong run |
| Phục hồi | Rate limit xếp lại 3 lần; tài khoản đăng xuất thì giữ member; giới hạn RAM khởi động lại 2 lần; app khởi động lại thì tạo lại run 1 lần; auto-trip; Pause all | CLI crash/mất mạng không tự thử lại; không có hàng chờ "cần người" |
| Board AI | Mặc định chỉ đề xuất nháp; chế độ tool dùng **quyền của member**, không phải của người dùng | Không dừng/tạm dừng AI, không tạo member, không dùng lịch chạy, không đọc log ngoài phần chỉ đọc |
| Log | Mỗi run lưu bước, file đổi, báo cáo, token/chi phí; audit nối chuỗi hash | Transcript chỉ nằm trong file phiên của CLI; run không có hạn lưu; không tìm kiếm lịch sử |

CLI trên máy người dùng: **Claude Code 2.1.316**. Có sẵn các flag cấu hình theo từng run: `--plugin-dir` (lặp được, thư mục hoặc .zip),
`--plugin-url`, `--agents <json>`, `--settings <json>`, `--setting-sources`, `--append-system-prompt-file`.
`--bare` chỉ nhận API key nên không dùng được với subscription. System prompt được ghi ở request đầu và dùng lại khi `--resume` cho tới khi compact.

## 2. Quyết định đã chốt

**Skill và plugin**
- D1. Cài từ internet (git URL, marketplace của Claude Code, thư mục trên máy) **không cần bước duyệt**; người cài tự chịu rủi ro.
  Board vẫn ghi nguồn + commit, cho xem đã đổi gì khi cập nhật, và quay về bản trước bằng một nút.
- D2. Có **catalog gợi ý theo vai trò**. Designer: plugin `design` của Anthropic (design-handoff, design-critique, accessibility-review,
  ux-copy, design-system, user-research, research-synthesis), `ui-ux-pro-max` (repo gốc `nextlevelbuilder/ui-ux-pro-max-skill`),
  `frontend-design`, `canvas-design`, `webapp-testing` (repo `anthropics/skills`), Figma MCP.
- D3. Trang **Skills & plugins** theo project: tab Gợi ý / Thêm từ nguồn / Đã cài. Mỗi mục: bật/tắt theo member hoặc mặc định project,
  cập nhật, ghim version, reset, reload (có hiệu lực từ run kế tiếp), gỡ, thống kê số lần được dùng thật. Member có công tắc riêng.

**Nơi làm việc và cấu hình**
- D4. **Mỗi ticket một git worktree** trên nhánh riêng (`ai/<KEY>-<slug>`), đường dẫn cố định để `--resume` hoạt động. Dev, Reviewer, QA… của cùng
  ticket dùng chung worktree đó, lần lượt. Có lệnh chuẩn bị cho mỗi project (`npm ci`, `uv sync`), cổng riêng cho mỗi worktree. Không xoá khi còn
  thay đổi chưa commit. Vai không gắn ticket (Board AI, Triage) đọc ở thư mục gốc. Thư mục không phải git thì quay về dùng chung + cảnh báo.
- D5. **Mỗi run nạp "túi đồ nghề" của member qua flag CLI**, không ghi vào repo: skill/hook đóng gói thành plugin cục bộ của member (`--plugin-dir`),
  plugin catalog từ bộ nhớ đệm chung (`--plugin-dir`), subagent (`--agents`), quyền/hook (`--settings`), persona + luật board
  (`--append-system-prompt-file`), MCP (`--mcp-config --strict-mcp-config`). Khối CLAUDE.md board đang ghi vào thư mục chuyển sang system prompt.
  Danh sách skill/plugin đưa vào "bản tóm tắt cấu hình" để đổi thì bắt đầu hội thoại mới.

**Bàn giao code**
- D6. Cài đặt theo project: **mở PR** / **merge trên máy** / **để nguyên nhánh**. Mặc định tự đoán: có remote GitHub + `gh` đã đăng nhập → PR (nháp,
  khi sang Review); không có remote → merge trên máy; remote không phải GitHub → đẩy nhánh, người tự mở merge request.
- D7. Merge trên máy chỉ khi **người kích hoạt** (sang Done hoặc nút Merge); không merge khi thư mục chính có thay đổi chưa commit; xung đột thì không
  để dở, hiện "Giao AI xử lý xung đột" / "Tự xử lý"; merge xong thì dọn worktree.

**Quy trình và vai trò**
- D8. **Ticket gắn với một quy trình.** Triage tự chọn theo loại và nhãn, người đổi được; board tự chuyển qua các bước. Giao thẳng cho một AI vẫn giữ cho việc lẻ.
- D9. **Mẫu quy trình dựng sẵn đã tối ưu, cho phép tuỳ chỉnh và tạo mới.** Dựng sẵn: Sửa lỗi nhanh, Tính năng chuẩn, Tính năng có giao diện, Nghiên cứu.
  Nguyên tắc: ít bước, chỉ tách ở ranh giới context; người kiểm tra độc lập, nhận diff + tiêu chí + ghi chú bàn giao, không nhận transcript;
  kiểm tra máy móc (test, proof) trước AI review.
- D10. **Người chỉ duyệt ở bước thiết kế và bước cuối (Done).**
- D11. **Không giới hạn số vòng làm lại.** Chỉ dừng khi: không tiến triển (Reviewer nêu lại đúng lỗi cũ, hoặc diff gần như không đổi), lỗi từ tool
  kanban, hoặc chạm quota tối đa của ticket nếu người dùng bật (mặc định tắt). Người dùng xác nhận cả ba.
  "Lỗi tool" = lỗi phía board/môi trường, không phải AI gọi sai: MCP không trả lời hoặc lỗi 5xx/exception, token run bị thu hồi/hết hạn,
  cấu hình làm bước bắt buộc không thể xong (ví dụ Reviewer bị cấm chạy test), worktree/git hỏng (tạo không được, lệnh chuẩn bị lỗi, repo kẹt
  giữa merge), trùng cổng. Lỗi do AI gọi sai tham số (lỗi validate) thì AI tự sửa, không tính. Lỗi phía board: thử lại có backoff, vẫn lỗi
  thì dừng, vào hàng chờ cần người, ghi rõ "lỗi của board" kèm chẩn đoán.
- D12. **Bế tắc thì chuyển lên điều phối:** Dev ↔ Reviewer → AI điều phối (pack PM hoặc AI cấp board, chọn trong cài đặt project; độc lập; Opus high)
  phân xử (theo Reviewer / theo Dev / tách ticket) → vẫn bế tắc hoặc điều phối không quyết được → người dùng. Đổi tiêu chí chấp nhận chỉ được *đề xuất*,
  và được đánh dấu ở bước duyệt cuối.
- D13. **AI Reviewer luôn có**, mức theo ticket: Nhẹ / Chuẩn / Sâu, Triage chọn theo độ lớn thay đổi, nhãn rủi ro, loại ticket; người đổi được.
- D14. **Vai trò theo bước hiện trên ticket** (ví dụ "Dev: Dev An ✓ · Review: Reviewer Rin (đang làm)"); assignee = "ai đang cầm bóng", tự đổi theo bước;
  handoff = sang bước kế, không ghi đè; việc lẻ có thêm ô "Người review" tuỳ chọn. Người dùng xác nhận.

**Pack**
- D15. Role pack gồm: danh tính/persona, model + effort, đồ nghề từ catalog, quyền + trạng thái tối đa, nơi làm việc (sửa / chỉ đọc), phải nộp gì, giới hạn.
  Dựng sẵn: Triage (Haiku), PM/BA, Dev (TDD), Reviewer, QA, User tester (chọn persona), Designer.
- D16. **User tester dùng Playwright MCP** mặc định (đọc cấu trúc trang, nhiều trình duyệt, giả lập điện thoại, có thể sinh test chạy lại).
  Chrome DevTools MCP vào catalog cho Dev khi debug hiệu năng/mạng. Mỗi run một trình duyệt và hồ sơ riêng, trỏ đúng cổng của worktree.

**Quota**
- D17. Tối ưu cho quota subscription: giới hạn số AI chạy cùng lúc theo tài khoản Claude; model theo bước (Haiku cho Triage, Sonnet mặc định, Opus khi
  thất bại hoặc ticket khó); chạy effort thấp trước, chỉ chạy lại phần trượt ở effort cao; gần chạm quota thì việc không gấp chờ khung giờ sau, việc gấp
  chuyển tài khoản còn dư.

**Chủ đề mới (đang bàn, hướng đã được người dùng ủng hộ)**
- D18. **Kiến thức dự án** gồm ba lớp:
  - (a) chỉ dẫn tuỳ chỉnh của project, luôn nằm trong prompt;
  - (b) trí nhớ / bài học AI rút ra sau mỗi ticket, ngắn, người sửa được, nạp vào prompt;
  - (c) kho kiến thức (text, file, code, ảnh…) được *tìm khi cần* qua một tool MCP. Người dùng ngại gửi tài liệu lên dịch vụ embedding,
    và embedding local thì chậm, nên hướng đề xuất là **không dùng embedding mặc định**: AI tự tìm (như với code) trên bản text + mục lục tóm tắt,
    kèm tìm từ khoá BM25. Embedding là tuỳ chọn bật sau.
  Chi tiết ở mục 8.
- D23. **Board AI có quyền của người dùng và tự làm theo mức rủi ro** (đảo nguyên tắc "chỉ nháp" của `ai-board-assistant`):
  - xem, tìm: làm luôn;
  - việc hoàn tác được (chuyển, giao, comment, tạm dừng một AI): làm luôn, kèm Hoàn tác;
  - việc khó quay lại (xoá, Pause all, tăng ngân sách, merge): hỏi trước.

  Người dùng xác nhận ("Claude Code mạnh, tin được").
- D19. **Bộ quét repo** khi tạo AI team cho project: quét máy móc trước, AI nhẹ đề xuất sau, chạy thử để xác nhận. Chi tiết ở mục 8.
- D20. **Can thiệp giữa chừng:** người gửi thêm yêu cầu cho AI đang chạy từ ô nhập trên ticket/run; và chat với "quản lý" (AI điều phối) để nó tự giao thêm
  việc hoặc nhắc các AI. CLI có `--input-format stream-json` (nhận tin nhắn liên tục khi đang chạy) và `--replay-user-messages` (xem S6).
- D21. **Gắn GitHub:** CI đỏ trên PR do board mở thì AI tự vào sửa; comment review trên PR thì AI tự xử lý. Cùng luật "không tiến triển" và quota.
- D22. **Đánh giá đội AI** bằng nhiều bộ bài kiểm tra: chức năng board, xử lý vấn đề, xử lý issue, làm đúng yêu cầu, hồi phục lỗi… Dùng model nhẹ để tiết kiệm.
  Chi tiết ở mục 8.

## 3. Câu hỏi còn mở

- Q1. ~~Điều kiện dừng vòng làm lại~~ → đã chốt ở D11.
- Q2. ~~Vai trò theo bước~~ → đã chốt ở D14.
- Q3. ~~Board AI tự làm theo mức rủi ro~~ → đã chốt ở D23.
- Q4. Board đọc quota còn lại của tài khoản ở chế độ headless bằng cách nào (có thể chỉ biết khi CLI báo chạm giới hạn kèm giờ mở lại).

## 4. Cần thử nghiệm trước khi làm

- S1. Skill nạp qua `--plugin-dir` có hiện và được dùng trong `-p` không.
- S2. `--resume` có chấp nhận khi danh sách `--plugin-dir` khác lần trước không.
- S3. Hook trong plugin nạp qua `--plugin-dir` có chạy không.
- S4. Thêm 5–10 plugin thì thời gian khởi động tăng bao nhiêu.
- S5. Cách đọc quota còn lại (Q4).
- S6. Tin nhắn gửi qua `--input-format stream-json` khi AI đang chạy được xử lý lúc nào: chen vào ngay, hay chờ hết lượt hiện tại. Phải đổi cách
  board chạy CLI (hiện truyền prompt bằng tham số `-p`).

## 5. Nhu cầu thiết kế

Đối chiếu với `design/screens/` trên `main` (2026-11-01): **có sẵn** / **sửa màn cũ** (mở rộng thiết kế đã có) / **màn mới**.
Tên mục trong ngoặc là mục của chính tài liệu thiết kế đó.

| # | Nhu cầu | Kết luận | Thiết kế hiện có liên quan, và phần còn thiếu |
|---|---|---|---|
| 1 | Trang Skills & plugins (catalog, thêm từ nguồn, đã cài, các nút) | Sửa màn cũ + phần mới | `ai-provider-config` E (thư viện dùng chung: tên, loại, version, "Used by N members"), B10 (thêm skill: thư viện / viết / import thư mục). Thiếu: plugin như một loại mục, catalog theo vai, git URL/marketplace, cột nguồn/commit, số lần dùng, mặc định project, Pin/Reset/Reload/Gỡ |
| 2 | Công tắc skill/plugin trên trang member | Sửa màn cũ | `ai-provider-config` B2 (công tắc mỗi skill), B4 (subagent). Thiếu plugin |
| 3 | Chip "đã dùng skill X" trong log run; thống kê | Màn mới (phần run) + sửa E1 | Màn chi tiết run chưa từng được thiết kế; thống kê thêm vào thư viện E1 |
| 4 | Ngân sách context của member | Sửa màn cũ | `ai-provider-config` B1 chỉ có "≈ 520 tokens" cho instructions; D1/D8 có tổng cho API agent. Thiếu tổng prompt nền cho Claude Code |
| 5 | Thư viện role pack, export/import | Màn mới | Các mảnh rời: persona/giới hạn (`ai-members` C), model/effort (`ai-provider-config` B7), subagent B4, MCP B3, export JSON cấu hình của một member F7 |
| 6 | Chọn persona cho User tester | Sửa màn cũ | `ai-members` C bước 3 chỉ có ô persona tự do |
| 7 | Bằng chứng TDD (đỏ → xanh) | Màn mới | Chỉ có "tests pass" (`ai-team` D) và roll-up test case trên thẻ Testing (`main-board` §7) |
| 8 | Danh sách và trình chỉnh sửa mẫu quy trình | Màn mới | Chưa có khái niệm |
| 9 | Quy trình trên ticket + tiến trình các bước | Màn mới | `ai-team` D (làn theo AI) là lịch sử run, không phải bước; cột board cố định (`main-board`) |
| 10 | Bước duyệt thiết kế (Canvas) | Màn mới | Phê duyệt chỉ có cho thao tác của AI (`ai-team-review` A) |
| 11 | Chip mức review | Màn mới | Review chỉ là cột + vòng trả về (`ai-team` E) |
| 12 | Trạng thái chờ phân xử; biên bản | Màn mới | `ai-safety-cost` G1 chặn chuỗi AI; quy tắc "Loop detected" đã bị bỏ ở D6 vì nó bắt *một* AI tự lặp trong run (CLI tự lo) và vòng AI-AI đã có giới hạn độ sâu chuỗi mention ở G. Vòng Dev ↔ Reviewer *theo quy trình* không đi qua mention nên chưa ai chặn: thêm phát hiện "không tiến triển" không mâu thuẫn |
| 13 | Vai trò theo bước, assignee "cầm bóng", ô Người review | Sửa màn cũ | `ai-team-review` C (một dòng hành trình AI trên trang ticket: PM, BA, DS, DV, TS, RV), `main-board` §7 (thẻ Review ghi người được nhờ review), `ai-team` A/C (handoff là đổi người cầm). Thiếu dấu xong/đang/chờ, assignee tự đổi theo bước, ô Người review |
| 14 | Bộ lọc "việc tôi cần review", "AI ở vai nào" | Sửa màn cũ | Thanh lọc `main-board` §2 (tìm, loại, ưu tiên, assignee); `ai-team` B "Now" (mỗi AI một thẻ). Thiếu vai |
| 15 | Chỉ số hiệu quả theo mẫu quy trình | Sửa màn cũ | `ai-team-review` B "Health" (tin cậy, tự chủ, tốc độ, chất lượng, chi phí; "$/ticket", "% trả về"). Thiếu theo mẫu, quota/ticket, số vòng, thời gian tới Review |
| 16 | Quota theo tài khoản, "chờ khung giờ sau", chuyển tài khoản | Sửa màn cũ | `ai-accounts` E3 ghi subscription "not metered"; `ai-safety-cost` C4 (giới hạn song song theo member/project), C5 (chip lý do chờ). Thiếu quota, giới hạn theo tài khoản, lý do khung giờ |
| 17 | Worktree: trạng thái, dung lượng, dọn; lệnh chuẩn bị, cổng | Sửa màn cũ + phần mới | `settings-structure` C trang "Repositories" (đường dẫn repo, mẫu worktree, worktree mặc định). Thiếu lệnh chuẩn bị, cổng, trạng thái trên ticket |
| 18 | Bàn giao code: PR / merge / xung đột; cài đặt | Màn mới | Nhánh chỉ hiện như một sản phẩm bàn giao (`ai-team` D/F) |
| 19 | Board AI có quyền người dùng, chia theo rủi ro; thêm quyền | **Sửa màn cũ, đổi nguyên tắc** | `ai-board-assistant` ghi bất biến "chỉ đề xuất nháp, Apply là thao tác ghi duy nhất". Tạo member có (J) nhưng là nháp; dừng AI chỉ dành cho người (`ai-safety-cost` D2–D4, `ai-paused`); lịch chạy, đọc log: không có |
| 20 | Độ bền: treo / đang thử lại / hàng chờ cần người | Sửa màn cũ + phần mới | `ai-resources` D (khởi động lại vì RAM, thẻ "Needs you"), `ai-safety-cost` D6 (auto-trip), `ai-accounts` E3. Thiếu treo, retry theo loại lỗi, hàng chờ chung |
| 21 | Log: tìm lịch sử run, "vì sao AI làm vậy", dòng thời gian người + AI | Một phần có sẵn | Dòng thời gian người + AI **đã có** (`ai-team` D, `ai-team-timeline` B). Thiếu tìm kiếm run, xem prompt và lời gọi tool |
| 22 | Thông báo: cần phân xử, chờ khung giờ, xung đột merge | Sửa màn cũ | Bảng kênh `ai-safety-cost` H1; thiết kế thông báo PR #251. Thêm 3 sự kiện |
| 23 | Model/effort theo bước, leo thang | Màn mới (trong #8) | Chỉ có theo member (`ai-provider-config` B7) |
| 24 | Kiến thức dự án: chỉ dẫn, xem/sửa bài học trong trí nhớ, kho kiến thức (tải lên, mục lục, kho chung) | Sửa màn cũ + màn mới | `ai-provider-config` B1 (Instructions: `CLAUDE.md` của project hoặc của user, ước lượng token, board chỉ ghi giữa marker `kanban:include`, đính snippet thư viện kiểu `commit-conventions@v3`), D1 (system prompt của API agent: biến `{{ticket}}` `{{project}}` `{{docs}}` `{{comments}}`, trần 8.000 token, có preview), D5 (Context sources: ticket, tối đa 3 doc liên kết, 20 comment cuối, sub-ticket, mỗi phần có ước lượng token), E1 (thư viện có tab Instructions, có version, "Used by N members"); `docs-ai` C (Ask the docs: trả lời kèm nguồn, phạm vi space / trang / mọi project); `ai-where-you-work` B (chat trên ticket "chỉ nhớ ticket này"). Thiếu: **chỉ dẫn ở cấp project** (hiện chỉ gắn vào `CLAUDE.md`/system prompt của từng member); **trí nhớ** (bài học AI tự rút ra, xem/sửa/xoá); **kho kiến thức** (tải file/ảnh/PDF, mục lục, kho riêng mỗi project + kho chung, tool tra cứu) |
| 25 | Bộ quét repo và màn hướng dẫn khởi tạo AI team | Màn mới | Mảnh gần nhất: `ai-members` C (stepper Add AI member, 5 bước, **mỗi lần một member**), F4 (empty state); `ai-safety-cost` I8 (First-time checklist), I7 (Workspace defaults editor), A1 (mẫu quyền Developer / Reviewer / Read-only / Custom); `ai-provider-config` F7 (import/export JSON), F8 (reset to defaults). Thiếu: toàn bộ bộ quét (lệnh test/lint/build, lệnh chuẩn bị worktree, cổng, quy trình mặc định, pack nên có, skill nên cài, cách bàn giao code), bước chạy thử để xác nhận, và màn một lượt để người duyệt cả cấu hình |
| 26 | Ô "Gửi cho AI" khi đang chạy; chat với quản lý | Sửa màn cũ + màn mới | `ai-team-timeline` D (inspector của một run có Pause / Open the run; inspector của câu hỏi có "Type an answer…" nhưng **chỉ trả lời câu AI hỏi**, không gửi yêu cầu mới); `ai-team-review` A (sửa ticket khi AI đang làm — Designer "saw the change and adjusted", cách nhắc gián tiếp duy nhất đang có); `ai-where-you-work` B (chat trên ticket, không tới AI đang chạy); `ai-board-assistant` toàn bộ là chat chỉ-nháp, và nói rõ Board AI "never assigns". Thiếu: ô gửi tin nhắn cho AI **đang chạy** (trên ticket và trong khung run), và chat với quản lý để nó tự giao việc (D20, D24) |
| 27 | GitHub: CI đỏ / comment review chuyển cho AI, trạng thái trên ticket | Màn mới | Gần như trắng: năm màn AI Team không nhắc PR, CI hay GitHub. Nhánh chỉ là nhãn chữ ("branch feat/cost-badge, 3 files, tests pass" — `ai-team` D; "Branch feat/todo" — `ai-team` F); `ai-safety-cost` A1 có quyền "Create branches" (gắn nhánh `ai/kan-…` vào ticket); `settings-structure` C có hàng "Repositories". Chữ "Review" trong các màn này là **trạng thái ticket và thread Docs**, không phải PR review. Thiếu: PR do board mở, trạng thái CI, comment review giao lại AI, trạng thái PR/CI trên ticket |
| 28 | Đánh giá đội AI: các bộ bài, điểm theo thời gian | Màn mới (cạnh Health) | `ai-team-review` B "Health" đã có 5 ô (Reliability 89% — tốt khi ≥85%; Autonomy 61% — đích 70%; Speed 3 h 40, 27% là chờ người; Quality 13% sent back; Cost $41.30, $2.29/ticket, 24% của trần $175), dòng phán quyết "2 good · 3 watch · 0 fix" (không hiện khi <10 run), bảng Each AI (RUNS, FINISHED OK, ASKED YOU, SENT BACK, TOUCHES/10 RUNS, AVG RUN, COST/TICKET + Healthy/Watch/Fix), danh sách "What to fix · 8" (chỉ hiện khi ≥3 ca), ngưỡng đổi ở Settings › AI. Nhưng §E nói rõ các chỉ số này "measure how the setup works, not how smart an AI is", và chỉ so "vs last week", **không có đồ thị theo thời gian**. `ai-board-assistant` E là gợi ý test case cho ticket, "AI does not run or judge tests". Thiếu: các bộ bài kiểm tra, cách chấm, project sandbox + repo mẫu, điểm theo thời gian |
| 29 | Board AI chủ động: thẻ gợi ý; lệnh thường trực (danh sách, chạy thử, lịch sử chạy, hoàn tác) | Sửa màn cũ (mở rộng F) + phần mới | `ai-board-assistant` F "Board health and daily digest": F1 sáu insight (Stuck, WIP overload, Blocked chain, Unassigned, At risk, Priority), mỗi cái **chỉ dựng nháp** ("Draft a nudge") + Snooze / Dismiss; pill "Needs action 5 / Snoozed 1 / Dismissed 3"; F2 (09:00 T2–T6, Stuck sau 3 ngày, trần 5 insight/ngày, insight đã dismiss chỉ trở lại khi xấu hơn); F3 (toast "Board health is ready" + badge); H1 (công tắc tính năng, $1.86/tháng). `ai-team-review` B "What to fix" là danh sách gợi ý dựa trên bằng chứng, chỉ hiện khi ≥3 ca, mỗi mục mở đúng trang cài đặt. Trong sáu insight chỉ có **Stuck** trùng với danh sách tín hiệu mới ("Blocked chain" là phụ thuộc, không phải bất đồng AI). Thiếu: tín hiệu AI treo, run lỗi liên tiếp, quota gần chạm, hàng chờ dài, bất đồng chưa phân xử; và **toàn bộ lệnh thường trực** (viết bằng lời, chế độ thử, danh sách luật, lịch sử chạy, hoàn tác một việc tự động). Lưu ý: hiện Undo chỉ tồn tại trên bản nháp đã Apply (B10, D3, J) |
| 30 | Member PM điều phối (một pack) và thứ bậc Board AI > PM | Thuộc #5, nhưng có phần phải sửa màn cũ | `ai-team` F (parent ticket "led by PM", 6 ticket con), C (PM delegate và nhận `report_back`; report back **không tính** là "sent back" nên PM không bị trông như nút cổ chai); `ai-board-assistant` J (mặc định "PM = Developer template, read-only CLI, ceiling To Do"); `ai-team-timeline` C (Autopilot là lifeline có "delegate: PM" quyết phê duyệt sau khi chờ, trong mức rủi ro + giới hạn mỗi giờ; **không bao giờ** quyết Docs proposal, yêu cầu của chính nó, hay ngân sách). Phát hiện ping-pong đã có (`ai-team` C/E, `ai-team-review` E, `ai-team-timeline-cases` F: cùng hai AI đẩy qua lại ≥3 lần) nhưng **chỉ phát hiện, người tự gỡ** — đúng chỗ để gắn phân xử của D12. Thiếu: thứ bậc Board AI > PM, PM làm trọng tài, PM nhận lệnh điều phối từ chat |
| 31 | Hàng chờ "cần người" với chẩn đoán và các lựa chọn | Thuộc #20 | Đã có nhiều mảnh, tất cả đều thiếu chẩn đoán: `ai-team` B "Now › Needs you · 4" (oldest first, "something an AI cannot continue without"; thẻ: BA hỏi → Answer, Dev muốn đổi assignee → Approve/Deny, Tester offline → Fix connection, Designer đề xuất 2 thay đổi trang → Review changes; mỗi thẻ ghi đã chờ bao lâu và nó chặn gì); `ai-resources` A/D (restart = notice amber im lặng "restart 1 of 2"; **stop = thanh đỏ + thẻ Needs you có Retry**, kèm Open run và Raise limit, và có thông báo desktop), F1/F2 (empty state, Retry là hành động duy nhất); `ai-accounts` E3 (thẻ "Account signed out" + Sign in again); `ai-safety-cost` B1 Inbox › Approvals (tab Mentions/Questions/Approvals, chip rủi ro, đếm ngược, thanh hành động hàng loạt), I3 (backlog 10/agent, 25/project), D6 auto-trip (4 luật: 5 run lỗi trong 10 phút → tạm dừng agent; spend gấp 3 trong 15 phút → tạm dừng agent; 6 lần bị từ chối trong 10 phút → safe mode; 3 agent trip trong 30 phút → Pause all, mặc định tắt), D3 Resume; `notifications` A/F/N (kind "Needs you" tự đóng khi xử lý ở nơi khác; tên "Needs you" dùng cho **cả** tab panel và mục AI Team, cùng một danh sách, gỡ ở đâu cũng đóng cả hai). Thiếu: chẩn đoán, "đã thử gì", và bộ lựa chọn Thử lại / Chạy tiếp kèm ghi chú / Giao AI khác / Huỷ |
| 32 | Màn chi tiết run "vì sao", ghim run, hạn lưu, xuất | Thuộc #21 | **Màn run view chưa từng được thiết kế ở bất kỳ tài liệu nào** — chỉ có cửa vào: `ai-team` B ("Open last run", "Open run"), D ("Open the full run"), `ai-team-review` C ("Run view: still the detail of one run. Every bar opens it"), `ai-team-timeline` D (hover card: steps, tokens, cost; inspector: LATEST STEPS kiểu "Edited RunCard.tsx", "Ran npm test: 2 failed", STARTED BY, Open the run, Pause; công tắc "Detailed" thêm tick cho từng bước), `ai-team-timeline-cases` J (step list nạp khi mở inspector; 8 trạng thái run; toggle "Table" cho accessibility). Thiếu: xem prompt đã gửi, tool call kèm đầu vào/đầu ra (hiện chỉ có một dòng tóm tắt mỗi bước), ghim run, hạn lưu run (chỉ có chat retention "Kept 30 days" ở `ai-board-assistant` B3), xuất run (chỉ có Export CSV của touches ở `ai-team-review` A), tìm lịch sử run (chỉ có "Find a ticket", filter của `ai-team-review` A, và "Search chats…") |

Hàng 24–32 đã đối chiếu (2026-11-01).

**Tổng kết (sau khi đối chiếu đủ 32 hàng):** 12 màn mới (5, 7, 8, 9, 10, 11, 12, 18, 23, 25, 27, 28), 10 sửa màn cũ (2, 4, 6, 13, 14, 15, 16, 19, 20, 22), 6 vừa sửa vừa thêm phần mới (1, 3, 17, 24, 26, 29), 1 phần lớn đã có (21), 3 hàng thuộc mục khác (30 → #5, 31 → #20, 32 → #21).
Hai việc cần người dùng xác nhận trước khi giao designer: #19 đảo nguyên tắc "chỉ nháp" của Board AI (tài liệu `ai-board-assistant` nhắc bất biến này ở 10 chỗ: A1, B1, B2, C1, D1, F1, I, I7, I10 và ô Invariant — đảo nó là sửa cả tài liệu, không phải một dòng); #12 thêm phát hiện vòng lặp (đã xem lý do bản cũ bị bỏ; không mâu thuẫn, chỉ cần người dùng biết).

**Mâu thuẫn phát hiện khi đối chiếu, đã chốt ở D26:** `ai-safety-cost` H1 có cột **Email** và bản tóm tắt 09:00, trong khi thiết kế thông báo (PR #251) bỏ bản 09:00 (thay bằng thẻ 18:00) và bảng kênh của nó không có cột Email. H1 là bên phải sửa, và đã sửa.

**Đã thiết kế:**
- Đợt 1 — [`design/screens/ai-operations.md`](../../design/screens/ai-operations.md) (mục A–M): phủ các hàng 16, 17, 18, 20, 21, 24 (phần chỉ dẫn + trí nhớ), 31, 32.
- Đợt 2 — [`design/screens/ai-team-process.md`](../../design/screens/ai-team-process.md) (mục A–N): phủ các hàng 1, 2, 3, **4**, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 23, 25, 26, 30. (Hàng 4 — ngân sách context của member — nằm ở mục B: thẻ member ghi "base prompt 3,140 tokens".)
- Đợt 3 — [`design/screens/ai-board-wave3.md`](../../design/screens/ai-board-wave3.md) (mục A–N): phủ các hàng 19, 22, 24 (phần kho kiến thức), 27, 28, 29.

Cả 32 hàng của mục 5 đã có thiết kế. Mục B của đợt 3 liệt kê đúng 10 chỗ trong `ai-board-assistant` nói "chỉ nháp" và nói rõ cái gì thay thế từng chỗ — đây là việc #19 cần người dùng xác nhận trước khi giao dev.

## 6. Việc kỹ thuật không có giao diện

- Giới hạn số run song song cho CLI theo tài khoản; phát hiện treo; retry theo loại lỗi có backoff.
- Đọc tool `Skill`/`Task` từ stream để biết skill/subagent được dùng.
- Lưu transcript (nén) khi run kết thúc; hạn lưu run; tìm kiếm toàn văn.
- Sửa `kanban_mcp/instructions.py` (mention trong run có đánh thức AI; `ai_team(ask)` bị chặn trong run).
- Tool MCP đính kèm file (dùng lại cơ chế chép file của proof và Docs).
- Bộ bài kiểm tra năng lực dùng tool của AI, chạy định kỳ.
- Lệnh `wait` / `kanban wait` cho AI bên ngoài (đã bàn ở phần thông báo).

## 7. Thứ tự đề xuất (cập nhật sau các chủ đề mới)

1. **Độ bền:** treo → chẩn đoán → xử lý; lỗi theo loại; giới hạn theo tài khoản (mặc định 2); quota theo khung giờ; sửa hướng dẫn MCP.
2. **Lưu log của board** (gấp: Claude Code tự xoá transcript sau ~30 ngày, dữ liệu đang mất dần), skill/subagent được dùng, tìm kiếm.
3. **Trí nhớ dự án + chỉ dẫn** (tiết kiệm quota rõ nhất).
4. Worktree theo ticket + cấu hình theo run (sau S1–S4).
5. Skills & plugins, role pack, bộ quét repo.
6. Quy trình, vai trò theo bước, member PM, phân xử, can thiệp giữa chừng (sau S6).
7. Board AI có quyền người dùng, chủ động, lệnh thường trực.
8. Kho kiến thức, gắn GitHub, đánh giá đội AI.

## 8. Chi tiết các chủ đề mới (đang bàn)

### Kiến thức dự án (D18)

| Lớp | Nội dung | Cách AI nhận | Ai viết |
|---|---|---|---|
| Chỉ dẫn | Quy ước, cách làm, điều cấm | Luôn có trong prompt | Người (đã có một phần: tài liệu AI guidance trong Docs) |
| Trí nhớ | Bài học: "test bằng lệnh X", "đừng sửa file Y", lỗi hay gặp | Luôn có trong prompt, giới hạn độ dài | AI đề xuất sau ticket, người sửa/xoá được |
| Kho kiến thức | Text, PDF, ảnh, code, trang Docs… | Tool MCP khi cần (mục lục, tìm, đọc) | Người tải lên, AI thêm được |

- Code trong repo: Claude Code tự tìm bằng grep/glob rất tốt, không cần RAG.
- **Hướng mặc định cho kho kiến thức: không embedding.**
  1. Mọi thứ đổi sang text khi tải lên: PDF → text; ảnh → Claude (model nhẹ) mô tả một lần, lưu mô tả cạnh ảnh; trang Docs đã là text.
  2. Mỗi tài liệu có tóm tắt ngắn + từ khoá + "trả lời được câu hỏi gì", do model nhẹ viết một lần lúc tải lên.
  3. Một **mục lục** tự cập nhật (tên, tóm tắt một dòng) để AI lướt trước, rồi mở đúng tài liệu cần.
  4. Tìm từ khoá BM25 (SQLite FTS5; Docs đã có FTS) trên nội dung + tóm tắt + từ khoá; AI tự thử nhiều cách diễn đạt.
  5. Tool MCP: `knowledge_index` (mục lục), `knowledge_search` (từ khoá), `knowledge_read` (đọc một tài liệu/đoạn).
- Không gửi tài liệu ra dịch vụ nào ngoài Claude (vốn đã đọc chúng khi làm việc). Không cần API key thêm.
- Embedding (Voyage AI, OpenAI, Gemini) để làm tuỳ chọn sau, nếu kho lớn tới mức tìm từ khoá + mục lục không đủ.
- **Phạm vi (đã chốt):** mỗi project một kho riêng, cộng một **kho chung** tuỳ chọn để chia sẻ giữa các project (quy ước công ty, tài liệu
  dùng chung). Project chọn có dùng kho chung hay không; tool tìm kiếm trả kết quả từ cả hai, ghi rõ nguồn.

### Bộ quét repo (D19)

1. Quét máy móc, không tốn quota: `package.json` (scripts test/lint/build, framework), `pyproject.toml`/`uv.lock`, `go.mod`, `Cargo.toml`, `Makefile`,
   `Dockerfile`, workflow CI trong `.github/workflows` (lệnh test thật đang chạy), `CLAUDE.md`/`AGENTS.md`, `.claude/` có sẵn, README, monorepo,
   kích thước, thư mục test, có giao diện web hay không, git remote.
2. AI nhẹ (Haiku/Sonnet effort thấp) đọc bản tóm tắt + README, đề xuất: lệnh test/lint/build, lệnh chuẩn bị worktree, cổng, quy trình mặc định,
   pack nên có (có UI thì thêm Designer + User tester), skill trong catalog, cách bàn giao code.
3. Chạy thử lệnh chuẩn bị + test một lần trong một worktree để xác nhận lệnh đúng, rồi người duyệt trong một màn hướng dẫn.
4. Quét lại khi repo thay đổi lớn (đổi lệnh trong CI, thêm package).

### Can thiệp giữa chừng (D20)

- Ô "Gửi cho AI" trên ticket và trong khung run: tin nhắn tới ngay AI đang chạy (S6); nếu không chen được thì giao vào lượt kế tiếp.
- Chat với "quản lý" (AI điều phối / Board AI): người nói một lần, quản lý tự nhắc từng AI liên quan hoặc tạo việc mới.

### Gắn GitHub (D21)

- Chỉ với PR do board mở. App chạy trên máy nên dùng `gh` hỏi định kỳ (không có webhook).
- CI đỏ: lấy log bước lỗi (`gh run view --log-failed`) đưa cho AI của ticket. Comment review: đưa nguyên văn + vị trí dòng.

### Đánh giá đội AI (D22)

| Bộ bài | Kiểm tra gì | Chấm thế nào |
|---|---|---|
| Chức năng board | Dùng đúng tool: giao việc, comment, Docs, handoff, hỏi người | Trạng thái board sau khi chạy |
| Xử lý vấn đề | Sửa bug trên repo mẫu có bug cài sẵn | Test ẩn pass |
| Xử lý issue | Phân loại, làm rõ ticket mơ hồ, tách ticket | Đối chiếu đáp án + AI chấm (model nhẹ) |
| Làm đúng yêu cầu | Tuân theo tiêu chí, không làm thừa | Kiểm tra máy móc + AI chấm |
| Hồi phục | Cố tình gây lỗi: giết CLI, MCP sập, rate limit giả | Run có hồi phục / dừng đúng cách |
| Phối hợp | Quy trình nhiều bước, phân xử | Đi hết quy trình, số vòng |
| An toàn | Tôn trọng quyền, chống prompt injection trong ticket | Không làm điều bị cấm |

- Chạy trên một project sandbox với repo mẫu cố định; lưu điểm theo thời gian.
- Model nhẹ (Haiku) cho hầu hết các bộ. Lưu ý: chạy bằng Haiku thì đo năng lực của Haiku; các bộ "xử lý vấn đề" nên thỉnh thoảng chạy bằng model thật
  đang dùng (ví dụ hằng tuần) để số liệu còn ý nghĩa.

### Board AI: quyền cụ thể (đề xuất, đang bàn; nguyên tắc ở D23)

Hiện trạng: chế độ nháp (board dựng sẵn context đưa vào prompt, AI đề xuất khối `kanban-actions`, người bấm Apply); chế độ tool chỉ khi chọn một member
Claude Code và chạy với quyền của member đó; "Do the work" mở run trong chat của ticket.

Đề xuất:
- Chạy bằng Claude Code CLI (subscription), một hồ sơ riêng "Board AI", không phải một member nhận ticket. Hành động ghi vào audit/activity là
  "Bạn (qua Board AI)".
- Phạm vi mặc định là cả app (mọi project); màn đang mở (project/ticket/trang) tự đính kèm làm ngữ cảnh.
- Lấy thông tin bằng tool khi cần thay vì board nhồi sẵn context vào prompt (tiết kiệm quota).

| Nhóm | Làm luôn | Làm + Hoàn tác | Hỏi trước |
|---|---|---|---|
| Tra cứu | Tìm ticket/Docs/kho kiến thức; tiến độ; ai đang làm gì; log, transcript run; quota; audit; lịch chạy | | |
| Ticket | | Tạo, sửa trường, chuyển trạng thái, giao/đổi người, comment, link, gắn/đổi quy trình, mức review | Sang Done; thao tác hàng loạt trên nhiều ticket; xoá |
| AI team | | Chạy run, dừng một run, tạm dừng / chạy tiếp một member, tạo member, gán pack/skill, cài skill/plugin | Pause all; đổi quyền / trạng thái tối đa / bypass; xoá member |
| Quy trình | | Tạo/sửa mẫu quy trình (có version) | Xoá mẫu |
| Lịch chạy | | Tạo, sửa, tạm dừng, chạy ngay | Xoá |
| Docs / kho kiến thức | | Tạo, sửa, publish, tải lên | Xoá |
| Code | | | Merge, mở PR / đẩy nhánh lên GitHub |
| Ngân sách, tài khoản, cài đặt | | | Mọi thay đổi |
| Không làm | Nhập API key / mật khẩu, xoá project | | |

- Hoàn tác: mỗi lần làm là một nhóm thao tác có thao tác ngược; hoàn tác được tới khi có thay đổi khác đè lên. Lưu ý comment đã đăng có thể đã được
  AI khác đọc; hoàn tác chỉ xoá comment, không rút lại phản ứng của AI.
- Câu hỏi AI gửi cho người dùng / phê duyệt: Board AI chỉ trả lời hoặc duyệt khi người dùng bảo rõ ("trả lời giúp: dùng cách A"); tự quyết thay
  người là việc của Autopilot, giữ nguyên.

Câu hỏi:
- Board AI có đồng thời là "quản lý" để chat (D20) và là trọng tài phân xử (D12) không, hay tách một member PM riêng.
- Chủ động: chỉ gợi ý ("QA Quy treo 20 phút, dừng nhé?"), hay cho đặt "lệnh thường trực" để nó tự làm theo luật người dùng đặt.

**Chốt (Board AI):**
- D24. **Tách một member PM** làm điều phối đội và trọng tài phân xử (D12). **Board AI vẫn có quyền quản lý:** người dùng giao việc qua Board AI thì nó
  tự điều phối (tách việc, giao, cho chạy, gắn quy trình) hoặc giao cho PM lo phần điều phối kéo dài. Thứ bậc: người dùng > Board AI (nói thay người dùng)
  > PM > các member. Lệnh từ Board AI thắng quyết định của PM; PM cần người thì báo qua Board AI / thông báo.
- D25. **Board AI chủ động, làm kỹ** (chi tiết ngay dưới).
- D26. **Bảng kênh `ai-safety-cost` H1 theo thiết kế thông báo.** Bỏ cột **Email** (app không gửi email) và bỏ bản tóm tắt 09:00 (thẻ 18:00 của thiết kế thông báo thay nó). Sửa trên chính board `ai-safety-cost` (đã làm: bảng kênh giờ chỉ còn In-app và Desktop).

### Board AI chủ động (D25)

Ba mức:
1. **Quan sát và gợi ý** (mặc định bật): board tự tính tín hiệu (AI treo, run lỗi liên tiếp, quota gần chạm, ticket kẹt ở một bước quá lâu, hàng chờ dài,
   bất đồng chưa phân xử) và hiện thẻ gợi ý kèm nút làm ngay. Không tự làm gì.
2. **Lệnh thường trực** (người bật): người viết luật bằng lời ("AI nào treo quá 30 phút thì khởi động lại"); Board AI đổi thành luật có cấu trúc
   (khi nào, điều kiện, làm gì, tối đa bao nhiêu lần) để người xác nhận. Có danh sách luật; mỗi lần chạy được ghi lại và hoàn tác được.
3. **Không bao giờ tự động:** mọi việc thuộc mức "hỏi trước".

Làm kỹ:
- Tín hiệu và phần lớn luật chạy **bằng code, không gọi AI**, nên không tốn quota; chỉ gọi AI khi cần phán đoán.
- Luật mới chạy **chế độ thử** trước: chỉ ghi "lẽ ra đã làm gì" trong một khoảng thời gian, người xem rồi mới bật thật.
- Giới hạn tần suất cho mỗi luật; tôn trọng giờ yên lặng; Pause all dừng cả luật tự động.
- Chống giẫm chân: luật không được làm đúng việc PM đang làm, và không được kích hoạt lẫn nhau thành vòng.
- Luật mẫu dựng sẵn: AI treo thì chẩn đoán rồi xử lý theo kết quả (xem dưới); run lỗi thì thử lại một lần ở effort cao; CI đỏ thì giao lại Dev; ticket nằm ở Review quá 24 giờ thì nhắc;
  quota gần chạm thì hoãn việc ưu tiên thấp.

### AI treo: chẩn đoán trước, xử lý sau (người dùng đề xuất)

Thay cho "khởi động lại" mù. Mọi lệnh thường trực đều theo khuôn **phát hiện → chẩn đoán → xử lý**; người dùng chọn "để AI phân tích rồi quyết định"
hoặc một hành động cố định.

1. **Chẩn đoán bằng code (không tốn quota):** tiến trình còn sống không, CPU có chạy không; bước cuối cùng trong stream là gì. Phần lớn ca treo có dấu hiệu rõ:
   - lệnh chạy server ở tiền cảnh (`npm run dev`) không bao giờ kết thúc;
   - lệnh chờ nhập từ bàn phím (trình soạn thảo của `git commit`, câu hỏi "Ok to proceed?" của `npx`);
   - build/test dài nhưng vẫn ra output (không phải treo, chỉ là chậm);
   - tool MCP đang chờ (tối đa 15 phút);
   - đang chờ rate limit;
   - RAM tăng mãi.
2. **Chẩn đoán bằng AI nhẹ** (Haiku) chỉ khi code không kết luận được: đọc vài bước cuối + trạng thái tiến trình, phân loại và đề xuất cách xử lý.
3. **Xử lý theo kết quả**, vẫn theo mức rủi ro D23:
   - chờ thêm (việc dài hợp lệ);
   - dừng đúng tiến trình con bị kẹt, không dừng cả run;
   - nhắn cho AI đang chạy qua `stream-json` (S6), ví dụ "lệnh X đang treo, hãy chạy nền hoặc thêm timeout";
   - dừng rồi chạy tiếp bằng `--resume` kèm ghi chú vì sao;
   - chuyển hàng chờ cần người.
4. **Học từ lần treo:** ghi bài học vào trí nhớ dự án (D18), ví dụ "dev server của repo này phải chạy nền", để lần sau không treo lại.

### Độ bền: lỗi theo loại, hàng chờ cần người, chạy song song (đề xuất, đang bàn)

| Loại | Hiện tại | Đề xuất |
|---|---|---|
| Chạm giới hạn sử dụng của gói (khung giờ) | Coi như rate limit, xếp lại tối đa 3 lần | Không phải lỗi: đọc giờ mở lại CLI báo, giữ mọi run của tài khoản đó tới giờ ấy; việc gấp chuyển tài khoản còn dư. Không đếm lần thử |
| Mất mạng, API quá tải (5xx/529) | Thành lỗi chung | Thử lại có backoff (30 giây, 2 phút, 10 phút) bằng `--resume` |
| CLI crash (thoát mà không có kết quả) | Thành lỗi, người bấm Retry | Chạy tiếp một lần bằng `--resume`; crash lần hai thì chẩn đoán (đọc stderr) rồi vào hàng chờ cần người |
| Tài khoản bị đăng xuất | Giữ run, chờ đăng nhập | Giữ nguyên, thêm tự chạy tiếp ngay khi đăng nhập lại |
| Lỗi phía board (D11) | — | Thử lại có backoff, vẫn lỗi thì vào hàng chờ, ghi "lỗi của board" |
| Hội thoại quá dài, compact lỗi | — | Bắt đầu hội thoại mới kèm ghi chú bàn giao tóm tắt |
| Vượt RAM | Khởi động lại tối đa 2 lần | Chẩn đoán trước: tiến trình con nào ngốn RAM, có thể chỉ cần dừng nó |
| App / máy khởi động lại | Tạo lại run một lần trong 24 giờ, chỉ run làm việc | Chạy tiếp mọi run bị ngắt, có backoff; máy ngủ dậy thì kiểm tra CLI còn sống không |

- **Hàng chờ "cần người"**: một nơi duy nhất (gắn với "Needs you" của thông báo). Mỗi mục ghi: chuyện gì xảy ra, chẩn đoán, đã thử gì, các lựa chọn
  (Thử lại / Chạy tiếp kèm ghi chú / Giao AI khác / Huỷ). Việc nghiệp vụ thì PM xem trước rồi mới tới người (như D12); lỗi kỹ thuật của board thì tới
  người luôn.
- **Chạy song song:** giới hạn theo tài khoản Claude (mặc định đề xuất 2) và theo project; xếp hàng theo ưu tiên của ticket; trang Resources đã có RAM.
- **Máy ngủ:** bản desktop có tuỳ chọn "giữ máy thức khi AI đang chạy".
- **Không làm hai lần:** chạy tiếp sau crash có thể khiến AI lặp lại thao tác (đăng lại cùng một comment). Board bỏ qua thao tác trùng hệt trong
  khoảng ngắn.

- **Chốt:** số AI chạy cùng lúc trên mỗi tài khoản Claude: mặc định **2**, người chỉnh tuỳ ý (người dùng không có yêu cầu riêng).

### Log và lịch sử (đề xuất, đang bàn)

Hiện tại: mỗi run lưu bước, file đổi, báo cáo, token/chi phí; transcript đầy đủ chỉ nằm trong file phiên của Claude Code (thư mục cấu hình của tài khoản).
Claude Code tự xoá transcript cũ theo cài đặt `cleanupPeriodDays` (mặc định 30 ngày; máy người dùng không đổi), nên **lịch sử chi tiết của run
sẽ tự mất sau khoảng một tháng**. Run không có hạn lưu; không tìm kiếm được.

1. **Board tự giữ bản của mình** khi run kết thúc, không dựa vào file của CLI:
   - prompt đã gửi (system + phần ticket/trí nhớ/kết quả tìm kho kiến thức) — đây là phần trả lời "vì sao";
   - toàn bộ sự kiện stream: lời AI nói, lời gọi tool kèm đầu vào/đầu ra (đầu ra lớn thì cắt bớt, phần đầy đủ lưu riêng);
   - skill/subagent đã dùng, lỗi và chẩn đoán, tin nhắn người gửi giữa chừng, luật tự động đã chạy;
   - code: dựa vào git (commit trên nhánh của ticket), không lưu diff riêng.
   Lưu nén trong thư mục dữ liệu. Che các chuỗi trông như bí mật (API key, token) trước khi lưu.
2. **Hạn lưu** (cài đặt project): bản tóm tắt run giữ mãi (nhỏ); transcript đầy đủ **90 ngày (đã chốt)**, khớp thông báo; ghim run quan trọng để giữ mãi;
   hiện dung lượng đang dùng.
3. **"Vì sao AI làm vậy":** màn chi tiết run dạng dòng thời gian; bấm một bước thấy AI nói gì ngay trước đó, tool gọi với tham số gì, kết quả ra sao,
   và AI có những ngữ cảnh nào lúc ấy.
4. **Tìm kiếm** (FTS): tóm tắt, câu hỏi/trả lời, comment của AI, tên tool, đường dẫn file, lỗi; lọc theo project, member, ticket, thời gian, trạng thái,
   skill, chi phí. Board AI tìm được qua tool ("tuần trước ai sửa file X?").
5. **Dòng thời gian ticket** (đã có thiết kế ở `ai-team` D): thêm tin nhắn người gửi giữa chừng và các lần luật tự động chạy.
6. **Xuất** một run hoặc lịch sử một ticket ra Markdown/JSON.
7. **Học từ log:** cuối mỗi ticket, model nhẹ đọc log để đề xuất bài học cho trí nhớ dự án (D18).
