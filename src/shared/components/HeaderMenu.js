"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import ChangelogModal from "./ChangelogModal";
import { ConfirmModal } from "./Modal";
import { translate } from "@/i18n/runtime";

function MenuItem({ icon, label, onClick, href, trailing, danger }) {
  const className = `flex items-center gap-3 w-full px-4 py-2.5 text-sm transition-colors ${
    danger
      ? "text-red-500 hover:bg-red-500/10"
      : "text-text-main hover:bg-black/5 dark:hover:bg-white/5"
  }`;
  const inner = (
    <>
      <span className={`material-symbols-outlined text-[20px] ${danger ? "" : "text-text-muted"}`}>
        {icon}
      </span>
      <span className="flex-1 text-left">{label}</span>
      {trailing && <span className="text-base">{trailing}</span>}
    </>
  );
  // External entries are anchors, not buttons: middle-click / copy-link work,
  // and the desktop shell (fnOS webview) still treats them as normal links.
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className} onClick={onClick}>
        {inner}
      </a>
    );
  }
  return (
    <button onClick={onClick} className={className}>
      {inner}
    </button>
  );
}

MenuItem.propTypes = {
  icon: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  onClick: PropTypes.func,
  href: PropTypes.string,
  trailing: PropTypes.node,
  danger: PropTypes.bool,
};

export default function HeaderMenu({ onLogout }) {
  const [isOpen, setIsOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const menuRef = useRef(null);

  const handleShutdown = async () => {
    setIsShuttingDown(true);
    try {
      await fetch("/api/version/shutdown", { method: "POST" });
    } catch (e) {
      // Expected to fail as server shuts down; ignore error
    }
    setIsShuttingDown(false);
    setShutdownOpen(false);
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const close = () => setIsOpen(false);

  return (
    <>
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setIsOpen((v) => !v)}
          className="flex items-center justify-center p-2 rounded-lg text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5 transition-all"
          title={translate("Menu")}
        >
          <span className="material-symbols-outlined">grid_view</span>
        </button>

        {isOpen && (
          <div className="absolute right-0 top-full mt-2 w-60 bg-surface theme-card border border-black/10 dark:border-white/10 rounded-xl shadow-2xl z-50 animate-in fade-in zoom-in-95 duration-150 overflow-hidden py-1">
            <MenuItem
              icon="history"
              label={translate("Change Log")}
              onClick={() => { close(); setChangelogOpen(true); }}
            />
            {/* 主题切换不在这里：入口统一到左侧相邻的主题按钮（ThemeToggle，
                面板锚定按钮弹出），居中弹窗版已废弃。 */}
            <MenuItem
              icon="power_settings_new"
              label={translate("Shutdown")}
              danger
              onClick={() => { close(); setShutdownOpen(true); }}
            />
            <MenuItem
              icon="logout"
              label={translate("Logout")}
              danger
              onClick={() => { close(); onLogout(); }}
            />
          </div>
        )}
      </div>

      <ChangelogModal isOpen={changelogOpen} onClose={() => setChangelogOpen(false)} />
      <ConfirmModal
        isOpen={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title={translate("Close Proxy")}
        message={translate("Are you sure you want to close the proxy server?")}
        confirmText={translate("Close")}
        cancelText={translate("Cancel")}
        variant="danger"
        loading={isShuttingDown}
      />
    </>
  );
}

HeaderMenu.propTypes = {
  onLogout: PropTypes.func.isRequired,
};
