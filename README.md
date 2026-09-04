<div align="center">

<img width="3818" height="1901" alt="image" src="https://github.com/user-attachments/assets/790507c7-68be-4111-a907-32ca6303f141" />

# 🚀 10Router

[![GitHub stars](https://img.shields.io/github/stars/techysy/10router?style=flat&logo=github)](https://github.com/techysy/10router/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/techysy/10router)](https://github.com/techysy/10router/commits)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![10Router](https://img.shields.io/badge/10Router-v1.0.6-orange.svg)](https://github.com/techysy/10router/releases)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io%2Ftechysy%2F10router-blue?logo=docker)](https://github.com/techysy/10router/pkgs/container/10router)

基于 [decolua/9router](https://github.com/decolua/9router) v0.5.55 的本地优化快照

**✨ 单一 commit 历史，无上游提交污染；上游新功能一律学习后自行重写。**

</div>

---

## 📖 简介

10Router 是 [9Router](https://github.com/decolua/9router) 的精简优化版本。在上游 v0.5.55 基础上合并了若干本地验证过的修复，排除未完成的实验性功能，保持干净的 git 历史便于持续同步上游。

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
│  • Regional currency display            │
└──────────┬──────────────────────────────┘
           ↓
┌──────────────────────────────────────────┐
│     85+ Providers · 1000+ Models         │
│  Free ──→ Cheap ──→ Subscription         │
└──────────────────────────────────────────┘
```

## 🧾 版本历程

| 版本 | 要点 |
|------|------|
| **v1.0.6** | CodeBuddy CN 每日自动签到（实验性）；Antigravity 配额对齐官网（5h + 每周双窗）与 Gemini 3.8 Flash 404 修复；OpenCode Free 免费目录对齐；Windows Web 安装器（211KB 在线拉取）；quota「只看有余额」实时重算；更新横幅 / Profile i18n 补齐；免费模型 429 友好中文提示 |
| **v1.0.5** | **桌面托盘版（Windows / macOS）** + CLI/桌面多语言；Agent 自助添加自定义供应商；CodeBuddy CN 账号 JSON 批量导入导出；新增 Agnes AI 双站 / APInex 供应商；上游 v0.5.65 供应商同步 + 新搜索供应商（Ollama Search / Xquik）；SSRF 三层防护；用量表 成本/Token 切换错乱修复 |
| **v1.0.4** | 新增 TokenBom / GoRouter / TaBiAI 供应商与 B.AI 扩展；社区供应商开关（DB 持久化）；CodeBuddy 修复；用量导入路径加固与鉴权补齐；Skills 界面多语言 |
| **v1.0.3** | 安全加固（npm 包敏感文件门禁、占位密钥拒用、登录限流、用量去重）；新增 LongCat / SenseNova / Dots / B.AI 供应商与官方图标；自定义供应商模型目录；fpk 更新直达 Releases；移除 qoder-cn；npm 包名变更为 `@techysy/10router` |
| **v1.0.2** | 修复更新检查误指第三方包、`--help` 命令名、postinstall 失败；新增测试 CI，统一 Node 24 |
| **v1.0.1** | 未作为完整版本发布（仅 npm 试水包 `10router-cli@1.0.1`），MITM 安全修复与 UI 改进实际随 v1.0.2 交付 |
| **v1.0.0** | 品牌重塑 9Router → 10Router（数据目录迁移至 `~/.10router/` 等一次性变更），沉淀本地修复与增强：配额轮询加速、按 connection 隔离、多币种显示、arm64 Docker 等 |

👉 各版本完整明细（每项修复的根因与验证方式）见 **[CHANGELOG.md](CHANGELOG.md)**；本地打包发版流程见 [cli/PACKAGING.md](cli/PACKAGING.md)。

## 🚀 快速开始

### 💻 npm 全局安装（桌面推荐）

```bash
npm i -g @techysy/10router
10router
```

装完后可执行命令是 `10router`，仪表盘默认在 `http://localhost:20128`。

> ⚠️ 包名是 **`@techysy/10router`**，不是 `10router` —— 后者是 npm 上一个与本项目无关的 fork。

> ℹ️ **npm 11+ 的 `allow-scripts` 提示**：新版本 npm 会拦截本包的 `postinstall` 脚本并警告
> `Run npm install -g --allow-scripts=@techysy/10router to allow these scripts once...`。
> **这是可选的，不影响使用**——该脚本只是把 SQLite 引擎「预暖」到 `~/.10router/runtime`，
> 跳过它首次启动时会自动补装。想消除提示：
>
> ```bash
> npm install -g --allow-scripts=@techysy/10router
> # 或永久允许：
> npm config set allow-scripts=@techysy/10router --location=user
> ```

### 🐳 Docker 部署

```bash
docker pull ghcr.io/techysy/10router:latest
docker run -d \
  --name 10router \
  -p 20128:20128 \
  -v ~/.10router:/app/data \
  ghcr.io/techysy/10router:latest
```

支持 `linux/amd64` 和 `linux/arm64`。

### 📦 fnOS fpk 安装

从 [Releases](https://github.com/techysy/10router/releases) 下载对应架构的 `.fpk` 文件：

| 文件 | 说明 |
|------|------|
| `10router-<版本>-x86.fpk` | x86 URL 版 |
| `10router-<版本>-iframe-x86.fpk` | x86 IFRAME 版 |
| `10router-<版本>-arm.fpk` | ARM URL 版 |
| `10router-<版本>-iframe-arm.fpk` | ARM IFRAME 版 |

安装：App Center → 手动安装 → 选择 fpk。

### 💻 Standalone Server

```bash
tar xzf 10router-server.tar.gz -C /opt/10router
cd /opt/10router
node custom-server.js --port 20128
```

### 🛠 源码开发

```bash
git clone https://github.com/techysy/10router.git
cd 10router
cp .env.example .env
npm install
PORT=20128 npm run dev        # 开发模式
```

生产部署：

```bash
npm run build
PORT=20128 HOSTNAME=0.0.0.0 npm run start
```

- Dashboard: `http://localhost:20128/dashboard`
- API endpoint: `http://localhost:20128/v1`
- 初始密码: `123456`（登录后请修改）

## 🔄 同步上游

上游新增功能时，**先学习、再自己写**：阅读上游对应实现理解思路，然后在本仓库用自己的代码和提交重写，移植后跑 `npx vitest run` + 三条 registry 基线确认无回归，并在 CHANGELOG.md 记录。

> ⚠️ 不要直接 merge / cherry-pick 上游分支，也不要用 tarball 覆盖文件 —— 那会把上游提交和未验证的代码带进这条干净的单提交历史（contributor 目录就是这么被污染的）。

上游 remote 仅用于阅读源码：

```bash
git remote add upstream https://github.com/decolua/9router.git
git fetch upstream
git show upstream/master:<path>    # 阅读某文件的上游实现
```

## 📁 项目结构

```
10router/
├── src/                    # Next.js app + Dashboard
│   ├── app/                # 路由 + API
│   ├── lib/                # DB / Auth / Usage
│   └── shared/             # 组件 / 工具函数
├── open-sse/               # 路由/翻译引擎（可独立使用）
│   ├── executors/          # 每个 provider 的执行器
│   ├── translator/         # 格式翻译（OpenAI ↔ Claude）
│   ├── providers/          # Provider 注册 + 配置
│   └── rtk/                # Token Saver 压缩引擎
├── cli/                    # CLI launcher（npm: @techysy/10router）
├── tests/                  # 测试（vitest）
├── docs/                   # 架构文档
└── .github/workflows/      # CI（Docker GHCR 构建）
```

## 🔗 相关链接

- [GitHub 仓库](https://github.com/techysy/10router) — 主仓库
- [Gitee 镜像](https://gitee.com/techysy/10router) — 国内镜像
- [📚 技术文档](https://github.com/techysy/10router/tree/main/docs) — 架构 + 工程专题（中英双语导航）
- [上游项目 9Router](https://github.com/decolua/9router)
- [9Router 文档](https://9router.com)
- [9Router fnOS 应用包](https://github.com/techysy/9router-fnos)

## 👥 交流群

**9+1 Router 飞书交流群** — 扫码加入：

![飞书交流群二维码](assets/feishu-qr.png)

## 👥 贡献者

- [techysy](https://github.com/techysy) — 主要维护者
- [shiyangyuda](https://github.com/shiyangyuda) — 代码优化
- [monkey2jack](https://github.com/monkey2jack) — arm64 Docker 支持

## 📄 License

MIT — 与 [decolua/9router](https://github.com/decolua/9router) 一致
