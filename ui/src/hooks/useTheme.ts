import { useState, useEffect, useCallback } from 'react';
import type { Theme } from '../types';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(
    () => {
      const stored = localStorage.getItem('theme');
      const resolved: Theme = stored === 'bw' ? 'bw' : 'default';
      document.documentElement.dataset.theme = resolved; // apply before paint
      return resolved;
    }
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme(prev => (prev === 'default' ? 'bw' : 'default')), []);

  return { theme, toggleTheme };
}
