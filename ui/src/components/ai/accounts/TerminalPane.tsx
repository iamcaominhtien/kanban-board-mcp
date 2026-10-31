import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { openLink } from './SignInLinks';

/** What the sign-in window can do to the terminal. Output is never kept anywhere but in the terminal itself. */
export interface TerminalHandle {
  /** Output from the CLI. */
  write: (data: string) => void;
  focus: () => void;
  /** The text on screen and in the scrollback, for "Copy output". */
  text: () => string;
  /** Clear the screen for a new attempt. */
  reset: () => void;
}

interface Props {
  /** The command shown in the bar above the terminal. */
  command: string;
  /** Greyed out once the sign-in has ended. */
  dim?: boolean;
  /** The terminal has a size: the sign-in can start with it. */
  onReady: (size: { cols: number; rows: number }) => void;
  /** The person typed or pasted. */
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /** Shift+Esc inside the terminal: focus moves out so that Esc can leave the window. */
  onLeave: () => void;
}

/**
 * The real terminal of a sign-in (xterm.js). Keys go to the CLI, Esc included; Shift+Esc hands the focus back to the
 * window so that Esc can close it. Web links in the output are clickable and open in the system browser.
 */
export const TerminalPane = forwardRef<TerminalHandle, Props>(function TerminalPane(
  { command, dim, onReady, onInput, onResize, onLeave },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [size, setSize] = useState({ cols: 80, rows: 24 });
  const handlers = useRef({ onReady, onInput, onResize, onLeave });
  handlers.current = { onReady, onInput, onResize, onLeave };

  useImperativeHandle(
    ref,
    () => ({
      write: (data) => term.current?.write(data),
      focus: () => term.current?.focus(),
      reset: () => term.current?.reset(),
      text: () => {
        const buffer = term.current?.buffer.active;
        if (!buffer) return '';
        const lines: string[] = [];
        for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
        return lines.join('\n').replace(/\n+$/, '');
      },
    }),
    [],
  );

  useEffect(() => {
    if (!host.current) return;
    const t = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: true,
      scrollback: 1000,
      scrollSensitivity: 3, // the default (1) moves three lines for ten wheel clicks
      theme: { background: '#14201A', foreground: '#DDE8E0', cursor: '#C7E7D0', selectionBackground: '#2E6F4066' },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)));
    t.open(host.current);
    t.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'Escape' && e.shiftKey) {
        t.blur();
        handlers.current.onLeave();
        return false;
      }
      return true;
    });
    t.onData((d) => handlers.current.onInput(d));
    term.current = t;

    const refit = () => {
      try {
        fit.fit();
      } catch {
        return; // hidden or zero-sized: try again at the next resize
      }
      setSize((s) => (s.cols === t.cols && s.rows === t.rows ? s : { cols: t.cols, rows: t.rows }));
      handlers.current.onResize(t.cols, t.rows);
    };
    refit();
    handlers.current.onReady({ cols: t.cols, rows: t.rows });
    const watcher = new ResizeObserver(refit);
    watcher.observe(host.current);
    t.focus();
    return () => {
      watcher.disconnect();
      t.dispose();
      term.current = null;
    };
  }, []);

  return (
    <div className={`sg-term ${dim ? 'sg-term-dim' : ''}`}>
      <div className="sg-term-bar">
        <i />
        <code>{command}</code>
        <span className="sg-grow" />
        <span>
          {size.cols} × {size.rows}
        </span>
      </div>
      <div
        className="sg-term-body"
        ref={host}
        role="group"
        aria-label={`Terminal running ${command}. Press Shift+Escape to leave it.`}
        data-testid="sign-in-terminal"
      />
    </div>
  );
});
