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

## 5. Những gì đo được đến giờ

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

## 6. Quy ước khi viết

- Chờ trạng thái (role, text, request xong), không dùng `sleep`. Step chỉ fail trên máy nhanh thường là đọc toast hoặc
  danh sách quá sớm.
- Scenario khẳng định hành vi app hiện tại. Lỗi của app tìm thấy khi viết: ghi trong step và báo cáo, không sửa assert
  cho khớp lỗi.
- Ưu tiên locator theo role / aria-label như các scenario hiện có; thiếu aria-label thì thêm vào component (đó cũng là
  một cải thiện a11y).
- Mỗi lỗi UI đã sửa phải có một step bắt được nó.
