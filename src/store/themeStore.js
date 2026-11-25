"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG } from "@/shared/constants/config";

// 主题注册表。themePicker（ThemePicker 弹出层）是这个清单的单一事实来源：
// 两边同步改。system 是伪主题（跟随 OS 昼夜），落到哪个具体主题由
// systemFamily 决定——只有 classic / glass 两组有深浅之分，「跟随系统」
// 是组内开关（ThemePicker 组头），不是独立主题。glass 是毛玻璃系，
// backdrop-filter 全力做效果——低端设备由 ThemePicker 兜底提示
// （用户明确不裁剪效果）。
export const THEMES = ["system", "light", "dark", "brutal", "gruvbox", "nord", "dracula", "glass-light", "glass-dark"];
const DARK_FAMILY = ["dark", "gruvbox", "nord", "dracula", "glass-dark"];

// 「跟随系统」的组 → 深浅映射。system + systemFamily=classic 落到
// light/dark；=glass 落到 glass-light/glass-dark。layout.js 首帧脚本的
// 解析逻辑与此保持一致（两边同步改）。
export const SYSTEM_FAMILY = {
  classic: { light: "light", dark: "dark" },
  glass: { light: "glass-light", dark: "glass-dark" },
};

const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: THEME_CONFIG.defaultTheme,
      systemFamily: "classic",

      setTheme: (theme) => {
        if (!THEMES.includes(theme)) return;
        set({ theme });
        applyTheme(theme);
      },

      // 组内「跟随系统」开关。打开：记住是哪组在跟随（决定深浅映射落到
      // 哪对主题）。关掉：落回该组此刻正在显示的主题 —— 视觉零跳变。
      setFollowSystem: (family, on) => {
        if (!SYSTEM_FAMILY[family]) return;
        if (on) {
          set({ systemFamily: family, theme: "system" });
          applyTheme("system");
          return;
        }
        if (get().theme !== "system" || get().systemFamily !== family) return;
        const effective = resolveSystemTheme();
        set({ theme: effective });
        applyTheme(effective);
      },

      // 旧的循环切换：现在只在持久化的 theme 不认识时兜底到 system。
      // 真正的切换入口是 ThemePicker 弹出层（主题多了，循环不再可用——
      // 六个主题一按到底没法用）。顶栏主题按钮与设置页共用它。
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

// system 的解析：按 systemFamily 的深浅映射落到具体主题。dark 系主题统一
// 挂 .dark（dark: 变体层）+ 各自的 .theme-*（token 层），brutal 是亮组裸类。
function resolveSystemTheme() {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const family = SYSTEM_FAMILY[useThemeStore.getState().systemFamily] || SYSTEM_FAMILY.classic;
  return dark ? family.dark : family.light;
}

// Apply theme to document. Each theme paints through two root classes:
//   .dark  — set for every DARK_FAMILY theme. The whole app's `dark:` Tailwind
//            variants and `.dark …` rules (sidebar vibrancy, scrollbars,
//            select popups, dot-grid) key off this class only — a dark token
//            set without it renders light-mode chrome on dark colors (the
//            "white sidebar with unreadable text" bug).
//   .theme-* — the per-theme token layer; its block sits AFTER `.dark` in
//            globals.css, so on the coexisting class the theme's variables win.
// The two classes are cleaned up together on switch, so no stale pair lingers.
function applyTheme(theme) {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  const effectiveTheme = theme === "system" ? resolveSystemTheme() : theme;

  // 先清掉全部主题类再上新的 —— 新增主题时漏清理某一项的隐患由列表驱动消除。
  for (const cls of ["dark", "brutal", "theme-gruvbox", "theme-nord", "theme-dracula", "theme-glass-light", "theme-glass-dark"]) {
    root.classList.remove(cls);
  }
  if (DARK_FAMILY.includes(effectiveTheme)) root.classList.add("dark");
  // brutal 的 CSS 类是裸的 .brutal（狂野派先于 theme-* 约定存在），
  // 挂成 theme-brutal 会静默匹配不到任何规则 —— 整套皮肤丢失。
  if (effectiveTheme === "brutal") root.classList.add("brutal");
  else if (effectiveTheme !== "light" && effectiveTheme !== "dark") root.classList.add(`theme-${effectiveTheme}`);
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
