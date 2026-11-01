const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildBackendLaunchSpec,
  getLegacyMcpStdioBinaryPath,
  getMcpStdioBinaryPath,
  isOpenablePath,
  isOpenableUrl,
  openExternalSafely,
  openPathSafely,
  parseReadyPort,
  shouldRunVscodeSetup,
  shouldWriteSetupFlag,
  terminateBackendProcess,
} = require('../main-helpers');

test('buildBackendLaunchSpec uses packaged binary and user data db path', () => {
  const spec = buildBackendLaunchSpec({
    isPackaged: true,
    platform: 'win32',
    resourcesPath: 'C:/Kanban/resources',
    userDataPath: 'C:/Users/test/AppData/Roaming/Kanban Board',
    desktopDir: '/repo/desktop',
    baseEnv: { EXISTING: '1' },
    devPythonExists: false,
  });

  assert.equal(spec.command, 'C:/Kanban/resources/kanban-server/kanban-server.exe');
  assert.deepEqual(spec.args, []);
  assert.equal(spec.options.env.EXISTING, '1');
  assert.equal(
    spec.options.env.KANBAN_DB_PATH,
    'C:/Users/test/AppData/Roaming/Kanban Board/kanban.db'
  );
  assert.equal(
    spec.options.env.KANBAN_UPLOADS_DIR,
    'C:/Users/test/AppData/Roaming/Kanban Board/uploads'
  );
  assert.deepEqual(spec.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('buildBackendLaunchSpec uses configured data_folder uploads if config exists', (t) => {
  const fs = require('fs');
  const os = require('os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ data_folder: '/custom/storage/data' }));

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const spec = buildBackendLaunchSpec({
    isPackaged: true,
    platform: 'darwin',
    resourcesPath: '/Applications/Kanban.app/Contents/Resources',
    userDataPath: '/Users/test/Library/Application Support/Kanban Board',
    desktopDir: '/repo/desktop',
    baseEnv: {},
    devPythonExists: false,
    configPath,
  });

  assert.equal(spec.options.env.KANBAN_UPLOADS_DIR, path.join('/custom/storage/data', 'uploads'));
  assert.equal(spec.options.env.KANBAN_SECRET_STORE, 'keychain');
});

test('buildBackendLaunchSpec prefers project virtualenv in dev mode', () => {
  const spec = buildBackendLaunchSpec({
    isPackaged: false,
    platform: 'darwin',
    resourcesPath: '/Applications/Kanban.app/Contents/Resources',
    userDataPath: '/Users/test/Library/Application Support/Kanban Board',
    desktopDir: '/repo/desktop',
    baseEnv: {},
    devPythonExists: true,
  });

  assert.equal(spec.command, '/repo/server/.venv/bin/python');
  assert.deepEqual(spec.args, ['/repo/server/main.py']);
  assert.equal(spec.options.cwd, '/repo/server');
  assert.equal(
    spec.options.env.KANBAN_DB_PATH,
    '/Users/test/Library/Application Support/Kanban Board/kanban.db'
  );
});

test('buildBackendLaunchSpec falls back to python3 when no virtualenv exists', () => {
  const spec = buildBackendLaunchSpec({
    isPackaged: false,
    platform: 'linux',
    resourcesPath: '/opt/kanban/resources',
    userDataPath: '/tmp/appdata',
    desktopDir: '/repo/desktop',
    baseEnv: {},
    devPythonExists: false,
  });

  assert.equal(spec.command, 'python3');
  assert.deepEqual(spec.args, ['/repo/server/main.py']);
});

test('parseReadyPort extracts a ready signal from aggregated stdout', () => {
  assert.equal(parseReadyPort('booting\nREADY port=48213\n'), 48213);
  assert.equal(parseReadyPort('booting only\n'), null);
});

test('getLegacyMcpStdioBinaryPath points at the pre-onedir single file', () => {
  assert.equal(
    getLegacyMcpStdioBinaryPath({ platform: 'darwin', resourcesPath: '/R' }),
    '/R/kanban-mcp-stdio'
  );
  assert.equal(
    getLegacyMcpStdioBinaryPath({ platform: 'win32', resourcesPath: 'C:/R' }),
    'C:/R/kanban-mcp-stdio.exe'
  );
});

test('getMcpStdioBinaryPath resolves packaged and dev locations', () => {
  assert.equal(
    getMcpStdioBinaryPath({
      isPackaged: true,
      platform: 'darwin',
      resourcesPath: '/Applications/Kanban.app/Contents/Resources',
      desktopDir: '/repo/desktop',
      existsSync: () => false,
    }),
    '/Applications/Kanban.app/Contents/Resources/kanban-mcp-stdio'
  );

  assert.equal(
    getMcpStdioBinaryPath({
      isPackaged: true,
      platform: 'win32',
      resourcesPath: 'C:/App/resources',
      desktopDir: 'C:/repo/desktop',
      existsSync: (p) => p.endsWith('kanban-mcp-stdio/kanban-mcp-stdio.exe'),
    }),
    'C:/App/resources/kanban-mcp-stdio/kanban-mcp-stdio.exe'
  );

  assert.equal(
    getMcpStdioBinaryPath({
      isPackaged: true,
      platform: 'darwin',
      resourcesPath: '/Applications/Kanban.app/Contents/Resources',
      desktopDir: '/repo/desktop',
      existsSync: (p) =>
        p ===
        '/Applications/Kanban.app/Contents/Resources/kanban-mcp-stdio/kanban-mcp-stdio',
    }),
    '/Applications/Kanban.app/Contents/Resources/kanban-mcp-stdio/kanban-mcp-stdio'
  );

  assert.equal(
    getMcpStdioBinaryPath({
      isPackaged: false,
      platform: 'win32',
      resourcesPath: 'C:/ignored',
      desktopDir: '/repo/desktop',
    }),
    '/repo/server/mcp_stdio.py'
  );
});

test('setup flag helpers only mark successful packaged registration states', () => {
  assert.equal(shouldRunVscodeSetup({ isPackaged: true, setupFlagExists: false }), true);
  assert.equal(shouldRunVscodeSetup({ isPackaged: false, setupFlagExists: false }), false);
  assert.equal(shouldRunVscodeSetup({ isPackaged: true, setupFlagExists: true }), false);

  assert.equal(shouldWriteSetupFlag('registered'), true);
  assert.equal(shouldWriteSetupFlag('already-registered'), true);
  assert.equal(shouldWriteSetupFlag('parse-error'), false);
});

test('terminateBackendProcess only kills valid child processes', () => {
  let killed = false;
  assert.equal(
    terminateBackendProcess({
      kill() {
        killed = true;
      },
    }),
    true
  );
  assert.equal(killed, true);
  assert.equal(terminateBackendProcess(null), false);
});
test('the API secret goes to the server on its standard input, never in its environment', () => {
  const apiSecret = require('crypto').randomBytes(12).toString('hex'); // made up for this test
  const spec = buildBackendLaunchSpec({
    isPackaged: true,
    platform: 'darwin',
    resourcesPath: '/R',
    userDataPath: '/U',
    desktopDir: '/D',
    baseEnv: {},
    devPythonExists: false,
    apiSecret,
  });
  assert.deepEqual(spec.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(spec.options.env.KANBAN_API_SECRET_STDIN, '1');
  assert.ok(!JSON.stringify(spec.options.env).includes(apiSecret));
  const dev = buildBackendLaunchSpec({
    isPackaged: false,
    platform: 'darwin',
    resourcesPath: '/R',
    userDataPath: '/U',
    desktopDir: '/D/desktop',
    baseEnv: {},
    devPythonExists: true,
    apiSecret,
  });
  assert.deepEqual(dev.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.ok(!JSON.stringify(dev.options.env).includes(apiSecret));
});

test('isOpenablePath opens documents, images and media but never scripts or programs', () => {
  for (const ok of ['/data/uploads/shot.PNG', 'C:\\work\\report.pdf', '/w/notes.md', '/w/clip.mp4', '/w/sheet.xlsx']) {
    assert.equal(isOpenablePath(ok), true, ok);
  }
  for (const bad of [
    '/w/run.sh', 'C:\\w\\setup.exe', 'C:\\w\\go.bat', '/w/tool.js', '/w/main.py', '/w/page.html',
    '/Applications/Calculator.app', '/w/no-extension', '/w/macro.doc', '\\\\host\\share\\a.pdf', '', null, 42,
  ]) {
    assert.equal(isOpenablePath(bad), false, String(bad));
  }
});

test('isOpenableUrl allows web and mail links only', () => {
  for (const ok of ['https://github.com/x', 'http://localhost:8000/', 'mailto:a@b.c']) {
    assert.equal(isOpenableUrl(ok), true, ok);
  }
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://open', 'smb://host/share', 'not a url', '', null]) {
    assert.equal(isOpenableUrl(bad), false, String(bad));
  }
});

function fakeShell({ openPathResult = '', fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async openPath(p) {
      calls.push(['openPath', p]);
      if (fail) throw new Error(fail);
      return openPathResult;
    },
    async openExternal(u) {
      calls.push(['openExternal', u]);
      if (fail) throw new Error(fail);
    },
  };
}

test('openPathSafely opens a document, and a program only once the person confirms', async () => {
  const shell = fakeShell();
  assert.deepEqual(await openPathSafely(shell, '/w/report.pdf'), { success: true, error: null });
  // no confirm given: a program is not opened, and the shell is never asked
  assert.deepEqual(await openPathSafely(shell, 'C:\\w\\setup.exe'), { success: false, error: 'Not opened' });
  const asked = [];
  const no = async (name) => (asked.push(name), false);
  assert.deepEqual(await openPathSafely(shell, '/w/run.sh', { confirm: no }), { success: false, error: 'Not opened' });
  const yes = async (name) => (asked.push(name), true);
  assert.deepEqual(await openPathSafely(shell, '/w/notes.ts', { confirm: yes }), { success: true, error: null });
  assert.deepEqual(asked, ['run.sh', 'notes.ts']);
  assert.deepEqual(await openPathSafely(shell, 42), { success: false, error: 'Invalid path' });
  assert.deepEqual(shell.calls, [
    ['openPath', '/w/report.pdf'],
    ['openPath', '/w/notes.ts'],
  ]);
});

test('openPathSafely asks about a link that is named like a document but points at a program', async () => {
  const shell = fakeShell();
  const asked = [];
  const confirm = async (name) => (asked.push(name), false);
  const realpath = (p) => (p === '/w/report.pdf' ? '/usr/local/bin/tool.sh' : p);
  assert.deepEqual(await openPathSafely(shell, '/w/report.pdf', { confirm, realpath }), {
    success: false,
    error: 'Not opened',
  });
  assert.deepEqual(asked, ['report.pdf']);
  // a missing file is left to openPath, which reports it
  const missing = () => {
    throw new Error('ENOENT');
  };
  assert.equal((await openPathSafely(fakeShell(), '/w/gone.pdf', { realpath: missing })).success, true);
  assert.deepEqual(shell.calls, []);
});

test('openPathSafely never opens a network path, even when confirmed', async () => {
  const shell = fakeShell();
  for (const p of ['\\\\attacker\\share\\a.pdf', '//attacker/share/a.pdf']) {
    const res = await openPathSafely(shell, p, { confirm: async () => true });
    assert.equal(res.success, false);
    assert.match(res.error, /network share/);
  }
  assert.deepEqual(shell.calls, []);
});

test('openPathSafely reports what the shell says', async () => {
  assert.deepEqual(await openPathSafely(fakeShell({ openPathResult: 'No app' }), '/w/a.png'), {
    success: false,
    error: 'No app',
  });
  assert.deepEqual(await openPathSafely(fakeShell({ fail: 'boom' }), '/w/a.png'), { success: false, error: 'boom' });
});

test('openExternalSafely opens web links only', async () => {
  const shell = fakeShell();
  assert.deepEqual(await openExternalSafely(shell, 'https://github.com/x'), { success: true });
  assert.equal((await openExternalSafely(shell, 'file:///etc/passwd')).success, false);
  assert.deepEqual(await openExternalSafely(fakeShell({ fail: 'no browser' }), 'https://a.b'), {
    success: false,
    error: 'no browser',
  });
  assert.deepEqual(shell.calls, [['openExternal', 'https://github.com/x']]);
});
