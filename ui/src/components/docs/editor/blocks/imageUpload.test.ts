import { describe, expect, it } from 'vitest';
import { previewSrc } from './imageUpload';

describe('previewSrc', () => {
  it('keeps the blob: URL of a picked file and a typed http(s) or board address', () => {
    expect(previewSrc('blob:http://localhost/1234')).toBe('blob:http://localhost/1234');
    expect(previewSrc(' https://example.com/a.png ')).toBe('https://example.com/a.png');
    expect(previewSrc('/uploads/a.png')).toMatch(/^https?:\/\/[^/]+\/uploads\/a\.png$/);
  });

  it('refuses any other scheme', () => {
    expect(previewSrc('javascript:alert(1)')).toBeUndefined();
    expect(previewSrc('data:text/html,<b>x</b>')).toBeUndefined();
    expect(previewSrc('vbscript:x')).toBeUndefined();
  });
});
