# 小米 MiMo 模型清单 — 四方对比（2026-09-11）

| 来源 | 说明 |
|---|---|
| **我们** | `open-sse/providers/registry/xiaomi-mimo.js`（本仓库） |
| **桌面目录** | MiMo Desktop 自带 `%APPDATA%/Xiaomi MiMo/models-with-claude.json`，4 个分区（main/tp-cn/tp-sgp/tp-ams） |
| **models.dev** | 线上快照 `xiaomi` + 3 个 token-plan 分区 |
| **程序本体** | `app.asar`（99 MB）里 grep 出的模型 id |

## 对比矩阵

| 模型 id | 我们 | 桌面目录 | models.dev | 程序本体 | 上下文/输出 | 模态 |
|---|---|---|---|---|---|---|
| `mimo-auto` | — | ✅ (main) | — | ✅ | 1000000/128000 | text+image→text RAT |
| `mimo-flash` | — | ✅ (main) | — | ✅ | 1000000/128000 | text+image→text RAT |
| `mimo-pro` | — | ✅ (main) | — | ✅ | 1000000/128000 | text+image→text RAT |
| `mimo-v2-flash` | ✅ | —  | ✅ | ✅ | 262144/65536 | text→text RT |
| `mimo-v2-flash-free` | — | —  | — | ✅(仅此源,存疑) | ? | ?→?  |
| `mimo-v2-omni` | ✅ | ✅ (tp-cn,tp-sgp,tp-ams) | ✅ | ✅ | 262144/131072 | text+image+audio+video+pdf→text RAT |
| `mimo-v2-omni-free` | — | —  | — | ✅(仅此源,存疑) | ? | ?→?  |
| `mimo-v2-pro` | — | ✅ (tp-cn,tp-sgp,tp-ams) | ✅ | ✅ | 1048576/131072 | text→text RT |
| `mimo-v2-pro-free` | — | —  | — | ✅(仅此源,存疑) | ? | ?→?  |
| `mimo-v2-tts` | — | ✅ (tp-cn,tp-sgp,tp-ams) | ✅ | ✅ | 8192/8192 | text→audio  |
| `mimo-v2.5` | ✅ | ✅ (tp-cn,tp-sgp,tp-ams) | ✅ | ✅ | 1048576/131072 | text+image+audio+video→text RAT |
| `mimo-v2.5-asr` | — | ✅ (main) | — | ✅ | 8192/4096 | audio→text  |
| `mimo-v2.5-free` | — | —  | — | ✅(仅此源,存疑) | ? | ?→?  |
| `mimo-v2.5-pro` | ✅ | ✅ (tp-cn,tp-sgp,tp-ams) | ✅ | ✅ | 1048576/131072 | text→text RT |
| `mimo-v2.5-pro-crof` | — | —  | — | ✅(仅此源,存疑) | ? | ?→?  |
| `mimo-v2.5-pro-free` | — | —  | — | ✅(仅此源,存疑) | ? | ?→?  |
| `mimo-v2.5-pro-ultraspeed` | — | —  | ✅ | ✅ | 1048576/131072 | text→text RT |
| `mimo-v2.5-tts` | ✅(TTS) | ✅ (main,tp-cn,tp-sgp,tp-ams) | ✅ | ✅ | 8192/4096 | text→audio  |
| `mimo-v2.5-tts-voiceclone` | — | ✅ (main,tp-cn,tp-sgp,tp-ams) | ✅ | ✅ | 8192/4096 | text→audio  |
| `mimo-v2.5-tts-voicedesign` | — | ✅ (main,tp-cn,tp-sgp,tp-ams) | ✅ | ✅ | 8192/4096 | text→audio  |
| `mimo-x-flash-preview` | ✅(Preview) | —  | — | — | ? | ?→?  |
| `mimo-x-pro-preview` | ✅(Preview) | —  | — | — | ? | ?→?  |

## Token Plan 分区端点（models.dev 格式，我们目前不支持）

| 分区 | api |
|---|---|
| `xiaomi` | https://api.xiaomimimo.com/v1 |
| `xiaomi-token-plan-cn` | https://token-plan-cn.xiaomimimo.com/v1 |
| `xiaomi-token-plan-sgp` | https://token-plan-sgp.xiaomimimo.com/v1 |
| `xiaomi-token-plan-ams` | https://token-plan-ams.xiaomimimo.com/v1 |

## 关键差异

1. **`mimo-x-pro-preview` / `mimo-x-flash-preview` 四方里只有我们（= 照搬上游未合并 PR）有**；程序本体 0 命中、桌面目录 0 命中、models.dev 0 命中。
2. **`mimo-v2.5-pro-ultraspeed`**：程序本体 ✅ + models.dev ✅，我们 ❌ —— 唯一有双重佐证、而我们缺失的模型。
3. `mimo-v2.5-pro-crof`：仅程序本体有，来源不明。
4. `-free` 系列（`mimo-v2.5-pro-free` / `mimo-v2-flash-free` / `mimo-v2-omni-free` / `mimo-v2-pro-free` / `mimo-v2.5-free`）：仅程序本体，属免费档（对应我们已有的 `mimo-free` 供应商）。
5. TTS/ASR 家族我们只有 `mimo-v2.5-tts`；缺 `mimo-v2-tts`、`mimo-v2.5-tts-voicedesign`、`mimo-v2.5-tts-voiceclone`、`mimo-v2.5-asr`。
6. 桌面目录自带快照与线上 models.dev **不是同一 vintage**：前者 main 分区是 `mimo-auto/mimo-flash/mimo-pro`（2026-07-01），后者是 `mimo-v2.5-pro-ultraspeed/mimo-v2-flash/...`。

## 建议动作（待定）

1. **两个 Preview id 的最小安全改动**：保留，但在注册表注释里写明「id 来源 = 上游未合并 PR #3921，作者自查清单未勾选，本机三方交叉验证均为 0 命中」，避免以后有人当成已核实。
2. **补 `mimo-v2.5-pro-ultraspeed`**（程序本体 + models.dev 双重佐证，1048576/131072，text-only RT）—— 唯一证据充分而我们缺失的对话模型。
3. **TTS/ASR 家族**：`mimo-v2-tts` / `mimo-v2.5-tts-voicedesign` / `mimo-v2.5-tts-voiceclone`（text→audio）与 `mimo-v2.5-asr`（audio→text）都有三方佐证，可按需补（我们只有 `mimo-v2.5-tts`）。
4. **Token Plan 三区域**（cn/sgp/ams，`token-plan-*.xiaomimimo.com/v1`）我们完全不支持；若要做，目录来源现成。
5. **定稿前的决定性证据**：在桌面版登录小米账号后（Cookie 库当前 0 行），直接探账号服务 `/api/route/chat/completions` 的真实模型列表，即可判定 Preview id 与 `-free`/`-crof` 系列的真伪。
