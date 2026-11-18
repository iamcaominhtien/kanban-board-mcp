/**
 * Insert video (design "Embeds", frames 13-14): Upload (drop or choose a file; MP4, WebM or MOV up to the project's
 * limit) or Link (the address of a video file). A YouTube, Vimeo or Loom address is placed as an embed from a link:
 * a picture whose player loads only after Play. Also Replace on a selected video: the same dialog, which keeps the
 * video's place and settings.
 */

import type { Editor } from '@tiptap/core';
import { useRef, useState } from 'react';
import { fetchLinkPreview } from '../../embeds/embedApi';
import { VIDEO_ACCEPT, fileNameOf, playableInBrowser, providerName, videoEmbedOf } from '../../embeds/videoEmbed';
import { setNodeAttrs } from './commands';
import { startDocUpload } from './docUpload';
import { insertLinkEmbed } from './LinkDialogs';
import { EmbIcon } from '../../embeds/embIcons';
import { Dialog } from './ui';

type Tab = 'upload' | 'link';

/** True for a file the video upload takes. */
export const isVideoFile = (f: File) => f.type.startsWith('video/') || /\.(mp4|m4v|webm|mov)$/i.test(f.name);

/**
 * The dialog.
 * @param props.replacePos - Replace the file of the video at this position instead of inserting one.
 * @param props.limitMb - The project's video limit in MB.
 */
export function InsertVideoDialog({
  editor,
  projectId,
  replacePos,
  limitMb,
  onClose,
}: {
  editor: Editor;
  projectId: string;
  replacePos?: number;
  limitMb: number;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('upload');
  const [over, setOver] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const replacing = replacePos != null;
  const clean = url.trim();
  const valid = /^https?:\/\/\S+$/i.test(clean);
  const site = valid ? videoEmbedOf(clean) : null;
  let host = '';
  try {
    host = valid ? new URL(clean).hostname : '';
  } catch {
    host = '';
  }

  const upload = (list: File[]) => {
    const f = list[0];
    if (!f) return;
    startDocUpload(editor, f, { kind: 'video', replacePos });
    onClose();
  };

  const insertLink = async () => {
    if (!valid) return;
    if (site) {
      // a player of another site: an embed from a link, read once for its picture and title
      setBusy(true);
      const preview = await fetchLinkPreview(clean, projectId).catch(() => ({ url: clean }));
      setBusy(false);
      insertLinkEmbed(editor, { ...preview, url: clean }, 'video', replacing ? { replacePos } : {});
      onClose();
      return;
    }
    if (replacing) setNodeAttrs(editor, replacePos, { src: clean, provider: 'file' });
    else
      editor
        .chain()
        .focus()
        .insertContent({ type: 'video', attrs: { src: clean, provider: 'file' } })
        .run();
    onClose();
  };

  return (
    <Dialog title={replacing ? 'Replace video' : 'Insert video'} onClose={onClose} testId="insert-video" width={340}>
      <div className="dk-ins">
        <div className="dk-ins-tabs" role="tablist" aria-label="Where from">
          {(
            [
              ['upload', 'Upload', 'upload'],
              ['link', 'Link', 'link'],
            ] as const
          ).map(([v, label, icon]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={tab === v}
              className={tab === v ? 'on' : undefined}
              onClick={() => setTab(v)}
            >
              <EmbIcon name={icon} />
              {label}
            </button>
          ))}
        </div>
        {tab === 'upload' ? (
          <>
            <div
              className={`dk-ins-drop${over ? ' over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                upload(Array.from(e.dataTransfer.files));
              }}
            >
              <EmbIcon name="upload" size={22} />
              <div className="dk-ins-drop-title">Drop a file here</div>
              <button type="button" className="st-btn st-btn-sm" onClick={() => fileRef.current?.click()}>
                Choose file
              </button>
              <input
                ref={fileRef}
                type="file"
                accept={VIDEO_ACCEPT}
                hidden
                aria-label="Choose a video file"
                onChange={(e) => {
                  const list = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  upload(list);
                }}
              />
            </div>
            <p className="dk-ins-hint">
              MP4, WebM or MOV, up to {limitMb} MB.
              <br />
              Video is never played automatically.
            </p>
          </>
        ) : (
          <>
            <div className="dk-ins-field">
              <label className="dk-ins-label" htmlFor="dk-video-url">
                Video address
              </label>
              <input
                id="dk-video-url"
                className="dk-ins-input"
                type="url"
                placeholder="https://cdn.example.com/demo.mp4"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void insertLink();
                  }
                }}
              />
            </div>
            {valid && site && (
              <p className="dk-ins-note">
                A {providerName(site.provider)} video. It is placed as an embed from a link: a picture whose player
                loads from {host} only after Play.
              </p>
            )}
            {valid && !site && (
              <div className="dk-ins-prev">
                <span className="dk-ins-thumb" aria-hidden="true" />
                <span className="dk-ins-prev-text">
                  <b>{fileNameOf(clean)}</b>
                  <br />
                  <span>
                    {playableInBrowser(clean) ? 'Direct file' : 'This format may not play in a browser'} · {host}
                  </span>
                </span>
              </div>
            )}
            <p className="dk-ins-note">
              For YouTube, Vimeo and Loom, <b>Embed from link</b> works the same way.
            </p>
            <div className="dk-ins-foot">
              <button type="button" className="st-btn st-btn-sm" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="st-btn st-btn-primary st-btn-sm"
                disabled={!valid || busy}
                onClick={() => void insertLink()}
              >
                {replacing ? 'Replace video' : 'Insert video'}
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
