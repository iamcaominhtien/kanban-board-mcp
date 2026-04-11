#!/usr/bin/env node
/**
 * Generates desktop app icons from docs/assets/logo.svg.
 * Outputs:
 *   desktop/build/icon.png   — 512×512 PNG
 *   desktop/build/icon.icns  — macOS icon set (via iconutil)
 *   desktop/build/icon.ico   — Windows icon (via png-to-ico)
 *
 * Usage (from repo root):
 *   node desktop/scripts/generate-icons.js
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const pngToIco = require('png-to-ico');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_SVG = path.join(ROOT, 'docs', 'assets', 'logo.svg');
const BUILD_DIR = path.join(ROOT, 'desktop', 'build');
const ICON_PNG = path.join(BUILD_DIR, 'icon.png');
const ICON_ICNS = path.join(BUILD_DIR, 'icon.icns');
const ICON_ICO = path.join(BUILD_DIR, 'icon.ico');

async function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  // 1. Render SVG → 512×512 PNG
  console.log('Generating icon.png …');
  await sharp(SRC_SVG).resize(512, 512).png().toFile(ICON_PNG);
  console.log(`  ✓ ${ICON_PNG}`);

  // 2. macOS icns via iconutil
  if (process.platform === 'darwin') {
    console.log('Generating icon.icns …');
    const iconsetDir = path.join(BUILD_DIR, 'icon.iconset');
    fs.mkdirSync(iconsetDir, { recursive: true });

    await Promise.all(
      [16, 32, 64, 128, 256, 512].flatMap(size => [
        sharp(SRC_SVG).resize(size, size).png().toFile(path.join(iconsetDir, `icon_${size}x${size}.png`)),
        sharp(SRC_SVG).resize(size * 2, size * 2).png().toFile(path.join(iconsetDir, `icon_${size}x${size}@2x.png`))
      ])
    );

    execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', ICON_ICNS]);
    fs.rmSync(iconsetDir, { recursive: true, force: true });
    console.log(`  ✓ ${ICON_ICNS}`);
  } else {
    console.log('  (skipping icon.icns — not macOS)');
  }

  // 3. Windows ico via png-to-ico
  console.log('Generating icon.ico …');
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const pngBuffers = await Promise.all(
    icoSizes.map((size) => sharp(SRC_SVG).resize(size, size).png().toBuffer())
  );
  const icoBuffer = await pngToIco(pngBuffers);
  fs.writeFileSync(ICON_ICO, icoBuffer);
  console.log(`  ✓ ${ICON_ICO}`);

  console.log('\nAll icons generated successfully.');
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
