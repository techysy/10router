# 测试报告：NAS 热替换装出旧代码（arch 漏 pull + 增量 .next 假命中）（2026-09-12）

> 发生面：fnOS/NAS 热替换（构建机 arch 31.31 → NAS 101）。手册：
> `docs/zh-CN/fnos-hot-replace-deploy.md`。核心结论：**构建机的 checkout 不会自己
> 跟 main；只 fetch 不 pull 等于拿旧代码构建，而增量构建缓存会伪造"更新成功"**。

## 1. 时间线与现象

- 09-12 下午做 NAS 热替换 1.1.1-test.2 → test.15（用户要求装最新）。
- arch 构建机流程：`git fetch` → **没 pull** → 盖号 1.1.1-test.15 → `npm run build`
  （**增量**，未清 `.next`）→ 组装 → tar 直传 → NAS 预解包/原子交换/appcenter-cli 重启。
- 验证闭环：version 1.1.1-test.15 ✓、health ✓、dashboard 200 ✓、
  `codeBuddyDailyDone`（当天下午的新字符串）在 `.next/server/chunks` **命中** ✓。
- 事后核对 registry 文件时发现 `workbuddy.cn/app` / `codebuddy.ai/agents` **grep 不中**
  ——对照 arch 仓库：HEAD 停在早上的 `af0711ab`（test.2 构建态），
  **`git log origin/main -1` 明明是 `bc29c7c2`**。当日下午 7 个提交全部缺席。

## 2. 根因（两个叠加）

1. **构建机 checkout 不自动跟 main**：`git fetch` 只更新 remote ref，工作区还停在
   旧 commit。盖号/构建/部署全部照常成功——没有任何一步会替你发现 HEAD 落后。
2. **增量 `.next` 假命中**：`.next/server/chunks` 里混着旧构建的产物，新字符串
   （`codeBuddyDailyDone` 来自当天早些时候的提交，恰好在 fetch 边界**之前**）恰好能
   grep 到，制造"新代码已进产物"的假象。**一个 marker 命中什么也证明不了。**

## 3. 为什么常规验证没拦住

- version/BUILD_ID/health 只证明"装的是你构建的那个包"，不证明"包构建自最新代码"；
- 正向 marker 只对了 dashboard 侧一处，且选中的字符串恰好在旧 HEAD 里也存在；
- feature marker 的另一半（registry 侧字符串）在 `server/open-sse/` 源文件里，
  第一轮只查了 `.next` 目录。

## 4. 修复与闸门（已入 `fnos-hot-replace-deploy.md` §5 铁律）

1. **构建前 `git pull --ff-only origin main` 并核对 `git log -1` == `origin/main -1`**；
2. **服务端代码有变更时 `rm -rf .next` 干净重建**——增量缓存引入的变量远大于省下的
   90 秒；
3. **验证 marker 按字面量的宿主分两处**：dashboard/服务端字符串 grep
   `$BASE/server/.next/server/`，registry（open-sse）字符串 grep `$BASE/server/open-sse/`
   源文件；grep 不中先怀疑路径再怀疑代码，命中先怀疑新旧交叠再宣布成功。
- 本例重部署：干净重建后 BUILD_ID `d8PywpLF8VCDIFG1C7JS0`，两侧 marker 全中才收工。

## 5. 教训（浓缩版）

- 部署链的每一步（盖号/构建/替换/重启）都是"成功等于做了"，没有一步是
  "成功等于做对了"——**对齐性检查（HEAD==origin/main、BUILD_ID 双侧一致）必须显式做**。
- 缓存让"部分新 + 部分旧"成为可能；**验证要么全量重建后做，要么 marker 覆盖到
  fetch 边界两侧**。
- grep 命中是必要条件不是充分条件：先问"这个字符串在旧 HEAD 里存在吗"。
