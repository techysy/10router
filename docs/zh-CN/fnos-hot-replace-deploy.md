# fnOS/NAS 热替换部署：不重装 fpk 更新 10Router

> 适用：把新构建的 server 产物换到一台**已安装** 10Router 的 fnOS 上（如 31.101）。
> 与 `local-build-and-verify.md` 的分工：那篇 §3 的 fpk 通道验证的是**安装器本身**；
> 日常只更新代码用本文的**热替换**——换产物 → 重启，等价于 Windows 的 §2.2 就地替换。
> 首次来源：2026-09-12 把 31.101 从 1.1.0 热替换到 1.1.1-test.1（产物出自 31.31 构建机）。

## 0. 拓扑与资源

| 机器 | 角色 |
|---|---|
| `ssh nas`（192.168.31.101，yangyu，免密 sudo） | 目标机：fpk 应用在 `/vol4/@appcenter/10router/`（`server/` = 代码，数据在 `/vol4/@appdata/10router`），端口 **20127**，应用日志 `/var/log/apps/10router.log` |
| `ssh arch`（192.168.31.31，yangyu） | 构建机：repo `~/projects/10router`，组装目录 `~/projects/10router-fnos`（其 `app/server` = 补拷完外部目录的完整 standalone）；对 NAS 免密 ssh，可直传 |

服务生命周期管理一律走 `sudo /usr/local/bin/appcenter-cli {list,status,stop,start} 10router`
（root 专属二进制；`fnpack` 只有 build/create，管不了装包/启停）。

## 1. 产物从哪来

两条路，终点都是「补拷过外部目录的 standalone」：

1. **用现成的**：arch `~/projects/10router-fnos/app/server` 是上次组装留下的完整产物。
   先核对 `package.json` 的 version 和 `.next/BUILD_ID` 是不是你要的那次构建，别拿旧产物当新的。
2. **新构建**（repo 内 `npm run build`，postbuild 自动补 static/public/custom-server.js），
   然后手动补拷 **standalone 不包含**的外部目录——漏了运行时直接 module not found。
   清单以 `.github/workflows/build-fpk.yml` 的 COPY 步为准：

   ```bash
   cd <repo>/.next/standalone
   cp -r ../../open-sse .
   cp -r ../../src/mitm src/
   mkdir -p node_modules
   cp -r ../../node_modules/{node-forge,sql.js,next,better-sqlite3} node_modules/
   ```

## 2. 部署：预解包 → 原子交换 → 生命周期重启

```bash
# arch 上打包直传
cd ~/projects/10router-fnos/app/server
tar czf /tmp/10rf-server.tar.gz .
scp /tmp/10rf-server.tar.gz yangyu@192.168.31.101:/tmp/
```

NAS 上（sudo）分三段：

```bash
BASE=/vol4/@appcenter/10router

# ① 预解包（慢步骤，应用照跑；version/BUILD_ID 先验一遍再往下走）
sudo rm -rf $BASE/server.new && sudo mkdir -p $BASE/server.new
sudo tar xzf /tmp/10rf-server.tar.gz -C $BASE/server.new
sudo cp -a $BASE/server/.env $BASE/server.new/.env     # ★ 不保留 = JWT_SECRET/INITIAL_PASSWORD 全丢
sudo chown -R 10router:10router $BASE/server.new       # 服务用户是 10router，属主不对起不来
grep -o '"version": "[^"]*"' $BASE/server.new/package.json
cat $BASE/server.new/.next/BUILD_ID

# ② 原子交换（两个 rename，瞬间完成；运行中进程靠 fd 访问旧目录，不受影响）
sudo mv $BASE/server $BASE/server.bak_<旧版本>
sudo mv $BASE/server.new $BASE/server

# ③ 走 fnOS 生命周期重启（别手动 kill node，会脱离管理）
sudo /usr/local/bin/appcenter-cli stop 10router
sudo /usr/local/bin/appcenter-cli start 10router
```

**为什么这么排**：预解包/chown 都是慢步骤，放在应用还跑着时做；真正的交换只剩两个 rename。
`appcenter-cli stop` 之后 **~72 秒 fnOS 守护会自动把应用拉起**（TRIMEVENT 日志可查），stop 挡不住——
所以必须「先换完文件再重启」，反过来「先停再慢慢换」会撞上自动拉起读到半成品。

## 3. 验证闭环

```bash
curl -s http://127.0.0.1:20127/api/health                                  # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:20127/dashboard  # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:20127/login      # 200
curl -s http://127.0.0.1:20127/v1/models | head -c 200                     # 200 + 模型列表(本机免鉴权)
cat $BASE/server/.next/BUILD_ID                                            # 与构建机一致
```

再从局域网另一台机器打一遍 health/dashboard（排除网络层问题）；换完代码但行为没变时，
按 `local-build-and-verify.md` §4 的正/反向标记法在 `$BASE/server` 里 grep 字面量。
浏览器记得 **Ctrl+Shift+R 硬刷新**：chunk 哈希变了，旧缓存会让你看到旧 UI，极易误判「没更上」。

## 4. 回滚

```bash
sudo /usr/local/bin/appcenter-cli stop 10router
sudo rm -rf $BASE/server && sudo mv $BASE/server.bak_<旧版本> $BASE/server
sudo /usr/local/bin/appcenter-cli start 10router
```

新版本跑稳几天后删掉 `server.bak_*`（一份 ~286MB）。

## 5. 坑清单

| 现象 / 陷阱 | 原因与做法 |
|---|---|
| 改了源码 / scp 单文件不生效 | 运行时加载 `.next` 编译 chunk；必须整包重建+替换，别手改 chunk |
| 换完起来配置全丢 | 忘了保留 `server/.env`（JWT_SECRET / INITIAL_PASSWORD / 密钥类都在里面） |
| stop 之后应用自己又起来 | fnOS 守护 ~72s 自动拉起，属正常机制；靠 stop+start 加载新文件即可 |
| 起来后 module not found | standalone 缺外部目录，按 §1 补拷（open-sse / src/mitm / node-forge / sql.js / next / better-sqlite3） |
| 起来后读不了文件 | 没做 `chown -R 10router:10router` |
| 数据会不会丢 | 不会——数据在 `/vol4/@appdata/10router`，热替换只动 `@appcenter` 下的代码目录 |
| `appcenter-cli status` 看着像脱离管理 | 其输出格式和 `list` 不同；判状态用 `sudo appcenter-cli list` |
| 想看进程环境变量 | `/proc/<pid>/environ` 连 root 都读不了（fnOS ptrace 保护）；去看应用的配置文件 |
| **装上去的是旧代码**（marker 缺失/功能没出现） | **构建机 checkout 不自动跟 main**：只 fetch 没 pull 就构建=旧代码；增量 `.next` 还会让部分新字符串假命中。铁律：构建前 `git pull --ff-only` 并核对 HEAD==origin/main；服务端有变更 `rm -rf .next` 干净重建；marker 按 dashboard(`.next/server/`)/open-sse(源文件) 两处各验一个。详见 `test-report-nas-stale-checkout.md` |

## 6. 相关文件

| 路径 | 用途 |
|---|---|
| `docs/zh-CN/local-build-and-verify.md` | 测试版本号规则（`X.Y.Z-test.N`）、Windows 就地替换、fpk 全量安装通道、验证方法论 |
| `.github/workflows/build-fpk.yml` | standalone 需补拷的外部目录权威清单（§1） |
| `docs/zh-CN/test-report-INDEX.md` | 事故复盘总索引（含 NAS 场景报告，一篇一文件） |
| 31.31: `~/.hermes/skills/productivity/fnos-app-development/references/nextjs-standalone-hotfix-redeploy.md` | 本流程的原始出处（Hermes skill，含 10Router 诊断经验） |
| 31.31: `~/.hermes/skills/productivity/fnos-app-development/references/appcenter-auto-restart.md` | 72s 自动拉起的排查记录（TRIMEVENT） |
