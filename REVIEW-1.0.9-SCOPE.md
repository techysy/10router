# 发版范围评审：1.0.9 / 1.1.0（草稿）

> 基线 `HEAD = 9a981d7d`（`main`）· 更新于 2026-09-10
> 用途：确认两个版本各装什么、能力库工作怎么分步落地、哪些事情未决。

---

## 0. 版本记账

### 0.1 1.0.8 = 第一个 tag 的内容

`v1.0.8` 这个 tag 一共被推了 **4 次**，每次触发部分 workflow：

| tag 指向 | 时间 | 结果 |
|---|---|---|
| **`1e16a748`** | 09-10 00:43:06Z | **4/4 全部 success**（docker + desktop + fpk + server）← 真正的 1.0.8 |
| `9ee15812` | 09-10 10:36:58Z | desktop/fpk/server success，docker cancelled |
| `792542d2` | 09-10 13:14:50Z | 4/4 全 cancelled |
| `eeeb4b73` | 09-10 13:16:31Z | fpk/server success，desktop/docker cancelled |

**由此产生的现状**（同一版本号下三份不同的东西）：

| 产物 | 实际来源 | 状态 |
|---|---|---|
| 4 个 `.fpk` + `server.tar.gz` | `eeeb4b73` | 含 CN 修复 + 倍率徽章 |
| 4 个 Windows 安装包 | `9ee15812` | 缺 CN 修复与徽章 |
| ghcr `:1.0.8` + `:latest` | `1e16a748`（00:45Z） | 落后约 16 个提交 |
| npm `@techysy/10router` | `1.0.7` | 1.0.8 未发布 |

**决定**：**不回补 1.0.8**（回补要再推 tag、再搅一次资产）。

### 0.2 分界点：倍率徽章

- **1.0.9** = 第一个 tag 之后 → **徽章之前**的 10 个提交（纯修复 + 文档）
- **1.1.0** = **从徽章（`0d60b431`）开始**的一切（徽章是这轮第一个新功能）

即：`0d60b431` 是分水岭 —— 它之后的（含 combos 截断修复、DeepSeek 能力修正、Step 1/2/3）全部计入 1.1.0。

---

## 1. 两个版本各装什么

### 1.0.9（修复版，10 个提交）

| 提交 | 内容 |
|---|---|
| `ec4e70c7` | `/v1/models` 500 `jsonCatalog is not defined`——JSON 目录下线残留悬空引用，存量自定义模型的供应商一进列表即崩 |
| `6aae8743` | 端点页安全门控/隧道状态/密钥轮换弹窗文案补 i18n（zh-CN 38 + zh-TW 39） |
| `1d2307bf` | 拉取/导入的模型默认禁用（按需启用）+ 仪表盘禁用区回显/恢复 + `/v1/models` 门控闭环 |
| `bb18fbc5` | JSON 目录残留清理（17 文件，−1450 行） |
| `53c255b7` | CodeBuddy CN/国际版静态模型目录对齐服务端（含 rateMultiplier 数据） |
| `10b385e3` | CodeBuddy CN 移除误挂的国际版 GPT/Gemini 家族 |
| `53775805` | CodeBuddy CN 模型目录对齐服务端信用页 |
| `3d52263c` | 根 vitest.config（测试链路） |
| `9ee15812` · `1d6c6afb` | 文档 |

> 待确认：`53c255b7` 是「新增功能」还是「修复」——它只是把目录对齐服务端，按修复算。若你认为它是新功能，则它也应移入 1.1.0（其余 9 个仍是 1.0.9）。

### 1.1.0（从徽章起）

| 提交 | 内容 |
|---|---|
| `0d60b431` | **Feat**：仪表盘模型列表显示积分倍率徽章（`eeeb4b73` 免费标签改小写 `free`） |
| `17d667dd` | Fix：容量适配器的模型列表不再截断（第 4 个起无法管理/移除） |
| `ed1e430f` | Fix：DeepSeek-V4.1-Flash 能力补全（1M / 384K 输出） |
| `9a981d7d` | Fix：DeepSeek V4 能力纠错（§3 Step 1） |
| `dc07954e` | Fix：models.dev 可查证的能力兜底补齐（47 → 21）+ 守卫测试（§4 Step 2） |
| `200939d4` | Fix：旧支 `Doubao-Seed-Code` 单列能力行（32k 上限），与 Seed-2.0-code 分开钉死（§4.2b） |
| `e71764f3` | Fix：移除已下架的 `stealth/ox-alpha`（实为 `glm-5.3-flash` 的测试马甲） |
| `d87207b2` | Chore：能力库审计脚本 `scripts/audit-capabilities.mjs` + CI 报告步骤（§5 Step 3） |
| 本次 | Chore：cursor 模型目录测试改为**离线**（mock `http2` 传输层），消除门禁随机抖动（§2.1） |
| `784a9e7b` · `fe51c336` · `1457cb03` · `4e83740f` · `2f914c60` | Docs：本评审文档、CLAUDE.md 审计说明 |

---

## 2. 能力库审计结论

方法：遍历 registry 全部 1031 个 chat 模型，复刻 `getCapabilitiesForModel()` 回退链，与真实返回值逐个比对。

分布：通配 699 / canonical 89 / provider 73 / 落兜底 170（剔媒体类后：864 个纯 chat 模型中 **47 个落兜底**）。

落兜底等于 `DEFAULT_CAPABILITIES`：`vision:false`（`modality.js:65` 静默剥图）· `reasoning:false` · `contextWindow:200000` · `maxOutput:64000`（`claude.js:334` 夹 `max_tokens`）· `tools:true`。

> ⚠️ **修正**：早先列的 `poolside` 两条「死条目」是**审计脚本的假阳性**——注册表里是 `poolside/laguna-s-2.1`（带供应商前缀），能力库键是 `laguna-s-2.1`；运行时按最后一段 baseModel 查得到（已实测命中 provider 行）。真正的死条目只有 `codebuddy-cn` 的 `glm-5.0`/`glm-4.7`，已在 Step 1 清掉。

### 2.1 回归门禁的随机抖动（已修）

排查记录，与能力库无关，但会随机把门禁刷红：

- `tests/unit/cursor-models.test.js` 的两条网络用例 mock 的是 `global.fetch`，而 `open-sse/services/cursorModels.js` 走的是 `node:http2`（`agent.api5.cursor.sh` 只支持 HTTP/2，undici 支持不了）——原 mock 是**死代码**，两条用例实际都在打真网络。
- 后果一：`fetches the account-specific catalog and caches it` 永远不可能通过（真端点对无凭证请求返回 415/403），已在 `known-fails.txt` 里。
- 后果二：`fails open when the Cursor catalog request fails` 靠「真实请求失败得快」通过；服务内部超时是 `FETCH_TIMEOUT_MS = 10s`，而 vitest 默认 `testTimeout` 是 **5s**，所以真请求一旦慢过 5 秒，用例就被 vitest 判超时，报 **`STACK_TRACE_ERROR`**（vitest 的超时哨兵 Error，位置指向 `it()` 所在行）。实测：全量跑 3 次里抖红 1 次；`--testTimeout=800` 可稳定复现同一条哨兵错误。
- 修复：改为 `vi.mock("http2")` 注入假传输层（假 session / 假 request），两条用例变成纯离线。文件耗时 **1608ms → 19ms**，连跑 5 次全绿；`fetches the account-specific catalog` 转为通过，已从 `known-fails.txt` 删除该条（41 → 40）。全仓库仅此一个文件存在「mock fetch 但实现走 h2」的问题（`open-sse/executors/cursor.js` 与 `services/cursorModels.js` 是唯一的 h2 使用方）。

---

## 3. Step 1 ✅ 已完成（`9a981d7d`）

| 项 | 结论 | 依据 |
|---|---|---|
| `deepseek-v4-pro` | 改 `vision:false`、`maxOutput:50000 → 384000` | 模型卡 text→text；models.dev 124 条命中一致 `attach:false`；Ark 第一方 `deepseek-v4-pro-ga-260813` |
| `deepseek-v4-flash` | 撤销 `vision:true`，落通配即得纯文本语义 | Ark 第一方 `deepseek-v4-flash-ga-260731`、多家 reseller 均 `attach:false` |
| `deepseek-v4-flash-vision-exp` | 提为 **canonical**，`vision:true` | 19 条 models.dev 一致（含 `huggingface/deepseek-ai/…`）；一行覆盖真正上架它的 4 家（commandcode / deepseek / opencode-go / B.AI） |
| `codebuddy-cn` 死行 | 删 `glm-5.0`、`glm-4.7` | 目录已下架 |

---

## 4. Step 2 ✅ 已完成

兜底数从 **47 → 21**（后续 `Doubao-Seed-Code` 结掉后为 **20**），且剩下的全部是「有意不声明」（见下）。`id 写着 vision 却 vision:false` 目前 0 条。

### 4.1 新增 canonical 行 13 条（`MODEL_CAPABILITIES`）

| id | 值（ctx / maxOut） | 关键点 | 来源 |
|---|---|---|---|
| `muse-spark-1.1` / `-1.2` / `-1.2-contributor` | 1048576 / 131072 | vision+video+pdf，reasoning | `meta/muse-spark-*`（与既有 `-1.2-contributor-free` 行同值） |
| `fugu-ultra` | 1000000 / 131072 | vision；输出取保守值 | `sakana/fugu-ultra` 第一方报 1000000（=无上限），reseller 一致报 131072 |
| `hy4-preview` | 1000000 / 64000 | **纯文本**（9 处来源全部 `in:text`） | 含第一方 `tencent-tokenhub/hy4-preview` |
| `gpt-audio` / `-mini` | 128000 / 16384 | `audioInput` + `audioOutput`，无视觉 | `kilo` + `openrouter` |
| `LongCat-2.0` | 1000000 / 131072 | 纯文本 | `longcat`（第一方） |
| `sensenova-6.8-flash-lite` | 262144 / 65536 | vision | `sensenova`（第一方） |
| `venice-uncensored-1-2` | 128000 / 8192 | vision，无 reasoning | `venice`（第一方） |
| `morph-v3-large` / `-fast` | 32000/32000、16000/16000 | **`tools:false`**（第一方明说不支持工具） | `morph`（第一方） |

写 canonical 而非 provider 行的理由：这些 id 是模型自身的名字，reseller（commandcode / tokenrouter / kilo / cline …）随时可能挂同一个 id，一行覆盖全部；带 vendor 前缀的写法按 baseModel 也能命中。`thinkingFormat` 一律 `openai`（这些上游都是 OpenAI 兼容网关，与既有 `big-pickle` / `agnes-2.5-*` 行同口径）。

`codebuddy-cn` 的 `hy4-preview` provider 行**保留**（`thinkingCanDisable:false` 是 CN 服务端口径），仅去掉错误的 `vision:true`。

> 曾为 `ox-alpha` 写的一行已撤（`e71764f3`）：该 id 已下架，实为 `z-ai/glm-5.3-flash` 的**测试马甲**（正式 id 就在同一份 commandcode 目录里），同步从注册表删除了该条目。

### 4.2 新增 pattern 行 8 条（ByteDance Doubao-Seed 2.0 家族）

`*seed-2-0-{pro,code,mini,lite}*` + `*seed-2.0-{…}*`（同一模型各家写法不同：reseller 用 `seed-2-0-*` 且快照日期各异，Ark 控制台用 `Doubao-Seed-2.0-*`）。值取第一方 `volcengine` 条目，按族归并以免每来一个新快照日期就补一行：

| 族 | ctx / maxOut |
|---|---|
| pro | 256000 / 128000 |
| code | 262144 / 131072 |
| mini / lite | 256000 / 131072 |

全部 vision + videoInput + reasoning + tools。

### 4.2b 新增 pattern 行 1 条（旧支 `seed-code`）

`*seed-code*` → 256000 / **32768**，vision + reasoning，**不给 videoInput**。

火山方舟模型列表（第一方）里 `doubao-seed-code-preview-251028` 被标注**「即将下线」**，规格为「上下文窗口 256k / 最大输入 224k / 最大回答（默认 4k）32k / 最大思维链 32k」，能力为 深度思考 · 多模态理解 · 视觉定位 · 工具调用。它是**独立一支**，与 Seed-2.0 系列的 `code`（`doubao-seed-2-0-code-preview-260215`，262144 / 131072）不是同一模型；`*seed-code*` 与 `*seed-2-0-code*` 无公共子串，不会互相命中。reseller `zenmux` 报 64000 输出，偏大不取（32k 是保守下限，宁可少给不可越界）。

### 4.3 明确不写行（20 个，写入守卫测试的 allowlist 并注明理由）

| 类别 | 条目 | 理由 |
|---|---|---|
| 聚合器/元选择器（8） | `qoder/{auto,efficient,lite}`、`cursor/default`、`bazaarlink/auto:free`、`kilo-gateway/kilo-auto/{free,frontier,balanced}` | 上游每次请求自己挑真模型，静态表给不出准确值；沿用原逻辑落兜底 |
| 私有代号（7） | `github/oswe-vscode-prime`、`github/goldeneye-free-auto`、`iflow/iflow-rome-30ba3b`、`dots/dots3-note-prev`、`morph/morph-dsv4flash`、`tokenrouter/miromind/mirothinker-1-7-*` ×2 | 无公开规格、models.dev 无条目 |
| 证据冲突暂缓（2） | `kilo-gateway/kwaipilot/kat-coder-pro-v2.5:free`、`cline/kwaipilot/kat-coder-pro` | 见 §7.3 |
| 非 chat 端点（3） | `sensenova/sensenova-u1.5-lite`、`sensenova/sensenova-u1-fast`、`venice/venice-sd35` | 注册表标 `kind:"image"`（text2img），由媒体处理器分发，不需要 chat caps |

### 4.4 守卫测试（新增 `tests/unit/capability-floor-allowlist.test.js`）

另新增 `tests/unit/doubao-seed-capabilities.test.js` 4 条断言，遍历注册表把 Seed-2.0 家族与旧支 `seed-code` 分开钉死（含「两个 Ark 显示名不得塌成同一个」）。

替代原先打算写的生成器脚本——手写映射比模糊自动匹配更准（审计中已出现过 `qoder/auto` 被误配到 `md morph/auto` 的假阳性）。5 条断言：

1. **自检**：测试侧回退链与 `getCapabilitiesForModel()` 对**全部注册表模型**逐一比对，不一致即失败（把审计时"matcher-mismatches = 0"的验收固化下来）。
2. 任何 chat 模型若落兜底且不在 allowlist → 失败（新增模型必须显式表态）。
3. allowlist 里出现「已有行」的过期条目 → 失败。
4. 以 `media` 为由放行的条目，注册表必须真的是媒体 `kind`。
5. 名字含 `vision`/`-vl-`/`omni` 的 id 不得解析成 `vision:false`（唯一豁免：暂缓的 nemotron nano-omni）。

---

## 5. Step 3 ✅ 已完成（`d87207b2`）——不写生成器，改为审计脚本 + CI

原本计划的 `scripts/sync-capabilities.mjs`（自动从 models.dev 填值）**不做**：手写映射比模糊自动匹配更准（审计中已出现过 `qoder/auto` 被误配到 `md morph/auto` 的假阳性），而且守卫测试已保证「新模型必须显式表态」。取而代之：

- 新增 `scripts/audit-capabilities.mjs`：**纯离线**（不联网、无依赖、不写文件、不读 models.dev 快照）。回放与 `getCapabilitiesForModel()` 相同的回退链，输出四张表——兜底模型（附 allowlist 理由）、名字含 `vision`/`vl`/`omni` 却解析成 `vision:false`、图片输出却没 `imageOutput`、provider 行里对已下架模型的死条目。支持 `--check`（有违例则退出码 1）。
- 它同时是 floor allowlist 与解析链复刻的**唯一定义**：守卫测试改为 import 之，避免「脚本一份、测试一份」将来走偏。
- `.github/workflows/test.yml` 在注册表基线之后增加一步 `Capability audit`（`node --no-warnings`，只报告不拦门），每次推送都能在 CI 日志里看到当前状态；门禁仍由 vitest 用例负责。
- 死条目检查这次按 baseModel 做了供应商前缀归一化，修掉了上一版审计脚本把 `poolside/laguna-s-2.1` 误判成死条目的假阳性——当前报告为 0。

---

## 6. 已拍板决策

1. **`thinkingFormat` 不改**（原提议"把 `*deepseek-v4*` 通配拆成 provider 行"经数据核对后**不必要**）：20 家上架 `deepseek-v4*` 的 provider 里，17 家用通配给的 `deepseek` 形状（发 `thinking:{type}` + 归一化 `reasoning_effort`），其中包括火山方舟这类中国平台——本就是该平台的约定；只有 codebuddy-cn / nvidia / apinex / amd 各自有 `openai` 行，这正是"provider 行优先于通配"的既有分层设计。
2. **聚合器别名不写行**：维持落 `DEFAULT_CAPABILITIES` 的原逻辑，只在守卫测试里显式列 allowlist。
3. **`hy4-preview` 是纯文本**（9 处来源佐证），CN 行的 `vision:true` 已去掉。
4. **1.0.9 / 1.1.0 分界在徽章**（§0.2）。
5. **`ox-alpha` 是马甲**：已下架，实为 `glm-5.3-flash` 的测试马甲 → 注册表条目与能力行都已删（§4.1）。
6. **不做能力库生成器**：改为纯离线审计脚本 + CI 报告步骤（§5）。
7. **旧支 `seed-code` 与 Seed-2.0 `code` 分开声明**（用户提供火山方舟模型列表作第一方依据）：旧支已标「即将下线」，32k 输出上限；两者互不套用（§4.2b）。
8. **cursor 模型目录测试改为离线**：它 mock 的 `global.fetch` 从未被使用（实现在 `cursorModels.js` 里走 `node:http2`，因为 `agent.api5.cursor.sh` 只支持 h2），所以两条用例一直在打真网络 → 一条永远不可能通过（已在 known-fails）、另一条“赌真实请求失败得快”随机把门禁刷红（§2.1）。现改 mock `http2` 传输层，文件耗时 1608ms → 19ms，`known-fails` 41 → 40。

---

## 7. 未决事项

1. **`nemotron`（已定）**：`nemotron-3-ultra` 系列（`nemotron-3-ultra-free` 行 + `*nemotron*` 通配）在我们表里本来就是纯文本 ✓；另一模型 `nemotron-3-nano-omni-30b-a3b-reasoning:free` 虽有多家来源报多模态，但**按用户决定不动**（落 `*nemotron*` 通配＝纯文本，图片会被剥掉）。已记入审计脚本的 `DISPUTED`，不再作为待办。
2. **nvidia 的 `deepseek-ai/deepseek-v4-*`**：仓库写 `maxOutput:65536`（作者为 NIM 特意声明，注释说明「OpenAI 兼容、拒原生 thinking 字段」），而 models.dev 的 nvidia 条目报 393216。是保守值还是笔误？未动。
3. **`kat-coder-pro-v2.5` / `kat-coder-pro`**：vercel 报 256000/80000 · text+image · reasoning；kilo/openrouter 报 262144/235929 · text-only · 无 reasoning。输出上限差 3 倍且工具/推理支持不一致，等第一方（kwaipilot）说明。
4. **`Doubao-Seed-Code`（已定）**：经用户提供的火山方舟模型列表确认，它是**独立一支**旧模型（`doubao-seed-code-preview-251028`，官方标「即将下线」），不是 `doubao-seed-2-0-code-preview` → 已单列 `*seed-code*` 行（§4.2b），并加守卫测试防塌陷。**待你决定**：该条目是否像 `ox-alpha` 那样从注册表直接删掉（它当前仍可调用，只是官方已预告下线）。
5. **1.0.8 的 GitHub Release 备注**：目前描述的 CN 修复/徽章按记账属于 1.0.9/1.1.0。是否把 1.0.8 备注裁到第一个 tag 的内容？
6. **更新日志分区**：`CHANGELOG.md` 与三语 `public/i18n/changelog/*.md` 的 v1.0.8 段落里，有 5 个提交（`9ee15812`/`10b385e3`/`792542d2`/`eeeb4b73`/`1945f2fa`）补进去的条目，需按 1.0.9 / 1.1.0 重新分区。发版前一次性搬。
7. **npm**：`1.0.7 → ?` 跳版发布，需显式授权（若先发 1.0.9 则发 1.0.9）。
8. **gitee 镜像**：落后约 22 个提交，是否随发版一起推。

---

## 8. 发版清单

**1.0.9**（先发，纯修复）

- [ ] 版本号：根 `package.json`、`cli/package.json`、`desktop/package.json`、其它内嵌位置
- [ ] `CHANGELOG.md` 新开 `## v1.0.9`（只含 §1 那 10 个提交）
- [ ] 三语 `public/i18n/changelog/{en,zh-CN,zh-TW}.md`
- [ ] 全量测试 + 回归门禁（`tests/__baseline__/verify-no-regression.mjs`）
- [ ] `git tag v1.0.9 && git push origin v1.0.9`（**一次到位，不再前移**）
- [ ] 4 条 workflow 全绿；逐个核对资产来源（ghcr 读 `org.opencontainers.image.revision`）
- [ ] GitHub Release 备注
- [ ] `npm run cli:pack` → `npm publish`（授权后）

**1.1.0**（1.0.9 之后）

- [ ] 同上流程，tag `v1.1.0`；内容 = 徽章 + combos 修复 + DeepSeek 能力修正 + Step 1/2/3
- [ ] 本评审文档随本次提交归档
