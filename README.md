<div align="center">
  <img src="./images/9router.png?1" alt="10Router Dashboard" width="800"/>

  # 10Router

  **基于 [9Router](https://github.com/decolua/9router) v0.5.55 的本地优化分支**

  [![License](https://img.shields.io/github/license/techysy/10router)](LICENSE)

</div>

---

## 简介

10Router 是 [9Router](https://github.com/decolua/9router) 的精简优化版本。在上游 v0.5.55 基础上，合并了若干本地测试验证过的修复，排除了未完成的实验性功能，保持干净的单一 commit 快照便于持续同步上游。

## 与上游的差异

| 修复 | 说明 |
|------|------|
| `fix(models)` | DB 正常但无连接时，不再 dump 全量 built-in catalog（避免几百个不可用模型淹没客户端） |
| `fix(usage)` | Claude quota 轮询间隔从 10 分钟缩短至 3 分钟 |
| `fix(usage)` | 移除 `groupByProviderStable`，恢复自然排序 |
| `fix(providers)` | mimo-free 在 usage topology 上默认可见（可通过 toggle 隐藏） |

## 快速开始

```bash
git clone https://github.com/techysy/10router.git
cd 10router
cp .env.example .env
npm install
PORT=20128 npm run dev
```

生产部署：

```bash
npm run build
PORT=20128 HOSTNAME=0.0.0.0 npm run start
```

默认端口 `20128`，Dashboard 地址 `http://localhost:20128/dashboard`。

## 同步上游

```bash
# 下载上游最新 release
curl -L https://github.com/decolua/9router/archive/refs/heads/master.tar.gz | tar xz --strip-components=1

# 提交
git add -A
git commit -m "chore: sync upstream v0.5.xx"
```

## 相关链接

- [上游项目 9Router](https://github.com/decolua/9router)
- [9Router 文档](https://9router.com)

## License

[MIT](LICENSE)
