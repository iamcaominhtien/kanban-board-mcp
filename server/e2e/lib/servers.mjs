// Start a server the way server/crates/testkit/src/server.rs does: own temporary folders, no inherited KANBAN_*.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** A POSIX `TZ` value in which it is about nine in the morning now (its sign is the other way round). */
function morningZone() {
  const hour = new Date().getUTCHours();
  let east = 9 - hour;
  if (east < -12) east += 24;
  return `KBT${-east}`;
}

export const REPO = path.resolve(here, '../../..');
const STARTUP_MS = 60_000;

export function rustBinary() {
  const p = (process.env.KANBAN_SERVER_BIN || '').trim();
  return p || path.join(REPO, 'server/target/debug/kanban-server');
}

const live = new Set();

function killGroup(child) {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  try { child.kill('SIGKILL'); } catch {}
}

export function stopAll() {
  for (const s of live) s.stopSync();
}

for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
  process.on(sig, () => {
    stopAll();
    if (sig !== 'exit') process.exit(130);
  });
}

export async function startServer(target, { uiDist = path.join(REPO, 'ui/dist') } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-e2e-'));
  for (const d of ['data', 'config', 'logs', 'workspace', 'uploads', 'claude']) fs.mkdirSync(path.join(root, d));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('KANBAN_')) env[k] = v;
  Object.assign(env, {
    KANBAN_CONFIG_DIR: path.join(root, 'config'),
    KANBAN_DB_PATH: path.join(root, 'data/kanban.db'),
    KANBAN_LOG_DIR: path.join(root, 'logs'),
    KANBAN_WORKSPACE_ROOT: path.join(root, 'workspace'),
    KANBAN_UPLOADS_DIR: path.join(root, 'uploads'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    KANBAN_DIAGRAM_EXPORT: 'off',
    KANBAN_RUNNER: 'inprocess',
    KANBAN_UI_DIST: uiDist,
    KANBAN_DRAWIO_DIR: path.join(root, 'none'),
    KANBAN_AI_ROOTS: [root, os.tmpdir()].join(path.delimiter),
    PYTHONUNBUFFERED: '1',
    // From 18:00 on a working day the board writes each person's card of the day into the notifications, by the
    // computer's clock: the servers run in a zone where it is about nine in the morning, whenever the check runs
    // (the same rule as `testkit::morning_zone` of the Rust tests).
    TZ: morningZone(),
  });
  let cmd, args, cwd;
  if (target === 'python') {
    // The Python server was removed in 5.0.0. To compare with it, check out the commit before its removal
    // (server/PORTING.md) and name its server folder, with its virtualenv, in E2E_PYTHON_SERVER.
    if (!process.env.E2E_PYTHON_SERVER) throw new Error('--target python|both needs E2E_PYTHON_SERVER: the server folder of a checkout from before 5.0.0');
    cwd = process.env.E2E_PYTHON_SERVER;
    cmd = path.join(cwd, '.venv/bin/python');
    args = ['main.py'];
    if (!fs.existsSync(cmd)) throw new Error(`Python virtualenv missing: ${cmd}`);
  } else {
    cmd = rustBinary();
    args = [];
    cwd = root;
    if (!fs.existsSync(cmd)) throw new Error(`Rust server binary missing: ${cmd}`);
  }
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tail = [];
  const push = (l) => { tail.push(l); if (tail.length > 80) tail.shift(); };
  let buf = '';
  const server = {
    target, root, tail, child, port: 0, base: '',
    stopSync() {
      killGroup(child);
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
      live.delete(server);
    },
    async stop() { this.stopSync(); },
    dirs: { uploads: path.join(root, 'uploads'), workspace: path.join(root, 'workspace'), root },
  };
  live.add(server);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no READY line within ${STARTUP_MS}ms; last output:\n${tail.join('\n')}`)), STARTUP_MS);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        push('[stdout] ' + line);
        const m = /READY port=(\d+)/.exec(line);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      }
    });
    child.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => push('[stderr] ' + l)));
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}) before READY; last output:\n${tail.join('\n')}`)); });
  });
  try {
    server.port = await ready;
  } catch (e) {
    server.stopSync();
    throw e;
  }
  server.base = `http://127.0.0.1:${server.port}`;
  return server;
}
