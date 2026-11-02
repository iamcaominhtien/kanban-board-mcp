'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseExportArgs, parsePngArgs, isAllowedPageUrl } = require('../export-svg');

test('--export-png draws a page the board serves on 127.0.0.1, at a width, the whole page without a height (#267)', () => {
  const base = ['x', '--export-png', 'http://127.0.0.1:5123/index.html', '/tmp/out.png'];
  assert.deepEqual(parseExportArgs([...base, '--width', '390']), {
    png: true,
    url: 'http://127.0.0.1:5123/index.html',
    output: '/tmp/out.png',
    width: 390,
    height: null,
  });
  assert.equal(parsePngArgs([...base, '--width', '1280', '--height', '900']).height, 900);
  assert.match(parseExportArgs([...base]).error, /usage/);
  assert.match(parseExportArgs([...base, '--width', '20']).error, /usage/);
  assert.match(parseExportArgs([...base, '--width', '390', '--height', 'tall']).error, /usage/);
  for (const bad of ['file:///etc/passwd', 'https://example.com/', 'http://localhost:5123/']) {
    assert.match(parseExportArgs(['x', '--export-png', bad, '/tmp/o.png', '--width', '390']).error, /127\.0\.0\.1/, bad);
  }
});

test('a page drawn for a picture loads its own server and public hosts, never the rest of the machine', () => {
  const page = 'http://127.0.0.1:5123/index.html';
  assert.ok(isAllowedPageUrl('http://127.0.0.1:5123/tokens.css', page));
  assert.ok(isAllowedPageUrl('https://fonts.googleapis.com/css2?family=Inter', page));
  assert.ok(isAllowedPageUrl('data:image/png;base64,AAAA', page));
  for (const bad of [
    'http://127.0.0.1:8010/api/projects',
    'http://localhost:3000/',
    'http://192.168.1.2/',
    'http://10.0.0.1/',
    'http://172.20.0.1/',
    'http://[::1]:8010/',
    'file:///etc/passwd',
    'http://printer.local/',
  ]) {
    assert.ok(!isAllowedPageUrl(bad, page), bad);
  }
});
