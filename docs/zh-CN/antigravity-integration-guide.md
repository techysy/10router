# Antigravity（反重力）接入指南与排障实录

> **用途**：接入 / 排查 `antigravity` 渠道（alias `ag`，上游 `https://daily-cloudcode-pa.googleapis.com`，Google Antigravity IDE 后端）时优先参阅本文——**先分清是出口 IP 一致性、账号风控验证，还是模型寻址问题**，避免一遇到 403 盲目重登 Token。  
> **适用版本**：10Router v1.6.2 起（已支持 IDE 指纹 2.22.0、Gemini 4 Argon / Claude 5.5 家族隔离与真实生成探针测试）。

---

## 一、接入形态速览

| 维度 | 配置值 / 机制说明 |
|---|---|
| **Provider ID / Alias** | `antigravity` / `ag`（系统内置简写别名 `ag`，支持作为前缀调用） |
| **认证方式** | Google OAuth2，客户端身份**模拟官方 IDE**：内置官方 IDE 的 Client ID / Secret，携带合法 UA（`antigravity/ide/2.22.0 darwin/arm64`） |
| **核心上游** | `https://daily-cloudcode-pa.googleapis.com`（与官方 IDE 聊天会话端点一致） |
| **交互协议** | `format: "antigravity"`（Gemini 规范包装于 `body.request`，经由独立执行器驱动） |
| **重试与终止** | 遇到 `429` / `500` / `503` 自动重试（退避最多 3 次）；**遇到 `403` 视为终止态不重试**，结构化错误立即透传前端 |
| **现役模型** | 覆盖 `gemini-4-argon` 系列、`gemini-3.8-flash-{high,medium,low}`、`claude-sonnet-4-6` / `claude-opus-4-6-thinking` 等，支持原生 PDF 解析与图像生成 |
| **健康探测 (Test)** | **真实生成探针**：测试连接时自动剥离 thinking 后缀并发送真实生成探测，对齐 Antigravity 语义，防止带高思考参数误报 400 |
| **风险标记** | 标注 `RISK_NOTICE`：属于基于官方 IDE 协议接入的高级渠道，受 Google 账号级策略影响，不建议作为唯一单点依赖 |

> 💡 **核心概念**：10Router 对上游完全表现为一个**合格且版本合规的官方 Antigravity IDE 客户端**。Google 所有的账号风控（年龄、地区、会话标记）均直接施加在绑定的 Google 账号上。

---

## 二、故障速查矩阵（症状 → 根因 → 解决方案）

| 典型错误现象 / 报错日志 | 故障分类 | 根本原因 | 解决出路 |
|---|---|---|---|
| `403 ... "Verify your account to continue."` (`VALIDATION_REQUIRED`) | **账号风控门禁** | ① **年龄验证未完成（18+ 必须，占 80%）**<br>② 会话被 Google 标记异常，需完成二次人机/安全验证 | 1. 优先补全 Google 年龄验证（§三）<br>2. 提取响应里的 `validation_url` 在无痕浏览器中登录验证 |
| `TOKEN REFRESHED success:true` 紧随 `403 PERMISSION_DENIED` | **账号资格层拦截** | OAuth Refresh Token 完全有效，但 Google 在业务层判定账号无 Antigravity 使用资格 | **切勿盲目重复登录或刷新**。先做年龄验证，再走 `validation_url` 完成人脸/设备解锁 |
| `Eligibility check failed: ... not currently available in your location` | **出口分流不一致** | Google 域名分流规则不完整，部分内部校验请求漂移到受限节点（如香港）导致混合出口判定 | 检查 mihomo 规则，确保 `googleapis.com` 与 `googleusercontent.com` 全量走同组单一出口（§四） |
| `proxyconnect tcp: dial tcp ...: connection refused`（Go 风格报错） | **外部调用客户端代理死链** | 报错源自外部 CLI 工具（如 agy，启动时仅读取一次环境变量），而非 10Router 自身 | 修复调用客户端的 `http_proxy` 配置并**重启该进程**（§五） |
| `404 Requested entity was not found` | **模型 ID 寻址失配** | 上游 3.x/4.x 系列强制采用 tiered entity 寻址格式（如 `<id>(level)`），直发裸 ID 不被上游识别 | 必须使用注册表中映射好的 `upstreamModelId`（§六） |
| `all N accounts locked for ... (reset after 2m)` | **Failover 熔断兜底** | 连续 403/429 触发了单账号 120 秒 `modelLock` 保护，全部账号处于冷却中 | 并非新问题，解决前两项账号根因后，等待冷却自动倒计时结束即可 |
| 配额面板显示为 0 或扣除滞后 | **端点轮询时序** | 上游 daily 环境与标准 cloudcode 环境各自记账 | 10Router 现已自动按 `daily` → `daily.sandbox` → `cloudcode` 正确优先级提取真实配额 |

---

## 三、高频陷阱 1：VALIDATION_REQUIRED 账号风控验证

### 1. 根因剖析：年龄验证与会话拦截
Google Antigravity 服务有严格的 **18 岁以上用户门槛**（详见 [Google Antigravity FAQ](https://antigravity.google/docs/faq)）。  
账号只要未在 Google 体系内确立成年身份，即使开通了 Google One / Gemini Advanced，调用 Antigravity IDE 端点时也会直接遭遇静默拦截。

当接口报错如下时：
```json
{
  "error": {
    "code": 403,
    "message": "Verify your account to continue.",
    "status": "PERMISSION_DENIED",
    "details": [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      "reason": "VALIDATION_REQUIRED",
      "domain": "cloudcode-pa.googleapis.com",
      "metadata": {
        "validation_url": "https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=...&plt=...&flowName=GlifWebSignIn"
      }
    }]
  }
}
```

### 2. 标准自愈步骤
1. **补全年龄认证（首要前提）**：
   - 检查并补全出生日期：<https://myaccount.google.com/birthday>
   - 完成成人身份认证：<https://myaccount.google.com/age-verification>
2. **处理临时解锁链接**：
   - 在 10Router 面板报错或日志中复制 `validation_url`。
   - 使用**隐私无痕窗口**打开此 URL，输入该账号密码并完成二次验证，直到页面正确跳回 `auth_success_gemini`。
   - ⚠️ `plt=` 参数具有短时效性，若提示已过期，在 10Router 中点一次「测试连接」获取新链接即可。
3. **验证完成后的状态**：
   - 验证标记是**全局跟随账号**的，不是跟随 IP。解锁后即使切换代理节点（如在美区与新加坡之间切换），验证依然保持有效。

### 3. 若解锁后依然 403？
- **清理残留授权**：访问 [Google 账号已关联的应用](https://myaccount.google.com/connections)，解除所有 Antigravity / Cloud Code 的历史授权，随后在 10Router 中重新走一次添加账号流程。
- **强制静置降温**：**严禁持续高频重试**。Google 对短时间内高频失败的账号会加码风控，断开调用静置 6 小时以上通常自动降级。

---

## 四、高频陷阱 2：地区校验与出口 IP 一致性

地区报错通常表现为 `Eligibility check failed: ... not currently available in your location`。  
在怀疑账号被封或区域锁定之前，**90% 的原因都是因为代理分流规则遗漏了关联域名**。

### 1. 门禁 A（出口 IP）与 门禁 B（付款资料地区）的独立性

| 校验门禁 | 校验依据 | 常见翻车场景 | 解决策略 |
|---|---|---|---|
| **门禁 A: 出口 IP** | 真实请求发起时的出口节点 | 代理规则只写了主域名，认证子域漏走直连或走到了香港节点，呈现“混合出口” | 配置全域代理兜底（见下文） |
| **门禁 B: 付款地区** | Google Play / Google Pay 绑定的国家资料 | 家庭组车头与队员国家资料不一致，或资料锁在未开放区 | 访问 pay.google.com 设置页统一修正为美区/合规区 |

### 2. 代理分流兜底配置（以 mihomo / OpenClash 为例）
官方调用链不仅包含 `cloudcode-pa.googleapis.com`，还会在后台向 `firebaseremoteconfig.googleapis.com` 及图片存储域发送特征请求。

**正确做法**：在文件型自定义规则（抗订阅覆写）中直接放行后缀：
```text
DOMAIN-SUFFIX,googleapis.com,💬 Ai平台
DOMAIN-SUFFIX,googleusercontent.com,💬 Ai平台
```
配置生效后，可在控制台通过 `GET /connections` 观察连接链，确保所有匹配域均统一归入同一个海外代理节点（推荐美、日、新加坡等住宅/优质网络节点，机房原生黑名单 IP 会被直接拒之门外）。

---

## 五、高频陷阱 3：模型 ID 与 Tiered Entity 寻址

上游 Antigravity 针对模型有着特殊的路由映射规则，**直接请求裸 ID 会直接报 404 `Requested entity was not found`**。

10Router 的注册表已建立完善映射，对外调用规范如下：

| 对外标准模型 ID | 实际上游对应 Entity | 寻址特点说明 |
|---|---|---|
| `gemini-3.8-flash-high` | `gemini-3.8-flash-high(high)` | 3.8 Flash 最高算力档位 |
| `gemini-3.8-flash-medium` | `gemini-3.8-flash-medium(medium)` | 标准算力档位 |
| `gemini-3.8-flash` | `gemini-3.8-flash-medium(medium)` | 默认兜底映射至 medium |
| `gemini-4-argon` / 变体 | `gemini-4-argon-tiered(...)` | 新一代 Gemini 4 Argon 规范 |
| `claude-sonnet-4-6` | 上游 IDE Claude 映射 | 走独立家族配额与特性过滤 |

> 📌 **开发与配置须知**：在 10Router 中扩展或通过组合（Combos）路由 Antigravity 模型时，直接选择面板下拉模型名即可，系统底层会自动完成括号层级映射。

---

## 六、多账号并发调度与配额管理

1. **配额展示收口**：
   - 10Router 当前版本已对 Antigravity 配额展示完成清洗，仅呈现官方有效的周期性配额桶，剥离了无法消费的生图干扰项。
2. **账号故障隔离与锁机制**：
   - 遇到偶发 `429`（并发限流）或 `403` 时，系统触发该账号针对特定模型的 **`modelLock 120s`** 自动退避。
   - 建议在 10Router 中配置 2 个以上的 Google 账号，配合「到期优先」或「轮询」策略，实现透明故障转移（Failover）。
   - 单账号若频繁撞锁，请优先排查调用并发量，或在客户端适当增加请求间隔。

---

## 七、标准排查清单 Checklist（按序执行）

当 Antigravity 节点出现不可用时，请严格按以下步骤依次排查：

- [ ] **步骤 1：查出口纯净度**
  - 访问 `http://ip-api.com/json` 或通过代理面板确认当前出口非中国大陆/香港，且非高风险数据中心机房 IP。
- [ ] **步骤 2：查规则分流覆盖**
  - 确认 `*.googleapis.com` 与 `*.googleusercontent.com` 均走同组代理，无请求直连泄漏。
- [ ] **步骤 3：验证年龄认证**
  - 打开 [Google 账号年龄验证](https://myaccount.google.com/age-verification) 确认已显示验证通过。
- [ ] **步骤 4：处理安全验证链接**
  - 若日志出现 `VALIDATION_REQUIRED`，抓取报错中的 `validation_url` 在无痕窗口中完成二次登录。
- [ ] **步骤 5：使用 10Router 真实生成探针**
  - 在供应商连接详情页点击「测试」按钮，观察真实生成结果与返回文案。
- [ ] **步骤 6：核对模型命名**
  - 确认调用的客户端未私自改写模型为上游不支持的裸 ID。

---

## 八、相关模块代码索引

| 模块名称 | 仓库路径 | 职能说明 |
|---|---|---|
| **注册表配置** | `open-sse/providers/registry/antigravity.js` | 包含 IDE Client 身份凭据、Tiered 寻址字典、重试规则 |
| **独立执行器** | `open-sse/executors/antigravity.js` | 格式包装转换、Thinking 参数清洗、函数调用兼容 |
| **错误友好化** | `open-sse/utils/error.js` | 提取并组装 `validation_url` 为可交互错误提示 |
| **生成探测工具** | `src/app/api/providers/[id]/test/testUtils.js` | 负责剔除 thinking 后缀并发起真实测试请求 |
| **配额管理服务** | `open-sse/services/usage/google.js` | 官方周期性额度提取与解析落库 |
