/**
 * The page icon picker (design "Rich Docs — organising pages", D 32): an emoji, one of the app's line icons or an
 * uploaded picture. The choice is the page's `icon` setting (`🚀`, `icon:<name>`, `/uploads/...`).
 */

import { useMemo, useRef, useState } from 'react';
import { client } from '../../../api/client';
import { extractError } from '../../../api/extractError';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import { BottomSheet } from '../DocsSheets';
import { ModalShell } from '../docsShared';
import { Icon } from '../Icon';
import { PageIcon } from './treeParts';
import './tree.css';

/** Emoji with the words they are found by. */
const EMOJI: [string, string][] = [
  ['🔌', 'api plug connect'],
  ['📋', 'requirements clipboard list'],
  ['🧱', 'architecture brick wall'],
  ['📓', 'notebook log decision'],
  ['🚀', 'release launch rocket'],
  ['📖', 'book read story'],
  ['📅', 'meeting calendar date'],
  ['✍️', 'write blog post'],
  ['🔐', 'auth lock security'],
  ['💳', 'billing card payment'],
  ['🗂️', 'data model folder index'],
  ['⏱️', 'rate limit time timer'],
  ['🏠', 'home overview start'],
  ['🌙', 'moon night story'],
  ['🧪', 'test lab experiment'],
  ['🛠️', 'tools build setup'],
  ['📈', 'growth chart metrics'],
  ['🗺️', 'map roadmap plan'],
  ['🧭', 'compass guide direction'],
  ['💡', 'idea light bulb'],
  ['🎯', 'goal target aim'],
  ['🔒', 'lock private'],
  ['📦', 'package box ship'],
  ['🧾', 'receipt invoice'],
  ['📝', 'note memo draft'],
  ['🐞', 'bug issue'],
  ['🌱', 'seed start grow'],
  ['☕', 'coffee break'],
  ['📚', 'books library docs'],
  ['🎨', 'design art palette'],
  ['🖥️', 'desktop computer screen'],
  ['📱', 'phone mobile app'],
  ['⚙️', 'settings gear config'],
  ['🔍', 'search find'],
  ['🧩', 'puzzle piece plugin'],
  ['📣', 'announce news'],
  ['✅', 'done check'],
  ['⚠️', 'warning caution'],
  ['❓', 'question faq help'],
  ['🗒️', 'notes pad'],
  ['🎉', 'party celebrate'],
  ['🤝', 'handshake team partner'],
  ['👥', 'people team members'],
  ['🧑‍💻', 'developer coder'],
  ['🤖', 'robot ai bot'],
  ['✨', 'sparkle new magic'],
  ['🔥', 'fire hot'],
  ['⭐', 'star favourite'],
  ['🏁', 'finish flag'],
  ['🔁', 'repeat loop cycle'],
  ['🌍', 'world global'],
  ['💬', 'chat comment talk'],
  ['📊', 'chart report'],
  ['🧮', 'calculate numbers'],
  ['🗃️', 'archive files'],
  ['🎓', 'learn course'],
  ['🏗️', 'construction build'],
  ['🌊', 'wave sea tide'],
  ['🕯️', 'candle lamp'],
  ['✉️', 'letter mail'],
];

/** Line icons a page can wear (names of the app's icon set). */
const ICONS: [string, string][] = [
  ['page', 'page document'],
  ['folder', 'folder'],
  ['canvas', 'canvas layers'],
  ['comment', 'comment chat'],
  ['link', 'link'],
  ['lock', 'lock'],
  ['search', 'search'],
  ['check', 'check done'],
  ['i27', 'home'],
  ['i21', 'globe world'],
  ['i20', 'clock time'],
  ['i32', 'people team'],
  ['i44', 'bell notify'],
  ['i52', 'table'],
  ['i53', 'code'],
  ['i54', 'image picture'],
  ['i58', 'star'],
  ['i59', 'question help'],
  ['i68', 'calendar'],
  ['i30', 'sun light'],
  ['i25', 'lock private'],
  ['i14', 'warning'],
  ['i48', 'list'],
  ['i57', 'board columns'],
];

/**
 * The picker.
 * @param props.projectId - Where an uploaded picture goes (`POST /projects/{id}/docs/uploads`, kind image).
 * @param props.current - The page's icon now.
 * @param props.onPick - Called with the new icon, or `null` to remove it.
 */
export function IconPicker({
  projectId,
  title,
  current,
  layout,
  onPick,
  onClose,
}: {
  projectId: string;
  title: string;
  current: string | null | undefined;
  layout: DocsLayout;
  onPick: (icon: string | null) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'emoji' | 'icons' | 'upload'>('emoji');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const list = tab === 'icons' ? ICONS : EMOJI;
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? list.filter(([, words]) => words.includes(t)) : list;
  }, [list, q]);

  async function upload(f: File) {
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append('kind', 'image');
    form.append('file', f);
    try {
      const res = await client.post<{ src?: string; url?: string }>(`/projects/${projectId}/docs/uploads`, form);
      const src = res.data.src ?? res.data.url;
      if (src) onPick(src);
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      setError(status === 413 ? 'The picture is larger than this project allows.' : extractError(e));
    } finally {
      setBusy(false);
    }
  }

  const body = (
    <div className="tr-picker" data-testid="icon-picker">
      <div className="tr-picker-now">
        <PageIcon icon={current} size={22} />
        <span>{title}</span>
      </div>
      <div role="tablist" aria-label="Icon kind" className="tr-tabs">
        {(['emoji', 'icons', 'upload'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`tr-tab${tab === t ? ' tr-tab-on' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'emoji' ? 'Emoji' : t === 'icons' ? 'Icons' : 'Upload'}
          </button>
        ))}
      </div>
      {tab === 'upload' ? (
        <div className="tr-upload">
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
            aria-label="Choose a picture"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <button type="button" className="st-btn" disabled={busy} onClick={() => file.current?.click()}>
            <Icon name="i26" size={14} strokeWidth={2} />
            {busy ? 'Uploading…' : 'Choose a picture'}
          </button>
          <span className="st-hint">A square picture works best. It is shown 20 px wide in the tree.</span>
          {error && (
            <span role="alert" style={{ color: '#A5321E', fontSize: 12.5 }}>
              {error}
            </span>
          )}
        </div>
      ) : (
        <>
          <input
            className="st-input"
            placeholder={tab === 'emoji' ? 'Search emoji…' : 'Search icons…'}
            aria-label={tab === 'emoji' ? 'Search emoji' : 'Search icons'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="tr-picker-grid" role="listbox" aria-label={tab === 'emoji' ? 'Emoji' : 'Icons'}>
            {shown.map(([v]) => {
              const value = tab === 'icons' ? `icon:${v}` : v;
              return (
                <button
                  key={v}
                  type="button"
                  role="option"
                  aria-selected={current === value}
                  aria-label={tab === 'icons' ? `Icon ${v}` : v}
                  className="tr-picker-cell"
                  onClick={() => onPick(value)}
                >
                  {tab === 'icons' ? <Icon name={v} size={18} strokeWidth={1.8} /> : v}
                </button>
              );
            })}
            {shown.length === 0 && <span className="st-hint">Nothing matches “{q}”.</span>}
          </div>
        </>
      )}
      <div className="tr-picker-foot">
        <button
          type="button"
          className="st-btn st-btn-sm"
          onClick={() => onPick(EMOJI[Math.floor(Math.random() * EMOJI.length)][0])}
        >
          Random
        </button>
        <button type="button" className="st-btn st-btn-sm" disabled={!current} onClick={() => onPick(null)}>
          Remove icon
        </button>
      </div>
    </div>
  );

  if (layout === 'phone')
    return (
      <BottomSheet label="Page icon" onClose={onClose} testId="icon-picker-sheet">
        {body}
      </BottomSheet>
    );
  return (
    <ModalShell
      width={420}
      ariaLabel="Page icon"
      title="Page icon"
      onClose={onClose}
      bodyStyle={{ padding: '14px 18px' }}
    >
      {body}
    </ModalShell>
  );
}
