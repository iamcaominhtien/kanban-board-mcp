import { describe, expect, it } from 'vitest';
import { pdfOfDeck } from './kinds';

const f = (id: string, name: string) => ({ id, name });

describe('pdfOfDeck', () => {
  it("finds the PDF with the same file name, as the deck's own", () => {
    const deck = f('1', 'Pitch.pptx');
    expect(pdfOfDeck(deck, [deck, f('2', 'pitch.PDF'), f('3', 'Other.pdf')])).toEqual({
      item: f('2', 'pitch.PDF'),
      exact: true,
    });
  });

  it('offers the PDF of the deck for its Office-font copy, but does not say it is the same file', () => {
    const copy = f('1', 'Deck-office-fonts.pptx');
    expect(pdfOfDeck(copy, [copy, f('2', 'Deck.pdf')])).toEqual({ item: f('2', 'Deck.pdf'), exact: false });
  });

  it('finds nothing for a deck whose name no PDF shares', () => {
    const deck = f('1', 'Deck-v2.pptx');
    expect(pdfOfDeck(deck, [deck, f('2', 'Deck.pdf')])).toBeNull();
    expect(pdfOfDeck(deck)).toBeNull();
  });
});
