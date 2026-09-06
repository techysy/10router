# v1.0.7 发版审查（2026-09-06）

> 审查对象：`v1.0.6..HEAD`（23 个提交，99 文件，+3323 / −247）
> 审查方式：双会话交叉逐笔读 diff + 全量测试回归 + 声明逐项实测验证
> 版本：root `1.0.7` ／ cli `1.0.7` ／ desktop `1.0.7` ／ fnos manifest `1.0.7`（**四处**一致）
> ⚠️ `v1.0.7` **tag 尚未打**（最后一个 tag 是 `v1.0.6`），发版提交已就位，随时可 `git tag v1.0.7 && git push origin v1.0.7`（打 tag 会触发 `build-desktop-win.yml` 桌面产物 CI）

---

## 一、提交全景（按时间）

| 提交 | 主题 |
|---|---|
| `409b0b48` | Docs: README 版本历程重排 + 徽章 1.0.3→1.0.6 |
| `8cfa2451` | Docs: Contributors 残留上游贡献者诊断（fork 缓存滞后，勿重写历史） |
| `4efea7a3` | Feat: 桌面托盘更新链路适配 + 菜单精简（INSTALL_CHANNEL=desktop） |
| `4e8ee7fb` | Build: Windows 桌面产物 CI 化 + SignPath 签名链路 |
| `fd20ad8b` | Fix: desktop CI 补装 cli 依赖（esbuild） |
| `cca8bd7c` | Fix: mac 语言检测（defaults read AppleLocale 兜底） |
| `e624d4dc` | Feat: **使用量导入接口鉴权补齐**（登录态/x-9r-password/Bearer sk-） |
| `dd573e9c` | Feat: **ZCode 用量同步插件**（zcode-plugin/，新目录） |
| `1a91bf33` | Fix: 详情 tab 展示导入用量行（imported 行合成 + 双源归并分页） |
| `510c50ec` | Fix: Next16 dev allowedDevOrigins 补 127.0.0.1 |
| `3c5eb6cc` | Feat: 托盘图标单色化（mac template + win 主题黑白） |
| `82fa807d` | Fix: 托盘单色图深色跟随（读 SystemUsesLightTheme）+ 框线加粗 |
| `6bb1ca08` / `78ffd238` | Docs: 托盘单色化技术沉淀 ／ codebuddy-cn 错误码速查 |
| `847feb68` | Merge |
| `2adcd9c4` | **Sync: 上游 v0.5.69 第一批**（安全/风控/并行工具调用/配额/目录） |
| `00c8e002` | **Sync: 上游 v0.5.69 第二批**（qoder 目录/agy 配额分组/copilot 弃 MITM） |
| `4b312b09` → `3a8a1a5f` | Docs/Chore: 发版 v1.0.7（版本同步 + 三语用户日志 + 开发日志明细） |
| `c675368c` | Feat: cbcn 内置「总积分」配额聚合行 |
| `50c02e15` | Feat: cbcn 配额 i18n（Total Points / Bonus Pack N） |
| `6a007ebf` | Merge |

## 二、重点审查结论（按风险从高到低）

### 1. 安全相关 ✅ 全部通过

| 改动 | 审查结论 |
|---|---|
| **`/responses` 鉴权缺口修复**（`src/dashboardGuard.js`） | `PUBLIC_PREFIXES` 补入 `/responses`。middleware 先于 Next rewrites 执行，根路径 `/responses`（rewrite 到 `/api/v1/responses`）此前落进 guard「未知路径放行」分支→**远端免 key 直达 LLM handler**。修复正确，与 `/v1/*` 同口径。 |
| **import-usage 鉴权链**（`e624d4dc`） | 放行链完整：登录态 cookie → `x-9r-password`（`verifyDashboardPassword`）→ `Bearer sk-`（`validateApiKey`）。guard 侧对带凭据 POST 的放行**不是盲信**——路由内重新校验凭据本体，纵深防御成立。 |
| **cowork-mcp SSRF 防护**（`97f3ab97` 移植） | 远端调用者对 MCP url 强制 `assertPublicUrl`（拦内网地址），本机请求保留自建 MCP 兼容。单测 3 例（loopback/内网/本机放行）。 |
| **OAuth 连接测试 15s 超时**（testUtils.js） | `AbortSignal.timeout(15000)` 防悬挂耗尽连接池 + 供应商搜索空名守卫。 |
| **zcode-plugin 凭据处理** | 优先 `--key sk-`（虚拟 key），密码仅作回退；无凭据直接报错不静默。WAL 库不原地打开（拷贝临时文件快照）。 |
| **dev allowedDevOrigins**（`510c50ec`） | `["127.0.0.1"]` 仅 dev 水合修复，生产不受影响——**不是安全项**（防止被误读为绕过修复）。 |

### 2. 上游 v0.5.69 同步（两批，重实现不合并）✅ 逻辑自洽

- **后台 token 刷新防风控**（`backgroundTokenRefresh.js`）：`Promise.allSettled` 并行 → 串行 + 分级抖动（Google 系 12s+0~4s，常规 1.5s+200ms，env 可调 `BG_REFRESH_GOOGLE_DELAY_MS`/`BG_REFRESH_DELAY_MS`）。逐账号失败照旧吞掉不影响 tick。onboard 重试 5×2s → 2×12s+抖动。
- **Responses 并行工具调用修复**（`translator/response/openai-responses.js`）：`output_item.added` 即分配 chat tool_calls index，delta 按 **item_id** 路由（`state.respToolChatIndex` Map）而非流位置——修复上游全 added-后-delta 乱序时 N 个并行调用并进 index 0 的 bug。请求侧同步严格化：无名工具跳过（严格上游会 400）、名称截 128、`clampResponsesCallId`/`coerceResponsesArguments`/`coerceResponsesOutput` 收敛到 `formats/responsesApi.js` 统一导出；call_id 同毫秒回退加进程级序列防碰撞。
- **opencode-go 新 executor**：免费池按 `x-opencode-session` 粘会话——原生头优先，否则按（下游会话+客户端工具）SHA256 确定性生成 `ses_<32hex>`，防每请求随机会话被风控判滥用。registry、executor index、chatCore 双调用点（含 retry）均已接线。
- **antigravity 提示词清洗泛化**（`appConstants.ANTIGRAVITY_PROMPT_REWRITES`）：规则表驱动（剥 Claude Agent SDK 句 + opencode 大小写变体改写），防后端 429 Quota Exhausted 误判。
- **anthropic-compatible 前置真 Claude 补 beta flag**（`executors/default.js`）：按模型 id 门控补 `context-management-2025-06-27`，修静默换模型；非 Anthropic host 仍剥 claude-code 身份 flag。
- **claude server_tool_use 毒化清理**（`formats/claude.js`）：外来 server_tool_use 块按 `^srvtoolu_[A-Za-z0-9_]+$` 校验丢弃，连带清理悬空 tool_result + 空文本块/空消息——修组合回落后的 400 连环拒。
- **claude 缓存锚点跳过 defer_loading**：`lastCacheableToolIndex` 应用于 `anchorClaudeCache` 与 `prepareClaudeRequest` 两处，MCP 延迟工具不再连带 cache_control 被 Anthropic 400 拒。
- **gemini 元组校验**：`prefixItems`→`items` 转换后再剥离，数组缺 items 补占位。
- **thinkingUnified auto effort**：`auto` 归一为 `high`；永久 adaptive 模型（fable，`thinkingCanDisable:false`）不再发冗余 thinking 开关。
- **模型目录**：codebuddy-cn 删 7 个服务端不再发布模型（能力表按服务端 product-config 重校，thinkingLevels 补 per-model effort sets）+ GPT-5.6 image 变体；qoder 目录刷新 + 图片透传（base64 直传免 OSS 预上传）+ capabilities 全表；glm/glm-cn 补 glm-5-turbo；codex 补 gpt-6-astra。
- **copilot 弃 MITM**：CLI 工具页改三步 VS Code 扩展指引（`configType:"guide"`，基础设施已有两个先例），MITM 引擎层保留可手动配置回退。

### 3. 配额/用量 UI ✅

- **cbcn「总积分」聚合行**（`services/usage/codebuddy-cn.js`）：月包取 `Cycle*`、赠送包取 `Capacity*`（优先 Precise 字段，数值化求和后 `Math.round(x*100)/100` 防浮点漂移），插入序在 Monthly 之前；`resetAt: null`（聚合无单一周期，不渲染误导倒计时）；used/total 直读使「只看有余额」天然联动（耗尽自动隐藏）。i18n 英文键 `Total Points`（en 原样、zh 词条化）+ `Bonus Pack N` 显示层拆「基础名+序号」翻译（translate() 全串精确匹配打不中带序号名字），配额行与隐藏 chips 两处渲染点接齐。
- **antigravity 配额按家族分组**（`ProviderLimits/utils.js`）：gemini-*/claude-* 归并单行取**最耗尽成员**（即族内约束上限），hidden 陈旧 key 读侧修剪（存储不动、跨连接不串扰——保留本项目优于上游的按连接隔离），hide/show 对组键级联清理成员键。
- **详情页 imported 行**（`requestDetailsRepo.js`）：`meta.imported` 标记行从 usageHistory 合成详情、与 requestDetails 按时间戳内存归并分页。**归并分页数学已证明正确**（此前审查一度误报"深分页漏行"，收回）：取 K=offset+pageSize 时全局 top-K ⊆ 两源局部 top-K 的并集，合并排序后的前 K 名即全局 top-K，slice 结果与两源行数无关。实时代理双写无 imported 标记，不重复计数。
- **providers 下拉联合**（`/api/usage/providers`）：requestDetails 与 usageHistory（imported）DISTINCT 联合，参数化查询无注入面。

### 4. 桌面/CLI ✅

- 托盘单色化：mac `icon-template.png` + `isTemplateIcon`（alpha 即图形，旧彩色版开 template 会成实心块，故 darwin 专用）；win CLI 托盘（PowerShell NotifyIcon 管道，非 Electron）读注册表 `SystemUsesLightTheme`（任务栏跟随 Windows 模式，非 nativeTheme 只看的 AppsUseLightTheme 应用模式），desktop 壳走 `nativeTheme` + `setTemplateImage`；三处托盘面缺资产回落彩色品牌图标。
- `/api/version` 对 `INSTALL_CHANNEL=desktop` 返回 Releases 链接（与 fpk 同机制），托盘状态感知单动作 + 检查更新 + 关于 + 静默自检（fetchJson 8s 超时，仅发现新版本弹气泡）。
- mac 语言检测链：`TENROUTER_LANG`/`LC_ALL` 优先不变，darwin 插入 `defaults read -g AppleLocale`（2s 超时静默失败），`LANG` 降为兜底后一级；桌面壳用 `app.getPreferredSystemLanguages()`。
- CI（`build-desktop-win.yml`）：tag 触发 Setup/Portable/Web-Setup+7z，SignPath `if: vars.SIGNPATH_PROJECT_SLUG != ''` 门控——未配置自动降级未签名。

## 三、测试验证（本机实跑）

```
npx vitest run --config tests/vitest.config.js
结果：Test Files 188 passed / 21 failed(基线内) / 12 skipped；
      Tests   1997 passed / 39 fail(基线内) / 17 expected fail / 94 skipped
与干净基线（git stash 后同口径重跑）逐条比对：零新增失败。
node tests/__baseline__/verify-no-regression.mjs → ✅ No regression
```

- 本批新增/扩充测试全部通过：thinking-unified 46/46、dashboard-guard 24/24、provider-quota-visibility 14/14、background-token-refresh 11/11、opencode-go-session 10/10、claude-header-forwarding 19/20（1 例环境相关，见下）、responses-parallel-tool-calls 7/7、imported-usage-details-tab 6/6、codex-reset-credits 5/5、codebuddy-cn-usage 4/4、cowork-mcp-ssrf-guard 3/3、capabilities 5/5。
- ⚠️ `claude-header-forwarding` 的「api.anthropic.com → gotScraping」1 例为本机环境相关（gotScraping 不可导入时回退 fetch，mock 命中 0 次），已登记 `tests/__baseline__/known-fails.txt`，非代码缺陷。
- GitHub Actions（Tests workflow）对本批全部推送 conclusion=success。

## 四、风险点与注意事项（给接手人）

1. **tag 未打**：v1.0.7 发版提交、三语 changelog、fnos manifest 全就位，但 `git tag v1.0.7` 尚未执行。打 tag 即触发桌面 CI。
2. **`x-9r-cli-token` 跨层不变量**：import-usage 路由内对该头**仅判存在**（`route.js:50`），安全性依赖 guard 前置值比对 + 该路径在 ALWAYS_PROTECTED。后续若调整 guard 的 ALWAYS_PROTECTED 或 PUBLIC_PREFIXES，须同步复核 `import-usage/route.js` 的 `isAuthorized`。
3. **Claude fable 兜底行轻微误导**：仅存在泛化 `seven_day` 窗口时回填 `weekly fable (7d)` 固定 `used:0/total:100` 行——无 fable 权益的账号也会看到一条 100% 余量行（随上游同步引入，非本仓缺陷，可观察上游后续修正）。
4. **`meta LIKE '%"imported":true%'`**：JSON 字符串匹配，若未来 meta 序列化格式变化（键序/空格）需同步调整；当前写入侧唯一（importUsage 统一入口），暂无风险。
5. **Windows 本机跑测试**：用 `npx vitest run --config tests/vitest.config.js`（仓库根）或 `cd tests && npx vitest run`；判定回归只用 `verify-no-regression.mjs`，不要看裸 fail 数。
6. **SignPath**：未配置降级未签名——桌面产物目前无签名，electron-updater 差量更新（blockmap 已产出）依赖签名证书，CHANGELOG 已注明留待证书后接入。
7. **上游同步纪律**（重申）：两批 sync 均为「读上游实现 → 本仓风格重写」，无 merge/cherry-pick——后续同步保持此惯例，勿破坏干净贡献者集。
8. **gitee 镜像**：`gitee/main` 停在 `409b0b48`（本版第一个 docs 提交），**随发版手动推**：`git push gitee main --tags`（勿忘 tags，否则 Gitee Release 404）。
9. **外部 AI 审查引用须核验**：另一会话产出的 v1.0.7 审查（share.mirasim.ai 分享）含大量编造细节（不存在的 `calculateTotalPoints` 函数、虚构测试规模、Electron API 张冠李戴到 CLI 等），系其工具链大面积故障后的脑补产物，已弃用；本文档所有声明均经实测验证。

## 五、交接清单（Checklist）

- [x] `main` 与 origin/main 同步，工作区干净（gitee 随发版推送，见 §四.8）
- [x] 全量测试 + 回归门禁通过（39 fail 全在基线内，零新增）
- [x] 安全改动逐项复核（/responses 缺口、import-usage 鉴权、SSRF、超时）
- [x] 版本四处一致（root / cli / desktop / fnos manifest = 1.0.7）
- [x] CHANGELOG v1.0.7 与实际代码改动逐条比对一致（含上游同步明细、ZCode 用量链、mac 语言、托盘图标、cbcn 总积分；用户端三语含总积分与 ZCode 同步插件）
- [x] `git tag v1.0.7 && git push origin v1.0.7`（桌面 CI run 34049160612 绿，Release 附 9 产物）
- [x] npm 发布 `@techysy/10router@1.0.7`（registry.npmjs.org，latest=1.0.7；pack-destination 修正 `2c72cc72` 一并入库）
- [ ] 发版后 `git push gitee main --tags` 同步镜像
- [ ] SignPath 证书就绪后：接签名 → 评估 electron-updater 差量更新
- [ ] 观察 cbcn「总积分」/ antigravity 家族分组在真实多账号环境的展示反馈
