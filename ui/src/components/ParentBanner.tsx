import type { Ticket } from '../types';
import styles from './ParentBanner.module.css';

interface ParentBannerProps {
  parentTicket: Ticket;
  onOpenParent: () => void;
}

export function ParentBanner({ parentTicket, onOpenParent }: ParentBannerProps) {
  return (
    <button type="button" className={styles.banner} onClick={onOpenParent} title="Open parent ticket">
      <span className={styles.arrow}>↑</span>
      <span>Child of</span>
      <span className={styles.parentId}>{parentTicket.id}:</span>
      <span className={styles.parentTitle}>{parentTicket.title}</span>
    </button>
  );
}
