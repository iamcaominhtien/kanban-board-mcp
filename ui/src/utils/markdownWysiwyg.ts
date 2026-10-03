/**
 * Utility functions to convert between Markdown and HTML for the WYSIWYG Editor (Approach B).
 * Strictly mirrors the styling and formatting from DescriptionMarkdown.dc.html.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatInlineMarkdown(text: string): string {
  // Images: ![alt](url)
  let out = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');

  // Links: [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Bold: **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic: *text* or _text_
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');

  // Inline code: `text`
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Mark / Highlight: <mark>text</mark> or ==text==
  out = out.replace(/==([^=]+)==/g, '<mark>$1</mark>');

  return out;
}

export function markdownToHtml(md: string): string {
  if (!md || !md.trim()) return '<p><br></p>';

  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const htmlParts: string[] = [];

  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let inUl = false;
  let inOl = false;
  let inAlign: 'center' | 'right' | null = null;
  let alignContent: string[] = [];

  function closeLists() {
    if (inUl) {
      htmlParts.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      htmlParts.push('</ol>');
      inOl = false;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block ```
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        htmlParts.push(`<pre><code>${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`);
        codeBlockContent = [];
        inCodeBlock = false;
      } else {
        closeLists();
        inCodeBlock = true;
        codeBlockContent = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Align container ::: center / ::: right / :::
    if (line.trim() === '::: center') {
      closeLists();
      inAlign = 'center';
      alignContent = [];
      continue;
    }
    if (line.trim() === '::: right') {
      closeLists();
      inAlign = 'right';
      alignContent = [];
      continue;
    }
    if (line.trim() === ':::' && inAlign) {
      const innerHtml = markdownToHtml(alignContent.join('\n'));
      htmlParts.push(`<div style="text-align: ${inAlign};">${innerHtml}</div>`);
      inAlign = null;
      alignContent = [];
      continue;
    }
    if (inAlign) {
      alignContent.push(line);
      continue;
    }

    // Blank line
    if (!line.trim()) {
      closeLists();
      continue;
    }

    // Headings
    if (line.startsWith('#### ')) {
      closeLists();
      htmlParts.push(`<h4>${formatInlineMarkdown(line.slice(5))}</h4>`);
      continue;
    }
    if (line.startsWith('### ')) {
      closeLists();
      htmlParts.push(`<h3>${formatInlineMarkdown(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith('## ')) {
      closeLists();
      htmlParts.push(`<h2>${formatInlineMarkdown(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith('# ')) {
      closeLists();
      htmlParts.push(`<h1>${formatInlineMarkdown(line.slice(2))}</h1>`);
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      closeLists();
      htmlParts.push(`<blockquote><p>${formatInlineMarkdown(line.slice(2))}</p></blockquote>`);
      continue;
    }

    // Bulleted list item (- or *)
    const ulMatch = line.match(/^[-*]\s+(.*)$/);
    if (ulMatch) {
      if (inOl) closeLists();
      if (!inUl) {
        htmlParts.push('<ul>');
        inUl = true;
      }
      htmlParts.push(`<li>${formatInlineMarkdown(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered list item (1.)
    const olMatch = line.match(/^\d+\.\s+(.*)$/);
    if (olMatch) {
      if (inUl) closeLists();
      if (!inOl) {
        htmlParts.push('<ol>');
        inOl = true;
      }
      htmlParts.push(`<li>${formatInlineMarkdown(olMatch[1])}</li>`);
      continue;
    }

    // Regular paragraph line
    closeLists();
    htmlParts.push(`<p>${formatInlineMarkdown(line)}</p>`);
  }

  closeLists();
  if (inCodeBlock) {
    htmlParts.push(`<pre><code>${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`);
  }

  return htmlParts.join('\n');
}

/**
 * Traverses an HTMLElement and serializes its content into clean, standard Markdown.
 */
export function htmlToMarkdown(root: HTMLElement): string {
  function serializeInline(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || '';
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    // Check style/attributes
    const childrenText = Array.from(el.childNodes).map(serializeInline).join('');

    switch (tag) {
      case 'strong':
      case 'b':
        return childrenText ? `**${childrenText}**` : '';
      case 'em':
      case 'i':
        return childrenText ? `*${childrenText}*` : '';
      case 'mark':
        return childrenText ? `<mark>${childrenText}</mark>` : '';
      case 'code':
        return childrenText ? `\`${childrenText}\`` : '';
      case 'a': {
        const href = el.getAttribute('href') || '#';
        return `[${childrenText || 'link'}](${href})`;
      }
      case 'img': {
        const src = el.getAttribute('src') || '';
        const alt = el.getAttribute('alt') || '';
        return `![${alt}](${src})`;
      }
      case 'br':
        return '\n';
      case 'span':
        if (el.classList.contains('md-selected')) {
          return childrenText;
        }
        return childrenText;
      default:
        return childrenText;
    }
  }

  function serializeBlock(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue?.trim();
      return text ? `${text}\n\n` : '';
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    // Check alignment
    const textAlign = el.style.textAlign;

    switch (tag) {
      case 'h1':
        return `# ${serializeInline(el)}\n\n`;
      case 'h2':
        return `## ${serializeInline(el)}\n\n`;
      case 'h3':
        return `### ${serializeInline(el)}\n\n`;
      case 'h4':
        return `#### ${serializeInline(el)}\n\n`;
      case 'p': {
        const inline = serializeInline(el);
        if (!inline.trim()) return '';
        if (textAlign === 'center') {
          return `::: center\n${inline}\n:::\n\n`;
        }
        if (textAlign === 'right') {
          return `::: right\n${inline}\n:::\n\n`;
        }
        return `${inline}\n\n`;
      }
      case 'blockquote': {
        const lines = Array.from(el.childNodes).map(serializeInline).join('').split('\n');
        return lines.map((l) => `> ${l}`).join('\n') + '\n\n';
      }
      case 'pre': {
        const code = el.querySelector('code')?.textContent ?? el.textContent ?? '';
        return `\`\`\`\n${code}\n\`\`\`\n\n`;
      }
      case 'ul': {
        const items = Array.from(el.querySelectorAll(':scope > li'))
          .map((li) => `- ${serializeInline(li)}`)
          .join('\n');
        return items ? `${items}\n\n` : '';
      }
      case 'ol': {
        const items = Array.from(el.querySelectorAll(':scope > li'))
          .map((li, idx) => `${idx + 1}. ${serializeInline(li)}`)
          .join('\n');
        return items ? `${items}\n\n` : '';
      }
      case 'div': {
        if (textAlign === 'center') {
          const content = Array.from(el.childNodes).map(serializeBlock).join('').trim();
          return `::: center\n${content}\n:::\n\n`;
        }
        if (textAlign === 'right') {
          const content = Array.from(el.childNodes).map(serializeBlock).join('').trim();
          return `::: right\n${content}\n:::\n\n`;
        }
        return Array.from(el.childNodes).map(serializeBlock).join('');
      }
      default: {
        const inline = serializeInline(el);
        return inline ? `${inline}\n\n` : '';
      }
    }
  }

  const rawBlocks = Array.from(root.childNodes).map(serializeBlock).join('');
  return rawBlocks.trim();
}
