---
title: "BA Spec: Cải thiện Mô tả - Dán ảnh và Tải tệp (IAM-87)"
type: ba
status: draft
version: 1.0.0
created: 2026-04-13
updated: 2026-04-13
authors: [Knowledge Keeper]
ticket: IAM-87
---

# BA Spec: Cải thiện Mô tả để hỗ trợ dán ảnh và tải tệp lên (IAM-87)

## 1. Problem Statement (Vấn đề)
Hiện tại, mô tả (Description) của ticket trong Kanban Board MCP được lưu trữ dưới dạng văn bản Markdown thuần túy. Người dùng muốn chèn hình ảnh minh họa hoặc đính kèm tài liệu vào mô tả phải tải tệp lên một dịch vụ bên ngoài và chèn link thủ công, gây mất thời gian và giảm trải nghiệm người dùng ("ma sát" trong việc tài liệu hóa).

## 2. Goals and Non-goals (Mục tiêu)

### Goals
- Hỗ trợ dán ảnh trực tiếp từ Clipboard vào ô nhập liệu Description.
- Hỗ trợ chọn tệp từ máy tính để tải lên và chèn vào nội dung Description.
- Tự động chèn cú pháp Markdown cho hình ảnh/tệp sau khi tải lên thành công.
- Đảm bảo tính nhất quán với luồng tự động lưu (autosave) hiện tại của editor.

### Non-goals
- Xây dựng một trình soạn thảo Rich Text hoàn chỉnh (WYSIWYG) thay thế Markdown.
- Xây dựng hệ thống quản lý tệp tập trung (Media Library) phức tạp.
- Hỗ trợ kéo thả (Drag and Drop) tệp vào vùng mô tả (deferred).

## 3. Current State (Hiện trạng)
- **Data storage**: `description` được lưu dưới dạng chuỗi (string) Markdown trong cơ sở dữ liệu (SQLite/JSON).
- **Backend**: Python MCP server xử lý lưu trữ ticket thông qua các tool `create_ticket` / `update_ticket`. Chưa có endpoint xử lý upload tệp.
- **Frontend**: Sử dụng `MarkdownEditor` (dựa trên `react-markdown` để render và `textarea` hoặc thư viện tương tự để nhập liệu).

## 4. Recommended Solution (Giải pháp đề xuất)

### Storage Strategy
- Tiếp tục sử dụng định dạng Markdown làm nguồn dữ liệu duy nhất cho `description`.
- Hình ảnh/tệp sẽ được tải lên server và lưu trữ tại thư mục định sẵn (ví dụ: `server/uploads/`).
- Link tệp sau khi upload sẽ được chèn vào vị trí con trỏ trong editor dưới dạng: `![tên_tệp](đường_dẫn_tệp)`.

### Backend Implementation
- Bổ sung endpoint POST `/upload` (hoặc MCP tool tương ứng) để nhận file từ frontend.
- Trả về URL của tệp đã lưu.

### Frontend Implementation
- Lắng nghe sự kiện `onPaste` trên Editor: nếu clipboard chứa dữ liệu hình ảnh, tự động gọi API upload.
- Thêm icon "Tải tệp" (Upload) vào thanh công cụ của Editor.
- Hiển thị trạng thái "Đang tải lên..." (loading indicator) tại vị trí chèn trong khi chờ server phản hồi.

## 5. Functional Flow (Luồng xử lý)

### Paste Image (Dán ảnh)
1. Người dùng nhấn `Ctrl/Cmd + V` trong Description editor.
2. Hệ thống kiểm tra dữ liệu clipboard. Nếu là `image/*`:
   - Chèn dòng tạm thời: `![Uploading image...]()` tại vị trí con trỏ.
   - Gửi yêu cầu upload tệp lên server.
3. Khi server trả về URL (ví dụ: `/uploads/iam-87-abc.png`):
   - Thay thế dòng tạm thời bằng cú pháp Markdown hoàn chỉnh: `![image](/uploads/iam-87-abc.png)`.
4. Trình editor tự động kích hoạt logic `onChange` để autosave nội dung description mới.

### File Upload (Tải tệp)
1. Người dùng nhấn nút Upload trên Toolbar.
2. Hệ thống mở cửa sổ chọn tệp của hệ điều hành.
3. Sau khi người dùng chọn tệp:
   - Thực hiện luồng upload tương tự như phần "Dán ảnh".
   - Nếu là ảnh: sử dụng cú pháp `![name](url)`.
   - Nếu là tệp khác: sử dụng cú pháp `[name](url)`.

## 6. Validation Rules (Quy tắc kiểm tra)
- **Định dạng ảnh hỗ trợ**: `png`, `jpg`, `jpeg`, `gif`, `webp`.
- **Dung lượng tối đa**: 5MB (cấu hình phía server).
- **Security**: 
  - Server-side validate MIME type và extension của tệp.
  - Tên tệp được sanitize (loại bỏ ký tự đặc biệt) trước khi lưu để tránh các lỗi bảo mật path traversal.
  - Phía UI đảm bảo render an toàn (sanitize HTML từ markdown).

## 7. Acceptance Criteria (Tiêu chí nghiệm thu)
- [ ] Người dùng có thể dán ảnh từ clipboard vào Description và ảnh hiển thị đúng sau khi upload.
- [ ] Người dùng có thể nhấn nút Upload để chọn tệp từ máy tính.
- [ ] Cú pháp Markdown được tự động chèn chính xác tại vị trí con trỏ của người dùng.
- [ ] File quá dung lượng hoặc sai định dạng sẽ hiển thị thông báo lỗi (Toast notification).
- [ ] Tệp tải lên thành công được lưu trữ bền vững trên server và có thể truy cập qua URL.
- [ ] Không làm gián đoạn hoặc gây xung đột với tính năng Autosave hiện có.

## 8. Open Implementation Notes
- **UX**: Có thể hiển thị một thanh tiến trình (progress bar) nhỏ nếu tệp lớn.
- **Cleanup**: Cần xem xét logic xóa tệp trên server khi ticket bị xóa hoặc khi link ảnh bị xóa khỏi description (deferred).
- **Editor compatibility**: Đảm bảo tích hợp mượt mà với thư viện Markdown Editor hiện tại đang dùng trong `TicketModal`.

## 9. Out of Scope (Ngoài phạm vi)
- Di chuyển sang trình soạn thảo Rich Text (Draft.js, CKEditor, Quill).
- Quản lý tất cả tệp đính kèm theo danh sách riêng (không nằm trong Description).
- Resize ảnh tự động phía client trước khi upload.
