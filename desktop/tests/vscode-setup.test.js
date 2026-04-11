const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getVSCodeMcpConfigPath,
  getVSCodeUserConfigDir,
  mergeMcpConfig,
  readJsonSafe,
  registerMcpServer,
} = require('../vscode-setup');

test('getVSCodeUserConfigDir returns null when VS Code user directory does not exist', () => {
  const dir = getVSCodeUserConfigDir({
    platform: 'darwin',
    homeDir: '/tmp/does-not-exist',
    existsSync: () => false,
  });

  assert.equal(dir, null);
});

test('getVSCodeMcpConfigPath resolves config file for an existing platform-specific directory', () => {
  const dir = getVSCodeUserConfigDir({
    platform: 'win32',
    appData: 'C:/Users/test/AppData/Roaming',
    existsSync: () => true,
  });

  const filePath = getVSCodeMcpConfigPath({
    platform: 'win32',
    appData: 'C:/Users/test/AppData/Roaming',
    existsSync: () => true,
  });

  assert.equal(dir, 'C:/Users/test/AppData/Roaming/Code/User');
  assert.equal(filePath, 'C:/Users/test/AppData/Roaming/Code/User/mcp.json');
});

test('readJsonSafe returns null for corrupt JSON without overwriting it', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iam74-corrupt-'));
  const jsonPath = path.join(tempDir, 'mcp.json');
  fs.writeFileSync(jsonPath, '{bad json', 'utf8');

  assert.equal(readJsonSafe(jsonPath), null);
  assert.equal(fs.readFileSync(jsonPath, 'utf8'), '{bad json');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('mergeMcpConfig preserves unrelated servers during safe merge', () => {
  const merged = mergeMcpConfig(
    {
      servers: {
        existing: { type: 'stdio', command: '/bin/existing' },
      },
    },
    '/Applications/Kanban.app/Contents/Resources/kanban-mcp-stdio'
  );

  assert.equal(merged.result, 'registered');
  assert.deepEqual(merged.config.servers.existing, {
    type: 'stdio',
    command: '/bin/existing',
  });
  assert.deepEqual(merged.config.servers['kanban-board'], {
    type: 'stdio',
    command: '/Applications/Kanban.app/Contents/Resources/kanban-mcp-stdio',
  });
});

test('registerMcpServer returns already-registered when path matches existing config', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iam74-existing-'));
  const jsonPath = path.join(tempDir, 'mcp.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        servers: {
          'kanban-board': {
            type: 'stdio',
            command: '/tmp/kanban-mcp-stdio',
          },
        },
      },
      null,
      2
    ),
    'utf8'
  );

  const result = registerMcpServer('/tmp/kanban-mcp-stdio', {
    getConfigPath: () => jsonPath,
  });

  assert.equal(result, 'already-registered');
  assert.deepEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8')).servers, {
    'kanban-board': {
      type: 'stdio',
      command: '/tmp/kanban-mcp-stdio',
    },
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('registerMcpServer writes a merged config atomically when VS Code exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iam74-write-'));
  const jsonPath = path.join(tempDir, 'mcp.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        servers: {
          other: { type: 'stdio', command: '/bin/other' },
        },
      },
      null,
      2
    ),
    'utf8'
  );

  const result = registerMcpServer('/tmp/kanban-mcp-stdio', {
    getConfigPath: () => jsonPath,
  });

  assert.equal(result, 'registered');
  const config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.deepEqual(config.servers.other, { type: 'stdio', command: '/bin/other' });
  assert.deepEqual(config.servers['kanban-board'], {
    type: 'stdio',
    command: '/tmp/kanban-mcp-stdio',
  });
  assert.equal(fs.existsSync(`${jsonPath}.tmp`), false);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('registerMcpServer returns parse-error when mcp.json is corrupt', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iam74-parse-'));
  const jsonPath = path.join(tempDir, 'mcp.json');
  fs.writeFileSync(jsonPath, 'not-json', 'utf8');

  const result = registerMcpServer('/tmp/kanban-mcp-stdio', {
    getConfigPath: () => jsonPath,
  });

  assert.equal(result, 'parse-error');
  assert.equal(fs.readFileSync(jsonPath, 'utf8'), 'not-json');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('registerMcpServer returns vscode-not-found when config path cannot be resolved', () => {
  const result = registerMcpServer('/tmp/kanban-mcp-stdio', {
    getConfigPath: () => null,
  });

  assert.equal(result, 'vscode-not-found');
});

test('registerMcpServer returns write-error and removes temp file when atomic write fails', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iam74-write-error-'));
  const jsonPath = path.join(tempDir, 'mcp.json');
  const written = [];
  const removed = [];

  const result = registerMcpServer('/tmp/kanban-mcp-stdio', {
    getConfigPath: () => jsonPath,
    existsSync: () => false,
    readFileSync: fs.readFileSync,
    writeFileSync(filePath, contents) {
      written.push({ filePath, contents });
      throw new Error('disk full');
    },
    renameSync: fs.renameSync,
    unlinkSync(filePath) {
      removed.push(filePath);
    },
  });

  assert.equal(result, 'write-error');
  assert.equal(written[0].filePath, `${jsonPath}.tmp`);
  assert.deepEqual(removed, [`${jsonPath}.tmp`]);

  fs.rmSync(tempDir, { recursive: true, force: true });
});