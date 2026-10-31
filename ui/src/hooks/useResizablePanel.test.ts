import { describe, expect, it } from 'vitest';
import { clampWidth } from './useResizablePanel';

describe('clampWidth', () => {
  it('keeps a width inside the range', () => {
    expect(clampWidth(500, 300, 900)).toBe(500);
    expect(clampWidth(100, 300, 900)).toBe(300);
    expect(clampWidth(2000, 300, 900)).toBe(900);
  });
  it('lets a small window win over the minimum', () => {
    expect(clampWidth(500, 340, 260)).toBe(260);
  });
});
