"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG } from "@/shared/constants/config";

const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: THEME_CONFIG.defaultTheme,

      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },

      toggleTheme: () => {
        const currentTheme = get().theme;
        const newTheme = currentTheme === "dark" ? "light" : "dark";
        set({ theme: newTheme });
        applyTheme(newTheme);
      },

      initTheme: () => {
        const theme = get().theme;
        applyTheme(theme);
      },
    }),
    {
      name: THEME_CONFIG.storageKey,
    }
  )
);

// Resolve whether a theme resolves to dark. Exported for tests (QA-006).
export function resolveIsDark(theme, systemPrefersDark) {
  return theme === "dark" || (theme === "system" && systemPrefersDark === true);
}

// Apply theme to document — console tokens stay warm-dark in both modes, but
// the `dark` class must reflect the effective theme so dark: variants and
// documentElement state match the user's selection (light removes it).
function applyTheme(theme) {
  if (typeof window === "undefined") return;
  const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", resolveIsDark(theme, systemPrefersDark));
}

export default useThemeStore;

