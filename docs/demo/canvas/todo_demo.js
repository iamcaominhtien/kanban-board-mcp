// Demo PDF: the design of a mobile TODO app presented as an Idea with a Canvas of open, clickable frames.
//
//   1. start the server and the UI (vite on :5173), 2. python docs/demo/canvas/seed_todo_idea.py,
//   3. node docs/demo/canvas/todo_demo.js [output.pdf]
//
// Needs Playwright (require('playwright')). Screens go to $DEMO_DIR (default /tmp/canvas-todo-demo).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const UI = process.env.UI || 'http://127.0.0.1:5173/';
const DIR = (process.env.DEMO_DIR || '/tmp/canvas-todo-demo') + '/';
const OUT = process.argv[2] || path.join(__dirname, '..', 'canvas-demo.pdf');
fs.mkdirSync(DIR, { recursive: true });

const pages = [];
const note = (file, title, bullets) => pages.push({ file, title, bullets });

async function capture() {
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
  p.on('dialog', (d) => { errors.push('DIALOG ' + d.message()); d.dismiss(); });
  const shot = async (name) => { await p.waitForTimeout(500); await p.screenshot({ path: DIR + name + '.png' }); console.log('shot', name); };
  const frame = () => p.frameLocator('[data-testid=canvas-viewer-board] iframe');
  const leave = async () => { await p.evaluate(() => document.activeElement && document.activeElement.blur()); };
  const interact = (on) => p.getByTestId('canvas-interact').evaluate((el, want) => { if ((el.getAttribute('aria-pressed') === 'true') !== want) el.click(); }, on);

  await p.goto(UI, { waitUntil: 'networkidle' });
  await p.getByRole('button', { name: /Idea Space/ }).first().click();
  await p.waitForTimeout(800);
  await p.getByRole('button', { name: /^Inbox/ }).first().click();
  await p.waitForTimeout(1000);
  await shot('01-inbox');
  note('01-inbox', '1. Ghi lại ý tưởng ở Idea Space', [
    'Ý tưởng “Todo app for mobile: design” vào Inbox để triage (Keep / Park / Merge / Archive). Mô tả, vấn đề cần giải, 3 giả định cần kiểm chứng.',
    'Phần Design nằm ngay trong trang ý tưởng, ở bước sau: một Canvas.',
  ]);

  await p.getByText('Open the page').first().click();
  await p.waitForTimeout(3000);
  const embed = p.locator('[data-testid=canvas-embed]').first();
  await embed.scrollIntoViewIfNeeded();
  await embed.hover();
  await shot('02-idea-page');
  note('02-idea-page', '2. Trang ý tưởng có Canvas nhúng', [
    'Một dòng markdown `![Todo app: mobile design](canvas:cv_…)` hiện thành thẻ: 6 frame (4 màn hình phone, bản tablet, bảng design tokens), ghi chú, mũi tên luồng và nhãn tiêu đề.',
    'Rê chuột: Edit · Download · View full size · Copy link.',
  ]);

  await embed.getByText('View full size').click();
  await p.waitForSelector('[data-testid=canvas-viewer]');
  await p.waitForTimeout(2500);
  await shot('03-large-view');
  note('03-large-view', '3. View full size: mỗi frame là một trang web thật', [
    'Frame “Today” là HTML + CSS + JavaScript thường, mở ra như file trong trình duyệt (không còn bị khóa script). Công tắc Desktop / Tablet / Phone vẽ lại cùng một trang ở bề rộng 1280 / 820 / 390; mặc định theo cỡ của frame (frame phone mở ở Phone).',
    'Nút **Try it** (phím I) cho trang nhận click và phím để bấm thử prototype.',
  ]);

  await p.getByTestId('canvas-interact').click();
  await p.getByRole('button', { name: 'Phone' }).first().click();
  await p.waitForTimeout(800);
  await frame().locator('.task').nth(0).locator('.chk').click();
  await p.waitForTimeout(500);
  await shot('04-try-it');
  note('04-try-it', '4. Try it: bấm thử, có logic thật', [
    'Tick một công việc: vòng tiến độ và dòng “2 of 3 done” đổi ngay, toast hiện lên. Đây là JavaScript chạy trong frame; trước đây bộ lọc xóa mọi script và handler.',
    'Frame cũng gọi được CDN (React, Tailwind, thư viện icon), font và ảnh ngoài.',
  ]);

  await interact(false);
  await leave();
  await p.keyboard.press('ArrowRight');
  await p.waitForTimeout(1500);
  await interact(true);
  await frame().locator('#t').fill('Pay the electricity bill');
  await frame().locator('#pr .chip').nth(2).click();
  await shot('05-new-task');
  note('05-new-task', '5. Màn “New task”', [
    'Bottom sheet: tiêu đề, ghi chú, chip ưu tiên (Low / Medium / High), hạn (Today, Tomorrow…). Chọn High rồi bấm Add task.',
  ]);
  await frame().locator('button.btn').click();
  await p.waitForTimeout(600);
  await interact(false);
  await leave();
  await p.keyboard.press('ArrowLeft');
  await p.waitForTimeout(1500);
  await p.getByRole('button', { name: 'Phone' }).first().click();
  await shot('06-today-after-add');
  note('06-today-after-add', '6. Sang lại “Today”: việc vừa thêm đã có', [
    'Các frame cùng một địa chỉ nên dùng chung localStorage: việc thêm ở frame “New task” hiện ở frame “Today”. Một prototype nhiều màn hình chia sẻ dữ liệu như app thật.',
  ]);

  await p.keyboard.press('g');
  await shot('07-all-frames');
  await p.keyboard.press('g');
  await p.locator('[data-testid=canvas-filmstrip] button').nth(4).click();
  await p.waitForTimeout(1800);
  await p.getByRole('button', { name: 'Tablet' }).first().click();
  await p.waitForTimeout(1000);
  await shot('08-tablet');
  note('07-all-frames', '7. Phím G: tất cả frame', ['Lưới 4 màn hình phone, bản tablet và bảng design tokens; bấm để nhảy tới frame.']);
  note('08-tablet', '8. Cùng một trang, bố cục tablet', [
    'Cùng HTML của “Today” nhưng ở 820 px: danh sách bên trái, chi tiết bên phải (media query `@media (min-width: 700px)`). Hướng dẫn cho AI cũng yêu cầu viết frame responsive để công tắc Desktop / Tablet / Phone có nghĩa.',
  ]);

  await p.getByTestId('canvas-open-editor').click();
  await p.waitForSelector('[data-testid=canvas-editor]');
  await p.waitForTimeout(2500);
  await p.keyboard.press('Escape');
  await p.keyboard.press('0');
  await p.waitForTimeout(1200);
  await shot('09-editor-fit');
  await p.getByRole('button', { name: /Zoom in/i }).click();
  await p.getByRole('button', { name: /Zoom in/i }).click();
  await p.waitForTimeout(1800);
  await shot('09-editor');
  note('09-editor', '9. Canvas editor: mặt phẳng lớn', [
    'Các màn hình xếp cạnh nhau theo luồng, mũi tên có nhãn (“+ button”, “tap a task”, “Upcoming tab”), ghi chú màu, nhãn tiêu đề. Kéo để sắp xếp: không cần lock, hai người sửa cùng lúc được (merge theo từng item).',
  ]);
  await p.keyboard.press('0');
  await p.waitForTimeout(1000);
  const boxes = p.locator('[data-testid=canvas-board]');
  const b0 = await boxes.nth(0).boundingBox();
  await p.mouse.click(b0.x + b0.width / 2, b0.y + b0.height / 2);
  await p.waitForTimeout(500);
  await p.getByTestId('canvas-board-edit').first().evaluate((el) => el.click());
  await p.waitForSelector('[data-testid=canvas-source-editor]');
  await p.waitForTimeout(2000);
  await shot('10-source');
  note('10-source', '10. Sửa mã nguồn một frame', [
    'Mở = lấy lock của đúng frame đó (huy hiệu “Locked for you”); preview chạy như file mở trong trình duyệt, có công tắc Desktop / Tablet / Phone. Lưu = một version mới.',
  ]);
  await p.getByTestId('canvas-source-cancel').click();
  await p.waitForTimeout(500);
  await p.getByTestId('canvas-comments-btn').click();
  await p.waitForTimeout(800);
  await shot('11-comments');
  note('11-comments', '11. Comment và AI', [
    'Comment ghim lên frame hoặc mặt phẳng; AI comment dưới tên của nó và có thể “Propose a fix” (người xem trước/sau rồi Accept hoặc Reject).',
    'Qua MCP, AI còn tạo được canvas và frame (xem trang sau).',
  ]);
  console.log(errors.join('\n') || 'no page errors or dialogs');
  await br.close();
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
const img = (n) => 'data:image/png;base64,' + fs.readFileSync(DIR + n + '.png').toString('base64');

async function build() {
  let html = `<!doctype html><meta charset=utf-8><style>
@page{size:A4 landscape;margin:0}*{box-sizing:border-box}body{margin:0;font-family:"Plus Jakarta Sans",system-ui,sans-serif;color:#1f2937}
.p{width:297mm;height:210mm;padding:12mm 14mm;page-break-after:always;display:flex;flex-direction:column;gap:5mm;overflow:hidden}
h1{font-size:30px;margin:0}h2{font-size:20px;margin:0}.tag{display:inline-block;background:#eef0ff;color:#3b3bb0;border-radius:999px;padding:2px 10px;font-weight:700;font-size:11px;margin-bottom:6px}
ul{margin:0;padding-left:18px;font-size:12.5px;line-height:1.5;color:#374151}code{background:#f3f4f6;padding:0 4px;border-radius:4px;font-size:11.5px;color:#4338ca}
.shot{flex:1;min-height:0;display:flex;justify-content:center;align-items:flex-start}.shot img{max-width:100%;max-height:100%;border:1px solid #d1d5db;border-radius:8px;box-shadow:0 6px 20px rgba(17,24,39,.15)}
.cover{justify-content:center;background:linear-gradient(135deg,#1f2937,#5b5bd6);color:#fff}.cover h1{font-size:44px}.cover p{font-size:16px;max-width:210mm;line-height:1.6;color:#e0e7ff}
pre{background:#111827;color:#e5e7eb;padding:10px 12px;border-radius:8px;font-size:11px;line-height:1.5;white-space:pre-wrap;margin:0}
</style>`;
  html += `<div class="p cover"><span class="tag">Canvas · PR #247</span><h1>Trình bày design app TODO mobile bằng Idea Space + Canvas</h1>
<p>Một ý tưởng ở Idea Space, kèm một Canvas gồm 4 màn hình phone, bản tablet và bảng design tokens. Frame là trang web mở hoàn toàn (script, CDN, font chạy như mở file trong trình duyệt) nên mockup bấm được và có logic.</p>
<p>Chụp từ ứng dụng thật chạy bằng <code>docs/demo/canvas/seed_todo_idea.py</code> (tự dựng lại trên board của bạn) và <code>docs/demo/canvas/todo_demo.js</code> (tạo lại PDF này).</p></div>`;
  for (const pg of pages) {
    html += `<div class="p"><div><span class="tag">Demo</span><h2>${esc(pg.title)}</h2></div><ul>${pg.bullets.map((x) => '<li>' + esc(x) + '</li>').join('')}</ul><div class="shot"><img src="${img(pg.file)}"></div></div>`;
  }
  html += `<div class="p"><div><span class="tag">MCP</span><h2>AI tạo canvas từ một thư mục (không thêm tool mới)</h2></div>
<ul><li>Action mới <code>docs_write(canvas_create)</code>: mỗi thư mục con có <code>index.html</code> là một frame; <code>frame.json</code> đặt tên và cỡ (<code>"phone" | "tablet" | "desktop" | [w, h]</code>). Mọi frame được kiểm tra trước khi tạo gì cả. Có <code>canvas_id</code> thì thêm frame vào canvas đã có.</li>
<li>Trả về dòng <code>markdown</code> để đặt vào ticket, idea hoặc trang Docs. AI sửa frame có sẵn bằng <code>canvas_update</code>: frame đổi ngay, và History không tạo version cho thay đổi này.</li>
<li>Hướng dẫn MCP bảo AI viết frame responsive (viewport meta, % / flex / grid, media query) vì công tắc Desktop / Tablet / Phone vẽ lại cùng một trang.</li></ul>
<pre>todo/
  today/index.html        frame.json  {"name": "Today", "size": "phone"}
  new-task/index.html     frame.json  {"name": "New task", "size": "phone"}
  tablet/index.html       frame.json  {"name": "Today: tablet", "size": "tablet"}

docs_write(action="canvas_create", owner_kind="idea", owner_id="IDEA-1",
           title="Todo app: mobile design", path="/abs/path/todo")
  → {"id": "cv_…", "markdown": "![Todo app: mobile design](canvas:cv_…)", "boards": [{"id": "b_…", "name": "Today", "w": 390, "h": 844}, …]}</pre></div>`;
  html += `<div class="p"><div><span class="tag">Lưu ý</span><h2>Frame mở hoàn toàn: ai chịu trách nhiệm?</h2></div>
<ul><li>Frame không còn bị lọc script/handler/request ngoài, không có <code>Content-Security-Policy</code> và không có <code>sandbox</code> (Preview file HTML cũng mở như vậy). Export PNG/PDF vẫn vẽ bản tĩnh.</li>
<li>Board chạy local và không có đăng nhập, nên script trong frame gọi được API của chính board (đọc, sửa, xóa ticket). Chỉ mở file ZIP / HTML của người khác khi tin họ.</li>
<li>Trong mặt phẳng, frame là hình có thể kéo; trong large view và Present bật <b>Try it</b> (I) để bấm thử. Khi Try it bật, phím gõ vào trang ở lại trong trang: dùng nút để chuyển frame và đóng.</li></ul></div>`;
  fs.writeFileSync(DIR + 'demo.html', html);
  const br = await chromium.launch();
  const pg = await br.newPage();
  await pg.goto('file://' + DIR + 'demo.html');
  await pg.pdf({ path: OUT, format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
  await br.close();
  console.log('pdf', OUT);
}

(async () => { await capture(); await build(); })();
