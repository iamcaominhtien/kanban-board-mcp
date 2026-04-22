import type React from 'react';
import type { BoardType } from '../hooks/useBoardSelection';
import styles from './BoardSwitcher.module.css';

const TABS: { board: BoardType; label: string }[] = [
  { board: 'main', label: '📋 Board' },
  { board: 'idea', label: '💡 Ideas' },
];

interface BoardSwitcherProps {
  selectedBoard: BoardType;
  onBoardChange: (board: BoardType) => void;
}

export function BoardSwitcher({ selectedBoard, onBoardChange }: BoardSwitcherProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const tabs = TABS.map((t) => t.board);
    const currentIdx = tabs.indexOf(selectedBoard);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      onBoardChange(tabs[(currentIdx + 1) % tabs.length]);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onBoardChange(tabs[(currentIdx - 1 + tabs.length) % tabs.length]);
    }
  };

  return (
    <div
      className={styles.container}
      role="tablist"
      aria-label="Board selection"
      onKeyDown={handleKeyDown}
    >
      {TABS.map((tab) => (
        <button
          key={tab.board}
          id={`board-tab-${tab.board}`}
          type="button"
          role="tab"
          aria-selected={selectedBoard === tab.board}
          tabIndex={selectedBoard === tab.board ? 0 : -1}
          className={`${styles.tab} ${selectedBoard === tab.board ? styles.active : ''}`}
          onClick={() => onBoardChange(tab.board)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
