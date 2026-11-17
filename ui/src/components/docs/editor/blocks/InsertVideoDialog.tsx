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
import { Dialog, Tabs } from './ui';

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
    <Dialog
      title={replacing ? 'Replace video' : 'Insert video'}
      onClose={onClose}
      testId="insert-video"
      footer={
        tab === 'link' ? (
          <>
            <button type="button" className="dk-btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="dk-btn-primary"
              disabled={!valid || busy}
              onClick={() => void insertLink()}
            >
              {replacing ? 'Replace video' : 'Insert video'}
            </button>
          </>
        ) : undefined
      }
    >
      <Tabs
        tabs={[
          ['upload', 'Upload'],
          ['link', 'Link'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'upload' ? (
        <div
          className={`dk-drop${over ? ' over' : ''}`}
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
          <div className="dk-drop-title">Drop a file here</div>
          <button type="button" className="dk-btn-primary" onClick={() => fileRef.current?.click()}>
            Choose file
          </button>
          <p className="dk-bp-muted">MP4, WebM or MOV, up to {limitMb} MB.</p>
          <p className="dk-bp-muted">Video is never played automatically.</p>
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
      ) : (
        <div className="dk-bp-col">
          <label className="dk-bp-label" htmlFor="dk-video-url">
            Video address
          </label>
          <input
            id="dk-video-url"
            className="dk-bp-input"
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
          {valid && site && (
            <p className="dk-bp-note">
              A {providerName(site.provider)} video. It is placed as an embed from a link: a picture whose player loads
              from {host} only after Play.
            </p>
          )}
          {valid && !site && (
            <div className="dk-link-prev">
              <strong>{fileNameOf(clean)}</strong>
              <span className="dk-bp-muted">
                {playableInBrowser(clean) ? 'Direct file' : 'This format may not play in a browser'} · {host}
              </span>
            </div>
          )}
          <p className="dk-bp-muted">For YouTube, Vimeo and Loom, Embed from link works the same way.</p>
        </div>
      )}
    </Dialog>
  );
}
