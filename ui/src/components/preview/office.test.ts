// @vitest-environment jsdom
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parsePptx } from './office';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const para = (text: string, sz?: number) =>
  `<a:p><a:r><a:rPr${sz ? ` sz="${sz}"` : ''}/><a:t>${text}</a:t></a:r></a:p>`;
const slide = (...paras: string[]) =>
  `<p:sld ${NS}><p:cSld><p:spTree>${paras.map((p) => `<p:sp><p:txBody>${p}</p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`;
const deck = (slides: string[]) =>
  zipSync(Object.fromEntries(slides.map((s, i) => [`ppt/slides/slide${i + 1}.xml`, strToU8(s)])));

describe('parsePptx titles', () => {
  it('takes the biggest text as the title when the deck has no title placeholder', () => {
    const [s] = parsePptx(
      deck([
        slide(
          para('THE PROBLEM', 1050),
          para('Your board never hears about it.', 3750),
          para('Plans live in a chat', 1950),
        ),
      ]),
    );
    expect(s.title).toBe('Your board never hears about it.');
    expect(s.kicker).toBe('THE PROBLEM');
    expect(s.lines).toEqual(['Plans live in a chat']);
  });

  it('does not take a big figure for the title', () => {
    const [s] = parsePptx(deck([slide(para('12', 19500), para('MCP tools: the whole board', 3450))]));
    expect(s.title).toBe('MCP tools: the whole board');
    expect(s.lines).toEqual(['12']);
  });

  it('leaves out a footer every slide repeats and the slide number', () => {
    const slides = [1, 2, 3, 4].map((n) =>
      slide(para(`Title ${n}`, 3000), para('Kanban Board MCP', 1000), para(`0${n}`, 1000)),
    );
    const out = parsePptx(deck(slides));
    expect(out.map((s) => s.title)).toEqual(['Title 1', 'Title 2', 'Title 3', 'Title 4']);
    expect(out.every((s) => s.lines.length === 0)).toBe(true);
  });

  it('prefers a real title placeholder', () => {
    const real = `<p:sld ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>${para('Real title', 2000)}</p:txBody></p:sp><p:sp><p:txBody>${para('Bigger text', 5000)}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    expect(parsePptx(deck([real]))[0].title).toBe('Real title');
  });
});
