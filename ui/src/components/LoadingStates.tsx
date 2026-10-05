import React from 'react';
import styles from './LoadingStates.module.css';

export const SkeletonCard: React.FC<{ opacity?: number; className?: string }> = ({
  opacity = 1,
  className,
}) => {
  return (
    <div
      className={`${styles.cardSkeleton} ${className ?? ''}`}
      style={{ opacity }}
    >
      <div className={styles.skel} style={{ width: 64, height: 10 }} />
      <div
        className={styles.skel}
        style={{ width: 90, height: 16, borderRadius: 999 }}
      />
      <div className={styles.skel} style={{ width: '100%', height: 12 }} />
      <div className={styles.skel} style={{ width: '70%', height: 12 }} />
    </div>
  );
};

export const SkeletonColumn: React.FC<{ count?: number; className?: string }> = ({
  count = 2,
  className,
}) => {
  return (
    <div className={`${styles.columnSkeleton} ${className ?? ''}`}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} opacity={i > 0 ? 0.75 : 1} />
      ))}
    </div>
  );
};

export const FullPageSpinner: React.FC<{ message?: string; className?: string }> = ({
  message = 'Loading board…',
  className,
}) => {
  return (
    <div className={`${styles.fullPageSpinner} ${className ?? ''}`}>
      <div className={styles.spinner} />
      <div className={styles.spinnerText}>{message}</div>
    </div>
  );
};

export const ButtonSpinner: React.FC<{ className?: string }> = ({ className }) => {
  return <span className={`${styles.buttonSpinner} ${className ?? ''}`} />;
};
