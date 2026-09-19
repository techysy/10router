# 实施方案 — 上游 9Router v0.5.75 → v0.5.81 选择性移植

> 上游窗口：`v0.5.75`（2026-09-10）→ `v0.5.81`（2026-09-18），**33 个提交**。
> 分支：`feat/upstream-0.5.81-port`
> 约束（CLAUDE.md 硬约束）：**只读上游实现学习思路，在本仓库用我自己的风格重写**。
> 绝不 `git merge` / `cherry-pick` / 覆盖上游 tarball。每条独立成 commit，可单独回退。
>
> 前作：[upstream-triage-v0.5.75.md](./upstream-triage-v0.5.75.md)（v0.5.69 → v0.5.75 窗口）

---

## 0. 背景

我们的内容基线 ≈ 上游 **2026-08-21**，之后一切上游变更靠逐条重写移植。上游本窗口的主力在
**OpenCode 免费层反滥用治理 + 流健壮性 + Antigravity 反滥用 + 账号冷却语义修正**。

按"症状在本仓库是否真实存在"筛选（而非按上游做了什么），得到 3 条**确有缺口**、2 条**待确认**、其余不移植。

---

## 1. 移植清单（按风险从低到高）

### ✅ P0-1 · request-scoped 4xx 不冷却账号

| 项 | 内容 |
|---|---|
| 上游来源 | `20a43f5` fix(auth): don't cool down an account for a request-scoped 4xx |
| 我们的现状 | `open-sse/services/accountFallback.js:95` 兜底：**任何未匹配错误**都 `{shouldFallback:true, cooldownMs:TRANSIENT_COOLDOWN_MS}` |
| 真实症状 | 400「上下文超长」这类**请求自身**的错误会锁账号 30s。单连接场景下，窗口内每个后续请求都拿到**同一个错误的副本**（`all 1 accounts locked for <model> \| lastError=[400]`），把真实原因盖掉，且无关会话被误判为「也撞了同样的限制」 |
| 为什么对我们重要 | 与我们已处理的 **CodeBuddy 11128 渠道级熔断是同一类问题**（错误归属错层：请求级错误被当成账号级）。11128 已做渠道级熔断，但**通用 400 仍锁账号**——同一 bug 的未修复分支 |
| 上游思路 | 在兜底之前加前置判断：`status >= 400 && < 500 && 非 401/402/403/429` → `{shouldFallback:false, cooldownMs:0}`；账号级状态码保留原有规则；**文本规则（限流/配额/容量措辞）仍然优先胜出** |
| 我们的实现要点 | ① 位置必须在 `ERROR_RULES` 循环**之后**、兜底**之前**（保证文本规则优先）<br>② 显式排除 401/402/403/429（它们是账号级/限流级）<br>③ 保留 `channelScope: false` 字段（我们返回值多了这个字段，上游没有）<br>④ 注释写清「为什么」而不是「做了什么」 |
| 改动范围 | ~12 行 + 新增测试 |
| 风险 | 极低。纯收紧冷却条件，不改账号级行为 |
| 测试 | 新增 `tests/unit/account-fallback-4xx.test.js`：400 上下文超长不冷却 / 401·402·403·429 仍 fallback / 400 带「rate limit」措辞仍 fallback（文本规则优先）/ 503 仍走瞬态冷却 |

---

### ✅ P0-2 · 连接重验证时清除 stale 健康状态

| 项 | 内容 |
|---|---|
| 上游来源 | `accf2c5` / 相关（clear stale connection health state on re-validation，#3810 #3830） |
| 我们的现状 | `src/lib/db/repos/connectionsRepo.js` 有 `rateLimitedUntil` / `errorCode` 字段，但重验证路径**不清 `modelLock_*` / `backoffLevel`** |
| 真实症状 | 用户重新登录/修复账号后，仪表盘显示连接正常，但请求仍被**旧锁**拦住 → 报「没连上」，用户反复重试无果 |
| 上游思路 | 连接被重新验证为健康时，一并清掉 `modelLock_*`、`backoffLevel`、`rateLimitedUntil`、`errorCode` |
| 我们的实现要点 | ① 只在**验证成功**时清（失败不能清，否则掩盖真实故障）<br>② `modelLock_*` 是动态 key（含 model 名），要按前缀匹配清<br>③ 复用我们已有的 `mutateSettings` 事务内 read-modify-write（v1.1.2 为渠道熔断加的并发安全 helper），别用「读→改→整包覆盖写」 |
| 改动范围 | 1 个 repo 函数 + 调用点 |
| 风险 | 低。唯一注意点是别在失败路径误清 |
| 测试 | 单测：验证成功清 4 类状态；验证失败不动状态；并发两个连接验证无丢失 |

---

### ⚠️ P1 · HTTP 200 后中断改为 in-band 上报

| 项 | 内容 |
|---|---|
| 上游来源 | `9300121` fix(stream): report aborts after HTTP 200 in-band instead of closing silently |
| 我们的现状 | `open-sse/handlers/chatCore/streamingHandler.js:87`：`const onAbortTerminal = isResponsesPassthrough ? buildAbortedResponsesTerminalBytes : null;` —— **只有 Responses 直通有终止帧**，其他格式（OpenAI / Claude / antigravity…）一律 `null` |
| 真实症状 | 流 stall 或上游断开时，客户端看到「200 OK + 几个 chunk + 静默结束」，**分不清截断和正常完成**。对我们尤痛：反重力/Kiro 这类长静默期上游（`stallTimeoutMs` 场景）截断时，用户只会以为「回复就是短」 |
| 上游思路 | watchdog 把 abort 原因（`stream stall timeout` / `upstream connection lost`）交给 `onAbortTerminal`；`buildStreamErrorBytes` 按客户端格式成帧：OpenAI 兼容 → `data: {"error":{...}}` + `data: [DONE]`；Anthropic → `event: error`。**错误帧必须先于 `[DONE]`**；**绝不合成 finish_reason**（截断不能看起来像正常停止） |
| 我们的实现要点 | ① 先确认我们 `open-sse/utils/` 里是否已有 `buildStreamErrorBytes`（有则复用，没有则新增）<br>② 按我们 `FORMATS` 常量做分支，不硬编码格式名<br>③ 保持 Responses 直通路径不变（它已有专属 `response.failed` shape）<br>④ `abortMessage` 由 watchdog 设置后传入 |
| 改动范围 | `streamingHandler.js` + `streamHandler.js` + 可能的 `streamHelpers.js` |
| 风险 | **中**。动的是所有流路径；必须验证「正常结束不受影响」「错误帧顺序正确」「各格式客户端不炸」 |
| 测试 | 单测：三格式的错误帧字节形状 / 错误帧先于 [DONE] / 无 finish_reason / 正常完成不注入错误帧 |
| 建议 | 单独一个 commit，独立可回退；先做 P0-1/P0-2 合并后再动 |

---

### 🔍 P2-1 · Antigravity thoughtSignature 按模型家族隔离（待确认）

| 项 | 内容 |
|---|---|
| 上游来源 | `bc3be0c` fix(antigravity): scope cached thought signatures to the model family |
| 我们的现状 | `open-sse/translator/request/antigravity-to-openai.js` 处理了 thoughtSignature，但**未做家族作用域** |
| 待确认 | 我们是否真遇到过反重力「偶发 400 / 签名不匹配」？若无实测症状，**先不动**（避免引入无对应场景的分支） |
| 若确认要做 | 缓存 key 从「会话」→「会话 + 模型家族」；切模型时丢弃旧签名 |

### 🔍 P2-2 · Kiro 工具名下划线 + tool-result 图片（待确认）

| 项 | 内容 |
|---|---|
| 上游来源 | `c49efdf` / `82b1bca` / `f4f06f2` |
| 要点 | ① 保留 `mcp__server__tool` 的**下划线**（被清洗掉会导致工具调用失败）<br>② 响应侧还原客户端原始工具名<br>③ tool-result-only 回合用中性占位<br>④ 转发 tool-result 里的图片 |
| 待确认 | 我们用 Kiro 时是否出现过工具名不匹配 / 工具结果丢图 |

---

## 2. 不移植（附理由）

| 上游内容 | 不移植理由 |
|---|---|
| OpenCode 免费层反滥用（canonical session / decoy tools 隐真工具 / Muse Free 归一 / Union Alpha 走 Messages） | 依赖上游特定的免费层反滥用机制；我们免费层路径不同，照抄等于引入大量**无对应场景**的分支。**思路可借鉴**：他们「复用同一上游 session 防被判滥用」与我们 `opencode-go.js` 已有的 stable session 是同一思路（我们已自行实现） |
| 视频生成 / 1M 上下文开关 / 小米 MiMo 双认证 | **大功能**，非 bug 修复，需单独拍板（MiMo 双认证我们已有自己的实现） |
| 波斯语 i18n | 除非明确要支持 |
| DeepSeek-V4.1-Flash 等新模型清单 | 我们走自己的 catalog 同步节奏，不必跟随 |

---

## 3. 执行顺序与验收

```
1. P0-1 request-scoped 4xx   → commit 独立 → 单测
2. P0-2 清 stale 健康状态     → commit 独立 → 单测
3. （确认后）P2-1 / P2-2      → 有实测症状才做
4. P1 stream in-band 上报     → commit 独立 → 单测（风险最高，放最后）
5. 全量回归门禁
   npx vitest run --reporter=json --outputFile=/tmp/r.json
   node tests/__baseline__/verify-no-regression.mjs /tmp/r.json
   三条 registry 基线 + capability audit
6. 记账：CHANGELOG「上游 v0.5.75 → v0.5.81 择优移植」+ 本文档补实测结论
```

**验收标准**：回归门禁 PASS（不得让已知通过的用例转红）；每条改动有对应单测；
`docs/zh-CN/archive/upstream-triage-v0.5.81.md` 记账完整。

---

## 4. 风险与回退

- 每条独立 commit → `git revert <sha>` 即可单独回退，互不牵连
- P1 若回归门禁出现流相关失败，直接 revert，保留 P0-1/P0-2（它们收益最直接）
- 上游历史**无共同祖先**（我们历史是重写的），全程按**内容**对照，不可 merge
