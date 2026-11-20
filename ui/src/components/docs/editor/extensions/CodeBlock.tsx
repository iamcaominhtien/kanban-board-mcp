import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { common, createLowlight } from 'lowlight';
import { useRef, useState } from 'react';
import {
  CopyButton,
  LONG_CODE_LINES,
  ShowAllButton,
  copyText,
  diffLine,
  languageName,
  parseLineRanges,
} from '../../embeds/CodeView';
import { EmbIcon } from '../../embeds/embIcons';
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
    <Panel title="Code block" anchor={anchor} onClose={onClose} testId="code-settings">
      <div className="dk-bp-pair dk-cs-pair">
        <Row label="Language">
          <LangSelect
            className="dk-bp-input"
            lang={(attrs.language as string) ?? ''}
            onChange={(v) => update({ language: v })}
          />
        </Row>
        <Row label="File name">
          <input
            className="dk-bp-input dk-cs-mono"
            aria-label="File name"
            placeholder="tokens.py"
            value={(attrs.filename as string) ?? ''}
            onChange={(e) => update({ filename: e.target.value || null })}
          />
        </Row>
      </div>
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
      <div className="dk-emb-sz-done">
        <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={onClose}>
          Done
        </button>
      </div>
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
  const [all, setAll] = useState(false);
  const long = lines.length > LONG_CODE_LINES;
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
          <span className="dk-cv-file">
            <EmbIcon name="page" size={12} />
            <input
              className="dk-cv-file-input"
              aria-label="File name"
              placeholder="File name"
              value={filename}
              size={Math.max(8, filename.length + 1)}
              onChange={(e) => updateAttributes({ filename: e.target.value || null })}
            />
          </span>
        ) : (
          filename && (
            <span className="dk-cv-file">
              <EmbIcon name="page" size={12} />
              {filename}
            </span>
          )
        )}
        <span style={{ flex: 1 }} />
        {editable ? (
          // the language opens the block's settings (Embeds 33: "from the language picker")
          <button
            type="button"
            className="dk-cv-lang dk-cv-lang-btn"
            aria-label="Code block settings"
            title="Language and settings"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setSettings(wrapRef.current?.getBoundingClientRect() ?? null)}
          >
            {diff ? 'Diff' : languageName(lang)}
            <EmbIcon name="chevDown" size={11} sw={2.4} />
          </button>
        ) : (
          <span className="dk-cv-lang">{diff ? 'Diff' : languageName(lang)}</span>
        )}
        {editable && (
          <>
            <button
              type="button"
              className={`dk-cv-ico${a.lineNumbers ? ' dk-cv-ico-on' : ''}`}
              aria-label="Line numbers"
              aria-pressed={!!a.lineNumbers}
              title="Line numbers"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => updateAttributes({ lineNumbers: !a.lineNumbers })}
            >
              <EmbIcon name="hash" size={14} />
            </button>
            <button
              type="button"
              className={`dk-cv-ico${a.wrap ? ' dk-cv-ico-on' : ''}`}
              aria-label="Wrap long lines"
              aria-pressed={!!a.wrap}
              title="Wrap long lines"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => updateAttributes({ wrap: !a.wrap })}
            >
              <EmbIcon name="wrap" size={14} />
            </button>
            <button
              type="button"
              className="dk-cv-ico"
              aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
              title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => updateAttributes({ theme: theme === 'dark' ? 'light' : 'dark' })}
            >
              <EmbIcon name={theme === 'dark' ? 'moon' : 'sun'} size={14} />
            </button>
          </>
        )}
        <CopyButton text={copyText(text, diff)} />
      </div>
      <div className="dk-cv-frame">
        <div className={`dk-cv-edit-body${long && !all ? ' dk-cv-clip' : ''}`}>
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
        {long && <ShowAllButton all={all} lines={lines.length} onToggle={() => setAll((v) => !v)} />}
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
