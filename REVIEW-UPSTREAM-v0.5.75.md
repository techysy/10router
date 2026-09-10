# REVIEW — 上游 v0.5.69 → v0.5.75 分诊（哪些该一起进 1.1.0）

> 上游 tag：`v0.5.69`（2026-09-05）→ `v0.5.75`（2026-09-10，仅 tag，无 GitHub Release——他们的 Release 列表停在 v0.5.35）。
> 窗口内 **26 个实质提交**（+1 merge `537b3bef`）。
> `git merge-base HEAD v0.5.75` 为空：两边**无共同祖先**（本仓库历史是重写过的），所以只能按**内容**对照，
> 逐条在本仓库重新实现，**绝不 merge / cherry-pick / 覆盖上游包**（CLAUDE.md 硬约束）。
>
> 本文件是 `REVIEW-1.0.9-SCOPE.md` 的姊妹篇：那份管 1.0.9/1.1.0 的**自家**改动记账，这份管**上游**输入。
>
> **基线前提（重要）**：本仓库历史的根提交 `fd7a881c` 是 **2026-08-21** 的一次上游 merge，
> 也就是说我们的内容基线 ≈ 上游 08-21。之后一切上游变更都靠我们逐条重写移植。
> 量化（`v0.5.75` 的 981 个 js/mjs/json 文件，不含 tests）：**651 个逐字节相同**（已同步）、
> **21 个停在 v0.5.69**（本窗口改过、我们没动）、**264 个两边都不同**（已分叉/落后更早）、
> **45 个我们完全没有**。详见附录 A/B。 → **只扫本窗口补不齐**，窗口外还有存量欠账（见 §9）。

---

## 0. 结论摘要

按内容对照（脚本把每条提交"新增的行"抠出来，逐字在本地树里找）得到 5 类：

| 类别 | 条数 | 说明 |
|---|---|---|
| **无需动作** | 4 | 净效果为零、或我们已与"回退后"状态一致 |
| **已自行解决** | 2 | 我们做过且其中 1 条**比上游更全** |
| **Tier A — 建议一起进 1.1.0** | 8 | 小、独立、低风险，多为真 bug 或低成本新模型 |
| **Tier B — 建议进（可分批）** | 8 | 中等改动，每条独立可回退 |
| **Tier C — 大功能，需拍板** | 4 | 视频生成、qoder 附件体系、CLI 选择器 |

**最值得注意的三条**：

1. **kiro 顶层 `systemPrompt`（A2/A3）** — 我们**同时在两处发**这个字段：
   `translator/request/claude-to-kiro.js:330`、`openai-to-kiro.js:423`，以及 RTK 注入器
   `rtk/systemInject.js` 也会把它写回去。而上游对此有**两次**修复：
   `1fc2a81d`（2026-09-03，**窗口外**）删掉 translator 那两行、
   `1892ed77`（窗口内）修掉注入器并写明后果——kiro.dev 对任何带该字段的 body 回
   **400 `REQUEST_BODY_INVALID`**，且注意它的注释提到"translator 从 v0.5.59 起就不发了，
   是这个 injector 又把它加回来"。我们两半都缺。
   这是本次分诊里**唯一的"我们可能正在持续报 400"级**问题。
2. **`998bb3d9`（#3905）Claude tool `type` 作用域** — 我们**既没有**它修的前置提交
   （`e08ac6da`，2026-08-28 引入全局默认化），也**没有**它的收窄逻辑。
   也就是说：MiniMax 那类"严格网关"的原始 bug 我们大概率还在，而它的修法正好是
   我们该采用的最终形态（只给声明 `requireClaudeToolType` 的网关加 `type`）。
3. **`807553e2` codebuddy-cn `deepseek-v4.1-flash`** — 我们已做，但**数值有分歧**：
   上游写 `maxOutput: 128000`（注释称来自服务端 product-config payload），
   我们写 `384000`（来自 DeepSeek 模型卡）。按本仓库"证据冲突取保守值"的既定决策，
   这里可能需要回落到 128000。**待核对**（见 §7.2）。

---

## 1. 无需动作（4 条）

| 提交 | 主题 | 依据 |
|---|---|---|
| `83af3f18` | 打 tag 的提交（只改 CHANGELOG） | — |
| `accf2c52` | 删掉重复的 qwen 供应商 | 与 `40dffbce` 成对，**净效果为零** |
| `40dffbce` | 新增独立 Qwen 供应商（`registry/qwen.js`） | 上游 `v0.5.75` 里已不存在任何 `id: "qwen"` 的供应商（逐文件扫描确认为空），我们也没有 → 状态一致 |
| `248d7da0` | revert：把 qoder 的 Responses usage 管道从共享代码里撤掉 | 该提交改的 6 个共享文件（`nonStreamingHandler` / `sseToJsonHandler` / `responsesTransformer` / `openai-responses` / `openai-to-claude` / `stream.js`）"新增行"**逐字全部命中**本地树 → 我们已经处在"回退后"状态 |

> `248d7da0` 是对 `1f10f9e5` 的**部分回退**。移植 qoder（Tier C）时必须按
> **v0.5.75 的最终状态**取，而不是照抄 `1f10f9e5` 那个中间态——
> 否则会把上游主动撤掉的共享 usage 管道又引回来。

---

## 2. 已自行解决（2 条）

| 提交 | 主题 | 我们的状态 |
|---|---|---|
| `807553e2` | codebuddy-cn：`deepseek-v4-flash` → `deepseek-v4.1-flash` | ✅ 已做（并且做得更多：CN 全量 13 模型 + `rateMultiplier` 徽章）。**但 `maxOutput` 数值有分歧**，见 §4.2 |
| `c7126411` | opencode-go：把 `deepseek-v4.1-flash` 排到目录最前 | ✅ 已覆盖，且**比上游更全**：我们有 `deepseek-v4.1-flash`（官方文档 id），上游最终目录里只有 `deepseek-flash`（名字叫 "DeepSeek V4.1 Flash"）。**不照抄** |

---

## 3. Tier A — 建议一起进 1.1.0（8 条）

小、独立、低风险；多数是真 bug 修复或零成本新模型。

| # | 提交 | 主题 | 我们的现状 | 备注 |
|---|---|---|---|---|
| A1 | `628ff1ea` | 仪表盘会话 cookie 加 24h `maxAge` | ❌ 缺：`setDashboardAuthCookie()` 只设 `httpOnly/secure/sameSite/path`。我们的 JWT **已经是 24h**（`setExpirationTime("24h")`），只有 cookie 没跟上 → 浏览器当成会话 cookie，关掉浏览器即"登出"，而 token 其实还有效 | 1 行改动 + 常量 |
| A2 | `1fc2a81d`（**窗口外**，09-03）+ `1892ed77`（窗口内） | kiro：**永不发**顶层 `systemPrompt` | ❌ **我们两处都还在发**：`claude-to-kiro.js:330`、`openai-to-kiro.js:423`，且 `rtk/systemInject.js` 也会写回。上游 09-03 就删了 translator 那两行（v0.5.69/v0.5.75 均已无），窗口内又修了注入器 | 高风险修复；`claude-to-kiro.js`/`openai-to-kiro.js` 都属"只与 v0.5.69 逐字节相同"的干净基线；见 §7.3 |
| A3 | `35b950be` | kiro（#3776）：走当前 runtime surface + 修 400 | 部分：我们有 kiro 三个测试文件，但 `kiro-minimal-wire-payload.test.js` 缺失；`kiro-terminal-integrity` 两例是**已知失败**（基线内） | 与 A2 同族，建议一起评估 |
| A4 | `998bb3d9` | （#3905）Claude tool `type` 默认化的作用域 | ❌ 两边都没有：既无 `defaultClaudeToolType` 也无 `shouldDefaultClaudeToolType` | 建议**直接按最终形态**移植（一次到位：修 MiniMax + 不误伤 DeepSeek 的 Anthropic 端点） |
| A5 | `781c18d8` | codex：剥离 `\p{...}` Unicode 属性 pattern | ❌ 缺（本地无 `utils/codexToolSchema.js`） | 新文件 60 行；Codex schema 校验器不认 Unicode property escape，一个 `pattern` 就 400 整个请求 |
| A6 | `a7047a07` | codex：恢复 `Version` 头 + CLI 版本单一来源 | ❌ 我们 codex **没有** `Version` 头（只有 `originator: codex_cli_rs`），也没有 `cliVersion` 字段（只有 `gemini-cli.js` 有这个字段） | 上游用词是 "restore"（他们曾误删）；我们从未有过 → 是否有影响需活体验证 |
| A7 | `832a3465` | codex / openai：新增图像模型 `gpt-image-2.5`、`-2.5-flare`、`-2.5-sunburst`、`gpt-image-2`、`gpt-image-1.5` | ❌ 缺：我们 openai 只有 `gpt-image-1`；codex 的图像模型是另一套命名（`gpt-5.x-image` 家族） | 纯加模型，低风险 |
| A8 | `eee3515e` | opencode-go：补新发布的模型 | ❌ 缺 **10** 个：`glm-5.3`、`kimi-k3`、`longcat-2.0`、`qwen3.8-max`、`qwen3.8-flash`、`hy4-preview`、`hy3`、`grok-4.6`、`muse-spark-1.2-contributor`、`muse-spark-1.3-contributor` | **建议不照抄上游**：该 provider 的 `/models` 是公开无鉴权的（实测 37 个 id），我们比上游少 **18** 个 → 直接按活目录对齐（同时解决 §3.2 那条记账） |

---

## 4. Tier B — 建议进 1.1.0，可分批（8 条）

| # | 提交 | 主题 | 我们的现状 |
|---|---|---|---|
| B1 | `8a81085a` | claude：re-anchor 的 `cache_control` 关进 4 个标记的预算内 + 保留单对象 content turn | ❌ 缺（`formats/claude.js` 缺 76/83 行、`claude-to-openai.js` 全缺）。单对象 content 那条尤其值得看：注释说**裸对象的 system turn 会被整个丢掉** |
| B2 | `45ec1d30` | deepseek：转发到 `/anthropic/v1/messages` 时保留 Anthropic 专属 tool type | ❌ 缺（`registry/deepseek.js` 需加 quirks；`formats/claude.js` 缺 19/20 行白名单逻辑） |
| B3 | `4ad1e7a4` | claude usage：model-scoped weekly 从 `limits[]` 解析，不再**伪造**一行 | ❌ 我们是"改前"状态（`claude.js` 里就是上游删掉的 `MODEL_DISPLAY_NAMES` + "Fable 没返回就补一行 100%" 那段）。即：**我们现在会在没有该窗口时，凭空显示一行 100% 的 Fable 周额度** |
| B4 | `e3bf94ee` | antigravity：周额度追踪 + 免费档处理（#3892） | 🟡 部分已有：我们早已是 **summary 优先**架构（`quotaSummaryApiUrls` 多 host 回退），weekly 行本来就有。缺的是：① 免费档判定（免费档只有周额度，`fetchAvailableModels` 的 per-model 信息**会误导**）；② **对账**——Google 免费档在额度耗尽后 summary 仍报 `remainingFraction: 1`，上游改成"某家族全模型耗尽 ⇒ 把周额度压到 0"；③ 仪表盘 weekly 分组（`ProviderLimits/utils.js` 缺 4/11 行） |
| B5 | `122f23ee` | cline / airforce：拆 `{success,data}` 信封 + 活目录 + 刷新 airforce 免费模型 | ❌ 缺（新文件 `shared/clineEnvelope.js`；cline/clinepass 都没 `quirks.clineEnvelope`；airforce 无 `modelsFetcher`） |
| B6 | `f6e7cabe` | clinepass：不再给 API key 加 `workos:` 前缀 + 补 token refresh | ⚠️ 需核对：我们 `clinepass.js` 是 `authModes: ["oauth","apikey"]`，上游改成 `["apikey","oauth"]` 并注明 **OAuth 流发的 token 不被 ClinePass 接受（401）** → 我们这边可能真会把 OAuth token 送去打 |
| B7 | `7fee56ba` | 供应商校验通过后清理 stale model lock（#3830） | ❌ 缺：我们有 `MODEL_LOCK_PREFIX`（2 个文件命中）但没有 `resetHealthStateOnActivation` |
| B8 | `e7b5f09d` | gemini / antigravity：contents 归一 + 中间工具响应 | 🟡 部分：**我们已有这段逻辑但不共享** —— `normalizeGeminiContents` 私有在 `openai-to-gemini.js:37`（上游把它提到 `formats/gemini.js` 导出，并让 `executors/antigravity.js` 也用上）；`cleanJSONSchemaForAntigravity` 我们已在 `formats/gemini.js:345`。缺的是 executor 侧接入 + 中间轮工具响应处理（`openai-to-gemini.js` 缺 5/7 行：`isIntermediate` / `hasActualResponses`） |

---

## 5. Tier C — 大功能，需拍板（4 条）

| # | 提交 | 主题 | 规模 |
|---|---|---|---|
| C1 | `3288bbc4` + `da6aa901` | **视频生成**：新增 OpenRouter + Vertex AI（Veo）适配层 | 新目录 `handlers/videoProviders/{index,openrouter,vertex}.js`（vertex 108 行，**三个文件我们都完全没有**）+ `videoCore.js` 44 行改动（干净基线）+ 两个 registry 的模型表；`da6aa901` 是配套的**路径穿越校验**（拒绝会逃出 URL 路径的 job id / model id——安全项，必须与视频功能同批落地） |
| C2 | `1f10f9e5` | qoder：usage 上报到所有客户端 + 不再内联大附件 | 大：新文件 `shared/qoder/attachments.js`(251) / `contextTier.js`(113) / `sse.js`(145)（**均缺失**）+ executor 78 行 + 多文件 usage 改动。**注意见 §1 的回退说明** |
| C3 | `4a390685` | CLI：模型选择器按供应商分组 + 搜索 | 我们 `cli/` 是独立包（独立版本号），改动 115/131 行，属 CLI 发布物范围 |

---

## 6. 反向：我们有、上游没有

- **opencode-go `deepseek-v4.1-flash`**（`cb4ba599`）：上游最终目录里只有 `deepseek-flash`，
  名字却叫 "DeepSeek V4.1 Flash"。我们同时保留两个 id（官方文档 id + DeepSeek 自己的名字）→ **更全**。
- **供应商总数 134 vs 上游 123**：我们多出 amd、apinex 等（含本轮的 AMD 重建 `f5985745`）。
- **模型积分倍率徽章**（`0d60b431`）：上游无此功能。
- **能力库审计脚本 + CI 门禁**（`d87207b2`）：上游无此机制。
- **AMD 目录/能力实测重建**（`f5985745`）：本轮新增，上游未涉及。

---

## 7. 需要你决策

1. **Tier C 是否纳入 1.1.0？**
   - C1 视频生成 = 完整新功能（OpenRouter + Vertex/Veo），含一个安全项（路径穿越）。
   - C2 qoder 是大改（3 个新文件 ~500 行 + executor），且必须按 v0.5.75 最终态取。
   - C3 CLI 选择器属 `cli/` 包，会牵动 CLI 的独立版本号。
   - 建议：**C1 进 1.1.0**（用户可见、边界清楚）；**C2 拆成独立一轮**；**C3 单独跟进**。
2. **codebuddy-cn `deepseek-v4.1-flash` 的 `maxOutput`**：上游 128000（据称来自服务端
   product-config）/ 我们 384000（模型卡）。按"冲突取保守值"的既定决策，
   是否回落 128000？需要我再去服务端 product-config 核一次。
3. **kiro（A2/A3）**：你手上有可用的 kiro 凭据做活体验证吗？
   没有的话只能按上游证据改 + 加单元测试守卫（我们 kiro 已有 2 例**已知失败**在基线里，
   正好属于同一族，移植时可一并处理或明确继续豁免）。
4. **A6 codex `Version` 头**：需要能真实调 codex 的账号才能验证影响面；否则先按上游补上。

---

## 8. 建议的 1.1.0 执行顺序

一条一提交、每条可独立回退（沿用"慢工出细活"的既定节奏）：

1. **A1** cookie maxAge（1 行，先做掉）
2. **A4** #3905 tool type 作用域（一次到位，含 MiniMax quirks）
3. **A2 + A3** kiro runtime surface / 顶层 systemPrompt（先定 §7.3 再动手）
4. **A5 / A6 / A7** codex 三项（pattern 剥离、Version 头、新图像模型）
5. **A8** opencode-go 按活目录对齐（补全 18 个，同时收口 §3.2 记账）
6. **B3 / B7 / B5 / B6**（伪造行、stale lock、cline 信封、clinepass 认证）
7. **B1 / B2**（claude cache_control 预算、deepseek Anthropic tool type）
8. **B4** antigravity 免费档与对账
9. **B8** gemini 中间工具响应
10. **C1** 视频生成（含安全项）
11. 收尾：全量测试 + 门禁 + 三份基线 + capability 审计 → 打 1.1.0 tag

> 每条落地时的验收口径照旧：全量回归 `failed` 不得超过基线（`known-fails.txt`），
> 跑 `verify-no-regression.mjs` 门禁；改动 registry/capabilities 时补 capability 审计
> （`floor` 不得增长，`--check` 退出码 0）；新增测试不得依赖真实网络。

---

## 9. 窗口外的存量欠账（只扫本窗口补不齐）

复核过程中撞到一件比本窗口更大的事：**我们的内容基线是上游 2026-08-21**
（根提交 `fd7a881c` 就是那天的 merge），所以 08-21→09-05 这段也有没同步的东西：

- 上游 `v0.5.59..v0.5.69` 之间有 **50 个提交**。
- 已查到至少两个我们没同步的窗口外修复：
  - `1fc2a81d`（09-03）kiro 删顶层 `systemPrompt` —— **就是 A2 的另一半**；
  - `e08ac6da`（08-28）Claude tool `type` 默认化 —— **就是 A4 的前置提交**。

也就是说 A2 / A4 这两条本质上不是"本窗口的新修复"，而是"我们欠了两个更早的修复，
本窗口的提交正好把它们收窄/收尾"。

**建议**：把 `v0.5.69..v0.5.75` 当作**第一批**（因为它有干净的 21 文件基线，见附录 B），
做完后另起一轮扫 `v0.5.59..v0.5.69`（50 提交）以及更早的缺口——
否则我们会一直在"修 A4 才发现 A4 的前置也没移植"这种套娃里打转。

---

## 附录 A — 基线量化

对照基准：`v0.5.75` 的 981 个 `js/mjs/json` 文件（排掉 `tests/`），逐字节比对（忽略 CRLF）。

| 状态 | 数量 | 含义 |
|---|---|---|
| 与 v0.5.75 逐字节相同 | **651** | 已同步 |
| 只与 v0.5.69 相同 | **21** | 本窗口上游改过、我们没动 → **最干净的移植基线**（见附录 B） |
| 两边都不同 | **264** | 已分叉（我们自己的改动，或落后于更早的提交） |
| 我们完全没有 | **45** | 上游新增的文件（含 `gitbook/` 18 个与本窗口外的一些） |

> 快速重算：`node .tmp-sim.mjs`（见本轮脚本；需先 `git fetch upstream refs/tags/v0.5.69:... refs/tags/v0.5.75:... --no-tags`）。

## 附录 B — 两份可执行清单

### B.1 停在上个 tag、本窗口有改动（21 个，移植时三方基线干净）

```
open-sse/executors/codex.js
open-sse/executors/kiro.js
open-sse/executors/qoder.js
open-sse/handlers/imageProviders/codex.js
open-sse/handlers/videoCore.js
open-sse/providers/registry/api-airforce.js
open-sse/providers/registry/cline.js
open-sse/providers/registry/clinepass.js
open-sse/providers/registry/codex.js
open-sse/providers/registry/minimax-cn.js
open-sse/providers/registry/minimax.js
open-sse/providers/registry/openrouter.js
open-sse/providers/registry/vertex.js
open-sse/services/clinepassModels.js
open-sse/services/qoderModels.js
open-sse/services/usage/claude.js
open-sse/shared/clineAuth.js
open-sse/shared/qoder/constants.js
open-sse/translator/formats/gemini.js
open-sse/translator/request/claude-to-openai.js
src/app/api/models/test/ping.js
```

要点：`minimax.js` / `minimax-cn.js` 在这份名单里，意味着 A4（#3905）只需加一行 quirk；
`formats/gemini.js` / `claude-to-openai.js` / `usage/claude.js` 同属 B8 / B1 / B3 的干净基线。

### B.2 我们完全没有的文件（45 个）

本窗口相关的：

```
open-sse/handlers/videoProviders/index.js          (C1)
open-sse/handlers/videoProviders/openrouter.js     (C1)
open-sse/handlers/videoProviders/vertex.js         (C1)
open-sse/services/usage/antigravity-weekly.js      (B4)
open-sse/shared/clineEnvelope.js                   (B5)
open-sse/utils/codexToolSchema.js                  (A5)
open-sse/utils/claudeToolTypeSelfCheck.mjs         (A4 同族)
open-sse/shared/qoder/attachments.js               (C2)
open-sse/shared/qoder/contextTier.js               (C2)
open-sse/shared/qoder/sse.js                       (C2)
```

窗口外 / 与本次无关（供以后盘点）：`gitbook/`（18 个，上游自带的文档站 App）、
`open-sse/providers/{catalogOverride,visionPatterns}.js`、`open-sse/services/thoughtSignatureStore.js`、
`open-sse/utils/modelMarkers.js`、`open-sse/services/usage/{glm,groq,zed}.js`、
`src/lib/modelCatalog/sync.js`、`src/app/api/models/catalog-sync/route.js`、
`src/app/api/v1/models/[...model]/route.js`、`src/sse/services/antigravityQuota.js`、
`src/app/(dashboard)/dashboard/providers/[id]/BulkImportGrokCliModal.js`、
`src/app/api/oauth/grok-cli/bulk-import/route.js`、
`src/shared/components/NineRemote{Button,PromoModal}.js` 等。

