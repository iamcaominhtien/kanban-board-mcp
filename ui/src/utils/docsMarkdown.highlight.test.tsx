import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import { remarkDocs } from './docsMarkdown';

const html = (md: string) =>
  renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm, remarkDocs]}>{md}</ReactMarkdown>);

describe('reading view: ==text== is a highlight', () => {
  it('renders ==text== as <mark>', () => {
    expect(html('Tokens last ==30 days== for now.')).toBe('<p>Tokens last <mark>30 days</mark> for now.</p>');
  });

  it('keeps bold and links inside the highlight', () => {
    expect(html('A ==**key** point== and ==[spec](https://x.y)==.')).toBe(
      '<p>A <mark><strong>key</strong> point</mark> and <mark><a href="https://x.y">spec</a></mark>.</p>',
    );
  });

  it('leaves code, a lone == and an unclosed one as typed', () => {
    expect(html('Use `a == b` here.')).toBe('<p>Use <code>a == b</code> here.</p>');
    expect(html('```\nx == y\n```')).toBe('<pre><code>x == y\n</code></pre>');
    expect(html('a == b')).toBe('<p>a == b</p>');
    expect(html('x ==y = z== w')).toBe('<p>x ==y = z== w</p>');
  });

  it('works in headings, list items and table cells', () => {
    expect(html('## Tokens ==now==')).toContain('<mark>now</mark>');
    expect(html('- [ ] ==do it==')).toContain('<mark>do it</mark>');
    expect(html('| a |\n|---|\n| ==b== |')).toContain('<td><mark>b</mark></td>');
  });
});
