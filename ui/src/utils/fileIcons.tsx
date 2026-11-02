export type FileCategory =
  'excel' | 'word' | 'powerpoint' | 'pdf' | 'json' | 'text' | 'code' | 'image' | 'media' | 'archive' | 'generic';

export interface FileTypeMeta {
  category: FileCategory;
  label: string;
  badge: string;
  color: string;
  bgColor: string;
  borderColor: string;
}

const CATEGORY_MAP: Record<string, FileCategory> = {
  // Spreadsheet / Excel
  xlsx: 'excel',
  xls: 'excel',
  csv: 'excel',
  tsv: 'excel',
  // Word / Docs
  docx: 'word',
  doc: 'word',
  rtf: 'word',
  odt: 'word',
  // PowerPoint / Presentation
  pptx: 'powerpoint',
  ppt: 'powerpoint',
  odp: 'powerpoint',
  key: 'powerpoint',
  // PDF
  pdf: 'pdf',
  // JSON & Data
  json: 'json',
  json5: 'json',
  jsonl: 'json',
  // Text / Logs
  txt: 'text',
  log: 'text',
  md: 'text',
  markdown: 'text',
  // Code / Config
  js: 'code',
  jsx: 'code',
  ts: 'code',
  tsx: 'code',
  py: 'code',
  html: 'code',
  css: 'code',
  scss: 'code',
  yaml: 'code',
  yml: 'code',
  xml: 'code',
  sql: 'code',
  sh: 'code',
  env: 'code',
  toml: 'code',
  // Images
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  ico: 'image',
  // Audio & Video
  mp3: 'media',
  wav: 'media',
  ogg: 'media',
  mp4: 'media',
  webm: 'media',
  mov: 'media',
  // Archives
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  rar: 'archive',
  '7z': 'archive',
};

const CATEGORY_CONFIG: Record<FileCategory, FileTypeMeta> = {
  excel: {
    category: 'excel',
    label: 'Excel Spreadsheet',
    badge: 'XLS',
    color: '#2e6f40',
    bgColor: '#dceee1',
    borderColor: 'rgba(46, 111, 64, 0.35)',
  },
  word: {
    category: 'word',
    label: 'Word Document',
    badge: 'DOC',
    color: '#2f6fb0',
    bgColor: '#e1eefb',
    borderColor: 'rgba(47, 111, 176, 0.35)',
  },
  powerpoint: {
    category: 'powerpoint',
    label: 'PowerPoint Presentation',
    badge: 'PPT',
    color: '#b4571f',
    bgColor: '#fbe9e1',
    borderColor: 'rgba(180, 87, 31, 0.35)',
  },
  pdf: {
    category: 'pdf',
    label: 'PDF Document',
    badge: 'PDF',
    color: '#2f6fb0',
    bgColor: '#e1eefb',
    borderColor: 'rgba(47, 111, 176, 0.35)',
  },
  json: {
    category: 'json',
    label: 'JSON Data',
    badge: 'JSON',
    color: '#2f6fb0',
    bgColor: '#e1eefb',
    borderColor: 'rgba(47, 111, 176, 0.35)',
  },
  text: {
    category: 'text',
    label: 'Plain Text',
    badge: 'TXT',
    color: '#5b6b60',
    bgColor: '#f1f3f1',
    borderColor: 'rgba(91, 107, 96, 0.35)',
  },
  code: {
    category: 'code',
    label: 'Source Code',
    badge: 'CODE',
    color: '#5b6b60',
    bgColor: '#f1f3f1',
    borderColor: 'rgba(91, 107, 96, 0.35)',
  },
  image: {
    category: 'image',
    label: 'Image',
    badge: 'IMG',
    color: '#b4571f',
    bgColor: '#fbe9e1',
    borderColor: 'rgba(180, 87, 31, 0.35)',
  },
  media: {
    category: 'media',
    label: 'Media',
    badge: 'MEDIA',
    color: '#5b5fa8',
    bgColor: '#e6e9f5',
    borderColor: 'rgba(91, 95, 168, 0.35)',
  },
  archive: {
    category: 'archive',
    label: 'Archive',
    badge: 'ZIP',
    color: '#8a7355',
    bgColor: '#f3efea',
    borderColor: 'rgba(138, 115, 85, 0.35)',
  },
  generic: {
    category: 'generic',
    label: 'File',
    badge: 'FILE',
    color: '#5b6b60',
    bgColor: '#f6faf7',
    borderColor: 'rgba(91, 107, 96, 0.35)',
  },
};

/** Return the lowercase extension without the dot. */
export function getFileExtension(filename: string): string {
  const clean = filename.split(/[?#]/)[0];
  const lastDot = clean.lastIndexOf('.');
  if (lastDot === -1 || lastDot === clean.length - 1) return '';
  return clean.slice(lastDot + 1).toLowerCase();
}

/** Return the category of a file by its extension. */
export function getFileCategory(filename: string): FileCategory {
  const ext = getFileExtension(filename);
  return CATEGORY_MAP[ext] || 'generic';
}

/** Names for the kinds that the category label would blur (CSV is not "Excel Spreadsheet"). */
const EXT_LABELS: Record<string, string> = {
  csv: 'CSV',
  tsv: 'TSV',
  md: 'Markdown',
  markdown: 'Markdown',
  html: 'HTML',
  mp3: 'Audio',
  wav: 'Audio',
  ogg: 'Audio',
  mp4: 'Video',
  webm: 'Video',
  mov: 'Video',
};

/** Return the icon, color and badge for a file. */
export function getFileTypeMeta(filename: string): FileTypeMeta {
  const cat = getFileCategory(filename);
  const ext = getFileExtension(filename).toUpperCase();
  const base = CATEGORY_CONFIG[cat];
  return {
    ...base,
    label: EXT_LABELS[ext.toLowerCase()] ?? base.label,
    badge: ext || base.badge,
  };
}

/** Whether the file can be previewed as text. */
export function isTextPreviewable(filename: string): boolean {
  const cat = getFileCategory(filename);
  return cat === 'text' || cat === 'json' || cat === 'code';
}

/** Whether the file is a PDF. */
export function isPdf(filename: string): boolean {
  return getFileCategory(filename) === 'pdf';
}

/** Whether the file is an image. */
export function isImage(filename: string): boolean {
  return getFileCategory(filename) === 'image';
}

/** Whether the file is audio or video. */
export function isMedia(filename: string): boolean {
  return getFileCategory(filename) === 'media';
}

/** Whether the file is an Office document. */
export function isOfficeDoc(filename: string): boolean {
  const cat = getFileCategory(filename);
  return cat === 'excel' || cat === 'word' || cat === 'powerpoint';
}

/** Format bytes as "1.5 KB"; empty for missing values. */
export function formatFileSize(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || isNaN(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Strip the path and the server-added hash suffix from a stored file name. */
export function cleanDisplayFileName(rawName: string): string {
  if (!rawName) return 'Tệp tin';
  let clean = decodeURIComponent(rawName.split(/[?#]/)[0]);
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  if (slash !== -1) clean = clean.slice(slash + 1);

  // If filename has a UUID pattern like "-a1b2c3d4e5f6.ext" added by backend, strip it for clean display
  // Pattern: name-<12hexchars>.ext
  const match = clean.match(/^(.*?)-([0-9a-f]{8,32})(\.[a-z0-9]+)$/i);
  if (match) {
    clean = match[1] + match[3];
  }
  return clean;
}

/**
 * SVG Icon component for file types
 * @param props.category - File category picking the icon shape and default color.
 * @param props.size - Width and height in px.
 * @param props.color - Stroke color override; defaults to the category color.
 */
export function FileCategoryIcon({
  category,
  size = 20,
  color,
}: {
  category: FileCategory;
  size?: number;
  color?: string;
}) {
  const meta = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.generic;
  const stroke = color || meta.color;

  switch (category) {
    case 'excel':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="M8 13h8" />
          <path d="M8 17h8" />
          <path d="M12 9v12" />
        </svg>
      );
    case 'word':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <line x1="10" y1="9" x2="8" y2="9" />
        </svg>
      );
    case 'powerpoint':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="M9 13h3a2 2 0 0 0 0-4H9v8" />
        </svg>
      );
    case 'pdf':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="M9 15h6" />
          <circle cx="10" cy="11" r="1.5" />
        </svg>
      );
    case 'json':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
          <line x1="14" y1="4" x2="10" y2="20" />
        </svg>
      );
    case 'code':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      );
    case 'image':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      );
    case 'media':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
      );
    case 'archive':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="21 8 21 21 3 21 3 8" />
          <rect x="1" y="3" width="22" height="5" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      );
    case 'text':
    default:
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      );
  }
}
