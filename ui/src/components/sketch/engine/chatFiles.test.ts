import { expect, test } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  admit,
  chatScopeId,
  classifyFile,
  fitInside,
  newChatKey,
  scaledSize,
  tooLarge,
} from './chatFiles';

const file = (name: string, type: string, size: number) => ({ name, type, size });

test('pictures and text files are accepted, by type and by extension', () => {
  expect(classifyFile(file('a.png', 'image/png', 1000))).toStrictEqual({ kind: 'image', needsScaling: false });
  expect(classifyFile(file('b.webp', 'image/webp', 10)).kind).toBe('image');
  expect(classifyFile(file('notes.md', '', 10)).kind).toBe('text');
  expect(classifyFile(file('App.TSX', 'text/plain', 10)).kind).toBe('text');
  expect(classifyFile(file('big.jpg', 'image/jpeg', MAX_IMAGE_BYTES - 1))).toStrictEqual({
    kind: 'image',
    needsScaling: true,
  });
});

test('everything else is refused with a plain message that says what is accepted', () => {
  for (const [f, word] of [
    [file('r.pdf', 'application/pdf', 10), 'a PDF'],
    [file('m.docx', '', 10), 'office file'],
    [file('z.zip', 'application/zip', 10), 'archive'],
    [file('x.bin', '', 10), 'cannot be read'],
  ] as const) {
    const v = classifyFile(f);
    expect(v.kind).toBe('refused');
    if (v.kind === 'refused') {
      expect(v.message.includes(word), v.message).toBeTruthy();
      expect(v.message.includes('PNG, JPEG, WebP or GIF')).toBeTruthy();
    }
  }
  expect(classifyFile(file('e.txt', 'text/plain', 0)).kind).toBe('refused');
  const big = classifyFile(file('l.log', 'text/plain', MAX_TEXT_BYTES + 1));
  expect(big.kind === 'refused' && big.message.includes('200 KB')).toBeTruthy();
});

test('a message takes four pictures and four text files', () => {
  const pics = Array.from({ length: 5 }, (_, i) => file(`${i}.png`, 'image/png', 10));
  const r = admit({ images: 0, texts: 0 }, pics);
  expect(r.accepted.length).toBe(4);
  expect(r.refused).toStrictEqual(['At most 4 pictures can be attached to one message.']);
  const r2 = admit({ images: 3, texts: 4 }, [
    file('a.png', 'image/png', 1),
    file('b.png', 'image/png', 1),
    file('c.txt', '', 1),
  ]);
  expect(r2.accepted.length).toBe(1);
  expect(r2.refused.length).toBe(2);
  expect(admit({ images: 0, texts: 0 }, [file('x.pdf', 'application/pdf', 5)]).accepted.length).toBe(0);
});

test('a picture that is still too large after scaling is refused', () => {
  expect(tooLarge('a.png', 1000)).toBe(null);
  expect(tooLarge('a.png', MAX_IMAGE_BYTES + 1)?.includes('5.0 MB')).toBeTruthy();
});

test('pictures are scaled down, never up', () => {
  expect(scaledSize(3200, 1600)).toStrictEqual({ width: 1600, height: 800, scaled: true });
  expect(scaledSize(800, 600)).toStrictEqual({ width: 800, height: 600, scaled: false });
  expect(scaledSize(1, 1)).toStrictEqual({ width: 1, height: 1, scaled: false });
});

test('a picture put on the drawing is centred and fits the canvas', () => {
  expect(fitInside(100, 50, 400, 300)).toStrictEqual({ x: 150, y: 125, w: 100, h: 50 });
  expect(fitInside(800, 400, 400, 300)).toStrictEqual({ x: 0, y: 50, w: 400, h: 200 });
  expect(fitInside(300, 900, 400, 300)).toStrictEqual({ x: 150, y: 0, w: 100, h: 300 });
});

test('the chat of a sketch is kept under its id, or under a draft key until it has one', () => {
  expect(chatScopeId({ sketchId: 'sk_8f2a1c3d', chatKey: 'k', ownerKind: 'doc', ownerId: 'p' })).toBe('sk_8f2a1c3d');
  expect(chatScopeId({ chatKey: 'abcd1234efgh', ownerKind: 'ticket', ownerId: 'KAN-12', projectId: 'pid-1' })).toBe(
    'new~abcd1234efgh~ticket~KAN-12~pid-1',
  );
  expect(chatScopeId({ chatKey: 'abcd1234efgh', ownerKind: 'doc', ownerId: 'x' })).toBe('new~abcd1234efgh~doc~x~-');
  const key = newChatKey();
  expect(key).toMatch(/^[a-z0-9]{16}$/);
  expect(key).not.toBe(newChatKey());
});
