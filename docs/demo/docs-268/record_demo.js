// Demo video of #268 (Docs for every AI, and Docs in its own window), recorded from the real desktop app.
//
//   1. a board database with the Docs AI demo data (docs/demo/docs-ai/seed_demo.py against a throwaway server), whose
//      AI member "Reviewer" runs docs/demo/docs-268/demo_reviewer.py (a scripted CLI: no model) as its `cli_path`
//   2. ui/dist built (cd ui && npx vite build), desktop/node_modules installed
//   3. xvfb-run -a -s "-screen 0 1920x1080x24" node docs/demo/docs-268/record_demo.js <seed.db> <out.mp4>
//
// The whole X screen is recorded with ffmpeg (x11grab), so the Docs window and the board are two real app windows
// side by side. Captions are written to a separate band under the picture (never over the app): the screen video is
// padded with a dark band and the captions (an .ass file timed while recording) are drawn in it.
const { _electron: electron } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const [SEED, OUT = path.join(process.cwd(), 'docs-268-demo.mp4')] = process.argv.slice(2);
const WORK = process.env.DEMO_DIR || '/tmp/docs-268-demo';
const W = 1920;
const H = 1080;
const BAND = 150;
const PY = path.join(ROOT, 'server', '.venv', 'bin', 'python');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'userdata'), { recursive: true });
fs.copyFileSync(SEED, path.join(WORK, 'userdata', 'kanban.db'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const caps = [];
let t0 = 0;
let current = null;
function caption(text) {
  const now = (Date.now() - t0) / 1000;
  if (current) current.end = now;
  current = { start: now, end: null, text };
  caps.push(current);
  console.log(`[${now.toFixed(1)}s] ${text}`);
}
function assTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
}
function writeAss(file, total) {
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H + BAND}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Alignment 2 = bottom centre; MarginV keeps the text inside the band under the picture
    `Style: Band,Inter,34,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,80,80,${Math.round(BAND / 2 - 30)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const c of caps) {
    const end = c.end ?? total;
    lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(end)},Band,,0,0,0,,${c.text.replace(/\n/g, '\\N')}`);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function agent(url, step) {
  const out = execFileSync(
    PY,
    [path.join(__dirname, 'external_agent.py'), url, step, path.join(WORK, 'state.json')],
    { cwd: ROOT, encoding: 'utf8' },
  );
  console.log(`  agent ${step}: ${out.trim().split('\n').slice(-1)[0]}`);
}

(async () => {
  const app = await electron.launch({
    cwd: path.join(ROOT, 'desktop'),
    executablePath: path.join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', 'electron'),
    args: ['.', '--no-sandbox', `--user-data-dir=${path.join(WORK, 'userdata')}`],
    env: { ...process.env, KANBAN_SECRET_STORE: 'file', KANBAN_AI_ROOTS: '/tmp' },
    timeout: 120000,
  });
  const bounds = (i, b) =>
    app.evaluate(({ BrowserWindow }, [i, b]) => BrowserWindow.getAllWindows()[i]?.setBounds(b), [i, b]);
  const win = await app.firstWindow();
  await sleep(4000);
  await bounds(0, { x: 0, y: 0, width: W, height: H });
  await sleep(12000);
  const project = await win.evaluate(async () => {
    const r = await fetch(`http://127.0.0.1:${await window.electronAPI.getBackendPort()}/projects`);
    return (await r.json()).find((p) => p.name === 'Kanban Board').id;
  });
  await win.evaluate((p) => {
    localStorage.setItem('activeProjectId', p);
    localStorage.setItem('kanbanActor', 'An Nguyen');
  }, project);
  await win.reload();
  await sleep(6000);
  const port = await win.evaluate(() => window.electronAPI.getBackendPort());
  const MCP = `http://127.0.0.1:${port}/mcp/`;

  const rec = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'x11grab', '-framerate', '25', '-video_size', `${W}x${H}`,
    '-i', process.env.DISPLAY, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    path.join(WORK, 'screen.mp4'),
  ]);
  t0 = Date.now();
  await sleep(800);

  // 1. Docs
  caption('Issue #268 · Docs for every AI, and Docs in its own window · the desktop app, recorded as it runs');
  await win.getByTestId('view-docs').click();
  await sleep(3500);

  // 2. An external agent writes a spec over MCP
  caption('An outside agent, MCP only: it reads docs_guide, then writes a spec page with docs_write(create)');
  agent(MCP, 'setup');
  agent(MCP, 'spec');
  await sleep(2500);
  await win.getByText('Sign-in — spec', { exact: true }).first().click();
  await sleep(3500);
  caption('A highlight, a table, a warning callout, a task list, and two tickets linked by key (KAN-5, KAN-6)');
  await win.mouse.wheel(0, 500);
  await sleep(4500);
  await win.mouse.wheel(0, -500);

  // 3. A picture, one section, a passage
  caption('docs_write(upload): the sign-in design goes into the "Screens" section of the page');
  agent(MCP, 'picture');
  await sleep(4500);
  caption('docs_write(edit, section="Rules"): one section changes; the rest of the page is not sent back');
  agent(MCP, 'edit');
  await win.mouse.wheel(0, 700);
  await sleep(5000);
  caption('docs_write(comment, quote=...): a comment on one passage, highlighted where it is');
  agent(MCP, 'comment');
  await sleep(2500);
  await win.getByRole('button', { name: /Comments/ }).first().click();
  await sleep(4000);

  // 4. A person answers, the agent replies and fixes the table
  caption('A person answers in the thread…');
  const reply = win.getByPlaceholder(/Reply/).first();
  await reply.click();
  await win.keyboard.type('Yes, admins should get a notice. Add it to the rules?', { delay: 25 });
  await win.keyboard.press('Control+Enter');
  await sleep(2500);
  caption('…and the agent reads the thread, answers it, and changes that one table row (docs_write edit, find=...)');
  agent(MCP, 'reply');
  await sleep(5500);
  await win.keyboard.press('Escape');

  // 5. Tickets from the checklist
  caption('docs_write(tickets): the open tasks become tickets, linked to the page, their keys put on their lines');
  agent(MCP, 'tickets');
  await win.mouse.wheel(0, 600);
  await sleep(5500);

  // 6. Give the page to an AI member, see it work on the page
  caption('A person gives the page to the AI member "Reviewer" to review it (page menu › Give to an AI member)');
  await win.mouse.wheel(0, -2000);
  await sleep(800);
  await win.getByRole('button', { name: /More actions|Page actions|More/ }).first().click();
  await sleep(1200);
  await win.getByText(/Give to an AI member/).first().click();
  await sleep(1500);
  await win.getByPlaceholder(/Check the error cases/).fill('Check the lockout rules can be tested');
  await sleep(1200);
  await win.getByRole('button', { name: 'Give the page' }).click();
  caption('The page shows what the AI is doing now (it runs on a ticket linked to the page, as all AI work does)');
  await sleep(9000);
  caption('Its run reads the page over MCP and comments on the passage it questions');
  await sleep(9000);

  // 7. Docs in its own window
  caption('Docs can leave the board: "Open in its own window" (beside the page tree)');
  await win.getByTestId('docs-pop-out').click();
  await sleep(2500);
  await bounds(0, { x: 0, y: 0, width: 1060, height: H });
  await bounds(1, { x: 1060, y: 0, width: W - 1060, height: H });
  await sleep(3500);
  const docsWin = app.windows().find((p) => p !== win);
  caption('The board shows where Docs went; the Docs window works on its own (here: another page)');
  await docsWin.getByTitle(/Expand/).first().click().catch(() => undefined);
  await sleep(800);
  await docsWin.getByText('Auth', { exact: true }).first().click();
  await sleep(4000);
  caption('"Dock back" (or Ctrl+Shift+D) closes the window and opens Docs in the board on the same page');
  await bounds(0, { x: 0, y: 0, width: W, height: H });
  await docsWin.getByTestId('docs-dock-back').click();
  await sleep(5000);
  caption('Server: 12 new tests · desktop: 131 tests · checked in this desktop app with Playwright');
  await sleep(4000);
  const total = (Date.now() - t0) / 1000;
  if (current) current.end = total;
  rec.stdin?.end();
  rec.kill('SIGINT');
  await new Promise((r) => rec.on('close', r));
  await app.close();

  const ass = path.join(WORK, 'captions.ass');
  writeAss(ass, total);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', path.join(WORK, 'screen.mp4'),
    '-vf', `pad=${W}:${H + BAND}:0:0:color=0x14211A,subtitles=${ass}:fontsdir=/usr/share/fonts/opentype/inter`,
    '-c:v', 'libx264', '-crf', '28', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT,
  ]);
  console.log('wrote', OUT);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
