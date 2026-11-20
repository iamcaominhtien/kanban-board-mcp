import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { home, ensureProject, createTicket, addMember } from '../lib/ui.mjs';

// The database screens on real PostgreSQL and MariaDB servers (scenario 39 drives the same wizard with a second SQLite
// file, for want of a server). Needs KANBAN_TEST_POSTGRES_URL and KANBAN_TEST_MYSQL_URL (`scripts/dev-databases.sh
// start`), else it is skipped. Every step that writes works in a database of its own, made here and dropped at the end
// (on MariaDB the test user may only use `kanban_test` and `kanban_dbkit_*`, hence the names).
//
// - the move wizard, SQLite -> PostgreSQL, through the PostgreSQL card and its fields (no pasted URL): the connection
//   test refuses an unknown user and a missing database in the app's words, Check, Copy my data, Verify, Switch now;
//   the board then runs on PostgreSQL (the data is there, a ticket made after the switch is a row in PostgreSQL);
// - Settings > Database on a server database, and Edit connection (a wrong port refused, a saved one reconnects);
// - the reconnect screen when the server really does not answer (the board is pointed at a TCP relay of the
//   scenario, which is then closed), Try now, Edit connection from that screen;
// - the same wizard PostgreSQL -> MariaDB through the MySQL / MariaDB card: a wrong password refused, a missing
//   database, a target that holds tables, then copy, verify, switch; Edit connection keeps the saved password.
//
// Not covered: a wrong password on PostgreSQL (the throwaway server trusts every local user, so any password is
// accepted), the secure-connection modes (the servers have no TLS; the form is set to Off).
export default {
  name: 'Databases: move wizard to PostgreSQL and MariaDB, Settings > Database, Edit connection, reconnect screen',
  group: 'core',
  async run(s) {
    const p = s.page;
    const pgUrl = (process.env.KANBAN_TEST_POSTGRES_URL || '').trim();
    const myUrl = (process.env.KANBAN_TEST_MYSQL_URL || '').trim();
    if (!pgUrl || !myUrl) {
      await s.step('skipped: KANBAN_TEST_POSTGRES_URL and KANBAN_TEST_MYSQL_URL are not both set', async () => {
        s.note('skipped', 'no database servers (scripts/dev-databases.sh start)');
      });
      return;
    }
    const PG = new URL(pgUrl);
    const MY = new URL(myUrl);
    const pg = { host: PG.hostname, port: PG.port || '5432', user: decodeURIComponent(PG.username), password: decodeURIComponent(PG.password) };
    const my = { host: MY.hostname, port: MY.port || '3306', user: decodeURIComponent(MY.username), password: decodeURIComponent(MY.password) };
    const tag = `${Date.now().toString(36)}${process.pid}`;
    const pgDb = `kb41_${tag}`;
    const myDb = `kanban_dbkit_e41_${tag}`;
    const myDb2 = `kanban_dbkit_e41b_${tag}`;
    const missing = `kb41_missing_${tag}`;
    const pgEmpty = `kb41e_${tag}`;

    // ---- the servers, through their own clients
    // the clients: psql of the newest PostgreSQL installed, else the one on PATH; mariadb, else mysql (a CI runner
    // has the MySQL client only)
    const pgDirs = fs.existsSync('/usr/lib/postgresql') ? fs.readdirSync('/usr/lib/postgresql').sort() : [];
    const psqlBin = pgDirs.map((v) => `/usr/lib/postgresql/${v}/bin/psql`).filter((f) => fs.existsSync(f)).pop() || 'psql';
    const onPath = (name) => (process.env.PATH || '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, name)));
    const mysqlBin = onPath('mariadb') ? 'mariadb' : 'mysql';
    const psql = (db, sql) => execFileSync(
      psqlBin,
      ['-X', '-At', '-h', pg.host, '-p', pg.port, '-U', pg.user, '-d', db, '-c', sql],
      { env: { ...process.env, PGPASSWORD: pg.password, PGSSLMODE: 'disable' } },
    ).toString().trim();
    const mysql = (db, sql) => execFileSync(
      mysqlBin,
      ['-N', '-B', '-h', my.host, '-P', my.port, '-u', my.user, ...(db ? [db] : []), '-e', sql],
      { env: { ...process.env, MYSQL_PWD: my.password } },
    ).toString().trim();
    const cleanup = () => {
      for (const d of [pgDb, pgEmpty]) { try { psql('postgres', `DROP DATABASE IF EXISTS ${d} WITH (FORCE)`); } catch { /* best effort */ } }
      for (const d of [myDb, myDb2]) { try { mysql(null, `DROP DATABASE IF EXISTS ${d}`); } catch { /* best effort */ } }
    };
    try {
      psql('postgres', `CREATE DATABASE ${pgDb} ENCODING 'UTF8'`);
      psql('postgres', `CREATE DATABASE ${pgEmpty} ENCODING 'UTF8'`);
      mysql(null, `CREATE DATABASE ${myDb} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
      mysql(null, `CREATE DATABASE ${myDb2} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    } catch (e) {
      cleanup();
      throw new Error(`cannot make the scenario's databases: ${String(e.message).split('\n')[0]}`);
    }
    try {
      await body(s, { pg, my, pgDb, pgEmpty, myDb, myDb2, missing, tag, psql, mysql });
    } finally {
      cleanup();
    }
  },
};

async function body(s, env) {
  const { pg, my, pgDb, pgEmpty, myDb, myDb2, missing, psql, mysql } = env;
  const p = s.page;
  const nav = () => p.getByRole('navigation', { name: 'Settings pages' });
  const until = async (fn, what, ms = 30000) => {
    const t0 = Date.now();
    for (;;) {
      try { if (await fn()) return; } catch { /* look again */ }
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await p.waitForTimeout(150);
    }
  };
  const api = async (method, url, data) => {
    const r = await p.request.fetch(s.server.base + url, { method, data, headers: { 'content-type': 'application/json' } });
    return { status: r.status(), body: await r.json().catch(() => null) };
  };
  const openStorage = async () => {
    await home(s);
    await p.getByRole('button', { name: 'Settings' }).click();
    await nav().getByRole('button', { name: 'Storage & backup', exact: true }).click();
    await p.getByRole('heading', { name: 'Storage & backup', level: 1 }).waitFor();
    await p.getByTestId('db-facts').waitFor();
  };
  const wizard = () => p.getByRole('dialog', { name: 'Move to another database' });
  const openWizard = async () => {
    await p.getByTestId('db-move').click();
    await wizard().waitFor();
  };
  // the fields of the connection form, in the dialog `d`
  const fill = async (d, f) => {
    if (f.host != null) await d.getByLabel('Host', { exact: true }).fill(f.host);
    if (f.port != null) await d.getByLabel('Port', { exact: true }).fill(String(f.port));
    if (f.name != null) await d.getByLabel('Database', { exact: true }).fill(f.name);
    if (f.user != null) await d.getByLabel('User', { exact: true }).fill(f.user);
    if (f.password != null) await d.getByLabel('Password', { exact: true }).fill(f.password);
    if (f.ssl != null) await d.getByLabel('Secure connection').selectOption({ label: f.ssl });
  };
  const closeWizard = async () => {
    await p.keyboard.press('Escape');
    await wizard().waitFor({ state: 'detached' });
  };
  const moveState = async () => (await api('GET', '/database/move')).body?.state ?? null;
  const dbInfo = async () => (await api('GET', '/database')).body;
  void closeWizard; void until; void createTicket; void addMember; void ensureProject; void net; void path; void openStorage; void openWizard; void fill; void moveState; void dbInfo; void psql; void mysql; void pg; void my; void pgDb; void myDb; void myDb2; void missing;

  await s.step('set up: a project with a member and two tickets', async () => {
    await ensureProject(s);
    await addMember(s, 'Me');
    await createTicket(s, { title: 'Move me one' });
    await createTicket(s, { title: 'Move me two' });
  });

  await s.step('SQLite -> PostgreSQL, step 1: the PostgreSQL card and its fields; the test refuses an unknown user and a missing database', async () => {
    await openStorage();
    await openWizard();
    const d = wizard();
    // SQLite is where the board is now: its card is the current one and cannot be chosen
    await d.getByRole('radio', { name: /SQLite/ }).and(p.locator(':disabled')).waitFor();
    await d.getByText(/This is where you are now/).waitFor();
    await d.getByTestId('move-next').and(p.locator(':disabled')).waitFor();
    await d.getByRole('radio', { name: /PostgreSQL/ }).click();
    await d.getByRole('radio', { name: /PostgreSQL/ }).and(p.locator('[aria-checked="true"]')).waitFor();
    await d.getByTestId('move-next').click();
    // the form starts with the engine's own defaults
    await d.getByLabel('Port', { exact: true }).waitFor();
    if ((await d.getByLabel('Port', { exact: true }).inputValue()) !== '5432') throw new Error('the PostgreSQL port is not 5432');
    await fill(d, { host: pg.host, port: pg.port, name: pgDb, user: 'nobody_' + env.tag, password: 'x', ssl: 'Off' });
    await d.getByTestId('move-test').click();
    await d.getByText(/Cannot sign in/).waitFor();
    await d.getByTestId('move-next').and(p.locator(':disabled')).waitFor();
    await d.getByText('Next is off until every line is green or amber.').waitFor();
    await fill(d, { user: pg.user, password: pg.password, name: missing });
    await d.getByTestId('move-test').click();
    await d.getByText(`No database “${missing}” on ${pg.host}:${pg.port}`).waitFor();
    await d.getByText(/Create it on the server \(as an administrator\), then test again/).waitFor();
    await d.getByTestId('move-next').and(p.locator(':disabled')).waitFor();
  });

  await s.step('step 1: the right fields pass the test line by line; Next checks the target and reads the plan (step 2)', async () => {
    const d = wizard();
    await fill(d, { name: pgDb });
    await d.getByTestId('move-test').click();
    await d.getByTestId('test-findings').waitFor();
    await d.getByText(new RegExp(`Reached the server · ${pg.host}:${pg.port}`)).waitFor();
    await d.getByText(`Signed in · as ${pg.user}`).waitFor();
    await d.getByText(/Version · PostgreSQL 1\d(\.\d+)? \(needs 14 or newer\)/).waitFor();
    await d.getByText('Encoding · UTF8').waitFor();
    await d.getByText(/Can create tables/).waitFor();
    await d.getByText(/Database is empty · 0 tables/).waitFor();
    await d.getByTestId('move-next').and(p.locator(':enabled')).waitFor();
    await d.getByTestId('move-next').click();
    await d.getByTestId('move-step-check').waitFor();
    await d.getByText('Step 2 of 4 · nothing has been written yet.').waitFor();
    await d.getByText(/From: SQLite/).waitFor();
    await d.getByText(/To: PostgreSQL 1\d/).waitFor();
    await d.getByText(`${pg.host}:${pg.port}/${pgDb}`).first().waitFor();
    await d.getByText(/Empty · the board will create 82 tables/).waitFor();
    await d.getByText(/2 tickets, 1 projects/).waitFor();
    const job = (await api('GET', '/database/move')).body;
    if (job.state !== 'ready' || job.target.engine !== 'postgresql' || job.target.name !== pgDb || job.target.host !== pg.host) throw new Error(`move: ${JSON.stringify(job.target)}`);
    // nothing was written to the new database yet
    if (psql(pgDb, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'") !== '0') throw new Error('the check wrote tables');
    // the script for the same copy names the target without its password
    await d.getByRole('button', { name: 'Show it' }).click();
    await d.getByTestId('move-script').getByText(new RegExp(`--to postgresql://${pg.user}@${pg.host}:${pg.port}/${pgDb}`)).first().waitFor();
    await d.getByRole('button', { name: 'Hide it' }).click();
  });

  await s.step('Copy my data: the copy runs on PostgreSQL and is verified table by table', async () => {
    const d = wizard();
    await d.getByTestId('move-start').click();
    await d.getByTestId('move-verified').waitFor({ timeout: 90000 });
    await d.getByText('Step 4 of 4').waitFor();
    await d.getByText(/Everything was copied and checked/).waitFor();
    await d.getByText(/Row counts · equal in all 82 tables/).waitFor();
    await d.getByText(/Counters · the next ticket number carries on from ALP-3/).waitFor();
    await d.getByTestId('move-verify-table').getByText('project', { exact: true }).waitFor();
    // the rows are in PostgreSQL, the board still reads SQLite until Switch
    if (psql(pgDb, 'SELECT count(*) FROM ticket') !== '2') throw new Error('the tickets are not in PostgreSQL');
    if (psql(pgDb, "SELECT count(*) FROM ticket WHERE title='Move me one'") !== '1') throw new Error('Move me one is missing');
    const db = await dbInfo();
    if (db.engine !== 'sqlite') throw new Error(`the board moved before Switch: ${db.engine}`);
  });

  await s.step('Switch now: the board says it uses PostgreSQL, the data is there and a new ticket is a row in PostgreSQL', async () => {
    const d = wizard();
    await d.getByRole('button', { name: 'Switch to PostgreSQL now' }).click();
    await d.getByTestId('move-switched').getByText('The board now uses PostgreSQL').waitFor();
    await d.getByText(new RegExp(`${pg.host}:${pg.port}/${pgDb}`)).waitFor();
    await d.getByRole('button', { name: 'Done' }).click();
    await d.waitFor({ state: 'detached' });
    const db = await dbInfo();
    if (db.engine !== 'postgresql' || db.tickets !== 2 || db.reachable !== true || db.settings.name !== pgDb) throw new Error(`database: ${JSON.stringify(db)}`);
    await home(s);
    await p.getByText('Move me one').first().waitFor();
    await p.getByText('Move me two').first().waitFor();
    await createTicket(s, { title: 'Made on PostgreSQL' });
    await p.getByText('Made on PostgreSQL').first().waitFor();
    await until(() => psql(pgDb, "SELECT count(*) FROM ticket WHERE title='Made on PostgreSQL'") === '1', 'the new ticket to be a row in PostgreSQL');
    // ... and not in the old file
    const sqliteRows = execFileSync('python3', ['-I', '-c', 'import sqlite3,sys\nprint(sqlite3.connect(sys.argv[1]).execute("select count(*) from ticket where title=?", (sys.argv[2],)).fetchone()[0])', path.join(s.server.dirs.root, 'data/kanban.db'), 'Made on PostgreSQL']).toString().trim();
    if (sqliteRows !== '0') throw new Error('the new ticket went to the SQLite file');
    if (psql(pgDb, 'SELECT count(*) FROM ticket') !== '3') throw new Error('PostgreSQL does not hold three tickets');
  });

  // ---------------------------------------------------------------- Settings > Database on PostgreSQL
  await s.step('Settings > Database on PostgreSQL: engine, server, facts, and the buttons of a server database', async () => {
    await openStorage();
    const title = p.getByTestId('db-title');
    await title.getByText(new RegExp(`^PostgreSQL 1\\d(\\.\\d+)? · ${pg.host}$`)).waitFor();
    await p.getByText(`${pg.host}:${pg.port}/${pgDb}`).first().waitFor();
    const facts = p.getByTestId('db-facts');
    await facts.getByText(/^Connected · \d+ ms · 82 tables · 3 tickets in 1 project · up to date · no password saved$/).waitFor();
    await p.getByTestId('db-chip').getByText('Connected').waitFor();
    for (const name of ['Edit connection…', 'Test connection', 'Move to another database…', 'Use the SQLite file again']) await p.getByRole('button', { name }).waitFor();
    await p.getByText(/The database lives on the server\. Back it up with your own tools/).waitFor();
    // the server-database card has no "Why only these?" and no wording about SQLite being the file
    if (await p.getByRole('button', { name: 'Why only these?' }).count()) throw new Error('"Why only these?" is shown for a server database');
    const db = await dbInfo();
    if (db.settings.host !== pg.host || String(db.settings.port) !== String(pg.port) || db.settings.user !== pg.user || db.password_saved) throw new Error(`settings: ${JSON.stringify(db.settings)}`);
    if (db.sqlite_file.exists !== true) throw new Error('the SQLite file is not offered as a way back');
  });

  await s.step('Test connection on the card reads the saved connection and lists what it found', async () => {
    await p.getByRole('button', { name: 'Test connection' }).click();
    const found = p.getByTestId('database-card').getByTestId('test-findings');
    await found.waitFor();
    await found.getByText(`Signed in · as ${pg.user}`).waitFor();
    await found.getByText(/Already holds a Kanban board · 82 tables/).waitFor();
  });

  await s.step('Edit connection (PostgreSQL): the form shows what is saved; a wrong port and another database are refused in words', async () => {
    await p.getByRole('button', { name: 'Edit connection…' }).click();
    const e = p.getByTestId('edit-connection');
    await e.waitFor();
    await e.getByText('The same PostgreSQL database, reached another way. Nothing is copied.').waitFor();
    for (const [label, want] of [['Host', pg.host], ['Port', pg.port], ['Database', pgDb], ['User', pg.user], ['Password', '']]) {
      if ((await e.getByLabel(label, { exact: true }).inputValue()) !== want) throw new Error(`${label} is not ${want}`);
    }
    await e.getByText('Leave it empty to keep the saved password.').waitFor();
    // a port nobody listens on
    await fill(e, { port: 1 });
    await e.getByRole('button', { name: 'Test connection' }).click();
    await e.getByText(`Cannot reach the server · ${pg.host}:1`).waitFor();
    await e.getByRole('button', { name: /^Save and reconnect/ }).click();
    await e.getByRole('alert').getByText(/That database does not hold this board; use Move to another database to copy it\./).waitFor();
    // the saved connection is untouched
    if (String((await dbInfo()).settings.port) !== String(pg.port)) throw new Error('a refused connection was saved');
    // an empty database on the same server: reachable, but not this board
    await fill(e, { port: pg.port, name: pgEmpty });
    await e.getByRole('button', { name: 'Test connection' }).click();
    await e.getByText(/Database is empty · 0 tables/).waitFor();
    await e.getByRole('button', { name: /^Save and reconnect/ }).click();
    await e.getByRole('alert').getByText(/That database does not hold this board/).waitFor();
    if ((await dbInfo()).settings.name !== pgDb) throw new Error('the empty database was saved');
    await e.getByRole('button', { name: 'Cancel' }).click();
    await e.waitFor({ state: 'detached' });
  }, { expectConsole: true });

  // ---------------------------------------------------------------- the reconnect screen
  // A TCP relay of this scenario stands between the board and PostgreSQL: closing it is a real outage of the server
  // (nothing shared is stopped). The board is pointed at it with Edit connection.
  const relay = {
    server: null,
    sockets: new Set(),
    port: 0,
    async start() {
      this.server = net.createServer((c) => {
        const u = net.connect(Number(pg.port), pg.host);
        for (const x of [c, u]) { this.sockets.add(x); x.on('close', () => this.sockets.delete(x)); x.on('error', () => { c.destroy(); u.destroy(); }); }
        c.pipe(u); u.pipe(c);
      });
      await new Promise((ok, bad) => { this.server.once('error', bad); this.server.listen(this.port, '127.0.0.1', ok); });
      this.port = this.server.address().port;
    },
    async stop() {
      const srv = this.server;
      this.server = null;
      for (const x of this.sockets) x.destroy();
      if (srv) await new Promise((ok) => srv.close(ok));
    },
  };
  // The first request after the server went away waits for the pool (about 30 seconds) before the board says
  // "unreachable"; asking /database/health until it does makes the next page load show the reconnect screen at once.
  const outageSeen = async () => {
    for (let i = 0; i < 4; i++) {
      const r = await p.request.fetch(`${s.server.base}/database/health`, { timeout: 90000 });
      if ((await r.json()).ok === false) return;
    }
    throw new Error('the board never noticed that the database server is gone');
  };
  try {
    await relay.start();

    await s.step('Edit connection (PostgreSQL): the same database by another port is tested, saved, and the board goes on through it', async () => {
      await p.getByRole('button', { name: 'Edit connection…' }).click();
      const e = p.getByTestId('edit-connection');
      await fill(e, { port: relay.port });
      await e.getByRole('button', { name: 'Test connection' }).click();
      await e.getByText(new RegExp(`Reached the server · ${pg.host}:${relay.port}`)).waitFor();
      await e.getByText(/Already holds a Kanban board · 82 tables/).waitFor();
      const [saved] = await Promise.all([
        p.waitForResponse((r) => /\/database\/connection$/.test(r.url())),
        e.getByRole('button', { name: /^Save and reconnect/ }).click(),
      ]);
      if (saved.status() !== 200) throw new Error(`connection: ${saved.status()} ${await saved.text()}`);
      await e.waitFor({ state: 'detached' });
      await p.getByText(`${pg.host}:${relay.port}/${pgDb}`).first().waitFor();
      const db = await dbInfo();
      if (db.engine !== 'postgresql' || db.tickets !== 3 || String(db.settings.port) !== String(relay.port)) throw new Error(`database: ${JSON.stringify(db.settings)}`);
    }, { expectConsole: true });

    // The board is open and the server goes away: the next thing it asks for is answered with the reconnect screen.
    const goDown = async () => {
      await home(s);
      await relay.stop();
      await outageSeen();
      await p.getByRole('button', { name: 'Docs', exact: true }).click();
    };

    await s.step('the server stops answering while the board is open: the reconnect screen names the server, how long and why', async () => {
      await goDown();
      const down = p.getByTestId('database-down');
      await down.waitFor({ timeout: 40000 });
      await down.getByText('The board cannot reach its database').waitFor();
      await down.getByText(new RegExp(`PostgreSQL\\s+at\\s+${pg.host}:${relay.port}`)).waitFor();
      await down.getByText(/did not answer for \d+ (seconds?|minutes?)/).waitFor();
      await down.getByText(/Nothing is lost: the board reconnects by itself/).waitFor();
      await down.locator('[class*="downError"]').waitFor();
      await down.getByText('Use the old SQLite file instead').waitFor();
      await down.getByText(/It was last written on \d+ \w+, before you switched\. Anything done since is only in PostgreSQL\./).waitFor();
      const h = await api('GET', '/database/health');
      if (h.body.ok !== false || h.body.unreachable?.target?.host !== pg.host || String(h.body.unreachable.target.port) !== String(relay.port)) throw new Error(`health: ${JSON.stringify(h.body)}`);
      // Try now while it is still down: the screen stays (the button is off while an attempt runs, each up to 5 s)
      const tryNow = down.getByRole('button', { name: 'Try now' });
      await tryNow.and(p.locator(':enabled')).waitFor({ timeout: 20000 });
      await Promise.all([
        p.waitForResponse((r) => /\/database\/health$/.test(r.url()), { timeout: 20000 }),
        tryNow.click({ timeout: 20000 }),
      ]);
      await tryNow.and(p.locator(':enabled')).waitFor({ timeout: 20000 });
      await down.getByText('The board cannot reach its database').waitFor();
    }, { expectConsole: true });

    await s.step('the server is back: Try now takes the reconnect screen away and the board has its data', async () => {
      await relay.start();
      const down = p.getByTestId('database-down');
      await down.getByRole('button', { name: 'Try now' }).and(p.locator(':enabled')).click({ timeout: 20000 });
      await down.waitFor({ state: 'detached', timeout: 30000 });
      await home(s);
      await p.getByText('Made on PostgreSQL').first().waitFor();
      await p.getByText('Move me one').first().waitFor();
    }, { expectConsole: true });

    await s.step('the reconnect screen: Edit connection with the right port saves it and the board comes back', async () => {
      await goDown();
      const down = p.getByTestId('database-down');
      await down.waitFor({ timeout: 40000 });
      await down.getByRole('button', { name: 'Edit connection…' }).click();
      const e = p.getByRole('dialog', { name: 'Edit connection' });
      await e.waitFor();
      // the form has what the board was using
      if ((await e.getByLabel('Port', { exact: true }).inputValue()) !== String(relay.port)) throw new Error('the form does not show the saved port');
      if ((await e.getByLabel('Database', { exact: true }).inputValue()) !== pgDb) throw new Error('the form does not show the saved database');
      // the relay is still closed: a test says so in the app's words
      await e.getByRole('button', { name: 'Test connection' }).click();
      await e.getByText(`Cannot reach the server · ${pg.host}:${relay.port}`).waitFor();
      await fill(e, { port: pg.port });
      await e.getByRole('button', { name: 'Test connection' }).click();
      await e.getByText(new RegExp(`Reached the server · ${pg.host}:${pg.port}`)).waitFor();
      await e.getByRole('button', { name: /^Save and reconnect/ }).click();
      await e.waitFor({ state: 'detached' });
      await down.waitFor({ state: 'detached', timeout: 30000 });
      await home(s);
      await p.getByText('Made on PostgreSQL').first().waitFor();
      const db = await dbInfo();
      if (db.reachable !== true || String(db.settings.port) !== String(pg.port) || db.tickets !== 3) throw new Error(`database: ${JSON.stringify(db.settings)}`);
    }, { expectConsole: true });

    // From here the board is pointed at the relay again, then closed while the page is loaded anew.
    await s.step('a page loaded while the server is down: the reconnect screen shows and its buttons work (Try now)', async () => {
      await relay.start();
      await openStorage();
      await p.getByRole('button', { name: 'Edit connection…' }).click();
      const e = p.getByTestId('edit-connection');
      await fill(e, { port: relay.port });
      await e.getByRole('button', { name: /^Save and reconnect/ }).click();
      await e.waitFor({ state: 'detached' });
      await p.getByText(`${pg.host}:${relay.port}/${pgDb}`).first().waitFor();
      await relay.stop();
      await outageSeen();
      await p.reload();
      const down = p.getByTestId('database-down');
      await down.waitFor({ timeout: 40000 });
      await down.getByText(new RegExp(`PostgreSQL\\s+at\\s+${pg.host}:${relay.port}`)).waitFor();
      // /health needs no database: the start-up splash goes, so the screen's buttons can be pressed while the server
      // is down (it used to answer 503 too, and the splash kept the page inert until the server came back)
      const hr = await p.request.fetch(`${s.server.base}/health`);
      if (hr.status() !== 200) throw new Error(`/health answered ${hr.status()}`);
      await p.locator('#kb-splash').waitFor({ state: 'detached', timeout: 20000 });
      if ((await p.locator('#root').getAttribute('inert')) !== null) throw new Error('the page is still inert');
      // Try now while it is down keeps the screen; with the server back, Try now takes it away. The button is off
      // while the screen's own check runs (about 5 s against a server that does not answer): wait for it
      await down.getByRole('button', { name: 'Try now' }).click({ timeout: 30000 });
      await down.waitFor();
      await relay.start();
      await down.getByRole('button', { name: 'Try now' }).click({ timeout: 30000 }).catch(() => { /* it may have reconnected by itself */ });
      await down.waitFor({ state: 'detached', timeout: 40000 });
      await home(s);
      await p.getByText('Made on PostgreSQL').first().waitFor();
    }, { expectConsole: true });

    await s.step('Edit connection (PostgreSQL): back to the server\'s own port, the way the rest of the scenario goes on', async () => {
      await openStorage();
      await p.getByRole('button', { name: 'Edit connection…' }).click();
      const e = p.getByTestId('edit-connection');
      await fill(e, { port: pg.port });
      await e.getByRole('button', { name: /^Save and reconnect/ }).click();
      await e.waitFor({ state: 'detached' });
      await p.getByText(`${pg.host}:${pg.port}/${pgDb}`).first().waitFor();
      const db = await dbInfo();
      if (String(db.settings.port) !== String(pg.port) || db.tickets !== 3) throw new Error(`database: ${JSON.stringify(db.settings)}`);
    });
  } finally {
    await relay.stop();
  }

  // ---------------------------------------------------------------- PostgreSQL -> MariaDB
  const myMissing = `kanban_dbkit_e41_missing_${env.tag}`;
  const myFields = { host: my.host, port: my.port, user: my.user, password: my.password, ssl: 'Off' };

  await s.step('PostgreSQL -> MariaDB, step 1: PostgreSQL is the current card, the MySQL / MariaDB card has the 3306 default; a wrong password and a missing database are refused', async () => {
    await openStorage();
    await openWizard();
    const d = wizard();
    await d.getByRole('radio', { name: /PostgreSQL/ }).and(p.locator(':disabled')).waitFor();
    await d.getByText(/This is where you are now/).waitFor();
    await d.getByRole('radio', { name: /SQLite/ }).and(p.locator(':enabled')).waitFor();
    await d.getByRole('radio', { name: /MySQL \/ MariaDB/ }).click();
    await d.getByTestId('move-next').click();
    if ((await d.getByLabel('Port', { exact: true }).inputValue()) !== '3306') throw new Error('the MariaDB port is not 3306');
    await fill(d, { ...myFields, name: myDb, password: 'not-' + my.password });
    await d.getByTestId('move-test').click();
    await d.getByText(`Cannot sign in · as ${my.user}`).waitFor();
    await d.getByText(/The server refused the user name or the password/).waitFor();
    await d.getByTestId('move-next').and(p.locator(':disabled')).waitFor();
    // the password field hides what is typed until Show
    if ((await d.getByLabel('Password', { exact: true }).getAttribute('type')) !== 'password') throw new Error('the password is not hidden');
    await d.getByRole('button', { name: 'Show' }).click();
    if ((await d.getByLabel('Password', { exact: true }).getAttribute('type')) !== 'text') throw new Error('Show does not show the password');
    await d.getByRole('button', { name: 'Hide' }).click();
    await fill(d, { password: my.password, name: myMissing });
    await d.getByTestId('move-test').click();
    await d.getByText(`No database “${myMissing}” on ${my.host}:${my.port}`).waitFor();
    await d.getByText(/Create it on the server \(as an administrator\), then test again/).waitFor();
    await d.getByTestId('move-next').and(p.locator(':disabled')).waitFor();
  });

  await s.step('a MariaDB database that holds tables is not written into; "Use another database" goes back to the fields', async () => {
    const d = wizard();
    mysql(myDb2, 'CREATE TABLE notes (x INT)');
    await fill(d, { name: myDb2 });
    await d.getByTestId('move-test').click();
    await d.getByText(/Not empty · 1 tables that are not a Kanban board/).waitFor();
    await d.getByTestId('move-next').click();
    await d.getByTestId('move-step-check').waitFor();
    await d.getByTestId('move-not-empty').getByText(new RegExp(`${myDb2} on ${my.host} already has 1 tables`)).waitFor();
    await d.getByText(/From: PostgreSQL/).waitFor();
    await d.getByTestId('move-start').and(p.locator(':disabled')).waitFor();
    if (mysql(myDb2, 'SHOW TABLES') !== 'notes') throw new Error('the check changed the database');
    await d.getByRole('button', { name: 'Use another database' }).click();
    await d.getByTestId('move-step-where').waitFor();
    // the fields are still filled
    if ((await d.getByLabel('Database', { exact: true }).inputValue()) !== myDb2) throw new Error('the form lost what was typed');
  });

  await s.step('step 1 with the empty MariaDB database: every line passes (version, utf8mb4, can create tables), step 2 reads the plan from PostgreSQL', async () => {
    const d = wizard();
    await fill(d, { name: myDb });
    await d.getByTestId('move-test').click();
    await d.getByText(new RegExp(`Reached the server · ${my.host}:${my.port}`)).waitFor();
    await d.getByText(`Signed in · as ${my.user}`).waitFor();
    await d.getByText(/Version · .*MariaDB.* \(needs .* or newer\)/).waitFor();
    await d.getByText(/Character set · utf8mb4/).waitFor();
    await d.getByText(/Can create tables/).waitFor();
    await d.getByText(/Database is empty · 0 tables/).waitFor();
    await d.getByTestId('move-next').click();
    await d.getByTestId('move-step-check').waitFor();
    await d.getByText(/From: PostgreSQL/).waitFor();
    await d.getByText(/To: .*MariaDB/).waitFor();
    await d.getByText(/Empty · the board will create 82 tables/).waitFor();
    await d.getByText(/3 tickets, 1 projects/).waitFor();
    const job = (await api('GET', '/database/move')).body;
    if (job.state !== 'ready' || job.source.engine !== 'postgresql' || job.target.engine !== 'mysql' || job.target.name !== myDb) throw new Error(`move: ${JSON.stringify([job.source, job.target])}`);
    if (/"password"\s*:\s*"[^"]/.test(JSON.stringify(job))) throw new Error('the move shows the password');
    if (mysql(myDb, 'SHOW TABLES') !== '') throw new Error('the check wrote tables');
    await d.getByRole('button', { name: 'Show it' }).click();
    await d.getByTestId('move-script').getByText(new RegExp(`--from postgresql://${pg.user}@${pg.host}:${pg.port}/${pgDb} --to mysql://${my.user}@${my.host}:${my.port}/${myDb}`)).first().waitFor();
    await d.getByRole('button', { name: 'Hide it' }).click();
  });

  await s.step('Copy my data from PostgreSQL to MariaDB, verify, and Switch now', async () => {
    const d = wizard();
    await d.getByTestId('move-start').click();
    await d.getByTestId('move-verified').waitFor({ timeout: 90000 });
    await d.getByText(/Row counts · equal in all 82 tables/).waitFor();
    await d.getByText(/Counters · the next ticket number carries on from ALP-4/).waitFor();
    await d.getByTestId('move-verify-table').getByText('ticket', { exact: true }).waitFor();
    if (mysql(myDb, 'SELECT count(*) FROM ticket') !== '3') throw new Error('the tickets are not in MariaDB');
    if ((await dbInfo()).engine !== 'postgresql') throw new Error('the board moved before Switch');
    await d.getByTestId('move-switch').click();
    await d.getByTestId('move-switched').getByText(/^The board now uses (MariaDB|MySQL)/).waitFor();
    await d.getByText(new RegExp(`${my.host}:${my.port}/${myDb}`)).waitFor();
    await d.getByRole('button', { name: 'Done' }).click();
    await d.waitFor({ state: 'detached' });
    const db = await dbInfo();
    if (db.engine !== 'mysql' || db.tickets !== 3 || db.reachable !== true || db.settings.name !== myDb) throw new Error(`database: ${JSON.stringify(db.settings)}`);
  });

  await s.step('the board runs on MariaDB: the data is there, a new ticket is a row in MariaDB and PostgreSQL is no longer written', async () => {
    await home(s);
    for (const title of ['Move me one', 'Move me two', 'Made on PostgreSQL']) await p.getByText(title).first().waitFor();
    await createTicket(s, { title: 'Made on MariaDB' });
    await p.getByText('Made on MariaDB').first().waitFor();
    await until(() => mysql(myDb, "SELECT count(*) FROM ticket WHERE title='Made on MariaDB'") === '1', 'the new ticket to be a row in MariaDB');
    if (mysql(myDb, 'SELECT count(*) FROM ticket') !== '4') throw new Error('MariaDB does not hold four tickets');
    if (psql(pgDb, "SELECT count(*) FROM ticket WHERE title='Made on MariaDB'") !== '0') throw new Error('the new ticket went to PostgreSQL');
    if (psql(pgDb, 'SELECT count(*) FROM ticket') !== '3') throw new Error('PostgreSQL was written to after the switch');
  });

  await s.step('Settings > Database on MariaDB: engine, server, facts with the saved password, and the way back to SQLite', async () => {
    await openStorage();
    await p.getByTestId('db-title').getByText(new RegExp(`MariaDB.* · ${my.host}$`)).waitFor();
    await p.getByText(`${my.user}@${my.host}:${my.port}/${myDb}`).first().waitFor();
    await p.getByTestId('db-facts').getByText(/^Connected · \d+ ms · 82 tables · 4 tickets in 1 project · up to date · password (encrypted|in your system keychain)$/).waitFor();
    await p.getByTestId('db-chip').getByText('Connected').waitFor();
    const db = await dbInfo();
    if (db.password_saved !== true || /"password"\s*:\s*"[^"]/.test(JSON.stringify(db))) throw new Error('the password is saved but the database info must not carry it');
    // the way back to the SQLite file warns that what was done since is not copied back
    await p.getByRole('button', { name: 'Use the SQLite file again' }).click();
    const confirm = p.getByRole('alertdialog', { name: 'Use the SQLite file again' });
    await confirm.getByText(/Anything done since is only in MariaDB|Anything done since is only in MySQL/).waitFor();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await confirm.waitFor({ state: 'detached' });
    if ((await dbInfo()).engine !== 'mysql') throw new Error('Cancel changed the database');
  });

  await s.step('Edit connection (MariaDB): an empty password keeps the saved one; a wrong password is refused and not saved', async () => {
    await p.getByRole('button', { name: 'Edit connection…' }).click();
    const e = p.getByTestId('edit-connection');
    await e.getByText(/The same MySQL \/ MariaDB database, reached another way/).waitFor();
    for (const [label, want] of [['Host', my.host], ['Port', my.port], ['Database', myDb], ['User', my.user], ['Password', '']]) {
      if ((await e.getByLabel(label, { exact: true }).inputValue()) !== want) throw new Error(`${label} is not ${want}`);
    }
    await e.getByText('Leave it empty to keep the saved password.').waitFor();
    // empty password: the saved one is used
    await e.getByRole('button', { name: 'Test connection' }).click();
    await e.getByText(`Signed in · as ${my.user}`).waitFor();
    await e.getByText(/Already holds a Kanban board · 82 tables/).waitFor();
    // a wrong one
    await fill(e, { password: 'not-' + my.password });
    await e.getByRole('button', { name: 'Test connection' }).click();
    await e.getByText(`Cannot sign in · as ${my.user}`).waitFor();
    await e.getByRole('button', { name: /^Save and reconnect/ }).click();
    await e.getByRole('alert').waitFor();
    if ((await dbInfo()).reachable !== true) throw new Error('the wrong password was saved');
    // the password back, and a save that keeps the board where it is
    await fill(e, { password: '' });
    const [saved] = await Promise.all([
      p.waitForResponse((r) => /\/database\/connection$/.test(r.url())),
      e.getByRole('button', { name: /^Save and reconnect/ }).click(),
    ]);
    if (saved.status() !== 200) throw new Error(`connection: ${saved.status()} ${await saved.text()}`);
    await e.waitFor({ state: 'detached' });
    const db = await dbInfo();
    if (db.engine !== 'mysql' || db.reachable !== true || db.tickets !== 4 || db.password_saved !== true) throw new Error(`database: ${JSON.stringify(db.settings)}`);
  }, { expectConsole: true });
}
