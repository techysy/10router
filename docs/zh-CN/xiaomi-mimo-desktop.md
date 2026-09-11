# 小米 MiMo 桌面版适配（mimo / xiaomi-mimo）

> 范围：把 **小米 MiMo 桌面客户端**（MiMo Desktop）接成 10Router 的一个供应商。
> 相关代码：`open-sse/providers/registry/xiaomi-mimo.js`、`open-sse/executors/xiaomi-mimo.js`、
> `open-sse/shared/mimoAccount.js`、`src/lib/oauth/providers/xiaomi-mimo.js`、
> `src/lib/oauth/utils/server.js`、`src/app/api/oauth/xiaomi-mimo/*`、
> `src/app/api/oauth/[provider]/[action]/route.js`。

## 0. 为什么这家要单独适配

MiMo 桌面版**不是**标准 OAuth2，也不是"填个 API key 就完事"：

| 能力 | 认证方式 | 走哪个端点 |
|---|---|---|
| 云端 LLM（`mimo-v2.5-pro` 等） | API key `sk-...` | `https://api.xiaomimimo.com/v1` |
| **桌面专属 Preview**（`mimo-x-pro-preview` / `mimo-x-flash-preview`） | **小米账号会话 Cookie** | `https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions` |
| TTS（`mimo-v2.5-tts`） | API key | 见 `ttsConfig` |

两个关键结论决定了整个设计的形状：

1. **Preview 模型只认账号 Cookie**，API key 打不通 —— 所以想用 Preview 就必须拿到桌面版的登录态。
2. 桌面版的登录是**自定义 ECDH + AES-GCM 授权码**流程（不是 OAuth2 授权码），
   平台页面把一段密文交回客户端，客户端用本地私钥解出 `sk-`。

设计选择（当初定的"设计 A"）：**不新开一个 provider**，而是在现有 `xiaomi-mimo` 上做**双认证**
（`authModes: ["oauth", "apikey"]`），按模型选端点。这样用户无论用哪种方式登录，
模型列表是同一份，不会出现"两个小米"。

注册表要点：

```js
id: "xiaomi-mimo", alias: "xiaomi-mimo", uiAlias: "mimo",
aliases: ["mimo", "mimo-desktop", "xmd"],   // 兼容旧配置里的叫法
priority: 290, category: "oauth", authModes: ["oauth", "apikey"],
serviceKinds: ["llm", "tts"], color: "#FF6900",
```

模型清单（8 个）：

```
mimo-x-pro-preview          Desktop 专属（account-service）
mimo-x-flash-preview        Desktop 专属（account-service）
mimo-v2.5-pro
mimo-v2.5-pro-ultraspeed
mimo-v2.5
mimo-v2-omni
mimo-v2-flash
mimo-v2.5-tts               kind: "tts" —— 不参与文本 LLM 的默认禁用
```

> Preview 两个 id 是**客户端测试专属**的真实模型（用户确认），因此保留并标注来源；
> `mimo-v2.5-pro-ultraspeed` 的真实来源是 `https://mimo.mi.com/models/mimo-v2.5-pro-ultrspeed`
> （官方 URL 就是这么拼的，别"修正"它）。

## 1. 凭据路径：桌面版把登录态放在哪

这些路径**不存在 10Router 里，全是桌面客户端的**，且三个平台各不相同。
统一收在 `open-sse/shared/mimoAccount.js` 一个模块里（只有一处，两边不会漂移）：

```js
// Electron 的 userData（Chromium profile 根）
desktopUserDataDir():
  win32   %APPDATA%/Xiaomi MiMo
  darwin  ~/Library/Application Support/Xiaomi MiMo
  linux   $XDG_CONFIG_HOME（默认 ~/.config）/Xiaomi MiMo

// 账号分区 Cookie 库（passToken 在这）
desktopCookiePath():
  <userData>/Partitions/xiaomi-account/Network/Cookies

// auth.json —— 注意：不在 Electron profile 里！
desktopAuthJsonPaths():
  $XDG_DATA_HOME/mimocode/auth.json   ← 首选
  ~/.local/share/mimocode/auth.json   ← 回退（用户改过 XDG_DATA_HOME 时仍可用）
```

`auth.json` 的位置来自桌面客户端启动内置引擎时的 `authDataDir`，它是 **XDG *data* 目录**
（macOS 也不例外，不是 `~/Library`）；已退役的独立 mimocode CLI 写的是同一个目录，
所以一条路径同时覆盖两者。

### 读 Cookie 时的两个必须

1. **桌面版运行时会独占锁住 Cookie 库** → 先复制再读；复制失败就放弃（返回 null），不报错。
   复制的副本持有活的账号会话，所以按 `0600` 创建、用完即删。
2. **锁定要变成有类型的错误**：`EBUSY / EPERM / EACCES` 一律转成 `DESKTOP_LOCKED` 抛给上层，
   由 UI 提示"请先退出桌面版"；而**配额/用量这类路径必须降级、绝不抛**
   （拿不到就当作没有用量信息）。

## 2. 授权码流程（自定义 ECDH + AES-GCM）

### 2.1 握手与参数

```
客户端                                    平台
  │ 生成 X25519 密钥对
  │ pk = base64url(SPKI DER)              ← 必须是 base64url！见 §5.2
  │ ── GET /authorize?pk&redirect_uri&kn=mimocode&key_name&app=MiMo ──▶
  │ ◀── (回调) 或 (页面显示一段可复制的密文)
  │ 用本地私钥 ECDH + AES-GCM 解出 { uid, sk }
```

授权 URL 的**五个参数一个都不能少**（`buildAuthorizeUrl()`）：

```js
new URLSearchParams({ pk, redirect_uri, kn: "mimocode", key_name, app: "MiMo" })
```

`app: "MiMo"` 是**平台用来决定这份授权码为哪个客户端签发的**。缺了它，
页面交回的是为**另一个客户端密钥**加密的载荷 —— 长度正常、格式正常，
而任何一把我们的私钥都打不开。这是本项目踩过的最大一个坑（§5.1）。

配置集中在 `XIAOMI_MIMO_CONFIG`（`src/lib/oauth/constants/oauth.js`）：

```js
platformUrl: "https://platform.xiaomimimo.com",   // 可用 MIMO_PLATFORM_URL 覆盖
defaultBaseUrl: "https://api.xiaomimimo.com/v1",
kn: "mimocode",
app: "MiMo",
timeoutMs: 300000,        // 5 分钟：本地回调监听器等多久
pendingTtlMs: 24h,        // 待用私钥能活多久（粘贴授权码用，见 §2.4）
```

### 2.2 载荷线格式（逐字节，别改顺序）

```
base64url 解码后：
  bytes 0..31     32 字节  临时公钥（裸 X25519）
  bytes 32..43    12 字节  AES-GCM nonce      ← 在公钥【后面】
  bytes 44..n-16  密文
  最后 16 字节      GCM auth tag

密钥 = SHA256( ECDH(客户端私钥, 临时公钥) )
```

临时公钥的 SPKI 前缀是 `302a300506032b656e032100`（12 字节）拼上那 32 字节裸密钥。

**临时公钥在前、nonce 在后** —— 这和"nonce 在前"的直觉相反，而且是**本项目的真因级 bug**
（§5.3）。这份布局是逐字节对齐官方客户端 `app.asar` 里的解密函数得来的，不是推测。

### 2.3 本地回调监听器

`startXiaomiMimoProxy()`（`src/lib/oauth/utils/server.js`）：

- 绑定 `127.0.0.1` 的**临时端口**，`callbackUrl = http://127.0.0.1:<port>/callback/<32 hex>`
  —— 路径是**每个监听器随机生成的**（`crypto.randomBytes(16)`）。
  **这条随机路径本身就是防跨站的能力凭证**：不知道它的页面根本到不了处理逻辑（其余路径 → 404）。
  它取代了更早的"Origin 必须是 loopback"守卫 —— 那个守卫方向是错的，见 §5.4。
- 平台登录页是**从它自己的 https 源跨域调用**这个监听器的（官方客户端因此专门处理
  `OPTIONS` + `Access-Control-Allow-Origin`）。所以：只对平台源回 CORS 头，**不拒绝**其它来源。
- 结果用 **302 回平台自己的** `/authorize/callback?status=success|error&message=...` 报告，
  不再渲染我们自己的 HTML 页（官方就是这样，平台页面据此收尾）。
- 失败原因只有两个常量：`missing_data`、`decrypt_failed` —— **绝不把载荷回显进响应**。
- **回调里没有 `state`**（协议如此），所以无法按会话归因，只能**逐把待用私钥试**。
  归因规则：只有一个待用会话时把失败记到它头上；有多个时全部保持 pending，不误杀。

### 2.4 粘贴授权码通道（一等公民，不是兜底）

平台的授权页可能**显示一段码让人复制**，而不是回调我们的 localhost。这段码就是
**同一个 ECDH 密文**，所以走同一条解密入库路径（`completeXiaomiMimoFlow()`）。

- `POST /api/oauth/xiaomi-mimo/submit-code { code }` → `{ status:"done", state, result:{uid,baseUrl} }`
  或 400 `{ status:"error", error }`。
- 返回 **`state`** 是为了让模态框接着走已有的 `/exchange`：`sk-` 由服务端落库，
  **密钥从不经过浏览器**。
- **监听器超时（5 分钟）不能清掉待用私钥**。`stopXiaomiMimoProxy()` 只做"停止监听"；
  待用私钥的生命周期由 `registerXiaomiMimoSession()` 按 `pendingTtlMs`（24h）清理。
  （桌面版自己的登录引擎也是 24h，就是为了这个通道。）这里**曾经写反**过：见 §5.5。
- 粘贴文本会先归一化：容忍整段 URL / 裸 `u=` / `code=`、各种标签（`授权码：`、`验证码`、
  `Authorization code:`）、包裹的引号反引号、结尾标点；`decodeURIComponent` 包在 try/catch 里
  （一个裸 `%` 曾经变成 500）。
- **`payload_too_short`（< 60 字符）必须和 `decrypt_failed` 分开**：低于最小密文长度是
  **复制**问题，告诉用户"码不匹配"会让他去重抄一段本来好好的码。

### 2.5 错误文案与 i18n

服务端返回的文案会**原样显示在模态框里**，因此：

- 必须**说清下一步做什么**，不能只说"请重新复制"；
- **必须进 locale 表**（`public/i18n/literals/zh-CN.json` / `zh-TW.json`）。
  这些字符串**住在服务端**，模态框的字面量扫描看不见它们 —— 漏了就会在中文界面里
  突然冒出一句英文。`tests/unit/xiaomi-mimo-routes.test.js` 里有一条守卫用例会正则抽出
  这张映射表并逐个断言两个 locale 都有。

当前五个（`submit-code`）：

| error | 提示 |
|---|---|
| `empty_payload` | Paste the authorization code first. |
| `payload_too_short` | 太短，不是完整授权码（通常 100+ 字符），用页面上的 Copy 按钮整段复制 |
| `no_pending_session` | 本次登录已失效，点「Sign in via Browser」重新开始 |
| `decrypt_failed` | 与本次登录不匹配：整段复制，或重新获取 |
| `missing_api_key` | 这段码里没有 API key，请重新登录 |

模态框另有一条**错误态恢复按钮**（重新走一次浏览器登录），避免卡死在死路上。

### 2.6 端点契约

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/oauth/xiaomi-mimo/auto-import` | 从桌面版 profile 自动导入：`{found, apiKey, uid, baseUrl, source, hasDesktopSession, desktopLocked, error?}` |
| POST | `/api/oauth/xiaomi-mimo/api-key` | 手工填 `sk-` |
| GET | `/api/oauth/xiaomi-mimo/authorize?state=` | 启动监听器 + 登记密钥对；返回 `{ authorizeUrl, manualUrl, state }` |
| GET | `/api/oauth/xiaomi-mimo/poll-status?state=` | 轮询；**`done` 之后不能清会话**（否则 `/exchange` 拿不到） |
| POST | `/api/oauth/xiaomi-mimo/submit-code` | 粘贴授权码（§2.4） |
| POST | `/api/oauth/xiaomi-mimo/exchange` | 应用 `sk-`、建连接 |
| GET | `/api/oauth/xiaomi-mimo/stop-proxy` | 停止监听（**不清会话**） |

`manualUrl` = 平台那个**专门显示可复制授权码**的页面
（`redirect_uri=https://platform.xiaomimimo.com/authorize/code/callback`），
其它参数与自动版完全相同。模态框在有输入框时给出「打开授权码页面」链接。

## 3. 取号与端点选择（执行器）

`open-sse/executors/xiaomi-mimo.js`：

```js
PREVIEW_MODELS = new Set(["mimo-x-pro-preview", "mimo-x-flash-preview"])
COOKIE_KEY     = "__mimoAccountCookie"
```

- Preview → `https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions` +
  `Cookie: <账号会话>`；其余 → 云端 API + `sk-`。
- **401 → 失效缓存并重试一次**（账号 Cookie 30 分钟缓存，`COOKIE_TTL_MS`）。

## 4. 自动化与"不打扰"

- `auto-import` 会在桌面版**登录过**的情况下直接复用其登录态；桌面版正开着时
  Cookie 库被锁 → `desktopLocked: true`，UI 提示退出桌面版，**但绝不因为锁而让导入失败**。
- 导入/配额路径一律 **fail-open**：任何异常都退化成"没有额外信息"，不阻塞用户。

## 5. 踩过的坑（按严重程度，含真因复盘）

### 5.1 授权 URL 漏了 `app=MiMo`（症状：码永远不匹配）
平台据此决定为哪个客户端签发。缺了它就加密给别的客户端密钥。
→ 现在 `buildAuthorizeUrl()` 与官方构造器逐参数一致。

### 5.2 `pk` 用了标准 base64，而不是 base64url
官方是 `Buffer.from(publicKey).toString("base64url")`。X25519 SPKI 转标准 base64
**末尾必带 `=`**，还可能含 `+` `/` —— 这些字符不在 base64url 字母表里，
严格解码器会**静默跳过**，把 DER 拼成另一个（或无法导入的）公钥，
等于让平台加密给一把我们不持有的密钥。→ `pk` 用 base64url；
解密入口对标准 base64 再做一次归一化容错。

### 5.3 真因：载荷布局**前后颠倒**（症状：232 字符、格式正常、怎么都不匹配）
我们曾经按 `nonce(12) + 临时公钥(32) + ...` 读，官方是
`临时公钥(32) + nonce(12) + ...`。于是把临时公钥的前 12 字节当 nonce、把真 nonce 当公钥，
**ECDH 派生出的密钥全错，GCM tag 必然失败**。

> **为什么测试没拦住**：我们自己的加密测试助手也按同一个错误布局拼载荷，
> 自加密自解密当然全绿。**测试助手必须对齐对端实现，而不是对齐我们自己的解码器。**
> 现在助手与官方逐字节一致，并有一条"官方字节布局"断言（含字段偏移），
> 把顺序改回去会立刻变红。

### 5.4 Origin 守卫方向反了
早先要求回调的 `Origin` 必须是 loopback —— 而平台登录页是从**它自己的 https 源**调用的，
于是**唯一的合法调用方被 403**，自动回调这条路一直是断的。
→ 改为"随机回调路径 + 只对平台源回 CORS"，与官方一致。

### 5.5 监听器超时把待用私钥清空了
`stopXiaomiMimoProxy()` 曾经 `xiaomiMimoSessions.clear()`，于是用户一看回调不成就改去粘贴时，
私钥已经被 5 分钟超时清掉 —— 报"不匹配"。而当时那条测试用例还把 bug 当成契约固定了下来。
→ 现在只停止监听，TTL 由 `pendingTtlMs` 管；测试改成"停止后仍可用"。

### 5.6 回执方式不对
返回自定义 HTML → 平台页面无从知道结果（弹窗一直挂着）。
→ 302 到 `${platform}/authorize/callback?status=...`。

### 5.7 死配置
`XIAOMI_MIMO_CONFIG.callbackPath` 曾写着 `"/"`，与"随机路径"的现实矛盾且已无引用。
→ 已删除，避免下一个读代码的人被带偏。

## 6. 测试与验证

- 单测：`tests/unit/xiaomi-mimo-{oauth,routes,submit-code,account,executor,paths,icon,tts}.test.js`
  （8 文件）。路径类用例用伪造 home，并**只 mock `node:os.homedir`**（不要 mock `tmpdir`），
  且用 `assertSandboxed()` 保证**绝不写到沙箱外**（曾经因此覆盖过开发机上的真实 Cookie 库）。
- `process.platform` 是数据属性，要改就用
  `Object.defineProperty(process, "platform", { value, configurable: true })` 并在 `afterEach` 还原。
- **解密相关用例必须 `redirect: "manual"`**：否则 `fetch` 会真的跟到平台域名去（单元测试不该发真网络请求）。
- 手工验证：起一个临时 `DATA_DIR` + 非默认端口跑 sidecar；未鉴权时受保护路由返回 **401**
  只证明路由存在、不证明逻辑对。日志里会打
  `code rejected (decrypt_failed): N chars, M pending session(s)` —— **只打长度和计数，绝不打载荷**。
- 构建/替换/验证的通用流程见 `docs/zh-CN/local-build-and-verify.md`。

## 7. 相关文件

| 关注点 | 文件 |
|---|---|
| 注册表（模型 / 双认证 / 别名） | `open-sse/providers/registry/xiaomi-mimo.js` |
| 取号与端点选择 | `open-sse/executors/xiaomi-mimo.js` |
| 桌面版凭据路径 / Cookie / 用量 | `open-sse/shared/mimoAccount.js` |
| 握手与解密 | `src/lib/oauth/providers/xiaomi-mimo.js` |
| 本地监听器 / 会话 / 粘贴解密 | `src/lib/oauth/utils/server.js` |
| 常量 | `src/lib/oauth/constants/oauth.js` |
| 端点 | `src/app/api/oauth/xiaomi-mimo/*`、`src/app/api/oauth/[provider]/[action]/route.js` |
| 模态框 | `src/shared/components/XiaomiMimoAuthModal.js` |
| 图标 | `public/providers/xiaomi-mimo.png`（128×128 PNG，按 provider id 解析） |
