<div align="center">
  <img src="./images/9router.png?1" alt="10Router" width="800"/>

  # 10Router

  [![GitHub stars](https://img.shields.io/github/stars/techysy/10router?style=flat&logo=github)](https://github.com/techysy/10router/stargazers)
  [![GitHub last commit](https://img.shields.io/github/last-commit/techysy/10router)](https://github.com/techysy/10router/commits)
  [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
  [![9Router upstream](https://img.shields.io/badge/9Router-v0.5.55-cyan.svg)](https://github.com/decolua/9router)
  [![npm](https://img.shields.io/npm/v/9router.svg?label=npm)](https://www.npmjs.com/package/9router)
  [![Docker](https://img.shields.io/badge/Docker-decolua%2F9router-blue?logo=docker)](https://hub.docker.com/r/decolua/9router)

  **基于 [decolua/9router](https://github.com/decolua/9router) v0.5.55 的本地优化快照**

</div>

---

## 简介

10Router 是 [9Router](https://github.com/decolua/9router) 的精简优化版本。在上游 v0.5.55 基础上合并了若干本地验证过的修复，排除未完成的实验性功能，保持干净的单一 commit 快照便于持续同步上游。

```
┌─────────────┐
│  Your CLI   │  Claude Code · Codex · Cursor · Cline · OpenCode ...
│   Tool      │
└──────┬──────┘
       │ http://localhost:20128/v1
       ↓
┌─────────────────────────────────────────┐
│            10Router (Smart Router)       │
│  • RTK Token Saver (cut tool_result)    │
│  • Format translation (OpenAI ↔ Claude) │
│  • Quota tracking                       │
│  • Auto fallback & token refresh        │
└──────────┬──────────────────────────────┘
           ↓
┌──────────────────────────────────────────┐
│     40+ Providers · 100+ Models          │
│  Free ──→ Cheap ──→ Subscription         │
└──────────────────────────────────────────┘
```

## 与上游的差异

| 修复 | 文件 | 说明 |
|------|------|------|
| **无连接不暴露内置模型** | `models/route.js` | DB 正常但无连接时，不 dump 全量 ~680 built-in catalog，避免淹没客户端 |
| **Claude 轮询加速** | `ProviderLimits/utils.js` | quota 轮询间隔 10min → 3min，配额变化感知更快 |
| **移除 groupByProviderStable** | `ProviderLimits/utils.js` | 恢复自然排序，不强制按 provider 聚合 |
| **MiMo Free topology 默认可见** | `mimo-free.js` | usage topology 上默认展示（可 toggle 隐藏），不再只有一个大 OpenCode 图标 |

### 已在上游的改动（不再重复）

- 货币本地化（¥/NT$/₩/₫）— 上游 v0.5.50+
- 配额包按 connection 独立 — 上游 v0.5.50+
- 拓扑 toggle — 上游 v0.5.50+
- Cloudflare 修复 — 上游 v0.5.50+

## 快速开始

```bash
git clone https://github.com/techysy/10router.git
cd 10router
cp .env.example .env
npm install
PORT=20128 npm run dev        # 开发模式 (port 20128)
```

生产部署：

```bash
npm run build
PORT=20128 HOSTNAME=0.0.0.0 npm run start
```

- Dashboard: `http://localhost:20128/dashboard`
- API endpoint: `http://localhost:20128/v1`
- 初始密码: `123456`（登录后请修改）

## 同步上游

单一 commit 快照设计，更新方式：

```bash
# 下载上游最新 tarball，覆盖文件
curl -L https://github.com/decolua/9router/archive/refs/heads/master.tar.gz \
  | tar xz --strip-components=1

# 提交
git add -A
git commit -m "chore: sync upstream v0.5.xx"
```

## 项目结构

```
10router/
├── src/                    # Next.js app + Dashboard
│   ├── app/                # 路由 + API
│   ├── lib/                # DB / Auth / Usage
│   └── shared/             # 组件 / 工具函数
├── open-sse/               # 路由/翻译引擎（可独立使用）
│   ├── executors/          # 每个 provider 的执行器
│   ├── translator/         # 格式翻译（OpenAI ↔ Claude）
│   └── providers/          # Provider 注册 + 配置
├── cli/                    # CLI launcher（npm: 9router）
├── tests/                  # 测试（vitest）
└── docs/                   # 架构文档
```

## 相关链接

- [上游项目 9Router](https://github.com/decolua/9router)
- [9Router 文档](https://9router.com)
- [9Router fnOS 应用包](https://github.com/techysy/9router-fnos)

## License

MIT — 与 [decolua/9router](https://github.com/decolua/9router) 一致
