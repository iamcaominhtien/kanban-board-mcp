const test = require('node:test');
const assert = require('node:assert/strict');
const { isNewerVersion, pickAsset, buildUpdateInfo, expectedSha256, isTrustedDownloadUrl } = require('../updater-helpers');

const base = 'https://github.com/iamcaominhtien/kanban-board-mcp/releases/download/v2.4.0/';
const asset = (name, extra = {}) => ({ name, browser_download_url: base + name, size: 10, ...extra });
const release = {
  tag_name: 'v2.4.0',
  body: 'notes',
  html_url: 'https://github.com/x',
  assets: [asset('Kanban.Board-2.4.0-arm64.dmg'), asset('Kanban.Board-2.4.0.dmg'), asset('Kanban.Board.Setup.2.4.0.exe', { digest: 'sha256:' + 'A'.repeat(64) })],
};

test('isNewerVersion compares numerically, not lexically', () => {
  assert.equal(isNewerVersion('v2.10.0', '2.9.9'), true);
  assert.equal(isNewerVersion('2.3.1', '2.3.1'), false);
  assert.equal(isNewerVersion('2.3.0', '2.3.1'), false);
  assert.equal(isNewerVersion('garbage', '2.3.1'), false);
});

test('pickAsset selects installer by platform and arch', () => {
  assert.equal(pickAsset(release, 'darwin', 'arm64').name, 'Kanban.Board-2.4.0-arm64.dmg');
  assert.equal(pickAsset(release, 'darwin', 'x64').name, 'Kanban.Board-2.4.0.dmg');
  assert.equal(pickAsset(release, 'win32', 'x64').name, 'Kanban.Board.Setup.2.4.0.exe');
  assert.equal(pickAsset(release, 'linux', 'x64'), null);
});

test('buildUpdateInfo returns null when not newer, draft, or prerelease', () => {
  const ctx = { currentVersion: '2.4.0', platform: 'win32', arch: 'x64' };
  assert.equal(buildUpdateInfo(release, ctx), null);
  assert.equal(buildUpdateInfo({ ...release, prerelease: true }, { ...ctx, currentVersion: '2.3.0' }), null);
});

test('buildUpdateInfo returns installer info and sha256', () => {
  const info = buildUpdateInfo(release, { currentVersion: '2.3.1', platform: 'win32', arch: 'x64' });
  assert.equal(info.version, '2.4.0');
  assert.equal(info.sha256, 'a'.repeat(64));
});

test('untrusted download hosts are rejected', () => {
  assert.equal(isTrustedDownloadUrl('https://evil.example/a.exe'), false);
  const evil = { ...release, assets: [{ name: 'Setup.exe', browser_download_url: 'https://evil.example/Setup.exe' }] };
  assert.equal(buildUpdateInfo(evil, { currentVersion: '1.0.0', platform: 'win32', arch: 'x64' }), null);
  assert.equal(expectedSha256({ digest: 'md5:abc' }), null);
});
