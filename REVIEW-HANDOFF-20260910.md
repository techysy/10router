# 审查交接 — 10router 今日三提交（1e16a748 / ec4e70c7 / 6aae8743）

> 交给独立 agent 做代码审查用。仓库：`F:\Files\GitHub Files\10router`（branch main，HEAD = 6aae8743，已推送 GitHub，CI 绿）。
> 背景：v1.0.8 已发 tag/release（tag 被 force-move 到 1e16a748），npm 1.0.8 **尚未发布**——计划把今日修复并入 1.0.8 的 npm 包（tarball 已本地构建待发）。

## 提交清单

| commit | 主题 | 文件 |
|---|---|---|
| `1e16a748` | 补 desktop/package.json 版本号 1.0.7→1.0.8（发版 775c9474 漏同步） | desktop/package.json |
| `ec4e70c7` | 修 /v1/models 500 "jsonCatalog is not defined" | src/app/api/v1/models/route.js（-6 行） |
| `6aae8743` | 端点页文案补 i18n（zh-CN +38 / zh-TW +39 条） | public/i18n/literals/{zh-CN,zh-TW}.json |

## 审查点 1 — ec4e70c7（重点）

**背景**：`686b1217`（v1.0.8，JSON 模型目录下线，改官方刷新机制）删除了 `src/app/api/v1/models/route.js` 中 `jsonCatalog`/`jsonEnabled` 的声明，但第 490 行附近一个三元表达式仍引用它们：

```js
// 修复前
const customModelIds = (jsonCatalog && jsonEnabled.length > 0)
  ? []
  : customModels.filter(...);
// 修复后（ec4e70c7）
const customModelIds = customModels.filter(...);
```

**触发条件**：仅当存在"手动添加的自定义模型"（providerNodes/customModels 表有行）时才进入该分支——所以 CI/基线测试没抓住，生产（fpk 装机 .101）用户手动加模型后 `/v1/models` 直接 500。本地已复现（dev server 500→修复后 200）。

**请审查**：
1. `git show 686b1217 -- src/app/api/v1/models/route.js` 对照：除 490 行外是否还有**其他悬空引用或半迁移残留**（全仓 `grep -rn "jsonCatalog\|jsonEnabled" src/ open-sse/` 目前为 0，请独立验证）；
2. 修复语义是否正确：JSON 目录机制已整体删除，`customModels`（`getCustomModels()`，route.js ~line 273 加载）现在是自定义模型**唯一来源**，删掉死条件后是否会引入"重复条目/陈旧条目"（原注释声称 JSON 目录供应商会忽略 legacy customModels 防重复——但那套 JSON 导入已不存在，请确认没有第三条写入路径让两者同时存活）；
3. `.filter()` 内 `alias === staticAlias || alias === outputAlias || alias === providerId` 的口径在删除条件后是否仍闭环（`validProviderIds`/`validNodeIds` 孤儿过滤逻辑，~line 280-300）；
4. `/v1/models/[kind]`、`/v1/models/info` 等兄弟路由是否有同样的半迁移残留。

## 审查点 2 — 6aae8743（i18n）

- 翻译走 runtime DOM 层：`src/i18n/runtime.js` 按**英文原文精确匹配** key（trim 后整串），en locale 空 map 直接跳过。
- 新增 key 全部来自 `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js` 硬编码文案，含：安全门控两条 unsafeReason、`Open settings`（注意字典已有 `Open Settings` 大写 S 版本，源码是小写 s——已按源码原样新增小写版）、`Security required: ` 前缀的**拼接全串**（setTunnelStatus/setTsStatus 模板串，3 条）、密钥轮换/关闭 API key 校验的 confirm 弹窗全句（多行 `+` 拼接合并为单串 key）、隧道/Tailscale/Funnel 状态机消息。
- 3 条弹窗全串 key 在字典中**已存在**（v1.0.8 轮换功能入库时加的），合并脚本跳过未覆盖——请核对源码拼接结果与既有 key **逐字符一致**（含空格/破折号），不一致则 runtime 翻不到。
- zh-TW 用词锚定既有条目（金鑰/重簽/儀表板/登錄）；`Security required: ` 前缀 key 只加进了 zh-TW（zh-CN 原有），请核对 zh-CN 是否本来就有（应有，`'Security required: ' -> 安全要求：`）。
- 风险点：JSX 里 `{translate("Pause API key")}` 这类**编程式翻译**与 DOM runtime 并存——新增 key 只服务 DOM 层，请确认没有新增 key 实际需要编程式翻译而被漏接（即源码中有没有 `translate(` 包住这些新句子的调用点缺失）。

## 审查点 3 — 1e16a748（版本号）

- 发版同步应有 4 处：root `package.json` / `cli/package.json` / `desktop/package.json` / `fnos-packaging/manifest`。v1.0.8 发版提交 `775c9474` 漏了 desktop，1e16a748 补上。请验证 4 处当前均为 1.0.8，且 tag v1.0.8（指向 1e16a748）的产物命名正确。

## 环境注意（避免误报）

- 本地 vitest 在 Windows 挂 `@/` 别名解析（`Cannot find package '@/shared/constants/models'`）——**预存环境问题**，CI 绿（run 34437753442），不要把它当本次改动引入的失败。已知预存测试失败清单另见记忆（39 个，与本次无关）。
- 已知预存失败基线 41 项内零新增是回归门禁口径。
- `npm publish` 尚未执行（政策：发版由用户显式发起）。
