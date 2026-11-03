// The live check of #268 on video: a board where real Claude Code runs worked (a BA on sonnet wrote two specs on Docs,
// a Dev on haiku read one and built it), shown in the desktop app. The runs happened before recording
// (docs/demo/docs-268/live_setup.py, then ai_team(ask) for each); this walks through what they left.
//
//   xvfb-run -a -s "-screen 0 1920x1080x24" node docs/demo/docs-268/record_live.js <kanban.db> <uploads dir> <out.mp4>
//
// Captions go in a band under the picture, never over the app (as record_demo.js).
const { _electron: electron } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const [DB, UPLOADS, OUT = 'docs-268-live.mp4'] = process.argv.slice(2);
const WORK = process.env.DEMO_DIR || '/tmp/docs-268-live';
const W = 1920;
const H = 1080;
const BAND = 150;
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'userdata', 'uploads'), { recursive: true });
fs.copyFileSync(DB, path.join(WORK, 'userdata', 'kanban.db'));
for (const f of fs.readdirSync(UPLOADS)) fs.copyFileSync(path.join(UPLOADS, f), path.join(WORK, 'userdata', 'uploads', f));

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
const assTime = (s) =>
  `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;

(async () => {
  const app = await electron.launch({
    cwd: path.join(ROOT, 'desktop'),
    executablePath: path.join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', 'electron'),
    args: ['.', '--no-sandbox', `--user-data-dir=${path.join(WORK, 'userdata')}`],
    env: { ...process.env, KANBAN_SECRET_STORE: 'file', KANBAN_AI_ROOTS: '/tmp' },
    timeout: 120000,
  });
  const win = await app.firstWindow();
  await sleep(4000);
  await app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setBounds(b), {
    x: 0, y: 0, width: W, height: H,
  });
  await sleep(12000);
  const port = await win.evaluate(() => window.electronAPI.getBackendPort());
  const project = await win.evaluate(async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/projects`);
    return (await r.json()).find((p) => p.name === 'Studio app').id;
  }, port);
  const tree = await win.evaluate(
    async ([port, p]) => (await fetch(`http://127.0.0.1:${port}/projects/${p}/docs/tree`)).json(),
    [port, project],
  );
  const pageId = (t) => tree.find((n) => n.title.startsWith(t)).id;
  const go = async (query) => {
    await win.evaluate((q) => {
      localStorage.setItem('kanbanActor', 'An Nguyen');
      window.location.search = q;
    }, query);
    await sleep(6000);
  };
  const scrollTo = (text) =>
    win.evaluate((t) => {
      const h = [...document.querySelectorAll('[data-testid="page-body"] h2')].find((e) =>
        e.textContent.trim().startsWith(t),
      );
      h?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, text);
  await go(`?proj=${project}&docs=${pageId('Spec: Lock')}`);

  const rec = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'x11grab', '-framerate', '25', '-video_size', `${W}x${H}`,
    '-i', process.env.DISPLAY, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    path.join(WORK, 'screen.mp4'),
  ]);
  t0 = Date.now();
  await sleep(800);

  caption('Live check of #268 · real Claude Code runs on this board: BA on sonnet, Dev on haiku (runs done before recording)');
  await sleep(5000);
  caption('Asked only "write the spec for this as a Docs page and link it to this ticket": the BA (1 min 38 s, $0.40) wrote this');
  await sleep(4500);
  caption('A flow diagram it drew and checked as a picture, rules, numbered Given/When/Then requirements, open questions');
  await scrollTo('Flow');
  await sleep(4500);
  await scrollTo('Requirements');
  await sleep(4500);
  await scrollTo('Open questions');
  await sleep(4000);
  caption('Found here: its page went to the top of the tree; it never opened the docs-pages guide (fixed in 3.32.1)');
  await sleep(5500);

  caption('Then "The spec is ready. Please build this." to the Dev: its prompt lists the page; it read it (docs_read get)');
  await go(`?proj=${project}&ticket=STU-1`);
  await sleep(1500);
  await win.getByText('AI activity', { exact: true }).first().click();
  await sleep(4000);
  caption('…and built it test first from the spec\'s requirements: 12 tests pass, committed on the ticket\'s branch ($0.13)');
  await win.mouse.move(960, 700);
  await win.mouse.wheel(0, 700);
  await sleep(5500);
  await win.keyboard.press('Escape');

  caption('After the fix, a second ticket: the BA opened docs-pages, listed the tree and read the first spec ($0.38)…');
  await go(`?proj=${project}&docs=${pageId('Spec: Show')}`);
  await sleep(4500);
  caption('…and put its page under Requirements, linked to STU-2, with a comment on the ticket');
  await scrollTo('Requirements');
  await sleep(5000);
  const total = (Date.now() - t0) / 1000;
  current.end = total;
  rec.kill('SIGINT');
  await new Promise((r) => rec.on('close', r));
  await app.close();

  const ass = path.join(WORK, 'captions.ass');
  fs.writeFileSync(
    ass,
    [
      '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H + BAND}`, '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: Band,Inter,32,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,70,70,${Math.round(BAND / 2 - 28)},1`,
      '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ...caps.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end ?? total)},Band,,0,0,0,,${c.text}`),
    ].join('\n') + '\n',
  );
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
