const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

// PowerShell-based tray for Windows (AV-safe, zero binary deps)

let psProcess = null;
let clickHandler = null;

/**
 * Windows tray background theme: true = light, false = dark (default).
 * 任务栏颜色跟随「Windows 模式」(SystemUsesLightTheme),不是「应用模式」
 * (AppsUseLightTheme)——自定义主题下两者可不同,优先读任务栏自己的值。
 * Direct registry read — cheap, and works before the PowerShell process starts.
 */
function isWindowsLightTheme() {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
  try {
    const out = execSync(`reg query "${key}" /v SystemUsesLightTheme`, {
      encoding: "utf8", timeout: 2000, windowsHide: true
    });
    return /0x1\b/.test(out);
  } catch (e) { /* fall through to app mode */ }
  try {
    const out = execSync(`reg query "${key}" /v AppsUseLightTheme`, {
      encoding: "utf8", timeout: 2000, windowsHide: true
    });
    return /0x1\b/.test(out);
  } catch (e) {
    return false;
  }
}

/**
 * Monochrome tray icon matching the system theme (white glyph on the default
 * dark taskbar, black on light). Falls back to the colored brand icon.
 */
function winTrayIconPath() {
  const mono = path.join(__dirname, isWindowsLightTheme() ? "icon-mono-black.ico" : "icon-mono-white.ico");
  try {
    if (fs.existsSync(mono)) return mono;
  } catch (e) {}
  return path.join(__dirname, "icon.ico");
}

/**
 * Send JSON command to PowerShell tray process via stdin
 */
function sendCommand(cmd) {
  if (psProcess && psProcess.stdin.writable) {
    psProcess.stdin.write(`${JSON.stringify(cmd)}\n`, "utf8");
  }
}

/**
 * Initialize Windows tray using PowerShell NotifyIcon
 * @param {Object} options - { iconPath, tooltip, items, onClick }
 *   items: [{ title, enabled }]
 * @returns {Object|null} controller with sendAction/kill
 */
function initWinTray(options) {
  const { iconPath, tooltip, items, onClick } = options;
  clickHandler = onClick;

  const scriptPath = path.join(__dirname, "tray.ps1");

  try {
    psProcess = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-InputFormat", "Text",
        "-OutputFormat", "Text",
        "-File", scriptPath,
        "-IconPath", iconPath,
        "-Tooltip", tooltip
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch (err) {
    return null;
  }

  const rl = readline.createInterface({ input: psProcess.stdout });
  rl.on("line", (line) => {
    try {
      const evt = JSON.parse(line);
      if (evt.type === "click" && clickHandler) {
        clickHandler(evt.index);
      }
    } catch (e) {}
  });

  psProcess.on("error", () => {});
  psProcess.stderr.on("data", () => {});

  // Send initial menu items
  items.forEach((item, index) => {
    sendCommand({ action: "add-item", index, title: item.title, enabled: item.enabled });
  });

  return {
    updateItem(index, title, enabled) {
      sendCommand({ action: "update-item", index, title, enabled });
    },
    setTooltip(text) {
      sendCommand({ action: "set-tooltip", text });
    },
    kill() {
      try {
        sendCommand({ action: "kill" });
      } catch (e) {}
      setTimeout(() => {
        if (psProcess && !psProcess.killed) {
          try { psProcess.kill(); } catch (e) {}
        }
        psProcess = null;
      }, 300);
    }
  };
}

module.exports = { initWinTray, isWindowsLightTheme, winTrayIconPath };
