import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { common, createLowlight } from 'lowlight';
import { useRef, useState } from 'react';
import { CopyButton, copyText, diffLine, parseLineRanges } from '../../embeds/CodeView';
import { Panel, Row, Seg, Toggle } from '../blocks/ui';

/** Shared lowlight instance with the common languages. */
export const lowlight = createLowlight(common);

const LANGS = [
  ['', 'Plain text'],
  ['bash', 'Shell'],
  ['sh', 'sh'],
  ['json', 'JSON'],
  ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'],
  ['python', 'Python'],
  ['sql', 'SQL'],
  ['yaml', 'YAML'],
  ['xml', 'HTML / XML'],
  ['css', 'CSS'],
  ['markdown', 'Markdown'],
  ['diff', 'Diff'],
  ['go', 'Go'],
  ['rust', 'Rust'],
  ['java', 'Java'],
  ['ini', 'INI / TOML'],
];

/** The language picker (also in the settings panel). */
function LangSelect({
  lang,
  disabled,
  onChange,
  className,
}: {
  lang: string;
  disabled?: boolean;
  onChange: (v: string | null) => void;
  className: string;
}) {
  const known = LANGS.some(([v]) => v === lang);
  return (
    <select
      className={className}
      aria-label="Code language"
      contentEditable={false}
      value={lang}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    >
      {!known && <option value={lang}>{lang}</option>}
      {LANGS.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

/**
 * The code block settings (design "Embeds", frame 33): language, file name, line numbers, wrapping, theme,
 * highlighted lines and diff mode.
 */
function CodeSettings({
  attrs,
  update,
  anchor,
  onClose,
}: {
  attrs: Record<string, unknown>;
  update: (a: Record<string, unknown>) => void;
  anchor: DOMRect | null;
  onClose: () => void;
}) {
  return (
    <Panel
      title="Code block"
      anchor={anchor}
      onClose={onClose}
      testId="code-settings"
      footer={
        <button type="button" className="dk-btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <Row label="Language">
        <LangSelect
          className="dk-bp-input"
          lang={(attrs.language as string) ?? ''}
          onChange={(v) => update({ language: v })}
        />
      </Row>
      <Row label="File name">
        <input
          className="dk-bp-input"
          aria-label="File name"
          placeholder="tokens.py"
          value={(attrs.filename as string) ?? ''}
          onChange={(e) => update({ filename: e.target.value || null })}
        />
      </Row>
      <Toggle label="Line numbers" checked={!!attrs.lineNumbers} onChange={(v) => update({ lineNumbers: v })} />
      <Toggle
        label="Wrap long lines"
        hint="Off keeps one line per line and scrolls sideways"
        checked={!!attrs.wrap}
        onChange={(v) => update({ wrap: v })}
      />
      <Row label="Theme">
        <Seg
          label="Theme"
          value={attrs.theme === 'light' ? 'light' : 'dark'}
          onChange={(v) => update({ theme: v })}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ]}
        />
      </Row>
      <Row label="Highlight lines" hint='For example "5-6" or "2, 9-11"'>
        <input
          className="dk-bp-input"
          aria-label="Highlight lines"
          placeholder="5-6"
          value={(attrs.highlightLines as string) ?? ''}
          onChange={(e) => update({ highlightLines: e.target.value.trim() ? e.target.value : null })}
        />
      </Row>
      <Toggle
        label="Diff"
        hint="Lines starting with + or - are tinted"
        checked={!!attrs.diff}
        onChange={(v) => update({ diff: v })}
      />
    </Panel>
  );
}

function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const a = node.attrs as Record<string, unknown>;
  const lang = (a.language as string) ?? '';
  const filename = (a.filename as string) ?? '';
  const diff = !!a.diff;
  const gutter = !!a.lineNumbers || diff;
  const marked = parseLineRanges(a.highlightLines as string | null);
  const text = node.textContent;
  const lines = text.split('\n');
  const tinted = diff || marked.size > 0;
  const editable = editor.isEditable;
  const [settings, setSettings] = useState<DOMRect | null | false>(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const theme = a.theme === 'light' ? 'light' : 'dark';
  const lineCls = (l: string, i: number) => {
    const d = diff ? diffLine(l) : null;
    return [marked.has(i + 1) ? 'dk-cv-hl' : '', d?.sign === '+' ? 'dk-cv-add' : d?.sign === '-' ? 'dk-cv-del' : '']
      .filter(Boolean)
      .join(' ');
  };
  return (
    <NodeViewWrapper
      className={`dk-code-wrap dk-cv-edit dk-cv-${theme}${a.wrap ? ' dk-cv-wrap' : ' dk-cv-nowrap'}${gutter ? ' dk-cv-gut' : ''}`}
      data-language={lang || undefined}
      style={{ position: 'relative' }}
    >
      <div ref={wrapRef} className="dk-cv-head dk-cv-head-edit" contentEditable={false}>
        {editable ? (
          <input
            className="dk-cv-file dk-cv-file-input"
            aria-label="File name"
            placeholder="File name"
            value={filename}
            size={Math.max(8, filename.length + 1)}
            onChange={(e) => updateAttributes({ filename: e.target.value || null })}
          />
        ) : (
          filename && <span className="dk-cv-file">{filename}</span>
        )}
        <LangSelect
          className="dk-cv-lang-pick"
          lang={lang}
          disabled={!editable}
          onChange={(v) => updateAttributes({ language: v })}
        />
        {editable && (
          <button
            type="button"
            className="dk-cv-copy"
            aria-label="Code block settings"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setSettings(wrapRef.current?.getBoundingClientRect() ?? null)}
          >
            Settings
          </button>
        )}
        <CopyButton text={copyText(text, diff)} />
      </div>
      <div className="dk-cv-edit-body">
        {gutter && (
          <div className="dk-cv-edit-gutter" contentEditable={false} aria-hidden="true">
            {lines.map((l, i) => (
              <div key={i} className={lineCls(l, i)}>
                {diff ? diffLine(l).sign.trim() || ' ' : i + 1}
              </div>
            ))}
          </div>
        )}
        <div className="dk-cv-edit-main">
          {tinted && !a.wrap && (
            <div className="dk-cv-edit-back" contentEditable={false} aria-hidden="true">
              {lines.map((l, i) => (
                <div key={i} className={lineCls(l, i)}>
                  {' '}
                </div>
              ))}
            </div>
          )}
          <pre className="dk-code" spellCheck={false}>
            <NodeViewContent as={'code' as 'div'} />
          </pre>
        </div>
      </div>
      {settings !== false && (
        <CodeSettings attrs={a} update={updateAttributes} anchor={settings} onClose={() => setSettings(false)} />
      )}
    </NodeViewWrapper>
  );
}

/**
 * Fenced code with lowlight highlighting (palette in editor.css: mc-k/s/p/c/f), a header with the file name, the
 * language, Settings and Copy, and the rich options (line numbers, wrap, theme, highlighted lines, diff).
 */
export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
}).configure({ lowlight, defaultLanguage: null });
