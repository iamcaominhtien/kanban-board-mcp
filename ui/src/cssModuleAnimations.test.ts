import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// In a CSS module an animation name is local: `animation: spin` names this module's own `@keyframes spin`. Without
// one it points at nothing and the element stands still (the draw.io editor's spinner, the splash, the loading bars).
const KEYWORDS = new Set([
  'none',
  'inherit',
  'initial',
  'unset',
  'infinite',
  'linear',
  'alternate',
  'forwards',
  'both',
]);

function modules(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return modules(path);
    return name.endsWith('.module.css') ? [path] : [];
  });
}

function animationNames(css: string): string[] {
  const names: string[] = [];
  for (const m of css.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    for (const part of m[1].split(',')) {
      for (const token of part.trim().split(/\s+/)) {
        if (/^-?[a-zA-Z_][\w-]*$/.test(token) && !KEYWORDS.has(token) && !/^ease|^steps|^cubic/.test(token))
          names.push(token);
      }
    }
  }
  return names;
}

describe('CSS module animations', () => {
  it('every animation a module uses has its keyframes in that module', () => {
    const missing: string[] = [];
    for (const file of modules(join(__dirname))) {
      const css = readFileSync(file, 'utf8');
      for (const name of new Set(animationNames(css))) {
        if (!new RegExp(`@keyframes\\s+${name}\\b`).test(css))
          missing.push(`${file.replace(__dirname, 'src')}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
