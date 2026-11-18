#!/usr/bin/env node
// End-to-end check of the Electron desktop app, for what the browser suite (server/e2e) cannot reach: the OS
// notification, the launcher badge, what a click on a notice does, and the update flow.
//   xvfb-run -a npm run e2e          (from desktop/; see desktop/e2e/README.md)
// It starts the real app (main.js, which starts the real Rust server) with temporary folders, drives its window with
// Playwright and reads what the main process hands to the OS through lib/app.mjs. Exit code 0 = every check passed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  launchApp, closeApp, api, until, sleep, installRecorder, recorded, clickNote, setDaemon, setFocus, windowState, lastBadge,
  UPDATE, installUpdateFeed, setUpdateFeed, updateState, clickMenu,
} from './lib/app.mjs';

const REPORT = path.join(path.dirname(new URL(import.meta.url).pathname), 'report'); // screenshots of a failed run (git-ignored)
const RATE_MS = 20000; // notifier.js RATE_MS: the notifier has no hook to shorten it, so the check waits it out

const results = [];
let app;
let failed = false;

/** One check: runs `fn`, prints the result, and stops the run at the first failure (later checks need the earlier state). */
async function step(name, fn) {
  if (failed) { results.push({ name, status: 'skipped' }); return; }
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, status: 'ok', ms: Date.now() - t0 });
    console.log(`  ok    ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed = true;
    results.push({ name, status: 'FAILED', error: e });
    console.log(`  FAIL  ${name}\n${String(e.stack || e).split('\n').map((l) => `        ${l}`).join('\n')}`);
    try {
      fs.mkdirSync(REPORT, { recursive: true });
      const shot = path.join(REPORT, 'failure.png');
      await app.page.screenshot({ path: shot });
      console.log(`        screenshot: ${shot}`);
    } catch { /* no window */ }
    console.log(`        app output:\n${app.log.slice(-15).map((l) => `          ${l}`).join('\n')}`);
  }
}

const noteCount = async () => (await recorded(app)).notes.length;
const bell = () => app.page.getByRole('button', { name: /^Notifications(, (\d+ needs? you|unread updates|not connected))?$/ }).first();
const centre = () => app.page.getByRole('dialog', { name: 'Notifications' });

/**
 * Waits until the notifier has read the feed once for the current person, so its cursor is set and what happens next
 * is news. It uses the same IPC the window uses to tell the main process who the person is: a different actor makes
 * the notifier start over, and the check waits for the first /notifications/counts it asks after that.
 */
async function notifierReady() {
  const mark = (await recorded(app)).http.length;
  await app.page.evaluate(async () => {
    await window.electronAPI.notifications.setActor('probe');
    await window.electronAPI.notifications.setActor('user');
  });
  await until(async () => (await recorded(app)).http.slice(mark).some((h) => h.path === '/notifications/counts' && h.actor === 'user'), 'the notifier to read the feed', 15000);
}

/** After a change on the server: waits until the notifier has read the feed that carries it (the feed, then the count). */
async function afterFeed(from) {
  await until(async () => (await recorded(app)).http.slice(from).some((h) => h.path === '/notifications/counts'), 'the notifier to read the feed again', 15000);
}

try {
  console.log('Desktop app e2e');
  app = await launchApp();
  await installRecorder(app);
  const ctx = {};
  const as = (actor) => (method, url, data) => api(app, method, url, data, actor);
  const user = as(undefined);
  const ada = as('Ada');

  // the person's own folders, which the run must leave as they are (the app and its server get temporary ones)
  const ownFolders = {};
  for (const d of ['.kanban-board', '.config/kanban-board-desktop', '.config/Kanban Board']) {
    const dir = path.join(os.homedir(), d);
    ownFolders[dir] = fs.existsSync(dir) ? fs.statSync(dir).mtimeMs : null;
  }

  await step('1. the app starts, the window loads the board and the server it started answers', async () => {
    const w = await until(async () => { const st = await windowState(app); return st.visible && st; }, 'the window to be shown (ready-to-show)', 30000);
    assert.match(w.url, /ui\/dist\/index\.html$/, 'the window loads the built UI from disk');
    const health = await fetch(`${app.base}/health`);
    assert.equal(health.status, 200, '/health of the server the app started');
    // the server got its database in the temporary user data folder, not the person's home
    await until(() => fs.existsSync(path.join(app.dirs.userData, 'kanban.db')), 'the database in userData', 5000);
    // the page is connected to that server: its first-run screen is the board's own
    await app.page.getByLabel('Project name').fill('Alpha');
    await app.page.getByLabel('Prefix', { exact: true }).fill('ALP');
    await app.page.getByRole('button', { name: 'Create project' }).click();
    await app.page.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor({ timeout: 20000 });
    const projects = await user('GET', '/projects');
    assert.equal(projects.status, 200);
    assert.equal(projects.body.length, 1, 'the project made in the window is on the app\'s server');
    ctx.projectId = projects.body[0].id;
  });

  await step('set up: members Me and Ada, six published pages, the notifier has its cursor', async () => {
    for (const name of ['Me', 'Ada']) {
      const r = await user('POST', `/projects/${ctx.projectId}/members`, { name });
      assert.ok(r.status < 300, `member ${name}: ${JSON.stringify(r.body)}`);
    }
    ctx.pages = {};
    for (const name of ['Plans', 'Budget', 'Roadmap', 'Handbook', 'Notes', 'Later']) {
      const page = (await user('POST', `/projects/${ctx.projectId}/docs/pages`, { title: name, markdown: `# ${name}\n\nBody of ${name}.` })).body;
      const pub = await user('POST', `/docs/pages/${page.id}/publish`, { base_version: 0, note: 'first' });
      assert.equal(pub.status, 200, `publish ${name}: ${JSON.stringify(pub.body)}`);
      ctx.pages[name] = page.id;
    }
    await notifierReady();
    assert.equal(await noteCount(), 0, 'nothing was shown while setting up');
  });

  /** Ada mentions the person on a page: a "needs you" row for the person (server/e2e scenario 40 does the same). */
  const mention = async (pageName) => {
    const c = await ada('POST', `/docs/pages/${ctx.pages[pageName]}/comments`, { kind: 'page', body: `Please look at ${pageName} @Me` });
    assert.equal(c.status, 201, `comment on ${pageName}: ${JSON.stringify(c.body)}`);
  };

  await step('3. with the window focused a mention sends no OS notification, the badge still counts it', async () => {
    await setFocus(app, true);
    const from = (await recorded(app)).http.length;
    await mention('Plans');
    await until(async () => (await lastBadge(app)) === 1, 'the badge to show 1');
    await afterFeed(from);
    assert.equal(await noteCount(), 0, 'no OS notification while the window is focused');
    await app.page.getByRole('button', { name: /^Notifications, 1 needs? you$/ }).first().waitFor({ timeout: 15000 }); // the window's own bell
  });

  const openNotificationSettings = async () => {
    await app.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await app.page.getByRole('button', { name: 'Notifications', exact: true }).last().click();
    await app.page.getByTestId('notifications-settings').waitFor();
  };

  const rowOf = async (text) => {
    const rows = (await user('GET', '/notifications?view=page&filter=all')).body.items;
    const row = rows.find((r) => (r.body || '').includes(text));
    assert.ok(row, `a notification row for "${text}" among ${rows.length}`);
    return row;
  };

  await step('5a. reading a needs-you row does not clear the badge (it counts the open ones); dismissing it does', async () => {
    const row = await rowOf('Please look at Plans');
    let from = (await recorded(app)).http.length;
    const r = await user('POST', '/notifications/read', { ids: [row.id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await afterFeed(from);
    const counts = (await user('GET', '/notifications/counts')).body;
    assert.deepEqual([counts.needs, counts.needs_unread], [1, 0], 'one open needs-you row, none unread');
    assert.equal(await lastBadge(app), 1, 'the badge counts open needs-you rows: read is not resolved (design J)');
    from = (await recorded(app)).http.length;
    const d = await user('POST', `/notifications/${row.id}/dismiss`);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    await until(async () => (await lastBadge(app)) === 0, 'the badge to go to 0');
    assert.equal(await noteCount(), 0, 'still no OS notification');
  });

  await step('2. a mention while the window is not focused sends one OS notification with the right text', async () => {
    await setFocus(app, false);
    const before = await noteCount();
    await mention('Budget');
    ctx.first = await until(async () => (await recorded(app)).notes[before], 'the OS notification');
    console.log('        first notice:', JSON.stringify(ctx.first));
    await sleep(1000);
    const { notes } = await recorded(app);
    assert.equal(notes.length, before + 1, 'exactly one notification');
    assert.equal(ctx.first.title, 'Ada mentioned you');
    assert.match(ctx.first.body, /Please look at Budget @Me/);
    await until(async () => (await lastBadge(app)) === 1, 'the badge to show 1');
  });

  await step('4. the 20 s limit: two more mentions right after wait and become one grouped notice', async () => {
    await mention('Roadmap');
    await mention('Handbook');
    await until(async () => (await lastBadge(app)) === 3, 'the badge to show 3');
    await sleep(2500);
    assert.equal(await noteCount(), ctx.first.id + 1, 'nothing new within seconds of the first notice');
    const second = await until(async () => (await recorded(app)).notes[ctx.first.id + 1], 'the grouped notice', RATE_MS + 8000, 250);
    ctx.group = second;
    console.log('        grouped notice:', JSON.stringify(second));
    const gap = second.at - ctx.first.at;
    assert.ok(gap >= RATE_MS - 500, `the grouped notice came ${gap} ms after the first, not before ${RATE_MS} ms`);
    assert.ok(gap < RATE_MS + 6000, `and soon after the window ended (${gap} ms)`);
    assert.equal(second.title, '2 things need you');
    assert.match(second.body, /Ada mentioned you/);
    await sleep(2000);
    assert.equal(await noteCount(), ctx.first.id + 2, 'two mentions became one notice, not two');
  });

  await step('6a. clicking the grouped notice brings the window up at the list of what needs the person', async () => {
    await setFocus(app, false);
    assert.equal((await windowState(app)).focused, false);
    await clickNote(app, ctx.group.id);
    await until(async () => (await windowState(app)).focused, 'the window to be focused by the click');
    await centre().waitFor({ timeout: 10000 });
    await centre().getByRole('tab', { name: /Needs you 3/ }).waitFor();
    assert.equal(await centre().getByRole('tab', { name: /Needs you/ }).getAttribute('aria-selected'), 'true', 'the panel opens on Needs you');
    await centre().getByRole('button', { name: 'Close' }).click();
    await centre().waitFor({ state: 'detached' });
  });

  await step('6b. clicking a single notice brings the window up at the thing itself (the Docs page)', async () => {
    await setFocus(app, false);
    await clickNote(app, ctx.first.id);
    await until(async () => (await windowState(app)).focused, 'the window to be focused by the click');
    await app.page.getByTestId('page-title').filter({ hasText: /^Budget$/ }).waitFor({ timeout: 15000 });
    await app.page.getByText('Body of Budget.').waitFor({ timeout: 15000 });
    assert.equal(await app.page.getByTestId('page-title').count(), 1, 'one page open, not another');
  });

  await step('5b. resolving the rest takes the badge to 0', async () => {
    for (const name of ['Budget', 'Roadmap', 'Handbook']) {
      const row = await rowOf(`Please look at ${name}`);
      const d = await user('POST', `/notifications/${row.id}/dismiss`);
      assert.equal(d.status, 200, JSON.stringify(d.body));
    }
    await until(async () => (await lastBadge(app)) === 0, 'the badge to go to 0');
  });

  await step('7. Settings › Notifications › Send a test shows the test notice at once, and a refusal is reported', async () => {
    await setFocus(app, true);
    await app.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await openNotificationSettings();
    const hint = app.page.locator('[data-setting="notif-desktop"]');
    await hint.getByText('Allowed for this computer.').waitFor({ timeout: 10000 });
    const before = await noteCount();
    await hint.getByRole('button', { name: 'Send a test' }).click();
    await hint.getByText('Sent. Look for it on your screen.').waitFor({ timeout: 10000 });
    const { notes } = await recorded(app);
    assert.equal(notes.length, before + 1, 'one OS notification');
    const test = notes[before];
    console.log('        test notice:', JSON.stringify(test));
    assert.equal(test.title, 'Kanban Board — Test notification');
    assert.equal(test.body, 'Notifications from Kanban Board will look like this.');
    assert.equal((await windowState(app)).focused, true, 'it was sent although the window is focused and a notice went out seconds ago');
    await app.page.screenshot({ path: '/tmp/claude-0/-home-user-kanban-board-mcp/95853220-68bc-5f20-8e7b-fbb9fbce7a3a/scratchpad/settings.png' });
    // the OS refuses it (no notification service, or the person blocked the app): Settings says so
    await setDaemon(app, 'refuse');
    await hint.getByRole('button', { name: 'Send a test' }).click();
    const refused = app.page.locator('[data-setting="notif-desktop"][role="alert"]');
    await refused.getByText('Your computer is blocking notifications').waitFor({ timeout: 10000 });
    await refused.getByText('The notification service refused it.').waitFor();
    await app.page.screenshot({ path: '/tmp/claude-0/-home-user-kanban-board-mcp/95853220-68bc-5f20-8e7b-fbb9fbce7a3a/scratchpad/settings2.png' });
    assert.equal(await app.page.evaluate(() => window.electronAPI.notifications.status().then((st) => st.permission)), 'denied');
    // and it works again once the OS allows it
    await setDaemon(app, 'accept');
    await refused.getByRole('button', { name: 'Send a test' }).click();
    await app.page.locator('[data-setting="notif-desktop"]').getByText('Allowed for this computer.').waitFor({ timeout: 10000 });
    assert.equal(await app.page.evaluate(() => window.electronAPI.notifications.status().then((st) => st.permission)), 'granted');
  });


  await step('7b. a click on the test notice only brings the window up', async () => {
    await setFocus(app, false);
    const test = (await recorded(app)).notes.find((n) => n.title.endsWith('Test notification'));
    await clickNote(app, test.id);
    await until(async () => (await windowState(app)).focused, 'the window to be focused by the click');
    await app.page.getByTestId('notifications-settings').waitFor();
    assert.equal(await centre().count(), 0, 'no panel: the test notice points at nothing');
  });

  await step('7c. with Desktop notifications switched off in Settings no OS notification is sent, the badge still counts', async () => {
    const sw = app.page.getByRole('switch', { name: 'Desktop notifications' });
    assert.equal(await sw.getAttribute('aria-checked'), 'true', 'on by default');
    await sw.click();
    await until(async () => (await user('GET', '/notifications/settings')).body.desktop_on === false, 'the setting to be saved');
    await setFocus(app, false);
    const before = await noteCount();
    const from = (await recorded(app)).http.length;
    await mention('Later');
    await until(async () => (await lastBadge(app)) === 1, 'the badge to show 1');
    await afterFeed(from);
    await sleep(500);
    assert.equal(await noteCount(), before, 'no OS notification');
    const row = await rowOf('Please look at Later');
    assert.equal(row.desktop, false, 'the server marks the row as not for the desktop');
    await user('POST', `/notifications/${row.id}/dismiss`);
    await until(async () => (await lastBadge(app)) === 0, 'the badge to go to 0');
    await sw.click();
    await until(async () => (await user('GET', '/notifications/settings')).body.desktop_on === true, 'the setting to be saved');
  });

  // ── the update flow ──
  const updates = () => app.page.getByTestId('update-settings');
  const corner = () => app.page.getByRole('status').filter({ hasText: 'is available' }).filter({ has: app.page.getByText(/^Version .* is available$/) });
  const checkNow = async () => updates().getByRole('button', { name: /Check for updates|Checking/ }).click();
  const installerFile = path.join(app.dirs.tmp, 'kanban-board-update', UPDATE.asset);

  await step('8a. Settings › Updates: a failing check says why, an up to date app says so', async () => {
    await installUpdateFeed(app);
    await app.page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await app.page.getByRole('button', { name: 'Updates', exact: true }).last().click();
    await updates().waitFor();
    await updates().getByText('5.0.0', { exact: true }).waitFor(); // the installed version, from app.getVersion()
    await setUpdateFeed(app, 'error');
    await checkNow();
    await updates().getByText("Couldn't check for updates: GitHub responded 500").waitFor({ timeout: 10000 });
    await setUpdateFeed(app, 'same');
    await checkNow();
    await updates().getByText('You are on the latest version.').waitFor({ timeout: 10000 });
    assert.equal((await updateState(app)).menuLabel, 'Check for Updates…', 'the Help menu offers a check, not an install');
    // Help › Check for Updates… answers with a toast
    await clickMenu(app, 'check-updates');
    await app.page.getByText("You're up to date").waitFor({ timeout: 10000 });
    await setUpdateFeed(app, 'error');
    await clickMenu(app, 'check-updates');
    await app.page.getByText("Couldn't check for updates").first().waitFor({ timeout: 10000 });
    await setUpdateFeed(app, 'same');
    assert.equal(await corner().count(), 0, 'no notice in the corner');
  });

  await step('8b. a newer release is offered: the page, the notice in the corner and the Help menu; a download with a wrong checksum is refused', async () => {
    await setUpdateFeed(app, 'newer', { badDigest: true });
    await checkNow();
    await updates().getByText(`Version ${UPDATE.version} is available.`).waitFor({ timeout: 10000 });
    await corner().waitFor();
    await corner().getByText('Faster boards').waitFor(); // the release notes
    assert.equal((await updateState(app)).menuLabel, `Install Update ${UPDATE.version}…`);
    await app.page.screenshot({ path: '/tmp/claude-0/-home-user-kanban-board-mcp/95853220-68bc-5f20-8e7b-fbb9fbce7a3a/scratchpad/update.png' });
    await corner().getByRole('button', { name: 'Download' }).click();
    await corner().getByText('Checksum mismatch — the download was discarded').waitFor({ timeout: 20000 });
    assert.equal(fs.existsSync(installerFile), false, 'the file that did not match was removed');
  });

  await step('8c. with the right checksum the installer is downloaded and ready to install', async () => {
    await setUpdateFeed(app, 'newer');
    await checkNow(); // a manual check brings the offer back with the release as it is now
    await updates().getByText(`Version ${UPDATE.version} is available.`).waitFor({ timeout: 10000 });
    await corner().getByRole('button', { name: 'Try again' }).click();
    await corner().getByText('Downloaded. Kanban Board will close and the installer will start.').waitFor({ timeout: 20000 });
    await corner().getByRole('button', { name: 'Install and restart' }).waitFor();
    assert.equal(fs.statSync(installerFile).size, UPDATE.size, 'the installer is in the temporary folder');
    const { calls } = await updateState(app);
    assert.ok(calls.some((u) => u.endsWith(`/${UPDATE.asset}`) && u.startsWith('https://github.com/iamcaominhtien/kanban-board-mcp/releases/download/')), 'it came from the project\'s release URL');
    // "Install and restart" would start the installer and quit the app: not pressed here
  });

  await step('8d. once an update is known the menu item reads Install Update and opens Settings › Updates', async () => {
    await app.page.getByRole('button', { name: 'Back to board' }).click();
    await setUpdateFeed(app, 'same');
    // the item now reads "Install Update 9.9.9…" (the check found one): its command opens Settings › Updates
    await clickMenu(app, 'check-updates');
    await updates().waitFor({ timeout: 10000 });
    await app.page.getByRole('button', { name: 'Back to board' }).click();
  });

  await step('9. a notice is withdrawn from the OS when the row is resolved', async () => {
    await setFocus(app, false);
    const before = await noteCount();
    await mention('Notes');
    const note = await until(async () => (await recorded(app)).notes.slice(before).find((n) => n.body.includes('Please look at Notes')), 'the notice', RATE_MS + 5000, 250);
    assert.equal(note.closed, false);
    await until(async () => (await lastBadge(app)) === 1, 'the badge to show 1');
    const row = await rowOf('Please look at Notes');
    await user('POST', `/notifications/${row.id}/dismiss`);
    await until(async () => (await recorded(app)).notes[note.id].closed, 'the notice to be closed');
    await until(async () => (await lastBadge(app)) === 0, 'the badge to go to 0');
  });

  await step('10. in the whole run the app sent only the notices above, and never touched the person\'s own folders', async () => {
    const { notes } = await recorded(app);
    const titles = notes.map((n) => n.title);
    assert.deepEqual(titles, ['Ada mentioned you', '2 things need you', 'Kanban Board — Test notification', 'Kanban Board — Test notification', 'Kanban Board — Test notification', 'Ada mentioned you'], titles.join(' | '));
    assert.ok(!notes.some((n) => /Later/.test(n.body)), 'nothing for the mention made while Desktop notifications were off');
    for (const [dir, before] of Object.entries(ownFolders)) {
      const now = fs.existsSync(dir) ? fs.statSync(dir).mtimeMs : null;
      assert.equal(now, before, `${dir} was not created or changed by the run`);
    }
  });

  await step('11. quitting the app stops the server it started', async () => {
    const port = app.base;
    await app.electron.close();
    await until(async () => fetch(`${port}/health`, { signal: AbortSignal.timeout(1000) }).then(() => false, () => true), 'the server to stop', 15000, 250);
  });
} finally {
  await closeApp(app);
}
const bad = results.filter((r) => r.status === 'FAILED').length;
console.log(`\n${results.filter((r) => r.status === 'ok').length} ok, ${bad} failed, ${results.filter((r) => r.status === 'skipped').length} skipped`);
process.exit(failed ? 1 : 0);
