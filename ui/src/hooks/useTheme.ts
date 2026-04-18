import { useState, useEffect } from 'react';

export function useTheme() {
  const [theme, setTheme] = useState<'default' | 'bw'>(
    () => (localStorage.getItem('theme') as 'default' | 'bw') ?? 'default'
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(prev => (prev === 'default' ? 'bw' : 'default'));

  return { theme, toggleTheme };
}
