import React, { useState, useRef, useEffect } from 'react';
import type { Status } from '../types/ticket';
import styles from './StatusMenu.module.css';

export interface StatusOption {
  status: Status;
  label: string;
  dotColor: string;
}

export const STATUS_OPTIONS: StatusOption[] = [
  { status: 'backlog', label: 'Backlog', dotColor: '#C7D2CB' },
  { status: 'todo', label: 'To Do', dotColor: '#9AA8A0' },
  { status: 'in-progress', label: 'In Progress', dotColor: '#2F6FB0' },
  { status: 'review', label: 'Review', dotColor: '#6D5DD3' },
  { status: 'testing', label: 'Testing', dotColor: '#B4571F' },
  { status: 'done', label: 'Done', dotColor: '#2E6F40' },
  // divider before wont_do
  { status: 'wont_do', label: "Won't Do", dotColor: '#C4432A' },
];

export interface StatusMenuProps {
  value: Status;
  onChange: (status: Status) => void;
  disabled?: boolean;
  className?: string;
}

export const StatusMenu: React.FC<StatusMenuProps> = ({
  value,
  onChange,
  disabled = false,
  className,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentOption =
    STATUS_OPTIONS.find((opt) => opt.status === value) ?? STATUS_OPTIONS[0];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelect = (status: Status) => {
    onChange(status);
    setIsOpen(false);
  };

  const mainStatuses = STATUS_OPTIONS.filter((opt) => opt.status !== 'wont_do');
  const wontDoOption = STATUS_OPTIONS.find((opt) => opt.status === 'wont_do')!;

  return (
    <div
      ref={containerRef}
      className={`${styles.container} ${className ?? ''}`}
    >
      <button
        type="button"
        className={`${styles.trigger} ${isOpen ? styles.triggerOpen : ''}`}
        onClick={() => !disabled && setIsOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span
          className={styles.dot}
          style={{ backgroundColor: currentOption.dotColor }}
        />
        <span className={styles.label}>{currentOption.label}</span>
        <svg
          className={`${styles.arrow} ${isOpen ? styles.arrowOpen : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke={isOpen ? '#5B6B60' : '#9AA8A0'}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9L12 15L18 9" />
        </svg>
      </button>

      {isOpen && (
        <div className={styles.dropdown} role="listbox">
          {mainStatuses.map((opt) => {
            const isActive = opt.status === value;
            return (
              <button
                key={opt.status}
                type="button"
                className={`${styles.item} ${isActive ? styles.itemActive : ''}`}
                onClick={() => handleSelect(opt.status)}
                role="option"
                aria-selected={isActive}
              >
                <span
                  className={styles.dot}
                  style={{ backgroundColor: opt.dotColor }}
                />
                <span className={styles.itemText}>{opt.label}</span>
                {isActive && (
                  <svg
                    className={styles.checkmark}
                    viewBox="0 0 14 14"
                    fill="none"
                  >
                    <path
                      d="M3.5 7.2L5.7 9.5L10.5 4.3"
                      stroke="#2E6F40"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            );
          })}

          <div className={styles.divider} />

          <button
            type="button"
            className={`${styles.item} ${value === wontDoOption.status ? styles.itemActive : ''}`}
            onClick={() => handleSelect(wontDoOption.status)}
            role="option"
            aria-selected={value === wontDoOption.status}
          >
            <span
              className={styles.dot}
              style={{ backgroundColor: wontDoOption.dotColor }}
            />
            <span className={styles.itemText}>{wontDoOption.label}</span>
            {value === wontDoOption.status && (
              <svg
                className={styles.checkmark}
                viewBox="0 0 14 14"
                fill="none"
              >
                <path
                  d="M3.5 7.2L5.7 9.5L10.5 4.3"
                  stroke="#2E6F40"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
};
