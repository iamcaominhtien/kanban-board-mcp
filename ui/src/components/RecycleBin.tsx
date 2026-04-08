import { useEffect, useRef, useState } from 'react';
import type { Ticket } from '../types';
import styles from './RecycleBin.module.css';

interface RecycleBinProps {
  tickets: Ticket[];
  onRestore: (ticketId: string) => void;
  onClose: () => void;
}

export function RecycleBin({ tickets, onRestore, onClose }: RecycleBinProps) {
  const [visible, setVisible] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  function handleClose() {
    setVisible(false);
    setTimeout(onClose, 200);
  }

  return (
    <div
      className={`${styles.overlay} ${visible ? styles.overlayVisible : ''}`}
      onClick={handleClose}
    >
      <div
        className={`${styles.panel} ${visible ? styles.panelVisible : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Recycle Bin"
      >
        <div className={styles.header}>
          <div className={styles.headerTitle}>
            <span className={styles.headerIcon}>🗑</span>
            Recycle Bin
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            aria-label="Close"
            onClick={handleClose}
            ref={closeBtnRef}
          >
            ×
          </button>
        </div>

        <div className={styles.body}>
          {tickets.length === 0 ? (
            <p className={styles.empty}>No tickets marked as "Không làm".</p>
          ) : (
            <ul className={styles.list}>
              {tickets.map((ticket) => (
                <li key={ticket.id} className={styles.item}>
                  <div className={styles.itemHeader}>
                    <span className={styles.itemId}>{ticket.id}</span>
                    <button
                      type="button"
                      className={styles.restoreBtn}
                      onClick={() => onRestore(ticket.id)}
                    >
                      ↩ Restore
                    </button>
                  </div>
                  <p className={styles.itemTitle}>{ticket.title}</p>
                  {ticket.wontDoReason && (
                    <p className={styles.itemReason}>
                      <span className={styles.reasonLabel}>Reason: </span>
                      {ticket.wontDoReason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
