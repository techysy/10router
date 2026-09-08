# API Key 签名机制与密钥签名轮换（实验）

> 相关文件：`src/shared/utils/apiKey.js`（签名/解析）、`src/lib/db/repos/apiKeysRepo.js`（存储/校验）、`src/sse/services/auth.js` 与 `src/dashboardGuard.js`（请求准入）、`src/app/api/keys/rotate/route.js`（一键重签）
>
> 状态：实验功能（v1.0.8 未发布段引入）。本文档记录**当前过渡态的真实行为**与**未来整体改版的强校验规划**——两者差异是最容易误解的点。

## 密钥格式与签名算法

| 格式 | 结构 | 说明 |
|------|------|------|
| 新格式 | `sk-{machineId}-{keyId}-{crc8}` | machineId 16 位；keyId 6 位（`crypto.randomBytes`，v1.0.8 起）；crc8 = `HMAC-SHA256(secret, machineId + keyId)` 的 hex 前 8 位 |
| 旧格式 | `sk-{random8}` | 历史遗留，无 CRC，`parseApiKey` 直接放行 |

签名密文 secret 的解析链（`resolveApiKeySecret`，按优先级）：

1. **`API_KEY_SECRET` 环境变量** — 永远最优先。注意：设了它之后，仪表盘的轮换开关**实际不生效**（`isRotationEnabled` 直接返回 false）。
2. **轮换开启**（env `API_KEY_ROTATION=true` 或仪表盘设置 `settings.apiKeyRotation`）→ 自动生成随机 secret 落盘 `$DATA_DIR/api-key-secret`（mode 0600），进程内缓存。
3. **内置兜底密文**（`endpoint-proxy-api-key-secret`，公开已知）— production 下启动告警一次。

## 关键事实：CRC 目前只在签发时使用（过渡态设计）

这是本机制最反直觉、也是有意为之的一点：

- **请求路径不验签**。网关准入（`src/sse/services/auth.js` → `validateApiKey`）和仪表盘 API 守卫（`src/dashboardGuard.js`）都是**拿完整密钥字符串到 SQLite 精确匹配一行 + `isActive=1`**，不重算 CRC、不碰签名密文。
- `parseApiKey()`（会重算 CRC，不匹配返回 null）在当前源码中**零调用方**——它是为云端无状态校验（cloud worker，不在本仓库）预留的。
- 推论一：**"轮换后旧密钥失效"的直接原因是 Rotate all 把旧行置 `isActive=0`**，不是验签失败。在仪表盘 Resume（重新开启）旧密钥，它立即恢复可用，与它当年用哪个密文签名无关。
- 推论二：伪造一个格式合法、CRC 正确的密钥串**过不了**本地准入——它不在 DB 里。所以过渡期本地安全性不依赖 CRC。

这个过渡态是有意的：存量客户端可以通过 Resume 平滑回退，轮换不会一刀切断流。UI 文案"启用后旧密钥将失效"描述的是**目标态**（强校验落地后）的语义。

## Rotate all 一键重签（`POST /api/keys/rotate`）

- 前置：`settings.apiKeyRotation === true`，否则 409。
- 幂等防护（双保险）：
  - 服务端：模块级 `rotateInFlight` 标志，在途时再收请求返回 409（防双标签页/连点竞态）；
  - 前端：`rotateGuardRef` 防重入 + 确认弹窗统一"先关闭、再执行回调"（`EndpointPageClient.js` 底部 `ConfirmModal` 包装，覆盖页内所有确认场景）。
- 逐 key 流程：剥离已有 `(rotated)` 后缀（`/(?:\s*\(rotated\))+$/`，防止重复重签堆叠出 `name (rotated) (rotated)`）→ 按当前密文签发新 key `${base} (rotated)` → 旧行置 `isActive=0`。
- 新 key 明文仅在响应弹窗中展示一次，须立即复制分发。

## 未来整体改版：CRC 强校验规划

计划在未来破坏性版本把验签落到请求路径（`validateApiKey` 内加 `parseApiKey` CRC 校验）。届时必须一并处理：

1. **旧格式豁免**：`sk-{random8}` 无 CRC，需决定豁免还是强制废弃换新。
2. **machineId 耦合**：CRC 输入含 machineId——换机器 / 迁移 `DATA_DIR` 导致 machineId 变化时全部密钥验不过，需配套迁移提示或重签引导。
3. **env 优先级**：`API_KEY_SECRET` 永远压过自动生成密文，文档与 UI 须明示，避免用户设了 env 却以为在用轮换密文。
4. **发布顺序**：先引导用户完成 Rotate all 重签（现有 UI 即为此准备），再发布强校验版本；顺序反了会瞬间废掉所有旧密文密钥。

顺带的低成本增强：强校验落地时可将 CRC 从 8 位 hex（32 bit）加长——验签是本地 HMAC 重算，长度几乎零成本，而改长度同样是破坏性变更，与强校验合并到同一版本一次过渡最干净。
