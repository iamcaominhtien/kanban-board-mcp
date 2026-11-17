/**
 * The embed blocks of the rich page reader (RichDocView), read only: HTML embeds (sandboxed, scripts behind "Run
 * it"), video (nothing loads or plays before Play), link cards and players, files with their preview, page and
 * ticket cards, and code with its options. They reach the project and the references through the reader's chip
 * context, so RichDocView only places them.
 */

import { useContext, type CSSProperties, type ReactNode } from 'react';
import { pageRefKey } from '../../../utils/docsMarkdown';
import { ChipCtx, CodeBlock } from '../readerParts';
import { CodeView, hasCodeOptions, type CodeOptions } from './CodeView';
import { FileBlock } from './FileBlock';
import { HtmlEmbedBlock } from './HtmlEmbedBlock';
import { LinkEmbedBlock } from './LinkEmbedBlock';
import { PageCardView, TicketCardView } from './RefCards';
import { ProviderPlayer, VideoCaption, VideoPlayer } from './VideoBlock';
import { videoEmbedOf, youtubePoster } from './videoEmbed';
import './embeds.css';

/** The attributes RichDocView gives every block element. */
export interface ReaderBlockProps {
  className?: string;
  style?: CSSProperties;
  'data-block-id'?: string;
  'data-changed-in'?: string;
}

/** Props of the reader's embed blocks. */
interface Props {
  attrs: Record<string, unknown>;
  /** The block element's attributes (`data-block-id`, classes, the "Changed in" mark). */
  block: ReaderBlockProps;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const join = (...c: (string | undefined | false)[]) => c.filter(Boolean).join(' ');

/** An HTML embed. */
export function ReaderHtmlEmbed({ attrs, block }: Props) {
  const c = useContext(ChipCtx);
  return <HtmlEmbedBlock attrs={attrs} projectId={c?.projectId} blockProps={block as Record<string, unknown>} />;
}

/** A video: a file, or a YouTube / Vimeo video. */
export function ReaderVideo({ attrs, block }: Props) {
  const src = str(attrs.src).replace(/\/api\/uploads\//, '/uploads/');
  if (!src || src.startsWith('uploading:')) return null;
  const provider = str(attrs.provider) || 'file';
  const widthPct = typeof attrs.widthPct === 'number' ? attrs.widthPct : 100;
  const title = str(attrs.title) || str(attrs.caption);
  let player: ReactNode;
  if (provider === 'file')
    player = (
      <VideoPlayer
        src={src}
        poster={str(attrs.poster) || undefined}
        title={title}
        loop={!!attrs.loop}
        muted={!!attrs.muted}
      />
    );
  else {
    const embed = videoEmbedOf(src);
    player = embed ? (
      <ProviderPlayer
        embed={embed}
        poster={str(attrs.poster) || (embed.provider === 'youtube' ? youtubePoster(embed.id) : undefined)}
        title={title}
      />
    ) : (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {src}
      </a>
    );
  }
  return (
    <figure {...block} className={join('dk-video dk-vid-fig', block.className)} style={{ width: `${widthPct}%` }}>
      {player}
      <VideoCaption
        title={str(attrs.caption) || str(attrs.title) || undefined}
        description={str(attrs.description) || undefined}
      />
    </figure>
  );
}

/** A link card or an embedded player. */
export function ReaderLinkEmbed({ attrs, block }: Props) {
  const c = useContext(ChipCtx);
  return (
    <div {...block} className={join('dk-link-block', block.className)}>
      <LinkEmbedBlock attrs={attrs} projectId={c?.projectId} />
    </div>
  );
}

/** A file card, with its preview when the page shows one. */
export function ReaderFile({ attrs, block }: Props) {
  return (
    <div {...block} className={join('dk-file-block', block.className)}>
      <FileBlock attrs={attrs} />
    </div>
  );
}

/** A page shown as a card. */
export function ReaderPageCard({ attrs, block }: Props) {
  const c = useContext(ChipCtx);
  const page = str(attrs.page);
  const result = page ? c?.pages.get(pageRefKey({ title: page })) : null;
  return (
    <div {...block} className={join('dk-ref-block', block.className)}>
      {page ? (
        <PageCardView
          page={page}
          result={result}
          onOpen={c?.onOpenPage}
          onPeek={c?.peek ? (id) => c.peek?.(id) : undefined}
          onCreate={c?.onCreatePage}
          onRestore={c?.onRestorePage}
        />
      ) : (
        <span>No page chosen</span>
      )}
    </div>
  );
}

/** A ticket shown as a card. */
export function ReaderTicketCard({ attrs, block }: Props) {
  const c = useContext(ChipCtx);
  const key = str(attrs.key);
  return (
    <div {...block} className={join('dk-ref-block', block.className)}>
      {key ? (
        <TicketCardView ticketKey={key} result={c?.tickets.get(key)} onOpen={c?.onOpenTicket} />
      ) : (
        <span>No ticket chosen</span>
      )}
    </div>
  );
}

/**
 * A code block: with its options (file name, line numbers, wrap, theme, highlighted lines, diff) when it has any,
 * else the reader's plain code block.
 */
export function ReaderCode({ attrs, block, code }: Props & { code: string }) {
  const options = attrs as CodeOptions;
  if (!hasCodeOptions(options))
    return (
      <CodeBlock
        code={code}
        lang={str(attrs.language) || undefined}
        blockId={block['data-block-id']}
        className={block.className}
        changedIn={block['data-changed-in']}
      />
    );
  return (
    <CodeView
      code={code}
      options={options}
      blockId={block['data-block-id']}
      className={block.className}
      changedIn={block['data-changed-in']}
    />
  );
}
