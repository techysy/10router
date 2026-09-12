# Antigravity（反重力）接入指南与踩坑实录

> 用途：接入 / 排查 `antigravity` 渠道（alias `ag`，上游 `https://daily-cloudcode-pa.googleapis.com`，Google Antigravity IDE 后端）时先查本文——**先分清是出口 IP 问题、账号风控、还是代码问题**，避免一看到 403 就去重登 token。
> 维护：2026-09-12 汇总一轮完整踩坑（代理 → 分流 → 账号验证 → 产品化）。适用版本：v1.1.1-test.2 起（含 VALIDATION_REQUIRED 友好化与「验证账号」跳转链接）。

## 一、接入形态速览

| 项 | 值 / 说明 |
|---|---|
| provider id / alias | `antigravity` / `ag`（`uiAlias: ag`） |
| 认证 | OAuth（google-oauth2），客户端身份**仿官方 IDE**：`registry/antigravity.js` 内置 IDE 的 clientId/clientSecret，UA `antigravity/ide/<ver> darwin/arm64` |
| 聊天上游 | `https://daily-cloudcode-pa.googleapis.com`（daily host；配额摘要另有一组 URL，见 §七） |
| 格式 | `format: "antigravity"`（Gemini 形状包在 `body.request` 里，独立 executor） |
| 重试 | 仅 `429`/`500`/`503`（各 3 次）；**`403` 不重试 = 终止态**，直接抛给客户端 |
| 模型 | `gemini-3.8-flash-{high,medium,low}` tiered 寻址（见 §六），serviceKinds `llm`+`image` |
| 风险标记 | `deprecated: true` + `deprecationNotice: RISK_NOTICE`——UI 会弹风险确认，这是**已知高风险渠道** |
| onboarding | 注册表声明了 `loadCodeAssistEndpoint` / `onboardUserEndpoint`，但**当前源码无调用点**——"完成验证"只能由账号在 Google 侧自己做，router 里没有按钮能替你触发 |

关键认知：**router 对外表现为一个合格的官方 IDE 客户端**，所以 Google 的账号级门禁（风控/地区/资格）会原样落在这个 OAuth 账号上，且错误体基本原样透传（这反而是排障福利——响应里常带修复线索）。

## 二、故障速查表（症状 → 真根因 → 出路）

| 症状（关键报错） | 性质 | 真根因 | 出路 |
|---|---|---|---|
| `403 … "Verify your account to continue."` + `reason: VALIDATION_REQUIRED` | **账号风控验证** | Google 标记了该会话/账号，要求浏览器完成一次 "Verify your account" | 响应体里自带 `validation_url`，无痕浏览器打开、登录被标记账号完成验证即可。见 §三 |
| `TOKEN REFRESHED success:true` 之后紧跟 `403` | 同上 | refresh token 是好的，**门在账号资格层**，刷新令牌救不了 | 别重登，直接走 validation_url |
| `Eligibility check failed: … not currently available in your location`（agy CLI）或同义文案 | **出口地区不一致 / 未验证会话**（两种含义，先查前者） | ① 分流规则没覆盖全 Google 域，部分请求漏到别的出口，Google 看到混合/受限地区；② 纯粹是未验证会话的另一种表现 | 统一 googleapis 全域出口（§四）+ 完成验证（§三）。**先查 ①再怀疑地区锁** |
| `proxyconnect tcp: dial tcp <ip>:7890: connect: connection refused`（Go 风格） | **本机代理环境**，不是 10router | 报错方是 Go 程序（如 agy CLI），它读到的 `http_proxy/https_proxy` 指向了死地址；Go **进程启动时读一次** env | 修代理地址 + **重启该进程**。Go 报错格式是识别"错在客户端工具而非 router"的信号 |
| `404 Requested entity was not found` | **模型 id 寻址** | 3.6/3.7/3.8 用 tiered entity（`<id>(<level>)`），裸 id 上游不认 | 用 registry 的 `upstreamModelId` 映射，勿直连裸 id。见 §六 |
| `all N accounts locked for … (reset after 2m)` | **failover 耗尽**，非新故障 | 403/429 使账号进入 per-model `modelLock 120s`，单账号场景锁完即全锁 | 等锁过期；根因按上两行处理 |
| 配额数字不动 / 滞后 | **配额端点顺序** | 两个环境（daily / cloudcode）各自计数，先查错端点看到的是旧账 | 摘要按 daily → daily.sandbox → cloudcode 顺序查（已按此实现）。见 §七 |

## 三、坑 1：VALIDATION_REQUIRED —— 账号风控验证（最高频）

**完整现象**：请求打到 `daily-cloudcode-pa…/v1internal:generateContent`，返回：

```json
{ "error": { "code": 403, "message": "Verify your account to continue.",
  "status": "PERMISSION_DENIED",
  "details": [{ "@type": "…google.rpc.ErrorInfo", "reason": "VALIDATION_REQUIRED",
    "domain": "cloudcode-pa.googleapis.com",
    "metadata": { "validation_url": "https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=…&plt=…&flowName=GlifWebSignIn" } }] } }
```

**修复步骤**（响应自带自助修复路径，不用找 Google）：

1. **无痕浏览器**打开响应里的 `validation_url`，登录**被标记的那个账号**（别用浏览器里已登录的其它 Google 账号，会串）。
2. 完成 "Verify your account"（通常是密码 + 二次验证）。`continue=` 会落到 `…/gemini-code-assist/auth/auth_success_gemini` 成功页。
3. `plt=` continuation 参数**有时效**，过期就重新发一次请求拿新链接再开。
4. 等 10router 的 `modelLock 120s` 自动过期再试（或重启该 provider）。

**要点**：
- 这是 **Google 账号侧门禁**，不是 10router 缺开关；重登 token、换 refresh_token 都没用（token 本身有效）。
- 一个账号可以有多个触发面：我们实测同一账号在 agy CLI 报 "Eligibility check failed"、在 10router 报 VALIDATION_REQUIRED——**同一个未验证会话的两种表现**，验证一次全解。
- 验证状态**跟账号走、不跟出口走**：验证完成后换出口节点（美国 ↔ 新加坡实测）依然有效。
- 产品化（v1.1.1-test.2 起）：聊天路径错误直接是含可点击 URL 的友好提示（`utils/error.js` `buildAccountValidationMessage`）；连接测试与模型测试失败时，仪表盘在错误旁渲染「验证账号」跳转链接（`testUtils.js` `buildCloudCodeProbeError` + `src/shared/utils/validationUrl.js`）。

## 四、坑 2：出口地区一致性 —— "not available in your location"

**这一课最重要：先查出口 IP 一致性，再怀疑账号/地区锁。**

**踩坑过程**：代理分流规则只手写了 9 个 antigravity 相关域名（`cloudcode-pa` / `daily-cloudcode-pa` / `oauth2.googleapis.com` / `antigravity.google` / `accounts.google.com` / `clients4.google.com` 等 → `💬 Ai平台` 组）。登录流程里其余 Google 域（实测抓到 `firebaseremoteconfig.googleapis.com`、`lh3.googleusercontent.com`）漏到"漏网之鱼"规则 → 走了**香港**节点，而主流程走美国——Google 看到混合/受限出口，报 "not currently available in your location"。

**修法**（mihomo，写在文件型规则集里**抗订阅更新**）：

```text
# /vol4/@appdata/mihomo-core/custom-rules.txt（挂在 RULE-SET,custom,💬 Ai平台）
DOMAIN-SUFFIX,googleapis.com        # 兜底所有 googleapis 子域
DOMAIN-SUFFIX,googleusercontent.com
```

改完热重载：`curl -X PUT http://127.0.0.1:9090/providers/rules/custom`，用 `GET /providers/rules` 的 `ruleCount` 验证（文件内部规则**不会**出现在 `GET /rules` 明细里，别被它骗了）。再用 mihomo `GET /connections` 抓实际连接链确认（链路应形如 `节点 > 🇺🇸 美国节点 > 💬 Ai平台`）。

**"印度区锁"疑云的排除**：曾怀疑闲鱼购入的号只能用印度 IP。验证完成后**新加坡出口照样跑通**，排除地区锁——那句 location 文案与 VALIDATION_REQUIRED 是同一扇门的两面。若未来真遇到地区锁（换多个出口都报 location），再看付款资料 country（pay.google.com → 设置）。

## 五、坑 3：本机 CLI / Go 系工具的代理环境

- **agy（Antigravity CLI）是 Go 程序**：`http_proxy`/`https_proxy` 在**进程启动时读一次**，改完 `~/.profile` 必须重开登录 shell（或 `source`）+ 重启进程才生效。
- Go 的报错格式（`Post "…": proxyconnect tcp: dial tcp …: connection refused`）一眼就能分辨**错在客户端工具的代理配置**而不是 10router（Node 的 fetch/undici 不会产生这种文案）。
- 双通道注意：`http_proxy` 管 API 流量，`CHROMIUM_EXTRA_ARGS=--proxy-server=…` 管内嵌浏览器流量——两处指向要一致（都指本机 mihomo `127.0.0.1:7890`）。
- 排查进程实际用的代理：`tr '\0' '\n' < /proc/<pid>/environ | grep -i proxy`；残留旧环境的实例直接 kill 让用户重开。

## 六、坑 4：模型 id 寻址 —— tiered entity

上游对 3.6/3.7/3.8 使用 tiered entity 寻址，**裸 id 会 404 "Requested entity was not found"**，registry 用 `upstreamModelId` 做映射：

| 目录 id（对外） | 实际上游 id |
|---|---|
| `gemini-3.8-flash-high` | `gemini-3.8-flash-high(high)` |
| `gemini-3.8-flash-medium` | `gemini-3.8-flash-medium(medium)` |
| `gemini-3.8-flash` | `gemini-3.8-flash-medium(medium)`（兜底指向 medium 档） |
| `gemini-3.7-flash-{high,medium,low}` | `gemini-3.7-flash-tiered(<level>)` |
| `gemini-3.6-flash-{high,medium,low}` | `gemini-3.6-flash-tiered(<level>)` |

注意 3.8 与 3.6/3.7 的 tier 命名不同（`flash-high` vs `flash-tiered`）——3.8 是"每档一个独立 id + (level) 后缀"，勿混用历史经验。目录新加模型时必须带 `upstreamModelId`，否则 404 会被误判为"模型下架"。

## 七、配额与用量端点

| 用途 | URL | 说明 |
|---|---|---|
| 模型发现 / 配额 | `daily-cloudcode-pa…/v1internal:fetchAvailableModels` | daily host 与聊天一致（对齐官方 IDE 客户端） |
| 配额摘要（双窗口） | `daily…retrieveUserQuotaSummary` → `daily…sandbox…` → `cloudcode-pa…` | **顺序敏感**：聊天流量落在 daily，两个环境各自计数，先查 daily 否则数字滞后于真实消耗 |
| 项目/资格 | `cloudcode-pa…/v1internal:loadCodeAssist` | 连接测试（Test 按钮）也用它做探针：POST `metadata.pluginType=GEMINI`，401 → 刷新令牌 → 重试一次 |

## 八、多账号、failover 与锁

- 403/429 触发 **per-model per-account `modelLock 120s`**；期间 combo failover 到下一账号。
- 单账号场景锁完即 `all 1 accounts locked (reset after 2m)`——这不是新故障，是根因（§二前三行）的下游表现。
- 多账号轮换时，**被 Google 标记的账号会持续 403**（验证状态跟账号走），failover 能兜住流量但治标；根因处理见 §三。

## 九、风险与账号选择

- 注册表层面 `deprecated: true` + `RISK_NOTICE`：Google 可能限制经第三方 router 使用 IDE 身份的账号，这是该渠道的已知风险。
- 闲鱼等渠道购入的共享号/区域号是**风险最高的形态**：容易被风控标记（本例账号即被标记过一次，验证后恢复），且随时可能被封。可以跑，但**不要当主力依赖**，重要工作流做好 failover。
- 多备一个账号比死磕一个被标记的账号更有效。

## 十、排查顺序 checklist（照抄即可）

```
1. 出口 IP 一致性
   - mihomo: curl -s http://127.0.0.1:9090/connections | 看 google 域的 chains 是否同组同区
   - custom-rules.txt 是否已兜底 googleapis.com 全域
   - curl -x http://127.0.0.1:7890 http://ip-api.com/json （出口国别）
2. 报错体找 validation_url → 无痕浏览器完成验证（§三）
3. TOKEN REFRESH 成功仍 403 → 正常，别重登，回到第 2 步
4. 官方 Antigravity 客户端 + 同账号同网络对照：官方也挂 = 账号问题；官方好 = 出口/身份问题
5. 多账号对照：换号好 = 单账号被标记；全挂 = 出口/分流问题
6. 模型 404 → 查 upstreamModelId（§六），勿当目录错误下架
```

## 十一、相关文件索引

| 路径 | 内容 |
|---|---|
| `open-sse/providers/registry/antigravity.js` | 注册表：tiered 寻址、重试表、配额端点、IDE client 凭据 |
| `open-sse/providers/shared.js` | `ANTIGRAVITY_IDE_BASE_URL`（daily host）、IDE UA |
| `open-sse/executors/antigravity.js` | 独立 executor：瞬时错误重试模式、输出上限、函数名清洗 |
| `open-sse/utils/error.js` | `buildAccountValidationMessage`（聊天路径友好化，test.2 起） |
| `src/app/api/providers/[id]/test/testUtils.js` | `buildCloudCodeProbeError` + loadCodeAssist 探针（Test 按钮） |
| `src/shared/utils/validationUrl.js` + `ConnectionRow.js` / `[id]/page.js` | 仪表盘「验证账号」跳转链接 |
| NAS `/vol4/@appdata/mihomo-core/custom-rules.txt` | googleapis.com 全域分流兜底（§四） |
| `tests/unit/upstream-validation-required.test.js` / `connection-test-validation-url.test.js` | 上述两层的守卫测试 |
