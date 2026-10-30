// Takes the guide's screenshots from a demo project, at 1440 x 900 (JPEG, about 1500 px wide), so they can be redone
// whenever the interface changes.
//
//   1. Start a server on an empty data folder that serves the built UI:
//        cd ui && npm run build
//        cd ../server && KANBAN_UI_DIST=../ui/dist KANBAN_DB_PATH=/tmp/demo/kanban.db KANBAN_UPLOADS_DIR=/tmp/demo/uploads \
//          uv run uvicorn main:app --port 8765
//   2. node take_screenshots.js            (BASE=http://localhost:8765 by default; needs Playwright)
//
// The script creates the demo project through the API, so run it on a fresh data folder. Images go to ../images/.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:8765';
const OUT = path.join(__dirname, '..', 'images');

async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function seed() {
  const existing = (await api('GET', '/projects')).find((p) => p.prefix === 'WEB');
  if (existing) return { project: existing, tickets: [] }; // already seeded: run on a fresh data folder to start over
  const project = await api('POST', '/projects', { name: 'Website Relaunch', prefix: 'WEB', color: '#2E6F40' });
  const tickets = [
    ['Plan the release', 'task', 'high', 'backlog'],
    ['Write the docs', 'task', 'medium', 'backlog'],
    ['Design the new landing page', 'feature', 'high', 'todo'],
    ['Fix login error on Safari', 'bug', 'critical', 'in-progress'],
    ['Show cost on every run card', 'feature', 'medium', 'in-progress'],
    ['Set up the staging site', 'chore', 'low', 'review'],
    ['Add a sitemap', 'task', 'low', 'done'],
  ];
  const made = [];
  for (const [title, type, priority, status] of tickets) {
    made.push(await api('POST', `/projects/${project.id}/tickets`, { title, type, priority, status, description: `${title}.\n\nThis is a demo ticket.` }));
  }
  const login = made[3];
  for (const text of ['Login works on Safari 17 and 18', 'A test covers the failing case', 'No change to the sign-up flow']) {
    await api('POST', `/tickets/${login.id}/acceptance-criteria`, { text });
  }
  return { project, tickets: made };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const demo = await seed();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.04 });
  const page = await ctx.newPage();
  const shot = async (name) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 80 });
    console.log('  ' + name);
  };
  const tryClick = async (locator) => {
    try { await locator.first().click({ timeout: 4000 }); return true; } catch { return false; }
  };

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate((id) => localStorage.setItem('activeProjectId', id), demo.project.id);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await shot('board-overview');

  if (await tryClick(page.getByRole('button', { name: /new ticket/i }))) {
    await shot('new-ticket');
    await page.goto(BASE, { waitUntil: 'networkidle' }); // the window closes with its own buttons; a reload is simpler
  }
  await page.getByText('Fix login error on Safari').first().click();
  await shot('ticket-detail');
  await page.goto(BASE, { waitUntil: 'networkidle' });

  for (const [label, name] of [['List', 'list-view'], ['Timeline', 'timeline-view'], ['Docs', 'docs-empty']]) {
    if (await tryClick(page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }))) await shot(name);
  }
  await tryClick(page.getByRole('button', { name: /^Board$/i }));

  for (const [slug, name] of [['storage', 'settings-storage'], ['integrations', 'settings-integrations'], ['diagnostics', 'settings-diagnostics'], ['docs', 'settings-docs'], ['ideas', 'settings-ideas']]) {
    await page.goto(`${BASE}/?settings=${slug}`, { waitUntil: 'networkidle' });
    await shot(name);
  }
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await tryClick(page.getByText(/idea space/i))) await shot('idea-space');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
