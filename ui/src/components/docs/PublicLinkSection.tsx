/**
 * "Anyone with the link can read" in the Share popover (design board "Rich Docs — reading", frames 38-40 and 69):
 * a public read-only copy of the published page. Turning it on asks first what readers can do and what stays
 * private; then the link, Copy link, show names, search engines, expiry, and Stop sharing publicly. It is off with
 * the reason when the project switched public links off, the page was never published, or the reader cannot edit.
 */

import { useState } from 'react';
import { docsErrorDetail } from '../../api/docs';
import {
  publicLinkUrl,
  usePublicLink,
  useSetPublicLink,
  type PublicLinkChange,
  type PublicLinkExpiry,
} from '../../api/docsPublic';
import { extractError } from '../../api/extractError';
import type { DocsPage } from '../../types/docs';
import { Switch } from '../settings/settingsUi';
import { Icon } from './Icon';
import './reader.css';

const EXPIRY: readonly { value: PublicLinkExpiry; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: '7d', label: 'In 7 days' },
  { value: '30d', label: 'In 30 days' },
  { value: '90d', label: 'In 90 days' },
];

/** What a public page shows and keeps private: the confirm, and the note under a live link. */
export const PUBLIC_CONFIRM_POINTS = [
  'People can read it and pass the link on. They cannot edit or comment.',
  'Drafts and unpublished changes stay private.',
  'Page links, ticket chips, sketches, canvases, files and HTML embeds show as plain text to people outside the project.',
  'The link is a long random address. You can stop sharing at any time and it stops working at once.',
  'Highlights and comments are not shown on the public page.',
] as const;

/**
 * Why the public link cannot be turned on, or `null` when it can.
 * @param allowed - Whether the project allows public links.
 * @param page - The page (never published: no public link).
 * @param canEdit - The reader can edit the page (only owners and editors share it publicly).
 */
export function publicLinkBlocked(allowed: boolean, page: Pick<DocsPage, 'version'>, canEdit: boolean): string | null {
  if (!allowed) return 'Public links are turned off for this project.';
  if (page.version < 1) return 'Publish the page before you share it publicly.';
  if (!canEdit) return 'Only people who can edit this page can share it publicly.';
  return null;
}

/** The 14 px warning triangle and info circle of the notes under a live link (Reader boards, E). */
function NoteGlyph({ kind }: { kind: 'warn' | 'info' }) {
  return (
    <svg
      aria-hidden="true"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, marginTop: 2 }}
    >
      {kind === 'warn' ? (
        <path d="M12 3.5L22 20H2ZM12 10V14M12 17.2V17.3" />
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6M12 7.5v.01" />
        </>
      )}
    </svg>
  );
}

function expiryOf(expiresAt: string | null): string {
  if (!expiresAt) return 'never';
  const d = new Date(expiresAt);
  return Number.isNaN(d.getTime())
    ? ''
    : `Expires ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

/**
 * The public link part of the Share popover.
 * @param props.page - The page shared.
 * @param props.canEdit - The reader can edit the page.
 */
export function PublicLinkSection({ page, canEdit }: { page: DocsPage; canEdit: boolean }) {
  const q = usePublicLink(page.id);
  const set = useSetPublicLink(page.id);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expiry, setExpiry] = useState<PublicLinkExpiry | null>(null);
  const link = q.data?.link ?? null;
  const blocked = q.data ? publicLinkBlocked(q.data.allowed, page, canEdit) : null;

  async function change(c: PublicLinkChange) {
    setError(null);
    try {
      await set.mutateAsync(c);
      return true;
    } catch (e) {
      setError(docsErrorDetail(e)?.message ?? extractError(e));
      return false;
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy to the clipboard");
    }
  }

  if (confirming) {
    return (
      <div className="dk-pl-confirm" role="group" aria-label="Make this page public?" data-testid="public-confirm">
        <div className="dk-pl-confirm-head">
          <span className="dk-pl-confirm-ico" aria-hidden="true">
            <Icon name="link" size={17} strokeWidth={1.9} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <b className="dk-pl-title">Make this page public?</b>
            <span className="dk-pl-sub">{page.title}</span>
          </span>
        </div>
        <div className="dk-pl-confirm-body">
          <p className="dk-pl-lead">
            Anyone who gets the link will be able to read the published page, signed in or not.
          </p>
          <ul className="dk-pl-points">
            {PUBLIC_CONFIRM_POINTS.map((p) => (
              <li key={p}>
                <Icon name="check" size={15} strokeWidth={2.2} />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          {error && (
            <p role="alert" className="dk-pl-error">
              {error}
            </p>
          )}
        </div>
        <div className="dk-pl-confirm-foot">
          <button type="button" className="st-btn" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary"
            disabled={set.isPending}
            data-testid="public-confirm-yes"
            onClick={() => void change({ on: true }).then((ok) => ok && setConfirming(false))}
          >
            <Icon name="link" size={14} strokeWidth={1.9} />
            {set.isPending ? 'Making public…' : 'Make public'}
          </button>
        </div>
      </div>
    );
  }

  const disabledNow = !link && (!!blocked || !q.data);
  return (
    <div className="dk-pl" data-testid="public-link">
      <button
        type="button"
        className="dk-pl-option"
        aria-pressed={!!link}
        disabled={disabledNow || (!!link && !canEdit)}
        title={!link && blocked ? blocked : undefined}
        data-testid="public-link-toggle"
        onClick={() => {
          if (!link) setConfirming(true);
        }}
      >
        <span className="dk-pl-radio" aria-hidden="true" />
        <span className="dk-pl-ico" aria-hidden="true">
          <Icon name="i36" size={16} strokeWidth={1.9} />
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
          <b>Anyone with the link can read</b>
          <span>
            Exactly that: anyone who gets the link, signed in or not, can read the published page. Nothing else.
          </span>
          {!link && blocked && (
            <span className="dk-pl-why" data-testid="public-link-blocked">
              {blocked}
            </span>
          )}
          {q.isLoading && <span className="dk-pl-why">Checking the public link…</span>}
        </span>
      </button>
      {link && (
        <div className="dk-pl-on">
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="st-input dk-pl-url" data-testid="public-url">
              {publicLinkUrl(link).replace(/^https?:\/\//, '')}
            </div>
            <button
              type="button"
              className="st-btn"
              style={{ flexShrink: 0 }}
              data-testid="public-copy"
              onClick={() => void copy(publicLinkUrl(link))}
            >
              <Icon name={copied ? 'i10' : 'i24'} size={14} strokeWidth={copied ? 2.4 : 1.9} />
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
          <p className="dk-pl-text dk-pl-text-amber">
            <NoteGlyph kind="warn" />
            <span>Only the published version is public. Anyone who has the link can read it and pass it on.</span>
          </p>
          <p className="dk-pl-text dk-pl-text-blue">
            <NoteGlyph kind="info" />
            <span>
              People outside the project see page links, ticket chips, sketches, canvases, files and HTML embeds as
              plain text. Highlights and comments are not shown on the public page.
            </span>
          </p>
          {canEdit && (
            <>
              <div className="dk-rs-switch">
                <span>
                  <b>Show author names</b>
                  <span>Under the title and in the footer.</span>
                </span>
                <Switch
                  on={link.showNames}
                  label="Show author names"
                  testId="public-show-names"
                  disabled={set.isPending}
                  onChange={(v) => void change({ on: true, showNames: v })}
                />
              </div>
              <div className="dk-rs-switch">
                <span>
                  <b>Let search engines find it</b>
                  <span>Off keeps the link out of search results.</span>
                </span>
                <Switch
                  on={link.allowIndex}
                  label="Let search engines find it"
                  testId="public-allow-index"
                  disabled={set.isPending}
                  onChange={(v) => void change({ on: true, allowIndex: v })}
                />
              </div>
              <label className="dk-rs-switch">
                <span>
                  <b>Link expires</b>
                  <span>{link.expiresAt ? expiryOf(link.expiresAt) : 'The link works until you stop sharing.'}</span>
                </span>
                <select
                  className="st-input dk-pl-select"
                  aria-label="Link expires"
                  data-testid="public-expiry"
                  value={expiry ?? (link.expiresAt ? '' : 'never')}
                  disabled={set.isPending}
                  onChange={(e) => {
                    const v = e.target.value as PublicLinkExpiry;
                    setExpiry(v);
                    void change({ on: true, expires: v });
                  }}
                >
                  {link.expiresAt && !expiry && <option value="">{expiryOf(link.expiresAt)}</option>}
                  {EXPIRY.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="st-btn dk-pl-stop"
                disabled={set.isPending}
                data-testid="public-stop"
                onClick={() => void change({ on: false }).then((ok) => ok && setExpiry(null))}
              >
                Stop sharing publicly
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="dk-pl-error">
          {error}
        </p>
      )}
    </div>
  );
}
