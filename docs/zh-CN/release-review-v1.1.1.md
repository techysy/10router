# v1.1.1 发版前审计报告（2026-09-13）

> 范围：`v1.1.0`（`2205ba19`）→ main（`5f738854`）——首轮 66 提交（88 文件 / +3966−543）+ 复审轮 15 提交，**共 81 提交全量审读**。
> 方法：全量 diff 审读（大部分提交与审计同会话逐项实施，本文复核收口）+ 全量 vitest
> 与 `known-fails` 基线比对 + CI 状态核对 + 泄漏面/重复键扫描 + 六轮桌面测试
> （test.17–test.22）与两轮 NAS 热替换的产物级验证。

## 结论

**可发版，0 阻塞项。** 安全修复（P1）、并发修复（P3）、两个 GH issue 修复（#13/#14）
与全部 UX 迭代均已落地且有测试或产物级验证；35 个本地测试失败全部与基线匹配（含
2 个已知 Windows 环境项），CI main tip Tests 绿。

## 一、安全

| 项 | 状态 |
|---|---|
| P1 `xiaomi-mimo/auto-import` 入 guard 强保护双清单 | ✅ `53d027bc`，4 例新守卫（远程 403 / 本地免密 401 / JWT+CLI 放行），guard 套件 56 例绿 |
| P2 同接口 500 回显 `error.message` | ✅ 收敛为固定文案，细节只进服务端日志 |
| 新增网络面（签到/intl 活跃探测） | ✅ 仅打官方域名（codebuddy.cn / codebuddy.ai），Bearer 为用户自有 token，memo（`codeBuddyDailyDone`）只存连接 ID+日期，写前裁剪 |
| 桌面壳新增面（最近打开管理窗/打开网址弹窗） | ✅ `data:` 页面内容不含用户可控 JS（DOM `textContent` 构建 + `json.dumps` 字面注入），渲染用 IPC 单通道白名单动作 |
| 泄漏面扫描（v1.1.0..HEAD 全 diff） | ✅ 无 `sk-`/JWT/邮箱；`123456` 字样仅为 #9 审计文档引用的**代码证据行**；LAN IP 为内网拓扑文档正常内容 |

## 二、并发与数据

- **P3 `disabledModelsRepo` 并发丢写** ✅：事务外只做异步别名解析，事务内 `readFresh`
  同步重读（保留 own-row 优先 / sibling union 回退语义——外部方案的伪代码会删掉
  legacy 行，已规避）。
- **recent-urls 存储迁移**（字符串数组 → `{url,title,titleManual}`）：12 例冒烟测试
  覆盖旧格式迁移 / 大小写去重 / 容量 / 标签兜底。
- **签到当日备忘持久化**：settings 键 `codeBuddyDailyDone`，写入时裁剪非当日条目，
  重启不重打。曾有「函数建了没接线」的中间态（`3bf12317`→`bc29c7c2` 修复），
  最终态已在 DB 实测验证。

## 三、测试与回归

- 全量 vitest：**2347 过 / 35 败 / 94 skip**。35 个失败分布在 19 个文件，逐一与
  `known-fails.txt`（40 条）比对：**全部命中基线或为已知 Windows 环境项**——
  `db-benchmark`（本地缺 `lowdb` + %TEMP% EPERM）、`embeddings.cloud`（`/cloud` 别名
  路径仅 CI 存在）；CI main tip Tests **绿**（CI 环境解析正常）。
- 新增测试：guard +4、mimo session +6、disabled-ux +4、checkin 26、console-archive 6、
  recent-urls 冒烟 12 等。
- golden/alias/providers 三套快照已随 APInex 移除重生成（92→91 家），155 例相关套件绿。
- 测试轮自身三轮加固：登录态 SSR 冒烟（防「health 绿但页面 500」）、SkipAppBuild
  版本同步、PS 5.1 空输出/引号兼容。事故复盘：`test-report-test17-tdz-page500.md`。

## 四、i18n

- Endpoint 页全量清扫：110 处硬编码 → `translate()`，zh-CN/zh-TW 各新增 ~70 条；
  esbuild 语法验证 + test.22 轮绿。
- **审计中发现并修复**：sweep 引入 3 对重复词条键（与隧道功能时代的既有键撞车，
  JSON 后值覆盖故行为无差异，已去重并保留与本页术语一致的一组）。
- 已知非阻塞：zh-TW 字典规模（470 键）历史上远小于 zh-CN（1636），大量回落英文
  ——存量欠账，建议 1.2 补齐。

## 五、图标与供应商

- `@lobehub/icons` 集成：58 个供应商官方品牌 SVG（60 处深导入经脚本校验目录存在，
  lobe 5.18 无 Gitlab/Zed 已移除映射走 PNG 兜底）；`Color` 变体双主题通用（SVG
  `currentColor` 天然适配，无需 light/dark 双套位图）；33 个未覆盖供应商原 PNG 路径
  零删除。版本 `^5.18.0` 与仓库 32/34 的 `^` 浮动策略一致；lobe 未来删除图标的
  风险在**构建期**即报错（不会静默上线）。
- APInex 整体下架：registry/capabilities/图标/快照/测试全清，两端既有连接已删，
  provider 92→91。
- `amd` 图标换 ATI 标（128px，Wikimedia SVG 栅格化）。

## 六、桌面壳（test.17–test.22 六轮全绿）

- Alt「前往」菜单 / 帮助菜单 / 最近打开（标题 + 管理窗）/ 右键菜单 / 侧边栏翻转
  （终态：`menu_open` 水平镜像）/ Rotate all xs 档。
- 产物级验证方式：asar/`.next-cli-build` 内 marker 正向断言 + 登录态 SSR 200。

## 七、文档与发版面

- CHANGELOG 1.1.1 段与实际改动逐条对齐（本次审计修订 1 处过时描述：侧边栏终态
  为镜像而非汉堡）。
- 用户端三语 changelog（`public/i18n/changelog/`）按规则未动，发版时提炼。
- 测试报告体系：`test-report-INDEX.md` 总索引 + 三篇历史复盘（NAS 漏 pull /
  asar 句柄锁 / v1.0.8 版本漂移）+ test.17 TDZ 独立篇；两本部署手册已接索引与铁律。

## 八、发版 checklist（代码侧就绪，动作项待发版时执行）

- [x] 66 提交全审，0 阻塞
- [x] 四版本位处于 1.1.0 干净态（发版时 `test-build-version` 不适用——直接 bump 1.1.1 四处）
- [x] CHANGELOG 对齐
- [x] CI main tip 绿；本地全量套件无基线外失败
- [ ] bump 1.1.1（root/cli/desktop/fnos 四处一次同步——v1.0.8 教训）
- [ ] 用户端三语 changelog + README 版本表 + Release notes
- [ ] tag **单独推**（v1.0.8 教训）→ 盯 4 工作流
- [ ] Release 建好后删 v1.0.8 的 `nsis.7z` + `Web-Setup`（防死链惯例）
- [ ] Gitee `push main --tags`
- [ ] NAS 热替换到正式版（当前 test.20 已含全部代码，仅版本号差异）

## 九、遗留（不阻塞 1.1.1）

1. **#9 安全审计 6 未修项**（默认监听/默认密码兜底/凭据明文等）——定案 1.2，行为
   变更需迁移指引。
2. **#10 内容过滤流重试设计**——需先拍策略（计费放大风险）。
3. ~~P2 自定义模型批量启用/禁用~~ ✅ 已修（拍板进 1.1.1：bulk API + 双路径 UI + PUT merge 回归用例）。
4. zh-TW 字典补齐（见 §四）。
5. Endpoint 页 Suggested-free-models 区与 `endpointConstants` 的 TUNNEL_BENEFITS
   静态文案仍英文（低频展示）。
6. `db-benchmark` / `embeddings.cloud` 在 Windows 本地的环境性失败——可考虑补
   `known-fails` 标注或本地依赖说明，避免下次审计再花时间甄别。

## 十、复审轮（首轮报告后新增的 15 提交，`d0fd6cb1..5f738854`）

| 提交 | 内容 | 审读结论 |
|---|---|---|
| `a001218c` | P2 批量启用/禁用 + PUT merge 修复 | ✅ bulk route 在 `/api/models` 既有鉴权内（与单条 PUT 同暴露面）；merge 修复有回归用例锁 name/caps |
| `6f7ce575` | ProviderInfoCard notice 过 translate | ✅ 无词条自动回落英文，零副作用 |
| `96d4e737` / `52ad1830` | CN hy4 夜间免费(23–8) + 白天 0.29x | ✅ nightFree 窗口纯函数、CN/intl parity 测试排除 hy4 并各自钉住 |
| `583f6bbd` | promo 徽章契约测试同步 | ✅ Regression gate 抓到的 pass→fail，契约按新结构更新（gate 正常工作） |
| `a59a63bf` | Create Key 按钮 chr(10) 残留修复 | ✅ i18n 清扫脚本教训（改写型脚本跑完必须 grep 产物） |
| `ef7a934d` / `612f771d` | OAuth transfer 泛化 + 加密 | ✅ 见 §十补充安全评审（下方） |
| `ce2c5a54` | 导入免仪表盘密码 + 查重五级 | ✅ 口令即授权闭环；查重链 sub→token→rt→email→name 有测试 |
| `cbe8fc27` / `905acab3` / `af2b0eb3` | 提醒归位 + 设置组重排 + 词条补齐 | ✅ 纯 UI/词条 |
| `bc72050c` / `30c3eb31` | 导入直达一步 + 仪表盘密码前置校验 | ✅ verify-password 路由与 login 同暴露级；错误留在所输入的步骤 |
| `5f738854` | isNightFreeHour 提取 utils + transfer 行为测试保留 | ✅ 修本地 vitest 对 .js 内 JSX 不转译的文件级假红（CI 版本差异容忍，无 lock 浮动依赖又一例） |

### 补充安全评审（transfer 路径行为矩阵，`dashboard-guard-transfer-paths.test.js` 4 例锁定）

| 场景 | 行为 |
|---|---|
| 远程匿名（免密部署） | 401（ALWAYS_PROTECTED；**有意不加 LOCAL_ONLY**——NAS 远程仪表盘是合法场景） |
| 本地免密 | 401（同上，requireLogin=false 不放行） |
| 远程/本地持 JWT 或 CLI token | 放行 → export 内再验 dashboard 密码；import 由传输口令授权 |
| verify-password 前置校验 | public（与 login 同暴露级），仅返回 ok/false |

### 复审新增修复
- `isNightFreeHour` 提取至 `src/shared/utils/nightFree.js`（消除测试对 JSX 组件文件的依赖）；
- 3 对撞车词条去重（§五）；CHANGELOG 侧边栏终态描述修正。
