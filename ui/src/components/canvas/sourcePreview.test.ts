import { expect, test } from 'vitest';
import { inlineBoard } from './sourcePreview';

test("the preview inlines the board's own stylesheet and pictures and leaves outside addresses alone", () => {
  const html =
    '<link rel="stylesheet" href="css/site.css"><link rel="stylesheet" href="https://cdn.example.com/x.css"><img src="img/a.png"><img src="https://t.example/p.gif"><h1>Hi</h1>';
  const out = inlineBoard(
    'index.html',
    { 'index.html': html, 'css/site.css': 'h1{background:url(../img/a.png)} p{color:red}' },
    { 'img/a.png': 'data:image/png;base64,AAAA' },
  );
  expect(out).toContain('<style>h1{background:url(data:image/png;base64,AAAA)} p{color:red}</style>');
  expect(out).toContain('src="data:image/png;base64,AAAA"');
  expect(out).toContain('href="https://cdn.example.com/x.css"'); // left for the safe frame to drop
  expect(out).toContain('src="https://t.example/p.gif"');
});

test('a page in a folder finds its files relative to itself', () => {
  const out = inlineBoard(
    'pages/home.html',
    { 'pages/home.html': '<link rel=stylesheet href="../a.css">', 'a.css': 'b{c:d}' },
    {},
  );
  expect(out).toContain('<style>b{c:d}</style>');
});
