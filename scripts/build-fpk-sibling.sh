#!/usr/bin/env bash
# build-fpk-sibling.sh — 打包「并存测试」fpk：与正式 fpk 不同 appname/端口/数据目录，
# 在 fnOS 应用中心是独立应用，不影响已安装的 10Router。
#
# 用法（在 Linux 构建机上，仓库根目录）：
#   bash scripts/build-fpk-sibling.sh                # 默认 10router20 / 端口 20130 / 版本 2.0.0
#   VERSION=2.0.1 PORT=20130 bash scripts/build-fpk-sibling.sh
#
# 依赖：node（构建 standalone）、curl、sha256sum。fnpack 按 CI 钉版下载并校验。
set -euo pipefail

SIBLING_ID="${SIBLING_ID:-20}"
APPNAME="${APPNAME:-10router${SIBLING_ID}}"
DISPLAY_NAME="${DISPLAY_NAME:-10Router 2.0 Test}"
VERSION="${VERSION:-2.0.0}"
PORT="${PORT:-20130}"
PLATFORM="${PLATFORM:-x86}"
SKIP_BUILD="${SKIP_BUILD:-0}"
REPO_DIR="${REPO_DIR:-$PWD}"

FNPACK_VERSION="1.2.1"
FNPACK_SHA256="72d2a4095da676b64510b023731a227b369d80f8079bc45ff8a2f802ec0480c1" # linux-amd64

cd "$REPO_DIR"
echo "== fpk sibling build: appname=${APPNAME} version=${VERSION} port=${PORT} platform=${PLATFORM} =="

# 1) standalone 服务端（与 build-fpk.yml 同一汇集清单）
if [ "${SKIP_BUILD}" != "1" ]; then
  echo "[1/4] npm run build (Next standalone)…"
  rm -rf fnos-packaging/app/server
  npm run build
else
  echo "[1/4] SKIP_BUILD=1，沿用现有 .next/standalone"
fi
mkdir -p fnos-packaging/app/server
cp -r .next/standalone/. fnos-packaging/app/server/
cp -r open-sse fnos-packaging/app/server/
cp -r src/mitm fnos-packaging/app/server/
mkdir -p fnos-packaging/app/server/node_modules
for m in node-forge sql.js next better-sqlite3; do
  cp -r "node_modules/${m}" fnos-packaging/app/server/node_modules/
done

cd fnos-packaging

# 2) 身份改写（manifest / 桌面入口 / 数据共享名）
echo "[2/4] 改写应用身份 → ${APPNAME}"
sed -i \
  -e "s/^appname.*/appname               = ${APPNAME}/" \
  -e "s/^version.*/version               = ${VERSION}/" \
  -e "s/^display_name.*/display_name          = ${DISPLAY_NAME}/" \
  -e "s|^desc.*|desc                  = 10Router 并存测试版（独立端口 ${PORT}、独立数据目录，与正式版互不影响）|" \
  -e "s/^desktop_applaunchname.*/desktop_applaunchname = ${APPNAME}.Application/" \
  -e "s/^service_port.*/service_port          = ${PORT}/" \
  -e "s/^platform.*/platform              = ${PLATFORM}/" \
  manifest
grep -E '^(appname|version|display_name|service_port|platform|desktop_applaunchname)' manifest

node -e '
const fs = require("fs");
const [appname, title, port] = process.argv.slice(1);
const p = "app/ui/config";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
const old = c[".url"]["10router.Application"];
if (!old) { console.error("ui/config 缺少 10router.Application 键"); process.exit(1); }
delete c[".url"]["10router.Application"];
c[".url"][`${appname}.Application`] = { ...old, title, port: String(port) };
fs.writeFileSync(p, JSON.stringify(c, null, 2));
' "${APPNAME}" "${DISPLAY_NAME}" "${PORT}"
sed -i "s#\"10router/data\"#\"${APPNAME}/data\"#g; s#\"10router\"#\"${APPNAME}\"#g" config/resource

# 图标不替换——同一品牌；靠 display_name（应用中心展示「10Router 2.0 Test」）区分。

# 3) fnpack（钉版本 + sha256 校验，与 CI 一致）
echo "[3/4] 获取 fnpack ${FNPACK_VERSION}"
ARCH_SUFFIX="linux-amd64"
[ "${PLATFORM}" = "arm" ] && { ARCH_SUFFIX="linux-arm64"; FNPACK_SHA256="aad9e16b101267d30017f39ab969e3c085fbce209716f8bd3b1e167eaf15e0cf"; }
curl -fsSL -o /tmp/fnpack "https://static2.fnnas.com/fnpack/fnpack-${FNPACK_VERSION}-${ARCH_SUFFIX}"
echo "${FNPACK_SHA256}  /tmp/fnpack" | sha256sum -c -
chmod +x /tmp/fnpack
find . -type l -delete

# 4) 打包
echo "[4/4] fnpack build"
rm -f "${APPNAME}.fpk" 10router.fpk
/tmp/fnpack build -d .
OUT="${APPNAME}.fpk"
[ -f "${OUT}" ] || OUT="10router.fpk"   # fnpack 按 manifest appname 命名；防御性兜底
[ -f "${OUT}" ] || { echo "ERROR: fpk 未产出" >&2; exit 1; }
FINAL="${APPNAME}-${VERSION}-test-${PLATFORM}.fpk"
mv "${OUT}" "${FINAL}"
ls -lh "${FINAL}"
echo "OK: $(pwd)/${FINAL}"
