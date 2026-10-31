const { chromium } = require('playwright');
const fs = require('fs');
const dir = '/tmp/cvdemo/pdf/';
const pages = [
  ['01-ticket-card', 'Canvas trong mô tả ticket', ['Một dòng markdown `![Login redesign](canvas:cv_…)` hiện thành thẻ: tổng quan các frame (live), chân thẻ có tên, số frame, ai sửa và khi nào.', 'Rê chuột: Edit · Download · View full size · Copy link, và menu ⋯ (Move to Docs, Save as copy, Remove from text).', 'Dòng thứ hai chỉ nhúng một frame (`#b_…`); dòng dạng link là chip trong câu. Design: mục G1–G3.']],
  ['02-large-view', 'Large view (bấm vào thẻ)', ['Đi qua từng frame theo thứ tự, filmstrip, chuyển Desktop / Tablet / Phone, panel Comments. Chỉ đọc, không cần lock — ai cũng dùng được.', 'Frame HTML chạy trong iframe `sandbox=""` do API phục vụ với CSP chỉ cho vẽ. Design: H1.']],
  ['03-all-boards-grid', 'Phím G: tất cả frame', ['Lưới mọi frame của tab trang hiện tại; bấm để nhảy tới. Design: H2.']],
  ['04-editor-fit', 'Editor: mặt phẳng (Fit)', ['Header (tên, nơi chứa, AI, Comments, History, Present, Download, Save a copy, Done), tab trang, thanh công cụ 7 nút, zoom 10–400 %, map.', 'Dưới 40 % frame hiện ảnh chụp trạng thái cuối; từ 40 % vẽ live. Ghi chú, nhãn, mũi tên có nhãn, ghim comment. Design: C1, D, I.']],
  ['05-board-selected', 'Chọn một frame (phím 2: zoom vào vùng chọn)', ['8 tay nắm để đổi cỡ (320–1920), kéo để di chuyển có guide snap; thanh Open · Edit · Ask AI · Comment · ⋯ hiện khi rê/chọn.', 'Di chuyển, đổi cỡ, ghi chú, mũi tên, comment KHÔNG cần lock và merge theo từng item. Design: D1.']],
  ['06-board-menu', 'Menu frame', ['Edit (khoá frame cho bạn), Ask AI, Rename, Size (Desktop/Laptop/Wide/Tablet/Phone/Custom), Duplicate, Replace content, Download, Copy board as image, Copy link, Delete. Design: D3.']],
  ['07-comments-panel', 'Panel Comments', ['Thread theo từng frame, filter Open / Resolved / Only this board / Only mine / Written by AI; reply, resolve, Create ticket, Copy link.', 'Comment của AI có huy hiệu AI và nút **Propose a fix**. Design: C2, F.']],
  ['08-boards-panel', 'Panel Boards (frames)', ['Danh sách frame của tab hiện tại với thumbnail, cỡ, loại, số comment mở; kéo hàng để đổi thứ tự dùng cho Present và viewer. Design: C3.']],
  ['09-blocked-content', 'Nội dung bị chặn', ['Trang “Promo banner” cố chạy script, tải analytics và pixel ngoài: tất cả bị bỏ và liệt kê trong chip “N blocked” (script, event handler, request tới host nào). Design: L (Blocked content).']],
  ['10-ai-proposal', 'AI đề xuất (before / after)', ['Designer AI đề xuất đổi 2 frame. Thấy trước/sau trong hai frame khoá; Accept both / Accept this one / Reject. Chưa có gì được lưu (“Version 3 · nothing is saved yet”). Design: E3.']],
  ['11-proposal-source-diff', 'Compare in source', ['Các dòng thay đổi được tô sáng theo từng file.']],
  ['12-ask-ai', 'Ask AI (Ctrl J)', ['Chọn frame, nhấn Ctrl J, nói điều muốn đổi. AI đọc nguồn frame + ghi chú + comment (là dữ liệu không đáng tin) rồi tạo proposal; trong lúc làm, frame có ribbon tím. Dùng chung thành viên AI, ngân sách, kill switch của Docs AI. Design: E2.']],
  ['13-locked-by-someone', 'Frame đang có người sửa', ['Ribbon xanh “An Nguyen is editing”; vẫn xem, comment, di chuyển được; nút Edit tắt. Design: D1, E4.']],
  ['14-lock-card', 'Thẻ khi bấm Edit vào frame đang bị khoá', ['Nói rõ ai đang sửa và khi nào lock kết thúc (lưu / huỷ / đóng / idle 10 phút). Design: E4.']],
  ['15-source-editor', 'Source editor + preview khoá', ['Mở = lấy lock (huy hiệu “Locked for you”), file tabs, preview live dùng đúng khung “Safe preview” của Preview (không script, không request ngoài), Desktop/Tablet/Phone. Bản nháp giữ trên máy. Design: E1.']],
  ['16-conflict', '“Someone saved in the meantime”', ['Hoa Mai đã di chuyển cùng frame trong lúc bạn kéo nó → chỉ khi cùng một item bị đổi bởi hai người mới hiện thẻ: Save as copy / Load theirs / Replace theirs. Không mất gì. Design: L.']],
  ['17-history', 'History', ['Mỗi Done, mỗi proposal được chấp nhận, mỗi lần restore (và 10 phút một lần với canvas là trang Docs) tạo một version; có thể đặt tên, xem, restore (tạo version mới). Design: J1.']],
  ['17b-proposal-waits-for-lock', 'AI không bao giờ lấy lock của người', ['Frame đang bị khoá nên proposal được giữ và chờ: “Designer AI is waiting for …”. Accept bị tắt đến khi lock kết thúc. Design: E4.']],
  ['18-compare', 'Compare với phiên bản trước', ['Hai ảnh cạnh nhau cho từng frame, danh sách Changed / Same / Added / Removed. Design: J2.']],
  ['19-compare-source-diff', 'Source diff', ['Diff từng dòng của nguồn HTML giữa hai version.']],
  ['20-present', 'Present', ['Toàn màn hình tối, từng frame theo thứ tự, thanh nhỏ tự ẩn sau 3 giây, bật/tắt Notes và Comments. Chỉ đọc, không lock. Design: H3.']],
  ['21-present-grid', 'Present: lưới (G)', []],
  ['22-download-menu', 'Download / Copy link', ['ZIP tất cả frame, ZIP một frame, PNG 2x của frame, ảnh tổng quan, PDF (một frame mỗi trang), copy link tới canvas / frame, Move to Docs. Design: K.']],
  ['23-keys', 'Phím tắt (?)', ['Mọi phím của mục I trong design.']],
  ['24-new-canvas-dialog', 'Hộp thoại New canvas', ['Nút Canvas ở toolbar markdown (mô tả, comment, ý tưởng, Docs), `/canvas`, hộp thoại New idea, Docs › New page › Canvas, “Open on a canvas” trong Preview. Chọn Blank / From files / Ask AI. Design: B.']],
  ['25-embed-settings', 'Embed settings (Show…)', ['Chọn hiện cả canvas, một frame hay chỉ chip trong câu. Design: G3.']],
  ['26-docs-canvas-page', 'Canvas là trang Docs', ['Trang kiểu canvas có icon layers trong cây; editor cùng bộ nhưng không có Done (tự lưu) và có Share. Move to Docs biến canvas nhúng thành trang mà không đổi id. Design: C4, C5.']],
];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/`([^`]+)`/g, '<code>$1</code>');
const img = (n) => 'data:image/png;base64,' + fs.readFileSync(dir + n + '.png').toString('base64');
const extra = fs.existsSync('/tmp/cvdemo/evidence.json') ? JSON.parse(fs.readFileSync('/tmp/cvdemo/evidence.json')) : {};
let html = `<!doctype html><meta charset=utf-8><style>
@page{size:A4 landscape;margin:0}*{box-sizing:border-box}body{margin:0;font-family:"Plus Jakarta Sans",system-ui,sans-serif;color:#1E2A22}
.p{width:297mm;height:210mm;padding:12mm 14mm;page-break-after:always;display:flex;flex-direction:column;gap:5mm;overflow:hidden}
h1{font-size:30px;margin:0}h2{font-size:20px;margin:0}.tag{display:inline-block;background:#E8F1FA;color:#244E78;border-radius:999px;padding:2px 10px;font-weight:700;font-size:11px;margin-bottom:6px}
ul{margin:0;padding-left:18px;font-size:12.5px;line-height:1.5;color:#3A4A3E}code{background:#F1F5F2;padding:0 4px;border-radius:4px;font-size:11.5px;color:#2E6F40}
.shot{flex:1;min-height:0;display:flex;justify-content:center;align-items:flex-start}.shot img{max-width:100%;max-height:100%;border:1px solid #D0D9D3;border-radius:8px;box-shadow:0 6px 20px rgba(30,42,34,.15)}
.cover{justify-content:center;background:linear-gradient(135deg,#1E2A22,#2E6F40);color:#fff}.cover h1{font-size:46px}.cover p{font-size:16px;max-width:200mm;line-height:1.6;color:#DCEEE1}
pre{background:#1E2A22;color:#DFEEE4;padding:10px 12px;border-radius:8px;font-size:10.5px;line-height:1.5;white-space:pre-wrap;margin:0}
table{border-collapse:collapse;font-size:12px}td,th{border:1px solid #D0D9D3;padding:4px 9px;text-align:left}th{background:#F6FAF7}
</style>`;
html += `<div class="p cover"><span class="tag">Issue #246 · version 3.17.0</span><h1>Canvas</h1><p>Frame (HTML, ảnh, Sketch, Diagram) cạnh nhau trên một mặt phẳng lớn, kèm ghi chú, mũi tên, nhãn và comment — ngang hàng với Sketch và Diagram, xuất hiện ở mọi nơi chúng xuất hiện, và có thể là một trang Docs.</p>
<p>Demo này được chụp từ ứng dụng thật chạy trên dữ liệu mẫu (ticket KAN-1 “Redesign the sign-in screens”). Tài liệu: <b>docs/specs/canvas.md</b>. Design: <b>design/screens/canvas.md</b>.</p>
<p><b>Quyết định cho 5 câu hỏi ở mục M:</b> (1) gọi là <b>frame</b> trong UI · (2) làm <b>cả hai</b> dạng (nhúng và trang Docs, có Move to Docs) · (3) lịch sử trang luôn hiện canvas <b>mới nhất</b> · (4) giới hạn 60 frame / 5 MB / 50 MB / 10 tab, lock nhả sau 10 phút nhàn rỗi · (5) frame HTML là <b>một thư mục</b> (CSS, ảnh, font), hiển thị trong khung khoá như Preview.</p></div>`;
for (const [n, title, notes] of pages) {
  if (!fs.existsSync(dir + n + '.png')) continue;
  html += `<div class="p"><div><span class="tag">Canvas</span><h2>${esc(title)}</h2></div>${notes.length ? '<ul>' + notes.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : ''}<div class="shot"><img src="${img(n)}"></div></div>`;
}
if (extra.security) html += `<div class="p"><div><span class="tag">Bảo mật</span><h2>Frame HTML không chạy script và không gọi ra ngoài</h2></div><ul><li>Lớp 1: bộ lọc HTML/CSS khi lưu (parser thật, không regex). Lớp 2: header CSP + <code>sandbox</code> khi phục vụ file. Lớp 3: <code>&lt;iframe sandbox=""&gt;</code>.</li><li>Kiểm tra bằng trình duyệt thật: một trang độc hại được ghi thẳng xuống đĩa (bỏ qua lớp 1) vẫn không chạy script, không bật hộp thoại, không có request nào ra ngoài — cả trong large view lẫn khi mở địa chỉ frame riêng.</li></ul><pre>${esc(extra.security)}</pre></div>`;
if (extra.mcp) html += `<div class="p"><div><span class="tag">MCP</span><h2>Không thêm tool mới: 4 action trong docs_read / docs_write</h2></div><ul><li><code>docs_read(canvases)</code>, <code>docs_read(canvas, canvas_id [, board_id, path])</code> · <code>docs_write(canvas_comment)</code>, <code>docs_write(canvas_propose)</code>.</li><li>Agent chỉ đọc, comment và <b>đề xuất</b>; không bao giờ sửa trực tiếp, không lấy lock của người. Cần quyền Edit docs; chỉ chạm canvas của project mình.</li></ul><pre style="font-size:9px;line-height:1.35">${esc(extra.mcp.split('\n').filter((l) => !/updated_at|owner_id|page_id|owner_kind|"x"|"y"/.test(l)).slice(0, 50).join('\n'))}</pre></div>`;
if (extra.tests) html += `<div class="p"><div><span class="tag">Kiểm thử</span><h2>Kết quả</h2></div><pre>${esc(extra.tests)}</pre></div>`;
fs.writeFileSync('/tmp/cvdemo/demo.html', html);
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('file:///tmp/cvdemo/demo.html');
  await p.pdf({ path: '/tmp/cvdemo/canvas-demo.pdf', format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
  await b.close();
  console.log('pdf ok');
})();
