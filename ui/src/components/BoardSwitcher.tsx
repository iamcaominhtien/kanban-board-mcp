import styles from './BoardSwitcher.module.css';

interface BoardSwitcherProps {
  selectedBoard: 'main' | 'idea';
  onBoardChange: (board: 'main' | 'idea') => void;
}

export function BoardSwitcher({ selectedBoard, onBoardChange }: BoardSwitcherProps) {
  return (
    <div className={styles.container} role="tablist" aria-label="Board selection">
      <button
        type="button"
        role="tab"
        aria-selected={selectedBoard === 'main'}
        className={`${styles.tab} ${selectedBoard === 'main' ? styles.active : ''}`}
        onClick={() => onBoardChange('main')}
      >
        📋 Board
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={selectedBoard === 'idea'}
        className={`${styles.tab} ${selectedBoard === 'idea' ? styles.active : ''}`}
        onClick={() => onBoardChange('idea')}
      >
        💡 Ideas
      </button>
    </div>
  );
}
