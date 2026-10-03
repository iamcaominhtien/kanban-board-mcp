import React, { createContext, useContext, useState, useCallback } from 'react';
import styles from './Toast.module.css';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  title: string;
  message?: string;
  duration?: number;
}

interface ToastContextValue {
  showToast: (props: Omit<ToastItem, 'id'>) => string;
  removeToast: (id: string) => void;
  success: (title: string, message?: string, duration?: number) => string;
  error: (title: string, message?: string, duration?: number) => string;
  warning: (title: string, message?: string, duration?: number) => string;
  info: (title: string, message?: string, duration?: number) => string;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    ({ variant, title, message, duration = 4000 }: Omit<ToastItem, 'id'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      setToasts((prev) => [...prev, { id, variant, title, message, duration }]);

      if (duration > 0) {
        setTimeout(() => {
          removeToast(id);
        }, duration);
      }
      return id;
    },
    [removeToast]
  );

  const success = useCallback(
    (title: string, message?: string, duration?: number) =>
      showToast({ variant: 'success', title, message, duration }),
    [showToast]
  );

  const error = useCallback(
    (title: string, message?: string, duration?: number) =>
      showToast({ variant: 'error', title, message, duration }),
    [showToast]
  );

  const warning = useCallback(
    (title: string, message?: string, duration?: number) =>
      showToast({ variant: 'warning', title, message, duration }),
    [showToast]
  );

  const info = useCallback(
    (title: string, message?: string, duration?: number) =>
      showToast({ variant: 'info', title, message, duration }),
    [showToast]
  );

  const getVariantIcon = (variant: ToastVariant) => {
    switch (variant) {
      case 'success':
        return '✓';
      case 'error':
        return '✕';
      case 'warning':
        return '!';
      case 'info':
        return 'ℹ';
    }
  };

  const getIconClass = (variant: ToastVariant) => {
    switch (variant) {
      case 'success':
        return styles.iconSuccess;
      case 'error':
        return styles.iconError;
      case 'warning':
        return styles.iconWarning;
      case 'info':
        return styles.iconInfo;
    }
  };

  return (
    <ToastContext.Provider value={{ showToast, removeToast, success, error, warning, info }}>
      {children}
      <div className={styles.toastContainer} aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={styles.toast} role="alert">
            <div className={`${styles.icon} ${getIconClass(toast.variant)}`}>
              {getVariantIcon(toast.variant)}
            </div>
            <div className={styles.content}>
              <div className={styles.title}>{toast.title}</div>
              {toast.message && <div className={styles.message}>{toast.message}</div>}
            </div>
            <button
              type="button"
              className={styles.closeButton}
              onClick={() => removeToast(toast.id)}
              aria-label="Close notification"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

export interface InlineBannerProps {
  message: string;
  icon?: string;
  className?: string;
}

export const InlineBanner: React.FC<InlineBannerProps> = ({
  message,
  icon = '✓',
  className,
}) => {
  return (
    <div className={`${styles.inlineBanner} ${className ?? ''}`}>
      <span className={styles.bannerIcon}>{icon}</span>
      <span className={styles.bannerText}>{message}</span>
    </div>
  );
};
