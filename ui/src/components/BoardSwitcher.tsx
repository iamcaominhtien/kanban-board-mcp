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
  return (
    <div className={styles.container} role="tablist" aria-label="Board selection">
      {TABS.map((tab) => (
        <button
          key={tab.board}
          type="button"
          role="tab"
          aria-selected={selectedBoard === tab.board}
          className={`${styles.tab} ${selectedBoard === tab.board ? styles.active : ''}`}
          onClick={() => onBoardChange(tab.board)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
