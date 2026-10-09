#!/usr/bin/env bash
# 10Router fpk 本机 WSL 打包线:盖号 → 干净构建 → 组装(仅补缺失) → smoke → url/iframe 双变体 → sha256 → 导出
#
# 在 WSL(root)里跑;Windows 侧一条命令触发(Git Bash / cmd 皆可):
#   wsl -u root bash -lc 'bash "/mnt/f/Files/GitHub Files/10router/scripts/fpk-local.sh" --version 1.3.6-test.2'
#
# 为什么在 WSL ext4 的克隆里构建:
# - /mnt/f 是 drvfs,npm/next 在其上慢一个数量级;
# - 克隆与 Windows 工作树隔离——并行会话切分支不会污染构建(见 memory: nas-hot-deploy-isolated-build);
# - 31.31 构建机(i3-12300T/4核/7.7GB)已弃用:慢且 next build 内存吃紧(2026-10-08 决定走本机)。
# 克隆的 origin 就是 Windows 工作树,`git fetch` 拿到 main 的最新**提交**——
# 未提交的改动测不到,脚本会提示。
#
# 关键历史坑(2026-10-08,详见 docs/zh-CN/fnpk-size-reduction-1.3.6.md):
# 补拷 node_modules 时**覆盖** standalone 自带的 next,会连带毁掉 standalone 的
# node_modules/@swc → NAS 上 `Cannot find module '@swc/helpers/_/_interop_require_default'`,
# 服务起不来。所以组装只用 copy_if_missing 补 standalone 缺的包。
# CI(build-fpk.yml)已同步改为仅补缺失。
#
# 产物(导出目录默认 Windows 仓库的 fnos-packaging/):
#   10router-<ver>-url-<arch>.fpk / 10router-<ver>-iframe-<arch>.fpk
#   SHA256SUMS-fpk-<ver>.txt
#   10router-<ver>-server.tar.gz   ← 热替换用,交给 scripts/nas-deploy.sh(Git Bash 跑)
#
# 用法:
#   fpk-local.sh [--version X.Y.Z-test.N] [--no-build] [--no-smoke] [--keep-version]
#                [--clone DIR] [--out DIR] [--smoke-port N]
#   --no-build   复用克隆里现有 .next/standalone。要求克隆**已盖测试号**(版本号烘焙进 bundle,
#                没盖号会打出自相矛盾的产物);此时不再改版本号、结束后也不回退。
#   --keep-version 测完不回退版本号(继续迭代 -no-build 时配合用)。
set -euo pipefail

VERSION="" BUILD=1 SMOKE=1 KEEP=0
CLONE="${FPK_CLONE:-/root/projects/10router-fpk}"
WINREPO="${FPK_WINREPO:-/mnt/f/Files/GitHub Files/10router}"
SMOKE_PORT="${FPK_SMOKE_PORT:-20139}"
EXPORT=""

usage() { sed -n '2,/^set -euo/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --clone) CLONE="$2"; shift 2 ;;
    --out) EXPORT="$2"; shift 2 ;;
    --smoke-port) SMOKE_PORT="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --no-smoke) SMOKE=0; shift ;;
    --keep-version) KEEP=1; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1"; usage ;;
  esac
done
EXPORT="${EXPORT:-$WINREPO/fnos-packaging}"
PKG="$CLONE/fnos-packaging"
SRV="$PKG/app/server"

# ---------- 0) 前提 ----------
for t in node tar; do command -v "$t" >/dev/null || { echo "✗ 缺工具: $t"; exit 1; }; done
command -v fnpack >/dev/null 2>&1 || [ -x /usr/local/bin/fnpack ] || { echo "✗ 缺 fnpack(CI 用 1.2.1: https://static2.fnnas.com/fnpack/)"; exit 1; }
FPKPACK="$(command -v fnpack || echo /usr/local/bin/fnpack)"
command -v jq >/dev/null 2>&1 || { [ -x /usr/sbin/jq ] || { echo "✗ 缺 jq"; exit 1; }; }
JQ="$(command -v jq || echo /usr/sbin/jq)"
[ -d "$CLONE/.git" ] || { echo "✗ 克隆不存在: $CLONE(先 git clone \"$WINREPO\" $CLONE && cd $CLONE && npm install)"; exit 1; }
[ -d "$CLONE/node_modules" ] || { echo "✗ 克隆没装依赖: cd $CLONE && npm install(约 20 分钟,一次即可)"; exit 1; }

STAMPED=0; CFG_BAK=""
revert_all() {
  rc=$?
  if [ -n "$CFG_BAK" ] && [ -f "$CFG_BAK" ]; then cp "$CFG_BAK" "$PKG/app/ui/config" 2>/dev/null || true; rm -f "$CFG_BAK"; fi
  if [ "$STAMPED" = 1 ] && [ "$KEEP" = 0 ]; then
    (cd "$CLONE" && npm run test-version -- --revert >/dev/null 2>&1) \
      || echo "⚠ 版本号自动回退失败,手动: cd \"$CLONE\" && npm run test-version -- --revert"
  fi
  [ $rc -ne 0 ] && echo "== 失败($rc)。克隆里的中间产物与日志保留,可复盘: $CLONE"
  exit $rc
}
trap revert_all EXIT

if [ "$BUILD" = 1 ]; then
  # 克隆必须干净:防止盖印版本号、或别的会话留下的改动被当成"当前代码"
  DIRTY=$(git -C "$CLONE" status --porcelain | grep -vE '^\?\? ' || true)
  [ -z "$DIRTY" ] || { echo "✗ 克隆工作区有未提交改动(先回退/清掉):"; echo "$DIRTY"; exit 1; }
  # ---------- 1) 同步到 Windows 工作树的 main 最新提交 ----------
  BR=$(git -C "$CLONE" rev-parse --abbrev-ref HEAD)
  [ "$BR" = main ] || git -C "$CLONE" checkout -q main || { echo "✗ 克隆不在 main 且切不过去"; exit 1; }
  git -C "$CLONE" fetch -q origin
  git -C "$CLONE" merge --ff -q origin/main || { echo "✗ 克隆 main 无法快进到工作树 main(历史被动过?)"; exit 1; }
  WDIRTY=$(git -C "$WINREPO" status --porcelain -- src open-sse desktop cli 2>/dev/null | grep -vE '^\?\? ' || true)
  [ -z "$WDIRTY" ] || echo "⚠ Windows 工作树有未提交的源码改动——本脚本只测已提交代码(要测先 commit)"
  # ---------- 2) 测试号 ----------
  if [ -z "$VERSION" ]; then
    TAG=$(git -C "$CLONE" describe --tags --abbrev=0 --match 'v*' | sed 's/^v//')
    M=${TAG%%.*}; rest=${TAG#*.}; m=${rest%%.*}; p=${rest##*.}
    p=$((p+1))
    N=$(ls "$EXPORT/" 2>/dev/null | grep -oE "^10router-$M\.$m\.$p-test\.[0-9]+(-|$)" | grep -oE 'test\.[0-9]+' | cut -d. -f2 | sort -n | tail -1)
    VERSION="$M.$m.$p-test.$(( ${N:-0} + 1 ))"
    echo "== 自动测试号: $VERSION(最新 tag v$TAG 补丁位+1,轮次扫产物目录)"
  fi
  echo "== 盖测试版本号 $VERSION"
  (cd "$CLONE" && npm run test-version "$VERSION" >/dev/null)
  STAMPED=1
  # ---------- 3) 构建 standalone(postbuild 自动带 static/public/custom-server.js) ----------
  echo "== npm run build(较慢;Windows+Node24 有 OOM 前科,WSL 下正常)"
  (cd "$CLONE" && npm run build)
else
  # --no-build:克隆必须已盖测试号——版本号烘焙进 bundle,复用未盖号产物=自相矛盾
  VNOW=$(grep -o '"version": "[^"]*"' "$CLONE/package.json" | head -1 | sed 's/.*: "//;s/"//')
  case "$VNOW" in
    *-test.*) ;;
    *) echo "✗ --no-build 要求克隆已盖测试号(当前 $VNOW)。先去掉 --no-build 完整构建,或手动 npm run test-version"; exit 1 ;;
  esac
  [ -z "$VERSION" ] || [ "$VERSION" = "$VNOW" ] || { echo "✗ --version $VERSION 与克隆盖印的 $VNOW 不一致(--no-build 时号以克隆为准)"; exit 1; }
  VERSION="$VNOW"
  echo "== 复用现有构建,测试号 $VERSION(跳过同步/盖号/build)"
fi
[ -d "$CLONE/.next/standalone" ] || { echo "✗ 没有 .next/standalone"; exit 1; }

# ---------- 4) 组装 app/server:只补 standalone 缺的包,绝不覆盖 ----------
cd "$CLONE"
rm -rf fnos-packaging/app/server
mkdir -p fnos-packaging/app/server
cp -r .next/standalone/. fnos-packaging/app/server/
cp -r open-sse fnos-packaging/app/server/
cp -r src/mitm fnos-packaging/app/server/
copy_if_missing() {
  local pkg="$1"
  if [ -d "$SRV/node_modules/$pkg" ]; then
    echo "SKIP  $pkg (standalone 已带)"
  else
    mkdir -p "$SRV/node_modules/$pkg"
    cp -r "node_modules/$pkg/." "$SRV/node_modules/$pkg/"
    echo "COPY  $pkg (standalone 缺,补入)"
  fi
}
for pkg in node-forge sql.js next better-sqlite3 @swc; do copy_if_missing "$pkg"; done
find fnos-packaging -type l -delete 2>/dev/null || true
for p in node_modules/@swc/helpers node_modules/next node_modules/sql.js open-sse src/mitm .next/BUILD_ID public custom-server.js; do
  [ -e "$SRV/$p" ] || { echo "✗ 组装后仍缺 $p —— 运行时必炸,终止"; exit 1; }
done
echo "== app/server 组装完成: $(du -sh "$SRV" | cut -f1),BUILD_ID $(cat "$SRV/.next/BUILD_ID")"

# ---------- 5) 装前 smoke:临时 DATA_DIR 真跑 custom-server(先验证产物,再谈安装) ----------
if [ "$SMOKE" = 1 ]; then
  SMOKE_DATA=$(mktemp -d /tmp/10rf-smoke-XXXXXX)
  echo "== smoke:PORT=$SMOKE_PORT DATA_DIR=$SMOKE_DATA"
  ( cd "$SRV" && DATA_DIR="$SMOKE_DATA" HOME="$SMOKE_DATA" PORT="$SMOKE_PORT" HOSTNAME=127.0.0.1 \
      INSTALL_CHANNEL=fpk INITIAL_PASSWORD=smoketest123456 \
      nohup node --max-old-space-size=4096 custom-server.js > "$SMOKE_DATA/smoke.log" 2>&1 &
      echo $! > "$SMOKE_DATA/pid" )
  ok=0
  for i in $(seq 1 60); do
    curl -sf -m 3 "http://127.0.0.1:$SMOKE_PORT/api/health" >/dev/null 2>&1 && { ok=1; break; }
    kill -0 "$(cat "$SMOKE_DATA/pid")" 2>/dev/null || break
    sleep 1
  done
  if [ "$ok" = 1 ]; then
    # 登录态 SSR 冒烟(与 test-local.ps1 step 7 同源):未登录打 /dashboard 得 307(重定向 login),
    # 那只证明路由存在;health 全绿但页面 500 真发生过(test-report-test17),必须带 auth_token 打到 200。
    # jwt-secret 在服务启动加载 auth 模块时已落盘(DATA_DIR),直接复用 desktop/mint-smoke-jwt.mjs 铸 10 分钟号。
    if [ ! -f "$SMOKE_DATA/jwt-secret" ]; then echo "✗ smoke: DATA_DIR 里没有 jwt-secret(auth 未初始化?)"; tail -20 "$SMOKE_DATA/smoke.log"; kill "$(cat "$SMOKE_DATA/pid")" 2>/dev/null || true; exit 1; fi
    (cd "$CLONE" && node desktop/mint-smoke-jwt.mjs "$SMOKE_DATA/jwt-secret" "$SMOKE_DATA/smoke.jwt") || { echo "✗ smoke: 铸 JWT 失败"; kill "$(cat "$SMOKE_DATA/pid")" 2>/dev/null || true; exit 1; }
    JT=$(cat "$SMOKE_DATA/smoke.jwt")
    d=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -H "Cookie: auth_token=$JT" "http://127.0.0.1:$SMOKE_PORT/dashboard")
    l=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:$SMOKE_PORT/login")
    m=$(curl -s -m 10 "http://127.0.0.1:$SMOKE_PORT/v1/models" | head -c 60)
    # /v1/models 是 OpenAI 信封:{"object":"list","data":[…]}
    case "$m" in '{"object"'*'data'*) mok=1 ;; *) mok=0 ;; esac
    if [ "$d" = 200 ] && [ "$l" = 200 ] && [ "$mok" = 1 ]; then
      echo "== smoke OK(health + 登录态 dashboard=200 login=200 models=ok)"
    else
      kill "$(cat "$SMOKE_DATA/pid")" 2>/dev/null || true
      echo "✗ smoke 异常 dashboard=$d login=$l models=${m:0:40}(期望 200/200/{\"data\"…,终止)"; tail -20 "$SMOKE_DATA/smoke.log"; exit 1
    fi
  else
    kill "$(cat "$SMOKE_DATA/pid")" 2>/dev/null || true
    echo "✗ SMOKE FAILED,日志尾部:"; tail -40 "$SMOKE_DATA/smoke.log"; exit 1
  fi
  kill "$(cat "$SMOKE_DATA/pid")" 2>/dev/null || true
  rm -rf "$SMOKE_DATA"
fi

# ---------- 6) fnpack 打 url + iframe 两个变体 ----------
cd "$PKG"
FPK_VER=$(grep -E '^version[[:space:]]*=' manifest | sed 's/.*=//;s/[[:space:]]//g')
PLATFORM=$(grep -E '^platform[[:space:]]*=' manifest | sed 's/.*=//;s/[[:space:]]//g')
[ "$FPK_VER" = "$VERSION" ] || { echo "✗ manifest $FPK_VER ≠ 测试号 $VERSION(prebuild:fpk 没同步?)"; exit 1; }
CFG_BAK=$(mktemp /tmp/10rf-config-XXXXXX)
cp app/ui/config "$CFG_BAK"
for variant in url iframe; do
  "$JQ" --exit-status --arg v "$variant" '.".url"."10router.Application".type = $v' app/ui/config > app/ui/config.tmp
  mv app/ui/config.tmp app/ui/config
  rm -f 10router.fpk
  "$FPKPACK" build -d . > /dev/null
  [ -f 10router.fpk ] || { echo "✗ fnpack 打 $variant 失败"; exit 1; }
  mv 10router.fpk "10router-$FPK_VER-$variant-$PLATFORM.fpk"
  ls -lh "10router-$FPK_VER-$variant-$PLATFORM.fpk"
done
cp "$CFG_BAK" app/ui/config; rm -f "$CFG_BAK"; CFG_BAK=""

# ---------- 7) 热替换用 server tar(交 scripts/nas-deploy.sh,Windows 侧跑) ----------
tar czf "10router-$FPK_VER-server.tar.gz" -C app/server --exclude='./logs' .

# ---------- 8) sha256 + 导出 ----------
ls "10router-$FPK_VER"-*-*.fpk | xargs sha256sum > "SHA256SUMS-fpk-$FPK_VER.txt"
mkdir -p "$EXPORT"
cp "10router-$FPK_VER-url-$PLATFORM.fpk" "10router-$FPK_VER-iframe-$PLATFORM.fpk" \
   "SHA256SUMS-fpk-$FPK_VER.txt" "10router-$FPK_VER-server.tar.gz" "$EXPORT/"
(cd "$EXPORT" && sha256sum -c "SHA256SUMS-fpk-$FPK_VER.txt" >/dev/null && echo "== 导出校验和 OK")

echo
echo "✅ 完成。产物在: $EXPORT"
echo "   热替换(Git Bash): bash scripts/nas-deploy.sh \"$EXPORT/10router-$FPK_VER-server.tar.gz\""
echo "   或应用中心安装:   10router-$FPK_VER-url-$PLATFORM.fpk"
[ "$KEEP" = 0 ] && [ "$STAMPED" = 1 ] && echo "   (测试号已自动回退;要保留加 --keep-version)"
