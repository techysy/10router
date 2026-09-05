# 10router-sync (ZCode 插件)

把本机 ZCode 的模型调用流水（`~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表）导出并导入 10Router 的用量统计，复用 10Router 的 `/api/settings/database/import-usage` 接口。

## 能力

- **幂等**：10Router 按行签名去重，重复运行不会产生重复数据
- **防双重计数**：自动排除 baseURL 指向 10Router 自身的 provider（那些调用已被 10Router 记账），只导出官方渠道（`builtin:bigmodel-*`、`builtin:zai-*` 等）
- **溯源**：导入后 provider 显示为 `zcode-<名称>`（如 `zcode-bigmodel-start-plan`），cost 记 0（订阅制渠道），agent/会话/时长等明细在 meta 里
- **鉴权**：虚拟 key（`sk-…`，推荐）或仪表盘密码，与 10Router v1.0.7+ 的导入鉴权匹配

## 安装（本地开发）

ZCode 客户端 → Plugins → 从目录安装，选择本目录（含 `.zcode-plugin/plugin.json`）。或直接把目录拷贝到 ZCode 插件目录。

## 使用

- 斜杠命令：`/10router-sync:sync-usage`（可带参数，如 NAS 地址）
- 技能：对 ZCode 说「导出 ZCode 使用量到 10Router」即自动触发
- 直接跑脚本：

```bash
# 预览（不导入）
node scripts/export-usage.mjs --endpoint http://127.0.0.1:20127 --key sk-… --dry-run

# 导入
node scripts/export-usage.mjs --endpoint http://127.0.0.1:20127 --key sk-…
```

环境变量：`TENROUTER_ENDPOINT` / `TENROUTER_KEY` / `TENROUTER_PASSWORD`。

## 创建虚拟 key

10Router 仪表盘 → API Keys → 新建（如命名 `zcode-usage-sync`），把生成的 `sk-…` 传给脚本。key 可随时在仪表盘单独吊销，无需暴露仪表盘密码。
