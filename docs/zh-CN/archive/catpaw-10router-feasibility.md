# 美团妙手（CatPaw）接入 10Router 可行性报告

> 状态：**调研结项；不实施 10Router 模型供应商 / 反代适配**。本轮没有新增 CatPaw executor、provider 或额度 handler。
> 日期：2026-09-28。范围：10Router issue [#32](https://github.com/techysy/10router/issues/32)；在 Windows 本机对妙手桌面客户端、其运行日志与打包资源进行核查，并结合 CreditDaddy 已完成的本机凭据 / 额度验证。
> 结论：妙手套餐余额可在妙手 Agent 里消费，但目前没有确认到可供 10Router 稳定调用的公开模型 API。桌面端确实有普通 AgentService 与流式回答事件，因此不能再笼统说“没有推理接口 / 绝对不可能”；然而创建与提交普通对话的 HTTP 协议、原始 SSE 封装、服务端兼容性和计费映射均未完成验证。没有签到或每日免费活动时，接入不会产生额外积分；鉴于余额是有限且有期限的赠送 / 套餐额度，完整反代的工程与维护成本目前不合算。

---

## 1. 决策摘要

**暂不将 CatPaw 接入 10Router 作为可路由模型供应商，也不继续实施 `feat/catpaw-provider` 上的反代施工。**

- 目前已确认的价值仅是：让其他 OpenAI 兼容客户端有机会消费 CatPaw 账户中已有的 credits。反代不能创造、补充或签到领取 credits。
- 本机看到的欢迎赠额是一次性且有到期日，不是每日签到、周期发放或可重复领取的活动。到期前通过其他客户端消费可能有便利，但不是稳定的免费额度来源。
- 普通桌面 Agent 对话有专用服务和流式事件，但它是有会话、工作区与 Agent 状态的客户端服务，不等于公开的 Chat Completions API。当前缺少完整请求契约，直接照抄一段 SSE 解析器并不足以构成可靠的 provider。
- 账户与余额管理已由 CreditDaddy 侧实现。若将来只需要跨产品查看余额，可复用只读额度展示方向，不必因此实现模型代理。

这是一项**当前不值得施工、证据不足以承诺稳定反代**的判断，不是对服务端能力作“技术上绝对不可能”的断言。

## 2. 产品、积分与服务边界

### 2.1 CatPaw 与 LongCat：有关联，不等于同一接入面

妙手欢迎权益界面展示了「龙猫 LongCat」赠额。这能说明该权益与 LongCat 模型 / 品牌有关，不能据此证明 CatPaw 桌面 Agent 与 LongCat 的 API、凭据、额度账本或服务端点是同一产品接口。10Router 已有的 `longcat` 供应商，以及 `opencode-go` 的免费模型目录，是各自的供应商入口，不能当作 CatPaw 桌面会话 API。

此前 issue 评论把两者先说成完全无关、后又根据欢迎权益卡片称为“同一个东西”，两种表述都过度简化。准确表述应是：**妙手中展示了 LongCat 相关权益；两者的产品关系不改变各自的 API / 鉴权边界。**

### 2.2 赠额与增量活动

- 既有界面证据显示欢迎赠额为一次性发放，并注明有效期（此前截图所示为 2026-10-26）；它不是签到积分，也没有查到每日领取或重复领取入口。
- CreditDaddy 本机已能解密妙手桌面凭据并读取账号资料、套餐及余额；一次实测显示体验版及余额信息。此验证只证明账户 / 额度可读取，不证明有可由第三方调用的模型 API。
- 因此，若“反代价值”指通过签到赚取新 credits 再供 10Router 调度，答案是**没有这项价值**。若指消费已有的赠额 / 套餐余额，则理论上可能有便利，但额度仍按上游规则消耗和过期。

### 2.3 三套服务入口不得混用

| 用途 | 已观察到的服务 / 路径 | 结论 |
|---|---|---|
| CreditDaddy 账户 / 余额 | `https://catx.nocode.cn/api/gateway/auth/current-user`、`/api/gateway/credit/balance`；使用 `X-Auth-Token` | 本机验证可读取用户与余额；属额度查询，不是模型推理入口。 |
| 妙手普通 Agent 对话 | AgentService 运行配置指向 `https://ai.catpaw.meituan.com`；运行日志中可见 `/api/agent/conversation/detail` 与 `/api/agent/stream/connect` | 与桌面 Agent 对话有关，使用客户端会话身份；不是 NoCode 生成流。 |
| NoCode / 建站类流程 | 打包 UI 资源中配置 `https://nocode.cn`、`https://catpaw-agent.meituan.com`，涉及 `/api/chat/create`、`/api/chat/agent-stream`、`/api/agent/stream/connect` | 是另一条 NoCode 工作流。对其 `chat/create` 的 401/403 不能推断普通 AgentService 对话也不可用，也不能用它替代普通对话协议。 |

普通 AgentService 日志确认使用 `CatX` source 及 `X-Passport-Token` / `authTokens.x-passport-token` 这类桌面会话认证线索；NoCode 和额度网关各有自己的鉴权。不得把 `X-Auth-Token`、Passport Cookie / Token 与标准供应商 API Key 混为一谈。客户端请求还出现 `gray-set`、`M-APPKEY`、`user-uid` 等头部，但仅从日志观察到，并未逐一验证其是否为普通聊天请求的必需字段。

## 3. 普通 Agent 流式输出：已确认与未确认

### 已确认：客户端 SDK 事件层的回答增量

在默认工作区的一次真实普通对话中，妙手长连接日志记录了 SDK 已解析事件：

- `agent_start`、`status_update`（`running`）、`turn_start` / `model_start`；
- 回答增量使用 `type: "model_chunk"`，其中 `data.content` 是分片正文，按同一 `messageId` 顺序拼接；
- `data.reasoningContent` 是独立字段，不应当作面向用户的回答正文转发；
- 终结 `model_chunk` 可不带 `content`，而带 `finished: true` 与 `contextInfo`；之后有 `model_end`（含完整 `textContent` / message）、`turn_end` 和 `agent_end`。

证据来自妙手本机 `logs/long-conn/2026-09-28T09-42-36.451+08-00.log` 中 09:59 的运行记录。这里只记录字段结构与语义，不归档用户提示词、原始凭据或完整会话内容。

### 未确认：HTTP 层原始协议及端到端反代

- 该日志是妙手客户端消费后的 SDK 事件日志，不是 HTTP 响应的原始 SSE 字节抓包。因此，`event:` / `data:` 的原始封装、心跳、错误帧及断线续传行为没有被这份日志证明。
- 对旧的已完成会话附着 `/api/agent/stream/connect` 得到的是历史消息 / `currentStatus: "completed"`，并未得到活动 delta。不能将历史帧冒充实时帧。
- 新发的“ok”确实在默认工作区触发了普通 Agent 对话，并由本机日志记录到上述活动 `model_chunk`；但没有在执行期间取得原始 HTTP SSE 报文，也没有验证普通 AgentService 的**创建 / 提交用户消息**请求契约。
- NoCode 的 `chat/create` 探测失败不构成普通 AgentService 的反证。也没有证据表明 AgentService 可被任意外部调用，或可将模型与工作区上下文安全地映射成 OpenAI 请求。

## 4. 接入 10Router 所缺的关键闭环

10Router 可通过自定义 executor 适配非标准上游协议；架构本身不是障碍。CatPaw 施工仍至少缺少下列验证：

1. 普通 AgentService 新会话 / 发送消息的准确 HTTP 请求（字段、头、Cookie / token 来源与过期续期），并确认这是受支持且可重复调用的客户端接口。
2. 原始 SSE 事件封装、活动流帧、终止帧、错误 / 限流 / 取消行为和断线重连语义。
3. 10Router 无状态 `messages[]` 与妙手有状态 `conversationId`、默认工作区及 Agent 工具执行之间的明确映射；不能意外访问或修改用户工作区文件。
4. 模型选择、工具调用、多轮上下文、usage / credits 扣费数据以及账号失效 / 风控的行为映射。
5. 凭据生命周期与安全边界：桌面客户端的本地加密会话并非可长期分发的 API key。不能将个人 Passport Token 写入配置、日志、公开 issue 或共享给不受信任的调用方。

故目前只能说**回答 delta 的 SDK 层字段已确认**；并未达到实现或发布一个可靠 CatPaw 10Router executor 的证据门槛。

## 5. 成本收益与风险判断

| 维度 | 现状 | 影响 |
|---|---|---|
| 增量免费额度 | 未发现签到 / 每日活动；欢迎赠额一次性且有期限 | 无持续的免费额度供网关调度。 |
| 复用已有余额 | 可能，但必须经过 CatPaw Agent 会话服务 | 有限的便利性，不增加额度；用量仍受套餐和到期规则限制。 |
| 接口稳定性 | 当前观察到桌面 Agent 私有会话 API；公开的标准模型 API 未确认 | 自定义适配会依赖客户端协议，版本升级可能中断。 |
| 技术完整度 | 只有客户端事件 schema 部分确认 | 创建消息、原始 SSE、工具 / 上下文 / 用量均未打通，估算与维护成本不确定。 |
| 凭据风险 | 依赖桌面登录态，而非独立、可撤销的 provider key | 放入网关会扩大个人会话凭据的可达范围，须重新评估授权与隔离。 |

**推荐替代**：妙手继续在官方客户端内使用；通过 CreditDaddy 查看本机账号资料与额度。若 10Router 后续出现明确的“把妙手当前套餐余额用于其他兼容客户端”的刚性需求，先寻找官方支持的模型 API / 独立 API key；只有在协议与授权边界明确后才重新立项。

## 6. 重启条件

满足以下任一条件，再开新评估，而不是沿用本轮未完成的反代施工：

- 美团公开提供标准推理 API、稳定文档与独立 API 凭据；或
- 得到明确许可后，能从**一条新鲜的普通 Agent 对话**完整验证创建 → 活动 SSE → 取消 / 错误 / 用量终止的 HTTP 协议，并证明它适合隔离映射到网关请求。

再次评估时须优先使用脱敏抓包或本地 mock fixture；不得将访问令牌放进命令行参数、日志、报告或提交。

## 7. 分支与代码状态

- `feat/catpaw-provider` 没有新增 CatPaw 实现；它只包含与 `main` 上补丁等价的既有用量界面提交，未发现该分支独有的 CatPaw 代码。
- 本报告与归档索引是本轮唯一新增的 10Router 文件改动；无 changelog 用户功能条目，因为没有交付功能。
- Issue #32 已关闭；本报告用于更正并补充已有评论，不改变 LongCat 现有供应商或 `opencode-go` 免费模型目录。
