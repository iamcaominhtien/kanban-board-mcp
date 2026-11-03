// Demo video of #274 (AI memory: the AIs keep it themselves, a person sees and trusts it), recorded from the web app.
//
//   1. ui/dist built (cd ui && npx vite build), server/.venv synced (cd server && uv sync)
//   2. node docs/demo/ai-memory-274/record_demo.js <out.mp4> [screenshots dir]
//
// It starts the board on a throwaway database, makes a project with one AI member "Dev An" (role Dev) whose CLI is
// docs/demo/ai-memory-274/demo_dev.py (scripted: no model; its MCP calls to the board are real), and records Chromium
// with Playwright. Captions go in a band under the picture (never over the app), from an .ass file timed while recording.
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const [OUT = path.join(process.cwd(), 'ai-memory-274-demo.mp4'), SHOTS] = process.argv.slice(2);
const WORK = process.env.DEMO_DIR || '/tmp/ai-memory-274-demo';
const PORT = 8774;
const BASE = `http://127.0.0.1:${PORT}`;
const W = 1600;
const H = 900;
const BAND = 120;
const PY = path.join(ROOT, 'server', '.venv', 'bin', 'python');

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'video'), { recursive: true });
// the repository the AI works in: the board flags a memory that names a file it no longer has
const REPO = path.join(WORK, 'shop');
for (const f of ['ui/src/export/csv.ts', 'ui/src/export/csv.test.ts', 'package.json']) {
  fs.mkdirSync(path.dirname(path.join(REPO, f)), { recursive: true });
  fs.writeFileSync(path.join(REPO, f), '');
}
const CLI = path.join(WORK, 'claude');
fs.writeFileSync(CLI, `#!/bin/sh\nexec "${PY}" "${path.join(__dirname, 'demo_dev.py')}" "$@"\n`, { mode: 0o755 });

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
function writeAss(file, total) {
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H + BAND}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Band,DejaVu Sans,28,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,60,60,${Math.round(BAND / 2 - 24)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const c of caps) {
    lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end ?? total)},Band,,0,0,0,,${c.text}`);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

async function api(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Actor': 'An Nguyen' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
async function waitRun(ticketId, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const runs = await api('GET', `/tickets/${ticketId}/ai/runs`);
    if (runs[0] && ['finished', 'failed', 'cancelled'].includes(runs[0].state)) return runs[0];
    await sleep(700);
  }
  throw new Error(`run on ${ticketId} did not end`);
}

(async () => {
  const server = spawn(path.join(ROOT, 'server', '.venv', 'bin', 'uvicorn'), ['main:app', '--port', String(PORT)], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      KANBAN_DB_PATH: path.join(WORK, 'kanban.db'),
      KANBAN_PORT: String(PORT),
      PORT: String(PORT),
      KANBAN_AI_ROOTS: WORK,
      KANBAN_SECRET_STORE: 'file',
      KANBAN_AI_RUNS_DIR: path.join(WORK, 'runs'),
      KANBAN_WORKSPACE_ROOT: path.join(WORK, 'workspaces'),
      KANBAN_BOARD_URL: BASE,
    },
    stdio: ['ignore', fs.openSync(path.join(WORK, 'server.log'), 'w'), fs.openSync(path.join(WORK, 'server.err'), 'w')],
  });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/version`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }

  // the project, its person, one AI Dev, two tickets; the person asks for Vietnamese in a comment
  const project = await api('POST', '/projects', { name: 'Shop', prefix: 'SHOP', color: '#2E6F40' });
  const pid = project.id;
  await api('POST', `/projects/${pid}/members`, { name: 'An Nguyen', role: 'admin' });
  const dev = await api('POST', `/projects/${pid}/ai/members`, {
    name: 'Dev An',
    provider: 'claude-code',
    working_dir: REPO,
    cli_path: CLI,
    model: 'haiku',
  });
  await api('PATCH', `/ai/members/${dev.id}`, { config: { role: 'dev' } });
  const t1 = (await api('POST', `/projects/${pid}/tickets`, { title: 'CSV export breaks on commas', status: 'todo' })).id;
  const t2 = (await api('POST', `/projects/${pid}/tickets`, { title: 'Export the archive as CSV', status: 'todo' })).id;
  await api('POST', `/tickets/${t1}/comments`, {
    author: 'An Nguyen',
    text: 'Từ giờ hãy viết bình luận bằng tiếng Việt nhé.',
  });
  // an older lesson that names a file the repository no longer has (the board will flag it)
  await api('POST', `/projects/${pid}/ai/lessons`, {
    text: 'Export helpers live in server/legacy_export.py; never call them from the UI.',
  });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: path.join(WORK, 'video'), size: { width: W, height: H } },
  });
  await ctx.addInitScript(
    ([p]) => {
      localStorage.setItem('activeProjectId', p);
      localStorage.setItem('kanbanActor', 'An Nguyen');
    },
    [pid],
  );
  const page = await ctx.newPage();
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  t0 = Date.now();
  await page.goto(`${BASE}/?proj=${pid}`);
  await sleep(3000);

  caption('Issue #274 · AI memory: the AIs keep it themselves, and a person can see and trust it');
  await page.getByTestId('view-ai-team').click().catch(() => page.getByText('AI Team').first().click());
  await sleep(2500);
  await page.getByRole('tab', { name: /^Memory/ }).click();
  await sleep(1500);
  caption('AI Team › Memory: a count says what waits for you · here an older lesson is flagged: its file is gone');
  await sleep(4500);
  await shot('1-memory-before-runs');

  caption('Dev An (role Dev) takes SHOP-1 · the person asked in a comment for Vietnamese');
  await api('POST', `/tickets/${t1}/ai/assign`, { member_id: dev.id, start: 'now' });
  await page.getByRole('tab', { name: /^Now/ }).click();
  await sleep(3000);
  caption('npm test hangs, npm test -- --run works · it saves that in the Dev notes, without being asked');
  await waitRun(t1);
  await sleep(1500);
  caption('…and keeps the request for Vietnamese as feedback, a note on the ticket, and proposes a lesson');
  await page.getByRole('tab', { name: /^Memory/ }).click();
  await sleep(1500);
  await page.mouse.wheel(0, 300);
  await sleep(3500);
  await shot('2-memory-after-first-run');
  caption('Role notes · Dev: live at once for every Dev; editable; capped (2 of 30) · Ticket notes for the next run on SHOP-1');
  await page.mouse.wheel(0, 500);
  await sleep(5000);
  await shot('3-notes');

  caption('A person keeps the proposed lesson: from now on it is in every AI’s prompt');
  await page.mouse.wheel(0, -2000);
  await sleep(1000);
  await page.getByTestId('proposal-keep').first().click();
  await sleep(3500);

  caption('Dev An takes another ticket, SHOP-2 · its prompt carries the notes');
  await api('POST', `/tickets/${t2}/ai/assign`, { member_id: dev.id, start: 'now' });
  await waitRun(t2);
  await page.getByRole('tab', { name: /^Run history/ }).click();
  await sleep(2500);
  await page.getByText(/SHOP-2/).first().click();
  await sleep(2500);
  caption('The run’s transcript: it read its notes, ran npm test -- --run first time, and wrote in Vietnamese');
  await sleep(5500);
  await shot('4-second-run-steps');
  await page.getByRole('tab', { name: 'What it was given' }).click();
  await sleep(1500);
  await page.getByText('show which').first().click();
  await sleep(1000);
  caption('What it was given › Project memory: “Used 2 lessons and 2 notes”, and which');
  await sleep(5500);
  await shot('5-what-it-was-given');

  caption('An outside agent (MCP only) reads the same memory with knowledge(action="memory") and can propose a lesson');
  execFileSync(PY, [path.join(__dirname, 'external_agent.py'), `${BASE}/mcp/`, pid], { cwd: ROOT, stdio: 'inherit' });
  await page.getByRole('tab', { name: /^Memory/ }).click();
  await sleep(5000);
  await shot('6-outside-agent-proposal');
  caption('Recorded in the web app with Playwright · the AI member’s CLI is scripted (no model); its MCP calls are real');
  await sleep(3500);

  const total = (Date.now() - t0) / 1000;
  if (current) current.end = total;
  const video = page.video();
  await ctx.close();
  await browser.close();
  server.kill('SIGTERM');
  const raw = await video.path();
  const ass = path.join(WORK, 'captions.ass');
  writeAss(ass, total);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', raw,
    '-vf', `pad=${W}:${H + BAND}:0:0:color=0x14211A,subtitles=${ass}`,
    '-c:v', 'libx264', '-crf', '28', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT,
  ]);
  console.log('wrote', OUT);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
