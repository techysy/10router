import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

// Install paths per provider per platform — Trae and standard Windsurf IDE locations.
const IDE_PATHS = {
  trae: {
    darwin: ["/Applications/Trae.app"],
    win32: [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Trae", "Trae.exe"),
      path.join(process.env.ProgramFiles || "", "Trae", "Trae.exe"),
    ],
    linux: ["/usr/bin/trae", "/usr/local/bin/trae", "/opt/trae", "/opt/Trae"],
  },
  // Trae 国内版独立安装目录（"Trae CN"，与 "Trae" 并存；AI-Good-Tool/Trae-Api 同款识别口径）。
  // ide-status 只是粘贴 token 的 UX 提示（ideOptional=true），10R 装在服务器上没有
  // 客户端也照常可贴——探测不到不阻塞登录。
  "trae-cn": {
    darwin: ["/Applications/Trae CN.app"],
    win32: [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Trae CN", "Trae CN.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Trae CN", "Trae.exe"),
      path.join(process.env.ProgramFiles || "", "Trae CN", "Trae CN.exe"),
      path.join(process.env.ProgramFiles || "", "Trae CN", "Trae.exe"),
    ],
    linux: ["/opt/trae-cn", "/opt/Trae CN", "/usr/bin/trae-cn"],
  },
  windsurf: {
    darwin: ["/Applications/Windsurf.app"],
    win32: [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Windsurf", "Windsurf.exe"),
      path.join(process.env.ProgramFiles || "", "Windsurf", "Windsurf.exe"),
    ],
    linux: ["/usr/bin/windsurf", "/usr/local/bin/windsurf", "/opt/windsurf", "/opt/Windsurf"],
  },
};

const IDE_BINARIES = {
  trae: "trae",
  "trae-cn": "trae-cn",
  windsurf: "windsurf",
};

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function checkBinary(bin) {
  try {
    const cmd = os.platform() === "win32" ? `where ${bin}` : `which ${bin}`;
    await execAsync(cmd, { windowsHide: true });
    return true;
  } catch { return false; }
}

// Returns { installed: boolean, path: string|null } for the given provider's IDE.
export async function detectIdeInstalled(providerId) {
  const platform = os.platform();
  const paths = IDE_PATHS[providerId];
  if (!paths) return { installed: false, path: null };
  for (const p of paths[platform] || []) {
    if (p && await pathExists(p)) return { installed: true, path: p };
  }
  const bin = IDE_BINARIES[providerId];
  if (bin && await checkBinary(bin)) return { installed: true, path: bin };
  return { installed: false, path: null };
}
