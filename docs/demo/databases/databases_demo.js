// Records the "Choose your database" demo (3.36.0) against the real app, real PostgreSQL and MariaDB, and the board's own
// Claude Code member for the AI step. Nothing is mocked.
//
// Setup: a board made by seed_demo_board.py served on BASE (default http://localhost:8770, with ui/dist built), a Claude
// Code AI member in project KB, empty databases `kanban` on PostgreSQL (user kanban/kanban, 127.0.0.1:5432) and on
// MariaDB (127.0.0.1:3306), and cli.html (the real output of the kanban-db commands) next to this file or in OUT.
// The MariaDB step stops the server with `service mariadb stop` and starts it again.
// Usage: DEMO_DB_PASSWORD=… OUT=/some/folder node databases_demo.js [--shots]
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:8770';
// The demo databases' password (user kanban), given to the script rather than written in it
const DB_PASSWORD = process.env.DEMO_DB_PASSWORD || '';
const OUT = process.env.OUT || __dirname;
const SHOTS = process.argv.includes('--shots');
let shotN = 0;

async function caption(page, title, sub = '') {
  await page.evaluate(
    ([t, s]) => {
      let el = document.getElementById('__cap');
      if (!el) {
        el = document.createElement('div');
        el.id = '__cap';
        el.style.cssText =
          'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483647;max-width:1100px;' +
          'background:rgba(16,32,24,.93);color:#fff;padding:12px 22px;border-radius:12px;font:600 17px/1.35 system-ui,sans-serif;' +
          'box-shadow:0 10px 30px rgba(0,0,0,.35);pointer-events:none;text-align:center';
        document.body.appendChild(el);
      }
      el.innerHTML = t + (s ? `<div style="font-weight:400;font-size:14px;opacity:.85;margin-top:3px">${s}</div>` : '');
    },
    [title, sub],
  );
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(OUT, `shot-${String(++shotN).padStart(2, '0')}-${name}.png`) });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function titleCard(page, html, ms) {
  await page.setContent(
    `<html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#123222;color:#fff;font-family:system-ui,sans-serif">
     <div style="max-width:980px">${html}</div></body></html>`,
  );
  await wait(ms);
}

async function openStorage(page) {
  await page.goto(`${BASE}/?settings=storage`);
  await page.getByRole('heading', { name: 'Database' }).first().waitFor({ timeout: 20000 });
  await wait(800);
}

async function fillServer(page, { engine, host, port, name, user, password }) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: new RegExp(engine) }).first().click();
  await wait(700);
  await dialog.getByRole('button', { name: 'Next' }).click();
  await wait(700);
  const field = async (label, value) => {
    const box = dialog.getByLabel(label, { exact: true });
    await box.fill('');
    await box.type(String(value), { delay: 35 });
  };
  await field('Host', host);
  await field('Port', port);
  await field('Database', name);
  await field('User', user);
  await field('Password', password);
}

async function waitText(page, text, timeout = 60000) {
  await page.getByText(text).first().waitFor({ timeout });
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    recordVideo: SHOTS ? undefined : { dir: OUT, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  // The board's own "Board health is ready" toast can cover the wizard's buttons: close it as a person would
  await page.addLocatorHandler(page.getByTestId('health-toast'), async (toast) => {
    await toast.getByRole('button', { name: 'Close' }).click();
  });

  await titleCard(
    page,
    `<div style="font-size:15px;letter-spacing:.12em;opacity:.7;text-transform:uppercase">Kanban Board MCP · 3.36.0</div>
     <h1 style="font-size:46px;margin:12px 0 18px">Choose your database</h1>
     <div style="font-size:21px;line-height:1.6;opacity:.92">SQLite (default) · PostgreSQL · MySQL / MariaDB<br>
     Test → Check → Copy → Verify → Switch, with no restart<br>An AI (the board's own Claude Code member) helps when a copy stops</div>
     <div style="font-size:15px;opacity:.6;margin-top:26px">Real app, real PostgreSQL 16 and MariaDB 10.11, real Claude. Nothing is mocked.</div>`,
    5500,
  );

  // 1. The board on SQLite
  await page.goto(BASE);
  await wait(2500);
  await caption(page, 'A board on SQLite: 450 tickets, docs, ideas and 30,000 notifications', 'One file in the data folder, as today');
  await shot(page, 'board');
  await wait(3500);

  // 2. The Database card
  await openStorage(page);
  await caption(page, 'App settings › Storage & backup › the new Database card', 'What the board uses now, its size, tables and tickets');
  await shot(page, 'card-sqlite');
  await wait(4000);
  await page.getByRole('button', { name: 'Why only these?' }).click();
  await caption(page, 'Why only these?', 'Redis and MongoDB cannot hold a relational board, and the card says so');
  await wait(3500);
  await page.getByRole('button', { name: 'Why only these?' }).click();

  // 3. Move to PostgreSQL: a wrong password first
  await page.getByRole('button', { name: /Move to another database/ }).click();
  await caption(page, 'Step 1 · Where to', 'Choose an engine, give the connection, press Test');
  await wait(2200);
  await fillServer(page, { engine: 'PostgreSQL', host: '127.0.0.1', port: 5432, name: 'kanban', user: 'kanban', password: DB_PASSWORD + '-typo' });
  await page.getByRole('dialog').getByRole('button', { name: 'Test connection' }).click();
  await waitText(page, 'Cannot sign in');
  await caption(page, 'A wrong password: the test says what it found and how to fix it', 'Next stays off while a line is red');
  await shot(page, 'pg-wrong-password');
  await wait(4000);
  const pw = page.getByRole('dialog').getByLabel('Password', { exact: true });
  await pw.fill('');
  await pw.type(DB_PASSWORD, { delay: 40 });
  await page.getByRole('dialog').getByRole('button', { name: 'Test connection' }).click();
  await waitText(page, 'Database is empty');
  await caption(page, 'Reached, signed in, version, encoding, can create tables, empty', 'The test tries a table in a transaction and rolls it back; nothing is changed');
  await shot(page, 'pg-tested');
  await wait(4500);
  await page.getByRole('dialog').getByRole('button', { name: 'Next' }).click();

  // 4. Check
  await waitText(page, 'WHAT WILL HAPPEN', 30000).catch(() => waitText(page, 'What will happen'));
  await caption(page, 'Step 2 · Check: what moves, what stays, nothing written yet', 'About 30,500 rows in 86 tables; attachments stay in the data folder');
  await shot(page, 'pg-check');
  await wait(5000);
  await page.getByRole('dialog').getByRole('button', { name: 'Copy my data' }).last().click();

  // 5. Copy and verify
  await caption(page, 'Step 3 · Copy: table by table, parents first, one transaction per table', 'The SQLite file is only read');
  await shot(page, 'pg-copy');
  await waitText(page, 'Everything was copied and checked', 120000);
  await caption(page, 'Step 4 · Verify: counts, 500 random rows per table read back, links, counters', 'The board checks the copy itself');
  await shot(page, 'pg-verify');
  await wait(5500);
  await page.getByRole('dialog').getByRole('button', { name: /Switch to PostgreSQL now/ }).click();
  await wait(3000);
  await caption(page, 'Switched to PostgreSQL, live, with no restart');
  await shot(page, 'pg-switched');
  await wait(2500);
  const close = page.getByRole('dialog').getByRole('button', { name: 'Close' });
  if (await close.count()) await close.first().click();
  await wait(1200);
  await caption(page, 'The card now shows PostgreSQL 16 · connected', 'Edit connection, Test connection, and a way back to the SQLite file');
  await shot(page, 'card-pg');
  await wait(4500);

  await page.goto(BASE);
  await wait(2500);
  await caption(page, 'Same board, now read from PostgreSQL');
  await wait(3500);

  // 6. PostgreSQL → MariaDB, where a value does not fit, and the AI helps
  await openStorage(page);
  await page.getByRole('button', { name: /Move to another database/ }).click();
  await wait(1200);
  await caption(page, 'Any direction works: now PostgreSQL → MariaDB');
  await fillServer(page, { engine: 'MySQL', host: '127.0.0.1', port: 3306, name: 'kanban', user: 'kanban', password: DB_PASSWORD });
  await page.getByRole('dialog').getByRole('button', { name: 'Test connection' }).click();
  await waitText(page, 'Database is empty');
  await caption(page, 'MariaDB 10.11 · utf8mb4 · can create tables · empty');
  await shot(page, 'my-tested');
  await wait(3500);
  await page.getByRole('dialog').getByRole('button', { name: 'Next' }).click();
  await waitText(page, 'group_key', 30000);
  await caption(page, 'The check already warns: one notification key is 461 characters', 'On MySQL an indexed text column is VARCHAR(255)');
  await shot(page, 'my-check');
  await wait(5500);
  await page.getByRole('dialog').getByRole('button', { name: 'Copy my data' }).last().click();
  await waitText(page, 'The copy stopped at table notification', 120000);
  await caption(page, 'The copy stops exactly there: table, row, column, types on both sides', 'Tables before it are complete; this one is empty again, so a resume never duplicates');
  await shot(page, 'my-stopped');
  await wait(6000);

  await page.getByRole('dialog').getByRole('button', { name: 'Ask the AI' }).first().click();
  await caption(page, 'Ask the AI: the board’s Claude Code member, for real', 'It is shown names, types, lengths and the error; never the rows or a password');
  await waitText(page, 'What it affects', 240000);
  await caption(page, 'Claude explains the cause and proposes one ALTER TABLE on the new database', 'The board only accepts ALTER TABLE on its own tables, and nothing that drops data');
  await shot(page, 'my-ai');
  await wait(9000);
  await page.getByRole('dialog').getByRole('button', { name: /Apply and resume/ }).click();
  await caption(page, 'The AI proposes; the board applies, resumes from notification and verifies');
  await waitText(page, 'Everything was copied and checked', 180000);
  await shot(page, 'my-verify');
  await wait(5000);
  await page.getByRole('dialog').getByRole('button', { name: /Switch to MySQL/ }).click();
  await wait(3000);
  const close2 = page.getByRole('dialog').getByRole('button', { name: 'Close' });
  if (await close2.count()) await close2.first().click();
  await wait(1000);
  await caption(page, 'Now on MariaDB, with every check green');
  await shot(page, 'card-my');
  await wait(4000);

  // 7. The script
  await page.goto('file://' + path.join(OUT, 'cli.html'));
  await caption(page, 'The same copy from a terminal: kanban-db', 'Real output: test, dry run, copy with --verify to PostgreSQL');
  await page.waitForFunction(() => document.body.dataset.done === '1', null, { timeout: 60000 });
  await wait(4000);

  // 8. The database goes away, and comes back
  await page.goto(BASE);
  await wait(2500);
  execSync('service mariadb stop');
  await page.goto(BASE);
  await waitText(page, 'cannot reach its database', 60000);
  await caption(page, 'MariaDB was stopped: the board says so instead of failing', 'It retries every 8 seconds; or edit the connection, or open the SQLite file');
  await shot(page, 'down');
  await wait(6000);
  execSync('service mariadb start');
  await caption(page, 'MariaDB is back: the board reconnects by itself');
  await page.getByText('cannot reach its database').first().waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
  await wait(4000);

  // 9. Back to the SQLite file
  await openStorage(page);
  await page.getByRole('button', { name: /Use the SQLite file again/ }).first().click();
  await wait(1500);
  await caption(page, 'And back: Use the SQLite file again', 'The file is as it was when the board left it');
  await shot(page, 'sqlite-again-confirm');
  await wait(3500);
  await page.getByRole('alertdialog').getByRole('button', { name: /Use the SQLite file|Open|Use it/ }).first().click();
  await wait(3000);
  await caption(page, 'On SQLite again');
  await shot(page, 'card-sqlite-again');
  await wait(3500);

  await titleCard(
    page,
    `<h1 style="font-size:40px;margin:0 0 18px">Choose your database · 3.36.0</h1>
     <div style="font-size:19px;line-height:1.7;opacity:.92">• SQLite, PostgreSQL 14+, MySQL 8 / MariaDB 10.6+<br>
     • One move in four steps from Settings, the kanban-db script, or with the AI's help<br>
     • Verified by the board: counts, sampled rows, links, counters<br>
     • Faster lookups on every engine, SQLite tuned for the board and its MCP process sharing the file</div>`,
    5000,
  );

  await context.close();
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
