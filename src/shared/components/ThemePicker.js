"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "@/shared/hooks/useTheme";
import { translate } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";
import Toggle from "./Toggle";

// 主题清单与分组。加深/新增主题只动这里 + MODE_META（图标）+ globals.css
// token + themeStore THEMES（合法性）—— 四处同步。
//
// 「跟随系统」是 classic / glass 两组的组内开关（follow: true）——只有这两组
// 有深浅之分，跟随各自的深浅映射（themeStore SYSTEM_FAMILY）；打开时该组高亮
// 当前生效的那张卡。stylized 无深浅，没有跟随。glass 组是毛玻璃系：
// backdrop-filter 全力做效果，低端设备由能力提示兜底（用户明确不裁剪效果）。
export const THEME_GROUPS = [
  {
    key: "classic",
    label: "Classic",
    follow: true,
    // pair：跟随系统时昼夜落到哪张卡（卡片展示顺序与深浅无关，勿按下标推）。
    pair: { light: "light", dark: "dark" },
    themes: [
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" },
    ],
  },
  {
    key: "glass",
    label: "Glass",
    follow: true,
    pair: { light: "glass-light", dark: "glass-dark" },
    themes: [
      { id: "glass-light", name: "Glass Light" },
      { id: "glass-dark", name: "Glass Dark" },
    ],
  },
  {
    key: "stylized",
    label: "Stylized",
    themes: [
      { id: "brutal", name: "Brutal" },
      { id: "gruvbox", name: "Gruvbox" },
      { id: "nord", name: "Nord" },
      { id: "dracula", name: "Dracula" },
    ],
  },
];

// 迷你预览缩略图：一个「微型 dashboard」——侧栏条 + 顶栏 + 两块面板 +
// 品牌色按钮。纯 CSS，颜色取自每个主题的关键 token（inline style 直填，
// 不依赖 globals.css 加载时机，面板里即点即所见）。glass 两张卡在预览里
// 也走真半透明 + blur（预览容器带渐变底供其透出）。
const PREVIEW_TOKENS = {
  light:       { bg: "#FDFAF6", surface: "#ffffff", border: "#e5e7eb", text: "#0a0a0a", brand: "#E56A4A" },
  brutal:      { bg: "#FFF8E7", surface: "#fffdf5", border: "#111111", text: "#111111", brand: "#E56A4A" },
  dark:        { bg: "#131316", surface: "#1c1c21", border: "#2c2c33", text: "#f4f4f5", brand: "#E56A4A" },
  gruvbox:     { bg: "#282828", surface: "#32302f", border: "#504945", text: "#ebdbb2", brand: "#fe8019" },
  nord:        { bg: "#2e3440", surface: "#3b4252", border: "#4c566a", text: "#eceff4", brand: "#88c0d0" },
  dracula:     { bg: "#282a36", surface: "#343746", border: "#44475a", text: "#f8f8f2", brand: "#bd93f9" },
  "glass-light": { bg: "rgba(235,240,248,.92)", surface: "rgba(255,255,255,.72)", border: "rgba(255,255,255,.95)", text: "#1c1c1e", brand: "#E56A4A", glass: true },
  // 预览底色给足不透明度：半透明底叠在浅色面板上会发灰，深玻璃读起来像浅色。
  "glass-dark":  { bg: "rgba(14,18,27,.94)", surface: "rgba(36,40,52,.9)", border: "rgba(255,255,255,.2)", text: "#f2f2f7", brand: "#E56A4A", glass: true },
};

function ThemePreview({ id }) {
  const t = PREVIEW_TOKENS[id] || PREVIEW_TOKENS.light;
  return (
    <div
      className="rounded-lg overflow-hidden border h-[64px] shrink-0"
      style={{ background: t.bg, borderColor: t.border, backdropFilter: t.glass ? "blur(6px)" : undefined, WebkitBackdropFilter: t.glass ? "blur(6px)" : undefined }}
      aria-hidden
    >
      {/* 微型侧栏 + 主区 */}
      <div className="flex h-full">
        <div className="w-[22%] p-1.5 flex flex-col gap-1" style={{ background: t.surface, borderRight: `1px solid ${t.border}` }}>
          <div className="size-3 rounded" style={{ background: t.brand }} />
          <div className="h-1 rounded-full w-full opacity-30" style={{ background: t.text }} />
          <div className="h-1 rounded-full w-2/3 opacity-30" style={{ background: t.text }} />
        </div>
        <div className="flex-1 p-1.5 flex flex-col gap-1">
          <div className="h-1.5 rounded-full w-1/2 opacity-40" style={{ background: t.text }} />
          <div className="flex-1 rounded" style={{ background: t.surface, border: `1px solid ${t.border}` }} />
          <div className="flex gap-1">
            <div className="h-2.5 w-8 rounded" style={{ background: t.brand }} />
            <div className="h-2.5 w-5 rounded opacity-30" style={{ background: t.text }} />
          </div>
        </div>
      </div>
    </div>
  );
}

ThemePreview.propTypes = { id: (props, propName) => typeof props[propName] === "string" ? null : new Error("id required") };

// 锚定弹出层（不是居中 Modal）。panel portal 到 body + fixed 定位：
// 面板若留在触发按钮的原生层级里，会被后续 Card 的 backdrop-filter
// stacking context 整体压住（profile 页「主题面板被下一张卡盖住」就是它）。
// 位置在 useLayoutEffect 里直写 style（无 setState），并随滚动/视口变化
// 跟随锚点。消费方把触发元素的 ref 经 anchorRef 传入。
export default function ThemePickerPanel({ open, onClose, anchorRef }) {
  const { theme, setTheme, isDark, systemFamily, setFollowSystem } = useTheme();
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (e) => {
      const t = e.target;
      const inPanel = panelRef.current && panelRef.current.contains(t);
      const inAnchor = anchorRef?.current && anchorRef.current.contains?.(t);
      if (!inPanel && !inAnchor && !t.closest?.("[data-theme-picker-root]")) {
        onClose();
      }
    };
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, onClose, anchorRef]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const panel = panelRef.current;
      const anchor = anchorRef?.current;
      if (!panel || !anchor) return;
      const r = anchor.getBoundingClientRect();
      panel.style.top = `${Math.min(r.bottom + 8, window.innerHeight - 80)}px`;
      panel.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    };
    place();
    window.addEventListener("resize", place);
    // capture: 面板开着时内容区在内部滚动容器里滚，滚动不冒泡到 window
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef]);

  if (!open || typeof document === "undefined") return null;

  // 跟随系统时高亮该组「当前生效」的主题卡，网格反映的正是眼睛看到的东西。
  // system 只跟随 classic / glass 两组，落在 stylized 上不高亮任何卡。
  const effectiveFor = (group) => {
    if (theme !== "system") return theme;
    if (group.key === systemFamily && group.follow) {
      return isDark ? group.pair.dark : group.pair.light;
    }
    return null;
  };

  const pick = (id) => {
    setTheme(id);
    onClose();
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={translate("Theme")}
      className="theme-picker-panel fixed top-0 right-0 z-50 w-[min(92vw,340px)] rounded-xl border border-border-subtle bg-surface shadow-[var(--shadow-elev)] slide-in-top overflow-hidden"
    >
      <div className="px-4 pt-3 pb-2.5 border-b border-border-subtle">
        <p className="text-sm font-semibold text-text-main">{translate("Theme")}</p>
      </div>
      <div className="p-3 max-h-[min(64vh,520px)] overflow-y-auto custom-scrollbar">
        {THEME_GROUPS.map((group) => (
          <div key={group.key} className="mb-3 last:mb-0">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs font-medium text-text-muted">{translate(group.label)}</p>
              {group.follow && (
                <span className="flex items-center gap-1.5">
                  <span className="text-[11px] text-text-muted">{translate("Follow system")}</span>
                  <Toggle
                    size="sm"
                    checked={theme === "system" && systemFamily === group.key}
                    onChange={(on) => setFollowSystem(group.key, on)}
                  />
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {group.themes.map((t) => {
                const active = effectiveFor(group) === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => pick(t.id)}
                    className={cn(
                      "text-left rounded-lg p-1.5 border transition-all",
                      active
                        ? "border-brand-500 ring-1 ring-brand-500/40 bg-brand-500/5"
                        : "border-border hover:border-brand-500/50 hover:bg-surface-2"
                    )}
                  >
                    <ThemePreview id={t.id} />
                    <div className="flex items-center justify-between mt-1 px-0.5">
                      <span className={cn("text-xs font-medium", active ? "text-text-main" : "text-text-muted")}>
                        {translate(t.name)}
                      </span>
                      {active && (
                        <span className="material-symbols-outlined text-[15px] text-brand-500">check_circle</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
}

ThemePickerPanel.propTypes = {
  open: (props, propName) => typeof props[propName] === "boolean" ? null : new Error("open required"),
  onClose: (props, propName) => typeof props[propName] === "function" ? null : new Error("onClose required"),
  anchorRef: (props, propName) => (props[propName] === undefined || typeof props[propName] === "object" ? null : new Error("anchorRef must be a ref")),
};
