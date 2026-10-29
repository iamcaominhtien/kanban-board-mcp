import { FileCategoryIcon, cleanDisplayFileName, getFileTypeMeta } from '../utils/fileIcons';
import { uploadUrl } from '../api/tickets';
import { galleryAround, previewAttrs, usePreview } from './preview/PreviewContext';
import { previewKind } from './preview/kinds';
import styles from './FileAttachmentCard.module.css';

interface Props {
  url: string;
  fileName?: string;
  fileSize?: number;
}

/** Card for an attached file: a real thumbnail for images, a click opens the viewer on it and the files around it. */
export function FileAttachmentCard({ url, fileName: rawName, fileSize }: Props) {
  const preview = usePreview();
  const displayFileName = cleanDisplayFileName(rawName || url);
  const meta = getFileTypeMeta(displayFileName);
  const downloadHref = uploadUrl(url, displayFileName, true);
  const isImage = previewKind(displayFileName) === 'image';

  function open(el: HTMLElement) {
    const { items, index } = galleryAround(el);
    preview.open(items, index);
  }

  return (
    <span
      className={styles.card}
      {...previewAttrs(url, displayFileName, fileSize)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        open(e.currentTarget);
      }}
      title={`Preview or download ${displayFileName}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(e.currentTarget);
        }
      }}
    >
      <span className={styles.iconWrap} style={{ backgroundColor: meta.bgColor }}>
        {isImage ? (
          <img className={styles.thumb} src={uploadUrl(url, displayFileName, false, true)} alt="" loading="lazy" />
        ) : (
          <FileCategoryIcon category={meta.category} size={13} color={meta.color} />
        )}
      </span>

      <span className={styles.name}>{displayFileName}</span>

      <span
        className={styles.badge}
        style={{
          backgroundColor: meta.bgColor,
          color: meta.color,
        }}
      >
        {meta.badge}
      </span>

      <a
        href={downloadHref}
        download={displayFileName}
        className={styles.actionBtn}
        title={`Download ${displayFileName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </a>
    </span>
  );
}
