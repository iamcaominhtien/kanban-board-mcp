import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import type { CSSProperties, ReactNode } from 'react';
import { Icon } from '../Icon';

interface Props {
  editor: Editor | null;
  disabled?: boolean;
  onLink: () => void;
  onPickImage: () => void;
  ticketPrefix: string;
}

const ACTIVE: CSSProperties = { background: '#EAF0EC', color: '#1E2A22' };

/** 44px formatting toolbar (DocsEditor board A). */
export function EditorToolbar({ editor, disabled, onLink, onPickImage, ticketPrefix }: Props) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: !!e?.isActive('bold'),
      italic: !!e?.isActive('italic'),
      strike: !!e?.isActive('strike'),
      code: !!e?.isActive('code'),
      h1: !!e?.isActive('heading', { level: 1 }),
      h2: !!e?.isActive('heading', { level: 2 }),
      h3: !!e?.isActive('heading', { level: 3 }),
      bullet: !!e?.isActive('bulletList'),
      ordered: !!e?.isActive('orderedList'),
      task: !!e?.isActive('taskList'),
      quote: !!e?.isActive('blockquote'),
      table: !!e?.isActive('table'),
      codeBlock: !!e?.isActive('codeBlock'),
      callout: !!e?.isActive('callout'),
      link: !!e?.isActive('link'),
      canUndo: !!e?.can().undo(),
      canRedo: !!e?.can().redo(),
    }),
  });

  const Btn = ({
    label,
    on,
    onClick,
    children,
    off,
  }: {
    label: string;
    on?: boolean;
    onClick: () => void;
    children: ReactNode;
    off?: boolean;
  }) => (
    <button
      type="button"
      className="dk-tb"
      aria-label={label}
      title={label}
      aria-pressed={on}
      disabled={disabled || !editor || off}
      style={{ ...(on ? ACTIVE : null), ...(off || disabled ? { opacity: 0.45, cursor: 'default' } : null) }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
  const c = () => editor!.chain().focus();
  const s = st ?? ({} as NonNullable<typeof st>);

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      data-testid="editor-toolbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        height: 44,
        padding: '0 24px',
        borderBottom: '1px solid #E3E8E5',
        background: '#F6FAF7',
        boxSizing: 'border-box',
        flexShrink: 0,
      }}
    >
      <Btn label="Bold" on={s.bold} onClick={() => c().toggleBold().run()}>
        <span style={{ fontSize: 14, fontWeight: 800 }}>B</span>
      </Btn>
      <Btn label="Italic" on={s.italic} onClick={() => c().toggleItalic().run()}>
        <span style={{ fontSize: 14, fontStyle: 'italic', fontWeight: 600, fontFamily: 'Georgia,serif' }}>i</span>
      </Btn>
      <Btn label="Strikethrough" on={s.strike} onClick={() => c().toggleStrike().run()}>
        <Icon name="i47" size={16} />
      </Btn>
      <Btn label="Inline code" on={s.code} onClick={() => c().toggleCode().run()}>
        <Icon name="i33" size={16} />
      </Btn>
      <span className="dk-sep" />
      <Btn label="H1" on={s.h1} onClick={() => c().toggleHeading({ level: 1 }).run()}>
        H1
      </Btn>
      <Btn label="H2" on={s.h2} onClick={() => c().toggleHeading({ level: 2 }).run()}>
        H2
      </Btn>
      <Btn label="H3" on={s.h3} onClick={() => c().toggleHeading({ level: 3 }).run()}>
        H3
      </Btn>
      <span className="dk-sep" />
      <Btn label="Bulleted list" on={s.bullet} onClick={() => c().toggleBulletList().run()}>
        <Icon name="i48" size={16} />
      </Btn>
      <Btn label="Numbered list" on={s.ordered} onClick={() => c().toggleOrderedList().run()}>
        <Icon name="i49" size={16} />
      </Btn>
      <Btn label="Task list" on={s.task} onClick={() => c().toggleTaskList().run()}>
        <Icon name="i50" size={16} />
      </Btn>
      <Btn label="Quote" on={s.quote} onClick={() => c().toggleBlockquote().run()}>
        <Icon name="i51" size={16} />
      </Btn>
      <span className="dk-sep" />
      <Btn
        label="Table"
        on={s.table}
        off={s.table}
        onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      >
        <Icon name="i52" size={16} />
      </Btn>
      <Btn label="Code block" on={s.codeBlock} onClick={() => c().toggleCodeBlock().run()}>
        <Icon name="i53" size={16} />
      </Btn>
      <Btn label="Callout" on={s.callout} onClick={() => c().toggleCallout('info').run()}>
        <Icon name="i31" size={16} />
      </Btn>
      <span className="dk-sep" />
      <Btn label="Link" on={s.link} onClick={onLink}>
        <Icon name="i11" size={16} />
      </Btn>
      <Btn label="Reference a page or section" onClick={() => c().insertContent('[[').run()}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>[[</span>
      </Btn>
      <Btn label="Ticket" onClick={() => c().insertContent(`[[${ticketPrefix}-`).run()}>
        <Icon name="i13" size={16} />
      </Btn>
      <Btn label="Image" onClick={onPickImage}>
        <Icon name="i54" size={16} />
      </Btn>
      <div style={{ flex: 1 }} />
      <Btn label="Undo" off={!s.canUndo} onClick={() => c().undo().run()}>
        <Icon name="i19" size={16} />
      </Btn>
      <Btn label="Redo" off={!s.canRedo} onClick={() => c().redo().run()}>
        <Icon name="i62" size={16} />
      </Btn>
      <span className="dk-sep" />
      <span
        style={{
          fontSize: 12,
          color: '#5B6B60',
          whiteSpace: 'nowrap',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Icon name="i63" size={15} strokeWidth={1.7} />
        Type<span className="dk-kbd">/</span>for blocks
      </span>
    </div>
  );
}
