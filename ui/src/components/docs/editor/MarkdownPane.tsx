import { useMemo } from 'react';
import { TICKET_KEY_SRC } from './constants';

interface Props {
  value: string;
  onChange: (v: string) => void;
  filename: string;
  readOnly?: boolean;
}

const LINE_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};

const TOKEN = new RegExp(`(\\[\\[[^\\]\\n]*\\]\\])|(\`[^\`\\n]*\`)|(\\b${TICKET_KEY_SRC}\\b)`, 'g');

function inline(text: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1])
      out.push(
        <span key={m.index} style={{ color: '#2F6FB0', background: 'rgba(47,111,176,0.10)', borderRadius: 3 }}>
          {m[1]}
        </span>,
      );
    else if (m[2])
      out.push(
        <span key={m.index} style={{ color: '#2E6F40' }}>
          {m[2]}
        </span>,
      );
    else
      out.push(
        <span key={m.index} style={{ color: '#6D5DD3', background: 'rgba(109,93,211,0.10)', borderRadius: 3 }}>
          {m[3]}
        </span>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : ' ';
}

function highlight(lines: string[]) {
  let fence = false;
  return lines.map((line, i) => {
    let content: React.ReactNode;
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      content = <span style={{ color: '#9AA8A0' }}>{line}</span>;
    } else if (fence) {
      content = line || ' ';
    } else if (/^#{1,6}\s/.test(line)) {
      const m = /^(#{1,6}\s)(.*)$/.exec(line)!;
      content = (
        <>
          <span style={{ color: '#2E6F40', fontWeight: 700 }}>{m[1]}</span>
          <span style={{ color: '#2E6F40', fontWeight: 700 }}>{m[2]}</span>
        </>
      );
    } else if (/^>\s?\[!\w+\]/.test(line)) {
      content = <span style={{ color: '#B4791E', fontWeight: 700 }}>{line}</span>;
    } else if (/^>\s?/.test(line)) {
      const m = /^(>\s?)(.*)$/.exec(line)!;
      content = (
        <>
          <span style={{ color: '#B4791E', fontWeight: 700 }}>{m[1]}</span>
          {inline(m[2])}
        </>
      );
    } else {
      content = inline(line);
    }
    return (
      <div key={i} style={{ display: 'flex', gap: 12 }}>
        <span style={{ width: 22, textAlign: 'right', color: '#C7D2CB', flexShrink: 0, userSelect: 'none' }}>
          {i + 1}
        </span>
        <span style={LINE_STYLE}>{content}</span>
      </div>
    );
  });
}

/** Markdown source view (DocsEditor board D): line numbers, highlighting layer under a transparent textarea. */
export function MarkdownPane({ value, onChange, filename, readOnly }: Props) {
  const lines = useMemo(() => value.split('\n'), [value]);
  const rows = useMemo(() => highlight(lines), [lines]);
  return (
    <div
      data-testid="markdown-pane"
      style={{
        border: '1px solid #2E6F40',
        borderRadius: 12,
        background: '#FFFFFF',
        overflow: 'hidden',
        boxShadow: '0 0 0 3px rgba(46,111,64,0.10),0 10px 28px rgba(30,42,34,0.08)',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 44,
          padding: '0 14px',
          borderBottom: '1px solid #E3E8E5',
          background: '#F6FAF7',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5B6B60' }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{filename}</span>
          <span style={{ color: '#C7D2CB' }}>|</span>
          <span data-testid="char-count">{value.length} characters</span>
        </span>
      </div>
      <div
        style={{
          position: 'relative',
          padding: '14px 16px',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12.5,
          lineHeight: 1.7,
          color: '#3A4A3E',
          minHeight: 400,
        }}
      >
        <div aria-hidden="true">{rows}</div>
        <textarea
          aria-label="Markdown source"
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            boxSizing: 'border-box',
            padding: '14px 16px 14px 50px',
            margin: 0,
            border: 'none',
            outline: 'none',
            resize: 'none',
            overflow: 'hidden',
            background: 'transparent',
            color: 'transparent',
            caretColor: '#1E2A22',
            font: 'inherit',
            lineHeight: 'inherit',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            letterSpacing: 'inherit',
            tabSize: 2,
          }}
        />
      </div>
    </div>
  );
}
