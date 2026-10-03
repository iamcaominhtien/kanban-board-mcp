# 🎨 Redesign Implementation — Progress Tracker

> **Core Directive (Nguyên tắc tối cao)**:
> 1. **Code HTML nguồn (`design/source/*.dc.html`) là Technical Ground Truth**: Mọi component, style, hex color, padding, border-radius, SVG path, CSS transition đều **phải sao chép và đối chiếu trực tiếp từ file HTML nguồn tương ứng**. Tuyệt đối không tự suy diễn hay tự chế màu/style.
> 2. **Ảnh render (`design/images/*/*.png`) là Visual Ground Truth**: Luôn mở ảnh mẫu để đối chiếu trực quan, kiểm tra tương quan vị trí, thứ tự phân lớp (z-index/layering) và hiệu ứng thực tế.
> 3. **Quy trình 5 bước bắt buộc cho mọi item**:
>    - **B1**: Đọc kỹ file HTML nguồn trong `design/source/<Component>.dc.html`.
>    - **B2**: Kiểm tra ảnh chụp rendered trong `design/images/<component>/`.
>    - **B3**: Viết code chuẩn xác bám sát từng thuộc tính style, CSS modules và SVG.
>    - **B4**: Chạy `npm run build` và kiểm tra thật trên dev server (`http://localhost:5173`).
>    - **B5**: Cập nhật checkbox trong file này và báo cáo user review trước khi sang phase tiếp theo.

---

## Decisions Log

| # | Question | Decision |
|---|---|---|
| 1 | Description Markdown editor | **Approach B — WYSIWYG** (TipTap/Lexical) |
| 2 | Test Case Expected Result | **Free text** (markdown) |
| 3 | Test Case run history | **Latest run only** |
| 4 | Debug Space "Blocked" @-mention | TBD |
| 5 | Workspace retention clock reset | TBD |
| 6 | Wave auto-compute tie-breaking | TBD |

---

## Phase 0 — Foundation & Design System

### 0.1 — CSS Design Tokens & Fonts
- **Source HTML**: [`design/source/Main.dc.html`](design/source/Main.dc.html)
- **Visual Spec**: [`design/images/theme-and-typography/`](design/images/theme-and-typography/)
- [x] Fonts: `Plus Jakarta Sans` (400, 500, 600, 700, 800) + `JetBrains Mono` (400, 500)
- [x] Brand Colors: Forest `#2E6F40`, Mint `#CFFFDC`, Sage `#68BA7F`, Ink `#253D2C`
- [x] Neutrals: Surface `#FFFFFF`, Bg `#F6FAF7`, Border `#DCE6DF`, Text-sec `#5B6B60`, Text-pri `#1E2A22`, Text-body `#3F4B45`
- [x] Status & Column accents: Backlog `#8B8B8B`, Todo `#3B82F6`, In-progress `#F59E0B`, Review `#6D5DD3`, Testing `#B4571F`, Done `#68BA7F`, Won't Do `#9CA3AF`
- [x] Radii: card 12px, panel 16px, pill 9999px, code 6px
- [x] Type scale classes (.text-display, .text-h1, .text-h2, .text-body-500, .text-body-400, .text-caption, .text-code)
- [x] Keyframe animations: shimmer, spin, ic-ring, att-pulse-bg, att-pulse-icon
- [x] Body background `#F6FAF7` & font family

### 0.2 — Ticket Type Icons (SVG Components)
- **Source HTML**: [`design/source/Icons.dc.html`](design/source/Icons.dc.html)
- **Visual Spec**: [`design/images/icons/`](design/images/icons/)
- [x] Ticket Type Icons: TaskIcon, BugIcon, FeatureIcon, ChoreIcon (cả full 24/30px và card size 15px simplified)
- [x] Priority Marks: 4-bar SVG indicator (Low `#9BB3A4`, Medium `#E8B93A`, High `#E2793D`, Critical `#D64545`, inactive `#DCE6DF`)
- [x] Status Marks: DueDateIcon (`#5B6B60`), OverdueIcon (`#C4432A`), BlockedIcon (`#C4432A`), DragHandleIcon (`#9AA8A0`)
- [x] Test Case Marks: TestCasesTabIcon, PassIcon (`#2E6F40`), FailIcon (`#C4432A`), RunningIcon (`ic-ring` pulse animation), PendingIcon (`#9AA8A0`)
- [x] Debug Space Marks: DebugSpaceTabIcon, DebugEntryDot (5 trạng thái/màu chuẩn)
- [x] Workspace Marks: WorkspaceTabIcon, AutoDeletePendingIcon (`#B4571F`), KeptForeverIcon (`#2E6F40`)
- [x] Thay thế emoji references trong TicketCard, TicketModal, Sidebar

### 0.3 — App Icon / Favicon
- **Source HTML**: [`design/source/Main.dc.html`](design/source/Main.dc.html) (L160–268)
- **Visual Spec**: [`design/images/theme-and-typography/theme-and-typography-5-app-icon-sizes.png`](design/images/theme-and-typography/theme-and-typography-5-app-icon-sizes.png), [`theme-and-typography-6-app-icon-contexts.png`](design/images/theme-and-typography/theme-and-typography-6-app-icon-contexts.png)
- [x] Thẻ trắng (`#F3F8F4`) ở PHÍA SAU, chứa 2 dòng kẻ ngang màu mint (`#B7D9C0`)
- [x] Thẻ xoay nghiêng -9° ở PHÍA TRƯỚC, màu `#1E4A2C` độ mờ `opacity: 0.55` phủ lên trên thẻ trắng
- [x] Cập nhật SVG trong `ui/public/logo.svg`
- [x] Cập nhật component `AppLogo.tsx` (cho Sidebar chip 22px và các cỡ khác)
- [x] Cập nhật `ui/index.html` (preconnect font, favicon link, title)
- [x] **Phase 0 Review**: Chạy app thật, kiểm tra toàn bộ tokens, icons, logo và fonts

---

## Phase 1 — Data Model & Backend

### 1.1 — Status Enum Expansion (review + testing)
- **Spec Ref**: 7 statuses (`backlog`, `todo`, `in-progress`, `review`, `testing`, `done`, `wont_do`)
- [x] Frontend: update `Status` type trong `types/index.ts`
- [x] Frontend: update `COLUMNS` array + `VALID_STATUSES` (6 active columns trên board)
- [x] Backend: update status validation trong `server/models.py` và `server/api/tickets.py`
- [x] Backend: update MCP tools trong `server/mcp_tools.py`
- [x] Unit tests: thêm tests cho `review` và `testing` transitions trong `server/tests/test_tickets.py` (28/28 passed)

### 1.2 — TestCase Model Extension
- **Source HTML**: [`design/source/TestCases.dc.html`](design/source/TestCases.dc.html)
- **Visual Spec**: [`design/images/test-cases/`](design/images/test-cases/)
- [x] Thêm status `running` vào TestCaseStatus (cycle: pending → running → pass → fail → pending)
- [x] Thêm các trường: code (`TC-1`, `TC-2`...), description, expectedResult (free text markdown), notes, startedAt, assignee, testDataFiles
- [x] Backend services + API + MCP tools (`add_test_case`, `update_test_case`)
- [x] Frontend types, API client, TestCasesSection status badges
- [x] Unit tests trong `server/tests/test_tickets.py` (29/29 passed)

### 1.3 — WorkLog → Debug Space Model
- **Source HTML**: [`design/source/DebugSpace.dc.html`](design/source/DebugSpace.dc.html)
- **Visual Spec**: [`design/images/debug-space/`](design/images/debug-space/)
- [x] Mở rộng WorkLogEntry: `kind` (`investigation` | `fix_attempt` | `root_cause` | `blocked` | `resolved`), `pinned`, `attachments`, `linkedBranch`, `linkedTestCase`, `updatedAt`
- [x] Backend services + API (`POST /work-log`, `PATCH /work-log/{id}`, `DELETE /work-log/{id}`) + MCP tools (`add_work_log`, `update_work_log`)
- [x] Frontend type definitions (`DebugEntryKind`, `DebugAttachment`, `WorkLogEntry`) và API client (`addWorkLog`, `updateWorkLog`, `deleteWorkLog`)
- [x] Unit tests trong `server/tests/test_tickets.py` (30/30 passed) & `test_mcp_tools.py` (37/37 passed)

### 1.4 — Branches Model (New)
- **Source HTML**: [`design/source/Branches.dc.html`](design/source/Branches.dc.html)
- **Visual Spec**: [`design/images/branches/`](design/images/branches/)
- [x] Thiết kế Branch model (id, name, status (`baseline` | `open` | `merged` | `stale` | `archived`), branchFrom, prUrl, commitHash, linkedTicketId, aheadCount, behindCount, createdAt, updatedAt)
- [x] Backend model + Alembic migration (`b3c4d5e6f7a8_add_branches_column.py`) + API endpoints (`GET /branches`, `POST /branches`, `PATCH /branches/{id}`, `DELETE /branches/{id}`) + MCP tools
- [x] Frontend type definition (`BranchStatus`, `TicketBranch`) và API client (`listBranches`, `createBranch`, `updateBranch`, `deleteBranch`)
- [x] Unit tests trong `server/tests/test_tickets.py` (31/31 passed)

### 1.5 — Workspace Settings Model (New)
- **Source HTML**: [`design/source/Workspace.dc.html`](design/source/Workspace.dc.html)
- **Visual Spec**: [`design/images/workspace/`](design/images/workspace/)
- [x] WorkspaceSettings model (id, enabled, rootPath, defaultRetentionDays) + per-task `workspaceRetentionDays`
- [x] Alembic migration (`c4d5e6f7a8b9_add_workspace_settings.py`) + API endpoints (`GET/PATCH /workspace/settings`, `GET /tickets/{id}/workspace`, `PATCH /tickets/{id}/workspace/retention`)
- [x] Frontend types (`WorkspaceSettings`, `WorkspaceFile`, `TicketWorkspaceInfo`) và API client (`getWorkspaceSettings`, `updateWorkspaceSettings`, `getTicketWorkspace`, `setTicketWorkspaceRetention`)

### 1.6 — Members "Remove blocked" Check
- **Source HTML**: [`design/source/MembersView.dc.html`](design/source/MembersView.dc.html)
- **Visual Spec**: [`design/images/members-view/`](design/images/members-view/)
- [x] Server-side validation không cho xóa member nếu đang được assign ticket chưa đóng (`status not in ('done', 'wont_do')`) kèm thông báo chuẩn: `"Cannot remove: assigned to N open tickets. Reassign first."`
- [x] Unit tests trong `server/tests/test_tickets.py` (33/33 passed)

---

## Phase 2 — Core Component Restyling

### 2.1 — Ticket Card
- **Source HTML**: [`design/source/TicketCard.dc.html`](design/source/TicketCard.dc.html)
- **Visual Spec**: [`design/images/ticket-card/`](design/images/ticket-card/)
- [x] Bám sát kích thước, padding, border-radius (8px/12px), background `#FFFFFF`, viền `#E3E8E5`, hover `#B9CBBF`
- [x] Hàng tags: tinted pills + overflow count `+N`
- [x] Title clamp tối đa 2 dòng (`line-clamp: 2`)
- [x] 4 trạng thái: Default, Hover (shadow nâng nhẹ), Dragging (nghiêng nhẹ), Blocked (viền đỏ nhạt / lock badge), Done (strikethrough / opacity)
- [x] SVG type icons (15px simplified) + 4-bar priority marks

### 2.2 — Tags (TagPill component)
- **Source HTML**: [`design/source/Tags.dc.html`](design/source/Tags.dc.html)
- **Visual Spec**: [`design/images/tags/`](design/images/tags/)
- [x] Tinted pill background, màu text chuẩn theo 7 bảng màu thiết kế
- [x] Variant có nút xóa `×` (removable)
- [x] Hỗ trợ hiển thị trên card, filter và detail view

### 2.3 — Status Menu
- **Source HTML**: [`design/source/StatusMenu.dc.html`](design/source/StatusMenu.dc.html)
- **Visual Spec**: [`design/images/status-menu/`](design/images/status-menu/)
- [ ] Dropdown pattern 7 statuses kèm màu accent và checkmark cho status hiện tại
- [ ] Micro-interactions hover và transition mở menu

### 2.4 — Toast / Notification
- **Source HTML**: [`design/source/Toast.dc.html`](design/source/Toast.dc.html)
- **Visual Spec**: [`design/images/toast/`](design/images/toast/)
- [ ] 3 variants: Success, Error, Info
- [ ] Bottom-right stack container + inline banner variant

### 2.5 — Loading States
- **Source HTML**: [`design/source/Loading.dc.html`](design/source/Loading.dc.html)
- **Visual Spec**: [`design/images/loading/`](design/images/loading/)
- [ ] Skeleton cards với shimmer gradient animation
- [ ] Button loading spinners

### 2.6 — Drag & Drop Motion
- **Source HTML**: [`design/source/DragDrop.dc.html`](design/source/DragDrop.dc.html)
- **Visual Spec**: [`design/images/drag-drop/`](design/images/drag-drop/)
- [ ] Pickup animation: nâng card lên với shadow và độ nghiêng
- [ ] Source ghost slot (dashed placeholder) & target drop indicator line

---

## Phase 3 — Ticket Detail Panel Redesign

### 3.1 — Ticket Detail Layout
- **Source HTML**: [`design/source/TicketDetail.dc.html`](design/source/TicketDetail.dc.html)
- **Visual Spec**: [`design/images/ticket-detail/`](design/images/ticket-detail/)
- [ ] Header: breadcrumb, ticket ID mono, title, status dropdown, close button
- [ ] Two-column layout: Main content (trái) và Meta sidebar (phải)

### 3.2 — Parent Ticket Variant
- **Source HTML**: [`design/source/TicketDetailParent.dc.html`](design/source/TicketDetailParent.dc.html)
- **Visual Spec**: [`design/images/ticket-detail-parent/`](design/images/ticket-detail-parent/)
- [ ] Waves view, rollup progress bar (AC / Subtickets / Test cases rollup)

### 3.3 — Sub-sections Restyle
- **Source HTML**:
  - Acceptance Criteria: [`design/source/AddAC.dc.html`](design/source/AddAC.dc.html) (`design/images/add-ac/`)
  - Sub-tickets: [`design/source/AddSubticket.dc.html`](design/source/AddSubticket.dc.html) (`design/images/add-subticket/`)
  - Relations: [`design/source/Relations.dc.html`](design/source/Relations.dc.html) (`design/images/relations/`)
  - Attachments: [`design/source/Attachments.dc.html`](design/source/Attachments.dc.html) (`design/images/attachments/`)
- [ ] Tái cấu trúc từng sub-section theo đúng HTML/CSS của từng component tương ứng

### 3.4 — Description Markdown Editor (WYSIWYG)
- **Source HTML**: [`design/source/DescriptionMarkdown.dc.html`](design/source/DescriptionMarkdown.dc.html)
- **Visual Spec**: [`design/images/description-markdown/`](design/images/description-markdown/)
- [ ] Tích hợp WYSIWYG editor (TipTap/Lexical) với thanh công cụ toolbar nổi, định dạng code block JetBrains Mono

### 3.5 — New Ticket Modal Restyle
- **Source HTML**: [`design/source/NewTicket.dc.html`](design/source/NewTicket.dc.html)
- **Visual Spec**: [`design/images/new-ticket/`](design/images/new-ticket/)
- [ ] Restyle form tạo ticket mới đồng bộ với thiết kế

---

## Phase 4 — New Feature Components

### 4.1 — Test Cases Panel (Rewrite hoàn toàn)
- **Source HTML**: [`design/source/TestCases.dc.html`](design/source/TestCases.dc.html)
- **Visual Spec**: [`design/images/test-cases/`](design/images/test-cases/)
- [ ] Bảng Test Case: Pass, Fail, Running (với pulsating ring), Pending
- [ ] Free text markdown cho Expected Result
- [ ] Form thêm/sửa test case, hiển thị run history mới nhất

### 4.2 — Debug Space Panel
- **Source HTML**: [`design/source/DebugSpace.dc.html`](design/source/DebugSpace.dc.html)
- **Visual Spec**: [`design/images/debug-space/`](design/images/debug-space/)
- [ ] Timeline 5 loại entry: Investigation, Fix attempt, Root cause, Blocked, Resolved
- [ ] Pin entry quan trọng lên đầu, liên kết branch và test case

### 4.3 — Workspace Panel
- **Source HTML**: [`design/source/Workspace.dc.html`](design/source/Workspace.dc.html)
- **Visual Spec**: [`design/images/workspace/`](design/images/workspace/)
- [ ] Trạng thái retention clock: Auto-delete pending vs Kept forever

### 4.4 — Branches Panel
- **Source HTML**: [`design/source/Branches.dc.html`](design/source/Branches.dc.html)
- **Visual Spec**: [`design/images/branches/`](design/images/branches/)
- [ ] Danh sách git branches liên kết với ticket, trạng thái PR / commit

### 4.5 — Sub-task Grouping trên Board
- **Source HTML**: [`design/source/BoardGrouping.dc.html`](design/source/BoardGrouping.dc.html)
- **Visual Spec**: [`design/images/board-grouping/`](design/images/board-grouping/)
- [ ] Gom nhóm sub-task dưới parent ticket trên Kanban board

---

## Phase 5 — Screen-Level Assembly

### 5.1 — Main Board (Full 6 Columns)
- **Source HTML**: [`design/source/MainBoard.dc.html`](design/source/MainBoard.dc.html)
- **Visual Spec**: [`design/images/main-board/`](design/images/main-board/)
- [ ] Cấu trúc 6 cột: Backlog, Todo, In-Progress, Review, Testing, Done
- [ ] Filter Bar: lọc theo member avatar, tag pill, priority, search text
- [ ] Column header: badge đếm số lượng ticket, accent color dot

### 5.2 — Project Sidebar (Dark Ink Theme)
- **Source HTML**: [`design/source/Main.dc.html`](design/source/Main.dc.html) (L236–248)
- **Visual Spec**: [`design/images/main-board/`](design/images/main-board/)
- [ ] Nền `#253D2C`, logo chip 22px chuẩn thiết kế, switch board toggle, danh sách projects

### 5.3 — List View
- **Source HTML**: [`design/source/ListView.dc.html`](design/source/ListView.dc.html)
- **Visual Spec**: [`design/images/list-view/`](design/images/list-view/)
- [ ] Group by Status / Assignee / Priority / Tags
- [ ] Header bảng, row hover, status chip và priority bars

### 5.4 — Timeline / Gantt View
- **Source HTML**: [`design/source/TimelineView.dc.html`](design/source/TimelineView.dc.html)
- **Visual Spec**: [`design/images/timeline-view/`](design/images/timeline-view/)
- [ ] Thanh bar timeline theo ngày/tuần/tháng
- [ ] Drag bar để reschedule và resize hai đầu để thay đổi thời lượng

### 5.5 — Members Modal
- **Source HTML**: [`design/source/MembersView.dc.html`](design/source/MembersView.dc.html)
- **Visual Spec**: [`design/images/members-view/`](design/images/members-view/)
- [ ] Danh sách thành viên, avatar, role, số lượng ticket đang nắm giữ, nút thêm/xóa thành viên

### 5.6 — Settings Modal
- **Source HTML**: [`design/source/SettingsView.dc.html`](design/source/SettingsView.dc.html)
- **Visual Spec**: [`design/images/settings-view/`](design/images/settings-view/)
- [ ] Cài đặt project, prefix, màu sắc, data folder path, retention policy

---

## Phase 6 — Polish, Micro-interactions & Transitions
- [ ] Hover & focus states toàn diện
- [ ] Shimmer loading & pulse animations
- [ ] Mobile/Tablet responsive adjustments

## Phase 7 — Cleanup & Code Quality
- [ ] Dọn dẹp các CSS module cũ không còn sử dụng
- [ ] Kiểm tra toàn diện TypeScript types, không còn unused imports hoặc types thừa
- [ ] Kiểm tra MCP tools tương thích 100% với models mới
