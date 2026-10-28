# GitHub 仓库 Contributors（幽灵贡献者）彻底清理指南

本文记录 10Router 仓库曾困扰数月的「侧边栏 Contributors 出现 200+ 外部幽灵贡献者」问题的**底层产生机制、排查方法与经实战验证的彻底清理方案**。

---

## 1. 现象与痛点

在 GitHub 仓库主页右侧边栏（Sidebar）的 **Contributors** 统计中，突然或长期显示大量未曾直接在主分支合并过的第三方贡献者（例如上游 9Router 历史上的 240+ 位开发者头像），而在：
- `git log main` 本地主分支历史中只有核心维护者；
- GitHub 官方 REST API `/repos/{owner}/{repo}/contributors` 中只有真实维护者；
- 远程删除相关上游 tags、分支后，**页面侧边栏仍然长期死锁在 246 人，几个月都无法自动清除**。

---

## 2. 根因剖析：为什么删了 tag/分支依然无效？

GitHub 的贡献者数据在架构上分属两套完全不同的底层机制：

### ① REST API (`/contributors`)
- **机制**：由 API 网关实时遍历当前默认分支（`main`）的 commit 树计算得出。
- **表现**：当主分支干净时，API 返回非常干净（如仅 2-3 人）。

### ② 页面右侧侧边栏（Sidebar Contributors Fragment）
- **机制**：由 GitHub 后端的事件驱动图谱服务维护。当包含上游历史的 tags（如 `v0.2.x ~ v0.5.x` 共 90 多个 tag）被 `git push --tags` 一次性推送到远端时，GitHub 会扫描这些 tags 所指向的所有 commit 对象并索引全部作者。
- **死锁原因**：
  1. **无自动 `git prune`**：在 GitHub 上执行 `git push origin --delete <tag>` 时，GitHub 仅删除了引用指针（ref），底层存储中的历史提交对象变成了游离对象（dangling commits），并没有被物理删除；
  2. **命名空间缓存锁定**：只要仓库的默认分支名一直叫 `main`，GitHub 的图谱服务绝不会丢弃关于 `main` 仓库命名空间的历史贡献者聚合缓存。因此，哪怕等上数月，侧边栏数字依然固执地保持在 246。

---

## 3. 彻底清理方案（默认分支重构法）

无需等待客服人工工单，通过强制触发 GitHub 底层对默认分支的重新全量索引，即可在 1~2 分钟内彻底治愈。

### 步骤 1：本地清理所有非当前项目的历史 tags
避免后续推送再次污染：
```bash
# 查看本地是否有 v0.* 等旧上游标签
git tag -l "v0.*"

# 本地批量删除这些旧标签
git tag -l "v0.*" | xargs -r git tag -d
```

### 步骤 2：远程删除所有误推的外部 tags
```bash
# 查询并删除远端所有残留的 v0.* 标签（过滤 ^{} 解引用）
git ls-remote --tags origin "v0.*" | awk '{print $2}' | grep -v '\^{}' | xargs -r git push origin --delete
```

### 步骤 3：核心步骤——默认分支切换重构（Branch Dance）
通过将默认分支从 `main` 临时切换到全新分支，迫使 GitHub 的图谱服务销毁旧分支的贡献者拓扑，并对新分支进行干净计算：

```bash
# 1. 从当前干净的 main 创建并推送一个同名临时分支（如 master）
git push origin main:refs/heads/master

# 2. 调用 GitHub CLI 将仓库默认分支切换为 master
gh api -X PATCH repos/{owner}/{repo} -f default_branch=master

# 3. 稍等 30 秒至 1 分钟，让 GitHub 后端完成异步重构任务
# 4. 将默认分支切回 main
gh api -X PATCH repos/{owner}/{repo} -f default_branch=main

# 5. 删除临时的 master 分支
git push origin --delete master
```

### 步骤 4：验证结果
刷新 GitHub 仓库主页，右侧边栏的 Contributors 会直接从 246 骤降为真实的贡献者名单（如 3 人），彻底恢复干净纯粹！

---

## 4. 预防准则（防止复发）

1. **绝对禁止无差别 `git push --tags`**：
   发版或推送标签时，必须且只能推送具体的单一版本号：
   ```bash
   # 错误做法（会将本地缓存的全部历史 tags 一股脑推上去）
   git push origin main --tags

   # 正确做法（精确推送当前发版 tag）
   git push origin v1.6.2
   ```
2. **定期检查本地与远程 tags 纯度**：
   10Router 的官方发布标签自 `v1.0.0` 起步，本地与远程不应存在任何 `v0.*` 遗留标签。
