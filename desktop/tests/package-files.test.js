const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const shipped = new Set(require('../package.json').build.files);

// A module the app requires at startup but electron-builder doesn't package crashes the packaged app with
// "Cannot find module './x'" (it did for ./export-svg), while `npm start` from the source tree still works.
test('every local module the shipped files require is packaged', () => {
  const missing = [];
  for (const file of shipped) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [, dep] of src.matchAll(/require\('\.\/([\w-]+)(?:\.js)?'\)/g)) {
      if (!shipped.has(`${dep}.js`)) missing.push(`${file} -> ${dep}.js`);
    }
  }
  assert.deepStrictEqual(missing, []);
});
