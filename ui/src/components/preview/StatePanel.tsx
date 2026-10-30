import type { ReactNode } from 'react';
import styles from './PreviewViewer.module.css';

type Tone = 'loading' | 'warn' | 'error';

interface Props {
  tone: Tone;
  title: string;
  children?: ReactNode;
  /** Buttons; Download should always be one of them. */
  actions?: ReactNode;
}

/** A centred message for loading and problem states. Every state leaves a way out. */
export function StatePanel({ tone, title, children, actions }: Props) {
  return (
    <div className={styles.statePanel} role={tone === 'error' ? 'alert' : 'status'} data-tone={tone}>
      {tone === 'loading' ? (
        <div className={styles.spinner} aria-hidden="true" />
      ) : (
        <div className={styles.stateIcon} aria-hidden="true">
          !
        </div>
      )}
      <div className={styles.stateTitle}>{title}</div>
      {children && <div className={styles.stateText}>{children}</div>}
      {actions && <div className={styles.stateActions}>{actions}</div>}
    </div>
  );
}

/** Text shown above a reader when only the start of a file is shown. */
export function Notice({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className={styles.notice} role="note">
      <span>{children}</span>
      {actions && <span className={styles.noticeActions}>{actions}</span>}
    </div>
  );
}
