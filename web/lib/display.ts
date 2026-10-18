import { useCallback, useEffect, useState } from 'react';

export type DisplayPreferences = {
  density: 'compact' | 'comfortable';
  sidebarCollapsed: boolean;
  singleKeyShortcuts: boolean;
};

export const defaultDisplay: DisplayPreferences = {
  density: 'compact',
  sidebarCollapsed: true,
  singleKeyShortcuts: true,
};

function readDisplay(): DisplayPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem('forge.display') ?? 'null');
    return {
      density: saved?.density === 'comfortable' ? 'comfortable' : 'compact',
      sidebarCollapsed: saved?.sidebarCollapsed !== false,
      singleKeyShortcuts: saved?.singleKeyShortcuts !== false,
    };
  } catch {
    return { ...defaultDisplay };
  }
}

export function useDisplayPreferences() {
  const [display, setDisplay] = useState(readDisplay);
  useEffect(() => {
    document.documentElement.dataset.density = display.density;
    try {
      localStorage.setItem('forge.display', JSON.stringify(display));
    } catch {
      // Browser storage may be unavailable; the current view still works.
    }
  }, [display]);
  const updateDisplay = useCallback((patch: Partial<DisplayPreferences>) => {
    setDisplay((current) => ({ ...current, ...patch }));
  }, []);
  return { display, updateDisplay };
}
