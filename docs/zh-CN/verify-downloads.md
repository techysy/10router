# 核对下载物（Release 资产校验）

> 适用范围：从 [Releases](https://github.com/techysy/10router/releases) 手动下载安装包 / fpk / server tar.gz 的人。
> 本文只讲**怎么核对**，以及**这层校验能挡什么、挡不了什么**。

## 1. 每个 Release 带哪些校验文件

发布由三个工作流并行产出资产，因此校验清单也**按组各一份**（不是一个共享的 `SHA256SUMS.txt`——并行写同一个文件名会互相覆盖）：

| 校验文件 | 覆盖的资产 | 产出工作流 |
|---|---|---|
| `SHA256SUMS-desktop.txt` | `10Router-Win-Setup-<ver>.exe`、`10Router-Win-Portable-<ver>.exe`、`10Router-Win-Web-Setup-<ver>.exe`、`*.nsis.7z` | `build-desktop-win.yml` |
| `SHA256SUMS-fpk.txt` | `10Router-FnOS-<ver>-{x86,arm}.fpk`、`10Router-FnOS-Window-<ver>-{x86,arm}.fpk` | `build-fpk.yml` |
| `SHA256SUMS-server.txt` | `10router-server.tar.gz` | `build-server.yml` |

> 资产命名自 v1.4.0 平台化（`软件名-平台-…`，同平台资产在 Release 页自动聚类排序）。
> **≤v1.3.5 的旧 release 用旧文件名**（`10Router Setup <ver>.exe` / `10router-<ver>-iframe-<arch>.fpk` 等），
> 且旧桌面清单里 Setup 条目是空格分隔、与点分隔的资产名有漂移——`sha256sum -c` 都能正常工作，
> 只是照着上文表格找文件时注意区分两代命名。

格式就是 `sha256sum` 的标准输出（`<hash>  <文件名>`，二进制模式带 `*` 标记），所以可以直接 `sha256sum -c`。

## 2. 怎么核对

```bash
# 进入下载目录（桌面包请放在同一目录）
sha256sum -c SHA256SUMS-desktop.txt      # macOS: shasum -a 256 -c SHA256SUMS-desktop.txt
sha256sum -c SHA256SUMS-fpk.txt
sha256sum -c SHA256SUMS-server.txt
```

逐行 `OK` 即一致；出现 `FAILED` 说明文件损坏或被替换，**不要安装**，重新下载或来 issue 反馈。

Windows PowerShell 等价写法：

```powershell
$expected = (Get-Content SHA256SUMS-desktop.txt | Where-Object { $_ -match '10Router-Win-Setup-' }) -replace '\s+\*?', ' '
# 简单办法：直接比对一个文件（旧 release 的文件名是 "10Router Setup 1.2.0.exe"，空格分隔）
(Get-FileHash "10Router-Win-Setup-1.4.0.exe" -Algorithm SHA256).Hash.ToLower()
```

## 3. ⚠️ 这层校验能挡什么、挡不了什么

**能挡**：下载过程中的传输损坏、镜像/缓存投毒、以及"文件被第三方替换成别的构建"——只要比对来源是你信任的那份清单。

**挡不了**：如果**清单本身**和资产一起被替换（同一个 Release 被改），比对就失去意义。清单是**发布者对构建产物的承诺**，不是独立第三方证明。

**与「应用内一键更新」的关系**：应用内更新走的是 **npm**，不下载这些资产，因此**不读这些清单**。那条通道的完整性由 registry 的 `dist.integrity`（npm 自己校验 tarball 的 sha512）覆盖，另外我们额外做了两件事（见 `src/lib/updater/updater.js`）：

1. **只装自己的包**：包名是构建自带的常量，环境变量改不动；
2. **装的是钉住的版本并回读校验**：目标版本由服务端解析后下发，装完用 `npm ls -g --json` 回读，和期望不一致就**明确失败**，不会报"成功但装成了别的版本"。

所以：**桌面/fpk/tar.gz 靠本文的清单**，**CLI 自更新靠上面的双重约束**。

## 4. 维护者视角（发版评审时）

- 三份清单由 CI 生成，不手工维护；发版后可在 Release 页直接核对资产与清单行数是否匹配（桌面 4 行 / fpk 4 行 / server 1 行）。
- 若出现**同名资产但内容不同**（历史上 1.0.8 出过：同一个版本号三份产物），比对两次下载的 hash 即可立刻判定——这正是加清单最直接的理由。
- 签名（Windows 代码签名 / SignPath）与清单是两件互补的事：签名证明"谁构建的"，清单证明"你拿到的就是那份"。**取消签名、重新打包之后必须重新生成清单**（本仓库的桌面工作流把清单生成放在打包之后，因此顺序天然正确）。
