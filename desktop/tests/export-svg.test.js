'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PAGE_SCRIPT, parseExportArgs, isAllowedUrl, decodeSvgData } = require('../export-svg');
const { buildExportCommand, buildBackendLaunchSpec } = require('../main-helpers');

test('a normal start is not an export', () => {
  assert.equal(parseExportArgs(['/Applications/Kanban Board.app/Contents/MacOS/Kanban Board']), null);
  assert.equal(parseExportArgs(['electron', '.', '--inspect']), null);
});

test('reads the files and the editor address, packaged or in development', () => {
  const tail = ['--export-svg', '/tmp/in.drawio', '/tmp/out.svg', '--editor-url', 'http://localhost:8080/'];
  assert.deepEqual(parseExportArgs(['/opt/Kanban Board', ...tail]), {
    input: '/tmp/in.drawio',
    output: '/tmp/out.svg',
    editorUrl: 'http://localhost:8080',
  });
  assert.equal(parseExportArgs(['electron', '/repo/desktop', ...tail]).output, '/tmp/out.svg');
});

test('refuses a call that is missing a file or has a bad editor address', () => {
  assert.match(parseExportArgs(['x', '--export-svg', 'in.drawio']).error, /usage/);
  assert.match(parseExportArgs(['x', '--export-svg', 'a', 'b']).error, /editor-url/);
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'localhost:8080', 'http://']) {
    assert.match(parseExportArgs(['x', '--export-svg', 'a', 'b', '--editor-url', bad]).error, /editor-url/, bad);
  }
});

test('only the editor origin and inline data may load in the hidden window', () => {
  const editor = 'http://localhost:8080';
  assert.ok(isAllowedUrl('http://localhost:8080/js/app.min.js', editor));
  assert.ok(isAllowedUrl('data:image/png;base64,AAAA', editor));
  assert.ok(isAllowedUrl('blob:http://localhost:8080/x', editor));
  assert.ok(!isAllowedUrl('https://clear.diagrams.net/', editor));
  assert.ok(!isAllowedUrl('http://localhost:9090/x', editor));
  assert.ok(!isAllowedUrl('http://localhost.evil.com/', editor));
  assert.ok(!isAllowedUrl('not a url', editor));
});

test('decodes the editor answer, base64 or percent-encoded', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Ünï</text></svg>';
  assert.equal(decodeSvgData('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')), svg);
  assert.equal(decodeSvgData('data:image/svg+xml,' + encodeURIComponent(svg)), svg);
});

test('the page script is a function of the drawing, the editor and a timeout', () => {
  const fn = eval(PAGE_SCRIPT); // eslint-disable-line no-eval
  assert.equal(typeof fn, 'function');
  assert.equal(fn.length, 3);
});

test('the server is told how to reach the app: packaged exe, or electron plus the desktop folder', () => {
  assert.deepEqual(buildExportCommand({ isPackaged: true, execPath: '/opt/Kanban Board', desktopDir: '/repo/desktop' }), ['/opt/Kanban Board']);
  assert.deepEqual(buildExportCommand({ isPackaged: false, execPath: '/repo/node_modules/electron', desktopDir: '/repo/desktop' }), [
    '/repo/node_modules/electron',
    '/repo/desktop',
  ]);
  const spec = buildBackendLaunchSpec({
    isPackaged: true,
    platform: 'darwin',
    resourcesPath: '/r',
    userDataPath: '/u',
    desktopDir: '/d',
    baseEnv: {},
    exportCommand: ['/opt/Kanban Board'],
    devPythonExists: false,
    configPath: '/none',
  });
  assert.equal(spec.options.env.KANBAN_EXPORT_CMD, '["/opt/Kanban Board"]');
});
