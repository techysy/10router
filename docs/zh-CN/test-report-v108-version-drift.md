# 测试报告：v1.0.8 双发版事故——四版本位漂移 + tag 推送事件被静默丢弃（2026-09-10）

> 发生面：正式发版（tag 触发的 4 条 CI 工作流 + 本地 Windows 产物）。核心结论：
> **发版面的"版本一致性"与"tag 触达"都没有天然保证，必须显式校验/显式单独推**。

## 1. 事故 A：四版本位漂移 → 构建出「10Router Setup 1.0.7.exe」

- 发版 commit `775c9474` 把版本 1.0.7→1.0.8 只同步了 **3/4 处**（root/cli/
  fnos-manifest），**`desktop/package.json` 漏了**——electron-builder 的版本号取自它。
- 本地全量构建产出 `10Router Setup 1.0.7.exe`（内容是 1.0.8），与 CI 产物
  同名不同载；v1.0.7 时代也发生过一次"四个安装器三个载荷"的同族事故。
- 修复：`1e16a748` 补齐 desktop 版本位；闸门固化：
  - `scripts/test-build-version.mjs` 四文件（root/cli/desktop/fnos manifest）**原子盖章
    + 安全回退**（revert 拒绝吃掉非版本行改动）；
  - `scripts/sync-manifest-version.mjs` 在 prebuild:fpk 强制 manifest ← root；
  - **四版本位 = root / cli / desktop / fnos-packaging/manifest，一个都不能少**。

## 2. 事故 B：tag 与 main 同一把推 → GitHub 静默丢 tag 事件

- tag `v1.0.8`（→`775c9474`）与后续 main 提交**同一把 push**：tag 创建仅早于 main
  落地 13 秒，GitHub **静默丢弃了 tag-push 事件**——4 条挂 `v*` 的工作流
  （desktop/fpk/server/docker）一条都没触发，**没有任何报错、没有邮件、没有 UI 提示**。
- 修复：tag force-move 到补齐版本位的 `1e16a748` 后**单独一次 push** → 4 条工作流
  全部触发并全绿。
- 闸门（已入 [[发版手册/记忆]]，此处留档）：**tag 永远单独推**；推完必查
  `gh run list` 是否出现 4 条 tag 触发的 run，出现才算发版开始。

## 3. 为什么常规验证没拦住

- 本地构建的文件名肉眼可查，但"CI 为什么没跑"——没有失败就没人看 run 列表；
  **静默丢弃是最坏的一类失败**：一切看起来"什么都没发生"，而"什么都没发生"
  正是问题本身。
- 版本位分散在 4 个文件里，人工同步在时间压力下必然出错一次——这种事只能
  工具化（盖章脚本），不能靠 checklist 自律。

## 4. 教训（浓缩版）

- **发版是分布式状态同步问题**：4 个版本位 + tag + release body + 产物附件，
  每一处都要么工具化、要么有显式校验步骤，不允许"记得改"。
- **push 后 60 秒内验证事件是否被消费**（CI run 列表）：推了 ≠ 触发了。
- 同版本号不同载荷是发版大忌（同名产物三种内容无法追溯）——本地测试构建
  一律走 `X.Y.Z-test.N` 盖章（`local-build-and-verify.md` §1），正式发版才允许
  裸版本号，且四版本位必须一次盖章同步。
