# 组合决策路由（Router 策略）技术报告

> 面向维护者：决策路由的内部机制、协议契约、失败模式与调优手段。
> 用户视角的四种组合策略对比见 `routing-strategy-and-combos-guide.md` §4；本文只讲实现与排障。

---

## 一、它是什么

组合的 `router` 策略在成员模型前面插一次**决策调用**：一个 System One 决策模型读请求，从候选成员里选一个，然后**只有被选中的成员**真正回答。

这有两种本质区别，决定了它不会被做成"裁判模型"：

| | 融合（fusion）裁判 | 决策路由（router） |
|---|---|---|
| 模型输出 | 自然语言答案 | 类型化概率分布（`noul` / `choice` / `score`） |
| 作用 | 综合多个答案 | 只选人，**不参与回答** |
| 成本 | N + 1 次主调用 | 1 次廉价决策 + 1 次主调用 |

因为决策模型输出的是分布而非文本，把它当裁判用会得到一堆选择题答案。这是设计上的硬边界（issue #73 "非目标"）。

---

## 二、调用链

```
/v1/chat/completions
  └─ src/sse/handlers/chat.js            ← 策略判定 + 选中后重排
      └─ src/sse/handlers/comboRouter.js  ← 编排：凭证、健康度、日志
          └─ open-sse/handlers/systemoneCore.js  ← 决策端点转发（原样透传 body）
              └─ POST <provider>.systemoneConfig.baseUrl
                  └─ open-sse/services/combo/router.js  ← 纯函数：payload / 解析 / 守卫
```

**职责切分**：`open-sse/services/combo/router.js` 是纯函数（可单测、无 IO），`comboRouter.js` 负责 `src/sse` 侧的凭证与日志粘合。跨这条边界是刻意的——引擎侧不应依赖 app 的 auth 胶水。

### 2.1 生效条件

`chat.js` 仅在 `comboStrategy === "router"` 时进入决策路径：

```js
const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
```

`routerModel` 取自 `comboStrategies[modelStr].routerModel`，在组合页手动选择，选择器只列 `kind:"systemone"` 的模型。

**两者缺一即降级**：策略不是 `router` → 整个决策被跳过；`routerModel` 为空 → `decisionOnce` 首行返回 null。

### 2.2 选中之后

```js
const ordered = [picked, ...augmentedModels.filter((m) => m !== picked)];
return handleComboChat({ models: ordered, comboStrategy: "fallback", ... });
```

被选成员置顶，**其余成员保持原顺序**，并以 `fallback` 策略继续跑。即：决策只决定"先试谁"，不取消后续容错。这是"决策失败 / 选中成员挂掉"都不会导致请求失败的根基。

---

## 三、协议契约（最容易踩的坑）

决策端点走 System One 协议，**不走 chat 翻译层**。`systemoneCore` 只做 `{ ...body, model }` 后原样转发。

### 3.1 `choice` 题的形状

```json
{
  "state": "User request: ...\nCandidate models (pick exactly one id):\n- ...",
  "questions": {
    "pick_model": {
      "type": "choice",
      "instructions": "Pick the single best candidate model id to answer this request.",
      "criteria": {
        "cbai/deepseek-v4.1-flash": null,
        "cbcn/deepseek-v4.1-flash": null
      }
    }
  }
}
```

**关键约束（Drex 官方 schema，实测验证）**：

| 字段 | 规则 |
|---|---|
| `criteria` | **必填，必须是对象**。传数组或字符串报 `must be an object with options` |
| `criteria` 的键 | 即返回的 `choice` 标签，至少 1 个 |
| `criteria` 的值 | `string \| null`。传数字/对象报 `must be a string or null` |
| `options` | **不存在这个字段**，早期实现误用导致每次 422 |

> 描述一律传 `null`：每条描述都计入 `input_tokens`，而成员能力卡已经在 `state` 里了。

**键冲突陷阱**：`criteria` 是对象键，两个 id 若共享 64 字符前缀会被合并成一个选项，**静默缩小候选集**。因此长 id 不截断（API 对 `choice` 标签长度无限制），`ANSWER_CAP` 只在无损时生效。

### 3.2 响应形状

```json
{
  "model": "drex-v1.0",
  "answers": {
    "pick_model": {
      "type": "choice",
      "choice": "cbai/deepseek-v4.1-flash",
      "confidence": 0.986,
      "probabilities": { "cbai/...": 0.9895, "cbcn/...": 0.005, ... }
    }
  },
  "usage": { "input_tokens": 106, "output_tokens": 212 }
}
```

解析链：

1. `parseRouterDecisionResult()` — 取出 `answers.pick_model.choice`，防御式兼容 `choices[]` / `value` / `text` / `selected` 等变体；
2. `guardRouterPick()` — 必须在候选集内；容忍**唯一**的裸尾匹配（答 `gpt-5.2` 接受 `gpt/.../gpt-5.2`），歧义或零命中 → null；
3. `parseRouterDecisionMeta()` — **仅日志用途**，读 `confidence` 与次优候选，不参与路由。

### 3.3 决策成本入账

决策是真实上游调用，`saveRequestUsage()` 把它写进用量台账，因此"每请求 +1 次调用"在用量页可见。`total_tokens` 由 `prompt_tokens + completion_tokens` 合成（System One 返回的是 `input_tokens/output_tokens`，`systemoneCore` 做了映射）。

---

## 四、健康度：排除信号，不是排序分

这是本模块最容易做错、也最容易在无感知中退化的地方。

### 4.1 曾经的错误做法

有流量的成员卡上渲染 `health 91/100 (success 97%)`，没流量的成员**什么都不渲染**。

决策模型看到"一个明确 91 分、一个不说话"，会稳定选有分数的那个。于是：

```
没被调用 → 没数据 → 卡上无评分 → 决策模型不选 → 更没数据 → ...
```

**冷成员因为"新"而被系统性扣分**，形成自我强化的边缘化。这比不给信号更糟：它不是"没有权重"，而是**隐性负权重**。

### 4.2 现在的语义

```js
const flaky = info?.health != null && info.health < FLAKY_HEALTH_THRESHOLD; // 70
const mark = flaky ? ` [recently flaky: ${health}/100 over recent traffic, ${rate}% success]` : "";
```

- **只标注确定在失败的**（`< 70`）；
- **健康成员与无数据成员卡片完全一致**——这才是决策时刻真实的认知状态：你知道谁在坏，不知道谁没测过；
- `state` 末尾附显式判定规则，避免模型自己发明排序：

```
How to choose: prefer a member whose capabilities fit the request (...).
A member marked [recently flaky] should be avoided when an equally capable
unmarked member exists. Unmarked members either have good recent health or
no recent traffic data — absence of a mark is NOT a quality penalty.
```

**"不编造数字"的承诺保留**——没有数据就不写数字；补上的是原注释承诺过的 "say so"。

### 4.3 数据来源与门槛

```js
const dash = await getUsageDashboard({ minRequests: 10 });
byKey.set(`${m.provider}|${m.model}`, { health: m.score, successRate: m.successRate });
```

- 来源：用量看板同一批行（`src/lib/db/repos/usageRepo.js`，`score = successRate*0.6 + latency*0.2 + speed*0.2`）；
- 门槛：**请求数 < 10 的模型不进入结果集**，即视为"无数据"；
- 缓存：`healthCache` **60 秒 TTL**，进程级，避免每请求跑一次重查询。

门槛降到 3 并不会让结果更好——3 次样本的 `successRate` 噪声极大，反而误导决策。在健康度改为排除信号之后，门槛高低的影响已经小很多。

### 4.4 已知局限：没有探索机制

A+B（排除信号 + 显式规则）**消除了冷成员被低估**，但**没有主动给它机会**。两个能力相同、都未标记的成员，决策模型只能按先验选。观测到的现象是：`cbai/...` 与 `cbcn/...` 能力完全相同，7 次决策全部选了前者。

若希望新成员也能分到流量攒数据，需要额外的**探索性补偿**（例如在 state 里提示"偶发优先选择无流量记录成员以收集数据"，或代码层给冷成员加权）。这是一个策略选择，尚未实现。

---

## 五、失败模式与降级契约

**总原则**：决策是 advisory 的，任何失败都退回到**未经改动的 fallback 顺序**，绝不让决策路径导致 4xx。决策位于首 token 之前，因此有独立的紧预算。

| 失败模式 | 处理 | 有日志 |
|---|---|---|
| 策略非 router | 不进入 | —（设计内） |
| `routerModel` 为空 | 直接返回 null | ❌ **静默**（见 §6.1） |
| 无法解析 provider | 降级 | `router: unknown routerModel '...'` |
| 无可用凭证 | 不调用 | `router: no usable credentials for ...` |
| 上游非 2xx | 降级 | `router: decision failed (status: msg)` |
| 答案在候选集外 | 降级 | `router: decision picked '...' outside the candidate set` |
| 断言/JSON 异常 | 吞掉 | `router: decision errored (...)` |
| **超过 8s** | race 成 null | ❌ **静默**（见 §6.1） |

超时预算：`COMBO_ROUTER_DECISION_TIMEOUT_MS`，默认 `8000`,远短于上游 `FETCH_CONNECT_TIMEOUT_MS`。慢决策按降级处理，而不是拖住组合。

---

## 六、排障手册

### 6.1 只有 `router degraded`、没有原因行

`comboRouter.js` 里有两条**不打日志**的降级路径：

```js
if (!routerModel || !candidates?.length) return null;   // 静默
// withDecisionTimeout():
setTimeout(() => resolve(null), DECISION_TIMEOUT_MS);   // 静默
```

看到"degraded 但没有前因"时，按顺序排查：

1. **冷启动窗口**。`deploy` 后服务重启，短时间内 `comboStrategies` 可能还没就绪。实测：重启后 18s / 44s 各有一次静默降级，之后全部正常。**不是 Drex 的问题**。
2. **配置未落**。查库：`sudo strings <data.sqlite> | grep -o '"<combo>":{[^}]*}'`,确认 `routerModel` 存在。
3. **真超时**。对比请求开始到 `degraded` 的间隔是否接近 8s。

> 改进建议（未实施）：给这两条路径各补一条 warn，与其他分支对称。

### 6.2 决策一直失败

按错误码分流：

| 现象 | 原因 | 处置 |
|---|---|---|
| `429 Rate limit exceeded` | 决策模型通道限流（如 `oc/jev-1.13-free` 免费层） | 换付费/健康模型 |
| `422 ... Endpoint is unavailable` | 上游通道不可用 | 同上 |
| `422 questions.pick_model.criteria: must be an object with options` | **payload 用了 `options`**（旧版 bug） | 升级到带 criteria 的版本 |
| `502 UND_ERR_CONNECT_TIMEOUT` | 网络/代理不可达 | 查代理 |

**验证决策模型 key 是否可用**：让请求打到鉴权层即可——Drex 对无 key / 假 key 都返回 `401`：

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://drex.nace.ai/v1/systemone \
  -H "Content-Type: application/json" -H "Authorization: Bearer nace_sk_invalid" \
  -d '{"model":"drex-v1.0","state":"x","questions":{"q":{"type":"noul","instructions":"t"}}}'
```

> ⚠️ 各家鉴权顺序不同，**不要**用"非 401 即通过"作判据。实测 **THX-01 对未带 key 的请求返回 404 且 body 是完整决策结果**——按该判据会把空 key / 任意假 key 判为有效。

### 6.3 日志怎么读

```
router: drex/drex-latest → cbai/deepseek-v4.1-flash of 6 candidates (conf 0.52, next gpt/gpt-5.2 0.41)
```

| 字段 | 含义 |
|---|---|
| `→ <member>` | 被选中的成员 |
| `of N candidates` | 本次参与决策的候选数 |
| `conf 0.52` | 决策模型对该选择的置信度 |
| `next <member> 0.41` | 次优候选及其概率 |

`conf` 低且 `next` 接近 → 近似平局，同一问题再问**可能给出不同答案**（见 §7）。`conf` 常年很高但仍选错 → 问题出在 `state` 的描述上，而非决策模型。

---

## 七、缓存与缓冲

| 层 | 是否缓存 | 说明 |
|---|---|---|
| **决策结果** | ❌ **无** | 每个请求都真实调用一次决策模型 |
| 健康度数据 | ✅ 60s | `healthCache` 进程级，重查询成本高 |
| 成员能力卡 | ❌ 每次 | 每成员一次 `getModelInfo` + `getCapabilitiesForModel` |
| 凭证 | 由 auth 层管理 | 本模块只消费 |

**没有决策结果缓存是刻意的**：决策模型返回的是概率分布，同一 prompt 复用结果会让流量固化在一个成员上，失去按请求内容适配的意义。代价是每次请求都有一次决策往返（约 1–2s 观测值），以及"同一问题可能得到不同答案"的不确定性。

---

## 八、决策模型的接入要求

一个 provider 要能被选为决策模型，需要：

1. 注册表里 `serviceKinds` 含 `systemone`;
2. 有 `systemoneConfig.baseUrl`（或连接的 `providerSpecificData.baseUrl` 覆盖）；
3. 模型条目 `kind: "systemone"`——组合页选择器按此过滤。

**连接测试**：纯 System One provider（`serviceKinds` 全为 `systemone`，如 drex / v1m / thx）走专用探针，发一个最小 `noul` 决策到端点，判据为 **2xx / 400 / 422 才通过**（404 不通过，见 §6.2 的 THX 反例）。双面 provider（codiv / openrouter）仍走各自的 `/models` 探针，`every()` 守卫保证不被劫持。

---

## 九、测试覆盖

`tests/unit/combo-router.test.js`（24 例）

| 组 | 覆盖 |
|---|---|
| payload | 候选全集、工具意图、能力卡、**criteria 键集**、长 id 前缀冲突、空消息 |
| 健康度语义 | 健康/冷成员卡片一致、flaky 标记、**70 边界**、判定规则文本 |
| 解析 | 真实 choice 形状、变体兼容、元信息（confidence / 次优）、非法形状 |
| 守卫 | 精确命中、唯一裸尾、歧义与未知 |
| 编排 | 正常、**全失败模式降级**、异常不传播、超时、日志含 conf |

> 测试坑：`mockLog` 是模块级 mock，前面用例的日志会残留，`find()` 可能取到旧行——断言前必须 `mockClear()`。超时用例的 `vi.resetModules()` 会留下第二个模块实例，后续需要断言日志的用例必须重新 import。

---

## 十、关键决策记录

| 决策 | 理由 |
|---|---|
| 决策模型只选人，不当裁判 | 决策模型输出类型化分布，不是文本 |
| 选中成员置顶而非独选 | 保留组合容错；决策只决定顺序 |
| 降级到 fallback 而非报错 | 决策是优化项，不能降低可用性 |
| 健康度作排除信号 | 打分会让冷成员被系统性低估（§4） |
| 不缓存决策结果 | 概率分布 + 内容适配，缓存会让流量固化 |
| 404 判为无效 | THX 未鉴权也返回 404 + 完整 body（§6.2） |
| 长 id 不截断 | criteria 是对象键，截断会静默合并候选 |

---

## 附：相关提交

| 提交 | 内容 |
|---|---|
| `be4cf41a` | 组合新增 router 策略——System One 决策模型前置路由 |
| `b775425d` | 决策卡附成员近 7 天健康度 |
| `a6840727` | System One provider 接入连接测试与 key 校验链 |
| `21360d31` | 决策改用 Drex 规范要求的 criteria 对象 |
| `9302a864` | 健康度改为排除信号，消除冷成员被系统性低估 |
| `0c40fe03` | 决策日志带上 confidence 与次优候选 |
