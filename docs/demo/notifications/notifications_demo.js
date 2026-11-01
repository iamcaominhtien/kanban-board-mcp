// Demo PDF of Notifications (#253): drives the real running app and prints docs/demo/notifications-demo.pdf.
//
//   1. start the server on :8000 with the fake CLI and a fresh database, e.g.
//        cd server && KANBAN_AI_ROOTS=/tmp:$HOME KANBAN_DB_PATH=/tmp/notif-demo/kanban.db \
//          KANBAN_CONFIG_DIR=/tmp/notif-demo/config FAKE_CLAUDE_MODE=finish uv run uvicorn main:app --port 8000
//   2. start the UI (vite on :5173) from ui/, and for the "before" screen the UI of main (before this feature) on
//      :5174 (OLD_UI; `git worktree add /tmp/notif-demo/old origin/main`, link ui/node_modules, `npx vite --port 5174`)
//   3. cd server && KANBAN_DB_PATH=/tmp/notif-demo/kanban.db uv run python ../docs/demo/notifications/seed_notifications.py setup
//   4. node docs/demo/notifications/notifications_demo.js [output.pdf]
//
// The script runs the other seed steps itself (eight AI finishing, the Needs you events, the day card) while the
// pages are open, as the features would. The desktop notices come from the real notifier (desktop/notifier.js) run
// with a recording Notification in place of Electron's. Needs Playwright. Screens go to $DEMO_DIR.
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = process.env.UI || 'http://127.0.0.1:5173/';
const OLD_UI = process.env.OLD_UI || 'http://127.0.0.1:5174/';
const API = process.env.BOARD || 'http://127.0.0.1:8000';
const DIR = (process.env.DEMO_DIR || '/tmp/notif-demo/shots') + '/';
const OUT = process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(ROOT, 'docs', 'demo', 'notifications-demo.pdf');
const DB = process.env.KANBAN_DB_PATH || '/tmp/notif-demo/kanban.db';
fs.mkdirSync(DIR, { recursive: true });

// The pages are noted while capturing and saved beside the screenshots, so --build-only prints the same PDF again
let pages = [];
const note = (file, title, bullets) => {
  pages.push({ file, title, bullets });
  fs.writeFileSync(DIR + 'pages.json', JSON.stringify(pages, null, 2));
};
const state = () => JSON.parse(fs.readFileSync(path.join(path.dirname(DB), 'demo-state.json'), 'utf8'));
const seedEnv = { ...process.env, KANBAN_DB_PATH: DB };
const seed = (step, extra = {}) =>
  execFileSync('uv', ['run', 'python', '../docs/demo/notifications/seed_notifications.py', step], {
    cwd: path.join(ROOT, 'server'),
    env: { ...seedEnv, ...extra },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString();
const seedLater = (step, extra = {}) =>
  spawn('uv', ['run', 'python', '../docs/demo/notifications/seed_notifications.py', step], {
    cwd: path.join(ROOT, 'server'),
    env: { ...seedEnv, ...extra },
    stdio: 'ignore',
  });
const get = async (p) => (await fetch(API + p)).json();

// ---------------------------------------------------------------------------------------------------------------
// The desktop notifier, run for real with a recording Notification and app (no Electron here)
// ---------------------------------------------------------------------------------------------------------------

const notices = [];
let badge = null;
function startDesktop() {
  const { startNotifier } = require(path.join(ROOT, 'desktop', 'notifier.js'));
  class RecNotification {
    static isSupported() {
      return true;
    }
    constructor(o) {
      this.o = o;
      this.h = {};
    }
    on(ev, fn) {
      this.h[ev] = fn;
    }
    show() {
      notices.push({ ...this.o, at: new Date().toISOString(), closed: false, ref: this });
    }
    close() {
      const n = notices.find((x) => x.ref === this);
      if (n) n.closed = true;
      if (this.h.close) this.h.close();
    }
  }
  const app = { setBadgeCount: (n) => (badge = n), dock: { setBadge: () => {} } };
  return startNotifier({
    Notification: RecNotification,
    app,
    nativeImage: { createFromBitmap: () => ({}) },
    platform: 'darwin',
    port: Number(new URL(API).port),
    getWindow: () => null, // the window is closed: notifications still come
    onOpen: () => {},
  });
}

async function capture() {
  const s = state();
  const br = await chromium.launch();
  const errors = [];
  const shotOf = (p) => async (name) => {
    await p.waitForTimeout(600);
    await p.screenshot({ path: DIR + name + '.png' });
    console.log('shot', name);
  };

  // ---- Before: the old app, eight AI finish at once -------------------------------------------------------------
  let haveOld = true;
  try {
    await fetch(OLD_UI);
  } catch {
    haveOld = false;
  }
  if (haveOld) {
    const ctx0 = await br.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
    await ctx0.addInitScript((id) => localStorage.setItem('activeProjectId', id), s.agy);
    const o = await ctx0.newPage();
    await o.goto(OLD_UI, { waitUntil: 'networkidle' });
    await o.waitForTimeout(2000);
    const run = seedLater('finish8', { FINISH_AFTER: '6' });
    await new Promise((r) => run.on('exit', r));
    await o.waitForTimeout(4000);
    await shotOf(o)('01-before');
    note('01-before', '1. Trước: tám AI xong cùng lúc là tám toast', [
      'Ứng dụng trước tính năng này (nhánh main), cùng dữ liệu: 8 AI member xong việc trong vài giây. Mỗi cái là một toast 8 giây, không giới hạn, chồng lên nhau che màn hình — và hết 8 giây thì mất, không lưu ở đâu.',
      'Sáu tính năng (run AI, lịch, Docs publish, Docs comment, tài khoản AI, AI safety) mỗi cái tự theo dõi dữ liệu và tự bật toast. Chỉ AI safety có lưu, và sự kiện “nhẹ” của nó bị giữ tới 9:00 sáng hôm sau.',
    ]);
    await ctx0.close();
  } else {
    seed('finish8', { FINISH_AFTER: '0.5' });
  }

  // ---- After: the desktop notifier follows the log from now on ---------------------------------------------------
  const desktop = startDesktop();
  await new Promise((r) => setTimeout(r, 1500));

  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
  const shot = shotOf(p);
  await p.goto(`${UI}?proj=${s.kan}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);

  // The Needs you events arrive while the person is looking: at most three toasts
  seed('needs');
  await p.waitForTimeout(4000);
  await shot('02-toasts');
  const title = await p.title();
  note('02-toasts', '2. Sau: tối đa 3 toast, cái thứ 4 gộp thành “+N more”', [
    'Bốn việc “Needs you” đến cùng lúc khi bạn đang nhìn (BA Bao hỏi, Dev An xin duyệt, run #3 trên MOB-77 lỗi, tài khoản Work Claude bị đăng xuất). Toast chỉ dành cho việc cần bạn; tối đa 3 cái, cái cũ nhất gộp vào “+1 more · in Notifications · Open”.',
    'Tám AI xong việc ở bước 1 không bật toast nào nữa: chúng thành một dòng trong tab Updates.',
    `Chuông trên thanh trên cùng: số đỏ = chỉ việc Needs you. Bản web cũng hiện số ở tiêu đề tab: “${title}”.`,
  ]);

  // The bell and the Needs you tab (the toasts have gone by then: each lives 12 s)
  await p.waitForTimeout(12000);
  await p.keyboard.press('n');
  await p.waitForTimeout(1200);
  await shot('03-panel-needs');
  note('03-panel-needs', '3. Chuông và panel: tab Needs you', [
    'Panel mở đè bên phải, không đẩy trang. Needs you trước, việc chờ lâu nhất lên đầu. Mỗi dòng: ai, làm gì, ở đâu (chip AI member, ticket, project), đã chờ bao lâu.',
    'Hành động ngay trên dòng: Answer (trả lời ngay tại đây như trong ticket), Approve / Deny / Review, Retry / Open run log, Sign in again.',
    'Đọc không phải là xong: mở panel không làm giảm số đỏ; chỉ làm xong việc mới giảm.',
  ]);

  // Hover: Snooze and Mute
  const row = p.locator('[aria-label="Notifications"] article, [aria-label="Notifications"] [data-row]').first();
  if (await row.count()) await row.hover();
  else await p.mouse.move(1240, 190);
  await p.waitForTimeout(500);
  await shot('04-row-hover');
  note('04-row-hover', '4. Một dòng: Snooze và Mute khi rê chuột', [
    'Rê chuột hiện Snooze (1 giờ, tối nay, sáng mai) và Mute this ticket ngay trên hàng nút, dòng không cao lên.',
    'Snooze ẩn dòng và trả lại đúng giờ, không bao giờ coi là xong việc. Mute không bao giờ giấu được việc Needs you gửi cho bạn.',
  ]);

  // Updates: eight AI finished = one row, expanded
  await p.getByRole('tab', { name: /Updates/ }).click();
  await p.waitForTimeout(1000);
  await shot('05-panel-updates');
  note('05-panel-updates', '5. Tab Updates: tám AI xong = một dòng', [
    '“8 AI finished work — Reviewer Rin, Dev Gem, Dev An, QA Quy and 1 more · AGT-13 to AGT-20”: cùng loại, cùng project, trong 10 phút thì gộp; dòng đếm tiếp và nhảy lên đầu khi có thêm. Trên 20 thì ghi “20+”.',
    'Tab này không bao giờ làm phiền: không toast, không desktop, không số đỏ — chuông chỉ có chấm xanh. Kèm: trang Docs được publish trong space bạn theo dõi, reply trong thread bạn theo dõi, lịch chạy xong.',
  ]);
  const showAll = p.getByRole('button', { name: /Show all 8/ });
  if (await showAll.count()) {
    await showAll.first().click();
    await p.waitForTimeout(800);
  }
  await shot('06-group-expanded');
  note('06-group-expanded', '6. Mở dòng gộp', [
    'Mỗi AI một dòng với ticket và nút Open. Một nhóm được đọc như một khối; mở một dòng bên trong không đánh dấu đã đọc phần còn lại.',
    'Desktop chỉ nhận một thông báo cho cả nhóm (và mặc định tắt cho loại “For information”).',
  ]);

  // Answer in the ticket and watch the row close itself
  await p.getByRole('tab', { name: /Needs you/ }).click();
  await p.waitForTimeout(600);
  await p.getByRole('button', { name: 'Open ticket' }).first().click();
  await p.waitForTimeout(2500);
  const aiView = p.getByTestId('view-ai').first();
  if (await aiView.count()) {
    await aiView.click();
    await p.waitForTimeout(1200);
  }
  const input = p.getByTestId('ai-answer-input').first();
  if (await input.count()) {
    await input.scrollIntoViewIfNeeded();
    const opt = p.getByTestId('question-option').filter({ hasText: 'No' }).first();
    if (await opt.count()) await opt.click();
    else await input.fill('No, only open tickets.');
    await shot('07-ticket-question');
    note('07-ticket-question', '7. Trả lời ngay trong ticket KAN-215', [
      '“Open ticket” trên dòng thông báo mở ticket; câu hỏi của BA Bao nằm ở tab AI activity như trước. Bạn trả lời ở đây — không cần đụng tới thông báo.',
    ]);
    await p.getByTestId('ai-answer-send').first().click();
    await p.waitForTimeout(900);
    await shot('08-quiet-line');
    note('08-quiet-line', '8. Phản hồi thao tác là một dòng xám, không phải toast', [
      '“Answer sent · BA Bao resumes the run.” hiện thành dòng xám nhỏ ở đáy cửa sổ 2 giây: không icon, không nút đóng, không lưu lịch sử. “Saved”, “Copied”, “Moved to Done” cũng vậy.',
      'Toast chỉ còn ba lý do: việc Needs you khi bạn đang nhìn, thao tác của bạn bị lỗi, và lời mời Undo.',
    ]);
  }
  const home = async () => {
    await p.goto(`${UI}?proj=${s.kan}`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(1500);
  };
  await p.waitForTimeout(1500);
  await home();
  await p.keyboard.press('n');
  await p.waitForTimeout(1500);
  await shot('09-closed-itself');
  note('09-closed-itself', '9. Dòng tự đóng, ở mọi cửa sổ', [
    'Trong vòng một giây dòng chuyển xám với lý do “Done — you answered in the ticket” và xuống mục Done today; số đỏ giảm theo. Cùng một luật cho mọi việc: duyệt/từ chối ở AI Team, đăng nhập lại tài khoản, Retry run, trả lời thread — ở đâu cũng được, kể cả qua MCP.',
    'Server giữ read / done / snoozed theo từng người nhận, nên cửa sổ thứ hai cũng xám theo; toast của sự kiện đã xong tự đóng. Ở đây tài khoản Work Claude cũng đã tự đóng: lần kiểm tra đăng nhập tiếp theo của server thấy nó đã đăng nhập lại (“Done — the account signed in again”).',
  ]);
  await home();

  // All notifications
  await p.keyboard.press('Shift+N');
  await p.waitForTimeout(1500);
  await shot('10-all-page');
  note('10-all-page', '10. Trang All notifications', [
    'Mọi project, tìm kiếm, bộ lọc All · Unread · Needs you · Snoozed · Done · Cleared, khoảng ngày, lọc theo project và loại (For information / From AI members / From people / Schedules). Giữ 90 ngày (một setting).',
    'Mở bằng nút ở chân panel, Shift N, hoặc mục Notifications ở sidebar khi có việc chờ.',
  ]);
  const needsTab = p.locator('button, [role=tab]').filter({ hasText: /^Needs you/ }).first();
  if (await needsTab.count()) {
    await needsTab.click();
    await p.waitForTimeout(1000);
    await shot('11-all-needs');
    note('11-all-needs', '11. Lọc Needs you', [
      'Chỉ những việc còn chờ bạn. Dòng của ticket đã bị xoá sẽ ghi rõ “KAN-… was deleted, so this cannot be answered.” và chỉ còn Dismiss — Dismiss cũng là một cách hoàn tất (“Dismissed by you”), không xoá lặng lẽ.',
    ]);
  }

  // The day card
  seed('daycard');
  await home();
  await p.keyboard.press('n');
  await p.waitForTimeout(800);
  await p.getByRole('tab', { name: /Updates/ }).click();
  await p.waitForTimeout(1200);
  await shot('12-day-card');
  note('12-day-card', '12. Một ngày trong một thẻ', [
    'Viết lúc 18:00 các ngày làm việc (giờ và ngày là setting), từ chính log thông báo và các run — không hỏi AI nên không tốn gì và không bịa. Số run xong, lỗi, việc còn chờ, chi phí; mỗi project một dòng; Docs; việc còn snooze; lịch ngày mai.',
    'Đứng đầu tab Updates tới thẻ hôm sau. Thay digest AI safety 9:00 cũ (đã bỏ). Board health 9:00 vẫn giữ riêng.',
  ]);
  await home();

  // Settings › Notifications
  await p.evaluate(() =>
    window.dispatchEvent(new CustomEvent('kanban:notifications', { detail: { open: 'settings' } })),
  );
  await p.waitForTimeout(1800);
  await shot('13-settings');
  note('13-settings', '13. Settings › Notifications', [
    'Một trang riêng trong App settings, áp dụng cho mọi project. Mỗi loại sự kiện có In app và Desktop. In app của nhóm Needs you bị khoá bật: một AI đang chờ câu trả lời mà không có dòng nào thì sẽ chờ mãi. Server cũng từ chối tắt nó.',
    'Tắt là im lặng, không phải không ghi: sự kiện vẫn có trên trang All notifications và trong thẻ ngày.',
  ]);
  await p.mouse.wheel(0, 900);
  await p.waitForTimeout(800);
  await shot('14-settings-more');
  note('14-settings-more', '14. Desktop, giờ yên lặng, thẻ ngày, thời gian giữ, danh sách Muted', [
    'Desktop notifications (công tắc tổng) và Send a test; Quiet hours 22:00–08:00; theo Do not disturb của máy; âm thanh; thẻ ngày; giữ 90 ngày. Mọi thứ đã Mute từ một dòng hay một ticket đều hiện ở đây để bỏ Mute.',
  ]);

  // Follow bell on a ticket
  await home();
  await p.getByText('Assign the release checklist').first().click();
  await p.waitForTimeout(1500);
  const bell = p.locator('[aria-label*="ollow"], [title*="ollow"]').first();
  if (await bell.count()) {
    await bell.click();
    await p.waitForTimeout(600);
  }
  await shot('15-follow');
  note('15-follow', '15. Theo dõi và tắt tiếng một ticket', [
    'Nút chuông trên header ticket (và trang Docs): Following · Everything · Only mentions and questions · Muted · Mute for 1 hour. Mặc định bạn theo dõi những gì bạn yêu cầu, được nhắc tới hoặc bắt đầu.',
    'Mute không giấu được việc Needs you gửi cho bạn — AI hỏi bạn trên ticket đã mute vẫn tới, vì không ai khác gỡ được nó.',
  ]);
  await ctx.close();
  await br.close();

  // The desktop notices the notifier sent while all this happened (window "closed")
  await new Promise((r) => setTimeout(r, 1500));
  desktop.stop();
  fs.writeFileSync(DIR + 'notices.json', JSON.stringify({ notices: notices.map(({ ref, ...n }) => n), badge }, null, 2));
  if (errors.length) console.log(errors.join('\n'));
}

const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const img = (n) => 'data:image/png;base64,' + fs.readFileSync(DIR + n + '.png').toString('base64');

function desktopPage() {
  const { notices: ns, badge: b } = JSON.parse(fs.readFileSync(DIR + 'notices.json', 'utf8'));
  const card = (n) => `<div class="os"><div class="osh"><span class="app">▣</span><b>Kanban Board</b><span class="now">${new Date(n.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span></div>
<div class="ost">${esc(n.title)}</div><div class="osb">${esc(n.body || '')}</div>
${(n.actions || []).length ? `<div class="osa">${n.actions.map((a) => `<span>${esc(a.text)}</span>`).join('')}</div>` : ''}${n.closed ? '<div class="osw">withdrawn: its event was resolved</div>' : ''}</div>`;
  return `<div class="p"><div><span class="tag">Demo</span><h2>16. Thông báo desktop: notifier trong Electron main process</h2></div>
<ul><li>Đây là các thông báo mà <code>desktop/notifier.js</code> thật đã gửi trong lúc chạy demo, với cửa sổ đóng (<code>getWindow() → null</code>) — notifier theo dõi log qua <code>/events</code> và <code>/notifications/feed?since=</code>, không phải <code>new Notification()</code> từ trang. Electron được thay bằng một <code>Notification</code> ghi lại; hệ điều hành vẽ thẻ thật, ở đây chỉ vẽ lại nội dung nó nhận.</li>
<li>Chỉ việc Needs you; tối đa một thông báo mỗi 20 giây, phần còn lại gộp thành một (“N things need you”); thông báo của sự kiện đã xong bị thu hồi; bấm vào mở đúng thứ đó (ticket, run, tài khoản). Số trên dock: <b>${b ?? '–'}</b> (chỉ Needs you). Một máy một thông báo, dù mở hai cửa sổ.</li></ul>
<div class="oswrap">${ns.length ? ns.map(card).join('') : '<p>Không có thông báo nào được gửi.</p>'}</div></div>`;
}

async function build() {
  if (!pages.length && fs.existsSync(DIR + 'pages.json')) pages = JSON.parse(fs.readFileSync(DIR + 'pages.json', 'utf8'));
  if (!pages.length) throw new Error('No screenshots noted: run the capture first (without --build-only)');
  let html = `<!doctype html><meta charset=utf-8><style>
@page{size:A4 landscape;margin:0}*{box-sizing:border-box}body{margin:0;font-family:"Plus Jakarta Sans",system-ui,sans-serif;color:#1E2A22}
.p{width:297mm;height:210mm;padding:12mm 14mm;page-break-after:always;display:flex;flex-direction:column;gap:5mm;overflow:hidden}
h1{font-size:30px;margin:0}h2{font-size:20px;margin:0}.tag{display:inline-block;background:#E8F2EA;color:#2E6F40;border-radius:999px;padding:2px 10px;font-weight:700;font-size:11px;margin-bottom:6px}
ul{margin:0;padding-left:18px;font-size:12.5px;line-height:1.5;color:#374151}code{background:#F6FAF7;padding:0 4px;border-radius:4px;font-size:11.5px;color:#2E6F40}
.shot{flex:1;min-height:0;display:flex;justify-content:center;align-items:flex-start}.shot img{max-width:100%;max-height:100%;border:1px solid #d1d5db;border-radius:8px;box-shadow:0 6px 20px rgba(17,24,39,.15)}
.cover{justify-content:center;background:linear-gradient(135deg,#1E2A22,#2E6F40);color:#fff}.cover h1{font-size:44px}.cover p{font-size:16px;max-width:220mm;line-height:1.6;color:#DDEFE2}
.oswrap{display:flex;flex-wrap:wrap;gap:14px;align-content:flex-start}.os{width:340px;background:rgba(246,246,246,.96);border:1px solid #d6d6d6;border-radius:14px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.12);font-family:-apple-system,system-ui,sans-serif}
.osh{display:flex;gap:6px;align-items:center;font-size:11px;color:#555}.osh .now{margin-left:auto}.app{color:#2E6F40}.ost{font-weight:700;font-size:13px;margin-top:4px}.osb{font-size:12px;color:#333;margin-top:2px}
.osa{display:flex;gap:6px;margin-top:8px}.osa span{flex:1;text-align:center;background:#e9e9e9;border-radius:7px;padding:4px;font-size:12px}.osw{margin-top:6px;font-size:11px;color:#C4432A}
</style>`;
  html += `<div class="p cover"><span class="tag">Notifications · #253 · PR #251</span><h1>Một nơi cho việc cần bạn và những gì đã xảy ra</h1>
<p>Chuông và panel, trang All notifications, hai loại thông báo (Needs you / For information), gộp nhóm, thông báo tự đóng khi việc đã xong ở nơi khác, toast ít hơn, notifier desktop trong Electron main process, theo dõi và tắt tiếng, trang Settings › Notifications và thẻ tóm tắt cuối ngày.</p>
<p>Chụp từ ứng dụng thật (1440×900): <code>docs/demo/notifications/seed_notifications.py</code> dựng dữ liệu, <code>docs/demo/notifications/notifications_demo.js</code> chạy các bước và in lại PDF này.</p></div>`;
  for (const pg of pages) {
    html += `<div class="p"><div><span class="tag">Demo</span><h2>${esc(pg.title)}</h2></div><ul>${pg.bullets.map((x) => '<li>' + esc(x) + '</li>').join('')}</ul><div class="shot"><img src="${img(pg.file)}"></div></div>`;
  }
  html += desktopPage();
  html += `<div class="p"><div><span class="tag">Dữ liệu</span><h2>Log sự kiện là nguồn</h2></div>
<ul><li>Một log chỉ ghi thêm (<code>notify_event</code>, id tăng dần, không bao giờ dùng lại kể cả sau khi xoá theo retention). Mỗi sự kiện thành một dòng <code>notification</code> cho mỗi người nhận — một người hoặc một AI member (<code>ai:&lt;id&gt;</code>) — với read, done và lý do, snoozed, cleared.</li>
<li>Panel, notifier desktop và (sau này) một AI bên ngoài chờ trên board đều đọc cùng một thứ: <code>/notifications/feed?since=N</code>, <code>/notifications/log?since=N</code>; cursor cũ hơn phần còn giữ nhận <code>cursor_too_old</code> và bắt đầu từ <code>head</code>.</li>
<li><code>/events</code> chỉ báo “log đã tới id N”; cửa sổ tự hỏi phần chưa thấy, nên mất một tin nhắn không mất gì. Thay đổi từ tiến trình MCP stdio đến qua database watcher.</li>
<li>Sáu notifier cũ (runs, schedules, Docs publish, Docs comment, AI accounts, AI safety) đã bỏ khỏi UI; server ghi vào log, nên không có gì đến hai lần. Digest AI safety 9:00 đã bỏ. Chi tiết: <code>docs/specs/notifications.md</code>.</li></ul></div>`;
  fs.writeFileSync(DIR + 'demo.html', html);
  const br = await chromium.launch();
  const pg = await br.newPage();
  await pg.goto('file://' + DIR + 'demo.html');
  await pg.pdf({ path: OUT, format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
  await br.close();
  console.log('pdf', OUT);
}

(async () => {
  if (process.argv.includes('--build-only')) return build();
  await capture();
  await build();
})();
