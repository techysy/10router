# 10router-sync (ZCode 插件)

把本机 ZCode 的模型调用流水（`~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表）导出并导入 10Router 的用量统计，复用 10Router 的 `/api/settings/database/import-usage` 接口。

## 能力

- **幂等**：10Router 按行签名去重，重复运行不会产生重复数据
- **防双重计数**：自动排除 baseURL 指向 10Router 自身的 provider（那些调用已被 10Router 记账），只导出官方渠道（`builtin:bigmodel-*`、`builtin:zai-*` 等）
- **溯源**：导入后 provider 显示为 `zcode-<名称>`（如 `zcode-bigmodel-start-plan`），cost 记 0（订阅制渠道），agent/会话/时长等明细在 meta 里
- **鉴权**：虚拟 key（`sk-…`，推荐）或仪表盘密码，与 10Router v1.0.7+ 的导入鉴权匹配

## 安装

**方式一：ZCode 插件市场（推荐，npm/桌面/源码安装用户通用）**

ZCode → Settings → Plugin Management → Discover 页 → 点 `+` 添加市场，填 GitHub 仓库 `techysy/10router`（市场索引在仓库根 `marketplace.json`）→ 找到 **10router-sync** 点 Get 安装。

**方式二：从目录安装（本地开发）**

Plugins → 从目录安装，选择 `zcode-plugin/` 目录（含 `.zcode-plugin/plugin.json`）。或直接把目录拷贝到 ZCode 插件目录。

## 使用

- 斜杠命令：`/10router-sync:sync-usage`（可带参数，如 NAS 地址）
- 技能：对 ZCode 说「导出 ZCode 使用量到 10Router」即自动触发
- 直接跑脚本：

```bash
# 预览（不导入）
node scripts/export-usage.mjs --endpoint http://127.0.0.1:20127 --key sk-… --dry-run

# 导入（本机可直连 10Router 时）
node scripts/export-usage.mjs --endpoint http://127.0.0.1:20127 --key sk-…
```

### 离线模式（ZCode 与 10Router 不在同一网段）

本机无法直连 10Router 时，先导出 JSON（无需网络与凭据），把文件带到任何能连上
10Router 的机器再导入：

```bash
# ① ZCode 机器上导出
node scripts/export-usage.mjs --export zcode-usage.json

# ② 能连通 10Router 的机器上导入
node scripts/export-usage.mjs --import zcode-usage.json --endpoint http://<host>:<port> --key sk-…
```

导出的 JSON 也可以直接在 10Router 仪表盘导入（设置 → 数据库备份 → JSON 用量导入）。
幂等去重按行签名，导出后隔多久导入、重复导入都安全。

环境变量：`TENROUTER_ENDPOINT` / `TENROUTER_KEY` / `TENROUTER_PASSWORD`。

## 创建虚拟 key

10Router 仪表盘 → API Keys → 新建（如命名 `zcode-usage-sync`），把生成的 `sk-…` 传给脚本。key 可随时在仪表盘单独吊销，无需暴露仪表盘密码。
