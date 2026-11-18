/**
 * A link shown as a card or as an embedded player (design "Embeds", section H): the card has the page's title,
 * description, picture and site (a skeleton while it is read, the address only when it could not be read); a video
 * link of a site on the project's list becomes a 16:9 player that loads only after Play. A video link whose site is
 * not (or no longer) on the list says so and offers the original.
 */

import type { ReactNode } from 'react';
import { siteAllowed, useDocsSpaceSettings, useLinkPreview } from './embedApi';
import { EmbIcon } from './embIcons';
import { ProviderMark, ProviderPlayer } from './VideoBlock';
import { providerName, videoEmbedOf, youtubePoster } from './videoEmbed';
import './embeds.css';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The host of an address without `www.` (the address itself when it is not one). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** What a link card shows. */
export interface LinkCardData {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  site?: string | null;
}

/** The skeleton of a card whose title is being read (frame 63). */
export function LinkSkeleton() {
  return (
    <div
      className="dk-link-card dk-link-skel"
      aria-busy="true"
      aria-label="Reading the link"
      data-testid="link-skeleton"
    >
      <span className="dk-link-text">
        <span className="dk-skel" style={{ height: 10, width: '30%' }} />
        <span className="dk-skel" style={{ height: 14, width: '70%' }} />
        <span className="dk-skel" style={{ height: 10, width: '90%' }} />
      </span>
      <span className="dk-skel dk-skel-img" />
    </div>
  );
}

/** A link card: site, title and description, the picture on the right; a click opens the link in a new tab. */
export function LinkCard({ data, children }: { data: LinkCardData; children?: ReactNode }) {
  const site = str(data.site) || hostOf(data.url);
  return (
    <a className="dk-link-card" href={data.url} target="_blank" rel="noopener noreferrer" data-testid="link-card">
      <span className="dk-link-text">
        <span className="dk-link-site">
          <span className="dk-link-mark" aria-hidden="true">
            {site.charAt(0).toLowerCase()}
          </span>
          {site}
        </span>
        <strong>{str(data.title) || data.url}</strong>
        {str(data.description) && <span className="dk-link-desc">{str(data.description)}</span>}
      </span>
      {str(data.image) && (
        <span className="dk-link-img">
          <img src={str(data.image)} alt="" loading="lazy" referrerPolicy="no-referrer" />
        </span>
      )}
      {children}
    </a>
  );
}

/** The card of a link that could not be read: its address and an Open button (frame 64). */
export function LinkUnread({ url }: { url: string }) {
  return (
    <div className="dk-link-unread" role="status" data-testid="link-unread">
      <EmbIcon name="globe" size={20} />
      <span className="dk-link-text">
        <span className="dk-link-url">{url}</span>
        <span className="dk-link-why">Could not read this link. It may need a login.</span>
      </span>
      <a className="st-btn st-btn-sm" href={url} target="_blank" rel="noopener noreferrer">
        <EmbIcon name="open" size={12} sw={2.2} />
        Open
      </a>
    </div>
  );
}

/** A video link that will not show here (frame 65). */
export function LinkRefused({ url, onShowAsCard }: { url: string; onShowAsCard?: () => void }) {
  const embed = videoEmbedOf(url);
  const name = embed ? providerName(embed.provider) : hostOf(url);
  return (
    <div className="dk-link-refused" role="status" data-testid="link-refused">
      <div className="dk-link-refused-top">
        <ProviderMark provider={embed?.provider} name={name} size={30} />
        <span>
          <strong>{hostOf(url)} refused to show this video here</strong>
          <span>The owner may have turned off embedding, or the site is not on this project&apos;s list.</span>
        </span>
      </div>
      <div className="dk-link-refused-btns">
        <a className="st-btn st-btn-primary st-btn-sm" href={url} target="_blank" rel="noopener noreferrer">
          <EmbIcon name="open" size={12} sw={2.2} />
          Open original
        </a>
        {onShowAsCard && (
          <button type="button" className="st-btn st-btn-sm" onClick={onShowAsCard}>
            Show as link card
          </button>
        )}
      </div>
    </div>
  );
}

/** Props of {@link LinkEmbedBlock}. */
export interface LinkEmbedBlockProps {
  attrs: Record<string, unknown>;
  projectId?: string;
  /** Editor: "Show as link card" on a video that will not show. */
  onShowAsCard?: () => void;
}

/**
 * A `linkEmbed` block's content (the caller draws the block element around it).
 */
export function LinkEmbedBlock({ attrs, projectId, onShowAsCard }: LinkEmbedBlockProps) {
  const url = str(attrs.url);
  const settings = useDocsSpaceSettings(projectId);
  // a card saved without a title is read again (cached); a card with one shows what was kept
  const needsRead = !!url && !str(attrs.title);
  const preview = useLinkPreview(needsRead ? url : null, projectId);
  if (!url) return null;
  if (str(attrs.kind) === 'video') {
    const embed = videoEmbedOf(url);
    if (!embed || !siteAllowed(url, settings.data?.embedSites))
      return <LinkRefused url={url} onShowAsCard={onShowAsCard} />;
    const poster = str(attrs.image) || (embed.provider === 'youtube' ? youtubePoster(embed.id) : '');
    return (
      <div className="dk-link-video">
        <ProviderPlayer embed={embed} poster={poster} title={str(attrs.title)} site={str(attrs.site) || hostOf(url)} />
      </div>
    );
  }
  if (needsRead) {
    if (preview.isLoading) return <LinkSkeleton />;
    const p = preview.data;
    if (!p || p.error || !p.title) return <LinkUnread url={url} />;
    return <LinkCard data={{ ...p, url }} />;
  }
  return (
    <LinkCard
      data={{
        url,
        title: str(attrs.title),
        description: str(attrs.description),
        image: str(attrs.image),
        site: str(attrs.site),
      }}
    />
  );
}
