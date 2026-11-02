// Demo PDF of the AI team on Claude Code (3.20.0): drives the real running app and prints docs/demo/ai-team-demo.pdf.
//
// The pages show a project the AI team really worked on: real Claude Code runs (Sonnet and Haiku) fixed bugs
// test-first in their own worktrees, went through the Quick fix workflow, were diagnosed when one hung on a
// foreground server, read a PDF from the knowledge base, and the Board AI acted by risk tier. To make one:
//
//   1. run the server with the built UI (cd ui && npx vite build; cd server && uv run uvicorn main:app --port 8011)
//      on a database where a project has had that work done (the live test of PR #259 used "AI v2 live")
//   2. node docs/demo/ai-team/ai_team_demo.js <project id> [output.pdf]
//
// Needs Playwright (the library only: it drives the installed Google Chrome). Screens go to $DEMO_DIR.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const API = process.env.BOARD || 'http://localhost:8011';
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const BUILD_ONLY = process.argv.includes('--build-only');
const PROJECT = ARGS[0];
const OUT = ARGS[1] || path.join(ROOT, 'docs', 'demo', 'ai-team-demo.pdf');
const DIR = (process.env.DEMO_DIR || '/tmp/ai-team-demo') + '/';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
if (!PROJECT && !BUILD_ONLY) throw new Error('usage: node ai_team_demo.js <project id> [output.pdf] [--build-only]');
fs.mkdirSync(DIR, { recursive: true });

let pages = [];
const U = (q = '') => `${API}/?proj=${PROJECT}${q}`;

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const pg = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const wait = (ms = 1500) => pg.waitForTimeout(ms);
  const open = async (q) => {
    await pg.goto(U(q));
    await wait(2500);
  };
  // Scroll the first element showing `text` to the top of whatever scrolls it
  const at = async (text, offset = 24) => {
    const el = pg.getByText(text, { exact: true }).first();
    await el.waitFor({ timeout: 8000 });
    await el.evaluate((node, off) => {
      node.scrollIntoView({ block: 'start' });
      let p = node.parentElement;
      while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement;
      if (p) p.scrollTop -= off;
    }, offset);
    await wait(700);
  };
  const shot = async (key, title, bullets) => {
    if (ONLY && !ONLY.has(key)) return;
    const file = `${DIR}${String(pages.length + 1).padStart(2, '0')}-${key}.jpg`;
    await pg.screenshot({ path: file, type: 'jpeg', quality: 82 });
    pages.push({ file, title, bullets });
    console.log('shot', key);
  };

  // ---------------------------------------------------------------- the board and a ticket on a workflow
  await open('');
  await shot('board', 'A project the AI team worked on', [
    'Every ticket here was done by AI members on Claude Code (Sonnet and Haiku), each in its own git worktree.',
    'The filter bar now reads workflows: which step a ticket is at, and what waits for you.',
  ]);

  await open('&ticket=LIVE-11');
  await pg.getByRole('tab', { name: /AI activity/ }).click();
  await wait(2000);
  await shot('ticket-summary', 'A bug fixed through the Quick fix workflow', [
    'Triage (Haiku) sorted it, Dev (Sonnet) fixed it test-first, Checks ran the tests by code, Reviewer passed it.',
    'The reviewer read the diff and ran the tests itself: “7 passed”. Done stays a person’s move.',
  ]);
  await at('Quick fix');
  await shot('ticket-workflow', 'Who held the ticket, step by step', [
    'Each step names the AI that held it and links its run; the history is never overwritten.',
    'Triage set the labels and a light review depth; Checks ran the project’s test command in the worktree.',
  ]);
  await pg.getByTestId('tdd-card').evaluate((n) => n.scrollIntoView({ block: 'center' }));
  await wait(700);
  await shot('ticket-tdd', 'Proof that the test went red first', [
    'Read from the runs’ own command output: “assert 5 == 4” failed, then the same command passed.',
    'A run that died on an import error never ran the test, so it would not count.',
  ]);

  // ---------------------------------------------------------------- run history, a run, a hang diagnosed
  await open('&ticket=LIVE-10');
  await pg.getByRole('tab', { name: /AI activity/ }).click();
  await wait(2000);
  await shot('hang', 'An AI that hung on a foreground server', [
    'The run printed nothing for 90 s with python3 -m http.server open: the board diagnosed it by code.',
    '“Stop that command” stopped only the server; the run carried on and finished, and a lesson was proposed.',
  ]);

  await open('');
  await pg.getByRole('button', { name: /AI Team/ }).first().click();
  await wait(2000);
  await pg.getByText('Run history', { exact: true }).first().click();
  await wait(2500);
  await shot('history', 'Every run, kept by the board', [
    'The board keeps its own transcript of each run: what it sent and every line the CLI printed, secrets masked.',
    'Search reads the transcripts (FTS5): a command, a file, a test name.',
  ]);
  await pg.getByText('Serve the repo for a check').first().click().catch(() => {});
  await wait(2500);
  await shot('run-detail', 'A run, step by step', [
    'The prompt it was sent, each tool call with its output, the diagnosis and what was done about it.',
  ]);

  // ---------------------------------------------------------------- settings: operations, knowledge, tools
  await open('&settings=ai');
  await at('Operations');
  await shot('operations', 'Operations, per project', [
    'When the board says nothing is moving, and whether Haiku may read the last steps when the code cannot tell.',
    'Project knowledge: instructions every AI gets, and the lessons its AIs learned.',
  ]);
  await pg.getByRole('tab', { name: /^Memory/ }).click();
  await wait(1500);
  await at('Project knowledge');
  await shot('lessons', 'A lesson proposed by a diagnosis', [
    '“Start long-running servers in the background” came from the hang above; a person keeps, edits or drops it.',
  ]);
  await pg.getByRole('tab', { name: /^Knowledge base/ }).click();
  await wait(2000);
  await at('Project knowledge');
  await shot('kb', 'The knowledge base, with no embeddings', [
    'A PDF of release rules, read into text, summarised and given keywords by Haiku, searched with BM25.',
    'A Dev asked to write the release note found it with the knowledge tool and followed it: codename PELICAN-7.',
  ]);
  await pg.getByRole('tab', { name: /^Installed/ }).click();
  await wait(1500);
  await at('Skills and plugins').catch(() => {});
  await shot('plugins', 'Skills and plugins, loaded per run', [
    'A plugin added from a folder for the Dev role is loaded with --plugin-dir for each run, never written into the repo.',
    'Its skill was used by the Dev, and the board counted it from the stream.',
  ]);
  await at('Role packs: eight AIs you do not have to invent');
  await shot('packs', 'Eight role packs', [
    'Triage, PM, BA, Designer, Dev (TDD), Reviewer, QA and User tester, each with its model, tools and ceiling.',
    'The members of this project were made from them.',
  ]);
  await at('Standing orders');
  await shot('orders', 'Standing orders, tried before they act', [
    'A rule in your words becomes a rule you can read; it runs in trial first and only writes what it would have done.',
    'Turned on, it reminded on LIVE-1 once, and its Undo took the comment back.',
  ]);

  // ---------------------------------------------------------------- the Board AI, asked live
  if (ONLY && !ONLY.has('board-ai')) return finish(browser);
  await open('');
  await pg.getByRole('button', { name: /Ask AI/ }).first().click();
  await wait(2000);
  const ask = async (text, until) => {
    const box = pg.getByPlaceholder(/Ask about/).first();
    await box.fill(text);
    await box.press('Enter');
    await pg.getByText(until).last().waitFor({ timeout: 180000 });
    await wait(2500);
  };
  await ask('Add the tag release to LIVE-6.', /Done —|went through/);
  await shot('board-ai', 'The Board AI acts as you, by risk tier', [
    'A small, reversible change is done at once, with one Undo: the label is on the ticket before you read the answer.',
    'On Claude Code it looks things up with its tools; a change goes through its answer so the board can apply the tier.',
  ]);
  await ask('Move LIVE-1, LIVE-2, LIVE-5 and LIVE-6 to Done.', /will not do without you/);
  await shot('board-ai-asks', 'Done and bulk changes ask first', [
    'Four tickets, and Done: nothing moved. The card says why and waits for your yes.',
  ]);

  await finish(browser);
}

async function finish(browser) {
  await browser.close();
  fs.writeFileSync(DIR + 'pages.json', JSON.stringify(pages, null, 2));
  await build();
}

async function build() {
  const list = JSON.parse(fs.readFileSync(DIR + 'pages.json', 'utf8'));
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: 1440px 1010px; margin: 0 }
    body { margin: 0; font-family: -apple-system, 'Helvetica Neue', sans-serif; color: #1c2b22 }
    .p { width: 1440px; height: 1010px; page-break-after: always; overflow: hidden; background: #f4f6f3 }
    .cover { display: flex; flex-direction: column; justify-content: center; padding: 0 120px; box-sizing: border-box }
    .cover h1 { font-size: 54px; margin: 0 0 16px } .cover p { font-size: 22px; color: #44564b; max-width: 1000px; line-height: 1.5 }
    .head { height: 110px; padding: 18px 40px 0; box-sizing: border-box }
    .head h2 { margin: 0 0 6px; font-size: 26px } .head li { font-size: 15px; color: #44564b; line-height: 1.45 }
    .head ul { margin: 0; padding-left: 18px }
    img { display: block; width: 1440px; height: 900px }
  </style></head><body>
  <div class="p cover"><h1>The AI team on Claude Code</h1>
  <p>Kanban Board 3.20.0. Everything on these pages was done by real Claude Code runs on Sonnet and Haiku, on a sample
  project: bugs fixed test-first in their own worktrees, a workflow from triage to review, a hang diagnosed and
  stopped, a PDF read from the knowledge base, a rule tried before it acted, and the Board AI acting by risk tier.</p></div>
  ${list
    .map(
      (p) => `<div class="p"><div class="head"><h2>${esc(p.title)}</h2><ul>${p.bullets
        .map((b) => `<li>${esc(b)}</li>`)
        .join('')}</ul></div><img src="file://${p.file}"></div>`,
    )
    .join('')}
  </body></html>`;
  fs.writeFileSync(DIR + 'demo.html', html);
  const browser = await chromium.launch({ channel: 'chrome' });
  const pg = await browser.newPage();
  await pg.goto('file://' + DIR + 'demo.html');
  await pg.waitForTimeout(1500);
  await pg.pdf({ path: OUT, width: '1440px', height: '1010px', printBackground: true });
  await browser.close();
  console.log('wrote', OUT);
}

(BUILD_ONLY ? build() : main()).catch((e) => {
  console.error(e);
  process.exit(1);
});
