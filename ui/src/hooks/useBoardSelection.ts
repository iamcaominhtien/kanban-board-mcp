import { useCallback, useEffect, useState } from 'react';

export type BoardType = 'main' | 'idea';

type Board = BoardType;

function storageKey(projectId: string): string {
  return `selectedBoard_${projectId}`;
}

function readFromStorage(projectId: string): Board {
  try {
    const stored = localStorage.getItem(storageKey(projectId));
    if (stored === 'main' || stored === 'idea') return stored;
  } catch {
    // ignore
  }
  return 'main';
}

export function useBoardSelection(projectId: string | null): [Board, (board: Board) => void] {
  const [selectedBoard, setSelectedBoardState] = useState<Board>(() => {
    if (!projectId) return 'main';
    return readFromStorage(projectId);
  });

  // When projectId changes, reload the saved selection for the new project
  useEffect(() => {
    if (!projectId) {
      setSelectedBoardState('main');
      return;
    }
    setSelectedBoardState(readFromStorage(projectId));
  }, [projectId]);

  const setSelectedBoard = useCallback(
    (board: Board) => {
      setSelectedBoardState(board);
      if (projectId) {
        try {
          localStorage.setItem(storageKey(projectId), board);
        } catch {
          // ignore storage errors
        }
      }
    },
    [projectId],
  );

  return [selectedBoard, setSelectedBoard];
}
