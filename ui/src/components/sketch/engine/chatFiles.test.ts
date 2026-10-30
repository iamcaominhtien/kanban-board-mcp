import test from 'node:test';
import assert from 'node:assert/strict';
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
} from './chatFiles.ts';

const file = (name: string, type: string, size: number) => ({ name, type, size });

test('pictures and text files are accepted, by type and by extension', () => {
  assert.deepEqual(classifyFile(file('a.png', 'image/png', 1000)), { kind: 'image', needsScaling: false });
  assert.equal(classifyFile(file('b.webp', 'image/webp', 10)).kind, 'image');
  assert.equal(classifyFile(file('notes.md', '', 10)).kind, 'text');
  assert.equal(classifyFile(file('App.TSX', 'text/plain', 10)).kind, 'text');
  assert.deepEqual(classifyFile(file('big.jpg', 'image/jpeg', MAX_IMAGE_BYTES - 1)), {
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
    assert.equal(v.kind, 'refused');
    if (v.kind === 'refused') {
      assert.ok(v.message.includes(word), v.message);
      assert.ok(v.message.includes('PNG, JPEG, WebP or GIF'));
    }
  }
  assert.equal(classifyFile(file('e.txt', 'text/plain', 0)).kind, 'refused');
  const big = classifyFile(file('l.log', 'text/plain', MAX_TEXT_BYTES + 1));
  assert.ok(big.kind === 'refused' && big.message.includes('200 KB'));
});

test('a message takes four pictures and four text files', () => {
  const pics = Array.from({ length: 5 }, (_, i) => file(`${i}.png`, 'image/png', 10));
  const r = admit({ images: 0, texts: 0 }, pics);
  assert.equal(r.accepted.length, 4);
  assert.deepEqual(r.refused, ['At most 4 pictures can be attached to one message.']);
  const r2 = admit({ images: 3, texts: 4 }, [
    file('a.png', 'image/png', 1),
    file('b.png', 'image/png', 1),
    file('c.txt', '', 1),
  ]);
  assert.equal(r2.accepted.length, 1);
  assert.equal(r2.refused.length, 2);
  assert.equal(admit({ images: 0, texts: 0 }, [file('x.pdf', 'application/pdf', 5)]).accepted.length, 0);
});

test('a picture that is still too large after scaling is refused', () => {
  assert.equal(tooLarge('a.png', 1000), null);
  assert.ok(tooLarge('a.png', MAX_IMAGE_BYTES + 1)?.includes('5.0 MB'));
});

test('pictures are scaled down, never up', () => {
  assert.deepEqual(scaledSize(3200, 1600), { width: 1600, height: 800, scaled: true });
  assert.deepEqual(scaledSize(800, 600), { width: 800, height: 600, scaled: false });
  assert.deepEqual(scaledSize(1, 1), { width: 1, height: 1, scaled: false });
});

test('a picture put on the drawing is centred and fits the canvas', () => {
  assert.deepEqual(fitInside(100, 50, 400, 300), { x: 150, y: 125, w: 100, h: 50 });
  assert.deepEqual(fitInside(800, 400, 400, 300), { x: 0, y: 50, w: 400, h: 200 });
  assert.deepEqual(fitInside(300, 900, 400, 300), { x: 150, y: 0, w: 100, h: 300 });
});

test('the chat of a sketch is kept under its id, or under a draft key until it has one', () => {
  assert.equal(chatScopeId({ sketchId: 'sk_8f2a1c3d', chatKey: 'k', ownerKind: 'doc', ownerId: 'p' }), 'sk_8f2a1c3d');
  assert.equal(
    chatScopeId({ chatKey: 'abcd1234efgh', ownerKind: 'ticket', ownerId: 'KAN-12', projectId: 'pid-1' }),
    'new~abcd1234efgh~ticket~KAN-12~pid-1',
  );
  assert.equal(chatScopeId({ chatKey: 'abcd1234efgh', ownerKind: 'doc', ownerId: 'x' }), 'new~abcd1234efgh~doc~x~-');
  const key = newChatKey();
  assert.match(key, /^[a-z0-9]{16}$/);
  assert.notEqual(key, newChatKey());
});
