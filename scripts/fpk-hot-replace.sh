#!/usr/bin/env bash
# fpk hot-replace deploy with health gate + auto-rollback. Run ON the NAS:
#   scp scripts/fpk-hot-replace.sh nas:/tmp/
#   ssh nas 'sudo bash /tmp/fpk-hot-replace.sh /tmp/10rf-server.tar.gz'
# (optional 2nd arg: health-poll tries, default 45 => 90s)
#
# Re-run of the 2026-11-05/07 incidents: stop alone never comes back up
# (stop+start MUST share one session), and a payload that never turns healthy
# must be rolled back automatically, not left dead for the operator.
set -u
TARBALL="${1:?usage: fpk-hot-replace.sh <server.tar.gz> [health-tries]}"
TRIES="${2:-45}"
APP="10router"; PORT="20127"; BASE="/vol4/@appcenter/10router"

[ -f "$TARBALL" ] || { echo "GATE-FAIL: tarball not found: $TARBALL"; exit 1; }

echo "[1/5] pre-unpack (app keeps running)"
rm -rf "$BASE/server.new" && mkdir -p "$BASE/server.new"
tar xzf "$TARBALL" -C "$BASE/server.new" || { echo "GATE-FAIL: unpack error"; rm -rf "$BASE/server.new"; exit 1; }
chown -R 10router:10router "$BASE/server.new"

NEWVER=$(grep -o '"version": "[^"]*"' "$BASE/server.new/package.json" | head -1 | sed 's/.*: "//;s/"//')
NEWBUILD=$(cat "$BASE/server.new/.next/BUILD_ID" 2>/dev/null || echo MISSING)
OLDVER=$(grep -o '"version": "[^"]*"' "$BASE/server/package.json" 2>/dev/null | head -1 | sed 's/.*: "//;s/"//')
echo "  old=$OLDVER  new=$NEWVER  build=$NEWBUILD"

echo "[2/5] payload gates (post-unpack, same checks as fpk-deploy-gate.mjs)"
ABS_LINKS=$(find "$BASE/server.new" -type l -printf '%p -> %l\n' | grep -E ' -> /' | head -3)
if [ -n "$ABS_LINKS" ]; then
  echo "GATE-FAIL: absolute symlinks in payload (dangling on this host):"; echo "$ABS_LINKS"
  rm -rf "$BASE/server.new"; exit 1
fi
NMFILES=$(find "$BASE/server.new/node_modules" -type f 2>/dev/null | wc -l)
if [ "${NMFILES:-0}" -lt 200 ]; then
  echo "GATE-FAIL: node_modules has $NMFILES real files — symlinked-node_modules payload?"
  rm -rf "$BASE/server.new"; exit 1
fi
echo "  ok   node_modules real files=$NMFILES, no absolute symlinks"

BAK="$BASE/server.bak_$(date +%Y%m%d-%H%M%S)"
rollback() {
  echo "[5/5] ROLLING BACK to $OLDVER ($BAK)"
  /usr/local/bin/appcenter-cli stop "$APP" >/dev/null 2>&1
  rm -rf "$BASE/server"
  mv "$BAK" "$BASE/server"
  /usr/local/bin/appcenter-cli start "$APP" >/dev/null 2>&1
  for i in $(seq 1 30); do health && { echo "ROLLBACK-OK: $OLDVER healthy again"; exit 2; }; sleep 2; done
  echo "ROLLBACK-UNHEALTHY — needs manual attention"
  exit 3
}

echo "[3/5] atomic swap + lifecycle restart (stop can take ~72s)"
mv "$BASE/server" "$BAK"
mv "$BASE/server.new" "$BASE/server"
/usr/local/bin/appcenter-cli stop "$APP" >/dev/null 2>&1
/usr/local/bin/appcenter-cli start "$APP" >/dev/null 2>&1

health() { curl -sf -m 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"ok":true'; }

echo "[4/5] health poll ($TRIES x 2s)"
OK=""
for i in $(seq 1 "$TRIES"); do health && { OK=1; break; }; sleep 2; done
[ -z "$OK" ] && rollback

for p in /login /dashboard; do
  code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://127.0.0.1:$PORT$p")
  case "$code" in 2*|3*) echo "  ok   $p -> $code";; *) echo "  FAIL $p -> $code"; rollback;; esac
done
echo "DEPLOY-OK $NEWVER build=$NEWBUILD (backup kept: $BAK)"
