import styles from './TagPill.module.css';

export const TAG_PALETTE = [
  { bg: 'rgba(47,111,176,0.12)', color: '#2F6FB0' }, // blue
  { bg: 'rgba(109,93,211,0.12)', color: '#6D5DD3' }, // purple
  { bg: 'rgba(46,111,64,0.12)', color: '#2E6F40' }, // forest green
  { bg: 'rgba(226,121,61,0.14)', color: '#B4571F' }, // amber / orange
  { bg: 'rgba(196,67,42,0.12)', color: '#C4432A' }, // red
  { bg: 'rgba(45,150,140,0.14)', color: '#1E6B65' }, // teal
  { bg: 'rgba(91,107,96,0.12)', color: '#5B6B60' }, // sage neutral
];

// Special fixed mapping for known semantic tags from design
const SPECIFIC_TAGS: Record<string, { bg: string; color: string }> = {
  ui: { bg: 'rgba(47,111,176,0.12)', color: '#2F6FB0' },
  dnd: { bg: 'rgba(109,93,211,0.12)', color: '#6D5DD3' },
  backend: { bg: 'rgba(46,111,64,0.12)', color: '#2E6F40' },
  perf: { bg: 'rgba(226,121,61,0.14)', color: '#B4571F' },
  urgent: { bg: 'rgba(196,67,42,0.12)', color: '#C4432A' },
  bug: { bg: 'rgba(196,67,42,0.12)', color: '#C4432A' },
};

/** Return a stable color pair for a tag. */
export function getTagColor(tag: string): { bg: string; color: string } {
  const normalized = tag.toLowerCase().trim();
  if (SPECIFIC_TAGS[normalized]) {
    return SPECIFIC_TAGS[normalized];
  }
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash << 5) - hash + normalized.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % TAG_PALETTE.length;
  return TAG_PALETTE[index];
}

interface TagPillProps {
  tag: string;
  size?: 'small' | 'medium' | 'large';
  onRemove?: () => void;
  className?: string;
}

/** Colored tag chip, removable when `onRemove` is set. */
export function TagPill({ tag, size = 'small', onRemove, className }: TagPillProps) {
  const { bg, color } = getTagColor(tag);
  const sizeClass = size === 'large' ? styles.tagPillLarge : size === 'medium' ? styles.tagPillMedium : '';

  return (
    <span className={`${styles.tagPill} ${sizeClass} ${className ?? ''}`} style={{ backgroundColor: bg, color }}>
      <span>{tag}</span>
      {onRemove && (
        <button
          type="button"
          className={styles.removeBtn}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove tag ${tag}`}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </span>
  );
}
