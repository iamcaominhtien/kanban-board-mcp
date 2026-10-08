import { useState } from 'react';
import { FileCategoryIcon, cleanDisplayFileName, getFileTypeMeta } from '../utils/fileIcons';
import { uploadUrl } from '../api/tickets';
import { FilePreviewModal } from './FilePreviewModal';
import styles from './FileAttachmentCard.module.css';

interface Props {
  url: string;
  fileName?: string;
  fileSize?: number;
}

/** Card for an attached file with open and download actions. */
export function FileAttachmentCard({ url, fileName: rawName, fileSize }: Props) {
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const displayFileName = cleanDisplayFileName(rawName || url);
  const meta = getFileTypeMeta(displayFileName);
  const downloadHref = uploadUrl(url, displayFileName, true);

  return (
    <>
      <span
        className={styles.card}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsPreviewOpen(true);
        }}
        title={`Preview or download ${displayFileName}`}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsPreviewOpen(true);
          }
        }}
      >
        <span className={styles.iconWrap} style={{ backgroundColor: meta.bgColor }}>
          <FileCategoryIcon category={meta.category} size={13} color={meta.color} />
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

      <FilePreviewModal
        isOpen={isPreviewOpen}
        onClose={() => setIsPreviewOpen(false)}
        url={url}
        fileName={displayFileName}
        fileSize={fileSize}
      />
    </>
  );
}
