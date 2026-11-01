"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG } from "@/shared/constants/config";

// Toggle order. "brutal" sits between dark and system so the cycle stays
// one-press-per-mode: system → light → dark → brutal → system.
const THEME_CYCLE = ["system", "light", "dark", "brutal"];

const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: THEME_CONFIG.defaultTheme,

      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },

      // Cycle: system → light → dark → brutal → system. "system" follows the
      // OS preference (Windows personalization / macOS appearance / the fnOS
      // browser), "brutal" is the neo-brutalist skin (cream paper, hard black
      // outlines, zero-blur shadows) — it is a light-family theme, so it never
      // stacks with .dark.
      toggleTheme: () => {
        const currentTheme = get().theme;
        const index = THEME_CYCLE.indexOf(currentTheme);
        const nextTheme = THEME_CYCLE[(index === -1 ? 0 : index + 1) % THEME_CYCLE.length];
        set({ theme: nextTheme });
        applyTheme(nextTheme);
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

// Apply theme to document. Every theme is expressed as a mutually exclusive
// root class so a stale class can never linger when switching (e.g. going
// dark → brutal must drop .dark, or the dark variables would win).
function applyTheme(theme) {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

  const effectiveTheme = theme === "system" ? systemTheme : theme;

  root.classList.toggle("dark", effectiveTheme === "dark");
  root.classList.toggle("brutal", effectiveTheme === "brutal");
  // Keeps native widgets (scrollbars, date pickers, select popups) in step
  // with the active skin instead of following the OS.
  root.style.colorScheme = effectiveTheme === "dark" ? "dark" : "light";
}

export default useThemeStore;
