# 变更日志

> 面向用户的精简更新见 [`public/i18n/changelog/`](https://github.com/techysy/10router/tree/main/public/i18n/changelog)（`en.md` / `zh-CN.md` / `zh-TW.md`，仪表盘「Change Log」按界面语言加载对应文件）。本文件为完整开发日志，按版本从上往下排列。

## v1.0.8 (2026-09-09)

### ✨ 新增功能

- **新增 AMD Token Factory 供应商（免费档，与 NVIDIA NIM 同形态）**：AMD Radeon Cloud 的免费共享 OpenAI 兼容端点（`developer.amd.com.cn/radeon/api/v1`，Bearer `rc-…` key 在 Token Factory 页自动签发），上线两个实验模型——`DeepSeek-V4-Flash`（1M 原生上下文，默认不思考，reasoning_effort 六档全收）与 `Qwen3.8-Flash-Next`（262K 上下文，默认思考且不可关，仅收 low/medium，high→400、其余→422）；registry/capabilities/thinkingLevels 三处按上游文档逐项对齐（纯文本、tool calling 支持但无并行、json_object 可用 json_schema 不可、原生 thinking 字段 400 须走 reasoning_effort），DefaultExecutor 直接承接无需专属 executor；免费额度：每 key 30 RPM / 每账户 20 RPM / 并发 8。providers/alias 两份基线快照刻意重建（差异仅 `+amd`），OAuth 基线不变，全量回归零新增失败。
- **CodeBuddy 静态模型目录刷新（CN + 国际版）**：CN 站补入服务端已上架的 GPT-5.6 Sol/Terra/Luna、GPT-5.5、GPT-5.4、GPT-5.3-Codex、Gemini-3.5-Flash 七个模型；国际版（codebuddy.ai）按服务端目录重排——新增 Hy4-Preview / Hy3（走免费额度）、GPT-5.6 三档、GPT-5.5、GPT-5.4、GPT-5.3-Codex、Gemini-3.5-Flash、GLM-5.3、Kimi-K3，移除已下线的 GLM-5.1/5.0、GLM-5v-Turbo、MiniMax-M3、Kimi-K2.7/K2.5，并为国际版每个模型标注 `rateMultiplier` 积分倍率（0 = 免费额度）；配套 `tests/unit/codebuddy-intl-models.test.js` 断言由子集匹配改为全量精确列表。

### 🔒 安全加固

- **API key 生成与 HMAC secret 硬化**（本地审查清单落地，向后兼容）：① `generateKeyId()` 由 `Math.random()` 改 `crypto.randomBytes`——keyId 是密钥材料，不能出自可预测源（新旧格式互通，存量 key 不受影响）；② `API_KEY_SECRET` 硬编码兜底不再静默使用——未设置时启动告警提示；新增**实验功能 Key secret rotation（默认关闭）**：环境变量 `API_KEY_ROTATION=true` 或仪表盘「API Keys → Key secret rotation」开关均可开启，开启后与 `JWT_SECRET` 同契约，自动生成随机 secret 落盘 `$DATA_DIR/api-key-secret`（mode 0600）——因 CRC secret 变化会使存量 API key 失效需重新签发，故**绝不静默迁移**：开关两向切换均弹确认框（明示旧 key 失效不可恢复），开启后仪表盘提供 **Rotate all 一键重签**（逐 key 换发新串、旧 key 停用，弹窗一次性展示全部新 key 供复制）；`API_KEY_SECRET` 环境变量始终优先于实验开关；③ `.env.example` 补两个变量的契约说明，`REQUIRE_API_KEY=false` 死示例删除并注明该变量**运行时不读**（真开关是仪表盘设置 DB 的 `requireApiKey` 行，默认 true），消除部署误导。配套临时验证：生成→解析→CRC 校验闭环、篡改 CRC 必拒、20000 次抽取无 keyId 碰撞、三态解析（默认兜底 / env 优先 / rotation 落盘）与关闭时兜底行为同旧版逐字节一致（验证用例跑完即删，不入库）。
- **登录 500 不再回传内部错误详情**：`/api/auth/login` 的 catch 分支此前把 `error.message` 原样回给客户端（泄漏服务器内部信息），改为服务端 `console.error` 记录、客户端回通用文案。
- **仪表盘危险操作确认弹窗**：Endpoint 页「Require API key」关闭前弹确认（提醒端点将无鉴权裸奔，可随时重开）；secret rotation 开/关两向均弹不可逆警告（明示哪些 key 会失效、需更新所有客户端）。

### 🐛 修复

- **MCP SSE 长连接补注释心跳（issue #9 追加反馈）**：`/api/mcp/[plugin]/sse` 此前无心跳，MCP 会话在工具调用间隙长时间空闲，公网/NAT 部署下会被中间设备会话超时静默掐断（客户端表现为连接仍在但收不到任何事件）；对齐 `/api/usage/stream` 的既有模式补 25 秒一次 `: ping` SSE 注释行（客户端无感），cancel 时清理定时器。其余 SSE 路由均为请求期间持续有事件的短生命周期流，无需心跳。
- **非流式请求（省略 stream 字段）被误判为流式，返回畸形 SSE 响应（issue #4）**：`chatCore.js` 此前 `body.stream !== false` 使省略 `stream` 的请求默认走流式（返回 `text/event-stream` + JSON 尾随 `data: [DONE]`，严格 JSON 解析的客户端全部失败），与 OpenAI/Anthropic 规范（缺省=非流式）相反；Accept 兜底只认显式 `application/json`，SDK/curl 默认的 `*/*` 打不中。改为规范语义的 opt-in 流式：显式 `stream:true`、强制流式源格式（antigravity/gemini/gemini-cli）、或纯 `Accept: text/event-stream`（不含 application/json——两者并列是 OpenAI/Vercel AI SDK 的非流式签名，按 JSON）才流式；forceStream 供应商上游照旧流式、客户端未请求时聚合回 JSON（原 455 行分支，行为不变）。同类实现对照：CLIProxyAPI 仅显式 `stream:true` 流式，OmniRoute `resolveStreamFlag` 对 openai/claude 源格式同为缺省非流式（其 #302/#656/#5305 演化史与本修复同路径）。新增 `tests/unit/stream-default.test.js` 7 例（缺省/`*/*`/显式真假/纯 SSE opt-in/AI SDK 混合签名/显式 false 压过 SSE Accept），全量回归 39 失败全在 41 已知基线内零新增。
- **Antigravity 配额与 CLIProxyAPI/官网数字对不上（用户反馈）**：两处根因一并对齐——① **配额 summary 查错 host**：聊天流量走 `daily-cloudcode-pa`，配额 RPC 却固定查 prod `cloudcode-pa`，两个环境的计数器相互独立，仪表盘数字系统性滞后于账号实际消耗（实测 Gemini weekly 显示 90%、CLIProxyAPI 同时刻为 71%）；`quotaSummaryApiUrl` 改为 `quotaSummaryApiUrls` 列表，按 daily → daily sandbox → prod 依次尝试（2xx 且解析出 `groups[]` 才算命中，防无关信封误判；缓存/并发去重按 URL 分键），与原生 IDE 客户端及 CLIProxyAPI 管理中心同一顺序，某台 host 拒答自动落到下一台，全部不可用仍回退 `fetchAvailableModels` 逐模型解析；② **前端百分比失真**：`ProviderLimitCard` 的 `remainingPercentage` 三元表达式两个分支同值（都在前端从 used/total 重算），后端上报的真实百分比从未生效——改为直接取用；summary RPC 本就只报剩余比例（fraction），合成的 `x / 100` 刻度行不再当请求数展示（`percentScale` 标记贯通 google.js → parseQuotaData → QuotaTable/QuotaProgressBar，计数留空只显示剩余百分比与倒计时）。测试：新增 `antigravity-quota-summary-hosts.test.js` 覆盖 host 回退三场景（daily 命中即停 / daily 拒答逐级回落 prod / 全挂走兜底），既有 headers/weekly-quota/gemini-3.x 断言同步更新，8 套件 35 例全绿。
- **拉取/导入的模型目录默认禁用（用户按需启用）**：对齐静态目录 `a7db4496` 的默认姿态——`Import from /models`（OpenAI/Anthropic 兼容节点）与「Fetch Qoder Models」批量拉取时改为写入 `customModels` 的 `enabled=false`，拉回来的模型先落「Disabled models」区，用户按需激活，避免一次导入上百个模型刷屏。同时把该默认姿态补全成闭环：① `/v1/models` 有连接分支补上 `customModels.enabled===false` 过滤（此前只在零连接分支生效，标了禁用仍会被下发）；② 仪表盘回显与恢复——非兼容节点把禁用的自定义模型并入「Disabled models」区（可单个恢复，`Active All`/`Disable All` 同步覆盖自定义模型），兼容节点（`CompatibleModelsSection`）新增 Disabled 分组与行内激活/禁用开关。Web fetch 单点「Add」（手动添加、suggested 建议芯片）仍保持启用——点击本身即「按需」，只有批量导入才默认禁用。新增 `tests/unit/models-empty-connections.test.js` 三例（零连接 / 有连接 / 孤儿自定义）覆盖三条 `enabled===false` 门控路径，全量回归零新增失败。

### 🧹 清理

- **移除已下线的 JSON 模型目录残留**：`686b1217`（v1.0.8）已删除 `modelsJsonUrl` 在线目录机制（`/json-models` 路由 + `providerJsonModelsRepo` + 全局开关 + 仪表盘 UI），本次清掉遗留物——空目录 `src/app/api/providers/[id]/json-models/`、9 个 `providers/*.json` 目录文件及空的 `providers/` 目录、bai/tokenbom/commandcode/longcat/opencode-go 注册表顶部仍写有 "Fetch Models"/`modelsJsonUrl` 的过时注释（改为指向现存机制），以及 `docs/zh-CN/json-model-catalog-mechanism.md` 与其在 `docs/README.md`、`docs/zh-CN/ARCHITECTURE.md` 的索引（文档描述的路由与存储已不存在，`docs/en` 下本就没有该文件——README 的 en 链接原已是死链）。

## v1.0.7 (2026-09-07)

### ✨ 新增功能

- **ZCode 本地用量同步到 10Router（插件 + 导入链路）**：新目录 `zcode-plugin/`（10router-sync@inline）——skill + slash 命令 + manifest，读 ZCode 本地 model_usage 账本（`~/.zcode/cli/db/db.sqlite`，**WAL 活库不原地打开**：先拷贝临时文件快照再读）转 usageHistory 经 `/api/settings/database/import-usage` 导入；自动排除 baseURL 指向 10router 自身的 provider 防双重计数（20127/20128/`/v1` + 本机 host 双条件），`provider_id|logical_request_id` 指纹幂等可重跑；鉴权三通道（登录态免密 / `x-9r-password` 与导出一致 / `Bearer sk-` 虚拟 key 专供插件），仪表盘导入 401 自动回落密码弹窗（登录态无感）；详情 tab 展示导入行——importUsageRows 打 `meta.imported` 标记（去重命中回填，存量重跑即迁移），`getRequestDetails` 合成 imported 行与 requestDetails 按时间戳归并分页（归并分页数学已证明正确：全局 top-K ⊆ 两源局部 top-K 并集），`/api/usage/providers` 下拉联合 usageHistory 导入来源；配套单测 6+4 例。已装本机 ZCode 端到端验证。
- **托盘图标单色化（mac template + win 主题黑白）**：`make_icon.py` 新增 mono 资产（方框描边 + 粗体 10，alpha 即图形）；CLI mac systray2 用 `icon-template.png` + `isTemplateIcon` 随菜单栏深浅自适应（旧彩色版 alpha 是整块填充，开 template 会成实心块，故 darwin 专用）；CLI win 按 `AppsUseLightTheme` 注册表选黑白 ico；桌面壳 darwin `setTemplateImage(16+@2x)` + win `nativeTheme` 跟随切换；三处托盘面缺资产回落彩色品牌图标。
- **桌面托盘版更新链路适配 + 菜单精简**：① sidecar 启动注入 `INSTALL_CHANNEL=desktop`，`/api/version` 对该渠道返回 GitHub Releases 链接（与 fpk 同机制），仪表盘更新横幅对桌面版显示「从 Releases 获取安装包」而非错误的 `npm i -g` 命令/一键更新（桌面版更新 npm 包碰不到内嵌 cli/app，updater 重启也会拉起 CLI 而非 Electron 壳）；② 托盘菜单「启动服务/停止服务」合一为按状态显示的单动作项（菜单 11 项 → 更短），新增「检查更新」（走本地 `/api/version`，发现新版本弹框引导打开 Releases）与「关于 10Router」（版本/数据目录/GitHub 链接）；③ 服务启动成功后静默自动检查一次，仅发现新版本时弹托盘气泡引导（无更新/失败不打扰）。三语词条齐（en/zh-CN/zh-TW）。增量更新（blockmap 差量下载）评估：electron-builder 已产 `.blockmap`，但 electron-updater 差量更新要求应用代码签名（当前构建无证书、signing skipped），留待有签名证书后接入。
- **CodeBuddy CN 内置「总积分」配额聚合行**：用量页 CodeBuddy CN 卡片第一行新增 Total Points（总积分/總積分，i18n 词条化）——汇总全部包的实时余额（月包取 Cycle 字段、赠送包取生命周期 Capacity 字段，与逐包行同口径），置于每月行之前免用户自行加总；`resetAt` 置空（聚合无单一周期，不渲染误导性倒计时）；used/total 直读使其与「只看有余额」筛选天然联动（总余额耗尽自动隐藏、有余额常显）；精确串求和防浮点漂移（0.1+0.2 显示 0.3）。顺带补齐 `Bonus Pack N` 行的 i18n（精确匹配打不中带序号的名字，显示层拆「基础名 + 序号」翻译，赠送包 N/贈送包 N，隐藏 chips 同步接上）。
- **上游 9router v0.5.69 择优移植·第一批**（`2adcd9c4`，按「重实现不合并」惯例）：① **antigravity/gemini-cli 多账号后台刷新防风控**——OAuth 后台刷新由 `Promise.allSettled` 并行改为串行 + 分级抖动（Google 系 12s、常规 1.5s，`BG_REFRESH_GOOGLE_DELAY_MS`/`BG_REFRESH_DELAY_MS` 可调），onboard 重试 5×2s → 2×12s+抖动（`ONBOARD_MAX_ATTEMPTS`/`ONBOARD_RETRY_DELAY_MS`），多账号用户不再触发 Google 反滥用风控；② **anthropic-compatible-* 前置真 Claude 补发 beta flag**——自定义节点挂真 Claude 时补 `context-management-2025-06-27` 等头，修 `context_management: Extra inputs are not permitted` 400 静默换模型（按模型 id 门控，前置 Kimi/GLM 的节点不受扰）；③ **opencode-go 稳定 session**——新专属 executor 维护 `x-opencode-session`（原生头优先 → 按「会话+客户端工具」确定性翻译），免费池不再因每请求随机会话触发风控；④ **Responses 并行工具调用修复**——`output_item.added` 即分配 index 并按 item_id 路由 delta，修全 added-后-delta 乱序把 N 个并行调用并进 index 0（客户端 InputValidationError），call_id 同毫秒回退加进程级序列防碰撞；⑤ **Claude Fable 周配额追踪**（`seven_day_fable`/`fable` 归一 + 仅周窗口时回填展示行，仪表盘 claude 配额固定排序）；⑥ **codex 新模型**——gpt-6-astra（vision/thinking/search，272k）四表齐上 + GPT-5.6 Sol/Terra/Luna image 变体；⑦ **codebuddy-cn 目录对齐服务端契约**——删 glm-5.0-turbo/minimax-m2.7/kimi-k2.5/hy3-preview/hy3-x/hy4-preview-x/deepseek-v3-2-volc 七个不再发布的模型（保留 kimi-k3 / deepseek-v4-flash-vision-exp 本地增量），能力表按服务端 product-config 重校（glm-5.3/5.3-flash/5.2/deepseek thinkingCanDisable=true、kimi-k3-1 1M 窗口），thinkingLevels 补 per-model effort sets，与 docs/zh-CN/codebuddy-cn-error-codes.md 错误码速查配套；⑧ glm/glm-cn 补 glm-5-turbo；⑨ profile 页按 hostname 动态显示 Local/Remote Mode；⑩ 后台刷新日志降噪。
- **上游 v0.5.69 择优移植·第二批**（`00c8e002`）：① **qoder 目录刷新 + 图片透传**——模型清单对齐服务端（新增 lite/Qwen3.8-Max/Qwen3.8-Flash/GLM-5.3/GLM-5.3-Flash，删 qmodel_preview/gm51model），capabilities 补 qoder 全表（真实模型家族窗口/输出上限；thinkingCanDisable 全 false——客户端 thinking 意图被上游丢弃），executor 图片透传（OpenAI `image_url` 与 Claude image 均转 OpenAI 形态，base64 直传免 OSS 预上传），chat_record_id 纳入数组内容哈希（同 prompt 不同图不撞缓存）；② **仪表盘 antigravity 配额按家族分组**——gemini-*/claude-* 归并单行（取最耗尽成员为代表），image 等保持独立，hide/show 级联 + hidden 陈旧 key 读侧修剪；保留我们优于上游的**按连接隔离**（上游按 provider 共享会跨账号串扰），多账号互不影响；③ **copilot 弃 MITM 改 VS Code 扩展指南**——CLI 工具页 copilot 从 MITM 拦截改为三步扩展配置指引（`9Router for Github Copilot` 扩展 + Server URL/API Key + Copilot Chat 选模型），MITM 引擎层保留可手动配置随时回退。

### 🐛 修复

- **mac 中文用户看到英文界面（语言检测脱节）**：mac Terminal 的 `LANG` 常年是 `en_US/C` 与系统语言脱节（GUI 启动的进程甚至没有 LANG），CLI 检测链插入 darwin 分支 `defaults read -g AppleLocale`（2s 超时静默失败），桌面壳改用 `app.getPreferredSystemLanguages()`；`TENROUTER_LANG`/`LC_ALL` 优先级不变，`LANG` 降为 mac 兜底后一级。
- **Next16 dev 非 localhost 回环打开仪表盘不水合**：浏览器经 `127.0.0.1` 打开时 `/_next` 静态资源的 Origin 不在默认 localhost 白名单内全部 403（Next16 dev-only 防护）——`allowedDevOrigins` 补 `127.0.0.1`；生产/桌面构建不受影响。
- **`/responses` 根路径重写鉴权缺口（安全）**：dashboardGuard 的 `PUBLIC_PREFIXES` 此前不含 `/responses`，而中间件先于 Next.js rewrites 执行——根路径请求落在 guard「未知路径放行」分支后经重写直达 `/api/v1/responses` 公开 LLM handler，**远端无需 API key** 即可调用；补入前缀表后该路径与 `/v1/*` 同样强制 API key 校验（对齐上游 98579f98）。
- **Claude 组合回落产生的外来 `server_tool_use` 毒化历史（400）**：组合回落到自带内置工具的供应商（如 z.ai/glm 的 `call_` id analyze_image）后，历史里残留非 `srvtoolu_` 前缀的 server_tool_use 块，后续每个 Claude 回合整请求被 Anthropic 400 拒绝——passthrough 归一化现按 `^srvtoolu_[A-Za-z0-9_]+$` 校验并丢弃外来块，连带清理其 tool_result 半边（悬空 tool_result 同样 400），顺带清空文本块与清空消息（Anthropic 拒绝空 text 块）。
- **MCP 延迟工具破坏缓存锚点（400）**：Anthropic 拒绝同时携带 `defer_loading:true` 与 `cache_control` 的工具（MCP 客户端把延迟工具放尾部恰是锚点落点）——缓存锚点改为锚在最后一个**可缓存**工具上（`anchorClaudeCache` 与 `prepareClaudeRequest` 两处），不再整体丢缓存。
- **gemini schema 元组校验 400**：`prefixItems`/`additionalItems`（元组关键词）此前被静默剥离，`type:"array"` 缺 `items` 被 Gemini 以 "missing field" 拒绝——先转换 `prefixItems` → `items`（单变体直取/多变体 anyOf）再剥离残留，数组缺 items 补宽松占位。
- **antigravity 系统提示竞争品牌清洗泛化（防误判 429）**：Zed 的 Claude 提示词此前只剥一句，OpenCode 命名仍会触发后端 429 Quota Exhausted——改为规则表（Claude Agent SDK 句剥除 + `opencode` 大小写变体改写为 antigravity）。
- **免费模型后台刷新噪音与连接测试悬挂**：① 后台刷新 tick 高频 debug/info 日志降噪；② 连接测试加 15s 超时防挂起耗尽连接池，供应商搜索对空名守卫（对齐上游 df85e16d）。

### ⚙️ 工程与打包

- **Windows 桌面产物 CI 化 + SignPath Foundation 签名链路**（`4e8ee7fb`）：tag 触发构建 Setup / Portable / Web-Setup + 7z，SignPath 配置就绪（repo variable + secrets）时走外部签名、未配置自动降级未签名上传，产物自动附 Release——为免费开源代码签名铺路；desktop CI 补装 cli 依赖（esbuild 供 MITM 打包）。

### 📄 文档

- **CodeBuddy-CN 上游错误码速查**（`78ffd238`，社区贡献）：中英双语对照 11101/11128/11133/11150/11151 与 429/401/402 的成因与出路，登记进 docs README。

## v1.0.6 (2026-09-05)

> v1.0.5（2026-09-03，含最后一次 tag 移动并入的 APInex / 用量表修复 / 上游 v0.5.65 同步）之后的新增功能版：CodeBuddy CN 每日自动签到、Antigravity Gemini 3.8 Flash 修复 + 配额对齐官网（5h+每周）、OpenCode Free 免费目录对齐、Windows Web 安装器、quota「只看有余额」实时重算、更新横幅与 Profile i18n 补齐。

### ✨ 新增功能

- **CodeBuddy CN 每日自动签到**（实验性，默认关）：Profile → 实验性功能 打开 **CodeBuddy CN auto daily check-in** 后，cbcn 详情页的 Import / Export 按钮被替换为**每日自动签到**（每账号本地时间 00:00–06:00 随机时刻自动调用 CodeBuddy 每日签到接口续免费额度，失败放行不崩服务；401 自动刷新一次 token 后重试）与一个**立即签到**手动按钮（汇总 toast；服务端日志 `CB_CN_CHECKIN` 按账号输出「账号名： 状态」）。该开关与 CodeBuddy OAuth import / export 两个实验开关独立、详情页展示互斥。实现：后端调度器 `src/sse/services/codebuddyCheckin.js`（boot 即安全补签 + 次日随机槽定时器，unref、幂等启动，每次触发重读开关），`POST /api/oauth/codebuddy-cn/checkin` 手动签到接口（仅返回状态、不返回任何 token），新设置键 `codeBuddyCheckin`（默认 false，经 GET/PATCH /api/settings 持久化）。
- **Antigravity 配额对齐官网 Model Quota UI（5h + 每周双窗）**：用量页 Antigravity 配额重构为以 `v1internal:retrieveUserQuotaSummary` 为主数据源 —— 每账号精确 **4 张卡片**（2 个模型族 "Gemini Models" / "Claude and GPT models" × {5 小时限额, 周限额}），各含剩余比例与重置时间，与 antigravity.google 管理页一致；归一化基准改为 100 百分制（原 1000 假次数）。解析兼容显式 `window` 字段与从 bucketId/displayName 文本推断两种形态、兼容顶层与 `remaining.remainingFraction` 嵌套两种字段层级。该接口不可用时优雅回退原 `fetchAvailableModels` 逐模型解析（不再混排 17 假模型）。
- **OpenCode Free 目录对齐官方「限时免费」名单**：补入 Big Pickle（隐身模型）/ MiMo-V2.5 / Ling 3.0 Flash Fin / Nemotron 3 Ultra / Nemotron 3.5 Lightning 五个免费模型（registry + capabilities）；**刻意不收**上游列表残留的 `deepseek-v4-flash-free` / `laguna-s-2.1-free`（官方文档免费名单已无此二者，避免误用产生收费调用）。
- **桌面 Windows 双产物**：新增 nsis-web Web 安装器（约 211KB，在线拉取完整包）+ 完整版保留；`appPackageUrl` 用 GitHub `releases/latest/download`；CI 上传 server tar.gz 时不再硬编码 release `name`/`body`（防止重复 run 覆盖手工维护的发布说明）。

### 🐛 修复

- **Antigravity `ag/gemini-3.8-flash-*` 404「Requested entity was not found」（用户反馈）**：三处根因一并对齐 9router `70f15aa`——① registry 3.8 三档改为**各自的 tiered 实体**（`gemini-3.8-flash-high(high)` / `medium(medium)` / `low(low)`，裸 ID 直传会 404），并新增无档位 `gemini-3.8-flash`（路由到 medium 档）；② **IDE 指纹 2.1.1 → 2.11.0**（`providers/shared.js` 与 MITM 覆盖层 `src/mitm/antigravityIdeVersion.js` 两处统一，上游按 client 版本门控模型下发，旧指纹拿不到 3.8 实体）；③ MITM `MODEL_SYNONYMS` 补 `gemini-3.8-flash → medium` 归一化、capabilities 补 `*gemini-3.8*` pattern（vision/audio/video/reasoning/search、thinkingLevel、1M ctx）、quota discovery 切到 daily host（与原生 IDE 一致）。providers 基线同步重建。
- **用量页「只看有余额」拉不到新配额包（用户反馈）**：CodeBuddy CN 每日签到会新增满额（0/100）Bonus Pack，且旧包过期后后续包会**挤占前面的序号**（pack 名复用）。原「只看有余额」只把耗尽行**加进**持久化隐藏集合、从不移除后来恢复余额的行 → 新满额包顶到曾隐藏的 pack 名上就永远显示不出，得「显示全部」再重筛才回来。修复：抽出 `computeDepletedHiddenKeys`，每次筛选**实时从当前快照重算** hidden —— 只隐藏「当前确实 used≥total / 0-0」的行，任何有余额的行（含新满额包）自动移出隐藏，序号再挤也能看到新包。
- **更新横幅 / Profile 设置页 i18n 补齐**：侧栏「有新版可用」横幅、更新弹窗与 ManualUpdatePanel 全套文案（复制安装命令 / 倒计时 / 关闭指引）由英文硬编码改为接 translate；更新确认弹窗与服务器断开层的按钮文字补全。设置页 Providers / Experimental / Language / Security / Network / Observability / SSO 各卡**标题与描述**接 translate（此前字典有词条但代码漏接），补 `Regional currency` / `Single Sign-On (SSO)` 等缺失词条；弹窗「取消」按钮加 `whitespace-nowrap` 修复折行成两行。
- **免费模型 429 限流友好提示**：`oc/*-free`、`contributor-free`、APInex `free/` 前缀等免费模型被上游限流返回 429 时，不再透传上游英文 `rate_limit_exceeded`，改为返回友好中文提示——上游给了 Retry-After/重置时间则显示「约 N 秒/分/小时后可再试」，否则建议稍后再试或切换付费档；付费模型与多账号 fallback 路径完全不受影响。实现：新工具 `open-sse/utils/freeModel.js`（`isFreeModel` 保守正则识别免费档 + `formatFreeRateLimitMessage` 中文文案），在 `chatCore` 429 错误出口仅对免费模型覆盖 message。配套单测 `tests/unit/free-model.test.js`。

## v1.0.5 (2026-09-03)

> v1.0.4 发布后的功能版：新增 Electron 桌面托盘版（Win + macOS）与 npm CLI 系统语言检测（en/zh-CN/zh-TW）。本版 tag 经多次移动，最后一次覆盖并入 APInex 供应商、用量表修复与上游 v0.5.65 同步（见下方「09-03 并入」节），发布日期以首次发布的 09-03 为准。

### ✨ 新增功能
- **Antigravity 支持 Gemini 3.8 Flash 系列**（社区实测反馈）：Google 于 2026-09-02 在 Antigravity（agy）生态上线 Gemini 3.8 Flash（内部代号 Skimaki），`ag/gemini-3.8-flash-high` / `ag/gemini-3.8-flash-medium` / `ag/gemini-3.8-flash-low` 三档注册进 antigravity 供应商，计费对齐 3.7 Flash 档位（$1.50/M in、$7.50/M out），用量配额白名单与 CLI 种子模型同步补全。⚠️ 本版的上游寻址（裸 ID 直传）实测不可用，**v1.0.6 已修正**为 tiered 实体 + IDE 指纹 2.11.0，详见下版更新日志。
- **Kimi 官方渠道下线 kimi-k2.5 系列**：Moonshot 于 2026-08-31 正式下线 `kimi-k2.5` 与 `moonshot-v1` 系列（`moonshot-v1` 此前从未注册，无影响）。官方 `kimi` 供应商移除 `kimi-k2.5` / `kimi-k2.5-thinking` 两档（上游已 404，保留只会让请求失败）；第三方聚合网关（CodeBuddy、阿里百炼、B.AI、Cursor、Ollama、Cloudflare 等）各自的 `kimi-k2.5` 行**保留**——那些是网关侧自有托管副本，不受 Moonshot 平台下线影响，capabilities/pricing 条目相应加注释说明归属。

- **npm CLI 系统语言检测（i18n）**：CLI 此前整体英文硬编码，现随系统语言自动显示中文（简/繁）或英文，`TENROUTER_LANG` 环境变量可强制覆盖，检测优先级 `TENROUTER_LANG` → `LC_ALL`/`LANG` → ICU 系统 locale（Windows 取系统显示语言）→ 回退英文。覆盖启动器全流程（`--help`、接口选择菜单、托盘模式横幅、更新提示、崩溃重启）、系统托盘菜单（Windows PowerShell NotifyIcon 管道两端已有显式 UTF-8，中文标签安全传输）、供应商/组合/API Keys/设置/CLI 工具五大管理菜单与终端 TUI，共 358 条文案 × en/zh-CN/zh-TW 三语；术语与仪表盘 `public/i18n/literals` 对齐（仪表盘/供应商/组合等）。实现为 `cli/src/cli/i18n/` 零依赖轻量方案：按源文件分片的 JSON 字典（`locales/<lang>/*.json`）+ `t(key, params)` 查找，缺失键回退 en 再回退键名；`xai video` 子命令、hooks 诊断信息与 apiKeys 盒线 legacy 展示函数暂保持英文。

### ⚙️ 工程与打包

- **新增桌面托盘版（Electron，Win + macOS）**：参考 inspection-visualizer 的「Electron 壳 + sidecar」模式新增 `desktop/` 目录，把 10Router 封装成「装完即用、托盘管理」的桌面应用——托盘菜单（打开控制台/启动/重启/停止/开机自启/数据目录/退出）+ 内嵌 BrowserWindow（关闭即缩到托盘）+ 单实例锁 + 免鉴权 `/api/health` 健康轮询（1.2s，90s 超时）。要点：
  - **sidecar 复用 Electron 二进制**：`ELECTRON_RUN_AS_NODE=1` 以纯 Node 运行 `cli/app/custom-server.js`（Next standalone 产物，平台无关），不内嵌独立 Node 运行时；服务自拉起的子进程（更新器/MITM）继承该环境变量，ABI 一致；
  - **SQLite 驱动**：Electron 37（内置 Node 22）下服务驱动链命中 `node:sqlite`（实测日志确认），`sql.js` 捆绑兜底；
  - **与 npm CLI 形态互斥共享**：数据目录沿用 `%APPDATA%\10router` / `~/.10router`，同一端口 20128 健康预检，端口被占且健康时进入 external 模式只开窗口不重复拉起服务；
  - **壳日志隔离**：`app.setName('10router-desktop')` 必须先于一切 `getPath('userData')`——productName「10Router」在 Windows 大小写不敏感文件系统上会与服务数据目录 `10router` 撞名，壳日志会混进服务数据；
  - **打包流水线**：`desktop/build.ps1`（Win，NSIS 安装包 + 便携 exe，electron/electron-builder 二进制走 npmmirror）与 `desktop/build.sh`（mac，x64 + arm64 两个 dmg，须在 mac 上执行）；图标由 `make_icon.py` 生成，与 CLI 托盘同品牌（橙色圆角 + 白色「10」）。

### ✨ 新增（09-03 并入）

- **CodeBuddy CN 账号 JSON 批量导入 / 导出**（实验性，默认关）：`设置 → Providers → 打开 "CodeBuddy CN OAuth import / export"` 后，cbcn 详情页显示 **Import / Export** 按钮——用三方账号切换工具的 (wb) JSON 格式**批量导入**（选文件或粘贴）或**导出**（下载 `codebuddy-cn-accounts-<date>.json`）OAuth 授权。导入按 token 的 Keycloak `sub`（uid）或昵称去重（已存在则更新、否则新建），仅接受 `codebuddy.cn` / `copilot.tencent.com` 签发域（`workbuddy.cn` 等其它 realm 自动跳过）。实现：`GET/POST /api/oauth/codebuddy-cn/export` 与 `bulk-import`。
- **Agent 可自助添加自定义 OpenAI/Anthropic 兼容供应商**（运行时操作，免改源码/免重打包）：`POST /api/provider-nodes` + `POST /api/providers` 根路径可用 dashboard LLM API key 认证，两步把一个 baseUrl + 上游 key + 模型注册成可路由节点（模型须带 `{prefix}/` 前缀路由）；`GET/PUT/DELETE` 及子路由仍走 CLI token/JWT。随附 agent 操作指南 `docs/zh-CN/agent-add-custom-provider.md` 与开源 skill `skills/10router-add-provider/`。
- **公益站供应商默认改为显示**：GoRouter / TaBiAI 等公益站（`community`）供应商从「默认隐藏、需手动打开开关」改为**默认显示**（未显式关闭即显示）——供应商列表、Profile 的「显示公益站供应商」开关、用量页拓扑图三处统一为 `!== false` 语义，不再默认藏起来。
- **公益站供应商排序归组**：Free Tier 列表中 GoRouter / TaBiAI 等公益站（`community`）供应商在 rank 分组内聚成相邻的一块，不再与普通 freeTier 供应商按 priority/名字混排（rank 连接优先语义不变，公益站块排在同 rank 普通供应商之后）。
- **新增 Agnes AI 双站供应商**（标准 API Key 分区）：**Agnes AI**（`agnes-ai`，国际站）`https://apihub.agnes-ai.com/v1` + **Agnes AI (CN)**（`agnes-ai-cn`，中国站）`https://api.agnes-ai.cn/v1`，OpenAI 兼容、Bearer 鉴权。各登记 **Agnes 2.5 Flash**（512K 上下文，视觉+推理）与 **Agnes 2.5 Pro**（1M 上下文，视觉+推理）两个文本模型（实测 `/v1/models` 确认模型 ID；`agnes-2.0-flash` / `2.5-pro-alpha` 上游已废弃未登记）。能力按官方文档登记 contextWindow/vision/reasoning，两站共用品牌图标。国际站另含 **Agnes Image 2.0/2.1/2.5 Flash**、中国站含 **Image 2.1/2.5 Flash** 图像生成模型（走标准 `POST /v1/images/generations`，图生图/编辑能力，同 key 复用）。
- **设置页新增「实验性功能」分组**：Profile 设置新增独立的 **Experimental**（实验性功能）卡片，收纳开发者向/默认关闭的开关，方便后续扩展——从 Providers 卡迁入 **Fetch models from GitHub JSON**（JSON 模型目录导入）与 **CodeBuddy CN OAuth import / export**（cbcn 账号导入导出）。Providers 卡保留排序偏好与公益站显示开关。
- **新供应商 APInex（apinex.bond）**：第三方预付 USD 中转网关，OpenAI 兼容（`https://api.apinex.bond/v1`，Bearer 认证）。18 个模型（13 付费 + 5 个 `free/` 前缀免费模型，含 GLM-5.3 Flash、DeepSeek V4、GPT-5.6 Luna、Qwen 3.8 MAX），模型 ID 为 `vendor/model` 斜杠形式原样透传，capabilities 按完整 ID 挂 provider 专属表（contextWindow 取自上游目录）。类别 `apikey`、`hasFree`（非公益站，不设 community 标志）。免费模型已用真实 key 实测可用（付费模型 $0 余额返回 402 `billing_error`，Anthropic 系不参与赠送额度）。新增 `notice.inviteCode` 通用字段：供应商详情页两处 + ProviderInfoCard 的 Get API Key 旁渲染可复制邀请码 chip（`InviteCodeChip`，复用 `useCopyToClipboard`），APInex 填 `SLEWP68C`。基线（providers/alias）与 golden 快照已重建。
- **上游 v0.5.65 供应商/模型数据同步**：新增 GLM-5.3-Flash(Vision) / GLM-4.6V / DeepSeek-V4-Flash-Vision-Exp / Grok-4.6 / Claude-Fable-5.1 等模型与 Muse-Spark Responses 直连路由；CodeBuddy CN 目录刷新（新增 hy3 / hy4-x / kimi-k3-1，删除 EOL 的 glm-5.0 / 4.7）；`kimi-k2.5` 不随上游回加（维持 EOL 2026-08-31 决定）。
- **新搜索供应商 Ollama-Search 与 Xquik**：Ollama-Search 复用 Ollama 本地 key 直连搜索；Xquik（X/推特搜索）独立接入。搜索处理器支持凭据回退（`credentialFallback`）与搜索锁按 `websearch:*` 作用域隔离，避免跨 provider 串锁。

### 🔒 安全加固（09-03 并入）

- **CodeBuddy CN 账号导出/导入加密码二次验证**：审查发现 `requireLogin=false`（免登录本地单机模式）下 `/api/oauth/codebuddy-cn/export` 可**匿名导出全部 CodeBuddy token**（严重泄漏）——现导出与批量导入接口均要求 dashboard 密码（`x-9r-password` header），带 `x-9r-cli-token` 的 CLI 请求豁免；前端点 Export/Import 先弹密码确认框。无密码直接调用返回 401。补丁覆盖 cbcn 详情页的空连接态与有连接态两处入口。
- **fetchPublic 安全加固（SSRF）**：`fetchPublic` 增加三层防护 —— ① 域名先解析为 IP 后校验是否回环/私网/保留段（防 DNS rebinding 首跳打到内网）；② 连接建立后再按实际响应 IP 复验一次；③ 重定向跟随时对每个跳转目标重新做 IP 校验，杜绝被 302 带到内网探测。配套 `tests/unit/ssrf-guard-hardening.test.js`。

### 🐛 Bug 修复（09-03 并入）

- **Dashboard Skills 页链接指向不存在的 `master` 分支**：此前 `skills/*` 链接与 "View on GitHub" 均指向 `master`（仓库实际为 `main`），点击 404；统一改走 `main`。页面同时新增展示 **10router-add-provider** 技能卡片（可从 Skills 页复制粘贴给任意 AI agent 使用）。
- **长 TTFT（time-to-first-token）下客户端假断连（ResponseAborted 循环）**：超大上下文上游（如 CodeBuddy 的 DeepSeek/GLM 在 100K+ token 提示词）首字节可能要 20–30s，这段静默期客户端（网关/卡片 sidecar）看到连接空闲便超时中断 → 反复 ResponseAborted。现于等待首字节期间按 5s 间隔下发 SSE 注释行（`: keep-alive`，规范合法、各 OpenAI/Claude/Gemini 解析器忽略），首字节到达即停止；同时新增断连观测日志（`STREAM-ERR`/`STREAM-CANCEL` 记录 `firstByteSeen`/`keepalivesSent`/耗时，用于判断断连发生在 TTFT 窗口还是流中段）。
- **用量表 成本/Token 切换后显示错乱（用户反馈）**：根因在运行时 i18n（`src/i18n/runtime.js`）与 React 的冲突——观察器只监听 `childList`、看不见 React 原地改写的文本，且会把排序时被移动行的单元格文本重置回首次见到的"原文"（成本模式下的 `￥0.00`），造成 Token 模式下部分行显示金额、部分行显示 token 数的乱表。修复：观察器增加 `characterData` 监听 + 记录 `_i18nApplied`（上次写入值），发现文本被框架合法改写时采纳为新原文而非回退。附带修复：表头"Input Tokens"等被原地更新后漏翻译的问题。复现与修复均在 `next dev` + 真实浏览器验证。
- **用量表排序语义**：值列（token/成本）排序此前作用于分组前的明细行，组顺序由"组内第一条明细"决定而非组合计值（51M input 的组会排在升序第一位）；现按分组 summary 排序（`UsageStats.js`）。成本模式的排序列字段从 `promptTokens`/`completionTokens` 修正为 `inputCost`/`outputCost`（`UsageTable.js`）。
- **用量表表头字典补齐**：zh-CN 补 `Cached Cost`；zh-TW 补整个用量表组（Cached/Input Cost/Input Tokens/…/Usage by *，15 条）；APInex 提醒句与 `Invite code` 文案三语同步。


## v1.0.4 (2026-09-01)

> v1.0.3 发布后的维护版：修复供应商页排序、更新日志多语言化、Change Log 弹窗、出口代理开机恢复等问题。

### ✨ 新增功能

- **更新日志按界面语言加载**：仪表盘「Change Log」从包内 `public/i18n/changelog/` 按当前语言加载对应文件（`en.md` / `zh-CN.md` / `zh-TW.md`），未翻译的语言（日/韩等）回退到英文；随构建打包，无网络延迟。切换语言时弹窗即时刷新。
- **统一 CHANGELOG 分类风格**：`CHANGELOG.md` 全部版本统一为 ⚠️升级注意 / ✨新增功能 / 🐛Bug修复 / 🔒安全加固 / ⚙️工程与打包 / 📝文档 六类，消除此前 v1.0.0-1.0.2（纯文本）与 v1.0.3（emoji）的割裂。
- **历史用量导入（支持 9Router 备份）**：设置 → 本地模式 → 数据库备份新增「导入使用量」独立按钮，复用现有 Import Backup 文件选择流程，按扩展名分发——`.sqlite/.db` 只导入 `usageHistory` / `usageDaily`（用于统计），不触碰任何配置；`.json` 走原配置备份导入。用 `node:sqlite` 读取（无 wasm 依赖），按内容签名去重避免重复导入，前端硬校验扩展名（只收 SQLite 文件，选图片会提示）。
- **通知 Toast 顶部居中 + 图标对齐**：全局通知容器从右上角改为顶部居中，图标与文字垂直居中对齐（`items-center`），长文本换行不乱。供应商详情页（含模型下拉框）的浏览器原生 `alert()` 全部替换为友好的 `notify()` Toast（成功/警告/错误三类着色）。
- **新增 3 家供应商**：
  - **TokenBom**（`tokenbom`，标准 API Key 分区，**去中心化 token 交易市场**：闲置 API Key 自动赚积分、积分可调用多种模型、连接 API 提供者与消费者）：`https://tokenbom.com/v1`，Bearer 鉴权，含 79 模型 GitHub JSON 目录（Fetch Models 可拉取），种子含核心 Claude / DeepSeek / GLM / Kimi / Qwen；
  - **GoRouter**（`gorouter`，免费 Free Tier 分区，无充值入口，new-api 网关）：`https://gorouter.app/v1`，4 个模型（claude-opus-4-8 / 4-8-thinking / 5 / 5-thinking）；
  - **TaBiAI**（`tabiauto`，免费 Free Tier 分区，无充值入口，new-api 网关）：`https://tabitoken.com/v1`，同 GoRouter 4 个模型。
  - 三家用 new-api 官方 logo（青/洋红对称圆环 SVG）作图标。
- **配额包账户筛选提示框**：账户筛选（全部账号/活跃账号/已停用）选择会持久化到 localStorage，多次访问间保持；当筛选不是「All accounts」时，工具栏下方显示琥珀色提示条「账户筛选已启用，且会在多次访问间保持」，避免忘记当前筛选状态。
- **公益站供应商标签 + 显示开关**：GoRouter / TaBiAI 两个无充值入口的免费公益站（new-api 网关）默认不在供应商列表显示，带黄色「公益站」标签；可在 **设置 → Providers → 显示公益站供应商** 打开后显示。开关状态持久化到数据库。

### 🐛 Bug 修复

- **供应商页排序修正**（多项叠加，最终行为）：
  - **有连接的供应商前置**，连接状态优先于 priority（此前 priority 不同会打乱"有连接在前"）；
  - **连接全部停用（禁用）沉底**，排在从未添加的供应商之前；
  - **OpenCode Free / MiMo Code Free** 这类 noAuth 免费供应商按拓扑开关排序——拓扑隐藏时排在已连接供应商之后、已禁用之前，启用（拓扑显示）时置顶；两者默认拓扑隐藏（`topologyHiddenByDefault`）；
  - **合并 free 与 free-tier 列表**统一排序，避免有连接的免费供应商（如 Dots）排在拓扑隐藏的 noAuth 之后。
- **修复禁用连接的计数**：连接 `isActive=false` 不再计入"已连接"，全禁用的供应商不会被误判为活跃而浮到顶部。
- **Change Log 弹窗链接新标签打开**：修正 marked v18 renderer 签名（token 对象而非位置参数），`CHANGELOG.md` 链接恢复可点击并在新标签页打开。
- **Change Log 与头部菜单 i18n**：弹窗标题 / Loading / 错误文案、菜单项（Change Log / Theme / Shutdown / Logout 等）接入 `translate()`。
- **切换语言后文案残留旧语言**：`RuntimeI18nProvider` 现监听 locale 变化触发 React 重渲染，`translate()` 渲染的文本（如"已禁用"徽章）切换语言后立即更新。
- **bai 等自定义模型在 JSON 目录模式下不显示**：`customModelRows` 不再在 JSON 目录模式下被清空，手动添加的模型与 JSON 目录并存显示。
- **供应商连接测试补齐新供应商**：为 sensenova / dots / longcat / bai / api-airforce / bazaarlink / baidu / featherless / bluesminds / alitp-intl / codebuddy-cn / commandcode 等新增 provider 添加连接测试 case（有 `validateUrl` 走 GET models Bearer，否则 POST chat ping 自定义 header）；此前这些 provider 一律报 "Provider test not supported"。
- **JSON 目录启用模型后仍不显示**：启用 JSON catalog 模型时同步清除 `disabledModels` 中对应的陈旧禁用记录（含 provider 与 alias 两个 key，`/v1/models` 的 `isDisabled()` 用 outputAlias 判定）——否则用户在前端激活模型后列表仍被旧禁用状态挡住，出现"激活了却不显示"。
- **供应商详情的模型下拉框 i18n 补全**：New Model 输入、Fetch Models 等控件接入翻译。
- **B.AI 等 JSON 目录 provider 静态模型补全**：B.AI（35 模型，含 deepseek-v4-flash-vision-exp 免费实验版）、CodeBuddy CN（补 glm-5.3-flash / glm-5.3 / kimi-k3）等此前 Fetch Models 返回空或目录缺模型导致切换 "was not found in this provider's model listing"，现已补全静态目录。
- **供应商连接测试友好维护提示**：当 provider 端点被 Cloudflare/WAF 拦截（返回 403 HTML 挑战页）或网络不可达时，连接测试不再误导性地报 "Invalid API key"，而是显示琥珀色友好提示「Provider may be under maintenance — blocked by its gateway (e.g. Cloudflare)...」，并在添加 API key 弹窗中展示；新增 tokenbom / gorouter / tabiauto 的连接测试 case（走 GET /models Bearer）。
- **CodeBuddy CN DeepSeek 模型报 11150**：DeepSeek 系列模型（deepseek-v4-pro / deepseek-v4-flash / deepseek-v3-2-volc）不支持 `reasoning_effort: auto/off`，编码 agent（如 dsh 的 THINK:auto）调用时报 400 `11150`。现对 DeepSeek 模型将 `auto` 映射为 `high`、`off` 删除该字段（其他模型不变），agent 不再因思考强度参数失败。
- **CodeBuddy 系模型流式 tool_calls 空 name → 11133 / `unknown tool ""`**：CodeBuddy 上游流式返回工具调用时，首 chunk 带 `function.name`，后续 chunk 返回空 `name:""`（只累积 arguments）。原样透传给标准客户端时，客户端误判为空工具名导致 `unknown tool ""`，或把空名工具调用重发被上游拒绝（11133）。现于 SSE passthrough 中删除空 `function.name`，流符合 OpenAI 规范（name 只在首 chunk），客户端正确保留已累积的工具名。
- **隐藏公益站后拓扑图仍显示**：设置 → Providers → 关闭「显示公益站供应商」后，供应商列表正确隐藏 GoRouter / TaBiAI，但用量页的供应商拓扑图仍显示这两个公益站——拓扑图数据未同步读取该开关。现拓扑图与供应商页共用同一过滤逻辑（`AI_PROVIDERS[provider].community` + `showCommunityProviders`），开关关闭时拓扑图同步隐藏公益站。
- **dashboard/skills 页面 i18n**：Skills 页面的按钮、标题、提示文案未接入 `translate()`，中文界面下仍显示英文；skill 的 name / description 也未翻译。现已全部接入 i18n 并补全缺失翻译项（如「Copy link」「10Router (Entry)」）。
- **skills 页面链接关联中文版 SKILL**：`/dashboard/skills` 页面的复制链接 / 打开链接此前始终指向英文版 `SKILL.md`。现按当前界面语言解析——中文（zh-CN）时指向 `SKILL.zh-CN.md`，其余语言指向 `SKILL.md`。

### 🔒 安全加固

- **出口代理开机自动恢复**：`layout.js` 的 `initOutboundProxy` import 会被 Next 构建 tree-shake 掉，导致每次重启后 `process.env.HTTP(S)_PROXY` 不恢复、须等用户重存设置。新增 Node 侧初始化器（`outboundProxyStandalone.js`，随构建打入 standalone，由 `custom-server.js` 启动时调用）直接读设置表并应用代理 env。

### 📝 文档

- **npm 11+ `allow-scripts` 提示说明**：新版 npm 拦截本包 postinstall（仅预热 SQLite/托盘运行时，失败无代价），主 README、CLI 中英文 README、v1.0.3 release notes 均补充说明可忽略及如何放行（`--allow-scripts` / `npm config set`）。
- **更新日志拆分**：面向用户的精简版从 `CHANGELOG.ui.md` 迁至 `public/i18n/changelog/` 多语言文件，`CHANGELOG.md` 保留完整开发日志。

## v1.0.3 (2026-08-30)

> 首个以 **`@techysy/10router`** 名义发布的正式版。npm 包名已变更（npm 上的 `10router` 属于一个与本项目无关的 fork），可执行命令仍为 `10router`，数据目录 `~/.10router/` 不变，无需迁移。已装 `10router-cli` 的用户该包已停止更新，请改装新包。

### ⚠️ 升级注意

- **npm 包名变更为 `@techysy/10router`**：`npm i -g @techysy/10router`，可执行命令仍是 `10router`。为什么改：npm 上的 `10router` 属于 `some-du6e/10router` —— 同为 `decolua/9router` 的 fork，且早于本项目改名两周发布，属正当使用无法争取；此前的权宜之计 `10router-cli` 又与项目名不一致。改用 scope 包后 `@techysy` 归本组织独占，同时拿回品牌名。仪表盘的版本检查、「立即更新」拉起的 npx 命令、侧边栏安装命令、独立 updater 的兜底包名均已同步指向新包名。

### ✨ 新增功能

- **新增 4 家开放供应商**（均已配官方图标，模型目录 JSON 走仓库 GitHub + Gitee 双源，可在供应商页「获取列表」拉取更新）：
  - **LongCat**（美团，付费）：OpenAI 兼容端点 `api.longcat.chat/openai/v1`，Bearer 鉴权；
  - **SenseNova**（商汤 TokenPlan，公测免费）：`token.sensenova.cn/v1`，标准 Bearer，含 DeepSeek V4 Flash / GLM 5.2 托管模型与两款图像模型，归入供应商页 Free Tier 分区；
  - **Dots**（小红书 Dots Studio，公测免费）：`note3-prev-api.askdiandian.com/v1`，自定义 `api-key` 请求头，归入 Free Tier 分区；
  - **B.AI**（聚合平台，付费，一个 Key 通吃 GPT/Claude/Gemini/DeepSeek/GLM/Kimi/Qwen 等 11 个家族）：`api.b.ai/v1`，标准 Bearer；模型 ID 与凭证绑定，静态目录留空、以凭证 `GET /v1/models` 实时列表为准。
- **自定义供应商支持模型 JSON 目录**：自定义节点同样支持从 JSON 拉取模型清单，导入后可逐个禁用/激活、批量 Active All / Disable All，生命周期与预置供应商一致，`/v1/models` 只暴露启用模型。原手动路径在未导入目录或开关关闭时照常可用。
- **移除已废弃的 qoder-cn 渠道**：摘除其 registry 条目、OAuth 设备码流程、executor 与 usage 接入；qoder（国际版）不受影响。顺带删除了会静默抹掉 trae/devin-cli/windsurf 刻意隐藏的危险 registry 重建脚本（`regen-registry-index.mjs`）。
- **收录官方渠道图标**：LongCat、SiliconFlow 换用官方版图标，新增 tokenbom / Dots / SenseNova / B.AI 图标（B.AI 为 SVG，图标解析器新增扩展名映射）。
- **左上角品牌区更正为 "10Router Proxy"**：跟随上游改名时丢了 "Proxy" 后缀。仅调整侧边栏字标一处。
- **fnOS fpk 检查更新直达 Releases**：fpk 启动脚本注入 `INSTALL_CHANNEL=fpk`，`/api/version` 据此返回对应版本 release 的下载附件；侧边栏对 fpk 安装显示 "Get the fpk from Releases"，不再展示对 fpk 无效的 npm 安装命令。

### 🐛 Bug 修复

- **修复 npm 包携带构建机敏感文件**：CLI 构建把 `HOME`/`APPDATA` 指到 `cli/.build-home`，Next 构建期初始化生成的 `jwt-secret`、`machine-id` 和一份 `data.sqlite` 快照被 output tracing 带进 standalone、再随 `files: ["app"]` 进入 npm tarball（实测确认）。现改为构建期 HOME 挪到系统临时目录、产物显式排除，并在打包前新增第 9 步全量扫描门禁——命中任一敏感文件即拒绝出包；被污染的本地 `cli/app` 已清理。
- **修复照抄 `.env.example` 导致会话可伪造**：示例里的 `JWT_SECRET=change-me-...` 是仓库公开字符串，照抄的用户其 dashboard 登录态可被任意伪造。现在 `.env.example` 注释掉 `JWT_SECRET`/`INITIAL_PASSWORD`（留空即自动生成 0600 随机密钥），且运行时检测到已知占位值会忽略它并回退到生成的密钥。
- **修复用量统计同毫秒丢计数**：`saveRequestUsage` 的去重只按内容匹配（时间戳精确到毫秒 + provider/model/connection/key + token 数），两个真实不同请求若同毫秒落账且 token 数相同，第二条会被当重复吞掉。现调用方（chat 流式/非流式/SSE转JSON、embeddings 共 5 处）每上游尝试写入 `usageKey`，去重只按 key 命中；无 key 的旧调用方保持原行为。新增 `tests/unit/usage-dedup.test.js` 回归测试。

### 🔒 安全加固

- **仪表盘登录接入渐进锁定**：`loginLimiter`（5 次失败锁 30s→2m→10m→30m）此前只接了 SAML 回调，密码登录 `/api/auth/login` 完全无限流。现已接入，与 SAML 共用同一套 IP 判定（信任 `x-9r-real-ip` 需 custom-server 的 peer token 背书）。
- **登录密码校验统一**：登录路由改为复用 `verifyDashboardPassword`——`INITIAL_PASSWORD` 环境变量此前在登录路由被忽略（文档写了但实际不生效），现与敏感操作二次验证口径一致；同时移除登录路由里一份带硬编码兜底密钥的死代码。
- **仓库描述更正**：GitHub/GHCR 描述从 "9Router fork: ..." 更新为 10Router 自述（此前 Docker 包页展示的是上游名号）。

### ⚙️ 工程与打包

- **核实存疑两项**：docker-publish.yml 的 "重复 `--tag :latest`" 为误报（第二处 latest 是 `runs-on: ubuntu-latest`，写法本就正确）；`public/providers/longcat.png` 图标确认来自上游合并 `fd7a881c`，来源已明。
- 新增简体中文版 `cli/README.zh-CN.md`，两版顶部提供语言切换（npm 页面不解析相对链接，故使用绝对 URL）。

### 📝 文档

- **CLI README 新增「更新」章节**：分别说明 npm / Docker / fpk / standalone 四个渠道的更新方式，并明确警告 **非 npm 安装不要点击仪表盘的「立即更新」**——该按钮执行 `npm i -g` 并经 `npx` 重启，会在全局 npm 目录装出第二份，与原安装并存且互不知晓。fpk 安装现已被运行时识别（提示条自动改用 Releases 入口），该警告收窄为 Docker / standalone。
- **新增 `cli/PACKAGING.md` 本地 npm 打包指南**：覆盖构建九步、Step 9 敏感文件门禁、出包后自检（tarball 泄漏扫描 + 本机试装）、npmjs 发布（含国内镜像源不能发布、必须显式指定 registry 的坑）与 tag 触发其余三渠道的联动清单。
- **README 明确上游同步策略**：上游新功能一律学习后自行重写实现，禁止直接合并上游分支 / 挑拣提交 / 覆盖文件（见仓库根 `CLAUDE.md` 约定与 README「同步上游」章节）。

## v1.0.2 (2026-08-29)

> npm 上的 `10router-cli@1.0.1` 是首次发布的试水版本。npm 的 `name@version` 组合**永久不可重用**（即使 unpublish 也无法找回该版本号），因此正式版为 1.0.2。**建议 1.0.1 用户升级**：其内置的「检查更新」指向的是一个无关的第三方包。

### 🐛 Bug 修复

- ⚠️ **修复更新检查指向第三方包**（1.0.1 受影响）：仪表盘的版本检查、「立即更新」执行的 npx 命令、侧边栏展示的安装命令，以及独立 updater 的兜底包名，在 1.0.1 中仍写的是 `10router`——该名字在 npm 上属于一个与本项目无关的 fork。一旦该 fork 发布更高版本号，1.0.1 的仪表盘就会引导用户去安装他人的包。现已全部指向 `10router-cli`。
- **`--help` 显示错误的命令名**（1.0.1 受影响）：帮助信息打印的是 npm 包名 `10router-cli`，而实际可执行命令是 `10router`。二者在改名前恰好相同，改名后才暴露。
- **postinstall 失败不再中断安装**：该钩子仅预热 `~/.10router/runtime`，且 `cli.js` 每次启动都会重跑同样的自愈逻辑，失败本无代价。但在 WSL 路径上使用 Windows npm 安装时，postinstall 经由 cmd.exe 执行，而 cmd.exe 无法将 UNC 路径作为工作目录、会静默回退到 `C:\Windows`，导致 node 根本找不到脚本文件——脚本内部的 try/catch 此时尚未执行，整个安装随之失败。

### ⚙️ 工程与打包

- **澄清 `better-sqlite3` 的定位**（无行为变更）：它虽然在几乎所有部署里都不会被实际加载（npm ≥11 会跳过未放行安装脚本的 optionalDependency，且 Next tracing 只拷贝其 `lib/*.js` 而不含 `.node`，故 Docker / fpk / standalone 一律落到 `node:sqlite`），但它是**构建期必需**的：`adapters/betterSqliteAdapter.js` 静态 import、`api/oauth/cursor/auto-import/route.js` require，webpack 必须能解析该模块。曾尝试移除该依赖声明，导致 `next build` 报 `Module not found` 而中断，已恢复并在 `package.json` 中注明请勿删除。
- **新增测试 CI**：`.github/workflows/test.yml` 在每次推送 main 与 PR 时运行套件（ubuntu + Node 24），执行注册表基线校验与回归门禁。此前三个 workflow 只做构建，测试从未在 CI 跑过。
- **修复回归门禁脚本**并重建基线；修复一批仅因路径/运行器假设而失败的测试，套件从 1820 通过 / 94 失败变为 1872 通过 / 41 失败。
- 统一 Node 版本为 24（Active LTS，支持至 2028-04），新增 `.nvmrc`。

## v1.0.1 — 未发布（内容随 v1.0.2 交付）

> 本节记录原定于 1.0.1 的改动。**1.0.1 从未作为版本发布**：git 侧只有 `v1.0.1-rc.1` 标签（Release 已删除），Docker、fnOS fpk、standalone 三个渠道也从无 1.0.1 —— 以下内容对这些用户而言是随 **v1.0.2** 首次到达的。
>
> 唯一的例外是 npm：`10router-cli@1.0.1` 确实发布过，包含本节内容，但**不含** v1.0.2 修复的更新检查指向问题。该版本已由 `@techysy/10router` 取代。

### 🔒 安全加固

以下四项均为上游 9Router 继承代码中的问题。MITM 默认关闭，未启用过的用户不受影响。

- **MITM 转发上游时不校验 TLS 证书**：ALPN 探测、HTTP/2 与 HTTP/1.1 三条转发路径均设置了 `rejectUnauthorized: false`，加之固定使用单一公共 DNS 解析真实 IP，一旦 DNS 应答被投毒或链路上存在中间人，刚刚解密出的上游 OAuth 令牌会被原样转发给攻击者。三处均已恢复校验。
  - 关闭校验本无必要：三处原本就传了 `servername`，Node 按该主机名（而非所连 IP）校验证书，因此按 IP 直连不受影响。同仓库 `open-sse/utils/proxyFetch.js` 的 `createBypassRequest()` 做的是同一件事，且一直保持校验开启。
  - 已实测 `TOOL_HOSTS` 中各上游：githubcopilot、cursor、kiro 及两个 AWS 端点均校验通过并正常协商 h2；故意传入错误 servername 会以 `ERR_TLS_CERT_ALTNAME_INVALID` 拒绝。
- **根证书私钥权限收紧至 0600**：`rootCA.key` 此前以默认权限（0644）写入，本机任何用户可读；持有该私钥即可为任意域名签发受本机信任的证书。现以 0600 写入、`mitm` 目录以 0700 创建，且旧版本遗留的私钥会在下次启动时自动修复权限（Windows 由 ACL 管理，不适用）。
- **不再盲目杀掉占用 443 端口的进程**：MITM 启动时会 SIGKILL 掉任何监听 443 的进程，足以静默杀死本机正在运行的正常 HTTPS 服务，并且绕过了 `manager.js` 已经向用户征得的确认。现在仅回收自身残留实例（依据 `.mitm.pid`，或比对进程命令行），占用者无法识别时中止启动，并给出进程名与处理方式。
- **自动清理异常退出遗留的 hosts 条目**：清理钩子仅挂在 SIGTERM/SIGINT 上，SIGKILL、崩溃或断电后，被劫持的工具域名会持续指向 127.0.0.1 而无人监听，导致 Copilot/Cursor/Kiro 报出难以理解的错误，且此前没有任何机制会恢复。现在应用启动时会清理「当前不应生效」的残留条目（MITM 已关闭，或该工具 DNS 开关为关），正在运行的实例不受影响。
  - 检测为一次只读 hosts 读取，无残留时零开销，不会在每次启动触发 sudo 或 UAC 提示；确有残留但无提权时，会明确打印被搁浅的域名及处理方式，而非静默跳过。

### ✨ 新增功能

- **已禁用供应商排到最后**：Profile 设置页新增开关，开启后已禁用的供应商在列表中沉底，避免常用项被挤下去；Providers 页新增对应设置卡片。该排序同时覆盖 API Key 与免费商家分区。
- **CommandCode 接入标准化 JSON 模型目录**：新增 `providers/commandcode.json`（62 个模型，含能力字段），并在注册表接入 Fetch Models。
- **桌面侧边栏可折叠**：侧边栏支持收起，窄屏与专注场景下让出横向空间。
- **配额行批量显示/隐藏**：配额面板新增批量可见性按钮，不必再逐行开关；免费商家在拓扑图中以虚线连接区分。
- **OpenCode Go 配额用量接入**：通过 `opencode.ai/zen/go/v1/usage` 读取用量，并支持 rolling / weekly / monthly 三种窗口的扁平结构解析；模型列表亦可经 Fetch Models 实时拉取。
- **模型 JSON 目录改为 provider 独立存储**：目录不再混入 `customModels`，改为按 provider 保存并带 enabled/disabled 状态；JSON 拉取到的新模型默认禁用，需手动启用。全局开关持久化到数据库（原为 localStorage），关闭时回退到内置静态目录。
- **模型目录 Gitee 镜像回退**：`fallbackModelsJsonUrl` 提供 Gitee 镜像以加速国内拉取；主源改用 GitHub API URL，避免 raw CDN 的缓存延迟。

### 🐛 Bug 修复

- **修复 /v1/models 返回孤儿自定义模型**：从旧 9router 数据库导入后，`kv` 表里残留了大量引用已删除自定义节点（providerNodes）的 customModels，导致 `/v1/models` 对每个客户端（如 dsh、CLI 工具）返回成百上千个无效模型。
  - `/v1/models` 现在会过滤掉 `providerAlias` 指向不存在节点、或节点连接已停用的孤儿模型（保留内置 provider 与现存激活节点下的模型）。
  - 删除自定义节点时，同步清理其下的 customModels，避免再次产生孤儿。
- **自定义节点前缀唯一性检测**：创建/编辑自定义供应商节点时，若 prefix 与内置 provider 的 id/alias 冲突、或与其他自定义节点的 prefix 重复，将拒绝并返回明确错误（前端同步显示提示），避免模型路由歧义。
- **修复 CodeBuddy 执行器误删 Agent system prompt**：原逻辑把超过 2000 字符或命中宽松 agent 正则的 system prompt 整段替换为中性文本，导致自家 Agent（Hermes/10Router）每次开新会话失忆。现加入自家 Agent 白名单（原样放行）、去掉长度一刀切，仅替换真正的外部 agent 签名以通过上游内容过滤。
- **新增「从 GitHub JSON 获取模型」通用能力**：provider 可在注册表声明 `modelsJsonUrl`，详情页出现 "Fetch Models" 按钮，拉取该 JSON 并**替换**该 provider 的 customModels（新增 JSON 中的模型、清理已过时/不在 JSON 中的模型）。配套在设置页新增全局开关控制该功能（默认关闭）。目前已接入：CodeBuddy CN / Intl、OpenCode Go、CommandCode（对应 `providers/*.json`）。目录本身也同步更新：CodeBuddy CN/Intl 补充 vision/reasoning/context 能力字段，并新增 `hy4-preview` 模型。
- **Disable All / Active All 改为操作 JSON 目录的 enabled 标志**：此前这两个批量按钮不作用于通过 JSON 目录导入的模型，点击后界面状态与实际启用情况不一致。现改为对 JSON 目录发起批量 PUT（`all: true`），批量启停与单个模型开关走同一份状态。
- **侧边栏版本号不再硬编码**：`APP_CONFIG.version` 此前写死 `1.0.0`，装上 1.0.1 后侧边栏仍显示 1.0.0。改为读取 `package.json` 中的版本号。
- **配额零余额判定与「已耗尽」语义**：余额为绝对零值时才判为耗尽，避免误判；配额行的隐藏状态在多处视图间同步，筛选条件改为持久化保存，刷新后不再重置。批量按钮补齐 i18n，空状态下也提供操作入口。
- **自定义供应商 prefix 大小写不敏感**：prefix 校验改为大小写不敏感并统一归一化为小写，避免 `Foo` 与 `foo` 被视为两个前缀而产生路由歧义。
- **JSON 目录 provider 的过时静态模型可见**：内置静态目录中已不在 JSON 里的模型，会显示在「已禁用模型」中而不是直接消失，便于确认哪些模型被目录更新淘汰。

### ⚙️ 工程与打包

- **移除 `better-sqlite3` 依赖声明**（不影响任何已部署实例）：该包从未真正生效过 —— npm ≥11 默认拦截 install 脚本，作为 `optionalDependency` 它会被整包跳过；即便装上，Next 的 output tracing 也只拷贝其 `lib/*.js`，从不带 `.node` 原生二进制。实测确认 Docker 镜像、fnOS fpk、standalone 包三者**一直都跑在 `node:sqlite` 上**。
  - 数据完全兼容，无需任何用户操作：两者同为 SQLite 3.53.x，四个适配器共用同一份 `PRAGMA_SQL` 并都执行 WAL checkpoint，现存 `data.sqlite` 直接打开即可。
  - `src/lib/db/driver.js` 仍保留 better-sqlite3 探测与适配器 —— npm CLI 用户由 `cli/hooks/sqliteRuntime.js` 装到 `~/.10router/runtime`（自带版本号，与根 `package.json` 无关），那条链路不受影响。
  - 顺带消除了「实际生效的驱动取决于 npm 版本」这一不确定性。
- 🆕 **新增 npm 分发渠道**：CLI 已发布至 npm，`npm i -g 10router-cli` 即可安装，可执行命令为 `10router`。此前分发仅有 Docker / fnOS fpk / Standalone 三种。
- ⚠️ **修正更新检查指向错误的包**：仪表盘的版本检查、「立即更新」拉起的 npx 命令、侧边栏展示的安装命令，以及独立 updater 的兜底包名，此前全部写的是 `10router`——而该名字在 npm 上属于一个无关的 fork（停在 0.6.0）。现已全部指向 `10router-cli`，并让 `/api/version` 复用 `UPDATER_CONFIG.npmPackageName`，消除此前导致该问题的重复常量。
- ⚠️ **CLI npm 包名定为 `10router-cli`**：原定的 `10router` 已被第三方 fork 占用（npm 上停在 0.6.0），v1.0.0 更新日志中「npm 包名更新为 `10router`」一句就此作废。安装命令为 `npm i -g 10router-cli`，可执行命令仍是 `10router`，CLI 版本同步至 1.0.1。
- **CLI README 去除上游残留品牌**：`cli/README.md` 会作为 npm 包详情页展示，但其中的 npm/Docker/GHCR/License/Trendshift 徽章与文档链接仍全部指向上游 `decolua/10router`，会在本包页面上展示他人的版本号、下载量与仓库。现已改为本项目的 `10router-cli` 与 `techysy/10router`，移除 Docker Hub 与 Trendshift 徽章（本项目仅发布 GHCR 镜像），并在致谢中补上对上游 9Router 的署名。
- fnOS 打包 manifest 版本改为从 `package.json` 自动同步（`prebuild:fpk`），并在打包 README 中说明；manifest 对齐 1.0.1。
- 设置页卡片图标容器统一为方形 `size-10`（原为 `p-2` 矩形），并修正 Providers 卡片引用了字体中不存在的图标字形。

## v1.0.0 (2026-08-26)

### ⚠️ 升级注意

1. **数据目录改名**：默认数据目录从 `~/.9router/` 变为 `~/.10router/`（Windows: `%APPDATA%\10router`）。启动时若检测到旧目录存在且新目录为空，会自动一次性拷贝迁移（旧目录保留不删除）。显式设置 `DATA_DIR` 的环境不受影响。
2. **SAML entityID 变更**：默认 issuer 从 `urn:9router:sp` 改为 `urn:10router:sp`。已在 IdP 侧注册过 9Router SP 的用户升级后需在 IdP 重新注册新的 entityID，否则 SSO 登录中断。可在设置中手动改回旧值。
3. **MITM CA 更名**：MITM 代理的 CA 证书随数据目录更名重新生成，已在设备端信任旧 CA 的需重新信任新 CA。
4. **grok config marker 改名**：`config.toml` 中 `# 9router-prev-default` 记录不再被识别，升级后"上一个默认模型"记录丢失一次（仅一次，之后正常记录）。

### ✨ 新增功能

- **品牌重塑**：9Router → 10Router，版本号统一 1.0.0；全局替换 UI 文案、标题、landing page、元数据；品牌区显示 `10Router` + `v1.0.0`；更新日志数据源改为 `github.com/techysy/10router`。
- **i18n**：区域货币显示支持（en/pt-BR/pt-PT/es/de）；区分 CNY（全角 ￥）和 JPY（半角 ¥）；Profile 页面货币切换开关；中文翻译更新。
- **Providers**：免费商家拓扑开关关闭时增加卡片视觉反馈；按连接隔离配额行可见性；提供商拓扑画布开关。
- **Usage**：使用量页面升级上游结构，恢复表格筛选器与周期过滤；修复 ProviderTopology 数据源，使用活跃连接列表替代 byModel；恢复 ProviderTopology 渲染到 Usage Overview 页面。
- **Auth**：登录 cookie Secure 标志按请求协议动态判断；多跳反向代理下按 `x-forwarded-proto` 的第一跳判断协议，避免链路中后续跳把协议改写导致 cookie 标志判断错误。

### 🐛 Bug 修复

- 免费商家禁用文案 i18n 修复
- /v1/models 接口 noAuth 自定义模型遗漏修复
- 健康但无连接的数据库不 dump 完整内置目录
- 修复使用量页面无数据（SQLite 层统一）
- 重新导出 SQLite-layer request/usage APIs 通过 usageDb shim
- /v1/models 过滤已禁用的孤儿自定义模型

### ⚙️ 工程与打包

- **Docker 镜像**：GitHub Actions 自动构建 multi-platform (amd64 + arm64)；镜像 `ghcr.io/techysy/10router:latest`。
- **fnOS fpk 打包**：Matrix 构建 x86 + arm 双架构；每架构提供 url + iframe 双版本（共 4 个 fpk）；文件名 `10router-1.0.0-{arch}.fpk` / `10router-1.0.0-iframe-{arch}.fpk`；安装依赖 nodejs_v24。
- **Standalone Server**：无 Docker 环境的裸机部署包；含 standalone 构建产物 + custom-server.js + node-forge；启动 `node custom-server.js --port 20128`。
- **CI/CD**：`docker-publish.yml`（tag 触发 → multi-platform Docker 镜像推送 GHCR）；`build-fpk.yml`（matrix 构建 x86/arm → 双版本 fpk → 统一 Release 上传）；`build-server.yml`（standalone tar.gz 构建 → Release 资产）；CI Node 22 → 24，对齐 fnOS `nodejs_v24` 运行时；fnpack 1.2.1 固定 sha256 校验和。
- **工程清理**：移除上游 9Remote/9English 广告入口、`NineRemoteButton.js`、`NineRemotePromoModal.js` 组件、Sidebar 中 9Remote/9English 导航项、上游 DockerHub 发布和 GitBook 文档站点；清理开发 artifacts（workbuddy memory、npm 残留文件）；fnOS fpk 打包并入主仓库（fnos-packaging/）；README 重写为 10Router 版；捐赠入口改为本地 donate.json（GitHub Sponsors + 微信 + 支付宝）。
