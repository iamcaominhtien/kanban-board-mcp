// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ReplyTray,
  SelectToReply,
  UserText,
  cleanQuote,
  composeReplies,
  splitQuoted,
  useQuoteReplies,
} from './quoteReplies';

afterEach(cleanup);

describe('replies to passages, as one message', () => {
  it('quotes every passage with its reply under it, then the composer text', () => {
    const out = composeReplies(
      [
        { id: 'a', quote: 'Tôi chưa thay đổi gì.\n\nMỗi thay đổi đều có Undo.', text: ' Gán role pm thôi ' },
        { id: 'b', quote: 'Cài plugin flow', text: '' },
      ],
      'Cảm ơn',
    );
    expect(out).toBe(
      '> Tôi chưa thay đổi gì.\n>\n> Mỗi thay đổi đều có Undo.\n\nGán role pm thôi\n\n> Cài plugin flow\n\nCảm ơn',
    );
    expect(composeReplies([], '  hi  ')).toBe('hi');
    expect(composeReplies([], '   ')).toBe('');
  });

  it('cleans a selection: no trailing spaces, at most one blank line', () => {
    expect(cleanQuote('  one  \r\n\n\n\ntwo \n')).toBe('one\n\ntwo');
  });

  it('reads a sent message back into its quotes and text', () => {
    const sent = composeReplies([{ id: 'a', quote: 'line 1\nline 2', text: 'why?' }], 'more');
    expect(splitQuoted(sent)).toEqual([
      { kind: 'quote', text: 'line 1\nline 2' },
      { kind: 'text', text: 'why?\n\nmore' },
    ]);
  });

  it('frames the quotes of a sent message and leaves a plain one as typed', () => {
    const { container } = render(<UserText text={'> the passage\n\nmy reply'} />);
    expect(container.querySelector('.as-user-quote')?.textContent).toBe('the passage');
    expect(container.textContent).toContain('my reply');
    const plain = render(<UserText text="a > b" />);
    expect(plain.container.querySelector('.as-user-quote')).toBeNull();
    expect(plain.container.textContent).toBe('a > b');
  });
});

function Harness({ onSend }: { onSend: (text: string) => void }) {
  const body = useRef<HTMLDivElement | null>(null);
  const quotes = useQuoteReplies();
  const [text, setText] = useState('');
  return (
    <>
      <div ref={body}>
        <div className="as-quotable" data-testid="answer">
          <p>First passage of the answer.</p>
          <p>Second passage of the answer.</p>
        </div>
        <p data-testid="outside">Not an answer.</p>
      </div>
      <SelectToReply containerRef={body} onReply={quotes.add} />
      <ReplyTray replies={quotes.replies} focusId={quotes.focusId} onChange={quotes.update} onRemove={quotes.remove} />
      <textarea aria-label="message" value={text} onChange={(e) => setText(e.target.value)} />
      <button
        type="button"
        onClick={() => {
          onSend(composeReplies(quotes.replies, text));
          quotes.clear();
        }}
      >
        Send
      </button>
    </>
  );
}

async function select(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  // jsdom lays nothing out
  range.getBoundingClientRect = () => ({ left: 10, top: 100, width: 50, height: 16 }) as DOMRect;
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  await act(async () => {
    fireEvent.pointerUp(node.parentElement!);
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('select a passage, reply, send several at once', () => {
  it('offers Reply on a selection in an answer and sends every reply in one message', async () => {
    const sent: string[] = [];
    render(<Harness onSend={(t) => sent.push(t)} />);
    const [first, second] = screen.getByTestId('answer').querySelectorAll('p');

    await select(first.firstChild!);
    fireEvent.click(screen.getByTestId('reply-to-selection'));
    fireEvent.change(screen.getByLabelText('Reply to passage 1'), { target: { value: 'Why?' } });

    await select(second.firstChild!);
    fireEvent.click(screen.getByTestId('reply-to-selection'));
    fireEvent.change(screen.getByLabelText('Reply to passage 2'), { target: { value: 'Agreed.' } });

    expect(screen.getByTestId('reply-tray').textContent).toContain('Replying to 2 passages');
    fireEvent.click(screen.getByText('Send'));
    expect(sent).toEqual(['> First passage of the answer.\n\nWhy?\n\n> Second passage of the answer.\n\nAgreed.']);
    expect(screen.queryByTestId('reply-tray')).toBeNull();
  });

  it('offers nothing for a selection outside an answer, and a removed passage is not sent', async () => {
    const sent: string[] = [];
    render(<Harness onSend={(t) => sent.push(t)} />);
    await select(screen.getByTestId('outside').firstChild!);
    expect(screen.queryByTestId('reply-to-selection')).toBeNull();

    await select(screen.getByTestId('answer').querySelector('p')!.firstChild!);
    fireEvent.click(screen.getByTestId('reply-to-selection'));
    fireEvent.click(screen.getByLabelText('Remove passage 1'));
    expect(screen.queryByTestId('reply-tray')).toBeNull();
    fireEvent.click(screen.getByText('Send'));
    expect(sent).toEqual(['']);
  });
});
