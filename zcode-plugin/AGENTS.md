# AGENTS.md — 10router-sync

把本机 AI 编码工具的用量账本导出并导入 [10Router](https://github.com/techysy/10router) 的用量统计。

**这只是一个 CLI 脚本**（`scripts/export-usage.mjs`），不依赖任何特定 agent 宿主。本目录下的
`commands/` 和 `skills/` 是给 ZCode 用的可选包装；其他 agent（Claude Code、Codex、Cursor 等）
直接按本文的命令调用脚本即可，行为完全一致。

## 什么时候用

用户要求「同步/导出/导入用量到 10Router」「把 X 的使用量记到 10Router 统计里」，或想知道
某工具的用量并希望它出现在 10Router 仪表盘时。

## 环境要求

- **Node.js ≥ 24（推荐，与仓库 `.nvmrc` 和 CI 一致）**。脚本用内置的 `node:sqlite` /
  `DatabaseSync`，无第三方依赖，无需 npm install。
  Node 22.x 上 `node:sqlite` 属于实验特性，需要额外加 `--experimental-sqlite` 标志才能
  导入，否则报 `ERR_MODULE_NOT_FOUND`——若必须在 22.x 上跑，用
  `node --experimental-sqlite scripts/export-usage.mjs …`。
- 一个可连通的 10Router 实例，或一个虚拟 key（`sk-…`）／仪表盘密码

## 数据源

用 `--source` 指定，**只支持这三个值，且不会自动检测**（默认 `zcode`）：

| `--source` | 读取位置 | 导入后 provider 前缀 |
|---|---|---|
| `zcode`（默认）| `~/.zcode/cli/db/db.sqlite`（`model_usage` 表），另扫旧布局 `~/.zcode/projects/*/db.sqlite` | `zcode-<渠道名>` |
| `opencode` | `~/.local/share/opencode/opencode.db`，Windows 回退 `%LOCALAPPDATA%\opencode\opencode.db` | `opencode-<providerID>` |
| `mirasim` | `~/.mirasim/insights/usage-YYYY-MM.ndjson` | `mirasim-<协议>` |

三个源互相独立，需要各自单独跑一次。ZCode 源会把扫到的多个库合并去重（按行 id 去重），
所以有多份 db 时不必手动挑。

## 固定套路

大多数情况照抄这四步即可（把 `<源>` 换成 `zcode` / `opencode` / `mirasim`，`<URL>` 换成
10Router 地址）：

```bash
# 1. 预览，确认有数据、provider 分组合理
node scripts/export-usage.mjs --source <源> --endpoint <URL> --key sk-… --dry-run

# 2. 正式导入
node scripts/export-usage.mjs --source <源> --endpoint <URL> --key sk-…

# 3. 想看全部来源就换 --source 各跑一次（互相独立）

# 4. 连不上 10Router 时改为两步：先 --export 出 JSON，再在能连的机器 --import
```

若用户已把 key/endpoint 配在环境变量 `TENROUTER_ENDPOINT` / `TENROUTER_KEY` 里，
命令行参数可全省。

## 用法

```bash
# 1) 先预览（只统计不导入）——每次都建议先跑
node scripts/export-usage.mjs --source <源> --endpoint <URL> --key sk-… --dry-run

# 2) 确认后导入
node scripts/export-usage.mjs --source <源> --endpoint <URL> --key sk-…
```

- `--endpoint` 默认 `http://127.0.0.1:20127`；10Router 在 NAS/局域网就填实际地址，如 `http://192.168.31.101:20127`
- 鉴权二选一：`--key sk-…`（虚拟 key，推荐，可在仪表盘单独吊销）或 `--password <仪表盘密码>`
- 环境变量等价写法：`TENROUTER_ENDPOINT` / `TENROUTER_KEY` / `TENROUTER_PASSWORD`
- 其他参数：`--limit N` 只取最新 N 条；`--quiet` 静默

### 离线模式（本机连不上 10Router）

```bash
# ① 在产生用量的机器上导出（不需要网络，也不需要凭据）
node scripts/export-usage.mjs --source <源> --export usage.json

# ② 在能连上 10Router 的机器上导入
node scripts/export-usage.mjs --import usage.json --endpoint <URL> --key sk-…
```

导出的 JSON 也能直接在 10Router 仪表盘导入（设置 → 数据库备份 → JSON 用量导入）。

**导出文件格式**（供跨机器搬运 / 自行生成时参考）：

```json
{ "source": "zcode-plugin", "exportedAt": "<ISO 时间>", "rowCount": 1513, "usageHistory": [ … ] }
```

`--import` 只取 `usageHistory`（或 `usage`）字段，其余字段仅作说明、不校验；
两者都不是数组则报 `error: file is not a usage export` 并以退出码 1 结束。

## 退出码

脚本化调用时可据此判断失败类型，决定是重试还是改参数：

| 退出码 | 含义 | 例子 |
|---|---|---|
| `0` | 成功（含 0 行的空跑，此时只打印 `nothing to export/import`）| |
| `1` | 数据/环境/远端问题：可重试或换目标 | 找不到账本文件、导入文件读不了、HTTP 非 2xx |
| `2` | 参数错误：必须改命令行，重试无用 | `--source` 值非法、`--export` 与 `--import` 同时给、缺少 `--key`/`--password` |

## 关键行为（改动脚本前必读）

- **幂等去重**：10Router 服务端按行签名去重（时间戳 + provider + model + connectionId +
  apiKey + prompt/completion tokens 七字段）。重复运行安全，输出里的
  `imported X, skipped Y` 中 `skipped` 就是撞上已有行的数量。
  注意服务端有**两条写入路径**，签名相同但关注点不同：
  代理实时写入走 `saveRequestUsage()`，其去重契参见
  [用量去重 usageKey 契约](../docs/zh-CN/usage-usageKey-contract.md)（含「同毫秒丢计数」的
  历史坑与 usageKey 修复）；本脚本走 `importUsageRows()` 分支——**该文档的同毫秒问题不适用
  于导入场景**，导入侧关心的是下面那条防双重计数。
- **防双重计数**：这是最容易踩的坑。
  - ZCode 源会排除 baseURL 指向 10Router 自身的 provider（那些调用 10Router 已记账）。
  - mirasim 源会排除 `upstreamHost` 指向 10Router 实例的行——**必须在导出侧排除**，
    因为两侧行签名不同，服务端去重拦不住，漏掉就会双倍统计。判断逻辑见
    `isSelfHostedUpstream()`：私网/loopback 地址 + 常见端口（20127/20128/80/443），
    或 host 与目标 endpoint 同机。
  - 新增数据源时同样要先想清楚「这些调用是否已被 10Router 自己记过」。
- **只读快照，绝不原地打开数据库**：ZCode/OpenCode 的 SQLite 是其他进程正在写的 WAL 库，
  脚本会把它（含 `-wal`/`-shm`）复制到临时目录再读（`snapshotDb()`）。改动时不要破坏这一点。
- **cost 一律记 0**：这些渠道是订阅/套餐制，不按量计费；若某源有真实计费数据再另议。
- **失败调用跳过**：mirasim 源会跳过无 token 计数的失败调用，避免污染统计（日志会
  打印 `skipped N rows without token counts`）。

## 排查

| 现象 | 原因与处理 |
|---|---|
| `HTTP 401 Invalid password` | key 已吊销或密码错；去仪表盘新建虚拟 key |
| `HTTP 401 Unauthorized` | 请求被全局守卫拦下，key/密码头没送到；检查 `--key`/`--password` 是否传了 |
| `connection refused` | endpoint 填错或 10Router 没在运行 |
| `no db.sqlite found` | 该工具在本机从没记录过用量 |

## 结果汇报

跑完把 `imported X, skipped Y` 原样报给用户，并说明数据出现在 10Router 仪表盘 Usage 区的
`zcode-*` / `opencode-*` / `mirasim-*` 分组下。

## 相关文档

**本插件**

- [README.md](./README.md) — 安装方式（插件市场 / 目录安装）、各数据源示例、虚拟 key 创建
- [commands/sync-usage.md](./commands/sync-usage.md) — ZCode 斜杠命令定义
- [skills/zcode-usage-sync/SKILL.md](./skills/zcode-usage-sync/SKILL.md) — ZCode 技能说明

**10Router 服务端（导入侧）**

- [用量去重 usageKey 契约](../docs/zh-CN/usage-usageKey-contract.md) — 服务端去重规则权威说明，
  含同毫秒丢计数的历史坑；新增数据源前值得一读
- [架构文档](../docs/zh-CN/ARCHITECTURE.md) — 10Router 整体架构与用量统计在其中的位置
- [SQLite 驱动链](../docs/zh-CN/sqlite-driver-chain.md) — 服务端 SQLite 驱动选择；
  本脚本用的是 Node 内置 `node:sqlite`，与该链路无关，但排查数据库问题时可作参照

**数据源侧**

- [mirasim 工具调用丢失排查](../docs/zh-CN/mirasim-dsh-toolcall-loss.md) — mirasim 上游行为记录
- [ZCode 套餐代理可行性](../docs/zh-CN/zcode-plan-proxy-feasibility.md) — ZCode 渠道与
  防双重计数策略的背景

**仓库级**

- [CHANGELOG.md](../CHANGELOG.md) — 搜 `10router-sync` 可看插件各版本变更
- [CLAUDE.md](../CLAUDE.md) — 仓库贡献约定（提交信息规范等）
