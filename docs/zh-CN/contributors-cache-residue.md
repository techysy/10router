# Contributors 页面残留上游贡献者 — 诊断与自愈

> 诊断日期：2026-09-05 · 状态：已自愈（缓存重建触发后恢复），无需任何历史重写
> 关联背景：v1.0.0 品牌重塑（fork detach + 单一历史 force-push）

## 症状

仓库首页侧边栏 Contributors 区块显示 **248 个贡献者**，名单以 `@decolua`（9router 作者）开头，包含 `@anuragg-saxenaa`、`@Jordannst`、`@toanalien` 等 9router 链条上的上游作者，以及 `@claude`、`@cursoragent` 两个 AI bot 身份。而 10Router 的 main 分支历史是重塑后的单一干净历史，理论上只应有维护者一人。

## 数据源排查（三个端点，三个答案）

GitHub 的 contributors 数据不止一份缓存，先分清来源再下结论：

| 数据源 | 返回 | 性质 |
|--------|------|------|
| `GET /repos/techysy/10router/contributors` | 仅 `techysy`（273） | **git 实时**：默认分支真实历史，两个提交邮箱（`techysy@gmail.com` / `i@shiyangyu.com`）正确归并到同一账号 |
| `GET /repos/techysy/10router/stats/contributors` | `claude 25` + `techysy 270` | **周统计缓存**：含 detach 前旧历史的残留 |
| 首页侧边栏 / `graphs/contributors` | **248 人（含上游）** | **fork 网络聚合缓存**：仓库还在 9router fork 网络内时算出的结果 |

关键验证：

```bash
# 仓库已脱离 fork 网络（fork:false，且不在 9router 的 forks 列表里）
gh api repos/techysy/10router --jq '.fork, .network_count'
gh api "repos/decolua/9router/forks?per_page=100" --jq '.[].full_name' | grep 10router   # 无结果

# 所有远端分支均不含上游提交（排除 stale 分支带旧历史的可能）
git ls-remote --heads origin
for b in main zcode fix/issue-4-stream-default; do
  git rev-list --count --author=decolua "origin/$b"   # 全部 = 0
done
```

## 根因

10Router 最初是 **9router 的 fork**。v1.0.0 品牌重塑做了两件事：force-push 单一干净历史（root commit `fd7a881c`，无 parent；其 message「Merge remote-tracking branch 'upstream/master'…」是重塑时残留的误导文案，并非真 merge），随后**从 fork 网络 detach**。

但 GitHub 的 Contributors 侧边栏/graphs 页聚合的是**整个 fork 网络**的贡献者，且这份缓存**不随 detach 立即失效**——248 人就是 detach 前算出的旧结果。`stats/contributors` 里的 `claude 25` 同理：reflog 中可见旧历史残留的 `Claude Code <nadimtuhin@gmail.com>` 身份（上游时代某贡献者的 Claude Code 会话提交）。

`@claude`、`@cursoragent` 是上游 9router 历史中**真实存在的 bot 提交者**，出现在上游聚合视图里属正常，不是数据错误。

## 处理：等缓存重建，不要动历史

- **访问 graphs 页会触发重建**（页面显示 "Crunching the latest data…"），重建完成后数据源切回本仓库默认分支真实历史——248 人、上游作者、bot 幽灵全部消失，只剩 `@techysy`。本次即此路径自愈。
- **push 事件同样触发重算**：合并 PR、日常提交都会让缓存刷新。
- 若长期（>2 周）仍卡旧数据：`git commit --allow-empty -m "chore: refresh contributors cache" && git push` 再触发一次。
- **不要**为 contributors 显示问题重写历史（force-push 只会制造新的缓存不一致）；**不要**联系 GitHub Support 修 contributors 数据——他们不提供该服务，缓存会自行重建。

## 结论与预防

- 本仓库历史本身是干净的：271 个非 merge 提交全部归属维护者，patch-id 重复检测仅 3 对（qoder-cn 分支 merge 时的正常重做）。
- fork detach 后 contributors 视图滞后是**预期行为**，看到旧网络的人名先查三个数据源再定性，别急着改历史。
- 验证命令模板见上，可复用于任何 fork 重塑后的归属核查。
