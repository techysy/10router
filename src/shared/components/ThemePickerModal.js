"use client";

import Modal from "./Modal";
import { useTheme } from "@/shared/hooks/useTheme";
import { translate } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";

// 主题清单与分组。加深/新增主题只动这里 + MODE_META（图标）+ globals.css
// token + themeStore THEMES（合法性）—— 四处同步。
//
// light/dark 组决定「跟随系统」的映射（themeStore LIGHT_FAMILY/DARK_FAMILY
// 的第一个主题）。glass 组是毛玻璃系：backdrop-filter 全力做效果，低端设备
// 在弹窗里给出能力提示（用户明确不裁剪效果换性能）。
export const THEME_GROUPS = [
  {
    key: "light",
    label: "Light themes",
    themes: [
      { id: "light", name: "Light" },
      { id: "brutal", name: "Brutal" },
    ],
  },
  {
    key: "dark",
    label: "Dark themes",
    themes: [
      { id: "dark", name: "Dark" },
      { id: "gruvbox", name: "Gruvbox" },
      { id: "nord", name: "Nord" },
      { id: "dracula", name: "Dracula" },
    ],
  },
  {
    key: "glass",
    label: "Glass · 毛玻璃",
    themes: [
      { id: "glass-light", name: "Glass Light" },
      { id: "glass-dark", name: "Glass Dark" },
    ],
  },
];

// 迷你预览缩略图：一个「微型 dashboard」——侧栏条 + 顶栏 + 两块面板 +
// 品牌色按钮。纯 CSS，颜色取自每个主题的关键 token（inline style 直填，
// 不依赖 globals.css 加载时机，弹窗里即点即所见）。glass 两张卡在预览里
// 也走真半透明 + blur（预览容器带渐变底供其透出）。
const PREVIEW_TOKENS = {
  light:       { bg: "#FDFAF6", surface: "#ffffff", border: "#e5e7eb", text: "#0a0a0a", brand: "#E56A4A" },
  brutal:      { bg: "#FFF8E7", surface: "#fffdf5", border: "#111111", text: "#111111", brand: "#E56A4A" },
  dark:        { bg: "#131316", surface: "#1c1c21", border: "#2c2c33", text: "#f4f4f5", brand: "#E56A4A" },
  gruvbox:     { bg: "#282828", surface: "#32302f", border: "#504945", text: "#ebdbb2", brand: "#fe8019" },
  nord:        { bg: "#2e3440", surface: "#3b4252", border: "#4c566a", text: "#eceff4", brand: "#88c0d0" },
  dracula:     { bg: "#282a36", surface: "#343746", border: "#44475a", text: "#f8f8f2", brand: "#bd93f9" },
  "glass-light": { bg: "rgba(255,255,255,.5)", surface: "rgba(255,255,255,.55)", border: "rgba(255,255,255,.6)", text: "#1c1c1e", brand: "#E56A4A", glass: true },
  "glass-dark":  { bg: "rgba(24,28,38,.5)", surface: "rgba(30,32,40,.52)", border: "rgba(255,255,255,.14)", text: "#f2f2f7", brand: "#E56A4A", glass: true },
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

export default function ThemePickerModal({ isOpen, onClose }) {
  const { theme, setTheme } = useTheme();

  const pick = (id) => {
    setTheme(id);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={translate("Theme")} size="md" className="p-4!">
      <p className="text-xs text-text-muted mb-3">
        {translate("Pick a theme. Follow system uses the OS day/night preference.")}
      </p>
      {THEME_GROUPS.map((group) => (
        <div key={group.key} className="mb-4 last:mb-0">
          <p className="text-xs font-medium text-text-muted mb-2">{translate(group.label)}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {group.themes.map((t) => {
              const active = theme === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pick(t.id)}
                  className={cn(
                    "text-left rounded-lg p-2 border transition-all",
                    active
                      ? "border-brand-500 ring-1 ring-brand-500/40 bg-brand-500/5"
                      : "border-border hover:border-brand-500/50 hover:bg-surface-2"
                  )}
                >
                  <ThemePreview id={t.id} />
                  <div className="flex items-center justify-between mt-1.5 px-0.5">
                    <span className={cn("text-xs font-medium", active ? "text-text-main" : "text-text-muted")}>
                      {translate(t.name)}
                    </span>
                    {active && (
                      <span className="material-symbols-outlined text-[16px] text-brand-500">check_circle</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </Modal>
  );
}

ThemePickerModal.propTypes = {
  isOpen: (props, propName) => typeof props[propName] === "boolean" ? null : new Error("isOpen required"),
  onClose: (props, propName) => typeof props[propName] === "function" ? null : new Error("onClose required"),
};
