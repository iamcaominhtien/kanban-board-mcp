const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBackendLaunchSpec,
  getMcpStdioBinaryPath,
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

  assert.equal(spec.command, 'C:/Kanban/resources/kanban-server.exe');
  assert.deepEqual(spec.args, []);
  assert.equal(spec.options.env.EXISTING, '1');
  assert.equal(
    spec.options.env.KANBAN_DB_PATH,
    'C:/Users/test/AppData/Roaming/Kanban Board/kanban.db'
  );
  assert.deepEqual(spec.options.stdio, ['ignore', 'pipe', 'pipe']);
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

test('getMcpStdioBinaryPath resolves packaged and dev locations', () => {
  assert.equal(
    getMcpStdioBinaryPath({
      isPackaged: true,
      platform: 'darwin',
      resourcesPath: '/Applications/Kanban.app/Contents/Resources',
      desktopDir: '/repo/desktop',
    }),
    '/Applications/Kanban.app/Contents/Resources/kanban-mcp-stdio'
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