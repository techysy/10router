# 1.0.9 发版范围评审（草稿）

> 基线 `HEAD = 9a981d7d`（`main`）· 更新于 2026-09-10
> 用途：确认 1.0.9 要装什么、能力库工作怎么分步落地、哪些事情未决。

---

## 0. 版本记账：1.0.8 = 第一个 tag，其后一切归 1.0.9

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

**决定**：不回补 1.0.8（回补要再推 tag、再搅动资产）。把第一个 tag 之后的一切作为 **1.0.9** 发一次，由这一次全量重刷四个产物 + npm + ghcr `latest`。**1.0.9 的 tag 一次推到位，不再前移。**

---

## 1. 1.0.9 的内容（第一个 tag 之后的 16 个提交）

**修复 8 项**

| 提交 | 内容 |
|---|---|
| `ec4e70c7` | `/v1/models` 500 `jsonCatalog is not defined`——JSON 目录下线残留悬空引用，存量自定义模型的供应商一进列表即崩 |
| `6aae8743` | 端点页安全门控/隧道状态/密钥轮换弹窗文案补 i18n（zh-CN 38 + zh-TW 39） |
| `1d2307bf` | 拉取/导入的模型默认禁用（按需启用）+ 仪表盘禁用区回显/恢复 + `/v1/models` 门控闭环 |
| `10b385e3` | CodeBuddy CN 移除误挂的国际版 GPT/Gemini 家族 |
| `53775805` | CodeBuddy CN 模型目录对齐服务端信用页 |
| `17d667dd` | 容量适配器的模型列表不再截断（第 4 个起无法管理/移除） |
| `ed1e430f` | DeepSeek-V4.1-Flash 能力补全（1M / 384K 输出） |
| `9a981d7d` | DeepSeek V4 能力纠错（见 §3 Step 1） |

（8 项，上表含 Step 1）

**新功能 2 项**

| 提交 | 内容 |
|---|---|
| `53c255b7` | CodeBuddy CN/国际版静态模型目录对齐服务端（含 rateMultiplier） |
| `0d60b431` | 仪表盘模型列表显示积分倍率徽章（`eeeb4b73` 改为小写 `free`） |

**其余 6 项**：`bb18fbc5` JSON 目录残留清理、`3d52263c` 测试链路、`9ee15812`/`1d6c6afb`/`792542d2`/`1945f2fa` 文档。

---

## 2. 能力库审计结论（已修正）

方法：遍历 registry 全部 1031 个 chat 模型，复刻 `getCapabilitiesForModel()` 回退链，与真实返回值逐个比对，**matcher-mismatches = 0**。

分布：通配 699 / canonical 89 / provider 73 / 落兜底 170（剔媒体类后：864 个纯 chat 模型中 **47 个落兜底**）。

落兜底等于 `DEFAULT_CAPABILITIES`：`vision:false`（`modality.js:65` 静默剥图）· `reasoning:false` · `contextWindow:200000` · `maxOutput:64000`（`claude.js:334` 夹 `max_tokens`）· `tools:true`。

> ⚠️ **修正**：早先列的 `poolside` 两条「死条目」是**审计脚本的假阳性**——注册表里是 `poolside/laguna-s-2.1`（带供应商前缀），能力库键是 `laguna-s-2.1`；运行时按最后一段 baseModel 查得到（已实测命中 provider 行）。真正的死条目只有 `codebuddy-cn` 的 `glm-5.0`/`glm-4.7`，已在 Step 1 清掉。

---

## 3. Step 1 ✅ 已完成（`9a981d7d`）

| 项 | 结论 | 依据 |
|---|---|---|
| `deepseek-v4-pro` | 改 `vision:false`、`maxOutput:50000 → 384000` | 模型卡 text→text；models.dev 124 条命中一致 `attach:false`；Ark 第一方 `deepseek-v4-pro-ga-260813` |
| `deepseek-v4-flash` | 撤销 `vision:true`，落通配即得纯文本语义 | Ark 第一方 `deepseek-v4-flash-ga-260731`、多家 reseller 均 `attach:false` |
| `deepseek-v4-flash-vision-exp` | 提为 **canonical** `MODEL_CAPABILITIES`，`vision:true` | 19 条 models.dev 一致（含 `huggingface/deepseek-ai/…`）；一行覆盖真正上架它的 4 家（commandcode / deepseek / opencode-go / B.AI） |
| `codebuddy-cn` 死行 | 删 `glm-5.0`、`glm-4.7`；不再为旧 `deepseek-v4-flash` 留行 | 目录已下架，本表留行是残留 |
| 测试 | 新增 `tests/unit/deepseek-v4-capabilities.test.js`（遍历注册表按 vision 名分组断言，自动覆盖将来新上架的 provider）；`codebuddy-cn-models.test.js` 两条用例改写 | 12/12 绿，ESLint 干净 |

审计复跑后，`id 写着 vision 却 vision:false` 只剩一条：`tokenrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`（证据矛盾，见 §6）。

---

## 4. 两项已拍板的决策

1. **`thinkingFormat` 不改**（原提议"把 `*deepseek-v4*` 通配拆成 provider 行"经数据核对后**不必要**）：
   20 家上架 `deepseek-v4*` 的 provider 里，17 家用通配给的 `deepseek` 形状（发 `thinking:{type}` + 归一化 `reasoning_effort`），其中包括火山方舟这类中国平台——本就是该平台的约定；只有 codebuddy-cn / nvidia / apinex / amd 各自有 `openai` 行，这正是"provider 行优先于通配"的既有分层设计，不是层间不一致。**行为不动。**
2. **聚合器别名不写行**：`qoder/{auto,efficient,lite}`、`cursor/default`、`bazaarlink/auto:free`、`kilo-auto/*` 等"上游自己挑真模型"的 id，静态表给不准，维持落到 `DEFAULT_CAPABILITIES` 的原逻辑，只在守卫测试里显式列 allowlist（写明是"有意为之"）。

---

## 5. Step 2 — 用 models.dev 生成补丁（待做）

数据源 `https://models.dev/api.json`（213 provider / 4.5MB），按「供应商 + 模型」组织，字段一一对应：
`limit.context`/`limit.output` · `modalities.input`（vision/audio/video/pdf）· `reasoning` + `reasoning_options[].values`（= thinkingLevels 的 efforts）· `tool_call` · `attachment`。

实测覆盖：47 个落兜底模型里 **20 个可直接查全**，22 个查不到（其中约一半只是 id 命名不同——byteplus/tokenrouter 的 `seed-2-0-*` 与 `volcengine-ark/Doubao-Seed-2.0-*` 就是第一方 `volcengine/doubao-seed-2-0-*`，仅快照日期不同），**真无源的私有代号约 7 个**（`oswe-vscode-prime`、`goldeneye-free-auto`、`iflow-rome-30ba3b`、`dots3-note-prev`、`morph-dsv4flash`、`cursor/default`、`bazaarlink/auto:free`）。

⚠️ 必须避的坑：裸 id 跨 provider 模糊匹配会出假阳性（审计中 `qoder/auto` 被匹配到 `md morph/auto`）。生成器必须先做 provider 映射、再在 provider 内匹配。

可补的 20 条（示例值）：`LongCat-2.0` 1000000/131072 · 纯文本 · reasoning · tools；`morph-v3-large|fast` 32000/32000、16000/16000 · **tools:false**；`meta/muse-spark-1.1|1.2` 1M/65536 · text+image+video+audio(+pdf)；`sakana/fugu-ultra` 1M/16384 · text+image；`stealth/ox-alpha` 1M/131072 · text+image+video；`kat-coder-pro-v2.5` 256000/80000 · text+image；`sensenova-6.8-flash-lite` 262144/65536 · text+image；`kilo-auto/{free,frontier,balanced}` 256K/10000 · 1M/131072 · 1M/65536；`venice-uncensored-1-2` 128000/8192 · text+image。

### Step 3 — 生成器 + 守卫测试（待做）

- `scripts/sync-capabilities.mjs`（dev-time，不引入运行时依赖）：显式 provider 映射 + id 规范化；只输出「缺失/冲突」diff 报告；优先第一方条目，第三方多家冲突时报警而非静默取值。
- 守卫测试：遍历 registry 断言 (a) 不落兜底（allowlist 除外）(b) 名字含 `vision/vl/omni` 不得 `vision:false`（Step 1 已按此思路建立 deepseek 版）(c) 同 id 跨 provider 的 caps 一致（需排除 provider 特意的覆盖行）。

---

## 6. 未决事项

1. **`nemotron-3-nano-omni-30b-a3b-reasoning:free`**（tokenrouter）：requesty 报 `text+image+video+audio`，vultr 同模型报 text-only。证据矛盾，暂缓。
2. **`hy4-preview`**：models.dev 两处（`tencent-tokenhub`、nano-gpt）都说 **text-only**（attach false），而 `codebuddy-cn` 行写的是 `vision:true`。冲突→未提为 canonical，`commandcode/tencent/hy4-preview` 与 `codebuddy-intl/hy4-preview` 仍落兜底。
3. **nvidia 的 `deepseek-ai/deepseek-v4-*`**：仓库写 `maxOutput:65536`（作者为 NIM 特意声明，注释说明「OpenAI 兼容、拒原生 thinking 字段」），而 models.dev 的 nvidia 条目报 393216。是保守值还是笔误？未动。
4. **1.0.8 的 GitHub Release 备注**：目前描述的 CN 修复/徽章按上面的记账属于 1.0.9。是否把 1.0.8 备注裁到第一个 tag 的内容、避免 1.0.9 重复叙述？
5. **更新日志分区**：`CHANGELOG.md` 与三语 `public/i18n/changelog/*.md` 的 v1.0.8 段落里，有 5 个提交（`9ee15812`/`10b385e3`/`792542d2`/`eeeb4b73`/`1945f2fa`）补进去的条目，按记账应移入新的 `## v1.0.9` 段。建议在 1.0.9 发版前一次性搬。
6. **npm**：`1.0.7 → 1.0.9` 跳版发布，需显式授权。
7. **gitee 镜像**：落后约 22 个提交，是否随 1.0.9 一起推。

---

## 7. 1.0.9 发版清单

- [ ] 版本号四处同步：根 `package.json`、`cli/package.json`、`desktop/package.json`、其它内嵌位置
- [ ] `CHANGELOG.md` 新开 `## v1.0.9`（并把 §6.5 的条目从 v1.0.8 搬过来）
- [ ] `public/i18n/changelog/{en,zh-CN,zh-TW}.md` 三语用户向更新
- [ ] 全量测试 + 回归门禁（`tests/__baseline__/verify-no-regression.mjs`），基线按需重刷
- [ ] `git tag v1.0.9 && git push origin v1.0.9`（**一次到位**）
- [ ] 4 条 workflow 全绿：`build-fpk` / `build-server` / `build-desktop-win` / `docker-publish`
- [ ] 逐个核对资产来源（ghcr 可读 `org.opencontainers.image.revision`）
- [ ] GitHub Release 备注（`action-gh-release` 复用已有 release；`build-server.yml` 故意不写 `name/body`，别覆盖手写备注）
- [ ] `npm run cli:pack` → `npm publish`（授权后）
- [ ] 可选：gitee 镜像同步
