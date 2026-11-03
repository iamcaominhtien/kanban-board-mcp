/** Block syntax at the start of a line: a heading, a list or task item, a quote, a fence, a table row or a rule. */
const BLOCK_LINE = /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|```|~~~|\|.*\||-{3,}\s*$|\*{3,}\s*$)/m;
/** HTML that carries structure of its own (a web page, Word, another editor): pasted as HTML, not as Markdown. */
const RICH_HTML = /<(p|h[1-6]|ul|ol|li|table|blockquote|pre|img|a)\b/i;

/**
 * The Markdown to insert when plain text is pasted, or null to paste it as the browser gives it. Text with block
 * syntax (headings, lists, tables, fences, quotes) from a plain-text source (a terminal, a code editor, an AI chat)
 * becomes blocks, as the page stores Markdown; text copied from a web page or another document keeps its HTML.
 * @param text - The clipboard's text/plain.
 * @param html - The clipboard's text/html ('' when absent).
 */
export function markdownToPaste(text: string, html: string): string | null {
  if (!text || !text.includes('\n')) return null;
  if (html && RICH_HTML.test(html)) return null;
  return BLOCK_LINE.test(text) ? text.replace(/\r\n?/g, '\n') : null;
}
