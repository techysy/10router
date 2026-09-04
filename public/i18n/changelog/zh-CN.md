# 更新日志

这里展示面向用户的关键更新；完整开发明细见 [CHANGELOG.md](https://github.com/techysy/10router/blob/main/CHANGELOG.md)。

## v1.0.6 (2026-09-04)

### ✨ 新增
- **新增供应商 APInex（apinex.bond）**：预付美元额度的第三方聚合网关（OpenAI 兼容），18 个模型——GPT-5.6 Sol / Terra / Luna、Claude Opus 5 / Sonnet 5、Gemini 3.1 Pro / 3.8 Flash、Grok 4.6、DeepSeek V4、GLM-5.3、Kimi K3，外加 5 个 `free/` 前缀免费模型（GLM-5.3 Flash、DeepSeek V4 双档、GPT-5.6 Luna、Qwen 3.8 MAX）
- **邀请码一键复制**：供应商页「获取 API 密钥」旁显示邀请码 chip，点击即复制（APInex：`SLEWP68C`）
- **CodeBuddy CN 每日自动签到**（实验性，默认关）：`设置 → 实验性功能` 打开 "CodeBuddy CN auto daily check-in" 后，CodeBuddy CN 页面的 Import / Export 按钮被替换为每日自动签到（每个账号在本地时间 00:00–06:00 随机时刻自动签到续免费额度，失败不中断服务、401 自动刷新后重试）与「立即签到」手动按钮
- **Antigravity 配额对齐官网（5h + 每周双窗）**：用量页 Antigravity 配额重构为主用官网同款 retrieveUserQuotaSummary 接口，每账号精确显示 **4 张卡片**（Gemini Models / Claude and GPT models × {5 小时限额, 周限额}），归一化 100 百分制；接口不可用时回退旧逐模型解析

### 🐛 修复
- **Antigravity `ag/gemini-3.8-flash-*` 404**：模型寻址改为各档 tiered 实体并升级 IDE 指纹至 2.11.0（裸 ID 直传会 404「Requested entity was not found」）；新增无档位 `ag/gemini-3.8-flash`（路由到 medium 档）
- **用量统计 成本/Token 切换后表格错乱**：修复切换显示模式并点击排序后，部分行的 token 数被回退显示成金额的问题；繁体中文用量表表头翻译补齐
- **用量表排序语义**：按 Token / 成本列排序改为按模型合计值排序，与表头箭头方向一致

## v1.0.5 (2026-09-04)

### ✨ 新增
- **桌面托盘版（Windows / macOS）**：装完即用的桌面应用——系统托盘菜单（打开控制台 / 启动 / 重启 / 停止 / 开机自启）+ 内嵌窗口，关闭窗口即缩到托盘；与 npm CLI 共享数据、密钥与端口，两种形态互斥运行。Windows 提供安装版（NSIS，支持 `/S` 静默安装）与便携版，macOS 提供 Intel + Apple Silicon 双 dmg
- **CLI / 桌面版界面多语言**：npm CLI 与桌面托盘自动跟随系统语言显示简体中文、繁体中文或英文，可用环境变量 `TENROUTER_LANG`（`zh-CN` / `zh-TW` / `en`）强制指定
- **Agent 可自助添加自定义供应商 + Skills 页新增技能**：运行时用 dashboard LLM key 即可两步注册 baseUrl + 上游 key + 模型的自定义 OpenAI/Anthropic 兼容节点（免改源码/免重打包）；Dashboard **Skills 页**新增「10router-add-provider」技能卡片并修复此前链接指向不存在的 `master` 分支（点击 404），现指向 `main`
- **CodeBuddy CN 账号 JSON 批量导入 / 导出**（实验性，默认关）：`设置 → Providers` 打开 "CodeBuddy CN OAuth import / export" 后，CodeBuddy CN 详情页显示 Import / Export 按钮，可用三方(wb) JSON 格式批量导入或导出账号授权（导入自动去重、非 CodeBuddy 签发域跳过）。导入 / 导出均需二次输入 dashboard 密码确认（防免登录模式下匿名导出账号令牌）
- **公益站供应商默认显示**：GoRouter / TaBiAI 等公益站供应商改为默认显示（无需再手动打开开关），列表 / Profile 开关 / 用量拓扑图三处一致
- **公益站供应商排序归组**：Free Tier 列表中 GoRouter / TaBiAI 等公益站供应商在 rank 分组内聚成相邻一块，不再与普通 freeTier 按 priority/名字混排
- **新增 Agnes AI 双站供应商**：国际站 Agnes AI（com）+ 中国站 Agnes AI (CN)，各含 Agnes 2.5 Flash / 2.5 Pro 文本模型（512K / 1M 上下文，视觉+推理）；另含 Agnes Image 2.x Flash 图像生成模型（标准 images/generations 端点，图生图/编辑）
- **设置新增「实验性功能」分组**：Profile 独立 Experimental 卡片，收纳默认关的开发向开关（JSON 模型导入 + CodeBuddy CN 导入导出），方便后续扩展

## v1.0.4 (2026-09-01)

### ✨ 新增
- **新增 3 家供应商**：**TokenBom**（去中心化 token 交易市场——闲置 API Key 自动赚积分、积分可调用多种模型，含 79 模型在线目录）、**GoRouter**（免费网关，无充值入口）、**TaBiAI**（免费网关，无充值入口）
- **历史用量导入**：支持从 9Router 备份导入历史用量数据（SQLite 文件），合并统计不覆盖配置
- **通知体验优化**：全局通知改为顶部居中 Toast，供应商详情页浏览器原生弹窗全部替换为友好通知
- **公益站供应商**：GoRouter / TaBiAI 默认不显示，带「公益站」标签；可在 **设置 → Providers → 显示公益站供应商** 打开后显示

### 🐛 修复
- **供应商排序修正**：有连接的供应商前置、已禁用沉底，不再被优先级打乱
- **JSON 目录模型激活后不显示**：清理陈旧禁用记录，「激活了却不显示」问题解决
- **B.AI / CodeBuddy CN 模型补全**：切换模型报 "not found" 的缺模型已补齐
- **连接测试友好提示**：供应商端点维护中 / 被 Cloudflare 拦截时，显示维护提示而非误导性的 "Invalid API key"
- **账户筛选提醒**：配额包账户筛选持久化后，非默认筛选时显示琥珀色提醒条
- **CodeBuddy CN DeepSeek 模型 11150**：DeepSeek 系列调用不再因思考强度参数（auto/off）报 400，编码 agent（dsh 等）可正常使用
- **CodeBuddy 工具调用空工具名（11133 / unknown tool）**：流式返回的空 function.name 已规范化，标准客户端不再误判工具名
- **隐藏公益站后拓扑图仍显示**：用量页拓扑图同步「显示公益站供应商」开关，关闭后公益站不再显示
- **Skills 页面 i18n + 中文版链接**：Skills 页面文案支持多语言，中文界面下链接指向中文版 skill

## v1.0.3 (2026-08-30)

### ✨ 新增
- **新增 4 家供应商**：**LongCat**（美团）、**SenseNova**（商汤，免费公测）、**Dots**（小红书 Dots Studio，免费公测）、**B.AI**（聚合平台，一个 Key 通吃 GPT / Claude / Gemini / DeepSeek / GLM / Kimi / Qwen 等家族）
- **自定义供应商支持模型 JSON 目录**：自定义节点可拉取在线模型清单，逐个禁用 / 激活、批量管理
- **fpk 检查更新直达 Releases**：fnOS 安装的更新提示直达对应版本的下载附件

### 🔒 安全加固
- **登录接入渐进限流**：密码 5 次失败 → 30s / 2m / 10m / 30m 逐级锁定
- **拒绝占位 JWT 密钥**：照抄 `.env.example` 的公开密钥会被忽略，改用自动生成的随机密钥
- **修复 npm 包携带构建机敏感文件**：构建产物不再泄露密钥 / 机器 ID / 数据快照

### ⚠️ 升级注意
- npm 包名已改为 **`@techysy/10router`**（旧 `10router` 是本项目无关的 fork）。已装 `10router-cli` 请改装新包，数据目录不变。

## v1.0.2 (2026-08-29)

### 🐛 修复
- **修复更新检查指向第三方包**（1.0.1 受影响）：版本检查、更新命令、侧边栏安装命令均指向正确的包
- **postinstall 不再中断安装**：WSL 路径下 npm 安装不再因预热脚本失败而中断

### ⚙️ 工程与打包
- **新增测试 CI**：推送 / PR 时自动跑测试与回归门禁

> ⚠️ **1.0.1 用户请升级**：其内置「检查更新」指向的是一个无关的第三方包。

## v1.0.1 (未发布，内容随 v1.0.2 交付)

> 1.0.1 从未作为正式版发布（仅 npm 的 `10router-cli@1.0.1` 短暂存在过）。以下内容对 Docker / fpk / standalone 用户随 **v1.0.2** 首次到达。

### 🔒 安全加固
- **MITM 安全修复 ×4**：上游转发恢复 TLS 证书校验、根证书私钥权限收紧至 0600、不再盲目杀掉占用 443 的进程、自动清理异常退出遗留的 hosts 条目（MITM 默认关闭，未启用用户不受影响）

### ✨ 新增
- **已禁用供应商沉底**：设置页开关开启后，已禁用供应商在列表中排到最后
- **桌面侧边栏可折叠**
- **OpenCode Go 配额用量接入**
- **模型目录 Gitee 镜像回退**：国内拉取加速

### 🐛 修复
- **修复 /v1/models 返回孤儿自定义模型**：不再对客户端返回成百上千个无效模型
- **自定义节点前缀唯一性检测**：避免路由歧义
- **修复 CodeBuddy 执行器误删 Agent system prompt**

### ⚙️ 工程与打包
- **新增 npm 分发渠道**：`npm i -g 10router-cli`
- **新增「从 GitHub JSON 获取模型」通用能力**（Fetch Models）

## v1.0.0 (2026-08-26)

### ⚠️ 升级注意
1. **数据目录改名**：`~/.9router/` → `~/.10router/`（Windows: `%APPDATA%\10router`），启动时自动迁移
2. **SAML entityID 变更**：默认 issuer 改为 `urn:10router:sp`，IdP 需重新注册
3. **MITM CA 更名**：需重新信任新 CA

### ✨ 新增
- **品牌重塑**：9Router → 10Router
- **i18n 多区域货币**：en / pt-BR / pt-PT / es / de
- **多平台分发**：Docker（amd64 / arm64）、fnOS fpk（x86 / arm × url / iframe）、Standalone
