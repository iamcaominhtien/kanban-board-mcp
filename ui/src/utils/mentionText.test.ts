import { describe, expect, it } from 'vitest';
import { mentionRefs, toFriendly, toStored } from './mentionText';

const pm = { id: 'm1', name: 'PM' };
const tien = { id: 'm2', name: 'Tien Cao' };
const pmo = { id: 'm3', name: 'PMO' };

describe('mentionText', () => {
  it('shows a stored mention as @Name', () => {
    expect(toFriendly('Hi @[PM](member:465eec59-797d) please look')).toBe('Hi @PM please look');
    expect(toFriendly('no mention [x](https://a.b)')).toBe('no mention [x](https://a.b)');
  });

  it('stores a typed or picked name with its id', () => {
    expect(toStored('Hi @PM please', [pm])).toBe('Hi @[PM](member:m1) please');
    expect(toStored('@PM', [pm])).toBe('@[PM](member:m1)');
    expect(toStored('ask @pm, then @Tien Cao.', [pm, tien])).toBe('ask @[PM](member:m1), then @[Tien Cao](member:m2).');
  });

  it('keeps the member name as written by the board, whatever letter case was typed', () => {
    expect(toStored('@tien cao ok', [tien])).toBe('@[Tien Cao](member:m2) ok');
  });

  it('does not store a name inside a longer word, an e-mail or an unknown name', () => {
    expect(toStored('@PMO is here', [pm])).toBe('@PMO is here');
    expect(toStored('mail me at a@PM.com', [pm])).toBe('mail me at a@PM.com');
    expect(toStored('@Nobody', [pm])).toBe('@Nobody');
  });

  it('prefers the longest matching name', () => {
    expect(toStored('@PMO and @PM', [pm, pmo])).toBe('@[PMO](member:m3) and @[PM](member:m1)');
  });

  it('leaves already stored mentions alone and round-trips', () => {
    const stored = 'Hi @[PM](member:m1) and @[Tien Cao](member:m2)';
    expect(toStored(stored, [pm, tien])).toBe(stored);
    expect(toStored(toFriendly(stored), [pm, tien])).toBe(stored);
  });

  it('can keep a member that is no longer in the list', () => {
    const stored = 'cc @[Old Name](member:gone)';
    expect(toStored(toFriendly(stored), mentionRefs(stored))).toBe(stored);
  });
});
