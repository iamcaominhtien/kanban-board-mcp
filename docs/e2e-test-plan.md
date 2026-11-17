# Kế hoạch automation test toàn bộ UI (e2e)

Mục tiêu: mọi chức năng người dùng thấy trên UI đều có ít nhất một bước e2e tự động, và trong lúc viết sẽ dùng chính
việc đó để test app (lỗi tìm được thì ghi vào step và báo cáo, không giấu đi).

## 1. Hiện trạng

- Bộ e2e nằm ở `server/e2e` (Playwright, Chromium headless). `node run.mjs --target rust [--only 23,24] [--group core|ai]`.
- Mỗi scenario có server riêng, thư mục tạm riêng, AI giả (`fake-claude`). Mỗi step ghi request, console, page error,
  screenshot vào `e2e/report/`.
- Đã có 21 scenario (01–11, 13–22; không có 12), khoảng 375 step:

| # | Khu vực | Đã phủ |
|---|---|---|
| 01 | Lần chạy đầu, project | tạo project, validate prefix, trùng prefix, switch project, reload |
| 02 | Members | thêm, trùng tên, đổi role Docs, gán, xoá (bị chặn khi còn ticket), lọc theo assignee |
| 03, 13, 15 | Ticket | CRUD, mọi loại ticket, mô tả Markdown, priority, tag, due date, estimate, AC, sub-task, test case, work log, relation, kéo thả, blocked, Won't Do, Recycle Bin, Reopen, Pending |
| 04, 17 | File | ảnh trong mô tả, dán ảnh, upload/download, preview 10 định dạng |
| 05, 06, 18 | Docs | trang, publish, version, restore, cây trang, link ticket/page, comment, bin, Ctrl+K, import Markdown, editor (slash, toolbar, bảng, code, callout, KaTeX, find/replace, export) |
| 07 | Drawings | sketch 1 nét, canvas 1 note, draw.io (bỏ qua vì không có editor) |
| 08, 21 | Idea Space | capture, triage, stages, assumption, evidence, matrix, promote, Ask AI |
| 09 | Notifications | mention, Needs you / Updates, mark all read |
| 10, 22 | Settings | mọi mục, DB wizard, export ZIP, MCP integrations, diagnostics, phím tắt, B&W, workspace |
| 11 | Live sync | 2 tab: ticket, move, rename, delete, project, page |
| 14 | Board views | List, Timeline, Event Timeline, Story lanes, filter kết hợp |
| 16 | Repo | branch, graph, merge, worktree, Workspace tab |
| 19, 20 | AI | Docs AI, AI Team (account, team, run, câu hỏi, Flow, History, Health, Memory, Schedules, Board AI) |

## 2. Chỗ còn thiếu (đối chiếu `ui/src/components` với các scenario)

Những mục dưới đây chưa thấy step nào chạm tới:

**Project & board**
- Đổi tên, đổi màu, xoá project (`ProjectSidebar`: `Delete …`, `Color …`); trạng thái rỗng sau khi xoá project cuối.
- Story page (`StoryPage`) và sub-ticket theo wave (`SubTicketsSection`: tạo sub-ticket, đổi wave, gỡ). Hiện scenario 14
  tạo Story qua API.
- `ParentGroupLinks`, `TagPicker` tạo tag mới, `StatusMenu` từ card, `ReopenDropPopover` (kéo ticket Done ra ngoài).
- `ConflictNotice`: hai tab cùng sửa một ticket.
- Comment trên ticket: sửa, xoá, mention, quote reply (03 mới chỉ "add a comment").
- Recycle Bin: xoá vĩnh viễn, dọn sạch bin.

**Docs**
- Page actions: Duplicate, Move to, Rename, Give page (đổi owner), Share / Copy reference, Delete (`DeleteDialog`),
  Discard draft (`DiscardDialog`), Page info.
- So sánh version (`DiffView`), `HistoryDrawer` đầy đủ.
- `DocPeekPanel` (xem nhanh trang từ ticket/chip), `RefSuggester` (gõ để gợi ý link), `RefCheatSheet`.
- Kéo thả trong cây trang, resize / thu gọn cây.
- `ConflictBanner` (hai người sửa cùng trang), `OfflineBanners` (mất kết nối khi đang sửa).
- Trang là canvas (`CanvasPageView`), mở trang ở cửa sổ riêng (`DocsPoppedOut`, `DocsWindowApp`).
- Ticket → `TicketDocsSection` tạo/gắn trang từ ticket.

**Canvas / Sketch / Diagram**
- Canvas: thêm/xoá page tab, zoom, Map (M), Keys (?), màu note, label, Comments panel, History panel, Source editor,
  Move to Docs, đổi tên board.
- Sketch: layer (thêm, xoá, đổi tên, đổi thứ tự, merge, opacity), màu, hình, độ dày, Sketch AI panel.
- Diagram: draw.io hiện bị bỏ qua. Đề xuất phục vụ một stub draw.io cục bộ (trang HTML trả về XML qua `postMessage`) để
  test được luồng tạo / import `.drawio` / lưu / hiển thị; thả file `.drawio` (`DiagramDropZone`); Diagram settings.

**Idea Space**
- `IdeaDiscussion`, owner, effort guess, chọn project, idea cũ (stale), banner archived / assumption bị bác bỏ,
  bỏ archive.

**AI & trợ lý**
- Ticket AI chat (`TicketAi`, `TicketChat`), `AssistDock` / `ScopedChat`, `ContextMeter`, `DoneReceipt`.
- `AiMembersPage`, `AiProfile`, `DragConfirm` (kéo ticket cho AI), `TestCaseMention`, `RunResources`.
- Run lỗi / bị huỷ / vượt giới hạn (fake-claude cần thêm chế độ lỗi nếu chưa có).

**Notifications**
- Thông báo từ nguồn khác mention trên Docs: gán ticket, comment ticket, AI cần trả lời; nhóm theo ngày (`DayCard`);
  click thông báo mở đúng chỗ.

**Settings & trạng thái hệ thống**
- `UpdateSettingsSection` / `UpdateNotice`, `DiagramSettingsSection`, nhiều repository.
- Trạng thái lỗi: `LoadError`, DB down (`databaseDown`), `Splash` / `AppLoading`, server tắt giữa chừng rồi bật lại.

**Xuyên suốt**
- Màn hình hẹp (hiện cố định 1440×900): 1024 và 768 px, không cuộn ngang, panel vẫn dùng được.
- Theme tối / sáng (22 mới có B&W).
- Accessibility: chạy axe trên mỗi màn chính; điều hướng chỉ bằng bàn phím cho các luồng chính (tạo ticket, mở modal, đóng
  bằng Esc, focus trap).
- Console sạch: step nào có `pageerror` hoặc console error không khai báo `expectConsole` thì fail.

## 3. Scenario mới

Đánh số tiếp từ 23. Mỗi scenario 10–25 step, theo đúng quy ước hiện có.

| # | Tên | Nội dung chính | Nhóm |
|---|---|---|---|
| 23 | `23-projects.mjs` | đổi tên / màu / xoá project, xoá project cuối, xoá project có ticket (hỏi xác nhận), reload | core |
| 24 | `24-stories.mjs` | tạo Story trên UI, Story page, sub-ticket, wave, gỡ sub-ticket, tiến độ, parent links | core |
| 25 | `25-ticket-comments.mjs` | comment: sửa, xoá, mention → thông báo, quote reply, Markdown trong comment | core |
| 26 | `26-docs-page-actions.mjs` | Duplicate, Move to, Rename, Give, Share, Delete, Discard, Page info, kéo thả cây, xoá vĩnh viễn trong bin | core |
| 27 | `27-docs-versions-refs.mjs` | so sánh version (DiffView), Peek, RefSuggester, cheat sheet, tạo trang từ ticket | core |
| 28 | `28-docs-conflict-offline.mjs` | hai tab sửa cùng trang → ConflictBanner; chặn mạng (`context.setOffline`) → OfflineBanners, lưu lại khi có mạng | core |
| 29 | `29-canvas.mjs` | page tab, zoom, map, keys, note màu, label, comment, history, source, Move to Docs, canvas làm trang Docs | core |
| 30 | `30-sketch.mjs` | layer, màu, hình, opacity, merge, lưu và mở lại đúng thứ tự layer | core |
| 31 | `31-diagrams.mjs` | stub draw.io: tạo, import `.drawio`, thả file, sửa, lưu, hiển thị; Diagram settings | core |
| 32 | `32-ticket-ai.mjs` | Ticket AI chat, AssistDock, context meter, done receipt, kéo ticket cho AI (DragConfirm) | ai |
| 33 | `33-ai-failures.mjs` | run lỗi, huỷ run, vượt giới hạn, account hết hạn: UI báo đúng và cho chạy lại | ai |
| 34 | `34-notifications-more.mjs` | gán ticket, comment ticket, câu hỏi AI → thông báo; nhóm ngày; click mở đúng chỗ | core |
| 35 | `35-error-states.mjs` | splash, server tắt rồi bật (banner, tự nối lại), DB lỗi, route không tồn tại | core |
| 36 | `36-responsive-theme.mjs` | board, ticket, docs, settings ở 1024 và 768 px; theme tối; không cuộn ngang | core |
| 37 | `37-a11y-keyboard.mjs` | axe trên các màn chính (chỉ báo lỗi mức serious/critical), luồng chính chỉ bằng bàn phím | core |

Bổ sung vào scenario cũ thay vì tạo mới:
- 03: `StatusMenu` trên card, tạo tag mới trong `TagPicker`; 13: `ReopenDropPopover`, xoá vĩnh viễn trong Recycle Bin.
- 08/21: Discussion, owner, effort, chọn project, bỏ archive, banner assumption bị bác bỏ.
- 10/22: Update settings, Diagram settings, hai repository.
- 11: `ConflictNotice` khi hai tab sửa cùng ticket.
- 20: AI Members page, AI profile, Run resources, TestCaseMention.

## 4. Hạ tầng cần thêm

1. **Kiểm tra console sạch** trong `lib/session.mjs`: step có `pageErrors` hoặc console error không khai báo thì ghi
   lỗi. Bật trước ở chế độ chỉ báo cáo, xem số lỗi hiện có, sửa / khai báo, rồi mới bật thành fail.
2. **Viewport và theme theo scenario**: cho `Session` nhận `viewport` và `colorScheme` trong options của scenario.
3. **axe-core**: nạp từ file cục bộ bằng `page.addScriptTag` (thêm devDependency trong `server/e2e/package.json`).
4. **Stub draw.io**: một trang HTML nhỏ trong `server/e2e/lib/` trả lời giao thức embed của draw.io; trỏ cấu hình
   diagram của server test vào đó.
5. **fake-claude**: thêm chế độ lỗi / treo / vượt giới hạn nếu chưa có, để test scenario 33.
6. **Helper chung** trong `lib/ui.mjs` cho các thao tác lặp lại (mở page actions, chọn trong menu, chờ toast) để các
   scenario mới ngắn và đồng nhất.

## 5. Thứ tự làm

| Đợt | Việc | Lý do |
|---|---|---|
| 1 | Hạ tầng 1, 2, 6; scenario 23, 24, 25, 26 | luồng lõi, dễ viết, tìm lỗi nhanh nhất |
| 2 | 27, 28, 29, 30, 34; bổ sung 03/08/11/13 | Docs và drawings, nhiều component chưa phủ |
| 3 | Hạ tầng 4, 5; scenario 31, 32, 33 | cần stub draw.io và fake-claude mới |
| 4 | Hạ tầng 3; scenario 35, 36, 37; bổ sung 10/20/21/22 | xuyên suốt, chạy trên mọi màn |

Sau mỗi đợt: chạy các scenario mới với `--only`, ghi lại các lỗi app tìm được (issue hoặc ghi chú trong step), cập nhật
bảng scenario trong `server/README.md`. Chạy full (`node run.mjs --target rust`, khoảng 8 phút, sẽ lâu hơn khi thêm
scenario) ở cuối đợt 4.

## 6. Quy ước khi viết

- Chờ trạng thái (role, text, request xong), không dùng `sleep`. Step chỉ fail trên máy nhanh thường là đọc toast hoặc
  danh sách quá sớm.
- Scenario khẳng định hành vi app hiện tại. Lỗi của app tìm thấy khi viết: ghi trong step và báo cáo, không sửa assert
  cho khớp lỗi.
- Ưu tiên locator theo role / aria-label như các scenario hiện có; thiếu aria-label thì thêm vào component (đó cũng là
  một cải thiện a11y).
- Mỗi lỗi UI đã sửa phải có một step bắt được nó.

## 7. Chuẩn bị để chạy

```sh
cd server && cargo build -p kanban-server -p kanban-mcp-stdio -p fake-claude
cd ../ui && npm ci && npm run build
cd ../server/e2e && node run.mjs --target rust --only 23
```

Playwright phải resolve được (đã cài sẵn trong container cloud).
