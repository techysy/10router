#!/usr/bin/env bash
# 10Router 桌面版一键打包 (macOS) —— 必须在 macOS 上执行
# 用法:
#   cd desktop
#   ./build.sh                   # 全自动:构建 cli/app -> npm install -> electron-builder --mac
#   ./build.sh --skip-app-build  # 复用已有 cli/app 产物
# 产物在 dist/:10Router-Mac-Setup-<版本>-x64.dmg + 10Router-Mac-Setup-<版本>-arm64.dmg(无证书时 ad-hoc 签名,
# 首次打开需右键 -> 打开)。
# 要求:Node >= 18(macOS 自带 python 不需要;图标 icon.png 已随仓库提供)。

set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$DESKTOP_DIR")"
CLI_APP_DIR="$REPO_DIR/cli/app"

SKIP_APP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-app-build) SKIP_APP_BUILD=1 ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

echo "== 10Router Desktop Build (macOS) =="

# 0) 产物汇集:确保 cli/app(Next standalone)存在
if [ "$SKIP_APP_BUILD" = "1" ] && [ -f "$CLI_APP_DIR/custom-server.js" ]; then
  echo "[1/3] 复用已有 cli/app ($CLI_APP_DIR)"
else
  echo "[1/3] 构建 CLI 产物(node cli/scripts/build-cli.js,含 Next build)…"
  (cd "$REPO_DIR" && node cli/scripts/build-cli.js)
fi

# 1) 依赖安装(Electron 二进制按网络情况走镜像,可按需覆盖)
echo "[2/3] npm install (desktop)…"
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
cd "$DESKTOP_DIR"
npm install

# 2) electron-builder 打包(x64 + arm64 两个 dmg)
echo "[3/3] electron-builder --mac…"
npx electron-builder --mac

echo
echo "✅ 完成,产物在 $DESKTOP_DIR/dist/"
ls -1 "$DESKTOP_DIR/dist" 2>/dev/null || true
