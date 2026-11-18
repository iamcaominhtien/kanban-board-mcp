# Kế hoạch automation test toàn bộ UI (e2e)

Mục tiêu: mọi chức năng người dùng thấy trên UI đều có ít nhất một bước e2e tự động. "Đủ" không do ai ước đoán mà
do số đo quyết định (mục 2). Trong lúc viết test, cũng dùng chính việc này để test app: lỗi tìm được thì ghi vào
step và báo cáo, không giấu đi.

## 1. Số đo gốc (17/11/2026, 21 scenario, 375 step, không step nào lỗi)

| Thước đo | Đã phủ | Tổng | % |
|---|---:|---:|---:|
| Server call của UI được một step gọi tới | 244 | 427 | 57.1 |
| Control có nhãn đã được bấm / gõ vào | 289 | 1112 | 26.0 |
| Control có nhãn đã hiện trên màn hình | 561 | 1112 | 50.4 |
| Code `ui/src`: function | 6273 | 13172 | 47.6 |
| Code `ui/src`: branch | 17463 | 40823 | 42.8 |
| Code `ui/src`: statement | 20734 | 38500 | 53.9 |
| Code `ui/src`: line | 90920 | 147340 | 61.7 |

Danh sách chi tiết (do script sinh ra, không phải viết tay):
- [`e2e-coverage/api-gaps.md`](e2e-coverage/api-gaps.md): 183 server call chưa được gọi, theo file và tên hàm; 8 call nằm
  trong hàm không còn ai dùng (code chết?); 14 chỗ gọi có URL không phải literal, cần kiểm tay.
- [`e2e-coverage/ui-gaps.md`](e2e-coverage/ui-gaps.md): 823 control chưa được thao tác (551 chưa từng hiện, 272 có hiện
  nhưng chưa bấm), theo component.
- [`e2e-coverage/code-files.md`](e2e-coverage/code-files.md): coverage theo từng file, thấp nhất ở đầu (73 file 0 %
  function, ví dụ `SearchResults`, `IdeaDiscussion`, `MoveToDialog`, `RefSuggester`, `DocPeekPanel`, `DiffView`, canvas
  `SourceEditor` / `CommentsPanel` / `HistoryPanel`, các bước chuyển database).

Theo khu vực (function %, thấp trước): diagrams 31, canvas 21, sketch 31, assist 33, comments 34, ideas 36, docs 45,
ai 45, settings 46, preview 46, notifications 46, aiteam 50, components gốc (board, ticket) 60, api 70.

## 2. Cách đo

```sh
cd ui && npx vite build --sourcemap --minify false     # bản build cho đo (không minify, có source map)
cd ../server && cargo build -p kanban-server -p kanban-mcp-stdio -p fake-claude
cd e2e && E2E_MEASURE=1 node run.mjs --target rust     # ~11 phút
node measure/report.mjs                                # ~10 s → report/measure/
```

- `measure/inventory.mjs` đọc `ui/src`: mọi `client.get/post/…`, `fetch`, `EventSource` (method + URL template) và mọi
  `aria-label`, `placeholder`, chữ trên button / link / tab / menu item.
- `measure/record.mjs` (bật bằng `E2E_MEASURE=1`) ghi lại: mỗi click / change / input / phím tắt cùng nhãn của control,
  các nhãn có trên trang ở cuối mỗi step, và V8 coverage của trang. Coverage được chốt trước mỗi `goto` / `reload` /
  `close`, vì Chromium bỏ số đếm của trang cũ khi điều hướng.
- `measure/report.mjs` khớp các thứ trên với request đã ghi trong `report/rust.json` rồi sinh ra các file ở mục 1.
  Code coverage tính bằng `monocart-coverage-reports`; báo cáo HTML nằm ở `report/measure/code-html/`.
- Giới hạn: chỉ đếm request xảy ra trong một step; nhãn dựng hoàn toàn từ biến (83 cái) không được đếm; điều hướng do
  chính app gây ra (app tự `location.reload`) vẫn làm mất phần coverage trước đó. Số theo line của V8 cao hơn thực tế,
  nên dùng function và branch làm thước đo chính.

## 3. Thế nào là "đủ"

| Thước đo | Mục tiêu |
|---|---|
| Server call | 100 % call còn dùng. Code chết thì xoá hoặc nối lại vào UI, không viết test cho nó |
| Control được thao tác | 100 %, trừ danh sách loại trừ ghi rõ lý do (`docs/e2e-coverage/exclusions.md`: chỉ có trên desktop app, cần draw.io thật, …) |
| Code function | ≥ 85 % |
| Code branch | ≥ 70 %, tính cả unit test (vitest), vì e2e không nên đi hết mọi nhánh lỗi |

Một khu vực chỉ được coi là xong khi các danh sách thiếu của nó trống (hoặc chỉ còn mục đã loại trừ).

## 4. Thứ tự làm

Mỗi đợt lấy các danh sách thiếu của khu vực đó làm đầu bài: mỗi mục là một step mới, hoặc thêm vào step sẵn có, hoặc
ghi vào danh sách loại trừ kèm lý do. Hết đợt thì đo lại và cập nhật `docs/e2e-coverage/`.

| Đợt | Khu vực | Chưa phủ (call / control) | Scenario |
|---|---|---|---|
| 1 | Board & ticket: comment (sửa, xoá, khôi phục), reopen undo, workspace, project (đổi tên, màu, xoá), Story page, sub-ticket | tickets.ts 10, projects.ts 1 / TicketModal 23, Relations 7, DebugSpace 8, Workspace 7, SubTickets 4 | bổ sung 03, 13, 15, 16; mới `23-projects`, `24-stories` |
| 2 | Docs: page actions (Duplicate, Move, Rename, Give, Delete), DiffView, Peek, RefSuggester, trang kết quả search, comment, conflict, offline, pop-out | docs* 26 / docs 149 | bổ sung 05, 18; mới `25-docs-pages`, `26-docs-conflict` |
| 3 | Canvas, Sketch, Diagram (cần stub draw.io cục bộ) | canvases 22, sketches 3, diagrams 3 / canvas 63, sketch 40, diagrams 12 | mới `27-canvas`, `28-sketch`, `29-diagrams` |
| 4 | Idea Space: discussion, link, AI extras | ideas 21, ideaAi 5 / ideas 85 | bổ sung 08, 21 |
| 5 | AI & trợ lý: ticket chat, assist, knowledge base, packs, plugins, scan, code, schedules; run lỗi / huỷ (cần thêm chế độ lỗi cho `fake-claude`) | ai* 47, assist 17, editorAi 4, schedules 4 / ai 157, aiteam 48, assist 40, schedules 21 | bổ sung 19, 20; mới `30-ticket-ai`, `31-ai-failures` |
| 6 | Settings & hệ thống: chuyển database (các bước Move), update notice, notifications, preview còn thiếu | database 5, notifications 6, settings 2 / settings 39, notifications 16, preview 29 | bổ sung 09, 10, 17, 22 |
| 7 | Xuyên suốt: màn hình hẹp (1024 / 768 px), theme tối, axe trên các màn chính, chỉ dùng bàn phím, console sạch thì mới pass | — | mới `32-responsive`, `33-a11y` |

Đợt 1 làm luôn mấy việc hạ tầng nhỏ: helper chung trong `lib/ui.mjs`, cho Session nhận `viewport` / `colorScheme`, và
quyết định số phận 8 call code chết.

## 5. Tiến độ

| Sau | Scenario / step | Server call | Control được thao tác | Function | Branch |
|---|---|---:|---:|---:|---:|
| Số gốc | 21 / 375 | 57.1 % | 26.0 % | 47.6 % | 42.8 % |
| Đợt 1 (23, 24, 25) | 24 / 449 | 59.7 % | 29.8 % | 48.8 % | 43.4 % |
| Đợt 2 (26, 27, 28) | 27 / 574 | 63.0 % | 38.9 % | 53.8 % | 48.0 % |
| Đợt 3 (29, 30, 31) | 30 / 713 | 69.8 % | 46.3 % | 58.0 % | 52.3 % |
| Đợt 4 (32, 33, 34) | 33 / 804 | 75.6 % | 51.7 % | 60.6 % | 54.3 % |
| Đợt 5 (35, 36, 37) | 36 / 895 | 90.4 % | 57.4 % | 65.8 % | 58.0 % |
| Đợt 6 (38, 39, 40) | 39 / 944 | 93.9 % | 59.5 % | 68.8 % | 61.0 % |

Đợt 1: `api/tickets.ts` còn 1 call chưa phủ (từ 10), call duy nhất còn lại thuộc Docs / Idea (đợt 2, 4). Các component
gốc (board, ticket) tăng từ 60.4 % lên 67.2 % function. Bug đã sửa: trang vẫn gọi API của project đã xoá (`App.tsx`);
"Open ticket" trong menu card không làm gì, "Copy link" của card không báo (`TicketCard.tsx`,
`DraggableTicketCard.tsx`). Giới hạn đo: chọn một `<option>` bằng `selectOption` không được ghi là thao tác lên
option đó, nên 7 loại link trong `RelationsSection` vẫn hiện là chưa phủ dù scenario 23 có dùng đủ.

Đợt 2 (Docs): bug đã sửa: xoá trang đang mở làm trang bị gọi lại (410, rồi 404 sau khi xoá hẳn) (`DocsView.tsx`,
`api/docs.ts`); trang nháp không tìm được vì lưu nháp không cập nhật chỉ mục (`kb-docs` `save_draft`); sửa trong ô
Markdown source ngay sau khi mở trang bị bỏ qua (`DocsEditor.tsx`); "Retry now" ẩn banner offline khi server vẫn chưa
liên lạc được (`DocsEditScreen.tsx`). Tính năng thêm theo yêu cầu: sửa tên / màu project, xoá cả project đang mở và
project cuối, tạo Story từ New Ticket, Story đổi trạng thái như ticket thường.

Đợt 3 (Canvas, Sketch, Diagram): draw.io được thay bằng một editor giả lập chạy ngay trong scenario 31 (một HTTP
server nhỏ nói giao thức embed). Bug đã sửa: nhấp đúp vào note / label / board trên canvas không sửa được; Esc trong ô
comment mới của canvas không đóng; phím P của canvas lọt xuống ticket bên dưới; "Open on a canvas" gửi sai tên tham số
(không bao giờ liệt kê canvas có sẵn) và để trình xem file đè lên editor; Esc khi đổi tên layer của sketch vẫn lưu tên
và mở hộp lưu; ý tưởng của Sketch AI không hiện; editor draw.io tải địa chỉ chết trước khi kiểm tra xong.

Đợt 4 (Idea Space): `api/ideaAi.ts` hết call chưa phủ (từ 5), `api/ideas.ts` còn 1 (từ 21): `park-many` thật ra có
chạy, nhưng trong một browser context riêng (đồng hồ chạy trước 20 ngày) mà bộ đo không gắn vào. Các file trong
`components/ideas` giờ từ 60 % function trở lên (`IdeaDiscussion` từ 0 % lên 79 %, `IdeaAiPanel` từ 5 % lên 76 %).
Bug đã sửa: Accept một lời khuyên AI trong Triage (trên dòng hoặc thẻ) bỏ mất lời khuyên, nên nó không bao giờ được
đánh dấu đã nhận và hộp Park mở ở "Next week" thay vì số ngày AI gợi ý (`Triage.tsx`, `useIdeaMoves.tsx`,
`TriageDialogs.tsx`); xoá ý tưởng làm trang của nó bị gọi lại (hai lỗi 404) (`api/ideas.ts`); unit test
`ideaAiWave5` hỏng từ AI v2 vì câu thông báo đã đổi. Giữ nguyên: bóng đèn ý tưởng trên thẻ trượt 28 px khi rê chuột
(thiết kế cố ý); xoá giả định không có trả 400 (log, comment trả 404), đúng hợp đồng 4.0.x. Chưa phủ: sửa nội dung
mục log (không có UI), một lần "Get advice" trộn Merge / Park / Keep (`fake-claude` chỉ trả một câu cho mọi ý tưởng).

Đợt 5 (AI & trợ lý): call chưa phủ của các file `api/ai*`, `assist`, `editorAi`, `docsAi*`, `schedules` giảm từ 93 còn
17. Số còn lại không có màn hình gọi tới: `TicketHandover` (worktree, commit, merge, handover) chỉ hiện khi
`MOCK_AI_ACTIVITY` là false, mà công tắc này đang bật trong lúc chuyển giao diện AI của ticket sang thiết kế mới;
`GET /ai/power` chỉ desktop app gọi; poll pull request cần một PR GitHub thật; `scheduleApi.events`, `GET
/ai/scans/:id` không ai gọi; bản nháp Docs AI (PATCH trả 410 trong AI v2). `fake-claude` thêm `FAKE_CLAUDE_V2_FAIL`,
`_HANG`, `_DELAY`, `_STEPS`. Bug đã sửa: run đang chờ giữ tài khoản cũ của team sau khi team chuyển sang tài khoản
khác, chờ mãi lời đăng nhập lại (`kb-ai-run`: run chưa bắt đầu đi theo team, và health của team được kiểm lại);
Ask the docs không hiện trang nguồn và không nhận ra hai trang mâu thuẫn, vì server AI v2 trả `answered` / `conflict`
còn UI chờ `answer` / `disagree` (`api/docsAiAsk.ts`); Accept sau "Try again" của editor AI luôn lỗi; tóm tắt lịch sử
trang không hiện; Undo của "tickets created" không báo; xoá tài liệu knowledge base làm trang gọi lại nó (404). Test
cũ đã sửa: hai golden lịch chạy phụ thuộc giờ và ngày (`ai_schedule_routes`), mock của `Composer.draft`, `askRules`,
`Knowledge.test`. Chưa sửa: khoảng 40 unit test UI của khu vực AI hỏng từ AI v2 (#322) vì chữ trên màn hình đã đổi;
gửi một câu trả lời của trợ lý thành comment hai lần tạo comment trùng (chỉ khi gọi API thẳng); đồng hồ context của
Board AI không có số vì server không ghi; đề xuất lệnh của AI khi quét repository (`fake-claude` chưa trả lời được
lời gọi một lần không có session); cú bấm "Move and cancel run" thỉnh thoảng không ăn (2 / 12 lần, chưa rõ do test
hay do app).

Đợt 6 (Settings & hệ thống) và các việc kèm theo: màn hình AI của ticket chạy trên dữ liệu thật, công tắc
`MOCK_AI_ACTIVITY` đã bỏ và thẻ bàn giao worktree hiện lại (scenario 38; `GET /tickets/:id/ai/worktree` trả thêm
`route`, golden sửa tay); 39 đi hết wizard chuyển database sang một file SQLite khác, màn hình kết nối lại, thư mục
dữ liệu, cập nhật app; 40 notifications và preview (biểu đồ xlsx, hình và đường nối pptx). Bug đã sửa: menu "Turn
this kind off" của một thông báo bị dòng dưới che; đồng hồ context của Board AI không bao giờ có số (`kb-assist`
không giữ kích thước context Claude Code báo). Cú bấm "Move and cancel run" thỉnh thoảng mất là do test: dnd-kit
chặn mọi click trong 50 ms sau khi thả, `dragCard` giờ chờ 80 ms. Toàn bộ unit test UI xanh lại (851 / 851, trước
đó hơn 50 test hỏng từ AI v2). Còn chưa phủ: phần lớn call còn lại không có màn hình gọi (`GET /ai/power` chỉ
desktop app gọi, poll pull request cần PR GitHub thật, vài API không ai gọi); PostgreSQL / MariaDB thật (đang làm,
scenario 41); thông báo hệ điều hành của desktop app (cần chạy app Electron, xem đợt 7).

Đợt 7 (xuyên suốt): 42 kiểm các màn chính ở 1024×768 và 768×1024 trong hai giao diện (Color, Black & white): không
cuộn ngang, control chính không bị che, chữ đạt AA. Chữ phụ #9aa8a0 (2.48:1) đổi sang màu chữ phụ của app (5.65:1)
ở 207 chỗ; số đếm đầu cột giữ màu gốc theo lựa chọn của chủ dự án nên vẫn dưới AA. 43 chạy axe trên chín màn và
đi bằng bàn phím: New ticket và Members thành dialog thật, đóng bằng Esc, focus trở về chỗ mở; sửa tiêu đề ticket
bằng Enter hay F2; Esc của menu trạng thái không đóng cả ticket; nhãn cho các ô loại, ưu tiên, ước lượng, hạn; một
landmark `main`. Desktop app có e2e riêng (`desktop/e2e`, Electron thật dưới Xvfb): thông báo hệ điều hành, giới
hạn 20 s, số trên icon, click, thông báo thử, giờ yên lặng, luồng cập nhật. CI chạy hàng đêm
(`.github/workflows/e2e-nightly.yml`) chạy cả bộ e2e, scenario 41 trên PostgreSQL và MariaDB, và e2e desktop.
Còn lại (cần sửa `.tsx`): màu chữ inline #9AA8A0 trong `TicketModal.tsx`, bảng màu avatar; card kéo thả lồng nút
"Card options" (nested-interactive); vòng focus thiếu ở vài ô của Docs và mô tả ticket (CSS); thanh công cụ editor
Docs có khoảng 30 điểm Tab.

## 6. Những gì đo được đến giờ

- `03-tickets / log a debug-space entry`: test chập chờn. Danh sách hiện entry mới trước khi form kịp đóng nên cùng
  một dòng chữ xuất hiện hai chỗ. Đã sửa: test chờ form đóng rồi mới đọc.
- 8 hàm trong `ui/src/api` không còn chỗ nào trong UI gọi tới. Theo lịch sử git:
  - **Refactor AI v2 bỏ quên** (#322, 08/11): `useTicketDrafts`, `useCoverage`, `useMentionEstimate`. #322 đã xoá chỗ
    gọi trong component nhưng để lại hàm. Phía server, khái niệm draft đã bị bỏ ("Drafts are gone in AI v2", trả 410),
    nhưng route `GET /tickets/{id}/ai/assist/drafts`, `…/coverage`, `GET /tickets/{id}/ai/estimate` vẫn còn: cần xem
    route nào cũng thừa.
  - **Viết sẵn mà chưa bao giờ nối vào UI**: `deleteCanvas`, `makeVersion` (#247), `usePageMarkers`, `useDocsAiJobs`
    (#208), `useDocsVersion` (#135; UI dùng `useDocsVersions`, bản danh sách). Route server của cả năm hàm vẫn còn.
  - `toggleSubTask`, `restoreComment`, `undoReopenTicket` **không** chết: chúng được gọi qua `useToggleSubTask`,
    `useRestoreComment`, `useUndoReopen`, và các hook này có dùng trong `TicketModal` / `useMarkerActions`. Chúng nằm
    trong danh sách thiếu chỉ vì chưa có step nào gọi tới.
- Những thứ người dùng thấy nhưng chưa từng được test: Docs mở ở cửa sổ riêng, đổi tên / nhân bản / chuyển trang, so
  sánh version, comment / history / source của canvas, discussion của idea, AI trong sketch.

## 7. Quy ước khi viết

- Chờ trạng thái (role, text, request xong), không dùng `sleep`. Step chỉ fail trên máy nhanh thường là đọc toast hoặc
  danh sách quá sớm.
- Scenario khẳng định hành vi app hiện tại. Lỗi của app tìm thấy khi viết: ghi trong step và báo cáo, không sửa assert
  cho khớp lỗi.
- Ưu tiên locator theo role / aria-label như các scenario hiện có; thiếu aria-label thì thêm vào component (đó cũng là
  một cải thiện a11y).
- Mỗi lỗi UI đã sửa phải có một step bắt được nó.
