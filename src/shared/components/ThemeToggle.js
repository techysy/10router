"use client";

import { useRef, useState } from "react";
import { useTheme } from "@/shared/hooks/useTheme";
import { translate } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";
import ThemePickerPanel from "./ThemePicker";

// 顶栏/登录页的主题入口：按钮不再循环切换（主题多了循环不可用），点开
// 锚定在本按钮下沿的主题面板（右上角交互区，见 ThemePicker.js）。
// MODE_META 是全部主题的 UI 元数据单一来源 —— 新增主题在这里加一次，
// 设置页的主题行共用。
export const MODE_META = {
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
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const mode = MODE_META[theme] || MODE_META.system;

  const variants = {
    default: cn(
      "flex items-center justify-center size-10 rounded-full",
      "text-text-muted hover:text-text-main",
      open && "bg-surface-2 text-text-main",
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
    <div className={cn("relative", className)} data-theme-picker-root>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={cn(variants[variant])}
        aria-label={translate(mode.label)}
        aria-haspopup="dialog"
        aria-expanded={open}
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
      <ThemePickerPanel open={open} onClose={() => setOpen(false)} anchorRef={btnRef} />
    </div>
  );
}

ThemeToggle.propTypes = {
  className: (props, propName) => (props[propName] === undefined || typeof props[propName] === "string" ? null : new Error("className must be a string")),
  variant: (props, propName) => (["default", "card"].includes(props[propName]) ? null : new Error("variant must be default|card")),
};
