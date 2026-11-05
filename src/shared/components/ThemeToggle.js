"use client";

import { useTheme } from "@/shared/hooks/useTheme";
import { translate } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";

// Four-state cycle: system → light → dark → brutal (the store's toggleTheme).
// "system" tracks the OS day/night so Windows personalization / macOS
// appearance / the fnOS browser drive the theme with no manual switching;
// "brutal" is the neo-brutalist skin. The icon shows the CURRENT mode so the
// auto state is discoverable. Exported as the single source of truth for every
// theme switcher surface (HeaderMenu reuses it — a new theme is added here
// once, never per-surface).
export const MODE_META = {
  // 主题清单的 UI 元数据。清单本体在 themeStore THEMES（存储合法性）与
  // ThemePickerModal THEME_GROUPS（分组展示）—— 三处同步改。
  // icon 用于 HeaderMenu 菜单项（显示当前主题）与弹窗空态。
  system:      { icon: "routine",    label: "Theme: system" },
  light:       { icon: "light_mode", label: "Theme: light" },
  dark:        { icon: "dark_mode",  label: "Theme: dark" },
  brutal:      { icon: "palette",    label: "Theme: brutal" },
  gruvbox:     { icon: "forest",     label: "Theme: gruvbox" },
  nord:        { icon: "ac_unit",    label: "Theme: nord" },
  dracula:     { icon: "nightlight", label: "Theme: dracula" },
  "glass-light": { icon: "blur_on",  label: "Theme: glass light" },
  "glass-dark":  { icon: "blur_on",  label: "Theme: glass dark" },
};

export default function ThemeToggle({ className, variant = "default" }) {
  const { theme, toggleTheme } = useTheme();
  const mode = MODE_META[theme] || MODE_META.system;

  const variants = {
    default: cn(
      "flex items-center justify-center size-10 rounded-full",
      "text-text-muted hover:text-text-main",
      "hover:bg-surface-2 transition-colors"
    ),
    card: cn(
      "flex items-center justify-center size-11 rounded-full",
      "bg-surface/60 hover:bg-surface",
      "border border-border",
      "backdrop-blur-md shadow-sm hover:shadow-[var(--shadow-warm)]",
      "text-text-muted hover:text-brand-500",
      "transition-all group"
    ),
  };

  return (
    <button
      onClick={toggleTheme}
      className={cn(variants[variant], className)}
      aria-label={translate(mode.label)}
      title={translate(mode.label)}
      data-theme-mode={theme}
    >
      <span
        className={cn(
          "material-symbols-outlined text-[22px]",
          variant === "card" && "transition-transform duration-300 group-hover:rotate-12"
        )}
      >
        {mode.icon}
      </span>
    </button>
  );
}
