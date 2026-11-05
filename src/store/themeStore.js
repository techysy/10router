"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG } from "@/shared/constants/config";

// 主题注册表。themePicker（ThemePickerModal）是这个清单的单一事实来源：
// 两边同步改。system 是伪主题（跟随 OS），落到 LIGHT_FAMILY / DARK_FAMILY
// 的第一个主题上。glass 是毛玻璃系（浅/深各一），backdrop-filter 全力做
// 效果——低端设备由 ThemePickerModal 里的能力提示兜底（用户明确不裁剪效果）。
export const THEMES = ["system", "light", "dark", "brutal", "gruvbox", "nord", "dracula", "glass-light", "glass-dark"];
const LIGHT_FAMILY = ["light", "brutal", "glass-light"];
const DARK_FAMILY = ["dark", "gruvbox", "nord", "dracula", "glass-dark"];

const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: THEME_CONFIG.defaultTheme,

      setTheme: (theme) => {
        if (!THEMES.includes(theme)) return;
        set({ theme });
        applyTheme(theme);
      },

      // 旧的循环切换：现在只在持久化的 theme 不认识时兜底到 system。
      // 真正的切换入口是 ThemePickerModal（主题多了，循环不再可用——
      // 六个主题一按到底没法用）。HeaderMenu 的单按钮也已改为打开弹窗。
      toggleTheme: () => {
        const current = get().theme;
        const next = THEMES.includes(current) ? "system" : THEME_CONFIG.defaultTheme;
        set({ theme: next });
        applyTheme(next);
      },

      initTheme: () => {
        const theme = get().theme;
        applyTheme(THEMES.includes(theme) ? theme : THEME_CONFIG.defaultTheme);
      },
    }),
    {
      name: THEME_CONFIG.storageKey,
    }
  )
);

// system 的解析：亮组/暗组的第一个主题。dark 单独成类（.dark 变量层），
// brutal 仍是专属根类；gruvbox/nord/dracula/solarized 是新的 token 变体，
// 同样互斥成根类（见 globals.css）。
function resolveSystemTheme() {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return dark ? DARK_FAMILY[0] : LIGHT_FAMILY[0];
}

// Apply theme to document. Every theme is expressed as a mutually exclusive
// root class so a stale class can never linger when switching (e.g. going
// dark → brutal must drop .dark, or the dark variables would win).
function applyTheme(theme) {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  const effectiveTheme = theme === "system" ? resolveSystemTheme() : theme;

  // 先清掉全部主题类再上新的 —— 新增主题时漏清理某一项的隐患由列表驱动消除。
  for (const cls of ["dark", "brutal", "theme-gruvbox", "theme-nord", "theme-dracula", "theme-glass-light", "theme-glass-dark"]) {
    root.classList.remove(cls);
  }
  if (effectiveTheme === "dark") root.classList.add("dark");
  else if (effectiveTheme !== "light") root.classList.add(`theme-${effectiveTheme}`);
  // Keeps native widgets (scrollbars, date pickers, select popups) in step
  // with the active skin instead of following the OS.
  root.style.colorScheme = effectiveTheme === "dark" || DARK_FAMILY.includes(effectiveTheme) ? "dark" : "light";

  // Mobile browser chrome (address bar) follows the skin at runtime too — the
  // inline first-paint script in layout.js only covers the refresh path, so
  // switching themes live never updated it.
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) {
    const themeColor = {
      brutal: "#FFF6E5",
      gruvbox: "#282828",
      nord: "#2e3440",
      dracula: "#282a36",
      "glass-light": "#eef2f8",
      "glass-dark": "#141822",
    }[effectiveTheme] || (effectiveTheme === "dark" ? "#0a0a0a" : "#FDFAF6");
    themeColorMeta.setAttribute("content", themeColor);
  }
}

export default useThemeStore;
