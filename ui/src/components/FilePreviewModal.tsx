import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FileCategoryIcon,
  cleanDisplayFileName,
  formatFileSize,
  getFileCategory,
  getFileTypeMeta,
  isImage,
  isMedia,
  isOfficeDoc,
  isPdf,
  isTextPreviewable,
} from '../utils/fileIcons';
import { uploadUrl } from '../api/tickets';
import styles from './FilePreviewModal.module.css';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  url: string;
  fileName?: string;
  fileSize?: number;
  filePath?: string;
}

/** Modal that previews an attached or workspace file. */
export function FilePreviewModal({
  isOpen,
  onClose,
  url,
  fileName: rawName,
  fileSize,
  filePath: initialFilePath,
}: Props) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [isLoadingText, setIsLoadingText] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [isCopiedLink, setIsCopiedLink] = useState(false);
  const [detectedLocalPath, setDetectedLocalPath] = useState<string | null>(initialFilePath || null);
  const [openStatus, setOpenStatus] = useState<string | null>(null);

  const displayFileName = cleanDisplayFileName(rawName || url);
  const meta = getFileTypeMeta(displayFileName);
  const isElectron = Boolean(window.electronAPI?.openPath);

  // Lock body scroll while modal is open
  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Query header X-File-Path on desktop to know local path for openPath
  useEffect(() => {
    if (!isOpen || !isElectron || detectedLocalPath || !url) return;
    const fullUrl = uploadUrl(url);
    fetch(fullUrl, { method: 'HEAD' })
      .then((res) => {
        const headerPath = res.headers.get('x-file-path');
        if (headerPath) {
          setDetectedLocalPath(headerPath);
        }
      })
      .catch(() => {
        // Non-fatal if HEAD fails
      });
  }, [isOpen, isElectron, detectedLocalPath, url]);

  // Load text/code/json preview
  useEffect(() => {
    if (!isOpen || !url) return;
    if (!isTextPreviewable(displayFileName)) {
      setTextContent(null);
      return;
    }

    let active = true;
    setIsLoadingText(true);
    setTextError(null);

    const fullUrl = uploadUrl(url, displayFileName);
    fetch(fullUrl)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (!active) return;
        // Attempt pretty format if JSON
        if (getFileCategory(displayFileName) === 'json') {
          try {
            const parsed = JSON.parse(text);
            setTextContent(JSON.stringify(parsed, null, 2));
            return;
          } catch {
            // Keep raw text
          }
        }
        setTextContent(text);
      })
      .catch((err) => {
        if (!active) return;
        setTextError(err.message || 'Failed to load file preview');
      })
      .finally(() => {
        if (active) setIsLoadingText(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, url, displayFileName]);

  if (!isOpen || typeof document === 'undefined') return null;

  const downloadHref = uploadUrl(url, displayFileName, true);
  const inlineViewUrl = uploadUrl(url, displayFileName, false, true);

  async function handleOpenInSystemApp() {
    if (!window.electronAPI?.openPath) return;
    let targetPath = detectedLocalPath;
    if (!targetPath) {
      // Try one more fetch to retrieve header
      try {
        const res = await fetch(inlineViewUrl, { method: 'HEAD' });
        targetPath = res.headers.get('x-file-path');
        if (targetPath) setDetectedLocalPath(targetPath);
      } catch {
        // ignore
      }
    }

    if (targetPath) {
      setOpenStatus('Opening...');
      const res = await window.electronAPI.openPath(targetPath);
      if (res.success) {
        setOpenStatus('Opened in system app');
        setTimeout(() => setOpenStatus(null), 3000);
      } else {
        setOpenStatus(`Open failed: ${res.error || 'Unable to open'}`);
      }
    } else {
      // Fallback: trigger download link
      window.open(downloadHref, '_blank');
    }
  }

  function handleCopyContent() {
    if (!textContent) return;
    navigator.clipboard.writeText(textContent).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    });
  }

  function handleCopyLink() {
    navigator.clipboard.writeText(inlineViewUrl).then(() => {
      setIsCopiedLink(true);
      setTimeout(() => setIsCopiedLink(false), 2000);
    });
  }

  return createPortal(
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-modal="true">
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.fileInfo}>
            <div
              className={styles.fileIconWrap}
              style={{ backgroundColor: meta.bgColor, borderColor: meta.borderColor }}
            >
              <FileCategoryIcon category={meta.category} size={22} color={meta.color} />
            </div>
            <div className={styles.fileNameMeta}>
              <div className={styles.titleRow}>
                <span className={styles.fileName} title={displayFileName}>
                  {displayFileName}
                </span>
                <span
                  className={styles.badge}
                  style={{
                    backgroundColor: meta.bgColor,
                    color: meta.color,
                    borderColor: meta.borderColor,
                  }}
                >
                  {meta.badge}
                </span>
              </div>
              <div className={styles.fileMeta}>
                <span>{meta.label}</span>
                {fileSize ? ` · ${formatFileSize(fileSize)}` : ''}
                {openStatus ? ` · ${openStatus}` : ''}
              </div>
            </div>
          </div>

          <div className={styles.headerActions}>
            {isElectron && (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnNative}`}
                onClick={handleOpenInSystemApp}
                title="Open with default system application (Excel, Word, PowerPoint, Code...)"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                Open in App
              </button>
            )}

            <a
              href={downloadHref}
              download={displayFileName}
              className={`${styles.btn} ${styles.btnPrimary}`}
              title="Download file"
            >
              <svg
                width="14"
                height="14"
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
              Download
            </a>

            <button
              type="button"
              className={`${styles.btn} ${styles.btnSecondary}`}
              onClick={handleCopyLink}
              title="Copy file link"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              {isCopiedLink ? 'Copied!' : 'Copy link'}
            </button>

            <button type="button" className={styles.btnClose} onClick={onClose} aria-label="Close" title="Close (Esc)">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body Preview */}
        <div className={styles.body}>
          {isPdf(displayFileName) ? (
            <iframe src={inlineViewUrl} title={displayFileName} className={styles.pdfFrame} />
          ) : isImage(displayFileName) ? (
            <div className={styles.imagePreviewWrap}>
              <img src={inlineViewUrl} alt={displayFileName} className={styles.previewImg} />
            </div>
          ) : isMedia(displayFileName) ? (
            <div className={styles.mediaWrap}>
              {displayFileName.match(/\.(mp4|webm|mov)$/i) ? (
                <video src={inlineViewUrl} controls />
              ) : (
                <audio src={inlineViewUrl} controls />
              )}
            </div>
          ) : isTextPreviewable(displayFileName) ? (
            <div className={styles.textViewerWrap}>
              <div className={styles.textToolbar}>
                <span>{textContent ? `${textContent.split('\n').length} lines` : 'Preview'}</span>
                {textContent && (
                  <button type="button" className={`${styles.btn} ${styles.btnSecondary}`} onClick={handleCopyContent}>
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
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    {isCopied ? 'Copied!' : 'Copy content'}
                  </button>
                )}
              </div>
              {isLoadingText ? (
                <div className={styles.statusWrap}>
                  <div className={styles.spinner} />
                  <span>Loading preview...</span>
                </div>
              ) : textError ? (
                <div className={styles.statusWrap}>
                  <span>{textError}</span>
                </div>
              ) : (
                <pre className={styles.textContent}>{textContent}</pre>
              )}
            </div>
          ) : (
            <div className={styles.heroWrap}>
              <div
                className={styles.heroIconWrap}
                style={{ backgroundColor: meta.bgColor, borderColor: meta.borderColor }}
              >
                <FileCategoryIcon category={meta.category} size={42} color={meta.color} />
              </div>
              <div className={styles.heroTitle}>{displayFileName}</div>
              <div className={styles.heroDesc}>
                {isOfficeDoc(displayFileName)
                  ? `${meta.label} is ready to open directly in your desktop application or download to your machine.`
                  : 'Direct in-browser preview is not available for this binary file. You can download or open it with your desktop application.'}
              </div>
              <div className={styles.heroActions}>
                {isElectron && (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnNative}`}
                    onClick={handleOpenInSystemApp}
                    style={{ padding: '0.6rem 1.2rem', fontSize: '0.9rem' }}
                  >
                    Open with Desktop App
                  </button>
                )}
                <a
                  href={downloadHref}
                  download={displayFileName}
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  style={{ padding: '0.6rem 1.2rem', fontSize: '0.9rem' }}
                >
                  Download File
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
