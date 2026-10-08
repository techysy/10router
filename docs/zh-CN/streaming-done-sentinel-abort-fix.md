# 流式响应 [DONE] 哨兵与客户端断开引发的假夭折（False Abort）机制与修复

> 关联 Issue：#48 · 关联 PR：#50 · 关键 commit：`09bc01ca`, `fa0a3577`, `bea44d75`  
> 涉及模块：`open-sse/utils/stream.js`, `open-sse/utils/streamHandler.js`, `open-sse/handlers/chatCore/streamingHandler.js`

---

## 1. 背景与现象

在 10Router 网关服务（以及通过 Hermes Agent、OpenAI SDK、各类卡片 sidecar）使用中，用户与测试反馈在仪表盘「请求详情」中经常观察到成片出现的**红色异常记录**：
- **状态**：`status: "error"`
- **Token 统计**：`输入 0 / 输出 0`
- **响应预览**：`[Streaming aborted before completion]`
- **耗时**：几十秒（如 35s ~ 40s，往往与模型的首字延迟 TTFT 相当）

**最怪异的矛盾**在于：
- **客户端实际上完整拿到了回答**！例如 Hermes 的 `gateway.log` 显示 `Normal final-send ... final_len=1112 chars`，下游对话流畅推进，业务毫无异常；
- 10Router 仪表盘与账本却把这次请求记为了「0 Token 的失败请求」；
- 该现象在 **CodeBuddy / WorkBuddy 系列（如 `deepseek-v4.1-flash`）** 上尤为频繁和扎眼，导致用户误以为渠道挂了或产生丢单。

早期排查曾一度误以为是 CodeBuddy 模型首字耗时过长（TTFT 达 30s+）导致客户端超时断开，但现场日志打脸了该假设：在这些记录中 `firstByteSeen=true | keepalivesSent=0`，说明首字早在数十秒前就已经顺利吐给客户端，连接断开发生在整个回答吐完的最后一刻。

---

## 2. 根因剖析：五重机制连锁反应

经过端到端链路追踪与独立 Node Web Streams 仿真测试，复现并确认了该问题的完整机制：

### 机制一：客户端流式读取的正常生命周期
几乎所有现代 OpenAI 兼容的流式客户端（包括 `openai-python` SDK 的 `with client.chat.completions.create(stream=True) as s:`、HTTPX 流式上下文、Hermes Agent 连接池）：
1. 逐行读取 SSE 数据流；
2. 一旦检测到数据行是 `data: [DONE]`（OpenAI 协议规定的终止哨兵）；
3. **客户端立即退出流循环，并关闭底层的 HTTP 连接（触发底层 reader 的 `cancel()` 或 socket `close()`）**。

这是 HTTP/1.1 SSE 规范下标准客户端的标准做法——客户端已经看到了 `[DONE]`，任务已完成，无需继续挂起连接等待服务端主动关闭 TCP。

### 机制二：Web Streams 标准行为陷阱（`TransformStream.flush()` 绝不执行）
在标准 Web Streams（WHATWG Streams API / Node.js `node:stream/web`）实现中：
- 当下游消费方（Reader）调用 `reader.cancel()` 时；
- `TransformStream` 的内部管道被立即中止；
- **`TransformStream` 的 `flush()` 回调函数根本不会被执行！**（仿真验证：`Did flush run? false`）。

而在 10Router 原始设计中：
- 唯一一个负责调用 `onStreamComplete(...)`（把详情行从预置的 `streaming` 占位状态改写为 `status: "success"` 并记录真实 Token 用量）的触发点，**全部挂载在 `flush()` 回调中**！
- 客户端在读完 `[DONE]` 之后掐断连接，导致 `flush()` 被直接跳过，`onStreamComplete` 永远得不到执行。

### 机制三：断连检测器将正常收尾误判为异常中断
10Router 的 `createDisconnectAwareStream` 负责监测客户端主动断连：
- 客户端读到 `[DONE]` 退出触发的 reader cancel，会进入 `cancel(reason)`；
- 旧代码在 `cancel()` 中无条件调用 `streamController.handleDisconnect(reason)`；
- 外层 `streamingHandler.js` 将 `handleDisconnect` 包装成了中止落库：
  ```js
  // streamingHandler.js (旧逻辑)
  handleDisconnect: (r) => {
    recordAbort(typeof r === "string" ? r : "cancelled");
    streamController.handleDisconnect(r);
  }
  ```
- 此时占位行仍然是初始状态，`recordAbort()` 顺利抢占该行，将 `status` 覆盖为 `"error"`，Token 用量归零，内容覆盖为 `"[Streaming aborted]"`！

### 机制四：直通（Passthrough）与转译（Translate）双路径遗漏
10Router 存在两种流处理模式：
1. **Translate 模式**（格式转换，如 `claude -> openai`）：
   上游发出 `[DONE]`，旧逻辑进入 `if (parsed && parsed.done)` 分支，该分支仅下发了转译结束标记，随后直接 `continue`，没有结算。
2. **Passthrough 模式**（格式相同直接透传，如 `cbcn/deepseek-v4.1-flash` 的 `openai -> openai`）：
   上游发出的每一行通过 `reqLogger` 转发，包含 `data: [DONE]`。旧逻辑中直接当作普通数据行 enqueue，随后 `continue`，同样没有结算。

两条路径均未在「见到 `[DONE]` 的那一瞬间」立即结算，而是死等 `flush()`。

### 机制五：闭包作用域状态未共享
在 `streamingHandler.js` 中：
- `handleStreamingResponse`（包含 `abortTerminal` 和 `abortAwareController`）与 `buildOnStreamComplete` 分属两个不同的函数/闭包作用域；
- 若仅在局部作用域定义布尔标志 `let finalized = false`，`onStreamComplete` 无法访问该状态，导致完成结算与中止回写之间无法实现互斥闩锁，甚至在运行时抛出 `ReferenceError: finalized is not defined`。

---

## 3. 架构修复方案

修复遵循「协议驱动收尾（Sentinel-driven Completion）+ 状态原子闩锁（State Latch）」原则，涉及三个层面的协同改造：

### A. `open-sse/utils/stream.js`：提取幂等收尾函数，哨兵就地结算
提炼出单一权威的 `finishStream()` 方法，由 `streamCompleted` 状态锁保护，确保无论由哪个路径触发，真实落库逻辑只执行一次：

```js
const finishStream = () => {
  if (streamCompleted) return;
  streamCompleted = true;

  const finalUsage = mode === STREAM_MODE.PASSTHROUGH ? usage : state?.usage;
  if (!hasValidUsage(finalUsage) && totalContentLength > 0) {
    const estimated = estimateUsage(body, totalContentLength, mode === STREAM_MODE.PASSTHROUGH ? FORMATS.OPENAI : sourceFormat);
    if (mode === STREAM_MODE.PASSTHROUGH) usage = estimated;
    else state.usage = estimated;
  }

  const settledUsage = mode === STREAM_MODE.PASSTHROUGH ? usage : state?.usage;
  if (hasValidUsage(settledUsage)) {
    logUsage(provider || targetFormat, settledUsage, model, connectionId, apiKey);
  } else {
    appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
  }

  if (onStreamComplete) {
    onStreamComplete({
      content: accumulatedContent,
      thinking: accumulatedThinking
    }, settledUsage, ttftAt);
  }
};
```

并在所有模式遇到 `[DONE]` 哨兵时**立即触发结算**：
1. **Passthrough 模式**：
   ```js
   if (trimmed === "data: [DONE]" || trimmed === "data:[DONE]") {
     output = "data: [DONE]\n\n";
     streamDoneSent = true;
     reqLogger?.appendConvertedChunk?.(output);
     controller.enqueue(sharedEncoder.encode(output));
     finishStream(); // 立即结算，不再依赖 flush()
     continue;
   }
   ```
2. **Translate 模式**：
   在 `if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA)` 块中，下发完终态标记后立即执行 `finishStream()`。
3. **`flush()` 兜底**：作为没有显式 `[DONE]` 哨兵时的标准 EOF 兜底，同样调用 `finishStream()`。

### B. `open-sse/utils/streamHandler.js`：识别已收尾的客户端关闭
在流传输控制层，区分「收到哨兵后的正常客户端断开」与「流传输中途夭折」：
1. 在 `pull()` 循环中，打上字节级哨兵标记：
   ```js
   if (value && /\[DONE\]/.test(typeof value === "string" ? value : new TextDecoder().decode(value))) {
     sawUpstreamDone = true;
   }
   ```
2. 在 `cancel(reason)` 钩子中执行分流判断：
   ```js
   cancel(reason) {
     stopKeepAlive();
     if (!sawUpstreamDone) {
       // 未见 [DONE]，确系异常断流或中途强行掐断
       streamController.handleDisconnect(reason || "cancelled");
     } else {
       // 上游已发 [DONE]，客户端关闭系正常收尾，按正常完成对待
       streamController.handleComplete();
     }
     reader.cancel();
     writer.abort();
   }
   ```

### C. `chatCore.js` & `streamingHandler.js`：引用型共享互斥闩锁
解决跨函数跨闭包的竞争问题：
1. 在 `chatCore.js` 中创建引用对象：
   ```js
   const finalizedRef = { current: false };
   ```
2. 传递并贯穿至 `buildOnStreamComplete` 与 `handleStreamingResponse`：
   - 当 `onStreamComplete` 执行成功写入时，置 `finalizedRef.current = true`；
   - 当 `recordAbort` 准备覆写时，先检查 `if (finalizedRef.current) return;`，杜绝任何晚到的断开事件破坏已经生效的成功记录；
   - 当真实 abort 发生时，先置 `finalizedRef.current = true`，杜绝半成品被后续异步事件盖写。

---

## 4. 验证与实地结果

### 1. 独立仿真验证
构造包含完整 Web Streams 管道（`upstream -> TransformStream -> DisconnectAwareStream`）的独立脚本，仿真两种客户端行为：
- **场景 A**：客户端读至 EOF 自然退出。
- **场景 B**：客户端一旦读出 `[DONE]` 立即 `reader.cancel()` 强行退出。

**仿真结果**：
- 场景 A 与 场景 B 产出的详情行 **100% 相同**（均准确落库 `success`，Prompt: 8，Completion: 5）；
- 场景 B 下 `aborted` 计数为 0，`completed` 计数为 1。

### 2. 反向防御验证（防误判泛化）
- **场景 C**：客户端仅读取部分正文、**尚未收到 `[DONE]`** 时强行掐断连接。
- **仿真结果**：`aborted` 计数为 1，`completed` 为 0，详情行准确记录为 `error`，未将真实故障放宽。

### 3. 生产机（NAS 192.168.31.101）热替换实测

在 NAS 生产环境热替换部署后，通过外部 Arch Linux 客户端（Python `openai` SDK、`httpx` 客户端、原生 HTTP 流）针对 `codebuddy-cn` 和 `codebuddy-intl` 进行真实调用验证：

| 客户端调用模式 | 最终落库状态 | 记录 Token | 详情耗时 |
|---|---|---|---|
| Python `openai` SDK 读完退出 | **`success`** | prompt: 14, completion: 5 | 1523ms / TTFT 1445ms |
| `httpx` 流读取，收到 `[DONE]` 立即 break | **`success`** | prompt: 8, completion: 5 | 1241ms / TTFT 1171ms |
| 读至 EOF 完整关闭 | **`success`** | prompt: 14, completion: 5 | 1790ms / TTFT 1593ms |
| **首块内容刚出、未见 `[DONE]` 时强行 break** | **`error`** | prompt: 0, completion: 0 | 1423ms / TTFT 0ms |

---

## 5. 工程经验与防坑总结

1. **不可将生命周期终止操作与 Web Streams 的 `flush()` 强绑定**：
   `TransformStream.flush()` 只在「上游正常 EOF 且下游持续拉取」时执行。任何下游提前退出（`reader.cancel()`）、TCP RST 或断开，都会导致 `flush()` 静默跳过。业务结算必须以协议层的终止信号为准。
2. **SSE 终态哨兵（`[DONE]`）不仅是客户端读取边界，也是服务端结算边界**：
   一旦服务端向客户端发送了 `[DONE]`，本次对话对于客户端而言就已经宣告完结。从此时开始，任何连接断开都是正常的连接回收，不可再计为 Transport Error 或 Abort。
3. **跨模块共享状态务必使用 Mutable Ref**：
   在异步流处理流程中，回调函数（如 `onStreamComplete`）和管道流控制器（`pipeWithDisconnect`）生命周期交错，通过基本类型（boolean）传值会产生闭包隔离，应统一使用 `{ current: value }` 容器对象进行共享。
