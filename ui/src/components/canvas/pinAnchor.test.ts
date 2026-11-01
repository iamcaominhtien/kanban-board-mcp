// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { anchorAt, resolveAnchor, selectorFor } from './pinAnchor';

function page(html: string): Document {
  const d = document.implementation.createHTMLDocument('p');
  d.body.innerHTML = html;
  return d;
}
const rect = (el: Element, r: { left: number; top: number; width: number; height: number }) =>
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    ...r,
    right: r.left + r.width,
    bottom: r.top + r.height,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  });

test('a selector finds the same element again: id, stable attribute, or the path', () => {
  const d = page('<main><ul><li>a</li><li id="b">b</li><li data-testid="c">c</li><li>d</li></ul></main>');
  for (const el of Array.from(d.querySelectorAll('li'))) {
    const s = selectorFor(el);
    expect(d.querySelector(s)).toBe(el);
  }
  expect(selectorFor(d.getElementById('b')!)).toBe('#b');
  expect(selectorFor(d.querySelector('[data-testid=c]')!)).toBe('li[data-testid="c"]');
  expect(selectorFor(d.querySelectorAll('li')[3])).toContain('li:nth-of-type(4)');
});

test('a pin keeps its element and where inside it, and follows it when the page is laid out again', () => {
  const d = page('<form><button class="primary">Add task</button></form>');
  const button = d.querySelector('button')!;
  // made at phone width: the button is 300 wide at (45, 700); the person clicked 3/4 across and in the middle
  rect(button, { left: 45, top: 700, width: 300, height: 48 });
  d.elementFromPoint = vi.fn(() => button);
  const a = anchorAt(d, 45 + 225, 700 + 24, 390)!;
  expect(a).toMatchObject({ text: 'Add task', ox: 0.75, oy: 0.5, w: 390 });
  expect(d.querySelector(a.sel!)).toBe(button);
  // at desktop width the same page puts the button elsewhere: the pin goes with it
  rect(button, { left: 520, top: 380, width: 200, height: 40 });
  expect(resolveAnchor(d, a)).toEqual({ x: 520 + 0.75 * 200, y: 380 + 0.5 * 40 });
});

test('without the selector the text finds the element; without both there is nothing to follow', () => {
  const d = page('<section><p>Intro</p><a href="#">Start focus</a></section>');
  const link = d.querySelector('a')!;
  rect(link, { left: 10, top: 20, width: 100, height: 20 });
  expect(resolveAnchor(d, { sel: '#gone > a', text: 'start FOCUS', ox: 0, oy: 0 })).toEqual({ x: 10, y: 20 });
  expect(resolveAnchor(d, { sel: '!!not css!!', text: 'Start focus', ox: 1, oy: 1 })).toEqual({ x: 110, y: 40 });
  expect(resolveAnchor(d, { sel: '#gone', ox: 0.5, oy: 0.5 })).toBeNull();
  expect(resolveAnchor(d, { text: 'nothing like this', ox: 0.5, oy: 0.5 })).toBeNull();
});

test('the page background is not an element to follow', () => {
  const d = page('<p>hi</p>');
  d.elementFromPoint = vi.fn(() => d.body);
  expect(anchorAt(d, 5, 5, 390)).toBeNull();
  d.elementFromPoint = vi.fn(() => null);
  expect(anchorAt(d, 5, 5, 390)).toBeNull();
});
