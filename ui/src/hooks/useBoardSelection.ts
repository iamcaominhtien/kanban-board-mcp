import { useCallback, useLayoutEffect, useState } from 'react';

export type BoardType = 'main' | 'idea';

type Board = BoardType;

function storageKey(projectId: string): string {
  return `selectedBoard_${projectId}`;
}

function readFromStorage(projectId: string | null): Board {
  if (!projectId) return 'main';
  try {
    const stored = localStorage.getItem(storageKey(projectId));
    if (stored === 'main' || stored === 'idea') return stored;
  } catch {
    // ignore
  }
  return 'main';
}

export function useBoardSelection(projectId: string | null): [Board, (board: Board) => void] {
  const [selectedBoard, setSelectedBoardState] = useState<Board>(() => readFromStorage(projectId));

  // useLayoutEffect fires synchronously before paint — no stale render on projectId change
  useLayoutEffect(() => {
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
