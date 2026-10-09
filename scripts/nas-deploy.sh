#!/usr/bin/env bash
# 10Router NAS 热替换部署线(在 Git Bash / Windows 侧跑;WSL 没有 ssh,别在 WSL 里跑本脚本):
#   预检 → 传 server tar → NAS 预解包 → 原子交换 → appcenter 重启 → 验证;验证失败自动回滚旧版
#
# 输入是 scripts/fpk-local.sh(WSL 打包线)导出的 server tar:
#   bash scripts/nas-deploy.sh [版本号] [--dry-run]
# 不传版本号 = fnos-packaging/ 里最新的 10router-*-server.tar.gz。
#
# 流程与铁律出自 docs/zh-CN/fnos-hot-replace-deploy.md §2:
# - **先换文件再重启**:appcenter-cli stop 之后 ~72s fnOS 守护会自动拉起,
#   "先停再慢慢解包"会让它读到半成品;
# - 预解包/属主都在应用还跑着时做,交换只剩两个 rename;
# - 服务用户是 10router,chown 不对就起不来;
# - 数据在 @appdata/10router,热替换只动 @appcenter 代码目录,不碰数据。
#
# 验证(装后闭环):health {"ok":true} + dashboard/login 200 + /v1/models + BUILD_ID 与本地 tar 一致
#   —— health 全绿但页面 500 真发生过(test-report-test17),只看 health 不够。
# 任一验证失败 → 自动换回 server.bak-<ts> 并重启回旧版。
set -euo pipefail

SSH_HOST="${NAS_SSH:-nas}"
BASE="${NAS_BASE:-/vol4/@appcenter/10router}"
DRY=0
VER=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) VER="$a" ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$REPO/fnos-packaging"
if [ -z "$VER" ]; then
  TAR=$(ls -1t "$PKG"/10router-*-server.tar.gz 2>/dev/null | head -1 || true)
  [ -n "$TAR" ] || { echo "✗ fnos-packaging/ 里没有 10router-*-server.tar.gz(先跑 WSL 打包线 scripts/fpk-local.sh)"; exit 1; }
else
  TAR="$PKG/10router-$VER-server.tar.gz"
  [ -f "$TAR" ] || { echo "✗ 找不到 $TAR"; exit 1; }
fi
VER=$(basename "$TAR" | sed 's/^10router-//;s/-server\.tar\.gz$//')

# tar 必须来自 fpk-local.sh 的完整流水线(组装校验+smoke+fnpack 都过了)。
# 只有 fnpack 真打了包才会留下同版本的 url fpk 与 SHA256SUMS——手搓散装 tar 在这里被拒。
[ -f "$PKG/10router-$VER-url-x86.fpk" ] || { echo "✗ 本地没有同版本 url fpk(10router-$VER-url-x86.fpk)——tar 可能来路不完整"; exit 1; }
[ -f "$PKG/SHA256SUMS-fpk-$VER.txt" ] || { echo "✗ 本地没有同版本 SHA256SUMS——tar 可能来路不完整"; exit 1; }

echo "== 部署 $VER($(du -h "$TAR" | cut -f1)) → $SSH_HOST:$BASE"
if [ "$DRY" = 1 ]; then echo "(dry-run:验证以上前置后退出,不连 NAS)"; exit 0; fi

echo "== 预检 ssh/sudo"
ssh -o BatchMode=yes "$SSH_HOST" "echo ok" >/dev/null || { echo "✗ ssh $SSH_HOST 不通"; exit 1; }
ssh -o BatchMode=yes "$SSH_HOST" "sudo -n true" 2>/dev/null || { echo "✗ sudo 不可用(nas 需免密 sudo)"; exit 1; }

# tar 由 `tar czf … .` 生成,成员名带 ./ 前缀;两种写法都试,防打包端形态变化
LOCAL_BID=$(tar xzOf "$TAR" ./.next/BUILD_ID 2>/dev/null || tar xzOf "$TAR" .next/BUILD_ID 2>/dev/null || true)
[ -n "$LOCAL_BID" ] || { echo "✗ tar 里读不到 .next/BUILD_ID"; exit 1; }
echo "== 本地 BUILD_ID: $LOCAL_BID"

echo "== 上传 server tar"
scp -q -o BatchMode=yes "$TAR" "$SSH_HOST:/tmp/10rf-deploy.tar.gz"
NAS_MD5=$(ssh -o BatchMode=yes "$SSH_HOST" "md5sum /tmp/10rf-deploy.tar.gz" | cut -d' ' -f1)
LOC_MD5=$(md5sum "$TAR" | cut -d' ' -f1)
[ "$NAS_MD5" = "$LOC_MD5" ] || { echo "✗ 上传校验不一致(nas=$NAS_MD5 local=$LOC_MD5)"; exit 1; }
echo "== 上传完成(md5 一致)"

TS=$(date +%s)
# heredoc 不带引号 = Windows 侧本地展开(传 BASE/TS/BID 进去),
# 所有 NAS 侧的东西一律 \$ 或 \$(...) 转义。**新加行忘了转义会在这里静默炸远程脚本。**
ssh -o BatchMode=yes "$SSH_HOST" bash -s <<EOF
set -euo pipefail
BASE=$BASE
TS=$TS

echo "-- [NAS] 预解包 → server.new(慢步骤,趁旧版还在服务时做)"
sudo rm -rf "\$BASE/server.new" && sudo mkdir -p "\$BASE/server.new"
sudo tar xzf /tmp/10rf-deploy.tar.gz -C "\$BASE/server.new"
[ -f "\$BASE/server/.env" ] && sudo cp -a "\$BASE/server/.env" "\$BASE/server.new/.env" || true
sudo chown -R 10router:10router "\$BASE/server.new"
V=\$(grep -o '"version": "[^"]*"' "\$BASE/server.new/package.json" | head -1 | sed 's/.*: "//;s/"//')
B=\$(cat "\$BASE/server.new/.next/BUILD_ID")
echo "-- [NAS] server.new: version=\$V BUILD_ID=\$B"
[ "\$B" = "$LOCAL_BID" ] || { echo "✗ [NAS] BUILD_ID 与本地不一致,终止(不动现役)"; exit 1; }

rollback() {
  # bak 存在才说明交换(至少第一个 mv)发生过;没交换就别动现役 server。
  # 两个 mv 之间崩的半残态(server 没了、bak 在)由 rm -rf 的 || true 兜住。
  [ -d "\$BASE/server.bak-\$TS" ] || { echo "-- [NAS] 交换未发生,无需回滚"; return 0; }
  echo "-- [NAS] 回滚 → server.bak-\$TS"
  sudo /usr/local/bin/appcenter-cli stop 10router || true
  sudo rm -rf "\$BASE/server" || true
  sudo mv "\$BASE/server.bak-\$TS" "\$BASE/server"
  sudo /usr/local/bin/appcenter-cli start 10router || true
}
# trap 必须在**第一个 mv 之前**装好:两个 mv 之间失败(磁盘满等)会留下"没有 server 目录"的半残态,
# 装得晚就没人回滚了。
trap 'rollback; exit 1' ERR

echo "-- [NAS] 原子交换(两个 rename,瞬间;随后走 appcenter 重启)"
sudo mv "\$BASE/server" "\$BASE/server.bak-\$TS"
sudo mv "\$BASE/server.new" "\$BASE/server"

sudo /usr/local/bin/appcenter-cli stop 10router || true
sudo /usr/local/bin/appcenter-cli start 10router

echo "-- [NAS] 验证(health 最多 90s)"
ok=0
for i in \$(seq 1 90); do
  h=\$(curl -sf -m 3 http://127.0.0.1:20127/api/health 2>/dev/null) || h=""
  if printf '%s' "\$h" | grep -q '"ok":true'; then ok=1; break; fi
  sleep 1
done
[ "\$ok" = 1 ] || { echo "✗ [NAS] health 90s 未就绪:\$h"; false; }
echo "-- [NAS] health: \$h"
l=\$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:20127/login)
[ "\$l" = 200 ] || { echo "✗ [NAS] login 页异常:\$l"; false; }
# dashboard 验证登录态(health 绿但页面 500 真发生过,test-report-test17)。
# 用 initial-password 真登录拿 cookie;用户改过口令(401)时退化为"未登录必须 307 去 /login"——
# 307 同样能证明 SSR 路由活着,且不会用错误口令穷举。
PW=\$(sudo head -1 /vol4/@appdata/10router/initial-password 2>/dev/null || true)
JAR=/tmp/10rf-smoke-\$TS.jar; rm -f "\$JAR"
d=""
if [ -n "\$PW" ] && printf '%s' "\$PW" | grep -qE '^[A-Za-z0-9+/=._-]+\$'; then
  lc=\$(curl -s -o /dev/null -w '%{http_code}' -c "\$JAR" -m 10 -H 'Content-Type: application/json' \
       -d "{\"password\":\"\$PW\"}" http://127.0.0.1:20127/api/auth/login)
  if [ "\$lc" = 200 ]; then
    d=\$(curl -s -o /dev/null -w '%{http_code}' -b "\$JAR" -m 15 http://127.0.0.1:20127/dashboard)
    [ "\$d" = 200 ] && echo "-- [NAS] dashboard=200(登录态 SSR 通过)"
  else
    d=\$(curl -s -o /dev/null -w '%{http_code}' -m 15 http://127.0.0.1:20127/dashboard)
    [ "\$d" = 307 ] && echo "-- [NAS] dashboard=307(口令已改,按未登录重定向判定通过)"
  fi
else
  d=\$(curl -s -o /dev/null -w '%{http_code}' -m 15 http://127.0.0.1:20127/dashboard)
  [ "\$d" = 307 ] && echo "-- [NAS] dashboard=307(未登录重定向,判定通过)"
fi
[ "\$d" = 200 ] || [ "\$d" = 307 ] || { echo "✗ [NAS] dashboard 异常:\$d"; false; }
rm -f "\$JAR"
m=\$(curl -s -m 10 http://127.0.0.1:20127/v1/models | head -c 60)
case "\$m" in '{"object"'*data*) ;; *) echo "✗ [NAS] /v1/models 异常: \$m"; false ;; esac
echo "-- [NAS] login=200 dashboard=\$d models=ok"
printf 'DEPLOY-DONE %s\\n' "\$TS"
EOF

echo
echo "✅ $VER 部署完成且验证通过。回滚备份保留在 NAS:$BASE/server.bak-$TS(跑稳几天后删,一份约 85MB)"
