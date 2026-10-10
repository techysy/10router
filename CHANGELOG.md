# 变更日志

> 面向用户的精简更新见 [`public/i18n/changelog/`](https://github.com/techysy/10router/tree/main/public/i18n/changelog)（`en.md` / `zh-CN.md` / `zh-TW.md`，仪表盘「Change Log」按界面语言加载对应文件）。本文件为完整开发日志，按版本从上往下排列。

## v1.4.0 (待定)

### ✨ 新增

- **API 密钥支持每日 Token 限额**:Endpoint 页创建的每个客户端 key 现在可以设「每日 Token 限额」(如 100M/天),超限后 `/v1/*` 一律返回 429(`rate_limit_error` + `retry-after` 指向重置时刻),到服务器本地零点自动恢复——与仪表盘「今日」用同一个边界口径,数字不会再对不上。限额跟随 key 本身:即使没开「要求 API key」,带 key 的流量也计量(回环 / CLI token 无 key 身份,不受限)。Endpoint 页顶部另有「每日 Token 限额开关」全局总闸:关掉即停止一切拦截,但每个 key 已配置的限额值原样保留,再打开即全部恢复。创建弹窗可选填限额,列表行显示「今日: 37.2M / 100M tokens」并在达标时标红,行上的日历图标**常驻可见**(不靠悬停),点开即改或清除(留空 = 不限)。被拒请求同样落库:usageHistory 记一条 `rate_limited` 状态、0 token 的行(0 token 是刻意的——拒绝不该消耗它正在执行的额度),仪表盘「请求」列表与日志都能看到这条 429,不会在排查看到缺口。429 文案做服务端本地化(按 dashboard 的 locale cookie / Accept-Language 选中/繁中,SDK 裸调用回退英文),app 生成的 key 名(「Default Key」「(rotated)」)在界面上同样随语言本地化,不再中英混搭。九个 `/v1` handler(chat/embeddings/fetch/image/search/stt/systemone/tts/video)统一走 `checkApiKeyDailyLimit` 一处判定;计量为 prompt+completion 总量,usage 在请求完成后才落库,因此单个在途请求可以超额、下一条即被拒(护栏语义,非精确计费)。DB 查询异常时 fail-open(限额不打挂网关);key 轮换继承限额,备份导出/导入往返保留限额。schema 附加列 `apiKeys.dailyTokenLimit`(SCHEMA_VERSION 1→2,`syncSchemaFromTables` 自动补列,无需迁移文件)。
- **配额跟踪器卡片图标可点击直达供应商官网**:配额页每张卡片左上角的供应商 logo 此前是静态图标,现在点击即在新标签页打开对应供应商的官网 / 控制台(悬停有 ring 高亮与带 URL 的提示)。跳转目标以注册表为唯一真相源(新增 `getProviderWebsite`,回退链与提供商详情页一致),不在前端维护第二份映射;解析不到 URL 的 provider(自定义连接等)保持纯图标、不渲染假链接。全部 29 个带用量追踪的 provider 都能解析出跳转目标,由测试逐个钉住——将来新增 provider 忘配官网会当场变红,而不是让用户看到点不动的图标。
- **隐藏卡片视图开关补齐「零余额」一档**:实验页的「隐藏无配额提供商卡片」只处理*没有配额可显示*的卡片(消息卡、Token Plan 等),0 余额 / 0 积分的连接仍会整卡留在页面上。现在新增独立的「隐藏零余额提供商卡片」开关(localStorage `quotaHideZeroBalance`,同一视图偏好模式,默认关),判定谓词 `isConnectionDepleted` 从组件闭包上收到 `utils.js` 导出——批量「禁用耗尽连接」与新视图过滤器从此用同一个判据,不会再出现两处对「耗尽」各有定义的分歧。两开关互相独立且可叠加:消息卡算「无配额」但不算「零余额」,不会被新开关误藏;加载中 / 拉取报错 / 尚未返回的卡片两个过滤器都保留,真实卡片不会闪没。仅含 unlimited 行的连接保持可见,而「耗尽的付费包 + unlimited 包」的组合按既有语义判定为耗尽(与批量禁用行为逐字一致,由测试钉死)。配额页「Showing …」摘要沿用既有机制,叠加过滤后自动报告实际渲染数。
- **免费线卡片新增 CreditDaddy 网关连通性检测与引导**(issue #49 关闭时承诺):ZCode Free / MiniMax Free / Trae Free 卡片的网关设置区现在会实时探测网关端口(服务端 TCP 探测,浏览器跨源探测不可靠)——在线显示绿色「网关在线」,不通则显示琥珀色提示并附 CreditDaddy 下载链接与开启网关的引导,支持手动「重新检测」、保存配置后自动重探。探测端点仅放行本机/局域网私有网段(公网地址 400),不构成端口扫描器。
- **OpenCode 两条付费线补齐新上架模型**:Zen 线新增 Claude Haiku 5.5 / Sonnet 5.5、GPT 6 Sol / 6.1 Sol、Mistral Large 4 与 Exo Free / Fledge Alpha Free / Ling 3.1 Flash Free 三个免费 id;Go 线新增付费版 Space Bunny。id 依据官方 `/zen/v1/models` 与 `/zen/go/v1/models` 目录核对。
- **Claude Haiku 5.5 能力声明修正为 1M / adaptive**:此前该 id 命中 `*claude*haiku*` 兜底,被按 200K / claude-budget 声明——与 Opus 5.x、Sonnet 5.x 同为 5 代的 Haiku 5.5 实为 1M / 128000 adaptive(models.dev 第一方),budget 会让翻译层伪造签名 thinking 占位。补精确键覆盖,同批修正 Exo Free、Ling 3.1 Flash Free 与 Space Bunny 的窗口/模态。
- **CodeBuddy 两条线对齐官方积分页,并补上此前漏掉的一整条模型面**:国际线新增 GPT-6.1-Sol / Gemini-3.8-Flash / Grok-4.7(1.90x)与 Kimi-K2.8-Preview,国内线新增 GLM-5.3-FlashX 与 MiniMax-M2.7。**Space-Bunny 由 0.03x 回调至 0.08x**——10/2–10/7 的限时折扣价到期,积分页回填正式价(CN 与国际同步)。国内线的 GLM-5.3-FlashX 补上 0.14x(积分页 2026-10-09 回填)——它比同族的 GLM-5.3-Flash(0.06)贵一倍以上。MiniMax-M2.7 现网可用但积分页仍未公布倍率,不猜,徽章留空。
  积分页上另有 Auto / Fast / Balanced / Primary / Deep 五个 agent 档位,均未收录:后四个不是模型 id(20 种写法一律 11102,是聊天端发请求前自己解析的预设),而 `auto` 虽是网关真 id、却会把请求路由到会变的模型(探测五次全落 GLM-5.2),没有稳定的能力声明与稳定的花费可记。
  能力表:intl 侧只有 Space-Bunny 一行,其余模型落到通用行(与国内线的数值不一致)。**有意不镜像国内表**——输出上限是真夹子,照抄另一条通道会把夹子挪到没有依据的位置。
- **CodeBuddy 国际线补上整条 Claude 线**,此前该渠道一个 Claude 模型都没有:新增 Opus 5.5(2.17x)/ Sonnet 5.5(1.33x)/ Opus 5 / Sonnet 5 / Opus 4.8 / 4.7 / 4.6(均 3.33x)/ Sonnet 4.6,连同 CN 线新收的 StepFun **Step-5-Preview**(0.43x)。id 一律用小写点号——积分页渲染的 `Claude-Opus-5.5`、连字符版与 `-thinking`/`-agentic` 变体实测全部 11102。
  这批**在本机免费账号上探测回 11102**(Claude 组 17 种写法、Step-5 同样),而同批的 Opus-4.6 / Sonnet-4.6 / GPT 组全部回 200,判定器正常——按账号档位差异收录,注册表注释与测试都写明了这一点,以及下架判据(付费账号上仍是 11102 才算目录错误)。Claude-Sonnet-4.6 的倍率积分页未给,按用户决定对齐同档的 Sonnet-5(1.33),属推断而非页面原值。
- **模型行新增两个徽章**,都是积分页上肉眼可见、此前代码里没有对应概念的标记:
  - **付费档**(黄,锁图标)——积分页上带订阅锁的模型。回答的是「能不能用取决于你的账号档位」,与倍率徽章是两件事。
  - **订阅优先**(蓝,闪电图标)——积分页标「订阅优先」的模型(Step-5-Preview / Kimi-K2.8-Preview),即订阅用户排队优先,与价格和准入都无关。
  两者视觉可区分、守卫互相独立:倍率徽章由 `displayMultiplier !== null` 守卫,未公布倍率的模型进不去,若共用守卫会让付费档徽章在最该出现的地方消失。
- **Token Harbor 收录 `claude-haiku-5.5:free`**:免费档保留上游点号 id 并追加 `:free`,注册表没有这条时能力审计会把它判成死行。该 id 的 1M / adaptive 能力行一并补齐(点号写法命中不了全局 `claude-haiku-5-5` 连字符键,原会落到 200K / claude-budget 兜底,把 combo 的上下文压成 200K)。
- **Release 资产命名平台化**:所有 CI 产物改为「软件名-平台-…」形式(`10Router-Win-Setup-<版本>.exe` / `10Router-Win-Portable-…` / `10Router-Win-Web-Setup-…` / `10Router-Mac-Setup-<版本>-<arch>.dmg` / `10Router-FnOS-<版本>-<arch>.fpk` / `10Router-FnOS-Window-<版本>-<arch>.fpk`),同一 Release 页面里同平台资产排序自动聚类,与 CreditDaddy 的命名约定对齐。**更早的 release(≤v1.3.5)保持旧文件名不变**;桌面壳内置更新器的资产挑选新旧两代命名都识别,已发布的旧版壳升级不受影响。Web-Setup 的在线数据载荷 `10router-desktop-<版本>-x64.nsis.7z` **有意不改名**——该名字被烤进已发布的 Web-Setup 安装器里按 `releases/latest/download` 直链拉取,改名即断链。
- **刷新令牌失效的账号标记「待重新授权」并从轮换冷却**:invalid_grant / refresh_token_reused 这类不可恢复的刷新失败此前只打日志——死账号留在轮换里、每 2 分钟被 401 冷却再撞一次,仪表盘没有任何人工介入提示。现在三条检测路径(checkAndRefreshToken 预检刷新、四个 core 的 401→刷新失败回调 `onCredentialsRefreshFailed`、usage 路由强制刷新)落同一个标记,两段式状态:粘性 `testStatus:"needs-reauth"`(只被「凭据又能用了」的证据清除:刷新成功 / 重新授权 / 凭据测试)+ 24h 冷却戳 `needsReauthUntil`(轮换只在窗口内跳过;**重新授权立即生效**,仍死的账号每窗口探一次)。故意不用 `modelLock_*`——重新授权路径不清那类锁,新凭据会被再挡 24h。配套:全池死锁返回带重试时间与「请重新授权」文案的响应(不再裸 404);后台刷新器 / CodeBuddy 签到在窗口内不探尸——每探一次都会把窗口重置 24h,等于永不放回轮换;`clearAccountError` 保留标记(访问令牌一时可用 ≠ 刷新令牌复活);凭据重新录入(create-merge / resetErrorState)即重新授权,消费掉标记。仪表盘连接行 / 卡片 / 用量胶囊三处显示新状态,zh-CN/zh-TW 文案齐全。配套 `needs-reauth.test.js`(354 行,钉两段语义 + 8 处接线源码守卫)。

### 🐛 修复

- **Trae Free 模型目录对齐官方 remote**(issue #54):上游按 TRAE 2.3.87413 的版本把目录重整过一轮,注册表还是旧的。本次按官方 remote 全量对齐:新增 18 款、移除 10 款已被上游下架的模型,保留 2 款仍在目录里的存量。注意 v1.3.5 段落所述的 12 款模型面里 10 款已不复存在——历史段落保持原样,以本条为准。
- **StepFun CN 实名闸门不再被当成「额度用完」**(PR #55):`stepfun-plan-cn` 的免费 Step Plan 在放行调用前要求账号完成实名(人脸)核验,未完成时上游对每个请求都回 403 `real-name verification is required ... please complete face verification at https://account.stepfun.com/security?action=realname`。此前它落到通用 `{ status: 403, cooldownMs: COOLDOWN.long }`,把模型锁 2 分钟并给客户端回一个 `(reset after 2m)`——而实名是**配置状态**,等多久都不会自己好,那个等待时间纯属误导(combo 也白等一轮才穿透)。现按既有 `mimo desktop account` 的模式加 text 规则(`real-name verification` / `realname verification`)归零冷却:账号永不锁定、combo 立即穿透。另一头是文案:403 的 OpenAI 兼容 type 叫 `insufficient_quota`,用户看到英文 JSON 会往「去充值」的方向走,实际的路是去实名。`formatProviderError`(chat / embeddings / image / video / systemone 五个 core 共用的唯一收口点)现在给命中该特征的消息追加一段可执行的出路说明——完成人脸核验的地址,或改用按量计费的 `stepfun-cn` 渠道(无实名要求)。仪表盘连接行走另一条渲染路径(`translateQuotaError`),同批补上中文文案并提供实名页跳转链接(`extractRealnameVerificationUrl`,与 Google 年龄验证那条 `extractAccountsVerificationUrl` 分开——后者有「忽略非 signin Google URL」的既有断言,泛化会同时破坏该契约并可能把 StepFun 的链接当成 Google 验证目标返回)。正则与文案的真相源收在 `config/errorConfig.js`(叶子模块,无 import)供两侧共用。普通 403 与普通消息逐字节不受影响,`realname-gate-hint.test.js` 15 例钉住。
- **combo(模型组)的上下文终于发给了 agent**:组合会聚合成员能力并算出 contextWindow,但只写进嵌套的 `capabilities.contextWindow`(驼峰),而客户端并不递归进嵌套对象——Claude CLI / mirasim 匹配顶层 `context_window` / `context_length`,拿到空值就按模型名猜,且往高猜(372k 被读成 1.05M 永远不触发压缩,直到上游硬失败)。combo 条目现补发顶层 `context_length` / `context_window` / `max_completion_tokens`(数值仍走 combo-caps 契约:min context / max output;web 组合无聚合,不输出)。dashboard 给成员设置的覆盖值(pinned caps)也参与 combo 聚合——此前面板显示正确而 `/v1/models` 照旧返回静态值。
- **客户端在 `[DONE]` 之后立即断开,不再把完整答复记成失败**(issue #48,#50):流式答复已完整送达后,客户端提前断开连接会被记为一次失败。现在 `[DONE]` 之后的断开视为正常结束,详情页与用量统计按成功记录。
- **GitHub Copilot 配额按类别分行,月度窗口不再并入资源包合计**:此前 Copilot 的 chat / completions 两类被当作同一资源包累加,与 Google 反重力等按窗口分列的口径不一致。现在按 `类别 · 每月` 拆成独立行,与 Antigravity 一致;新增 `Monthly` / `chat` / `completions` 三条中文文案,英文界面显示 `chat · Monthly` / `completions · Monthly`。
- **自定义连接名称优先显示**:连接行不再冗余显示用户名或邮箱,用户为连接设置的名称直接可见。
- **升级安装不再弹「无法关闭」——新安装器自带清理,不再执行旧版本卸载器**(Windows 桌面安装包已原位替换更新):electron-builder 的升级路径会把旧版本发布时冻结的卸载器拷出静默执行,其内部的进程检查即使没有任何 10Router 进程也会非零退出,于是弹出「无法关闭」或静默退出码 2。现在新安装器在覆盖前删除旧版卸载注册表项,升级框架便跳过旧卸载器;旧程序文件由新安装直接覆盖,用户数据(`%APPDATA%\router`)不受影响。
- **升级强杀改为「先解释再提权」,UAC 被拒绝不再无声失败**:需要提权时先弹出说明,告知将弹出 UAC 以及应选择的选项;用户拒绝提权时安装器给出明确提示并记入安装日志,不再静默放弃升级。
- **fpk 打包不再覆盖 standalone 自带的 next**(CI 与本机打包线同修):旧写法无条件 `cp -r` 整个 `node_modules/next`,把 standalone 的精简版换成完整版,连带清掉旁边的 `@swc`(scoped 追踪产物),装到 NAS 上直接 `Cannot find module '@swc/helpers/...'`,服务起不来;顺带多带约 170MB 构建期文件。现在按包的存在性决定补拷还是跳过,并在打包后逐项检查关键产物齐备,缺件当场失败而不是装到机器上才发现。
- **能力审计新增「同 provider 内重复 model id」检查**:改模型块时把一行复制成两行,此前没有任何检查能发现——能力解析与死行检查都会把重复折叠进集合,第二行完全隐形;而两行若带不同的倍率或标志,哪行生效只是「后者胜」的静默取舍。`kind` 计入键是有意的:gemini-2.5-pro 在 chat 与 `kind:"stt"` 各有一行是合法的(同名 id 走不同上游端点),只有 id 与 kind 都相同才算失误。
- **`test-local.ps1` 入口预检 `ELECTRON_RUN_AS_NODE`**:该变量残留会让 `10Router.exe` 以纯 Node 方式启动,无托盘、无日志、静默退出,现象与「包坏了」无法区分,排查一次要花一小时。脚本末尾虽有清理,但那时构建时间已白花,故在第一步直接拒绝并给出清除命令。另按改动路径提示该选哪种构建模式(仅提示,不拦截)。
- **轮换的刷新令牌落不了库就立刻失败,别静默吊销整个 session**:`checkAndRefreshToken` 与 7 个 handler 的 `onCredentialsRefreshed` 都丢掉了 `updateProviderCredentials` 的返回值,而该函数吞异常只返回 false。OpenAI 类供应商每次刷新都轮换 refresh token,上游一收下新的旧的就作废——写库失败后下一个请求拿作废的 RT 去刷,上游直接吊销整个 session(账号被整体登出)。注释里「DB 较新则采纳」的守卫救不了这个:丢写让 DB 变得更**旧**,而守卫只在 DB 更新时才采纳。新增 `persistRefreshedCredentials` 统一这条路径:轮换了 RT 且写库失败→抛 `CredentialPersistError`,请求就地失败(而不是拿只有本进程看得见的凭据继续服务);未轮换→只 warn 继续(丢写只多刷一次,不该把请求打死)。顺带合并 7 处不一致的内联副本(chat/embeddings 全量 spread,fetch/image/search/video 只传三个字段——丢掉 `lastRefreshAt`,而那正是「DB 较新」守卫比较的键);这 7 处一路在传的 `testStatus:"active"` 在 `updateProviderCredentials` 里根本没被读取,已接上。同段还修了 401 重试:重试返回非 ok 时原实现保留最初的 401,真实原因是 429/500 也让客户端去查 API key;现在重试有任何响应都取代原响应,只有重试彻底抛错才回落最初的 401。
- **sql.js 落盘失败要重排重试,别把整批写入静默丢掉**:sql.js 是驱动链最后一环(bun:sqlite → better-sqlite3 → node:sqlite → sql.js),没有原生 sqlite 的环境就跑在它上面。它的防抖落盘遇到失败只打一行 console 就结束:`persist()` 抛出、dirty 仍是 true,但定时器已清空且无人重排——触发这次保存的写入早已向调用方报了成功,于是一整批写入(请求路径经此落盘的轮换 refresh token 就在其中)在无声中丢失,除非之后恰好又有一次变更。改为指数退避重排(100ms 起,封顶 30s),永久失败的磁盘停在上限而不是原地空转。`close()` 的最终落盘不再向外抛(但大声记日志),shutdown 的 flush 也从 `catch{}` 改成记日志——正是那个静默吞错把「进程退出时丢掉轮换的 RT」这种事藏了起来。
- **模型目录查找按别名归一化,opencode-zen 目录改成精确集合**:PROVIDER_MODELS 以 `alias || id` 为键,两种拼写并不通用(opencode-zen 存在 `ocz` 下,qoder-cn 存在 `qdc` 下)。各查找函数原先裸键访问,用规范 id 查就返回「没这个模型」:supportedFormats 为 null、没有 targetFormat、没有 strip 列表——chatCore 里那个每模型传输守卫于是落到默认端点。chatCore 自己记得先转别名,生产没事;但测试或新调用方一旦传 id,断言等于空跑还照样绿——「15 个模型漏声明格式」就是这么误读出来的:探针传了 opencode-zen 拿到 null,而登记表其实一直是对的。现在查找函数内部归一化,只需写对一种拼写。opencode-zen 的目录断言原先只有 6 个 `toContain` + length>60,87 行里钉住 71 行,新 id 带着错误(或缺失)的端点声明进来不会有任何东西变红;改成 opencode-go 那种精确集合比对,并把缺的 16 行补进对应清单。全部 87 行都声明了 supportedFormats,所以这里的任何缺口都是真遗漏——另加一条断言钉住这点。
- **th / thh / ps / atria-asi 补进能力别名归一化**:`getCapabilitiesForModel` 不做别名归一化,combo 座位、自定义模型的 providerAlias、AI_MODELS 前缀都用短拼写查,拼写没接线就静默走 MODEL → PATTERN → DEFAULT:`th/claude-haiku-5.5:free` 实测解析到 200000/64000 + claude-budget(应为 1M/128000 + adaptive),combo 的 min() 再把整组压到 200k。与 cbai(Space-Bunny)同类。shims 仍手写(capabilities.js 被 registry/*.js 导入,顶部引 REGISTRY 是会撞 TDZ 的环),但补了从注册表派生期望集的完整性测试——下次漏一行会红,而不是静默降级。
- **provider 别名撞车改归属,uiAlias 补进路由**:provider 有四个地方发布自己的拼写,各喂一张不同的表(id/alias/aliases[] → 请求路由 `ALIAS_TO_PROVIDER_ID`;`alias||id` → `PROVIDER_MODELS` 查到哪份目录;`uiAlias||alias||id` → 禁用模型/modelCaps 规范名;`uiAlias||alias` → `/api/models` 自定义模型归属)。原守卫只遍历 `aliases[]`,两类撞车整块漏掉:`tr` 被 trae 的 alias/uiAlias 与已失效的 tokenrouter 简写同时认领——trae 的目录以 `tr/` 前缀发射,归 trae,tokenrouter 改回全称前缀;`mmf` 被 mimo-free 的 alias/uiAlias 与 id 就叫 `mmf` 的 provider 同时认领——`PROVIDER_MODELS[alias||id]` 让两边写同一个键、后者覆盖前者,disabledModelsRepo 的规范名也合成一组,改 mimo-free 用自己的 id 当拼写。守卫改走全部四个字段后当场又揪出两个同类:`pa`(perplexity-agent)/`voyage`(voyage-ai)是 `/api/models` 认的自定义模型前缀却没进 `aliases[]`,parseModel 解析不了——已补。verify-alias 的探针表也是手写的,不含上面任何一个拼写才探不到;改成从注册表派生(保留历史 token 以便发现拼写被删),探针 148 → 258。
- **`/v1/models` 六个发射点收敛到同一形状,models/info 与 models 对齐**:buildModelsList 的六个发射点里三个各自手搓「能力块 + snake_case token 三件套」并逐渐漂开——静态目录回退(!dbAvailable)只发 capabilities,token 三件套整个没有:只匹配 context_length / context_window 的客户端拿不到任何东西,只能从模型名猜窗口且往高猜,永远到不了压缩阈值然后上游硬失败;零连接自定义模型循环发三件套但没有 capabilities 块、也没有目录回退;combo 那处此前修过,注释还写着「其余两处已经发了」,其实并没有。抽 `applyModelCaps` 统一,顺带把 dashboard 钉子接进静态目录回退。自定义模型走 `emitFloor:false`——仪表盘写明「没有内置默认值:留空时使用供应商上报的」,所以留空的不灌 200K 地板;但 id 若真解析到表里那行(如 qfmodel),那一行正是「供应商上报的」,必须发出来。`/v1/models/info` 同样对齐:buildInfo 原先读原始 registry 行而非 getCapabilitiesForModel,两者会对不上(bai 的 deepseek-v3.2 行写 131072/65536,表里是 128000/64000,而 /v1/models 一直跟表走)。现在两个端点对同一模型说同一个数。
- **截断的干净 EOF 不再记成成功**:issue #48 修的是反方向(完整答复被记成 error),这是同一类的另一半——上游用干净 FIN 在回答中途掐断连接,flush() 发现没有终结符只好自己补 `data: [DONE]`(否则 OpenClaw 会挂到超时),然后照常 finishStream() → 请求明细 `status:"success"` 配估算用量。客户端看到一个像完整的截断答复,仪表盘说一切正常。停滞看门狗只在字节间隙上触发,干净的提前 EOF 不算,flush() 是唯一能分辨的地方。补发哨兵照旧(客户端需要它),但把 `endedWithoutTerminal` 带进 onStreamComplete,请求明细记 "truncated" 而非 "success"。Gemini 族豁免:它没有 [DONE] 方言,`!streamDoneSent` 恒真,照此判会把每条健康流都标成截断。flush() 里那个 `catch { console.log }` 也改了:它在 finishStream 之前抛出会让请求明细永远停在 "streaming",或稍后被 abort 路径改写成 error——哪怕字节早已发出去了。现在照样收尾并标记未完成。
- **SSE 流里丢弃的坏 data 行要计数,别让内容凭空消失**:无法解析的 data 行被静默丢弃是有意的——上游有时会把 HTML 错误页或限流文案塞进 SSE 流,转发出去会撑爆客户端的 JSON 解码器。但同一个吞法也藏着真损坏:某一 chunk 的内容直接没了,客户端拿到比模型实际产出更短的答案,而流照常以 [DONE] 收尾、请求照常记成功,没有任何信号。不改成功语义(单行损坏不足以判定截断),只把次数记进 onStreamComplete 和请求明细的 `response.parseFailures`:健康流为 0,非 0 就说明有内容被丢过。普通的非 data 行(注释、event 名)不算——否则每条健康流都会像坏的。
- **回归门补上套件级失败 / 跳过 / 消失三类盲区**:门原先只比断言失败,三类情况一概看不见——套件级失败(用例全过但文件红于导入/teardown,没有断言失败可比)、pass→skip(不算失败,只是不再测任何东西)、pass→消失(文件被删、describe 被注释、import 在注册前抛出,连失败行都不留)。10-08 之后两条真回归(cbai 别名漂移、opencode-go 陈旧清单)就是从后两类漏过去的。snapshot-known-fails.mjs 现同时写 known-inventory.json(全部用例键 → 状态),两个文件一起写所以不会漂;门比三类并分门别类报告。「门必须被证明会响」固化成 `regression-gate.test.js`:六种偏离逐一驱动真门脚本并断言它抱怨——从没触发过的门不算门。
- **能力审计的 `--check` 接进 CI**:审计脚本的 --check 一直没人传,打印完违规项 CI 照样绿。floor 和 vision 两类另有 vitest 门共用本脚本的表,但 image-output 缺 `imageOutput:true`、死 provider 行、provider 内重复 model id 这三类只在脚本里算,从未拦住过任何东西。
- **golden 头快照中和宿主机派生字段(kimi 在 ubuntu CI 必红)**:`buildKimiHeaders` 把 X-Msh-Device-Model(platform+arch)与 X-Msh-Device-Name(hostname)烤进头里,cline/clinepass 把 X-PLATFORM / X-PLATFORM-VERSION(process.platform / process.version)烤进去——golden 快照冻结的是生成它的机器身份,而不是头形状。此前 known-fails 40→37 重快照依据本机 Windows 全绿把 kimi 摘除,ubuntu CI 上必然 mismatch。修法:在 sanitize() 里按键名把四个宿主派生键整值替换为 `<HOST>`,重生成快照;kimi 在任何平台可过,cline/clinepass 从 known-fails 摘除。claude 的 X-Stainless-Runtime-Version 与 grok-cli 的 "(linux; x86_64)" 是源码硬编码字面量,不属漂移,保持原样。
- **translator 自注册 import 清单加完整性守卫**:译者通过 `register(from, to, …)` 在 import 时自注册,index.js 底部用 22 行手写的 side-effect import 把它们拉起来。新译者文件漏了那一行就静默不跑:路由查找落回有损双跳(claude → openai → kiro),thinking 块、tool id、非 base64 图片、is_error 全丢——而这正是直连路由存在要保护的那批脆弱组合。系统其它地方不会察觉,双跳照样给出答案,只是更差。守卫比对磁盘上的文件集与 index.js 的 import 集,并确认每个文件真的调了 `register(`;另导出 `listRegisteredRoutes()` 从活注册表读,钉住那批脆弱组合的直连路由确实存在。
- **标明 CODEX / OPENAI_RESPONSE 不是可达的 targetFormat**:这俩在 FORMATS 枚举里、也被几处防御性 case 和 pivot 表读着,但全树查下来没有任何东西会产出它们(registry 的 targetFormat 只有 claude 与 openai-responses,executor 的 responseFormat 只有 openai,provider config 的 format 里也没有这两个值——尤其注意 OPENAI_RESPONSE 单数不等于 OPENAI_RESPONSES)。删除要连带改 4 处防御性分支,收益不成比例,作为保险留着无害;真正的隐患是枚举读起来像受支持的目标,于是会有人照着写出根本走不到的路径。所以在 formats.js 头部写明结论,并加一条断言守住它:一旦哪个 provider 行、executor 或 config 真的开始产出其中一个,注释就过期了,必须改写注释并补真处理,而不是删掉断言。
- **xiaomi-mimo OAuth 回调测试加重试**:这几个用例起真 socket 再 fetch,负载高的全量并行下首次 connect 偶发 `TypeError: fetch failed`;单跑全绿,只在并行时炸,于是回归门会因一个本身并不 flaky 的用例来回翻车。loopbackFetch 加两次重试、间隔递增;真坏掉的 listener 仍会三次全失败,不会被掩盖。

## v1.3.5 (2026-10-05)

### ✨ 新增

- **新增 Trae Free 供应商（CreditDaddy Trae 线，`trae-free`）**：与 ZCode / MiniMax 两条线同款的本地网关接线——CreditDaddy 桌面版「Trae 网关」接口（`/gateway/trae/v1/messages`，Anthropic Messages 形态，默认 `127.0.0.1:47860`；网关内部转译到 sol.trae.cn 的 SOLO agent 会话协议，账号多路 SWRR 轮换、401 凭据热对齐、429 限流冷却与局域网白名单均在 CreditDaddy 侧），noAuth 免登录卡片、主机/端口复用 CreditDaddy 网关配置、路径按线独立（设置键 `traeGatewayPath`）。模型面 12 款：Doubao-Seed-2.0-Code / Doubao-Seed-Code / MiniMax M2.7 / GLM 5.1 / GLM 5v-Turbo / GLM 5 / DeepSeek V4 Pro / V4 Flash / Kimi K2.6 / K2.5 / Qwen 3.6 Plus / 3.5，支持 thinking_delta 思考流与用量回报。五处接入点：注册表条目 + `registry/index.js` 自动列表（p149）、`executors/base.js` 网关 baseUrl 覆盖（三线同判）、`auth.js` noAuth 虚拟行与网关路径分支（三线同源，抽风格从二元改多分支）、`NoAuthProxyCard` 网关设置区与本地/局域网接入说明、`public/providers/trae-free.png` 官方图标（从 TRAE SOLO 客户端 exe 的 PE 资源提取的黑白标，256px RGBA）。

### 🐛 修复

- **中途夭折的流式请求不再留一行「绿色 0 token」的假成功**（issue #48 连带修复）：流式请求一开就先把占位行写进 `requestDetails`，但状态写的是 `status: "success"`；而 `UsageStats.js` 判圆点颜色的条件是 `!r.status || r.status === "ok" || r.status === "success"`。上游中途断链或触发 120 秒无数据看门狗时，abort 走的是 `streamController.handleError`（纯内存终止，**完全不碰数据库**），`onStreamComplete` 永远不会被调用——于是这行占位记录再没人修正，**长期**留在详情页里显示为一个「成功、0 输入 / 0 输出」的请求，读起来像一次刚好没花钱的正常调用。

  两处改动：占位行状态改为 `streaming`（进行中就是进行中，不冒充成功）；把终止帧构造器包一层，abort 时按同一个 `id` upsert 回 `status: "error"`（`requestDetailsRepo` 的 upsert 冲突键正是 `id`，所以是原地更新而非追加一行）。`recordAbort(message)` 原样返回 message，**客户端收到的字节与之前完全一致**，只是那一行数据库记录知道了这次请求提前结束了。占位行的写入相应挪到建 pipe 之前——abort 处理器需要那一行已经存在。
- **单模型失败不再把整个连接标记为「不可用」**（issue #46 根因修复）：`markAccountUnavailable` 在写**按模型**的锁（`modelLock_<model>`）时，同一次写入里**无条件**附带 `testStatus: "unavailable"` —— 而选路自始至终只看那把按模型的锁（`auth.js:185-194`），也就是说一个模型的 429 会让整条连接显示为宕机、而它的兄弟模型在整个窗口内照常可用。现在 `testStatus` **只在锁键为 `modelLock___all`（真·账号级）时才写**。

  `lastError` / `errorCode` / `lastErrorAt` **仍无条件写**：连接行要靠它们解释「这个模型为什么被锁」（`translateQuotaError` 从中取重置倒计时与模型名，`extractAccountsVerificationUrl` 也读它），去掉会让模型被静默锁住。被去掉的只是那句「整个账号已下线」的断言。

  这是本次改动里唯一影响仪表盘之外行为的一处：CLI 工具页在连接无任何模型信息时，`conn.testStatus === "active"` 才给出「自行填写 model id」的建议；按模型失败后该建议现在会重新出现 —— 而这更正确（兄弟模型仍可路由，并没有理由把用户挡在门外）。

  配套：`clearAccountError` 此前**零真实覆盖**（`tests/` 下 4 处引用全是 `vi.fn()` mock），其 `remainingActiveLocks.length === 0` 门控一行都没执行过，而那正是本次要动的判断。已先补 `clear-account-error-locks.test.js`（10 例，含「兄弟锁还活着时不复位」与两步恢复），**再**改写入逻辑；新增 `mark-account-unavailable-scope.test.js`（7 例）钉住两个断言：按模型失败不得写账号级 `testStatus`、账号级失败仍必须写。`codebuddy-channel-block.test.js` 里断言 429 会写 `testStatus` 的那例按新语义更新（它传了 model，本就是按模型锁）。
- **CreditDaddy 三条线的 404 不再被误报成「模型不存在」**（issue #47）：报告者在 ZCode Free 上遇到永久 404，而提示文案指向模型列表，与真正原因无关。两件事：

  - **文案**：`errorConfig.js` 把 404 映射为 `code: "model_not_found"` / 文案 `"Model not found"`。这在本地网关上尤其误导——CreditDaddy 的网关端点已从 `/gateway/v1/messages` 迁到 `/gateway/<品牌>/v1/messages`（`zcode` / `minimax` / `trae`），**端点 404 与模型无关**，404 发生在路由阶段、还没走到模型解析。现文案改为「Not found (wrong endpoint path, or the model does not exist)」。`error.code` 是客户端据以编程的机器码，**保持 `model_not_found` 不变**（改动它属破坏性 API 变更）；且 `buildErrorBody` 只在调用方未提供 message 时才回落这句，所以上游自带文案的 404 不受影响——这也正是这个修法安全的原因。
  - **提示**：`NoAuthProxyCard` 与集成文档此前写着「可直连 `zcode-api`，其端点为 `/v1/messages`」——那是迁移前的裸端点，**任何版本都不再提供**，照着填必然 404。现改为说明「路径必须保留品牌段」，并在卡片上直给 404 排查提示：先看路径带不带 `/gateway/zcode/…`，再看 CreditDaddy 版本（重命名前的旧版仍只提供裸端点，应升级 CreditDaddy 而非改这个输入框）。三条线的 `defaultPath` 本就都是带品牌的，未改。

  新增 `creditdaddy-404-diagnosis.test.js`（8 例，钉住 404 文案 / 机器码不变 / 自带 message 不被覆盖 / 三线默认路径均带品牌段且无裸端点回落 / 卡片与文档的 404 提示 / 两个语种的译文齐全）。
- **webFetch / webSearch 的锁不再写成账号级、且成功后能自己清掉**（issue #46 连带修复）：`search.js` 早就为搜索线单独引入了 `websearch:<provider>` 锁键（否则一次搜索失败会把共享的聊天 key 整个下线），`fetch.js` 却**既不传锁键也不传 model**——`markAccountUnavailable` 收到 `model=null`，于是写下一个账号级 `modelLock___all`，一次 webFetch 失败会把整条连接停掉；而两个 handler 成功后调 `clearAccountError` 时都没带 model，`clearAccountError` 只清 `modelLock_<model>`，所以自己写的锁谁也清不掉。现按 `search.js` 的既有做法给 fetch 补 `webfetch:<provider>` 锁键，两处都把**同一个键**贯穿「取凭据 → 写锁 → 清锁」三步（`getProviderCredentials` / `markAccountUnavailable` / `clearAccountError`）。新增 `web-handler-lock-key.test.js`（8 例源码文本守卫，`search.js` 此前无任何测试）；`fetch-success-clears-account.test.js` 的断言同步更新为三参数。
- **单个模型额度用完不再显示成「账号不可用」**（issue #46 收尾）：上一笔只把提示文案点名到模型，状态色仍是红的——「unavailable 且锁已过期 → 当作 active」这条启发式被**独立实现了四份**（`providerCardOrder.js` / `ConnectionRow.js` / `ConnectionsCard.js` / usage 页的 `ProviderLimits`），每份各写一套过期过滤，其中两处还存在「倒计时用的锁不过滤、状态用的锁过滤」的分裂，于是倒计时芯片可能显示一把早已过期的锁而徽章说已恢复。现收敛为单一纯函数 `classifyConnectionCooldown()`，新增第三态 **`partial`（部分受限，黄色）**：

  | 状态 | 判据 | 呈现 |
  |---|---|---|
  | `partial` | 有活跃的 `modelLock_<model>`，无 `modelLock___all` | 黄色徽章 + 「部分受限」+ 倒计时；该连接**计入 connected** |
  | `unavailable` | 有活跃的 `modelLock___all` | 红色（真·整账号） |
  | `active` | 无活跃锁（含「`testStatus` 仍是 unavailable 但锁已过期」） | 绿色 |

  连带修三处：`computeConnectionStats` 现把 `partial` 计入 connected（否则卡片会显示「1 Connected / 0 Error / 1 total」这种对不上的数）；usage 页那个连接状态胶囊此前**直接读 `conn.testStatus`**、完全没有冷却概念，是本 issue 最刺眼的一张脸；`ConnectionsCard.js` 此前把上游原始 JSON（最长 500 字符）直接吐进 300px 红色 span，同一条连接在供应商页显示友好句子、在媒体页显示一坨 JSON，现统一走 `translateQuotaError`。`Badge` 早有 `warning` 变体，未新增视觉语言。

  测试：新增 `connection-cooldown.test.js`（14 例，含「过期锁不得让状态变红」「`__all` 优先于 partial」「earliestUntil 跳过过期锁」）、`connection-status-variant.test.js`（`getStatusVariant` 此前**零覆盖**，补 `partial → warning`）、`connection-cooldown-ux.test.js`（10 例源码文本防漂移——两处 JSX 组件在 vitest 的 node 环境下无法 import，这是仓库既有约定）；`provider-card-order.test.js` 扩 5 例。earliestUntil 的内联实现（`getEarliestModelLockUntil` 自己读挂钟、无法注入 `now`）已用交叉断言钉在引擎函数上。
- **单个模型的额度用完，不再显示成「整个账号不可用」**（issue #46 第 1 步）：Google / Antigravity 的额度是**按模型**分桶的（5 小时个人额度每个模型各一份），我们存的锁也是按模型的，但提示文案一律写「该账号额度已用完」——用户看到的是一个红掉的账号，而实际上同一连接上的其它模型在整个窗口内照常可用。上游 payload 里本就带着 `"model": "gemini-3.8-flash-high"`，此前解析完就丢掉了。现补 `extractQuotaResetInfo().model` 并新增按模型措辞的模板（`zh-CN` / `zh-TW` 同步），文案改为「模型 X 的额度已用完…该账号的其它模型仍可正常使用」；不带 model 的 payload 仍走原账号级模板（那才是真的整账号耗尽）。**只改文案、不动路由** —— 选路本来就看 `modelLock_<model>`，是对的。
- **用量「概览」空白、而「详情」列得出一堆 0/0 的行**（issue #48）：两个页签读的是两张表——概览读 `usageDaily`/`usageHistory`（`saveUsageStats` 写），详情读 `requestDetails`（`saveRequestDetail` 写）——而两者的写入门限原本不对称：上游没回 `usage` 时，`saveUsageStats` 见 0/0 直接丢行（`requestDetail.js` 的 `in === 0 && out === 0` 早退），`saveRequestDetail` 却照样把 `{prompt_tokens: 0, completion_tokens: 0}` 写进去，于是概览一个字都没有、详情每行都是 0。缺失的一环是**估算兜底**：SSE 路径一直有 `estimateUsage` 兜底（`stream.js` 四处），非流式路径只有 `extractUsageFromResponse`，认不出的 usage 形状就返回 null。现补上同款兜底（新增 `measureResponseTextLength` 一趟量出 OpenAI / Claude / Responses 三种形状的正文长度，含 reasoning），非流式与 forced-SSE-to-JSON 两条路径都改记同一个 `recordedUsage`，两个页签数字从此一致。**估算值只入库、不上线**：`sseToJsonHandler` 里发给客户端的 usage 一律取 `upstreamUsage`，避免把一个猜测当作真实花费报给调用方。新增 `nonstream-usage-estimate-fallback.test.js`（13 例，含「无 usage 时概览侧必须写非零行」「两个页签数字相同」「客户端收到的 usage 不被估算污染」）。
- **超长上下文自动压缩默认触发比例 0.9 → 0.95**（`DEFAULT_SETTINGS.autoCompactRatio`）：自动压缩（Auto-compact，v1.2.1 引入）此前默认在实际窗口 90% 处触发，现上调到 95%——更贴近窗口上限才压缩，减少长会话里偏早触发对上下文的折损。阈值档位（80 / 90 / 95%）不变，仍可在「实验特性」卡片自行下调，总开关逻辑不动。
- **`/v1/models` 补发 `context_window`，Claude Code / mirasim 不再在 160K 处强行压缩**：对外模型列表此前只发 OpenAI 约定的 `context_length` 与嵌套的 `capabilities.contextWindow`，而 Claude CLI / mirasim 走 Anthropic 约定读 `context_window`——读不到就回退到**内置 200k 默认值**，于是 Qwen3.8-Max（真实 1M）等模型在客户端侧 160K 就触发压缩，而 10Router 自己的 auto-compact 因窗口解析正确从不触发，两端口径割裂。现在四个发射点（零连接 custom / 已连接主循环 / noAuth 静态 / 孤儿 custom）同位置补发 `context_window`，纯增量不动既有字段。
- **供应商别名归一化到 id，仪表盘不再把 1M 模型显示成 200K**：`PROVIDER_CAPABILITIES` 以 provider id 为 key，但 `/api/models` 的 `AI_MODELS` 用 `PROVIDER_MODELS` 的 key（即 alias）拼 provider，alias 查表失配后跌到 `DEFAULT_CAPABILITIES` 200k 地板或泛化 pattern。全量扫描 39 个 `alias ≠ id` 的 provider、547 个模型后定位 5 个别名失配并全部归一化（沿用既有 `cx`/`dv`/`devin` 范式）：

  | 别名 → id | 影响 | 失配后果 |
  |---|---|---|
  | `qd` → `qoder` | 15 个模型 | 全部跌 200k 地板，vision / reasoning 被剥 |
  | `qdc` → `qoder-cn` | 14 个模型 | 同上 |
  | `kr` → `kiro` | 13 个 gpt-5.6 系 | 窗口 **272k → 1.05M**（掉 `*gpt-6*` 泛化 pattern，虚高 5 倍） |
  | `cbcn` → `codebuddy-cn` | 13 个模型 | 掉 hunyuan/zai/minimax/kimi/deepseek 泛化行，窗口/输出/思考格式全错 |
  | `ag` → `antigravity` | 1 个（gemini-pro-agent） | reasoning 被剥、thinkingFormat 变 null |

  新增全量不变量测试（`capabilities.test.js`）遍历所有 `alias ≠ id` 的模型断言 alias 与 id 解析完全一致——以后新增 provider 漏归一化会直接红。
- **trae-free 卡片图标不显示 / 各屏两张脸**（本版接入时的遗留）：接入时只加了 `LobeProviderIcon` 的 Trae 彩色标映射、没带 `public/providers/trae-free.png`——而供应商卡片列表（`providers/page.js`）、拓扑图等走的是 `src`-only 路径，压根不查 Lobe 映射，于是请求 `/providers/trae-free.png` 404、`onError` 把 `trae-free` 写进本会话 `failedIds`、卡片回落成文字缩写 "TF"；而拓扑图 / 用量卡片 / CLI 工具卡走 `providerId` 路径又会渲染成彩色 Trae 标。现补上从 TRAE SOLO 客户端 exe 提取的 256px 黑 PE 资源标（与 `qoder.png` 同规格、`minimax-free` 同做法），并**移除** Lobe 映射——trae-free 代表本机 SOLO 客户端、与远程 `trae` 不是同一张脸，两屏各显一张比不显示更难认。新增 `trae-free-icon.test.js` 守卫资产存在 / RGBA / 256px / 与远程 trae 标不同图 / 未被 Lobe 短路。
- **trae-free 的 CreditDaddy 网关 baseUrl 覆盖生效**（本版接入时的遗留）：接入时 `executors/base.js` 加了该线但漏了 `executors/default.js` 的同名分支，而 trae-free 没有专属 executor（`executors/index.js` 注册的 `trae` 是另一个 provider，走 `core-normal.trae.ai`），实际由 `DefaultExecutor` 承接——用户配置的局域网主机/端口对 trae-free 完全无效，请求仍打注册表默认 `127.0.0.1:47860`。两处现已同判，并补 `creditdaddy-gateway-url.test.js`（从注册表反推本地网关线，在两个重复实现上各断言 4 种情形；已验证回退 `default.js` 到缺 trae-free 的状态即红并点名该 provider）。
- **Qoder 网页会话失效不再静默降级**（issue #44）：部分 Qoder 账号的 openapi quota/usage 聚合值归零，套餐积分只能靠 CreditDaddy 同步来的网页会话读取；会话一旦失效（cookie 过期 / owner 不匹配），10Router 会静默回落到 openapi 聚合值，用户只看到「订阅积分凭空消失」，没有任何提示。现在把整条失败路径点亮——`getQoderUsage` 在「会话存在但没产出可用数据」时返回 `webSessionExpired:true`；额度卡片显示琥珀色警告并指明去 CreditDaddy 重新登录网页；导入 qoder 连接后并发（≤6）探测各账号网页会话可用性，弹窗展示结果，有失效时取消自动关闭确保用户看到。
- **Windows 升级安装不再卡在「10Router 无法关闭」**：assisted installer（`oneClick:false`）以普通用户运行，`taskkill` 只能杀同权限或更低权限的进程——而旧版 sidecar 由 10Router 以「以管理员身份运行」拉起（MITM 绑定 443 需要提权），安装器直接 `taskkill /IM` 被拒绝（access denied），`CHECK_APP_RUNNING` 弹「无法关闭」后放弃升级。现在 `customInit` 在普通 taskkill 之后追加一段 UAC 提权（PowerShell `-EncodedCommand` + `-Verb RunAs`，直连系统 `taskkill.exe` 避免 PATH 投毒）从高权限上下文强杀；用户拒绝提权时退化为普通 taskkill，最坏与之前一致。同时给 `nsisWeb` 目标补上 `include`（此前只有标准 Setup 有 customInit，Web-Setup 没有）。**这条修复同时覆盖 `10Router.Setup` 与 `10Router-Web-Setup` 两个安装包。**
- **桌面端更新下载加超时保护**：GitHub tags 拉取、安装包下载与 `checkUpdateViaGitHub` 此前无超时，网络挂起会让更新流程永久卡死。新增 `fetchWithTimeout`（AbortController）统一包裹，读流循环加 `try/catch` + `reader.cancel()`，`startUpdateDownload` 失败时清理已下载的临时文件。

## v1.3.3 (2026-10-04)

### ✨ 新增

- **新增 MiniMax Code Free 供应商（CreditDaddy MiniMax 线，`minimax-free`）**：与 ZCode Free 同款接线——CreditDaddy 桌面版「MiniMax 网关」的本地 Anthropic 网关（`/gateway/minimax/v1/messages`，上游 agent.minimax.cn 标准协议；账号多路轮换、401 自动 OAuth 刷新、429 冷却均在 CreditDaddy 侧），noAuth 免登录卡片，主机/端口复用 CreditDaddy 网关配置。模型面 MiniMax-M3.1-Flash-Preview / M3 / M2.7-highspeed / M2.7（实测可答，响应带 signature thinking 块与 cache_read）。详情页补 **CreditDaddy 网关主机设置区**（主机/端口与 ZCode 线共享同一 daemon，路径按线独立）与 **官方图标**。官方 Minimax Coding（api.minimax.io，API key 计费）为并行通道，两者互补。
- **MiniMax 家族能力接线对齐官方客户端设置面板**：M3.1-Flash-Preview 思考深度五档透传（`thinking.effort`，default/low/medium/high/xhigh/max——CreditDaddy 网关实测 200 接受；透传门控在 `thinkingCanDisable:false` 上，M3 与 M2.x 不带档位）；M3 思考为开/关切换（客户端有「思考」开关 → `canDisable:true`，显式成行修正旧 pattern 的 false）；上下文 512K/1M 两档为 MiniMax 侧用量分档，能力表按上限 1M 声明。MiniMax-M3.1-Flash-Preview / M3 canonical 行按 models.dev minimax-coding-plan 条目（text+image+video 进、1M/512K）。Lobe 官方 MiniMax 图标复用（`minimax-free`）。
- **`/v1/models` noAuth 静态出口改按 dashboard 优先级排序**（低位在前、id 稳定次序）——此前依赖注册表插入顺序，两个尾部 noAuth 供应商之间会退化成字母序偶然。

### 🐛 修复

- **zcode-free 网关端点补齐 `/zcode` 段（与 minimax 线同形）**：CreditDaddy 侧已把 ZCode 网关从 `/gateway/v1/messages` 迁到 `/gateway/zcode/v1/messages`（对齐 MiniMax 线的 `/gateway/minimax/v1/messages`），10Router 的内置默认值同步跟进——注册表 `transport.baseUrl`、运行时兜底（`auth.js`）、卡片预填/占位值、集成文档四处一致。已显式存过 `zcodeGatewayPath` 的用户不受影响（留空才走内置默认）。
- **CreditDaddy 网关卡片：路径显示生效值 + 远程接入说明纠错 + 补简繁**（zcode-free / minimax-free 两条线同享）：路径输入框此前把内置默认藏在 placeholder 后面，留空时用户看不出实际走哪条路径——改为直接预填生效值（与 `auth.js` 兜底同源，字段 `pathPlaceholder` 一并删掉，名字与行为不再各说各话），输入框 `w-44` 加宽到 `w-56` 免得路径被截断成看不出是 zcode 还是 minimax 线。远程接入文案此前写「远程主机需鉴权——建一个带 key 的连接（key = 其虚拟 key）」，**与实际不符**：CreditDaddy 网关不校验任何 key，它由 IP 白名单保护，10Router 侧无需为它建连接，改为写明「本机开网关开关 / 局域网开 Allow LAN access + 把本机 IP 加白名单 + 重启 CreditDaddy」两步，并点明该开关是启动时读取的。卡片硬编码中文一并收进 i18n（`translate()` 显式调用——运行时 DOM 遍历器只处理文本节点、不碰 `placeholder` 属性，占位符必须自己翻），zh-CN / zh-TW 各补 6 条。集成文档同步加「局域网部署必读」小节。
- **CodeBuddy CN 不再本地拦截工具多的 Claude Code / codex 会话**：极端体积后备里的 `tools > 60` 一刀切把挂了 MCP 工具集的真实会话整个锁死（用户报告「cbcn 大部分模型都无法在 Claude 和 codex 内使用」）——而工具数从未与体积分离验证过（09-17 的 11128 样本是 4.5MB / 1676 条 / 54 工具整体失败）。工具数移出拦截标准、只进拒绝诊断信息（错误现在写明超的是哪个维度、实际多少 MB / 多少条 / 多少个工具）；体积 3.2MB 与 1200 条消息两项保留，若上游对「工具多但体积小」仍 11128，由渠道熔断按设计兜底。
- **windsurf / trae / devin-cli 新目录模型的能力地板收尾**：SWE-1.5/1.6（±Fast）无公开规格（models.dev 未收录）→ 审计 allowlist 注记保留地板值；trae 的 Auto / Work 为 server 挑模型虚拟档 → allowlist「aggregator」性质（同 cursor/default）。

## v1.3.2 (2026-10-03)

### ✨ 新功能

- **APInex（apinex.bond）供应商复上架 + 目录实测刷新**：v1.0.5 上线、v1.1.0 因上游宕站下架（9cefa48b）的聚合网关恢复——取回历史 registry、图标、目录 JSON、capabilities 行与 free/* 判定注释；邀请码 chip（notice.inviteCode）沿用现行 InviteCodeChip。随后用实测 key 拉取线上目录重写为 **36 模型**（上游已弃 vendor 前缀改裸 id；免费档扩到 18 个 free/*，含 free/claude-opus-4.6、free/muse-spark-1.3、free/qwen-3.8-max 等），capabilities 按家族实测值重写（vision/maxOutput 补齐，thinkingFormat 沿用历史实测的 openai 转发）。实测备注：free/* 需每天在 airdrop 页签到（否则 billing_error "Daily check-in required"），付费档 $0 时 402。三项基线（104 providers / 148 alias tokens / audit-capabilities）与 golden-url-header 全过。
- **CodeBuddy CN 上架 Space-Bunny（0.03x，10/2–10/7 限时折扣）+ deepseek-v4.1-flash 倍率回调 0.03 → 0.11**：官方积分页 2026-10-02 将首周尝鲜价回调至正式倍率，intl 同步（ promoFreeUntil 随窗口终结一并移除，两网关保持倍率一致）；promo-free 徽章链路不动，`deepseek-v4-capabilities` 的供给方列表补 APInex、promo 测试改写为「促销已结束」断言。
- **供应商面整理：图标补齐 / Atria 取 key 链接 / Dahl 下架 / Token Harbor 免费档补齐**：
  - **图标**：`public/providers/` 新增 `atria.png`（官方 logo）与 `tokenharbor.png`（官方 icon-192），统一规格化为 128×128 RGBA（库内惯例尺寸）；`opencode-zen.png` 直接复用 OpenCode 同图。
  - **Atria Dawn**：「获取 API 密钥」链接 `api.atria-asi.ai/dashboard` → **`/console`**；用户 key 实测通过（/v1/models 列出 Atria-Dawn-Preview、chat 正常应答）。实测响应带 `reasoning_content`，能力表维持保守 `reasoning:false`（thinking 控制语义待单独决策，不随本轮改）。
  - **Dahl Inference 整体下架**：registry 条目 / `registry/index.js` 生成列表 / `PROVIDER_CAPABILITIES.dahl` / `/api/providers/[id]/models` 目录映射 / testUtils 校验分支共 5 处清除；providers/alias 基线重快照，`audit-capabilities` dead-rows 0。
  - **Token Harbor 免费档补齐**：seed 增加 `qwen3.8-flash:free` / `mimo-v2.6-flash:free`（官网 Models 页 2026-10-02 Free tab）——`:free` 后缀使 canonical 键全部失配，泛化 pattern 只给 262K 纯文本；能力表按各自由行补齐（qwen：视觉+视频+1M；mimo：全模态 text+image+audio+video+1M，与 canonical mimo-v2.6 系一致不声明 reasoning）。另：本机禁用表里 tokenharbor 的 5 个付费 seed 处于用户侧禁用状态（未代改，仪表盘可自行恢复）。
- **安装器品牌侧板（首装/卸载观感对齐产品设计语言）**：assisted向导（`nsis.oneClick:false`）的欢迎/完成/卸载页左侧 164×314 位图位此前是 electron-builder 默认白底占位。新增 `desktop/make_installer_art.py`（Pillow，与 make_icon.py 同工具链）按 update-window.html 同一套 globals.css token 生成 `installerSidebar.bmp` / `uninstallerSidebar.bmp`（24 位 BMP：米白底 + 应用图标同款橙渐变圆角块 + 字标 + 特性清单 + 底部品牌条），nsis 配置仅加两个位图键——NSIS 脚本逻辑一行未动。刻意只对齐有品牌位的两屏：目录/进度页保留原生（Windows 装软件的既有心智），且升级路径走壳内静默安装本就看不到向导，全套自绘不划算。
- **应用内自更新 UI 重做（`desktop/update-window.html`）**：原生「安装包已就绪」对话框与 data-URL 进度弹窗全部退役，改为统一的无边框 HTML 更新窗——状态机 检查中 → 有新版 → 下载中（进度条 + % + MB，关窗即中止）→ 就绪（立即安装/稍后）→ 错误（重试/打开 Releases）；420 宽定高自适应（ResizeObserver 回报）、圆角卡片 + 品牌主色、深色模式自适应、contextIsolation + sandbox preload（白名单 bridge）、严格 CSP 无远程资源；行为契约不变（SHA256 校验、安装前 `stopServer` 再 spawn、macOS/Portable 走 Releases 引导）。用例 `desktop-update-window.test.js` 8 例；顺带修 Windows 非整数缩放下窗口内容亚像素溢出导致更新窗出现滚动条（内容区 `overflow:hidden`，固定尺寸窗不该滚，fit 量高逻辑不变）。
- **仪表盘 → 桌面壳 更新握手（`/api/version/shell-update`）**：仪表盘内的「检查更新」与壳的更新器此前是两条平行路径——页面查到新版本只有一句文案（profile）或 Sidebar 的 Releases 链接，托盘里现成的「下载 → SHA256 校验 → 更新窗安装」全自动流程够不着（浏览器页面没有到 Electron 的桥）。按 reset-password 同款 marker 约定打通：桌面安装（sidecar 由壳以 `INSTALL_CHANNEL=desktop` 启动）下，profile 页「立即检查」发现新版本且本端为桌面渠道时出现「通过桌面壳更新」按钮，POST 在数据目录落一次性 `update-request.json`；壳每 3s 消费（`desktop/updateRequest.js`：新鲜度 15 min、时钟漂移容忍 5 min、消费即删、壳正在下载时忽略不打断），命中即跑既有 `checkForUpdates()`——检查/下载/校验/安装全复用更新窗既有状态机，marker 只承载「用户要更新」这一个意图，不带权威数据。远端（LAN/Tailscale）打开的仪表盘同样生效：sidecar 与壳同机、共用 DATA_DIR。非桌面渠道一律 403（没有壳在消费，拒绝让按钮静默无效）；新路径随 `/api/version/shutdown` 进 ALWAYS_PROTECTED；`desktop/updateRequest.js` 已登记 build.files（漏登记 = 打包后静默消失）；字面量补 zh-CN/zh-TW。用例 `desktop-update-request.test.js` 9 例（解析/新鲜度/时钟漂移/一次性消费）+ `shell-update-route.test.js` 4 例（渠道门禁/版本清洗/空 body）；desktop 源码形状三件套回归 PASS。
- **壳内「关于」窗（与更新窗同款 UI）**：托盘/菜单「关于 10Router」从原生 MessageBox 迁移为无边框 HTML 小窗（`about-window.html` + `preload-about.js`，sandbox + contextIsolation + 严格 CSP）——品牌图标 + 标语、版本胶囊、壳版本与数据目录、GitHub 外链按钮；三语文案主进程 tr() 单源，页面导航/外链全拦（外链走主进程 `shell.openExternal`）；`build.files` 同步登记两份新文件。

### 🐛 修复

- **用量统计：缓存命中率分母形状鲁棒化**：`usageHistory` 里并存两种数据形态——canonical / mirasim 导入行 prompt **含**缓存，原始 Claude 形态行 prompt **不含**缓存（实测 prompt_tokens=8 挨着 cache_read_input_tokens=263296）。旧算法 `cached >= prompt` 一刀切跳过，把缓存最密集、命中率最高的行静默丢出统计（实测 684 行）。新分母 `max(prompt, cache_read + cache_creation)` 对两种形态都成立（含缓存的 prompt 恒 ≥ read+write，独占形态被其淹没），失真守卫收窄到它原本防的那一种（input==cache 且无写入）；lifetime 新增 `cacheCreationTokens`（写入量）供后续命中/写入/未命中拆分展示。实测：参与请求 13,355 → 13,476，聚合命中率 97.5% 基本不变——高命中率是 agent 流量的真实形态（每轮整段会话前缀命中缓存），不是算法注水。
- **`/v1/models` 孤儿自定义模型不再发裸条目**：供应商无连接行时其自定义模型（如 opencode-zen 未连接下的 `ocz/fledge-alpha-free`、`ocz/space-bunny-free`）走孤儿出口——该出口此前只发 `id/owned_by`，同一 id 在已连接供应商下有完整元数据、这里却让客户端瞎猜。现与连接循环同口径解析目录能力（优先级：钉值 > 自定义行存储值 > 目录表）；并补 `fledge-alpha-free` canonical 行（models.dev opencode 条目 2026-10-02：text+image 进、1M/131072、reasoning/tool_call true，openai 转发）。用例 `models-empty-connections` 补 1 例。
- **`/v1/models` noAuth 免登录静态模型补齐上下文窗口 / 输出上限上报**：`exposeStaticModels` 发射通道（zcode-free 等无连接供应商的唯一出口）此前只发 `id/owned_by`，唯独这里不调 `getCapabilitiesForModel()`——客户端读不到 `context_length` / `max_completion_tokens`，智能体模型卡显示「该供应商也未上报窗口大小」、无法显示占用百分比；而能力表里 `glm-5.3-flash`（1M / 131072）等条目一直都在，仪表盘因走本地解析所以显示正常，只有对外列表漏了。现与已连接供应商循环同口径：LLM 类条目挂 `capabilities` 并落顶层 snake_case 字段，仪表盘钉值（modelCaps 覆盖）仍在其上。用例 `tests/unit/models-empty-connections.test.js` 补 2 例（目录值上报 / 钉值优先、嵌套块同步）。
- **供应商详情页：邀请码 chip 去重 + 连接计数半截翻译 + 26 条供应商提示文案补齐简繁**：头部与提示横幅各渲染一次邀请码 chip（APInex 页两处同屏）——删横幅内那份，保留头部；连接计数 `{n} connection{s}` 被 i18n 的 DOM 文本节点遍历器拆成「0个连接s」（"connection" 命中键、"s" 是独立节点）——改整串键 `{n} connections` / `1 connection`；registry 全部 31 条 `display.notice.text` 此前 zh-CN / zh-TW 双缺 26 条（提示横幅一直走 `translate()`，缺的只是字典条目）——全部补齐简繁两语，新增常驻审计脚本 `scripts/audit-notice-i18n.mjs` 防回潮。
- **Windows 升级安装不再被旧进程锁死（严重）**：sidecar（Next 服务）与托盘是同一个 `10Router.exe`（`ELECTRON_RUN_AS_NODE` 无窗进程），旧版卸载器对它只能"找窗口关闭"、杀不掉——v1.3.0 → 1.3.1 升级实测「Failed to uninstall old application files / 无法关闭」。两道防线：① NSIS `customInit` 在新安装器最早阶段 `taskkill /F /IM 10Router.exe /T`（升级跑的是旧版卸载器，代码改不到，只能由新安装器先清场）；② 退出路径确定性停车——托盘退出 / 应用内自更新 / NSIS 引导关闭都先 `stopServer()` 再退出，安装器到达替换阶段时锁已释放（此前 updater 是 spawn 与 quit 竞速）。1.3.1 的四个 Windows 桌面资产已**原位替换**（同版本号，CI 原版同样未签名；端到端验证：app 运行 5 进程中 `/S` 覆盖安装 24 秒完成、进程全清、版本完整）。用例 `desktop-install-kill.test.js` 5 例。

### 🔧 其他

- **`desktop/test-local.ps1` 步 7 增加「服务自报版本」校验**：`currentVersion` 是构建期烘焙进 bundle 的（`config.js` 静态 import），磁盘上 app/package.json 的手动对齐救不了它——实测 `-SkipAppBuild` 跨测试号复用旧产物（test.4 壳 + test.3 bundle）时，仪表盘陈旧检测横幅「Installed version … differs from the running build」报得完全正确、脚本却全绿。现完整构建自报版本不一致直接 Die；`-SkipAppBuild` 只警告不拦（该模式本就以「界面停留旧号」为代价），权衡显式化。

## v1.3.1 (2026-10-02)

### ✨ 新功能

- **GLM Coding 支持 Z.ai OAuth 登录（dual-auth，#上游 068ce87d）**：API key 粘贴之外新增 OAuth 设备流程（ZCode CLI 轮询协议：init → 浏览器授权 → poll → 业务 JWT → coding-plan key），凭据存 accessToken、无 refresh grant（到期重新登录，与官方 CLI 一致）；配额读取 OAuth/apikey 双通道 `Session (Nh)`/`Weekly (7d)` 动态键解析。glm-cn 保持 apikey-only（bigmodel.cn 与该流程不同源）。用例 `glm-oauth` 15 例。
- **新增 System One 决策供应商 v1m（v1m.ir，#上游 0a879c5c）**：与 Drex 同 Jev lane 的第二家后端（rev-latest / v1m-decision-engine，aliases systemone|jev），`systemoneCore` 支持 `providerSpecificData.baseUrl` 覆盖。用例 `v1m-systemone-provider` 8 例。
- **新增 Meta Muse 供应商（OAuth + 模型目录，#上游 28809807）**：Meta 官方 Muse Code 通道，双认证（OAuth 设备流程：device code → poll → 铸造订阅 key，429 退避重试、Meta 错误信封 action_url 透出；也支持粘贴 key）。五个 Muse Spark 模型全部钉 `openai-responses` 目标格式（reasoning/encrypted_content 只有 Responses 能往返），官方定价 1.25/4.25 与 contributor 档 0.10/0.20 录入；OAuth key 带 `x-api-version`，models 端点固定该头。用例 `muse-oauth` 26 例。
- **codex 暴露 GPT-6 / GPT-5.6 的 `[1m]` 长上下文变体（#上游 9f41ee75）**：六变体（astra/sol/luna + 5.6 三款）872k 窗口，`[1m]` 标记在请求入口剥离、仅用于账号 enabledModels 过滤，专属 400 走 codex 限定规则换号；models 发现的 client_version 收编 registry 单源（删除散落的 0.144.6 硬编码）。用例 `codex-extended-context` 16 例。

### 🐛 修复

- **qoder / qoder-cn 能力表缺口修复**：`auto`（INTL+CN）与 `efficient`（INTL）档位此前无 provider 行，落进 200K 能力地板且 thinkingCanDisable 语义与 qoder 执行器（思考上游固定、客户端意图丢弃）冲突——按「虚拟档家族漂移、保守超集」补齐；显示名寻址（`qoder/Qwen3.8-Max` 等）此前落到通用 family pattern（思考开放），现按内部 id 唯一真源 + `aliased()` 程序化派生别名（INTL 15 + CN 16 条映射，含档位显示名），双路径同值同语义。audit-capabilities 的 stale-allowlist 与 dead-row 检查（name 计入 offered）联动修正。用例 `qoder-capabilities` 6 例（遍历 registry 断言无地板行、别名全等）。
- **上游 v0.5.95 移植批次（一，七笔，思路重实现）**：codex CLI 身份升 **0.159.0**（0.155 起旧版被 OpenAI 限流拒绝）；codex 幽灵模型清理（gpt-5.4 系 / 5.3-codex-spark 后端一律 400）+ 新增 gpt-daybreak-blue-latest / gpt-reserve（保守 caps 随补）；`gpt-5.x/6.x` 裸 slug 路由 codex——combo/别名命中仍优先、#34 未知裸名 400 不变（`isCodexBareSlug`，`src/sse/services/model.js` chat 主路径接入）；**codex refresh-token 复用修复**（refreshLeadMs 5 天 → **10 分钟**、刷新前重读 DB 凭据、DB 有更新 token 直接采纳——此前 auto-ping 沿旧快照复用已轮换的 refresh token，触发 OpenAI 吊销、用户反复掉授权）；codebuddy CN/intl **6004 限流解析 `resetsAtMs` 精确冷却**（接入既有 codex 同款通道；上游 `UTC+8:00` 时区归一 bug 顺带修掉）；**grok-cli 版本/UA 升 1.0.44**（上游 cli-chat-proxy 已对 <1.0.13 一律 HTTP 426；pager UA 三处硬编码收编 `open-sse/config/grokCli.js` 单源）；**opencode-go 托管 DeepSeek** 走 /messages 时注入未签名 thinking 占位（精确门控 `deepSeekServed`，不误伤 minimax/qwen）；`*claude*sonnet-5*` 通配落 claude-adaptive（未知的 Sonnet 5.x id 不再落回 budget 发伪造占位）。新增用例 codex-registry-and-routing 30+ / codex-refresh-reuse-guard 11 / codebuddy-parse-error 7 / grok-cli-oauth-ua 5 / opencode-go-deepseek-thinking 7 / capabilities-sonnet-5-wildcard 4；providers/alias 基线重快照；全量回归门禁 PASS。
- **上游 v0.5.95 移植批次（二，六笔）**：**Claude 尾部 user 轮保留 + 有意 prefill 保护**（`ensureTrailingUserTurn` + `detectClientLastRole`——清理后 body 不得以 assistant 结尾（新版 Claude 直接 400），而 Gemini/Responses 源格式显式 prefill 不误伤）；**工具循环末轮 tool_result 第 4 缓存断点**（5m ephemeral，工具循环每轮不再为末轮 tool_result 付未缓存价）；**Claude Sonnet 5.5** 登记（含 `thinkingOffType` / `forcedToolChoice` 归一化——关 thinking 走 between_tools、xhigh/max effort 夹 high、any/tool 归一 auto）；**Kiro claude-opus-5.5** 点号四变体 + capabilities；**GPT-6 Sol/Luna caps + 官方定价校准**（astra 5/30→10/50、sol 2/10、luna 0.10/0.50、6.1-sol 2/10 且 cached 与 6-sol 刻意不同）与真实窗口（devin-cli 200k 档位、`*gpt-6*` pattern 抄错的 272k → 1.05M、5.4/5.5/5.6 档位补全、cx/dv 别名）；**claude-adaptive 支持 xhigh**（六档 `budgetX`，*claude*4.6* 维持五档钳制；Kiro 的 max 解除钳、xhigh 按模型档位表透传）。新增用例 claude-trailing-user-turn 15+3 / claude-cache-final-tool-results 6 / claude-sonnet-5-5-translator 8 / gpt6-capabilities-pricing 11 / kiro-claude-opus-5-5 10 / thinking-levels-kiro 重写；audit-capabilities / audit-pricing / providers 基线 PASS；全量回归门禁 PASS。
- **上游 v0.5.95 移植批次（三，八笔）**：**DeepSeek 同名工具去重**（`dedupeTools(tools, {clientTool, model})`——deepseek 模型同名保留首个，上游稳定 400 "Tool names must be unique" 消除；Claude MCP 等价规则语义不变）；**Gemini tool schema 剥离清单补齐**（errorMessage(s)、x-intellij-html-description、x-taplo*、doNotSuggest、suggestSortText、min/maxProperties 等，Antigravity 400 消除；顺带去掉清单内重复项）；**strictProxy 池失效防直连**（代理解析失败但存在代理意图时 fail-closed 抛错，不再静默回落直连泄漏真实 IP；无代理意图的调用方行为不变）；**Responses 延迟补发 3s watchdog**（尾部 usage 到达或 [DONE] 即补发 completed；上游 stall 时 3s 兜底，不双发）；**配额页 `?provider=` URL 深链**（初值 URL > localStorage，切换 `router.replace` 回写，可书签）；**用量统计排除 hidden 供应商**（已连接账号分支对齐过滤）；**zed live 模型目录**（ModelSelectModal 泛化为逐供应商 live catalog 聚合 + 后端 `PROVIDER_MODELS_CONFIG` 补 zed 条目打通闭环，hosted-disabled 行过滤）；**模型别名补齐**（`deepseek-v4-1-flash` vision alias 防图片静默被剥、agnes-2.5-pro-beta / agnes-3.0-flash 种子）。新增用例 gemini-unknown-schema-fields 6 / strict-proxy-enforcement 10 / openai-responses-completion-watchdog 4 / tool-deduper 13 / quota-provider-url-param 等五文件 27；providers/alias 基线 PASS；全量回归门禁 PASS。
- **配额卡片：月度沉底 + 实验性「嵌套周期配额条」开关**：平铺周期行顺序从 月度→滚动→每周 改为 **滚动→每周→月度**（最宽窗口锚定底部）；实验页新增开关（localStorage `quotaNestedCycle`，配额页下次加载生效）——打开后滚动 ⊂ 每周 ⊂ 月度 的包含链恢复为上版同心嵌套轨道（`NestedCycleTrack`），`buildNestedCycle` 增 `force` 选项放宽「每层上限严格小于父层」规则（commandcode 每周与月度同为 6 的等值上限此前因此无法嵌套）；默认行为不变。用例 `quota-card-cycle-rows` 补 3 例（等值链默认平铺/force 嵌套钳制/force 仍需月度头）。
- **设置→安全 开启「需要登录」不再把自己踢出**：建立防护（设置密码 / 开启登录校验）的 PATCH 此前不签发会话——靠本机信任或免密访问进来的操作者在校验生效瞬间手里没有任何凭据，立刻被弹到登录页（远程 Tailscale/隧道场景尤为突兀）。`PATCH /api/settings` 成功设置密码或开启校验时，为已通过全部守卫的当前会话签发 auth cookie；拒绝请求与无关设置变更不签发。登录页「忘记密码？」入口补中文，找回面板重写为明确的 reset-password 文件格式说明并链接完整文档 `docs/zh-CN/dashboard-password-recovery.md`，全面板简/繁本地化。找回文件接受 **`reset-password.*` 任意扩展名**（Windows 资源管理器建无扩展名文件不便且默认隐藏扩展名，`reset-password.txt/.md` 均有效；并存时无扩展名版本优先、其余按字典序消费，`reset-password-old` 这类不带点的名字不匹配）。用例 `tests/unit/issue-33-password-lockout.test.js` 扩至 20 例（签发时机/拒发分支/扩展名通配与优先级）。
- **Drex「获取 API 密钥」改指邀请链接**：Nace 当前为邀请制注册，`dashboard/api-keys` 对未注册用户是一条死路；取 key 链接改为 `https://drex.nace.ai/invite/tnzgt5vr`。
- **README 版式**：交流群二维码再缩 20%（280 → 224px）并改为左对齐；贡献者致谢头像固定每行 10 个排布。

## v1.3.0 (2026-10-01)

### ✨ 新功能

- **桌面版应用内自更新（Windows 安装版）**：托盘/菜单「检查更新」发现新版本后不再只弹窗引导去 Releases 页——直接从对应 release 下载 `10Router.Setup.<版本>.exe`（进度窗 + 任务栏进度条，关窗即取消），按 `SHA256SUMS-desktop.txt` 校验后运行安装（发布端 sums 里的文件名是空格分隔、资产名是点分隔，按「小写+去非字母数字」归一后匹配，避免永远失配）。版本口径不变：仍以 `/api/version`（npm latest）为主数据源；本地服务不在时壳内直查 GitHub Releases API 兜底（服务挂了也能查更新）。macOS / Portable / release 缺安装包维持原「打开 Releases 页面」引导。纯逻辑拆 `desktop/releaseUpdater.js`（资产挑选、sums/资产名漂移归一匹配、版本比较），用例 `tests/unit/desktop-release-updater.test.js` 16 例；桌面壳三语更新文案同步补齐，并以源码形状用例钉住 en/zh-CN/zh-TW 三语完整性与 `?check=1` 显式检查语义。
- **CLI 工具「模型组合方案」（Claude 卡，#17）**：Claude 工具卡新增 Profiles 栏——把当前表单（Opus/Sonnet/Haiku 映射 + API Key + 上下文窗口）存为命名方案，可存多组；下拉选中**即写入** `~/.claude/settings.json`（对标 CC-Switch 的切换体验，无需再点 Apply）。方案存服务端 settings（`cliToolProfiles` 键）而非浏览器 localStorage，NAS / Tailscale / 隧道多端访问同一实例时共享同一份；卡片按磁盘上当前 settings 自动预选对应方案（端点 + Key + 三模型槽位全等才算命中）。`/api/cli-tools/claude-profiles` CRUD，env 白名单过滤（写用户真实 settings.json 的入口不接受任意键）；组件按 per-tool 通用件写，Codex / Droid 等同构卡后续零成本接入。**保存以名称为目标**（CC-Switch 语义）：重名即更新该方案、新名即另存新方案，空名称且有选中方案时沿用其名——修掉「同一组合反复保存建出一串同名方案 / 选中后另存反被覆盖」的坑。测试 `tests/unit/cli-tool-profiles.test.js` 12 例（清洗/上限/原地更新/匹配器）。
- **新增搜索 + 抓取供应商 TinyFish 与 Keenable（webSearch / webFetch 双能力，#26）**：两个 registry 条目都同时带 `searchConfig` + `fetchConfig`、`serviceKinds: ["webSearch","webFetch"]`，按既有 registry 驱动链路自动浮出——仪表盘 media-providers 的 Web Search / Web Fetch 两页、主供应商页、`/v1/search` 与 `/v1/web/fetch` 都零改动接上。
  - **TinyFish**（归 `freeTier`）：Search 走 `GET https://api.search.tinyfish.ai`（`X-API-Key`；支持 `location`/`language`/`include_domains`/`exclude_domains`、`search_type=news` 映射 `domain_type`、`time_range` 映射 `recency_minutes`（1440/10080/43200/525600）、`offset` 换算 0 基 `page`）；Fetch 走 `POST https://api.fetch.tinyfish.ai`（`{urls:[…], format}`，我们请求的 `text` 映射为其 `markdown`，`html` 直传）。上游只回 `results[]`，空结果时把 `errors[0].error` 原样透出而不是报一个含糊的 502。官方口径是「任意余额免费、不扣钱包」，故 `category: freeTier` + 免费额度标 Unlimited，取 key 链接 `agent.tinyfish.ai/api-keys`。
  - **Keenable**（标准 `apikey`，积分计费、不虚标免费额度）：Search 走 `POST https://api.keenable.ai/v1/search`，`provider_options.mode` 可选 `pro`/`realtime`（越界值忽略），`time_range` 映射为相对增量 `1d/7d/30d/365d`；`site` 上游只收单域名，**多域名过滤刻意丢弃**（宁可少过滤也不静默只取第一个）；Fetch 走 `GET https://api.keenable.ai/v1/fetch?url=…&max_chars=…` 并强制 `live=true` —— 上游默认只吐已索引 URL，不开就抓不到任意地址。取 key 链接 `app.keenable.ai/console`。
  - 配套改动：`handlers/search/callers.js` 两个 request builder + `handlers/search/normalizers.js` 两个归一（Keenable `description`→`snippet`、`snippet`→`content.text`；两家非数组 payload 统一回 `{results: [], totalResults: null}`，与既有归一的降级口径一致）；`handlers/fetch/index.js` 两个 runner（上游地址读 `providerConfig.baseUrl`，配置驱动不写死）；`registry/index.js` 追加 `p144/p145`。
  - 用例 `tests/unit/tinyfish-keenable-wiring.test.js`（25 例）：注册契约与前端双 kind 浮现、两个 builder 的字段映射与边界（无 key 报错、单域名 site、mode 越界忽略、0 基分页）、归一与降级、fetch 分派用 stub `globalThis.fetch` 打桩校验 method/auth 头/body、`live=true` 与 `max_chars` 透传、per-URL 错误透出。lint 0 error（3 条 warning 与 `tavily.js` 等既有注册表文件同款匿名默认导出提示），三项 registry 基线（providers/alias/oauth-urls）与 `audit-capabilities` 全部 PASS。

- **新增 System One 决策供应商 Drex（TypeSafe/Jev 线协议兼容）**：nace.ai 的决策模型（drex.nace.ai），官方文档自述 wire-compatible with TypeSafe's Jev——直接复用 `/v1/systemone` 决策 lane，零翻译层（state + noul/choice/score typed questions → 校准概率分布 + confidence），Bearer `nace_sk_` key 由 systemoneCore 注入。模型面按 2026-10-01 实测 GET /v1/models 收录 drex-v1.0 / v1.1 / v1.5（state 上限 131,072 tokens）/ drex-latest；与 search 系供应商同口径：无 chat transport（media-only 先例），API 仅 evaluate + list models 两个端点、无额度接口，不挂 usage 卡。取 key 链接 `dashboard/api-keys`；官方立方体 logo 生成 `public/providers/drex.png`（白色圆角底，深浅色主题通吃）。用例 `tests/unit/drex-wiring.test.js` 4 例，providers/alias 基线重快照（alias 探针 +drex）。

- **/v1/models 能力元数据与 Combo 能力聚合（`5c217d34` + `37a6b7e0` 思路重实现）**：新增 `aggregateComboCapabilities` —— 组合能力按成员保守聚合（vision/pdf/audio/video/imageOutput/audioOutput/search 取并集，tools 取交集，reasoning/thinking 字段取主模型，contextWindow 取 min、maxOutput 取 max），支持嵌套组合递归（防环）与 `resolveCaps` 覆盖回调（浏览器端拿不到仅服务端可见的同步目录，仪表盘经 useModelCaps 把服务端答案喂进来，本地表仍独占 tools/pdf/thinking 字段）。`/v1/models` 组合条目带 `capabilities`，静态目录分支的模型行也补齐能力元数据；Combos 卡片显示成员徽章（嵌套组合解析）与聚合 ctx/max 行。Pattern 修正：`*qwen*max*` 补 vision；MiniMax M3 修正为 1M/131072、M2.7 补 vision、补 M2.5 行；MiMo v2.5 代际补 `<think>` 常开 reasoning（deepseek 形态）。用例 `tests/unit/combo-capabilities.test.js` + `tests/unit/combo-caps-resolver.test.js` 18 例。

- **新增 OpenCode Zen PAYG 供应商（`ocz`，`49185137` 思路重实现）**：opencode zen 平台的付费按量通道——真 API key（Bearer）解锁完整目录（Claude / Gemini / GPT / Grok / Kimi / GLM / MiniMax / Qwen / DeepSeek / Muse Spark…），免费档 id 在同一把 key 下照常可用。三端点多 transport（/chat/completions、/messages、/responses）按客户端 sourceFormat 直连，per-model `supportedFormats` 门控路由（与 opencode-go 同契约）；目录按官方定价表 2026-10-01 现值校准（含 Claude Opus 5.5 / Grok 4.7 / Qwen3.8 / DeepSeek V4.1 Flash / MiMo-V2.6-Flash）。专属执行器：免费档指纹（bash/glob/grep/read 四件套 + 强制 stream:true）、x-opencode-client 桌面标识、UA 合规版本透传、zen 会话头（原生透传 / 确定性派生）、Muse Spark 强制 /responses（Responses 形状归一 + reasoning 项剔除 + tool 扁平化）。额度走 GET /zen/v1/usage 滚动/周/月百分比窗口（features 双旗标接入 Provider Limits）。能力表补 muse-spark-1.3（付费档，此前仅 -contributor-free 有行）；audit allowlist +`opencode-zen/union-alpha`（代号）。用例 `tests/unit/opencode-zen-models.test.js` 22 例，providers/alias 基线重快照（alias 探针 +ocz）。

- **OpenAI 客户端拿回 Claude 思考文本（`90b06934` 思路重实现）**：Claude 只在请求带 `thinking.display:"summarized"` 时才回传思考文本，而该字段在 OpenAI 形态没有等价物——此前 reasoning_effort 拉满，reasoning_content 也恒为空。`captureThinking` 在格式翻译前捕获 OpenAI 客户端的"要思考文本"意图（Chat Completions 的 `reasoning_effort` 即请求；Responses 的 `reasoning.summary` 为显式摘要请求），`applyThinking` 把 display 注入 Claude 请求体（adaptive/enabled 两形态），执行器侧 `selectAnthropicBeta` 随 body 摘除 redact-thinking（`cb99d4bc` 的联动半边）。claude→openai 流翻译里 thinking 只走 reasoning_content（移除 `<think>` 字面标记——OpenAI 客户端会当正文渲染），Responses 流在答案文本/工具调用开始时即关闭 reasoning 段（reasoning_content 流没有 `</think>` 信号）。用例 `openai-thinking-display`（请求形状）+ `claude-thinking-stream-boundaries`（流边界）+ `claude-refusal-stream`（refusal stop_reason 以 content_filter + 官方解释到达 OpenAI 客户端的 live 钉形状）。
- **Claude 免费限流重置额度展示与兑换（`e571a8b6` 思路重实现）**：OAuth 用量端点带 `cedar_ember=1`（与 Claude Code 同参）拉取免费 "limit reset" 补给块，解析 grants（剩余次数/到期/清零的窗口/冷却）。Provider Limits 卡片展示可用重置次数并一键兑换——`POST /api/usage/[connectionId]/claude-reset` 先经 profile 解析 org，再打 org 级 reset 端点（program `cedar_ember` + grant_id + request_id），成功即清本地用量缓存强制下次重读。重置发放按 surface 门控：UA 用 `(external, cli)`（Claude Code 轮询用量即此身份，聊天才走 sdk）；`CLAUDE_CLI_VERSION` 抽为常量与伪造指纹共用。用例 `claude-reset-grants`（解析形状与消耗函数契约）。

- **上游 v0.5.91 余量移植批次（一批七笔）**：新增聚合器供应商 Token Harbor / Dahl Inference / Atria Dawn（`737b1f4d`+`06112c13` 思路，OpenAI 兼容直连 + live 模型拉取 + capabilities 显式防低报）；opencode 指纹工具四件套抽成公共模块、tool rename 在三条非流式 JSON 路径与同格式直通路径双向闭环（`93837af0`/`822aa958` 系）；POST /api/providers 同名校验下沉 repo 事务层、批量导入 key 降 O(1)（`239bcfc5`）；Tailscale enable 健康等待收敛 20s（`e7c269b8`）；opencode-go 的 glm-5.3-flash 改走 reasoning_effort、mimo-v2.5-pro 档位收敛（`477b2aed`/`1b72f02e`）；qoder 计费阻断补 code 110（`2daf25ff` 部分）；OAuth 弹窗粘贴 token 入口按配置门控（`7a436d20` 同主题）；ollama 免费计划月度窗口按注册日推导重置（`73e0218b`）。用例 tokenharbor-provider / opencode-fingerprint / provider-priority-insert-cost / ollama-usage 扩充全绿。

### 🐛 修复

- **虚拟 key 可远程写自定义 provider（#38）**：`POST /api/providers` 与 `/api/provider-nodes` 的虚拟 key 例外此前嵌在 `ALWAYS_PROTECTED` 分支内，而这两个路径不在该列表里，例外永不匹配，远程带有效虚拟 key 一律 401（CreditDaddy 同步账号通道）。例外提到该判断之外；`[id]` 上的 list/update/delete 仍受保护。`tests/unit/dashboard-guard-provider-write.test.js` 覆盖远程放行与 `[id]` 仍 401。
- **MITM sudo 启动不再把 ROUTER_API_KEY 写进 argv（#31）**：`sudo -S -E sh -c <cmd>` 的整条命令行在 /proc/<pid>/cmdline 里常驻、本机任意用户可读。key 改走 stdin 第二行（sudo 吃第一行密码、`IFS= read -r` 吃第二行），shell 内 `export` 后 `exec` 起服务，服务自身 argv 也干净。守卫用例 `tests/unit/mitm-sudo-apikey-argv.test.js` 4 例（源码级钉形状）；顺带修掉 `outbound-proxy-loopback.test.js` 的 cwd 陷阱（源码路径改从测试文件自身解析，tests/ 与仓库根两种跑法都绿——该用例此前在基线里常红）。
- **未知裸模型名不再按前缀猜 provider 后静默回落（#34）**：`/v1/chat/completions` 发不带 provider 前缀的裸名（如 `deepseek-v4.1-flash`）此前按名字前缀猜 provider（`deepseek-`→openrouter、`claude-`→anthropic、其余→openai），猜中后直接去撞凭证库，报出与真实原因毫不相干的 `No active credentials for provider: <猜的>` 404。现在 chat 主路径对未命中别名/combo 的裸名直接拒绝：400 `Unknown model: "<name>"…`，指向 `/v1/models` 的带前缀 id。**范围刻意收窄**：仅 chat 主路径关闭推断；`/v1/audio|images|embeddings` 等 OpenAI SDK 惯例发裸名（`tts-1`）的面保留推断；combo 内部条目（作者显式写入）与内置/用户别名不受影响。解析重构为 `resolveModelAliasCore`（纯别名解析）+ 可选推断，测试 `tests/unit/bare-model-resolution.test.js` 8 例。
- **ZCode 免费体验包供应商（`zcode-free`，体验分类）**：Start Plan / Trust Build 体验包（GLM-5.3-Flash，1M 上下文 + 视觉）经 CreditDaddy 桌面版「额度网关」接入——上游 `POST http://127.0.0.1:47860/gateway/v1/messages`（Anthropic 形态），CreditDaddy 负责账号轮换 + 隐藏窗口静默过阿里云验证码；本条目只做端点映射，noAuth 无需连接行。体验分类与 OpenCode Free 一致（`community` 默认展示在体验簇）。配套：`/v1/models` 对 noAuth 供应商新增注册表模型发射通道（`exposeStaticModels` 显式 opt-in，不影响 opencode / mimo-free 既有行为）；官方 Z 图标 `public/providers/zcode-free.png`。
  - **CreditDaddy 主机可配置**：`zcode-free` 卡片可设置网关主机（留空 = 本机 127.0.0.1，局域网填 CreditDaddy 主机 IP + 端口，默认 47860）——`getProviderCredentials` 对 noAuth 虚拟连接注入覆盖 baseUrl，执行器按注入值拼 `/messages`；建了带 key 的连接时优先走真实连接（key = 对端「10Router 连接设置」的虚拟 key，远程网关鉴权用）。
  - **接入与反代实战文档**：详尽梳理 ZCode 客户端反向路由至 10Router 网关、免费体验包额度网关消费、以及官方 Coding Plan 正式订阅直连的三重链路与避坑指南，产出 `docs/zh-CN/zcode-integration-and-proxy-guide.md`。

- **配额可视化重构：QuotaToolbar 与配额窗口时间线（#26、#28 协同）**：
  - **响应式工具栏与窗口时间线**：新增 `QuotaToolbar`、`QuotaWindowTimeline` 与 `QuotaMeter`，支持在用量页展示各供应商周/月滚动周期窗口，直观呈现额度到期倒计时与重置进度。
  - **会话级视图切换（非持久化）**：用量页顶部增加「卡片」与「配额窗口」Tab 切换。刻意设计为仅会话态内存保持，刷新或再次进入恒定默认开启「卡片」视图，绝不落 localStorage，彻底避免用户上次查看时间线后下次打开找不到卡片的迷失感。
  - **多包分段进度条与明细折叠**：`QuotaPackBar` 忠实对齐 CreditDaddy 视觉语义，支持多资源包（赠送包/套餐包）分段聚合展示，并在卡片顶部显示精确最近到期时间。配套完整单测（`tests/unit/quota-*.test.js`）。

- **Qoder 逐资源包明细优先用 CreditDaddy 同步的网页会话（`648ac994`）**：
  - openapi 仅有聚合 addOnQuota，逐包（精确 used + 各自到期）只在网页端 `/api/v2/me/usages/big_model_credits` 提供（仅认浏览器 httpOnly Cookie）。
  - CreditDaddy 登录窗口会捕获该 Cookie 并随账号同步写进 `providerSpecificData.creditDaddyWebSession`。
  - `getQoderUsage` 优先利用该会话拉取精确 packs 并进行所有者 `userId` 校验防串号；无会话或 401 时平滑降级至既有 campaign 近似。单测 `tests/unit/qoder-web-packs.test.js` 4 例。

- **LongCat-2.5-Preview 与国际站支持**：新增 LongCat-2.5-Preview（1M/128K 上下文，支持图像与视频双模态输入，支持思考模式开关），并补充 `longcat.ai` 国际站独立提供商卡片与 CN 邀请链接。

- **桌面壳「容器」密码管理（浏览器式全自动，`639f77a8`）**：主窗体/壳内弹窗加载的外部网页（「前往→打开网址/最近打开」的 WorkBuddy、CodeBuddy 等）此前零密码能力。三件套：`desktop/passwordStore.js`（纯 Node 密码库，cipher 注入可测；`userData/passwords.json` 只落 Electron safeStorage 密文——Windows 即 DPAPI 绑当前系统用户；同 origin+username 幂等、密码不同即更新、neverAsk 站点黑名单、上限 200 条）+ `desktop/preload-container.js`（sandbox 安全 preload，不向页面暴露任何东西）+ `main.js` 容器登记 / 保存询问窗 / 管理窗 / 右键填充。行为与边界：
  - **捕获双路**：`<form>` submit 直接抓用户名+密码；SPA 无 form 登录靠启发式——密码框输入防抖上报，主进程在 did-navigate 同 origin 换路径时视为登录成功转保存询问（原地提交 / 换站 / 超 10 分钟不算）；多密码框值不同=注册/改密表单，跳过。询问窗可改完用户名密码再存，或「永不保存此站点」。
  - **填充**：该站恰好一条已存条目时，聚焦空密码框/配对用户名框自动回填（React 受控输入走原型 setter + input/change 事件）；多账号只在右键菜单「填充密码：用户名」条目上显式选，明文在点击那一刻才 reveal。漏网的走「前往→管理已保存的密码…」（Ctrl+Shift+P）手动补录 / 改 / 复制 / 两步删除。
  - **安全边界**：preload 只认 isTrusted 输入事件（程序化填充派发的合成事件不会再被捕获，防「填充→上报→重复弹窗」回环）；归属 origin 只信主进程侧 `senderFrame.url`，渲染层传参一律不采信；`pw:fill` 广播给全部 frame、各 frame 按 location.origin 自滤，跨域 iframe 拿不到；safeStorage 不可用→功能停用 + 气泡提示，绝不落明文。HTTP Basic/Digest（`app.on('login')`）、同步、导出为 v1 非目标。
  - **打包注意**：`desktop/package.json` 的 `build.files` 白名单同步补了两个新文件——壳新增文件漏登记 = 打包后功能静默消失。
  - 单测 `desktop-password-store.test.js` 17 例（假 cipher 纯 Node：origin 归一化 / 幂等 / 持久化 / 坏文件自愈 / cipher 不可用拒写）。

### 🐛 修复

- **配额重置时间改为自适应倒计时**：卡片/资源包上的重置与到期时间不再是只有日期的"10-01 重置"——未来时间统一显示倒计时，精度随量级自适应（≥1 天显示「天+小时」、不足一天「时+分」、不足一小时「分+秒」，如 `6d 3h` / `4h 44m` / `38m 12s`），悬停仍可见完整绝对时间；`shortDuration` 收编为全局面额（QuotaTable / QuotaPackBar / QuotaProgressBar 同一规则），i18n 新增 `resets in {duration}` / `expires in {duration}`。
- **配额窗口「5 小时」视图以现在为中心**：时间轴从自然日 00–24 点改为此时此刻前后 12 小时（起点取整到整点），"现在"永远在轨道中段——此前傍晚查看时当前时刻被顶到最右缘、整屏都是已过去的窗口；副标题同步显示起止时刻。
- **用量详情输入 Token 不再被缓存值顶替（`5fa83137`）**：请求明细存的是未折叠的 Claude 形态 usage（`prompt_tokens` 不含缓存，`cache_read_input_tokens` 另存）。此前前端在 `prompt < cache` 时直接回退显示 cache，导致高缓存命中供应商（如 `zcode-free` 命中率约 99%）输入与缓存列显示恒为 1:1。抽离 `src/shared/utils/usageDisplay.js` 判别式：无顶层 `cached_tokens` 时自动折叠 `prompt + cacheRead + cacheCreation`，恢复真实输入总量展示。
- **全新安装冷启动静态模型暴露（`54bb9469`）**：修复在数据库没有任何连接行的新安装环境下，`noAuth` 供应商（如 opencode、mimo-free、zcode-free）在 `/v1/models` 无法列出模型的问题；针对带 `exposeStaticModels: true` 的提供商自动派发静态模型定义。
- **OpenAI Responses 审核中断原因映射（`96157305`）**：`nonStreamingHandler` 将 Responses 格式中的 `incomplete_details.reason === "content_filter"` 正确转换为 Chat 补全规范的 `finish_reason: "content_filter"`（此前误回落至 `"length"`），避免下游 SDK 误判为 token 上限截断。
- **代理配置容错与严格代理链路打通（#36、`a382c9c6`）**：
  - **无 Scheme 主机自动归一**：`proxyFetch` 与 `outboundProxy` 允许填入无 scheme 的代理地址（如 `127.0.0.1:7890`，自动规范为 `http://`），提升配置容错性；
  - **密文解密失败防直连逃逸**：代理密文解析失败时维持不可读密文字符串，防止触发 `strictProxy` 关闭时的直连降级通道，杜绝代理泄漏风险；
  - **保存时协议白名单拦截**：在代理池及供应商独立代理的创建/更新路由接入协议校验（`http/https/socks4/5/5h/4a`），精准识别并阻断 `enc://` 等不支持协议。
- **主题模式系统自适应与防闪烁（`7d827880`、`ff787829`）**：登录页支持主题切换，全局增加跟随系统昼夜变化机制（Win/fnOS/macOS）；在 HTML 根注入 pre-paint 启动脚本，彻底根除深色模式刷新时的白屏闪烁。
  - **已有密文兼容解密**：在解析代理池及连接配置时增加 `unwrapProxyUrl`，透明解密误存或迁移遗留的 `enc:v1:` 格式，防止因协议解析异常中断。
  - 附单测 `issue-36-proxy-strict.test.js` 8 例。

- **反重力（Antigravity）请求：工具清洗升级 + 去掉 `requestType:"agent"`**（对照 9router v0.5.91 与 OmniRoute 的同类修复，按本仓风格重写，未合入上游代码）。
  - **不再发 `requestType:"agent"`**：官方客户端在 agent（对话）路径上根本不带这个字段，带上后 Google 会把请求归入另一个桶，**有额度也回无详情的 429 RESOURCE_EXHAUSTED**。翻译器两处信封不再写入，执行器再兜底删除（防止入站信封经 `...body` 展开带出）；`image_gen` 保留自己的 requestType。
  - **空字符串工具结果被丢 → 400**：openai→gemini 用 `if (!toolResponses[fid])` 判断有无结果，`""` 是假值被跳过——无输出的命令（`mkdir`、写文件）照样触发；更糟的是本仓自己的 `fixMissingToolResponses` 给未应答调用补的占位就是 `content: ""`，于是这道修复对 Gemini / 反重力**从来没生效过**，留下没有 functionResponse 的 functionCall，Gemini 直接 400。改为按 `undefined` 判定。对 gemini / vertex / gemini-cli 同样生效。
  - **改名的工具名会映射回原名**：Gemini 要求函数名匹配 `[a-zA-Z_][a-zA-Z0-9_.:\-]{0,63}`，数字开头（`1password_get`）、含 `/` 或空格、超 64 字符的名字此前被改名后**不还原**，模型调用的是客户端从没声明过的名字。新增 `translator/concerns/geminiTools.js`：每个请求一个命名器，声明与历史里的同一原名保证同一新名，改名记入 `_toolNameMap`，流式（`emitFunctionCall` 既有通道）与非流式（`translateNonStreamingResponse` 新增参数）都还原。`_toolNameMap` 以**不可枚举属性**挂出——Zed 执行器直接把翻译结果发上游，可枚举的话会序列化成未知字段。超 64 字符由截断改为「可读前缀 + 原名哈希」：以前两个前 64 字符相同的 MCP 工具截断后同名，执行器去重时**静默丢掉第二个**。
  - **schema 清洗按结构遍历，属性名不再被当关键字删**：旧实现把 `properties` 映射的键（属性名）当 schema 关键字比对，名为 `title` / `format` / `default` 的参数被整个删掉，名为 `properties` 的参数会被写入 `type` 字段。改为识别 `properties` / `$defs` / `definitions` / `patternProperties` / `dependentSchemas` 只下钻其值，`enum` / `default` / `examples` / `required` 等数据键不下钻。这是加新关键字的前提（否则名为 `strict`、`tags` 的参数会跟着消失）。
  - **新增剥离**：`strict`（OpenAI strict 模式塞进 parameters，RubyLLM 等默认如此）、`encrypted`（Codex 多 agent 工具）、`~` 前缀键（Zod 4 / Valibot 的 `~optional` 等 Standard Schema 元数据）、`$id` / `$anchor` / `$dynamicRef` / `$dynamicAnchor` / `$vocabulary`、`minContains` / `maxContains`、Copilot 注入的 `markdownDescription` / `markdownEnumDescriptions` / `enumItemLabels`——均为 Gemini「Unknown name … Cannot find field」整请求 400。数值类型（integer / number）上的 `enum` 改为删除（Gemini 只接受字符串 enum，旧逻辑转成字符串 enum 挂在 integer 上）。
  - **本地 `$ref` 内联**：pydantic / FastMCP 生成的工具 schema 把模型都放进 `$defs`，旧逻辑直接剥掉 `$ref` 留下 `{}`，再被补成 `{reason}` 占位——模型拿不到真实参数结构。现先按 JSON Pointer 内联（支持 `~0` / `~1` 转义，`$ref` 同级的 description 等覆盖目标），循环引用断在第二层，内联预算 256 次防菱形引用膨胀；外部 / 无法解析的引用仍按旧逻辑剥离。可空 `anyOf` 展平时保留字段自身的 description。清洗改为**不修改入参**（Claude 模型路径此前会原地改写客户端请求体里的 `input_schema`）。
  - **parameters 根节点强制 object**：Gemini 要求 `functionDeclaration.parameters` 为 OBJECT，Copilot 的 `terminal_last_command` 等只给 `{properties}` 不带 `type`，或给标量 / 数组根。无 `type` 补 `object`（保留其余关键字，union 仍可展平），标量 / 数组根替换为空 object（只留 description）。
  - **反重力路径的对话轮次兜底**（仅执行器，gemini / vertex 共享翻译器不受影响）：首轮不是 user 时补一个 user 轮；以 model 轮结尾时追加 `Continue.` user 轮，结尾有未应答的 functionCall 则补对应 functionResponse。同时剔除空 part、合并相邻同角色轮次。
  - 用例 `antigravity-tool-sanitize.test.js` 26 例（关键字剥离 / 属性名同名保留 / `$ref` 内联含循环与转义 / 根节点强制 / 命名器与冲突 / 流式与非流式还原 / 空结果配对 / requestType / 轮次兜底）；`stop-sequence-wiring.test.js` 的调用签名断言随 `translateNonStreamingResponse` 新参数更新。全量回归门禁 0 回归，三份注册表基线逐字节一致。

### 🔧 其他

- **发版面订正：v1.2.1 块的 10router-sync 插件版本号 v1.5.0 → v1.5.1**。插件功能开发于 v1.5.0（`a6b5591d`），但发版时随 mirasim 两笔订正（`21bae482` / `ca20e946`）折叠为 **1.5.1** 发布——插件三处版本位（`.zcode-plugin/plugin.json` + 根 / 子 `marketplace.json`）均为 1.5.1，v1.2.1 主题句写对、条目标题没跟上（v1.2.1 发版后全量审查揪出）。只订正本文件；用户侧 `public/i18n/changelog/` 的 v1.2.1 段保持已发布形态不动（非 tag 提交不动用户端 changelog，且该段已随 v1.2.1 资产定形）。

## v1.2.1 (2026-09-26)

> 本版主题：**CreditDaddy 接入 + 导入用量计价 + 启动与运维加固**。额度总览只读接口、导入用量预估计价、服务启动即初始化（重启后远程访问不再等人打开页面）、可关闭自动检查更新 / 可隐藏登录关闭横幅；修复 qoder 排队限流被当成回复、mirasim 口径与订正脚本、开机成本修复卡死。并修复 **#33 开启登录校验后被锁死**（拒绝在没有自己密码时开启 + 新增找回密码入口，fnOS 可在应用设置里重置）。鉴权请求头改名向后兼容，无破坏性变更，走 patch。同批插件 10router-sync v1.5.1。

### 🔒 安全 / 修复

- **[重要] 开启登录校验后被锁在外面、任何密码都 401（#33）**：并非存了空密码（前端 `required`、后端空值都不会落库）。真正路径：fnOS 安装时生成随机初始密码写进用户看不到的 `initial-password` 文件；用户在登录校验关闭时打开「需要登录」——密码表单只在开启后才出现，没法先设——此后唯一有效的就是那个看不到的初始密码（旧默认 123456 早已移除），输什么都 401，除了重装无路可退。**防**：设置接口拒绝空 / 纯空白密码（按键存在判定，原先 `if (body.newPassword)` 让 `""` 静默放过）；**没有自己的凭据（已存密码或完整 SSO，初始密码不算）时拒绝开启登录校验**（400 `PASSWORD_REQUIRED`），界面改为弹「设置密码后开启」对话框，密码与开关同一请求落库。**救**：数据目录放一个 `reset-password` 文件——有内容即设为新密码，空文件则清掉已存密码回到首次登录密码；在下一次登录尝试 / 登录页加载 / 服务启动时生效（无需重启），读后立即删除，不留明文。入口：登录页新增「忘记密码？」说明各安装方式的做法；**fnOS 在「应用中心 → 10Router → 应用设置」直接填新密码保存**（新增 `wizard/config` + `config_callback` 写该文件，日志只记事件不记密码）。能写数据目录者本就能读整库，此入口不新增权限。用例 `issue-33-password-lockout.test.js` 15 例（含按报告复现锁死 → 放文件 → 立刻登入的端到端）。

### ✨ 新功能 / 修复

- **10router-sync 插件 v1.5.1：ZCode 大版本套餐渠道 id 适配 + mirasim 输入口径全量订正 + 10r 同步链路加固**（功能开发于 v1.5.0，发版折叠为 1.5.1；原条目错位于 v1.1.2 块，随 v1.2.1 发版归位）。
  - **套餐渠道 id 适配**：ZCode 大版本把套餐/赠送配额渠道（智谱 Start Plan）的 provider id 从 `builtin:bigmodel-start-plan` 改为 `account:bigmodel-start-plan`，插件的官方判据从「仅 `builtin:`」扩为「`builtin:` 或 `account:`」，剥前缀规则同步扩展（新旧行在目标侧同名合并为 `zcode-bigmodel-start-plan`）。旧判据把新形态当自定义渠道跳过，导致 09-18 起套餐流量漏同步——本机实测补导 343 行到 NAS。教训入库：ZCode 大版本会改官方渠道 id 形态，漏判表现是「某渠道突然没新数据」，先看跳过计数列表里的新前缀。
  - **mirasim 输入口径全量订正**：mirasim 账本的 `input` 是**净新增输入**（不含缓存，三协议腿实测：anthropic 110K vs 缓存读 4.71 亿、openai-chat 1651 万 vs 1.23 亿、openai-responses 584 万 vs 1.45 亿），旧转换器原样落库导致仪表盘出现「输入 638、缓存 1.13 亿」的失真口径。转换器改为 `prompt = input + cacheRead + cacheWrite`；新工具 `scripts/normalize-mirasim-input.mjs`（dry-run 默认 / `--apply` 写入 / `meta.mirasimInputNormalized` 幂等）对已导入行原地订正 **usageHistory 行 + usageDaily 日桶 delta 打补丁**（刻意不做全量重建——只动 promptTokens，其余字节不动）。双库实测：本机 20 行（delta 115 万 / 2 桶）、NAS 2998 行（delta **7.86 亿** / 12 桶 / 77 计数器），`verify-usage-db` 双库 **PASS（23/23、65/65 天全对）**；终局证明：订正后重同步 `imported 18（纯新行）/ skipped 2998（历史行签名逐条命中，零重复）`。备份 `data.sqlite.bak-*-mirasim` 留存于两库目录。
  - **运维工具预存分叉修复（#9 连带）**：服务端 `9826b8c3`（#9 第 5 项，usage 日志不再存完整 key）后，`usageHistory.apiKey` 列存 **mask** 而桶键是 sha256(原始 key)——原始 key 已不入库，插件侧**结构上无法复现**非空 key 的桶键（09-12「56/56 PASS」是导入库全 `local-no-key` 键未撞上）。`usage-daily.mjs` 镜像 meta 对齐（`apiKeyMasked` 替代 raw `apiKey`），`verify-usage-db.mjs` 的 byApiKey 维度改为**聚合比对**（数值总量仍精确，键身份对非空 key 不可验证）——修后本机 verify 从 16 例失败回到全绿。
  - **gatewaySync 标记**：`--source 10r` 源库**原生**行导出时打 `meta.gatewaySync=true`，目标侧健康度评分豁免「导入行排除」（见 v1.1.2 块「数据口径」条）；B 实例自己从客户端账本导入过的行经链式同步不打标、继续排除。
  - **同实例防护扩展到离线回导**：10r 导出每行盖 `meta.sourceDbPath`（与 `--tag` 无关的机器可查来源），`--import` 分支识别「离线文件来自本机默认实例库 + loopback endpoint」同样以退出码 2 拒绝。
  - **10r 源签名漂移重复行事故（09-24 当日清理）**：v1.2.0 签名含 `hashApiKey(entry.apiKey)` 而 10r 源透传源库 apiKey——桌面 10r 库 apiKey 列格式漂移（raw→mask）叠加签名换代，单轮把 1313 行历史行当新行重导；NAS 累计 **1258 组 / 2455 行重复**。按「每组保 MAX(id)」用 `clean-usage-db --where`（窗口函数谓词）删重 + 重建 16 日桶 + 计数器 57046→54591，`verify-usage-db` PASS 65/65，复跑五源零重导（10r `imported 9`=清理后新写行数，skipped 3099）。**约定：apiKey 口径保持 mask 直传不再改动**（改 null 会引发新一轮漂移）；清理谓词模板与流程见插件 AGENTS.md「apiKey 透传与签名漂移」。备份 `data.sqlite.bak-20260924-dedup`。

- **OAuth 加密导入/导出补齐 MiMo Desktop 卡（以及其他单认证 OAuth 供应商）**：传输功能上线时导出/导入按钮只渲染在「双认证」分支里，单认证模式（`authModes: ["oauth"]`）的卡走另一条分支、只有 Add 按钮 —— `mimo-desktop` 恰好是单认证，**唯一把「账号会话」本身当凭据的卡**（Windows → NAS 迁移全靠它）反而没有任何传输入口。抽出单一 `renderOAuthTransferButtons()`（保留实验开关与 CN 签到互斥两道门）注入全部四个渲染位。真机验证：mimo-desktop 页按钮 0/0 → 1/1，导出路由对伪造 CLI token 仍正确 401。摆位守卫用例进 `oauth-transfer.test.js`（4 调用位、无内联残留）。
- **zcode 插件同步进来的用量终于有预估计价**：导入历来原样照抄源库的 `cost`，而 ZCode/mirasim 本地账本没有 10Router 定价概念 —— 每条导入行都是 $0，仪表盘计价长期空转。三层修复：① 新导入按实时写入同一套定价表即时估算（仅补空，绝不覆盖源库已算好的成本）；② **重导入去重命中时补洞** —— 插件日常同步因此能自行治愈历史天，且当日聚合按差量同步全部桶（只 bump 既有桶、绝不凭空造桶）；③ 开机清扫覆盖插件「离线直写 DB」的入口（不经过任何导入函数）。幂等：修好的行退出扫描，重复跑是 no-op；未标记的实时零成本行绝不动。回归 6 例进 `usage-import-cost.test.js`（估价/保源/去重修复/清扫/幂等/不碰实时行）。

- **Qwen 全系官方精确价 + 定价覆盖审计工具**：所有新一代 Qwen 旗舰此前全部经由 `qwen*` 通配兜底 —— 通配值是 qwen3-coder-flash 档（0.5/2），**qwen3.8-max 实际官方价 2/6，被系统性低估 4 倍**，而且因为"有数字"所以无人察觉。从阿里云 Model Studio 官方计费文档（Singapore/International 标价，2026-09-24 抓取，缓存 hit 10%/创建 125% 规则）为全系补精确条目（max/plus/flash 三代际 + 带日期别名）；`mimo-v2.6-pro-claude` 补漏（Token Plan 变体上线时加了能力行漏了定价行，费率与 v2.6-pro 同源）。新增 `scripts/audit-pricing.mjs`（对齐 audit-capabilities 形态，离线跑真实解析器）：[A] 无价 LLM 门禁（credit 渠道/免费托管/媒体厂商按注明理由豁免）、[B] 通配兜底清单供人工对账。审计发现的真实未定价积压 68 条（mistral/cohere/morph/豆包 seed-2.0/托管开源 llama 等）为 1.2.1 待办 —— StepFun 官方定价页本轮无法抓取（文档路径 404），**刻意不反推**、入待办。14 条钉死测试（每个旗舰断言"不等于通配值" —— 正是本次回归的类型）。
- **额度总览只读接口 `GET /api/usage/quotas`（供 CreditDaddy 等外部面板）**：一次返回全部可查额度的供应商连接（OAuth + `USAGE_APIKEY_PROVIDERS` 白名单 apikey），额度已按仪表盘 Provider Limits 同一套 `parseQuotaData` 归一（name / used / total / remaining / resetAt），附 `providerName` / 账号名 / 邮箱 / 启用状态 / plan / error，**不含任何凭据**。鉴权：除会话 / CLI token 外，guard 对**仅 GET、仅该路径**放行有效的仪表盘虚拟 key（`sk-…`，与用量导入自助通道同级信任）。上游额度接口对频率敏感：按连接缓存 5 分钟（`?force=1` 跳过）、并发 4、单连接 25s 超时，单个供应商报错或超时只落成该条目的 `error`，不拖垮整份总览。单连接接口 `/api/usage/[connectionId]` 的主体抽成 `computeConnectionUsage(connection, {force})` 两处共用，原接口响应不变。用例：`usage-quotas-route.test.js`（筛选 / 归一 / 无凭据泄露 / 缓存与 force / 单条失败不连坐）+ guard 放行边界（有效 key 通过、无效或无 key 401、POST 不在豁免内）。
- **免密面板本机导入 OAuth 迁移文件不再被拦（`9873b018`）**：`requireLogin=false` 时浏览器没有 JWT，`/api/oauth/transfer/` 整段 `ALWAYS_PROTECTED` 把本机操作者自己的导入也挡成 401，界面报「会话已过期或无访问权限」（导入 CreditDaddy / 10router 导出文件时复现）。导入的真正授权是路由内的迁移口令（GCM 校验），故对**本机请求**（回环对端 + 回环 Origin、非经反代）且已认证（含 requireLogin=false）的导入放行；**导出**会吐出明文 token，保持全保护；远程匿名导入仍 401。
- **qoder 排队限流 `10605` 漏检 → 报错被当成正常回答**：上游把 `10605` 套在一层通用 `403` 信封里（`{"code":"403","message":"{\"code\":\"10605\",…}"}`），内层引号被转义，首帧拦截正则认不出——报错文本 `[qoder error 403: …]` 以助手回复流给客户端（mirasim），日志/请求详情记为**成功**（`OUT 55`），不触发切账号。NAS 09-26 凌晨 qfmodel 4 次命中。修复：签名匹配容忍任意转义深度；`10605` 改映射为 **429** 并把 `retryAfterSeconds` 转述为退避能读的「retry after N seconds」，账号按上游要求冷却 30s（原 403 锁 2 分钟），`112`/`pricingUrl` 仍 403。热更新 NAS 实测：并发测试当场触发 16 次真实 10605，全部记为 `✗ ERROR 429`，回退另一账号后全部模型 ok。回归用例取自 NAS 真实报文（`qoder-billing.test.js`）。
- **鉴权请求头对齐 10r 命名：`x-9r-cli-token` → `x-10r-cli-token`、`x-9r-password` → `x-10r-password`**：头名与读取收口到 `src/lib/auth/authHeaders.js`，guard（校验 CLI token 值）与 5 条「仅判存在」的路由经同一 helper 读头，两侧对「哪些头名算数」不会分叉。**旧名入站继续兼容**——已装的 CLI 启动器 / 同步插件不断；应用内发送方（仪表盘、模型测试 ping、Cowork MCP 注入）只发新名，外部客户端（`cli/` 启动器、插件 `status.mjs` / `export-usage.mjs`）新旧双发以兼容改名前的老服务端。token 派生 salt `9r-cli-auth` **刻意不改**（参与哈希，改名会使全部 token 失效）。顺带订正 `agent-add-custom-provider.md` 5 处把 CLI token 塞 `Authorization: Bearer` 的错误示例（guard 从不读该位置，照抄必 401）。
- **「登录校验已关闭」红色横幅可以隐藏（需确认）**：用户反馈明知已关登录校验，全站顶部横幅仍一直占位。设置 → 安全里「需要登录」下方新增「显示登录关闭警告横幅」开关——**仅在登录校验关闭时出现**，关闭横幅要过危险确认弹窗（写明隐藏的只是提醒、风险仍在），重新显示即时生效。新设置 `hideLoginOffBanner`（默认 false）存服务端，对所有设备生效；**重新打开登录校验时服务端自动清掉它**，下次再关会重新警告，隐藏不会一劳永逸。只隐藏登录关闭这一条，「未设置密码」横幅不受影响。顺带修正：横幅原本只在页面加载时读一次状态，切换「需要登录」后要刷新才更新；现在两个开关改动后横幅就地刷新。用例 `login-off-banner.test.js`（PATCH 重置规则 4 例 + 确认弹窗 / 即时恢复 / 横幅判断 / 中文文案）。
- **额度总览接口加固（CreditDaddy 接入前审查）**：① 可查额度的判据改用仪表盘 Provider Limits **同一个** `isUsageEligible`（抽到 `src/shared/utils/usageEligibility.js` 两处共用）——原接口自带的副本漏了 `USAGE_SUPPORTED_PROVIDERS`，把 kilocode 这类根本没有额度接口的 OAuth 连接也列出来（NAS 实测「Usage API not implemented」），外部面板会当成坏连接；已停用账号**照旧列出并查询**，与仪表盘一致（「额度耗尽自动停用 / 恢复后再启用」依赖看到它们的额度）。② 任何虚拟 key 都能 `?force=1`，等于能让持 key 者反复打满全部上游额度接口：现在强制刷新对**同一连接 30 秒内最多一次**（区间内回缓存，CreditDaddy 刷新按钮照常可用），同一连接的并发请求**共用一次上游调用**——包括调用方已 25s 超时但仍在跑的那次，其迟到结果照样落缓存，不会被重复发起。注意：响应含各账号**邮箱**，持任意虚拟 key 者都能读到，把 key 发给他人前知悉。用例 `usage-quotas-route.test.js` 扩到 7 例（判据同源 / 30s 下限 / 并发去重 / 超时后迟到结果）。
- **mirasim 输入订正脚本：旧行只加一次缓存、新行绝不重复加、过期估价会被重算**：`normalize-mirasim-input.mjs` 原先只认 `mirasimInputNormalized` 标记，而修正后的转换器（插件 export-usage ≥ v1.5.0、CreditDaddy 用量同步）写入时已是 `prompt = input + cache` 却**不打标记**、meta 也与旧转换器完全相同——同步后再跑会把缓存加第二遍（638 + 1.13 亿 → 638 + 2.26 亿）。单靠「`prompt ≥ cache` 即新口径」也不行：NAS 迁移前快照里 **2904 条旧行有 66 条**净新增输入本就大于缓存，跳过它们会让其与转换器口径不一致，再同步即产生重复行。现按结构证据逐行判定：已打标 → 跳过；同 `mirasimCallId` 存在 prompt 恰少一份缓存的孪生行 → 本行是新口径，跳过；存在 prompt 恰多一份缓存的孪生行 → 本行是旧行但新孪生已导入，订正会造出完全重复行，跳过并报告为重复对（按 AGENTS.md 去重流程清理）；库已订正过且 id 大于最大已打标 id → 订正之后导入的新行，跳过；其余（含 `prompt < cache`）→ 旧行，加缓存。另外：订正前已被服务端估过价的旧行，估价是在 prompt 不含缓存时算的（新增输入按 0 计），脚本清零该估价（连同日桶份额）并删除服务端成本修复水位 `_meta.usageCostRepair`，下次启动按订正后的 token 重算。NAS 实测（dry-run）：迁移前快照 → 2998 行 / delta 786,499,088，与 09-24 实际订正**逐字节一致**；当前库 → 1530 条新行全部跳过、delta 0。插件转换器写入时也补打标记（去重签名不含 meta，不会触发重导）。用例 `normalize-mirasim-input.test.js` 7 例（未迁移库含大输入旧行 / 已迁移库的 CreditDaddy 行 / 重同步孪生 / 迟到旧行 / 过期估价清零 + 水位删除）。
- **开机成本修复不再被无定价行卡死，也不再拖慢开机**：`repairImportedUsageCosts` 按「成本仍为 0」扫描，而无定价模型的行永远是 0——每次开机都重读同一批最老的无定价行，攒够 2 万条后更新的可计价行永远轮不到。改为 `_meta` 水位线（`{version, lastId}`）：每轮沿主键扫水位之后的下一批并越过全部已看过的行（无论能否计价），顺带免掉每次开机的全表 `LIKE` 扫描；**新版本号重置一次水位**（内置价表随发版更新），此前无价的行在新价表下能补上。开机不再 `await` 它——原先排在隧道 / Tailscale / MITM 自动恢复之前，大库上会推迟远程访问恢复。用例 `usage-import-cost.test.js` 增至 8 例（无价行不阻塞 / 换版本重扫 / 开机不等待）。
- **服务一启动就初始化，不再等第一次打开页面**：`bootstrap`（→ `initializeApp`：隧道 / Tailscale / MITM 自动恢复、看门狗、用量成本修复）过去只经根布局 `layout.js` 的 import 触发，重启后要等有人打开仪表盘页面才跑——NAS 实测 09:35 重启、10:23 才初始化；只被 `/v1` 调用的实例（CreditDaddy、各客户端）永远等不到，远程访问在重启后一直断着。现在 `instrumentation.register()`（Next 在服务实例启动时调用一次）直接引入 bootstrap：即发即走不阻塞就绪，`initializeApp` 的重活本就延后执行；`global.__appBootstrapped` 守卫保证布局那条 import 不会二次启动，构建期（`NEXT_PHASE`）与 edge 运行时不启动。用例 `startup-eager-init.test.js` 5 例。
- **可以关闭自动检查更新（设置 → 安全）**：有的用户刻意停在某个版本，不希望实例持续访问 npm registry 或弹新版本提示。新开关「自动检查更新」（默认开）关闭后：`/api/version` 不再请求 registry、也不回任何缓存中的新版本（侧栏「新版本」横幅、托盘开机气泡随之静默），CLI 启动器的启动检查也跳过——它在服务起来之前运行、读不到设置，由服务端把开关镜像成数据目录里的 `update-check-disabled` 标记文件（设置保存时写 / 删，开机按数据库重新对齐，防库被恢复后不一致），等同 `--skip-update`。显式检查不受影响：设置页新增「立即检查」按钮，托盘「检查更新」菜单改走 `/api/version?check=1`（等待 registry、绕过缓存）。「已安装版本与运行中不一致」提示比对的是本地磁盘，不属于更新检查，照常工作。用例 `auto-update-check.test.js` 10 例。

## v1.2.0 (2026-09-24)

> 本版主题：**供应商治理收敛 + 网关契约修复 + 一次安全审计收尾**。含两处破坏性变更（i18n 品牌重命名、MiMo Desktop 按 provider 判定），故走 minor。
>
> **关于 v1.1.4**：本版一并收录了 v1.1.4 开发位的全部内容。那个版本号是开发期盖上的，**从未发布**（无 tag、无 npm 包、无 Release），发布前已被 revert（`c714f2a8`），内容并入本版。因此本文档中没有 `v1.1.4` 独立版本段 —— 下方「v1.1.4 开发位」小节即其全部内容。

### ✨ 新功能

- **小米 MiMo 拆成三张卡，各管各的账（破坏性：按 provider 判定）**：此前一个 `xiaomi-mimo` 卡同时承载「浏览器登录 / API Key 的云端按量」与「桌面版账号会话 + 周额度」，两类凭据共用一个 provider id，导致卡上的「测试连接」「周额度」都按最宽松的一侧判定。现拆为：
  - **`xiaomi-mimo`（云端）**：浏览器登录 + `sk-` API Key，走 `api.xiaomimimo.com`，按正式资费计费，**不再显示周额度**（它本来就没有可读的额度接口，此前是把桌面版的额度「借」过来显示）。
  - **`mimo-desktop`（桌面版）**：独占账号会话面。模型必须由本机已登录的 MiMo Desktop 客户端提供 cookie，**不接受 API Key**；「测试连接」改为用实时模型探测，不再用一个已下架的模型 id（那个 id 让测试对新卡永远不可达）。卡片带自己的官方图标与中文提示（此前提示是原始英文串）。
  - **`xiaomi-tokenplan`（Token Plan）**：`tp-` 开头的套餐密钥，三区域（cn / sgp / ams）集群。
  - **清理存量污染**：新增 DB 迁移 `005`，把 v1.1.3 时期折叠进云卡的桌面会话行移回 `mimo-desktop`（该卡已持有同账号会话时删除），否则那些连接会以 `Bearer mimo-desktop-session-…` 打云端 API 得 401 并被标「账号不可用」。写入侧（两条 OAuth 路由按卡门控 + 云卡更新剥离会话字段）、导入侧（跨机转移剥离云卡的机器会话）、读取侧（usage 对云卡短路机器会话）全部堵住。
  - 逐个测试连接支持**选择测试模型**（下拉，默认「提供商默认」），因为有些凭据只覆盖部分模型 id——桌面版会话就是只能到桌面模型。
- **V2.6 落地、V2.5 退役，并给 MiMo 真实上下文窗口**：接入 V2.6 全系（`mimo-v2.6-pro` / `mimo-v2.6-flash`），退役 V2.5 与 `mimo-v2-omni`（**不阻断已配置的 combo**，走原 id 透传）。此前 MiMo 模型落进兜底能力表，上下文窗口按猜的算；现显式声明 1M 窗口 / 128K 输出。Desktop 卡卖 V2.6 实线并标 credit 倍率（`1.00x` / `0.40x`）。**MiMo V2.6 Pro UltraSpeed** 加入云端与 Token Plan 卡（它是定制服务，无合约为上游报错——优于要求用户手工添加模型）。
- **Qoder 逐个测试按别名核对**：Qoder 是聚合器，其真实推理端点是私有的 Cosy 签名协议而非 `/chat/completions`，此前「逐个测试」对 `qoder` 只验 token、对 `qoder-cn` 直接返回「不支持」。现改为用 job token 拉**该账号的实时模型目录**（不耗积分）核对所选模型的别名 key；目录拉不到时回退验 token，不把好连接误判为坏。
- **实验性页收纳「隐藏无配额视觉开关」**：配额页工具栏此前挤满筛选按钮，且该开关是客户端视图偏好（不走服务端设置）。现移至「设置 → 实验性」的提供商卡片，位于 OAuth 导入/导出之上；该页副标题同步更新为覆盖提供商工具、每日签到与仪表盘安全。
- **新增本地测试轮 tooling 与 CDP 无头浏览器探针**（开发者工具，非用户功能）：`desktop/test-local.ps1` 增加 `-Mode hot`（只同步 `.next-cli-build` + `public` 后重启）与 `-Mode ui`（仅 `public/**` 改动，不构建不重启）；测试版本号改为**轮次自增**而非时间戳，避免同秒撞号。新增 `scripts/browser-probe.mjs`（零依赖，Node 内置 WebSocket 讲 CDP）驱动真机 headless Chrome 执行脚本、回报结果与截图——本版两条渲染层缺陷（见下）就是它能测、而读码与单测测不到的类型。

### 🐛 修复

- **[数据丢失] 错误密钥启动会永久销毁凭据密文**：`decryptConnectionData` 解密失败时把字段从对象里**删掉**，只在返回值挂 `error`；而 repo 的读出口直接采用该结果，启动期 `cleanupProviderConnections` 与任何 `updateProviderConnection` 都会把这份**无密文对象**回写。场景：把 `data.sqlite` 恢复到没带 `credential-key` 的机器，起一次服务 → 所有 OAuth token / apiKey 密文被抹掉，之后补上正确密钥也救不回。现改为返回 `{ data, error, unreadable }`：不可解密的值仍从 `data` 移除（避免密文被当 Bearer 发上游），但随对象携带并在写回时原样落盘（`encryptSecret` 对 `enc:v1:` 幂等）。载体键不进 API 响应；合成的 `testStatus`/`lastError` 不再入库。
- **[网关契约] stop 序列守卫的补发行与终止帧粘成一个 SSE event**：守卫在切断后注入的补发行**没有空行终止符**，与紧随的终止帧（或 `[DONE]`）并入同一 event，官方 SDK 的 `JSON.parse` 必失败。触发条件仅是「最后一段文本以某个 stop 的真前缀结尾」，**与上游是否合规无关**，影响所有 passthrough 流。现补发完整 event（含空行）；Anthropic 形态补 `event:` 行与**正确的 content-block index**（原写死 0，而 thinking 块占用 0），且在命中后**整块丢弃**非文本块（原只清空 payload，客户端会收到 `input:{}` 的 `tool_use` 并可能空参执行工具）。
- **[计费] combo 空回复回退把「纯工具调用」判为空 → 误重试并重复计费**：Responses 侧不认 `function_call`、Gemini 侧不认 `functionCall`，模型一决定调工具就被判「无有效内容」，放弃并**重新计费全部输入上下文**（最多烧掉两个模型）。现三种形态均计入有效内容，并补 `delta.reasoning`（OpenRouter / xAI 拼写）。另：判 retry 后改为把上游流**读完**而非 `reader.cancel()` —— cancel 使 flush 不执行，该次 usage 实际不入库且被记成「客户端断开」。
- **[跨供应商误路由] `sfcn` 别名被 StepFun CN 劫持**：`stepfun-cn` 与 `siliconflow-cn` 同时声明 `sfcn`，注册顺序后者覆盖，于是 v1.1.3 用户写 `sfcn/<model>` 会带着 SiliconFlow 的模型 id 打到 `api.stepfun.com`。基线快照也已被重录成这个错误映射，所以门禁是绿的。现从 `stepfun-cn` 删除该别名（保留 `sf-cn`）并重录基线；新增**全局别名唯一性测试**（别名不得双属、不得撞 provider id）——它能挡住整类「后注册的 provider 静默劫持别名」。
- **桌面版连接「测试连接」永远失败 / 逐个测试全部 500**：`testUtils` 的分派表缺 `mimo-desktop`，落到 default 后 `testStatus` 被写成 error；且测试路由无条件 `request.json()`，**无 body 的 POST 直接抛错**，导致逐个测试对任何连接都返回 500。另修同路径一处死代码：后台过期刷新传入未定义的 `proxyOptions`，ReferenceError 被空 `catch {}` 吞掉——该刷新从未执行过。
- **`/api/version` 阻塞 npm registry 拖慢健康探测**：GET 会 `await` npm 版本同步，冷缓存最多等 4s，而 `doctor` 与陈旧服务探测的超时是 2s，防火墙丢包环境下会误判为 RED。现改为有缓存即返回、过期则后台刷新；`currentVersion` / `diskVersion` 恒为本地读取。更新器在「npm 退出 0 但读不到版本」时如实记「无法验证」，不再打印已验证。
- **会话绝对上限缺失（滑动续期可无限延长）**：2h 滑动窗口若只看当前 token 的 `iat`，每次续期都刷新它，被盗 cookie 只要每 <2h 访问一次就能永久续期，窗口从未真正闭合。现签发时写入已签名的 `origIat` 并跨续期原样传递，超过 30 天拒绝续期（老 token 无该声明则回退用自身 `iat`）。
- **用量按 key 统计把同机所有 key 并成一桶**：实时路径（24h / 今日）的分组键用的是**掩码**，而掩码是 `sk-` + 机器码前 5 位 —— 同机所有 key 完全相同，于是每个账号的用量全被合并。现改用 `apiKeyHash`（sha256），与日聚合路径一致。
- **配额页计数在有视图筛选时说谎**：摘要取的是后端分页总数，看不见客户端的视图过滤，于是「显示中 1-10 of 46」会压在被筛过的卡片网格上。现按实际渲染数量报。
- **同一张卡内多个按钮同一 tick 连点会丢写**：隐藏/恢复的 handler 从渲染闭包读状态，同一 tick 内多个点击都按点击前的同一份快照计算，最后一次 PATCH 覆盖其余——实测点 5 个「已隐藏」标签只恢复 2 个。现走 setState 更新式写入。
- **「只看有余额」与手动隐藏脱钩**：该开关被实现成一条独立的渲染期过滤，于是它藏掉的行**不出现在「已隐藏」列表里**、也无法按名字单独恢复，与单行隐藏按钮完全失去关联。现两者写**同一份** `quotaVisibility.hidden`，批量藏的行照样列出、照样能单独点回来。
- **fnOS 每次升级都会把引导密码换掉**：随机口令写在 `${SRC_DIR}/.env`，而该目录正是 fpk 升级时被整体替换的应用负载目录——升级后重新生成新口令，依赖旧口令的用户被静默锁死。现三个回调脚本统一改用 `${DATA_DIR}/initial-password`（0600，跨升级保留），升级时文件已存在即跳过，保留原密码。
- **备份导出在错钥实例上静默丢凭据**：导出的 JSON 只取解密后的 `.data`，错钥机器上导出的「备份」不含任何凭据且无任何提示。现保留密文（幂等穿过导入流程），并返回受影响行；**前端下载时据此告警**（原来一律报「下载成功」）。
- **桌面版卡与云端卡的其余收敛**：桌面版卡仅提供账号会话（不再给 API Key 入口）、去掉浏览器授权、带上自己的官方图标，卡片提示文案补齐中文；云端卡不再假装能读桌面版应用。

### 🔒 安全

- **`/api/health` 不再回显本地路径**：它是公开且 CORS `*` 的（外部监控唯一能轮询的端点），却原样返回 `lastDriverError` —— 那是驱动加载失败的原始 `Error.message`，native 模块场景下常态是绝对路径（`Cannot find module 'C:\Users\…\better-sqlite3'`），等于把用户名与目录结构告诉任何调用方。现抹掉路径，保留 `doctor` 判定所需的驱动名与「是否有错」。
- **Windows 上加密密钥与 JWT 密钥补齐 ACL 收紧**：`credential-key` / `jwt-secret` 此前只设 `mode: 0o600`（在 Windows 上是空操作），只有 Root CA 那处加了 `icacls`。现抽出共用的 `hardenOwnerOnly()`（POSIX chmod / Windows icacls），三处密钥文件统一使用。
- **备份导出与集成的其余收尾**：会话续期保留 oidc/saml 声明；登录限流键控真实 IP 不变。

### 🔧 内部与文档

- **i18n 品牌重命名收尾（破坏性：仅影响词条）**：恢复 258 条**失效的翻译**（此前因品牌重命名而全部落回英文），并把 `9Router` → `10Router` 的替换推进到安全范围内。环境变量 `NINEROUTER_*` → `TENROUTER_*` 保留**同表达式回退**并有守卫测试，存量部署不受影响。
- **landing 页不再把用户引到无关 fork 的安装包**。
- **文档与常量归位**：`docs/zh-CN/ARCHITECTURE.md` 的 `x-9r-real-ip` 更正为 `x-10r-*`（cli-token 头代码里仍是 `x-9r-cli-token`，准确，未动）；`MAX_ENFORCED_STOP_LENGTH` 从 `utils/` 移入 `config/runtimeConfig.js`（符合 open-sse 的 config 集中约定）；`fnos-packaging/manifest` 的维护者从上游残留名 `decolua` 更正为 `techysy`（`maintainer_url` 早已指向本仓库，只有名字没跟上）。
- 本地构建与验证手册新增「渲染类问题必须驱动真浏览器看 DOM」一节，含本版**实际付出的两个误判教训**：按图标「画的是什么」判方向而非按该排按钮的约定判；以及用顺序交互去覆盖同 tick 竞态（顺序点击会完全掩盖后者）。

### 以下为 v1.1.4 开发位的内容（该版本号未发布，一并随本版发布）

该位次积累的 57 个提交（StepFun 四渠道、ComfyUI 本地生图、combo 空回复回退、stop 序列守卫、默认密码斩断、凭据加密落库等）在 `v1.1.3` 之后落地，未随任何版本发布。

#### ✨ 新功能

- **变更日志只渲染到已发行版本**：仪表盘 Change Log 从仓库 `main` 拉取（旧版本用户能看到后续更新），但开发期写入的「未来版本」条目会立刻到达所有已安装客户端，告知用户自己并没有的功能。现以 `/api/version` 的 npm 已发版本与自身构建版本两者较高者为上限，截掉高于它的版本段；完全离线 / 版本未知时回退为不截断（旧行为），绝不会出现空白弹窗。附 12 例回归（`changelog-release-cap.test.js`）。
- **StepFun（阶跃星辰）全系列原生接入与多媒体能力隔离**：
  - **四通道拆分与极简短别名（国内站 / 国际站 × 按量 / Step Plan）**：`stepfun-cn`（国内站按量，`api.stepfun.com/v1`）、`stepfun`（国际站按量，`api.stepfun.ai/v1`）、`stepfun-plan-cn` / `stepfun-plan`（对应站点 Step Plan 套餐渠道，Base URL 带 `/step_plan` 前缀，**消耗套餐 Credit，不扣现金/代金券**）。暴露极简短别名 `stepp-cn`、`step-cn`、`stepp`、`step`（并全兼容通配 `sfp-cn`、`step-plan-cn`、`sfpcn` 等候选），模型调用从 `stepfun-plan-cn/step-5-preview` 缩减为 `stepp-cn/step-5-preview`。既有 `stepfun` 连接经 DB 迁移（`002-stepfun-cn-rename`）自动归入 `stepfun-cn`，停用模型 / 参数覆写 / 卡片顺序等旧键同步迁移，绝不误接到国际站。四张卡片的显示名分别为 `StepFun CN` / `StepFun` / `StepFun CN Plan` / `StepFun Plan`——套餐渠道原名 `StepFun CN Step Plan` / `StepFun Step Plan` 与 `StepFun` 叠字，现简化为「同渠道 + Plan」。
  - **Step Plan 智能路由模型**：接入套餐专属的 `step-router-v1`（按任务复杂度自动调度上游）；Step Plan 渠道同时提供 Anthropic 原生 Messages（Claude Code 可直接接入 `…/step_plan`，消耗套餐 Credit）。
  - **大语言模型（LLM / Chat）**：纯正文本与视觉模型 `step-5-preview`、`step-3.7-flash`、`step-3.5-flash`、`step-3.5-flash-2603`、`step-1o-turbo-vision`，严格隔离于主菜单【模型提供商】与默认 `/v1/models`。
  - **语音合成（TTS）**：接入 StepAudio 系列 `stepaudio-3-tts`、`stepaudio-2.5-tts`、`step-tts-2`、`step-tts-mini`（Step Plan 渠道为 `stepaudio-2.5-tts`），隔离至【媒体提供商 -> 语音合成】与 `/v1/models/tts`，默认音色设为 `cixingnansheng`（磁性男声，避免 OpenAI 默认 alloy 触发 400）。
  - **语音识别（STT / ASR）**：接入 `stepaudio-2.5-asr`，隔离至【媒体提供商 -> 语音识别】与 `/v1/models/stt`。
  - **图像生成（未放出，直接下架）**：官方公告（`docs/zh/guides/image-offline-notice`）`step-2x-large` / `step-image-edit-2` 与国内外 `/v1/images/{generations,image2image,edits}`、`/step_plan/v1/images/*` 于 2026-10-10 同步停服（`step-1x-edit` 更早已不可调用），实测下线前该服务已持续返回 503。故本次不放出图像能力：不再暴露 `kind:"image"` 模型、`imageConfig` 与 `serviceKinds` 中的 `"image"`，【媒体提供商 -> 图像生成】与 `/v1/models/image` 里不再出现 StepFun 四条渠道（`stepfun` / `stepfun-cn` / `stepfun-plan` / `stepfun-plan-cn`）。
  - **实时余额与代金券查询**：对接 `GET /v1/accounts`，国内站按 CNY、国际站按 USD 展示现金与代金券余额（Step Plan 渠道无公开额度 API，不显示用量卡）。
  - **官方高清图标**：注入官方透明 PNG 图标，覆盖大模型卡片与各媒体管理界面。
  - **模型类型图家族聚合**：`modelFamilyName` 新增品牌归一映射，把同一品牌的不同产品线前缀折叠成单一族——StepFun 的 `stepaudio-*`（TTS/ASR）与 `step-*`（LLM/视觉/图像）在「模型类型」用量图里不再拆成两根柱，统一聚合为 `step`。剥离 provider 前缀后匹配，覆盖 `stepp-cn/…`、`step-cn/…` 等带渠道别名的 id。附回归用例（`model-family-chart.test.js`）。

- **媒体供应商列表支持拖拽排序与已连接前置**：此前只有主【模型提供商】页的卡片可拖拽重排（持久化 `providerCardOrder`）并按连接状态自适应置顶；媒体供应商列表（图像 / 语音合成 / 语音识别 / 向量 / 视频 / 音乐，以及合并后的 Web Search / Web Fetch 页）此前是纯注册表 `priority` 顺序——既不能拖拽，已连接的供应商也不会浮到前面。现两处共用同一套排序与持久化口径：排序链 = 连接状态 rank（已连接或免鉴权启用 → 0；免鉴权关闭 → 1；已配置但全部连接禁用 → 2；从未配置 → 3）→ 手动拖拽顺序（`providerCardOrder`）→ 注册表 `priority` → 名称。拖拽仍走原生 HTML5 并写入同一全局 `providerCardOrder`，所以任一面板的拖拽在其它面板同样生效，`/v1/models` 的 provider 顺序保持一致。连接状态统计（model lock 冷却判定、禁用连接不计入已连接）与排序／换位数学抽到共享模块 `src/shared/utils/providerCardOrder.js`，拖拽卡片抽到 `src/shared/components/DraggableCard.js`，主 providers 页改为复用同一实现（行为与既有 lint 基线不变）。附 `provider-card-order.test.js`（20 例：rank / 比较器 / 换位 / 边界）。

- **ComfyUI 本地生图原生执行器实装**：
  - 接入本地 ComfyUI 实例（默认 `http://127.0.0.1:8188`），实装自动发现本地可用 Checkpoints、动态装配 SD / SDXL / Flux 标准文生图图工作流并排队轮询输出，经 `/v1/images/generations` 统一返回标准 base64 图像。

- **Qoder 签到与额度识别优化**：
  - 增强 Qoder 国际版与国内版签到容错，清晰展示当前账号代金券与 Credits 状态。

#### 🐛 修复

- **小米 MiMo 浏览器登录在局域网 / HTTP 访问下完全不可用**：连接弹窗生成 OAuth `state` 时直接调用 `crypto.randomUUID()`，而该 API **仅存在于安全上下文**（HTTPS 或 localhost）。从另一台设备以 `http://局域网IP:20128` 打开仪表盘（NAS / 自托管的常态访问方式）时它是 `undefined`，点击「浏览器」直接抛 `crypto.randomUUID is not a function`；又因为服务端 `/authorize` 强制要求客户端提供 `state`（缺失返回 400 `Missing state`，X25519 密钥对需绑定该字符串），整条浏览器登录链路被彻底堵死。新增浏览器安全 `uuid()` 工具：优先原生 `randomUUID`，否则用不受安全上下文限制的 `getRandomValues` 拼出 v4（正确置版本 / 变体位），全无 WebCrypto 时再降级；附 5 例回归用例（`browser-safe-uuid.test.js`）覆盖三种运行环境。同一弹窗里的桌面凭据自动导入与手动 API 密钥两条路径不受影响。
- **StepFun 连接测试报「Provider test not supported」**：StepFun 四个渠道（国内站 / 国际站 × 按量 / Step Plan）此前未在连接测试分支注册，仪表盘「逐个测试连接」与单连接测试对**健康密钥**也一律返回 `Provider test not supported`。现统一走通用 OpenAI 兼容校验（`GET {base}/models` + `Authorization: Bearer`）：`stepfun-cn`→`api.stepfun.com/v1/models`、`stepfun`→`api.stepfun.ai/v1/models`、`stepfun-plan-cn`→`api.stepfun.com/step_plan/v1/models`、`stepfun-plan`→`api.stepfun.ai/step_plan/v1/models`（Step Plan 仅 `/accounts` 额度路由 404，`/models` 正常）。401/403 判为无效密钥、网关 HTML/403 判为维护中，与其余通用渠道一致。附离线回归用例（`stepfun-connection-test.test.js`，mock fetch 校验路由与判定，不依赖真实网络）。
- **小米 MiMo 周套餐额度耗尽提示渲染为原始 JSON**：周套餐用尽时上游返回 `[403]: {"error":{"message":"本周用量已满…","code":"subscription_quota_exhausted","biz_code":30011}}`，而 `translateQuotaError` 此前只认识 Google 的 429 形态，原始 JSON 直接铺进连接行并被 380px 截断。新增窄匹配分支（仅 `subscription_quota_exhausted` / 「本周用量已满」，**刻意不含裸 `quota_exhausted`** —— Google payload 里的 `QUOTA_EXHAUSTED` reason 必须继继走自己的带倒计时分支），命中后显示「该账号额度已用完，请等待重置。」。附真机 payload 回归用例。
- **到期 / 重置倒计时跨天被折叠**：连接行到期徽标把 41 小时显示成 `1d`（实为 `1d 17h`），额度重置倒计时则写成「41小时」。`formatExpiry` 两处同步改为 `Xd Yh`（恰好整天数不追加 `0h`），`formatQuotaDuration` ≥24h 折叠为「1天17小时」；新增 `{n}d` 词条。附 `expiry-countdown-format.test.js`。
- **小米 MiMo（Token Plan）独立供应商按桌面版实态更新**：反编译 MiMo Desktop `app.asar` 拿到官方分区域套餐目录（token-plan-cn / sgp / ams 三区模型集完全一致）：删除套餐集群根本不存在的 `mimo-v2-omni`（调用必 404，来由「目录太旧」）；四个语音模型补 `kind:"tts"`（此前会混入聊天模型列表），并为 tokenplan 接入共享 MiMo 语音适配器（区域路由）+ `serviceKinds: [llm, tts]`；官方已弃用的 `mimo-v2-pro` 改名标注 legacy；默认集群 sgp→cn（与桌面版 plan 预设一致，存量连接已存显式 region 不受影响，海外出口仍自动匹配）；控制台链接指向 platform.xiaomimimo.com；provider 优先级 300→21，卡片紧挨基础 MiMo。同步重录 `providers-baseline.json`（与 StepFun 拆分时的惯例一致）。
- **Token Plan 浏览器登录的端点路由**：平台 OAuth 回传的 `url`（桌面版正是用它区分 plan / billing：auth.json metadata.base_url）此前只入库不参与路由 —— chat / TTS / 连接测试一律打在按量集群，套餐订阅账号登录后访问错集群。现在 xiaomi-mimo 执行器 `buildUrl`、MiMo TTS 适配器、连接测试探测地址均优先使用连接存储的集群（按量账号重建结果与原 transport 字节一致，行为不变）；套餐集群沿用「403 容忍、401 才判无效」的既有语义。新增共享 `normalizeMimoApiBase` 把任意形态的存储端点规范到 `https://host/v1`。
- **MiMo TTS 裸模型名被静默改写**：适配器的已知模型列表只有 `mimo-v2.5-tts`，`parseModelVoice` 会把不在列表里的裸模型（如 `mimo-v2-tts`）改写成默认模型 —— 四个套餐语音模型接入后此问题会真实触发，列表补全。
- **MiMo 浏览器登录挂起密钥无上限**：与桌面版对齐 `cap:8` —— 每个挂起会话持有一把 X25519 私钥，24 小时粘贴窗口不应变成无界密钥缓存；超出时淘汰最旧。
- **Combo 空回复自动回退（#10）**：部分上游（Z.ai/GLM 系等）把内容审查表达为 HTTP 200 空流 —— 流正常打开、以 `finish_reason:"sensitive"`/`content_filter` 终止且零输出 token，combo 的 `result.ok` 短路把空白回复直接交给客户端。新增可选「空回复时切换」（策略面板 Toggle，默认关；`comboStrategies[name].retryOnEmpty`，全局兜底 `settings.comboRetryOnEmpty`）：仅当仍有后备模型时窥探 2xx 流头部，终结时没有任何有效内容（正文/推理/工具调用）即落到下一个模型；首个有效增量立即放行（头部缓冲字节级无损重放，单一 TextDecoder 保住跨 chunk 的 CJK 字符）。仅对 SSE/JSON 生效，音频/图像二进制流不受影响；被放弃的调用已消费至终结，用量照常入账；最后一个模型永不窥探（空 200 优于合成 5xx）；单请求默认最多烧 2 个模型（`retryOnEmptyLimit`，按 combo / 全局 `comboRetryOnEmptyLimit` 可调 —— 重放会重新计费完整输入，报告人案例是 1.5M token 上下文），后备目标与主模型同厂时在日志中告警（大概率撞同一过滤器）。翻译层会归一化 filtered finish reason，故判据取「终结且零有效内容」而非 reason 本身（原始 filtered 令牌仍机会性识别）。另修复 combos 页策略修剪逻辑：在默认 fallback 策略下开启该开关时，整个 comboStrategies 条目会被连带删除、开关静默失效。附 `combo-retry-on-empty.test.js`（28 例）。
- **Claude Code 自动模式分类器经网关恒不可用（#18）**：auto mode 的 `xml_2stage` 分类器走「claude → openai → 上游」链路时，`stage1ParseAttempts:1` / `stage2ParseAttempts:0`，harness 报 `… is temporarily unavailable, so auto mode cannot determine the safety of Bash`。根因三处：
  1. **翻译层静默丢弃 stop 序列**：`claudeToOpenAIRequest` 是白名单式重建请求体，从未把 `stop_sequences` 映射为 OpenAI `stop`（反向 `openaiToClaudeRequest` 同样丢弃 `stop`）。分类器 stage-1 依赖 `max_tokens:64 + stop_sequences:["</block>"]` 让模型**吐出判定标签就地停住**，丢了这个参数后模型继续往 `<category>/<reason>` 写，64 token 预算把整轮截断。两个方向现均映射，并限制在 Anthropic 的 4 条上限内（空值/非字符串过滤、未传时不落字段）。
  2. **上游无视 stop，由网关代执行**（cbcn 直连实测：带 `stop:["GAMMA"]` 仍返回完整字符串）：新增 `open-sse/utils/stopSequenceGuard.js`，在 SSE 转发层执行客户端要求的 stop 契约 —— 生成文本出现该序列即就地切断、**序列本身不发出**（Anthropic / OpenAI 语义一致，客户端解析器的闭合标签本就是可选的：`/<block>(yes|no)\b(<\/block>)?/`、`/<severity>\s*(\d+(?:\.\d+)?)\s*(<\/severity>)?/`）。设计取舍：只扣留「确实是某个 stop 前缀」的尾部（普通文本原样透传、不产生额外重组），跨 delta 切断的序列照样命中；上游不认 stop 时仍继续转发后续分片但**剥掉正文**（保留 `usage` —— 分类器要读 `usage.input_tokens`，丢掉它等于换一种失败）；把上游的 `finish_reason:length` 改写为正常 stop（`max_tokens` 正是客户端丢弃答案的原因）；上游本就守规矩的不受影响（输出里已无该序列，扫描为空、字节级透传）；**仅对 SSE 文本流生效**，Kiro 那类二进制 EventStream 不做解码/重编码以免破坏字节。stop 同时从**客户端原始请求体**读取（意图的真实来源，未被任何翻译器映射的 stop 也必须执行）。
  3. **cbcn + 非流式 + claude 客户端返回 OpenAI 形状**：强制流式供应商回聚合成 JSON 时跳过了客户端格式翻译，Anthropic 客户端取 `content` 得到 undefined。`handleForcedSSEToJson` 现走与普通非流式相同的翻译路径（由 chatCore 注入，避开 `sseToJsonHandler ↔ nonStreamingHandler` 的循环导入）。

  实测（Windows 桌面版，真分类器提示词 + `l4e()` / `r4e()` 用二进制里的原版解析器判定）：修复前 `<block>yes</block><category>…<reason>…`（被 64 token 截断）→ 判定 `null` → `unavailable`；修复后 `<block>yes` / `stop_reason:end_turn` / `l4e()=true`，severity 模式 `<severity>10` 且 `r4e()=10`。**反证**：同一请求不传 stop 时完整输出 `<block>yes</block>` 原样透传，说明截断是契约执行而非副作用。附 `stop-sequence-guard.test.js`（24 例）、forced 路径客户端格式 3 例、wiring 守卫 8 例、`openai→claude` 映射 4 例。
- **不再有内置默认密码：未设密码时仪表盘仅本机可访问（#9 第 1/3/4 项）**：v1.0.7 审计指出「默认全网卡监听 + 未设密时 123456 兜底 + 凭据明文落库」三者叠加会一步打穿防护。本次斩断「口令兜底」整条腿：
  - **服务端**：`dashboardSession.js` 删除 `DEFAULT_PASSWORD`，`INITIAL_PASSWORD` 成为唯一的非交互式引导口令 —— 未设置时任何口令都不通过（而不是落回 123456）；`/api/settings` 的「首次设密」分支不再把字面量 `123456` 当合法 `currentPassword`（审计点名的「复活路径」）。
  - **权限模型**：未设密码（且无 SSO）时，回环来源视为可信 —— 本机操作员必须能进去设密码，否则「登录要密码、设密码要登录」直接死锁；**非回环来源一律拒绝**（401 / 跳登录页），它没有任何可校验的凭据。设完密码后行为与之前完全一致，`requireLogin=false` 这一显式选择不受影响（端点页的裸奔告警照旧）。
  - **登录页**：不再显示「默认密码 123456」；远程用户看到的是「尚未设置密码，请在运行 10Router 的机器上打开仪表盘设置，或用 `INITIAL_PASSWORD` 启动」，本机用户直接给「打开仪表盘」按钮。
  - **CLI**：设置菜单的「重置密码」此前把密码重置回 `123456`（同一条复活路径）。服务端仍只负责清空哈希，CLI 改为生成 **12 字节随机密码**并显示一次，登录后可在 Web UI 改掉。
  - **fnOS 打包**：首次安装写入 `.env` 的 `INITIAL_PASSWORD=123456` 改为**随机生成**并打印在安装日志；安装 / 升级回调把旧占位值 `change-me` 也换成随机值（此前同样换成 123456）；启动脚本改为从 `.env` **读回**该值 —— 环境变量优先级高于 `.env`，旧逻辑里的常量兜底会把刚生成的随机密码覆盖掉。
- **新增「安全」卡片（设置 → 实验性）**：把暴露面的事实与开关放在一起 —— 监听地址与局域网可达 URL、密码是否已设、登录校验是否开启、仪表盘访问范围，以及一个「仪表盘仅本机访问」开关（默认关，请求级生效、无需重启）。开启后非本机来源对仪表盘与管理接口的请求一律 403，**LLM 接口（`/v1`）不在此列**（它用自己的 API key 鉴权，把网关放到局域网正是本产品的主场景）。配套只读自检接口 `/api/security/status`（需鉴权）。附 `dashboard-no-default-password.test.js`（26 例：口令校验 / 引导态判定 / 守卫接线 / CLI 与 fpk 打包的静态守卫）。
- **安全提示补齐（#9 第 2/3/4 项的「提示」部分）**：
  - **仪表盘级常驻警告横幅**（挂在布局上，所有页面可见）：未设密码时提示「只能在本机打开」，登录校验被关闭时提示「任何能访问该端口的人都能管理全部供应商、密钥与凭据」，并直接给出去「设置」页的入口 —— 这两条此前只在端点页有告警，而操作员不一定会打开那一页。探测接口失败或状态正常时**不渲染**（不会把探测失败变成惊吓横幅）。
  - **关闭「要求登录」需二次确认**（与早已存在的「要求 API 密钥」一致）：弹窗写明「关闭后任何能访问该端口的人都无需密码即可管理全部供应商、密钥与凭据，且仪表盘会持续显示警告横幅」；重新开启仍是一键。
  - 「安全」卡片新增一项自检：**凭据存储 = 本地数据库明文（计划加密）** —— 第 2 项仍未落地，只报开关状态会让人误以为实例已经干净。
  - **i18n**：本次新增的安全文案全部补齐 zh-CN / zh-TW，并顺手补上登录页与 SSO 卡片此前缺失的 8 条词条（zh-TW 此前只有 654 条，约为 zh-CN 的 1/3，缺词条会静默显示英文）。新增回归用例逐条断言这些字符串在两个语种表里都存在。
- **凭据加密落库（#9 第 2 项，曾拆为 #30）**：`providerConnections.data` 里的 OAuth `accessToken` / `refreshToken` / `idToken` 与 `apiKey`（含 `providerSpecificData` 里名字像密钥的字段，如 xiaomi-mimo 的 `mimoPassToken`、内嵌账密的 `connectionProxyUrl`）不再明文存储 —— 审计指出「DB 文件被备份/同步/拷走即全部泄露」是三项高危里唯一没动的一条。
  - **实现**：AES-256-GCM，`enc:v1:<iv>:<tag>:<ciphertext>`（base64url）存于同一列。**加密/解密发生在 repo 的 `rowToConn`/`connToRow` 两个唯一出入口**，因此全应用（含拉 token 调上游的热路径）无感，无需改任何调用方；非密钥字段（到期时间、配额快照、模型锁…）仍可读，数据库仍可排查。
  - **密钥不进库**：优先 `CREDENTIAL_SECRET`（容器/fnOS 注入），否则自动生成 `$DATA_DIR/credential-key`（0600）—— 数据库是会流转的那个，密钥不能跟着走。
  - **向后兼容 + 存量迁移**：无 `enc:v1:` 前缀的值按明文处理（旧库照用、写入即加密），并有一次性的 `003-encrypt-credentials` 迁移把既有行加密；两者都幂等。
  - **失败不静默**：密钥丢失/换过（还原了别人的库、改了 `CREDENTIAL_SECRET`）时**不会**把凭据当空值（那会静默停用账号），而是把该连接标为 `unavailable` 并写明「Credentials unreadable」，仪表盘可见。
  - **「安全」卡片**改为实际读取数据库状态：`凭据存储：本地数据库加密存储（AES-256-GCM）`；若某行因数据目录不可写而未能加密则显式告警，并提示「密钥在库外，备份需连密钥文件一起（或设 `CREDENTIAL_SECRET`）」。附 `credential-encryption.test.js`（15 例：密码学往返 / 幂等 / 篡改与错钥报错 / 字段覆盖 / repo 往返 / 刷新路径不双重加密 / 存量迁移幂等）。
- **用量日志不再落全量 API key（#9 第 5 项）**：`usageHistory` 是库里最大、增长最快、也最常被截图/导出/贴进 issue 的表，而它**每一行都存完整的 `sk-…`**；更隐蔽的是 `usageDaily.data`（按天聚合）把同一把 key **又存了两份** —— 一份在聚合项的 `apiKey` 字段，一份在**聚合项的 map key** 里。
  - 现在只存两样东西：**展示用的掩码**（`sk-496f00***`）和**分组/查名用的 SHA-256 摘要**（新增 `apiKeyHash` 列 + 索引）。日志本来就只需要这两件事 —— 它从不把 key 取回来用。
  - 连带改的地方：每日聚合的 map key 从 `原key|模型|供应商` 换成 `摘要|模型|供应商`；按 key 查名字（`apiKeys` 表）改成按摘要建映射；写入时的去重比对（两处）改成比摘要。
  - 一次性迁移 `004-usage-apikey-digest` 重写存量行与聚合（幂等；已掩码/已有摘要的跳过），兼容读：旧聚合里残留的 `apiKey` 会被现场转成摘要，**升级前的历史统计不会丢 key 名字**。
  - 在真实库副本上实测：3024 行 / 20 个按天聚合（87 处 raw 值 + 87 处 raw map key）→ 迁移后 **残留 0**，聚合请求总数 3024 不变，摘要能解析出名字；重跑不改文件（幂等）。附 `usage-apikey-digest.test.js`（7 例）。
- **MiMo Token Plan 卡片改名 + 官方图标 + 额度行说明（含 i18n）**：
  - **改名**：`Xiaomi MiMo (Token Plan)` → **`MiMo Token Plan`**（卡头太长，且父卡已经叫 Xiaomi MiMo，重复前缀是噪音）。
  - **官方图标**：新增 `public/providers/xiaomi-tokenplan.png`，不再回退到 `smart_toy` / `XT` 占位。
  - **额度行不再显示「未实现」**：`tp-` 密钥所在的 token-plan 集群**没有任何额度接口**（实测：`token-plan-cn/sgp/ams` 上逐一试过的候选路径全部 404（openresty），而带周额度的 `aistudio.xiaomimimo.com/open-apis/v1/user/usage` 对 `tp-` 密钥返回 401 —— 它要的是 MiMo **账号会话**，不是套餐密钥）。此前该供应商没注册 usage handler，额度行直接回退成英文原句 `Usage API not implemented for xiaomi-tokenplan`。现注册 handler：若该连接另外带桌面端账号会话（`mimoPassToken`）就照旧读周额度，否则给出一句**说明性文案**（已译 zh-CN / zh-TW），并在官方控制台看套餐用量。
  - **横幅 i18n**：`display.notice.text`（“Xiaomi MiMo Token Plan subscription (API key starts with tp-)…”）补上 zh-CN / zh-TW —— 此前只有英文（与 AMD/byteplus/grok-cli 等同类横幅一起漏掉）。附 `mimo-tokenplan-wiring.test.js`（8 例）。
- **安全审计收尾三项（#9 第 7 / 8 / 11 项）**：
  - **第 11 项 `/api/version`、`/api/init` 不再对网络公开**：两者从公开白名单移出，改为**仅本机（或已登录）可达** —— CLI 的陈旧进程探测/`doctor`、桌面壳的更新检查都是访 `127.0.0.1` 轮询，照旧 200；徽章/登录页带会话 cookie 也是 200；未鉴权的远程调用现在 **401**（此前可用来指纹识别构建版本与更新状态）。`/api/health` 仍公开（托盘/浏览器需要），`/api/version/shutdown` 与 `/update` 本就在 ALWAYS_PROTECTED 里且先于该白名单判定。实测（临时关掉「仅本机」开关以避免被它先拦）：本机 200 / 局域网 401 / 局域网 `/api/health` 200 / 局域网 shutdown 401，验完已还原开关。
  - **第 8 项 会话从 24h 缩到 2h，并改为滑动续期**：泄露的 cookie 从“可用一整天”变成“两小时内失效”，而**正在使用的操作员不会被打断** —— `/api/auth/status`（仪表盘每次导航都会调，头部组件按路由重挂载）在会话过半时自动重新签发并保留身份声明。附回归：2h 的 exp 与 cookie maxAge 一致、新鲜令牌不续期、过半则续期且保留 oidc/saml 声明。
  - **第 7 项 MITM sudo 密码改用共享凭据加密**：原实现用 `sha256(机器码 + "10router-mitm-pwd")` 派生密钥，且取不到机器码时回退到 `sha256("10router-mitm-pwd")` —— 一个写在本仓库里的密钥，意味着那个“加密”文件对任何拿到源码的人都可解。但**即便不回退也仍不够**：机器码本身不是秘密（本机任意进程都能读），所以那套派生充其量是混淆而非加密，而且还多出一套要单独维护的密钥生命周期。现在直接复用供应商凭据那一套 `enc:v1:` AES-256-GCM（密钥来自 `CREDENTIAL_SECRET` 或 `$DATA_DIR/credential-key`，0600）—— 计划中的系统级密钥后端（Windows DPAPI / macOS Keychain / libsecret）只需替换 `getCredentialKey()` 一处，MITM 这条路径自动跟着升级。旧格式（机器码派生的 hex `iv:tag:ct`）仍能解密，并在**读取时就地升级**为新格式，无需一次性迁移脚本；密钥丢失或轮换时返回 null（下次操作重新询问密码）而不是抛错，保存失败只落日志不影响启动。
  - 附 `security-audit-leftovers.test.js`（19 例）+ `mitm-sudo-password-storage.test.js`（6 例，行为级：共享格式落库 / 往返 / 与供应商凭据同一把密钥 / 旧派生值可读并就地升级 / 错钥返回 null 而非抛错 / 清除）+ 更新两处原本锁定 24h 旧契约的用例。

## v1.1.3 (2026-09-20)

### ✨ 新功能

- **按模型上下文窗口 / 最大输出覆写（Context window pins）**（`92c35885`）：模型行新增调参图标，可对任意（含自动发现的）模型钉住 `contextWindow` / `maxOutput`；存 SQLite（`modelCaps` 作用域，与停用模型同为节点级，OAuth/导入导出自动跟随），优先级 = 钉住值 > 自定义模型自带值 > 目录默认，`/v1/models`、`/api/models` 徽标与用量口径同步生效；留空即回退默认。

- **超长上下文服务端自动压缩（Auto-compact）**（`cb4ec67f`）：客户端不自压缩（ZCode / OpenClaw / 自建 agent 直投全量历史）时，请求在派发前估算超过有效窗口的 90%（阈值 80/90/95% 可选，默认开）即由**同一模型**在带内部护栏头 `x-9r-internal-compaction` 的自调用里把较早轮次摘要化，摘要折入保留段首条消息（不产生连续 user 消息，Anthropic 严格形态安全）；`system`、最近 8 条与工具定义原样保留，切点保证不拆散 tool_use/tool_result 配对。任何失败（摘要调用错误/超时/格式不支持/responses 端点）原样放行，绝不因压缩器毁请求；CJK 感知的字符估算 + 4k token 热路径地板，小请求零开销。总开关在「实验特性」卡片。

- **Qoder 国内版（qoder-cn）完整恢复**（`a9b4a229`）：从删除前基线恢复 provider 注册表、OAuth 设备码流程、PAT→job-token 换取、模型目录与用量跟踪；不触碰隐藏供应商策略（trae / windsurf / devin-cli 继续不入库）。配套 `5b89d046` 修复模型家族映射——Qoder 内部代号（`qfmodel` / `qmodel*` / `qwq*` → qwen，`dmodel` / `dfmodel` → deepseek 等）在连字符/版本号剥离前先归一，用量图表不再按代号碎片分组。

- **Qoder / Qoder CN 每日 Credits 自动领取**（`25e8c00b` + `805bcc56`）：
  - 调度服务 `src/sse/services/qoderCheckin.js`：拉取 `/sash/api/v1/me/campaigns?clientType=10`，对可领取活动执行 `POST .../campaigns/{id}/claim`（带 `Cosy-ClientType` / `Cosy-Machine*` 头）；连接卡片提供手动触发按钮，API 为 `/api/oauth/qoder/checkin` 与 `/api/oauth/qoder-cn/checkin`。
  - 设置页「实验特性」新增 **Qoder 自动领取**开关，开/关即时动态启停调度器；`[QODER_CHECKIN]` 日志对齐 CodeBuddy 签到标准（启动横幅 / 调度节奏 / 每连接结果）。
  - **当日去重全局持久化**：SQLite `settings.qoderDailyDone`（仿 `codeBuddyDailyDone`），当日已领取后重复触发零网络请求，跨日自动清理；zh-CN / zh-TW i18n 词条补齐。

- **Qoder 资源包逐包展示**（`2a659730`）：从已领取（`claimStatus=CLAIMED`）的 CREDITS campaign 重建每个资源包（金额 / 到期时间 / 消耗按**先到期先扣**从聚合 `addOnQuota.used` 分摊），`quotas.addOn.packs` 输出，仪表盘逐行显示「赠送包 N」各带自己的到期日；聚合「资源包」行保留（官方口径的权威总量）。

- **OpenCode Free 体验渠道反滥用修复与默认开启**（`54ec08e7`）：
  - 针对 OpenCode 线上新增的反滥用检测，实装 4 层伪装拦截防护：User-Agent 规范版本化（`opencode/1.18.31`）、`ses_` 30 位规范会话生成与跨请求确定性映射、请求级 `bash`/`read` 隐真工具（decoy tools）注入（`tool_choice: "none"`）、强制流式连接（`stream: true`）。实测 `big-pickle`、`nemotron-3-ultra-free`、`nemotron-3.5-lightning-free`、`mimo-v2.5-free`、`ling-3.0-flash-fin-free` 100% 畅通秒吐字。
  - 体验渠道默认从拓扑隐藏改为**默认展示**（`topologyHiddenByDefault: false`），开箱即用。

- **反重力（Antigravity）生图模型补齐**（`54ec08e7`）：
  - 补录 Google 内部端点原生支持的 **`gemini-3-pro-image`**（Gemini 3 Pro 高清图像生成）、**`gemini-2.5-flash-image`** 与 **`imagen-3.0-generate-002`**（Imagen 3）。
  - 同步扩充 `open-sse/services/usage/google.js` 的配额拉取白名单，使得 Pro 级图像生成可在仪表盘正确显示配额与状态。

- **上游 v0.5.81 稳定性核心缺陷修复移植**（`81bdc69e` + `0b414322` + `81c040ed`）：
  - **P0-1（4xx 请求级错误不冷却健康账号）**：`checkFallbackError` 针对 400（上下文超长、畸形 body 等请求自身错误）短路跳过账号冷却，避免单账号场景下连续误报「账号不可用」并连带封锁其他无关会话。
  - **P0-2（连接测试成功自动清除陈旧模型锁与健康状态）**：连接点击测试成功时，主动清理 `modelLock_*`、`backoffLevel`、`rateLimitedUntil` 等残留锁，防止换 Key 或修复账号后仍被旧状态拦截。
  - **P1（HTTP 200 建立后流中断 in-band 错误帧上报）**：长静默流（如思考模型、Kiro 等）异常断开或 stall 超时时，按客户端格式注入错误帧后再发送 `[DONE]`，防止客户端将截断误判为正常短回复。

- **Provider 卡片拖拽排序与状态自适应**（`63b0547d` + `e85ec99b`）：
  - **已连接卡片拖拽排序（持久化）**：Provider 列表卡片支持原生 HTML5 拖拽重排，自动持久化至全局设置 `providerCardOrder`。
  - **移除「禁用排在最后」开关**：禁用的 provider 一律自动置底（且位于「无连接」分组之前：已连接 rank 0 → 免鉴权隐藏 rank 1 → 全部禁用 rank 2 → 未配置无连接 rank 3），删去冗余配置开关。
  - **OAuth 凭证导入/导出开关移至单 Provider**：移出 Profile 全局设置，改在每个 OAuth Provider 详情页的配置栏中独立开启（向下兼容旧全局设置）。
  - **Qoder / Qoder CN 手动领取 Credits 解耦**：各 Provider 详情页的手动「领取 Credits」仅对自身 provider 连接生效，不再跨 provider 触发；后台全天自动签到轮询维持一个全局开关。
  - **QODER_CHECKIN 日志精简与人读友好**：移除长 JSON 数据 dump 与裸 UUID，连接以「Qoder CN: 用户名」标识；启动与周期刷屏合并为可读摘要，单轮完成仅输出简明汇总行。

- **Qoder 实时倍率叠加与千问错峰半价/限免倒计时**（`bf820454` + `9d8c222a` + `40b78356`）：
  - 动态叠加官方实时 `price_factor` 与 promotion（夜间限免/半价），Qwen3.8-Max / Qwen3.7-Flash 实时展示折扣倍率与优惠倒计时。
  - 清理历史营销期虚构行（`lite` / `ultimate` / `performance` / `efficient` 等），保持与官方目录严格一致。
  - 修复 Tailwind 非层级样式覆盖导致的叶子图标尺寸异常，对齐 10px / 16px 精确渲染。

- **Qoder 官方图标**（`e804845b` / `b0b5ec87`）：从官方启动器 PE 资源提取 256×256 PNG，替换 `qoder` / `qoder-cn` 占位图标。

### 🛠️ 优化与修复

- **自动压缩对推理模型的兼容修复**（`754d790c`）：test.21 线上验证发现 hy4-preview 等推理型上游会把摘要调用的 `max_tokens` 全部耗在 `reasoning_content` 上、返回空 `content`，导致压缩静默退化为原样放行——摘要自调用现在强制携带 `enable_thinking: false`（统一 thinking 翻译层按 provider 能力映射/剥离），`extractSummaryText` 在 `content` 为空时回退 `reasoning_content`（残缺摘要也好过超限硬失败），且空摘要改为显式 `[COMPACT] empty summary` 告警不再静默。实测 30k 请求（pin 窗口 30000）：`est 30248 ≥ 90% → summarized 6, kept 7`，上游 `prompt_tokens` 26905 → 14981。

- **额度窗口用尽后重置时间徽章不再消失**（MiMo 周报）（`b4f2e024`）：连接卡片的到期徽章由 `extractEarliestPackageExpiry` 驱动，旧规则把「用尽」条目一律跳过——对一次性资源包正确，但周期性窗口（`recurring:true`：MiMo Weekly、CodeBuddy 基础包、commandcode）用尽时**恰恰最需要显示还剩几天重置**。现在仅非 recurring 条目受用尽过滤约束；MiMo Weekly 补上 `recurring:true` 标记；路由侧无影响（到期优先排序只发生在已过可用性检查的连接之间）。真实 payload 验证：100/100 用尽的 Weekly 现在持久化 2026-09-22 重置时间并出徽章。

- **`/v1/models` 模型列表顺序跟随仪表盘卡片排序**（`e937f6e5`）：抽取共享比较器 `buildProviderOrderComparator`（手动 `providerCardOrder` → 注册表 `priority` → id 字典序），与仪表盘同一口径；未连接 provider 的孤儿自定义模型与已连接 provider 按卡片序穿插（非固定尾部），combo 永远居首；组内按原有发射序稳定排序，空 cardOrder 回退注册表默认，读失败绝不致空列表。

- **严格兼容端工具 schema 顶层降级（#27）**（`dcc864b8`）：codebuddy-cn 对工具 `parameters` 根节点非纯 object（根 anyOf/oneOf/allOf、根 `$ref`、type 数组、缺 type）直接 `11129` 拒整个请求——新增 quirk 门控的转换器：仅对声明该约束的 provider 生效，根组合器展平/内联为纯 object 根（$ref 就地展开、required 按 allOf 并集/anyOf・oneOf 交集合并），嵌套层构造逐字不动；仅改写发往上游的副本，客户端原 payload / 其他 provider 字节不变；11 例回归 + 真实复现验证，线上已关闭 #27。

- **Qoder 配额解析修正**（`4a550135`）：`getQoderUsage` 补解析 `addOnQuota`——原实现只读 `userQuota`，免费账户每日/活动领取的 Credits 全部显示 0/0；顺带修复 qoder-cn 配额标题与类型 i18n。

- **资源包到期时间从 campaign 推导**（`fcc74f1d`）：官网用量页需会话 cookie（设备 token 一律 401），改用 campaigns 数据计算有效期——`FIXED_END` 直接取 `benefit.validity.fixedEnd`，`RELATIVE_DAYS` 按 `startAt + days×86400000`；仅保留未过期项并取最早作为 `addOn.resetAt`。实测与国际版官网「2026年10月18日」及国内版补偿包（9月30日）一致。

- **配额文案对齐 Qoder 官网 + 连接卡不露邮箱**（`2506f194`）：订阅 →**套餐内 Credits**、个人资源包 →**资源包**（与官网用词一致）；资源包聚合行不再显示倒计时，逐包「赠送包」行改用 CodeBuddy 同款「expires in」相对剩余文案；Qoder 国际版连接卡优先显示 `displayName`（真实姓名字段）而非邮箱，且防止次级标签与主标签重复。测试同步更新（含修正 `qoder-usage-display` 里遗留的旧「Personal」断言）。

- **PR #23：CodeBuddy 国际版 DeepSeek 拒绝 `reasoning_effort: "auto"`**（`69ea4169`，close #23）：`auto` 值不再透传（上游 400 code 11150），映射为不携带该参数，补单测锁行为。

### 📄 文档

- 账号停用申诉模板：补英文版并按「行动清单替代辩解」风格重写（`62b78546` / `31566db1`）。
- Antigravity 文档补 18+ 年龄验证硬门槛 + 新建账号风险与恢复指引（`3f9256f5`）。
- README 徽章校准（版本前置 + 下载计数徽章）、文档索引补齐 6 篇专题、10router-sync 插件章节更新（5 数据源 + `status` 命令）（`70ad6b32` / `d0376d59` / `07db22d5` / `322a461d`）。

## v1.1.2 (2026-09-18)

### ✨ 新功能

- **用量「详情」页新增仪表盘（热力图 / 节点健康度 / 生涯统计）**：
  - **生涯统计卡**（5 张，无需时间选择）：累计请求数、累计 Token 数、峰值 Token 数（附日期）、缓存命中率（精准过滤真实数据，排除无缓存与输入=缓存的虚假数据，附带缓存 Token 总量）、常用模型（按**最近 7 天 Token 消耗**判定，副标题调整为「最近 7 天 5.4亿 · provider」，保证小卡片宽度下关键用量数据永不截断）；配色与字体对齐概览卡片，模型名用 CSS 容器查询 `clamp()` 自适应缩小不截断。
  - **GitHub 风格活跃热力图**：固定 12 个月窗口（计入外部导入流量）、周一起始、周五→周六加宽 20% 间距、月份标签按周边界检测（首月不标）；网格**固定高度**、色块尺寸由高度推导，容器越宽显示的周数越多（ResizeObserver 自适应，取代拉伸变形）；日/周双视图，悬停为自定义深色气泡（本地化日期 + `2.5亿 tokens · 29 次请求` 格式）；底部汇总栏支持展示当前连续天数（如 `1,966 次请求 · 2.2亿 Token · 13 天活跃 · 连续 1 天`）。
  - **节点健康度**（固定最近 7 天窗口）：按供应商聚合同供应商多账号；评分 = 成功率 60% + 延迟 20% + 速度 20%（TTFT / 输出 tok/s 取自 `requestDetails` 最近窗口，缺数据轴权重回退成功率）；**请求数 < 100 不参与评分**；表格补齐「平均速度」（Avg Speed / tok/s）列，后端针对流式（`total - ttft`）与非流式/单包聚合流式（`total`）自适应计算输出吞吐速度；表格全部列支持点击排序、复用共享分页组件。
  - **单位缩写开关**（设置页语言卡「本地货币」下方）：localStorage 持久化、默认开启——中文界面大数字按 `亿`/`万` 缩写，其他语言按 `B`/`M`/`K`；关闭后全部数字回退完整千分位。仪表盘所有数字（卡片 / 热力图气泡 / 汇总行）统一走新共享工具 `src/shared/utils/compactNumber.js`。
  - **数据口径**：外部导入行（`meta.imported`）**不参与健康度评分**但计入热力图与生涯统计。**9r/10r 网关同步行除外**（2026-09-16 补）：`meta.gatewaySync=true` 标记「源实例原生观测」的导入行（10router-sync `--source 10r` 仅对源库原生行打标；服务端 9r 备份 sqlite 导入路径同规则自动打标）——其状态码是真实网关结果，计入健康度评分；B 实例自己从客户端账本（zcode/mirasim/mimo）导入过的行经链式同步**不带**标记，继续排除。
  - 新 API `GET /api/usage/dashboard`（`src/lib/db/repos/usageRepo.js` 的 `getUsageDashboard`，`period/days/start/end` 参数保留兼容但已不使用）；i18n 词条接入 zh-CN；新增 `tests/unit/usage-dashboard-import-exclusion.test.js` 4 例（导入排除/热力包含/阈值/范围无关性 + lifetime 断言）。

- **小米 Token Plan 出口节点智能匹配（ip.sb 多源探测）**：官方三集群 `cn`/`sgp`/`ams` 不再需要手动猜——添加/编辑 `xiaomi-tokenplan` 连接时自动探测本机网络出口地区并预选对应节点（中国大陆/港澳台→`cn`，欧洲→`ams`，其余海外→`sgp`），节点下拉框旁提示「已根据当前网络出口自动匹配节点」，用户随时可手动改回。服务端探测接口 `GET /api/network/egress-region`（`src/lib/network/egressRegion.js`）：ip.sb geoip + 3 秒超时 + 15 分钟内存缓存 + 整链 fail-open（探测失败静默返回 null，绝不阻塞连接添加/编辑流程）。顺带修复存量缺陷：连接「测试」按钮原把 `xiaomi-tokenplan` 硬编码打向 `sgp` 集群，配置 `cn`/`ams` 的连接永远测不通——现按 `providerSpecificData.region` 动态解析测试端点，与聊天转发行为一致；小米桌面会话模型出口在海外时的探测失败提示附带回国代理指引。新增 `tests/unit/egress-region.test.js`（国家→集群映射/缓存/超时 fail-open）与 `tests/unit/xiaomi-tokenplan-test-region.test.js`（region→测试 URL 路由）锁行为。

- **10router-sync 插件 v1.4.0：新增 `/10router-sync:status` 实例状态监控命令**：不打开仪表盘、一条命令查看目标 10Router 实例的运行状态与今日用量摘要（版本、连接规模、今日请求数/Token/费用等），复用插件既有认证链（仪表盘会话 / CLI token `x-9r-cli-token`），与导出/导入命令同配置即用。插件发版三处版本号同步：`.zcode-plugin/plugin.json` + 根 `marketplace.json`（Discover 实际索引）+ `zcode-plugin/marketplace.json`。

- **10router-sync 插件 v1.3.0：新增 10Router/9Router 实例用量同步（`--source 10r`）**。
  - 读另一个 10Router（或遗留 9Router）实例的 `data.sqlite`（`usageHistory` 表），原样透传导入目标实例——provider/cost/status/tokens/meta 全保留，同名 provider 在目标侧自然合并；适用于把 NAS 实例、兄弟中继、9Router 老安装的用量汇总进一处仪表盘。别名 `10router` / `9r` / `9router`。
  - 源库发现：`--db <path>` 显式指定（NAS 拷贝/挂载盘），否则自动发现 `%APPDATA%\10router|9router\db\data.sqlite` / `~/.10router|~/.9router/db/data.sqlite`（env `TENROUTER_DB` 优先，多库共存时提示）；`--tag` 自定义 `meta.syncedFrom` 标签；源实例 `connectionId` 挪进 `meta.sourceConnectionId` 并置空，避免污染目标按账户聚合。
  - **同实例防护**：源库路径命中本机默认实例库且 `--endpoint` 为 loopback 时以退出码 2 拒绝——把实例导回自己时所有行撞签名，而服务端 `importUsageRows` 撞签会给旧行补写 `meta.imported=true`，把实时行标成「导入行」；确实是另一实例时 `--force` 越过。反向链式双计（源实例上游是目标实例）签名两边不同、服务端拦不住，文档明示不可用。
  - 列集与服务端 `readUsageFromSqlite()`（9router 备份导入路径）一致，旧库缺列自动降级最小列集；读活库为快照复制（含 `-wal`/`-shm`），不必停源实例。合成库 + 本机真实库（2234 行）实测：导出转换/守卫 exit 2 / `--force` dry-run / 参数校验全通过。同日审查加固两处：无 scheme endpoint（`127.0.0.1:20127`）也能触发同实例防护（否则守卫失效开）；NULL 时间戳行导出侧跳过（服务端回填 `new Date()` 会破幂等）。根 `marketplace.json`（Discover 市场索引）同步 1.3.0 与新描述。

- **10router-sync 插件 v1.2.0：新增小米 MiMo 桌面版（mimocode）用量导出 + ZCode 源改为「仅官方渠道」**。
  - **小米 MiMo 桌面版**（`--source mimo`，别名 `--source mimocode`）：MiMo 把每轮 assistant 消息的完整 token 计量记在 `~/.local/share/mimocode/mimocode.db` 的 `message` 表（JSON `data` 列：`input`/`output`/`reasoning`/`cache.read`/`cache.write`，附 `modelID`/`providerID`/`agent`/`mode`/`time`），比 OpenCode 的 session 级汇总粒度更细（逐轮消息级）。实现要点：WAL 活库先快照再读（复用 `snapshotDb()`）、按 `message.id` 去重、0-token 空转/中断轮次跳过、provider 落 `mimo-<providerID>`、cost 记 0、`meta` 带 messageId/sessionId/agent/mode；Windows 回退路径 `%APPDATA%\Xiaomi MiMo\mimocode.db`。本机实测导入 101 行（`mimo-mimo` 42 / `mimo-xiaomi` 59），重跑幂等。
  - **ZCode 源改为结构性「仅官方渠道」**（`builtin:*` 前缀，如 `builtin:bigmodel-*`、`builtin:zai-*`）：非 `builtin:` 的 provider 一律是用户自加的自定义渠道，其流量在用户体系里都走本地网关（10Router 自身或兄弟中继），已由 10Router 记账或别的同步源覆盖，导出即重复。**背景**：旧守卫基于「当前配置里 baseURL 指向 10Router 的 provider id」，而 provider 删除重建会换 id——本机实测旧 id `bd97d057-…` 的 3810 行网关流量（模型名形如 `bai/glm-5.3-flash`）因此漏网并被导入，与 10Router 自记的 `bai` 渠道形成双份统计；启发式补丁（UUID + 网关寻址模型名）随后又被第三个自定义 provider（`1fd00800-…`，90 行，模型名不含前缀）绕过——改为前缀判据后三种情况结构性覆盖。跳过时按 provider 分组打印计数（绝不静默丢数据）；`--include-custom` 保留旧行为作逃生口。
  - 文档（README/AGENTS/SKILL/命令描述/manifest）同步更新至 v1.2.0。
  - **附带运维工具三件套**（`scripts/usage-daily.mjs` / `verify-usage-db.mjs` / `clean-usage-db.mjs`）：把 10Router 的 `usageDaily` 聚合契约固化成可复用工具——**校验器**做只读体检（完整性/外键/**usageDaily 与 usageHistory 逐日逐字段一致性**/lifetime 计数器），**清理器**按 provider 或 SQL 谓词删行并忠实重建受影响日桶（默认 dry-report，`--apply` 才写入，内置事后自检）。背景：手工清理导入错的重复行时踩过两个坑——日桶必须按**服务器本地日期**分桶（UTC+8 下约 20% 行归属不同），且必须重建**全部五个维度**（byProvider/byModel/byAccount/byApiKey/byEndpoint），否则数字静默错误。实测对同一份含 3810 条重复行的库执行，结果与手工修复**逐字节一致**（36917 行 / 56 桶 / 桶 JSON 完全相同）。

### 🛠️ 优化与修复

- **渠道熔断响应附带友好提示**：命中 11128 类渠道级风控时，客户端收到的不再只是上游原始 JSON（ZCode 等客户端只显示素的 "Bad Request"）——首次命中(400)与熔断窗口内(503)两处响应都追加中英双语说明：**这是请求形态（超长会话/工具过多）触发的上游渠道级安全风控，非账号问题；请压缩会话或稍后重试，窗口结束自动恢复**。纯函数 `withChannelScopeHint`（`open-sse/services/accountFallback.js`）承载文案，单测锁契约（cause/remedy/双语/不甩锅账号四要素）。

- **渠道级熔断三项跟进修复（P0 运行时崩溃 + 并发竞态 + 死代码）**：
  - **P0：`chat.js` 运行时必崩修复**——`0065bd0c` 引入渠道熔断时，`getChannelBlock / setChannelBlock / clearChannelBlock` 只加在 `src/lib/db/index.js`，**漏了 `src/lib/localDb.js` 兼容 shim 的 re-export**。ESM 缺失命名导入在构建期不报错、单测又把 localDb 整个 mock 掉，导致全量测试绿灯但**运行时每个聊天请求都会 `TypeError: getChannelBlock is not a function` 直接 500**。补上 shim 导出；新增 `tests/unit/localdb-shim-export-guard.test.js`——解析全库 `import { … } from "@/lib/localDb"` 并逐一核对 shim 真实导出，下次再漏会在 CI 红而不是生产崩。
  - **熔断状态并发竞态修复**：`setChannelBlock` / `clearChannelBlock` 原实现在事务**外** `getSettings()` 读、再把整个 `channelBlocks` map 传入 `updateSettings` 覆盖写——两个 provider 同时熔断会互相丢 block，`clearChannelBlock` 也可能复活期间新设的 block（注释声称的并发安全并不成立）。新增事务内 read-modify-write helper `mutateSettings`，合并逻辑进事务才真正原子；`tests/unit/channel-block-repo.test.js` 5 例在真实 store 上跑（含并发 set 无丢失、set+clear 竞态一致性），旧实现下该并发用例必红。
  - 清理 `accountFallback.js` 里从未被引用的 `CHANNEL_BLOCK_KEY_PREFIX` / `getChannelBlockKey`（kv 存储方案的遗留物，实际落点是 `settings.channelBlocks`，注释同步纠正）。
  - 补交 `siliconflow-cn` 的 golden URL/header 快照（`ac72c71d` 应带未带，本地跑测试自动更新出来的正确产物）。

- **CodeBuddy 11128「unapproved channel」改为渠道级熔断（不再逐账号重试放大风控）**：
  - **问题**：`codebuddy-cn` 命中上游安全策略 `11128` 时，10Router 按常规走账号 fallback——**同一秒内把 4 个账号依次打同一个模型**（`余师洋 → 1698 → 1697 → 洋芋`，整体 <2s，各锁 `modelLock 30s`），日志呈现 `all 4 accounts locked`。这段突发本身就是上游 WAF 关注的信号，于是重试变成自我放大：四个账号全被拒绝，且下一个请求等锁一过又重演。
  - **实测判据（NAS 生产实例）**：同一账号、同一 token、带 registry 那套 CLI 认证头**直连上游**，`1MSG` / `31TOOL` / `54TOOL` / `1752MSG+54TOOL` **全部 200**；逐账号复刻真实失败形态（`5MSG+54TOOL`，含 ZCode 身份 system prompt）**四个账号全部 200**。但 11128 命中的账号分布是 `1697(12) / 1698(10) / 余师洋(4) / 洋芋(5)`，且失败耗时仅 323–654ms（上游快速拒绝，非超时）。**结论**：不是某账号坏了、也不是 ZCode 入口特征——失败属于**渠道**（出口指纹 / 请求突发），单发请求永远成功。
  - **修法（配置驱动，`errorConfig.js` 新增 `channelScope` 规则位）**：命中 `unapproved channel` / `illegal api invocation` 时标记为 `channelScope: true`；`markAccountUnavailable` 对这类错误**不加任何账号级 `modelLock`**（只写 `lastError` 供仪表盘解释），由调用方改为设**provider 级渠道熔断**并立即中止账号 fallback。熔断落在 `settings.channelBlocks[provider]`（与 `codeBuddyDailyDone` 同层，非用户可见配置项），**60s 起步，5 分钟内复发升级到 10 分钟**；熔断期间该 provider 的请求直接返回 503 + `Retry-After`，不再触达上游。**任一成功请求立即清除熔断**（证明渠道已恢复，不必白等窗口）。
  - 效果：命中 11128 时对上游的调用从「4 次/秒 × 每 30s 重演」降为「1 次 / 60s」，且不再误锁四个账号（其余模型不受牵连）。
  - **与「配额包到期优先」的交互**：渠道熔断期间**跳过** SWR 配额刷新（`getProviderCredentials` 里判 `settings.channelBlocks[provider]`）——渠道正被整体拒绝时，多打一次上游（哪怕是 billing 端点）只会拖慢恢复，且读回的到期时间也不可用；熔断由任一成功请求清除，届时刷新自动恢复。反过来，**熔断真正生效过**时（清除前存在 block），成功请求会顺带 `invalidateQuotaCache(provider)` 把该 provider 全部连接的 `quotaCheckedAt` 置空，让下一次选号重新拉取——熔断窗口可能跨过配额包边界，earliest-expiry 排序不能拿熔断前的旧数据排。
  - 新增 `tests/unit/codebuddy-channel-block.test.js` 17 例：真实 11128 报文分类、大小写与纯 msg 匹配、11133/6004/429 不误判、既有 401/402/403/404 规则无回归、`channelScope` 仅由两条 11128 规则携带、熔断首次/升级/窗口外回落/过期归零、「渠道熔断不产生任何账号级 modelLock」，以及配额刷新交互三例（invalidate 逐连接置空 / store 故障不抛 / 熔断未过期才跳过刷新）。
  - 文档：`docs/zh-CN/codebuddy-cn-error-codes.md` 的 11128 条目补「渠道级熔断」处置与实测判据。

- **用量仪表盘生成速度算法优化与门槛调整**：
  - **加权吞吐与上游缓冲突发抑制**：重构 `UsageDashboard` 节点与模型平均生成速度（`avgSpeed` / tok/s）计算逻辑。针对 Antigravity / Gemini 等因上游代理缓冲整包下发导致 `ttft` 滞后、瞬时突发传输（如 100ms 接收 1700 tokens 导致算术平均被拉高至 1,189 tok/s）的失真问题，引入物理合理性探测——当瞬时生成速度 > 250 tok/s 时，自动判定为上游缓冲突发并回退至端到端总延迟（`total`）进行计算；同时将单纯的离散速率算术平均升级为真实的加权输出吞吐（`totalTokens / totalGenerationDuration`），兼容 `completion_tokens` 与 `output_tokens` 两种键名；
  - **健康度统计门槛降低至 50 次请求**：将节点健康度评分与展示的最小请求门槛由默认 100 次调整为 `minRequests = 50`，覆盖更多有一定请求规模的可用节点；
  - **提示文案与多语言规划**：节点健康度卡片提示文案更新为「最近 7 天（>50 次请求）」（`"Last 7 days (>50 requests)"`），空状态提示更新为「本时间段内没有请求数达到 50 的节点」（`"No nodes with 50+ requests in this period"`），并在 `zh-CN.json` 和 `zh-TW.json` 中补齐规范词条；补齐相关单元测试。

- **反重力（Antigravity）429 额度用完友好提示（多语言）**：
  - 新增共享工具 `src/shared/utils/quotaError.js`：识别 Google 风格 HTTP 429 `RESOURCE_EXHAUSTED` / `QUOTA_EXHAUSTED` 载荷，从 `quotaResetDelay` / `quotaResetTimeStamp`（或消息内 `Resets in …` 回退）解析重置时间与倒计时，模板化替换生成友好多语言提示，如「该账号额度已用完，将于 9月15日 20:52 重置（约 1小时27分 后）；可升级订阅提升限额。」；
  - 接入供应商详情页 `formatModelTestError` 与连接列表 `ConnectionRow` 的 `lastError` 展示管道，zh-CN / zh-TW 词条补齐；新增 `tests/unit/antigravity-quota-error-i18n.test.js` 8 例（含真实 429 报文回放）。

- **小米 MiMo 执行器加固与测试环境隔离**：
  - 修复 `transformRequest` 预览模型思考档位桥接在 `body` 缺失（`super.transformRequest` 返回 undefined）时的空引用崩溃风险；
  - 会话门槛测试改为确定性隔离：将 `APPDATA` 重定向至空临时目录，不再依赖本机是否安装/登录/运行小米 MiMo 桌面版。

- **小米 MiMo 思考级别软映射与动态 Token 预算控制**：
  - **能力与窗口修正**：在 `capabilities.js` 中为 `*mimo*preview*` 声明 `reasoning: true`、`thinkingFormat: "openai"`，并将上下文窗口修正为 1M (`contextWindow: 1048576`)；
  - **思考档位接入**：在 `thinkingLevels.js` 为 `*mimo*preview*` 配置 `["none", "low", "medium", "high", "xhigh"]` 5 档支持，使仪表盘供应商详情页可正常唤出 Thinking 思考档位选择器；
  - **动态 Token 预算与深度思考引导**：在执行器 `XiaomiMimoExecutor` 中实现对客户端 `reasoning_effort` 及 Claude Code `/effort` 档位的动态捕获，按档位阶梯分配 `max_tokens`（`none`: 4K, `low`: 8K, `medium`: 16K, `high`: 32K, `xhigh`: 64K），解决长思维链耗尽默认 4096 预算导致正文截断空白的痛点；对 `high` 与 `xhigh` 幂等注入兼顾工具调用规范的 UltraThinking 提示词；新增单元测试覆盖；
  - **测试错误多语言友好提醒**：供应商模型测试报错接入 `formatModelTestError` 智能多语言管道，补齐 `HTTP 502: [502]: This model requires the Xiaomi MiMo desktop account...` 全量词条与子消息模式匹配，将原始 HTTP 错误转换为友好提示「该模型需要小米 MiMo 桌面版账号。请先登录一次 MiMo 桌面版，然后重试。」。

- **用量与配额国际化全量清扫（福利抢先修复）**：
  - **配额项名称国际化**：修复用量面板配额名称硬编码英文问题，Command Code 滚动限额（`session (5h)` / `Session (5h)` → 滚动 / 滾動）、每周限额（`weekly (7d)` / `Weekly (7d)` → 每周 / 每週）、Qoder 账号级别（`Personal` / `Organization` → 个人 / 组织）、DeepSeek 及其他渠道通用余额（`Balance`、`Balance (CNY)`、`Balance (USD)`、`Balance ($)` 及任意货币模式 `Balance (XXX)` 动态正则回落）全部接入国际化字典与展示层转换；
  - **卡片视图与进度条管道接入**：修复 `ProviderLimitCard` 视图中直接渲染原始英文 `quota.name`、`message`、`error` 导致界面未翻译的遗漏，全量接入 `translateQuotaName()` 与 `translate()` 管道；进度条 `QuotaProgressBar` 补齐重置词（`Reset` / `Expires` → 重置 / 过期）与请求次数（`requests` → 次请求）的多语言翻译；
  - **供应商未连接与异常提示词翻译**：补齐 MiniMax（`MiniMax API key invalid or inactive...`、`MiniMax API key not available...`）、小米桌面版（`Xiaomi MiMo Desktop not connected...`、`Weekly quota requires Xiaomi account session. API key alone is insufficient.`）、Command Code、DeepSeek、OpenCode Go、Qoder 等用量状态提示文案的 zh-CN / zh-TW 字典；新增单元测试 `tests/unit/usage-quota-i18n.test.js`。

- **429 限流冷却尊重上游「请约 N 秒后重试」+ 客户端友好提示**：
  - **退避失配修复**：上游错误体明确给出等待窗口时（小米 MiMo TPM 实测文案：`用户 每人 触发 TPM 限流（上限 5000000），请约 23 秒后重试`），网关原先无视提示、按通用指数退避 2s/4s/8s/16s 连续空打——NAS 日志实证 16 秒内 4 连 429 全部浪费。新增 `extractRetrySeconds()`（中英双语模式：「N 秒后重试」/「retry after N seconds」）与 `backoffCooldown()`：冷却取 `max(指数退避, 上游提示秒数)`，上限仍为 30 分钟封顶；`checkFallbackError` 两条 `backoff` 分支统一接入，渠道熔断（`channelScope`）路径不受影响。
  - **限流文案友好化**：`withRateLimitHint()` 识别 429 限流类报文（`too many requests`/`rate_limit`/`频率限制`/`quota.*exceeded`/`[429]` 等形态），命中时在响应尾部追加「上游触发了限流（HTTP 429），非账号异常，已按上游提示自动冷却并稍后自动恢复；期间可切换其他模型或渠道」说明；小米 MiMo 渠道另附「体验/免费通道每分钟请求数与 TPM 均有硬限制」备注；非限流报文原样通过，可无条件套用。接入 `src/sse/handlers/chat.js`（全账号冷却、无账号可用两条客户端路径）与 `open-sse/services/combo.js` 组合模型兜底路径。
  - 新增 `tests/unit/rate-limit-hint.test.js` 9 例：真实报文识别（mimo 每请求/TPM 两种 429、CodeBuddy 6004、11128 不误判）、秒数解析（中文 23s/21s/30s、英文 45s、无提示 null）、冷却取值（上游提示 23s→冷却 23000ms、无提示走纯指数退避、超 30 分钟封顶）、渠道熔断响应不受影响。

- **修复 Cline/ClinePass 后台凭据自动刷新 400（issue #21，感谢 @TIANXT97 报告与定位）**：上游 `POST api.cline.bot/api/v1/auth/refresh` 不接受通用 OAuth2 蛇形表单体，严格校验 **JSON + 小驼峰**（`refreshToken` / `grantType`），原通用刷新链路对 cline 连接 100% 报 400 Validation failed，凭据到期即断连、后台无感续期失效。修法：`tokenRefresh/providers.js` 新增 `refreshClineToken(providerId, refreshToken, log)`——请求体 `{refreshToken, grantType:"refresh_token"}` JSON 提交，头部复用 `clineAuth.js` 的 `buildClineHeaders()`（chat/user 的 `Bearer workos:` 前缀不适用于刷新接口，token 走请求体），`dedupRefresh` 去重防调度器与请求路径并发重复打上游；响应 `data.expiresAt`（ISO）归一为相对 `expiresIn`（秒，与调度器/持久化层既有约定一致），`refreshToken` 轮换保留、无轮换回退旧值。`REFRESH_HANDLERS` 注册 `cline` + **`clinepass`**（ClinePass OAuth 共用同一 refresh 端点，原同样 400，一并修复）。新增 `tests/unit/cline-refresh-token.test.js`：请求体小驼峰 JSON（断言不含 `refresh_token`/`grant_type`）、端点 URL、`expiresIn` 归一、token 轮换/保旧、400 与无 accessToken 返回 null、双 provider 分发路由、merge 层 expiresAt 计算。**09-18 补充采纳 PR #22（@monkey2jack）三点增量**（与本修复同场景的平行提交，增量吸收后以 superseded 关闭）：请求体补 `clientType:"extension"`（对齐授权交换的 `client_type` 惯例）；accessToken 归一存 `workos:` 前缀（chat 路径本就惰性补前缀，归一后存储口径统一，`getClineAccessToken` 幂等）；**永久性认证错误**（refresh token 失效/吊销，`classifyOAuthRefreshError` 判 `invalid_grant` 等标记）返回 `{error:"unrecoverable_refresh_error"}` 标记而非 null——日志明确「需重新授权」；错误报文（含 issue #21 原始 400 Validation failed fixture）保持 transient 不误杀。测试扩至 11 例。

- **用量「模型类型」图表治理（家族聚合两轮 + 图例重构 + 概览接入单位缩写）**：
  - **家族归一化**：模型家族聚合原按连字符首段切分，`gpt-4o`/`gpt-6-astra` 归并正常，但版本号直接贴在品牌名上的产品被拆散——`hy4-preview`/`hy3` 各自成族、`qwen3.8` 与 `qwen2.5` 分家、`gpt-6` 与 `gpt` 分裂。两轮修复：先剥首段的连字符版本段（`gpt-6`→`gpt`），再对首段剥贴版数字（`hy4`→`hy`、`qwen3.8`→`qwen`，`[0-9]+(\.[0-9]+)*$` 正则），纯数字首段护栏保留原值不塌空、UUID 型模型名仍归 `other`。
  - **图例重构**：图例从图表内迁至顶部标签行右侧、贴容器最右缘；「other」聚合项**固定最右侧且不简写**；最多显示 6 项（含 other），超出按用量折叠进 other、图表数据同集合同步折叠；移动端整行自适应（`w-full`，桌面右对齐），图例与系列颜色一一对应。
  - **概览卡片接入单位缩写开关**：用量概览 5 张卡（总请求数/输入/缓存/输出 Token/费用）原用裸 `Intl.NumberFormat` 恒显完整千分位，与详情页的「单位缩写」开关脱节——四张计数卡统一改走 `fmtTokens(值, 语言)`（中文亿/万、其他语言 B/M/K，localStorage 开关双向生效）；Est. Cost 保持 `fmtCost`（货币金额不属于单位缩写范畴）。

- **CodeBuddy 11128 极端体积兜底与错误体协议化**：在渠道熔断治理之上增加极端请求体积的本地兜底（`isOversizedForCbcn` 判定直接拦截），明显超限的会话不再白白触达上游触发风控；网关错误响应体按 Claude 协议补齐顶层 `type:"error"` 字段（`open-sse/utils/error.js` 的 `buildErrorBody`/`unavailableResponse`），Claude 系客户端不再把结构化错误渲染成裸「Bad Request」；渠道熔断提示文案改以中文为主（保留必要英文对照）。

- **供应商与分类治理（体验分类 + 失效站下架 + 图标补齐）**：失效公益站 `gorouter`/`tabiauto` 下架移除（上游 403 FreeTierError 已死，无适配计划）；OpenCode Free / MiMo Code Free 归入新「体验」分类（registry 标记 `community: true`），默认从主列表隐藏，切换开关文案「显示公开免鉴权的免费体验通道（如 OpenCode Free）」；`siliconflow-cn` 补品牌图标（`providerIcon.js` 增加图标别名映射指向 siliconflow 资产）。

- **安全（P1）：`GET/PUT /api/providers/[id]` 单条连接接口脱敏**：列表接口（`328ecc41`）已抹 `providerSpecificData.mimoPassToken`，但单条接口的 GET 与 PUT 响应仍把 `providerSpecificData` 整包回显——小米桌面会话 cookie 明文暴露给任何仪表盘消费者。新增 `toSafeConnection()` 与列表同规则：删 `mimoPassToken` 与顶层 `apiKey/accessToken/refreshToken/idToken`，补 `hasAccessToken`/`hasDesktopSession` 能力布尔（占位 session 不算真 key）；PUT 为 merge 语义，编辑回传缺字段不会灭失存量 token。契约测试 `providers-route-secret-stripping.test.js` 扩 3 例：单条 GET 响应脱敏、部分编辑响应脱敏且存量 token 存活、无 `providerSpecificData` 编辑不灭失。

- **工程**：`tests/unit/channel-block-repo.test.js` 的 afterAll 临时目录清理包 try/catch 容错——Windows 下 SQLite 句柄延迟释放偶现 EPERM，把全绿套件打成 suite fail（发版审查 v1.1.2 §六.2 建议项落地）。

### 📄 文档

- **v1.1.2 全量审查报告**：`docs/zh-CN/archive/reviews/release-review-v1.1.2.md` 收录 v1.1.1→HEAD 全量审查，并于 2026-09-17 复审轮扩写——范围扩至 87 提交 + 工作区改动，纠错安全章节（单条接口泄漏已修），补发版 checklist；历史归档索引同步。
- **CodeBuddy 错误码手册**（`docs/zh-CN/codebuddy-cn-error-codes.md`）：11128 条目补「渠道级熔断」处置与实测判据（CN + intl 通用）；ZCode 兼容文档（`docs/zh-CN/zcode-cbcn-compatibility-and-plugin-design.md`）将「体积即触发维度」更正为已推翻结论（60KB 失败 / 113KB 通过样本对照），网关侧极端体积仅作兜底定位。

## v1.1.1 (2026-09-14)

### ✨ 新功能

- **支持跨账号「配额包到期优先」全局调度策略**：
  - 解决多账号下「固定薅一个账号直到耗尽、导致兄弟账号短期赠送包白白过期」的痛点。供应商详情页 Connections 卡片右上角新增「配额包到期优先 (Earliest Expiry First)」独立开关。
  - 新建 `open-sse/services/usage/expiryExtractor.js`，从配额数据中智能提取未耗尽包的最近到期时间，并在用量查询、连接测试及后台轻量刷新时持久化至数据库。
  - 调度器 `src/sse/services/auth.js` 在开启该策略时按到期时间升序排序账号（最快到期者优先消耗），零阻塞、零请求延迟；连接行即时展示到期倒计时徽章；新增 `tests/unit/earliest-expiry-first.test.js` 6 例测试覆盖。
- **支持 Command Code 用量追踪与配额展示（Issue #16）**：
  - 新增 `open-sse/services/usage/commandcode.js` 用量处理器，通过 Command Code CLI 协议头直接调用 `/alpha/billing/credits` 与 `/alpha/billing/subscriptions`。
  - 用量页完整展示 **5 小时会话滚动限额**（`session (5h)`）、**每周滚动限额**（`weekly (7d)`）、**月度额度**（`Monthly Credits`，含周期重置倒计时），并支持加量额度（`Purchased Credits`）与套餐名称映射（Go / GOAT / Pro / Max / Ultra 等）。
  - 注册表开启 `features: { usage: true, usageApikey: true }`，用量数据自动归一化与排序（固定顺序：5h 会话 → 每周 → 月度 → 加量）；新增 `tests/unit/commandcode-usage.test.js` 7 例单元测试锁定。
- **自定义模型批量启用/禁用（P2 收口）**：自定义节点/导入的 100+ 模型此前只能逐个 toggle。现①repo 新增 `setCustomModelsEnabled`（事务内 prefix 扫描、`ids` 可选子集、幂等返回改动数），API 新增 `POST /api/models/custom/bulk`；②**兼容节点与内置 provider 详情页两处**自定义模型区加「全部启用 / 全部禁用」（双向确认：enable 暴露给客户端 / disable 从 /v1/models 收回）；③**修 PUT 覆盖 bug**：`addCustomModel` 的 UPDATE 分支此前整行覆盖——只传 enabled 的单条 toggle 会把模型 `name` 重置为 id 并丢掉全部 capability 字段，现改为 merge。批量导入默认禁用的姿势此前已存在（Qoder/Import from /models），本次补齐一键恢复/收回的另一半。
- **Endpoint 页 i18n 全量清扫**：整页此前基本未翻译——「密钥签名轮换」问号图标的机制说明、标题/描述/确认弹窗、隧道与 Tailscale 全流程状态文案（重连中/创建隧道/打开登录页…）、API 密钥区的空态/暂停/删除确认/创建弹窗等 **110 处硬编码英文**全部改走 `translate()`，zh-CN/zh-TW 新增约 70 条词条（缺失时自动回落英文原文）。顺带修正两处此前只造了词条没接上的漏网（密钥签名轮换标题、全部重签）。
- **修正：CodeBuddy CN 的 Hy4-Preview 为「夜间免费」，与国际版分开**（用户核实）。此前两版都标 `rateMultiplier: 0`（全天免额度）——实际 CN 的免费仅限**本地时间 23:00–次日 8:00**，白天按正常倍率 **0.29x** 计费（用户提供）。注册表新增 `nightFree` 窗口字段（`{from: 23, to: 8}`，可跨午夜）：模型行徽章按本地时间**动态显示**——夜间绿色 `free`（tooltip 注明时段）、白天无倍率徽章（绝不全天误导性显示 0x）；intl 的 Hy4-Preview 维持全天免费 0 并钉住。CN/intl 倍率一致性守卫测试相应排除 hy4 并各自钉住语义（catalog 14 例绿）。
- **OAuth 导入 / 导出泛化到全部 OAuth 供应商 + 导出文件加密**。原 CodeBuddy CN 专属的明文 wb 格式导入导出升级为通用机制：①**所有声明 OAuth 的供应商**（gemini/claude/kilocode/qoder/antigravity/codebuddy 等）详情页头部均有 Export / Import 按钮（profile 的实验开关控制，原「按钮将被替换」文案已移除）；②**导出文件加密**——传输口令 scrypt 派生密钥 + AES-256-GCM（`10router-oauth-secure-v1` envelope），无口令即无法读取（旧文件是明文凭据）；③导入按身份合并去重（JWT sub → refreshToken → 名称，三级回退），新身份建连接、同身份原位更新；④安全与授权（按用户拍板迭代）：新路由 `/api/oauth/transfer/*` 进 guard `ALWAYS_PROTECTED`（免密部署也强制凭据）；**导入以传输口令为唯一授权、直达一步**——正确解密（GCM 认证标签）即证明持有导出方口令，UI 不再弹仪表盘密码框（呼应 #9 安全审计的口令重复暴露项）；仪表盘密码二次验证仅保留在**导出**（凭据出系统，闸门更高）；⑤导入查重增强至五级：JWT sub → accessToken 精确等 → refreshToken → email → 名称（同文件重复导入绝不产生重复连接）；⑥CN 签到开启隐藏 Import/Export 时补提醒文案。旧 wb 格式 API（`/api/oauth/codebuddy-cn/*`）保留兼容，UI 不再暴露。新增 `tests/unit/oauth-transfer.test.js` 10 例（roundtrip / 错口令 / 篡改 / 去重优先级 / 无 token 跳过）。
- **集成 `@lobehub/icons`：58 个供应商图标升级为官方品牌 SVG**。图标体系此前全靠手工维护的 `public/providers/*.png`，品牌更新要手动抠图。现引入 `@lobehub/icons`，按**精确手工映射**（60 处深导入 → 校验后 58 个：lobe 5.18 无 Gitlab/Zed）渲染官方矢量品牌标——优先 `Color` 变体（官方品牌色，明暗主题通用；无 Color 回退 mono，`currentColor` 自动跟随文字色，天然双主题无需 light/dark 两套）；lobe 未覆盖的 33 个供应商（CodeBuddy/Qoder/公益站/自托管/本地等）**原样走 PNG 兜底路径，零删除**。`ProviderIcon` 接入仅 4 行：命中映射 → SVG，否则原逻辑。深导入（而非整包引用）把 bundle 增量控制在只用到的图标。
- **`amd` 供应商图标换为 ATI 标**（用户指定，Wikimedia SVG → 128px PNG）。
- **测试报告体系文档化（一篇一文件 + 总索引）**：新增 `docs/zh-CN/test-report-INDEX.md`（按发生面分类：本地测试轮 / NAS 热替换 / 发版与 CI），沉淀三篇历史复盘——**NAS 漏 pull 装出旧代码**（fetch≠pull + 增量 `.next` 假命中 → 铁律：构建前 `pull --ff-only` 核对 HEAD==origin/main、服务端变更干净重建、marker 分 dashboard/open-sse 两处）、**electron-builder asar 句柄锁**（构建产物出工作区 → `-c.directories.output=%TEMP%`）、**v1.0.8 版本漂移 + tag 静默丢事件**（四版本位盖章工具化 + tag 必须单独推）；test.17 TDZ 事故独立成篇（`test-report-test17-tdz-page500.md`），`local-build-and-verify.md` §5 改索引、§6 误判表补「health 绿但页面 500」行。
- **本地测试轮加固三连**：①step 7 新增**登录态 SSR 冒烟**——`/api/health` 不走页面渲染，拦不住「health 绿但页面 500」；用数据目录 `jwt-secret` 铸 10 分钟 JWT 打 `/dashboard`，非 200 判轮次失败（铸 JWT 走落盘 helper `desktop/mint-smoke-jwt.mjs`——PowerShell 5.1 给原生 exe 传参会吃掉内嵌双引号，内联 `node -e` 必炸）；②`-SkipAppBuild` 复用旧产物时同步测试号到 `app/package.json`（否则 step 7 版本校验必挂）；③干净树时 `git status --porcelain` 空输出在 PS 5.1 是 `$null`，finally 里 `.Trim()` 会炸。
- **CodeBuddy 配额徽章改为「消耗递减」显示（CN + intl）**：用量面板此前把额度包显示成 `已用 / 总量`——新号读作 `0/100 100%`，数字随消耗**上涨**，与旁边本就是剩余语义的百分比（`100%`）互相打架。现 `parseQuotaData` 给 CodeBuddy 行打 `displayRemaining` 标记，渲染层翻转为 **`剩余 / 总量`**：新号 `100/100 100%`，随消耗递减（`99.5/100 96%`），数字方向与进度条、百分比一致。仅展示层翻转，`used` 数据语义不变（耗尽判定 `used >= total` 等逻辑不动）。CN 与 intl 共用同一分支（同一 fetcher），一并生效。卡片（`ProviderLimitCard`→`QuotaProgressBar`）与表格（`QuotaTable`）两个渲染视图均认该标记——首漏只改了卡片视图，用量页表格视图仍是已用口径（`96.66/100 3%`），已补齐。新增 `tests/unit/codebuddy-quota-display.test.js` 3 例。
- **修复：用量页百分比计算优先读取 `remaining` 导致金额型配额被当作百分比取整（如 $9.98 误显为 10%）**：`getRemainingPercentage` 此前先检查 `quota.remaining`，在处理带金额单位的配额（Command Code、Grok-cli 等，剩余 $9.9855）时直接执行 `Math.round(9.9855)` 导致误显为「10% 🔴」；现修正优先级优先读取标准的 `remainingPercentage`，并为 Command Code 开启 `displayRemaining`（显示为剩余金额递减 `9.99 / 10`），`tests/unit/commandcode-usage.test.js` 增加单测保护。
- **移除 APInex 供应商**：该渠道（高风险转售商，`api.apinex.bond`）实际体验不佳，整体下架——registry、模型目录、capabilities 元数据、图标、golden/baseline 快照一并移除（供应商 92→91）。既有连接已在两端（NAS/桌面）删除；历史文档中的 APInex 记录保留作存档。
- **修复：侧边栏收起/展开按钮状态不翻转**：桌面端收起侧边栏后，Header 左上的按钮图标仍是 `menu_open`（收起箭头）——看不出当前状态、也没有"展开"暗示。现 `DashboardLayout` 把 `sidebarCollapsed` 传入 `Header`，展开态显示收起箭头（menu_open）、收起态同图标水平镜像（箭头反向 = 展开暗示，用户终选方案，弃用汉堡），tooltip 同步翻转（新增词条 "Expand/Collapse sidebar"，zh-CN/zh-TW），并补 `aria-expanded`。
- **修复 #13：小米桌面版专属模型未登录时的报错友好化（不再伪装成限流）**：`mimo-x-pro/flash-preview` 只认 MiMo Desktop 账号 Cookie，未登录时调用原返回英文开发异常（含内部名词 `passToken`）且因错误未分类落入默认 30s 瞬时冷却——客户端看到误导性的 `(reset after 30s)`、同 provider 兄弟账号被无谓冷却。现 executor 抛带 `MIMO_DESKTOP_SESSION_REQUIRED` 码的可执行指引文案（错误规则表新增该文案 → **cooldown 0**：不锁账号、combo 立即穿透、客户端不再看到 reset 字样），文案入 zh-CN/zh-TW 词条并有守卫用例；注册表给两个模型加 `requiresSession` 标记，详情页模型行渲染「需桌面版登录」徽章（tooltip 说明仅凭 API key 无法调用），调用前即可见。
- **修复 #14：新增连接后禁用态即时可见 + 禁用区模型可直接测试**：provider 首次连接会触发服务端「全部内置模型默认禁用」，但两条新增连接路径（单条/批量）此前只刷连接列表不刷禁用表——界面显示「全部启用」而 `/v1/models` 实际为空，必须手动刷新页面。现抽 `refreshAfterConnectionChange()` 两路同时刷新。禁用区从裸 chip（只有 id + 恢复按钮）升级为完整 `ModelRow`（显示名/容量徽章/积分倍率/Test/复制一应俱全，主操作变为「+ 启用」）——服务端本就支持直接测被禁用模型（禁用表只过滤 `/v1/models` 可见性，不拦请求），「先测再决定启用」不再需要先暴露给客户端。两条路径均有源码守卫用例。
- **安全：`xiaomi-mimo/auto-import` 补进守卫强保护清单（P1，外部审查提出）**：该接口读取 MiMo Desktop 本地 `auth.json` 并把完整 `sk-` 密钥返回给响应体，与 cursor/kiro 的 auto-import 同级敏感，但 v1.1.0 加入时漏进了 `dashboardGuard` 的 `ALWAYS_PROTECTED`（免密部署也强制校验）与 `LOCAL_ONLY_PATHS`（仅限回环）两个清单——免密部署时内网任意请求可拖走密钥。现已补齐双清单并与 cursor/kiro 对齐（守卫单测新增 4 例锁定 远程403 / 本地免密401 / JWT与CLI token 放行 三态）；同接口 500 分支不再回显 `error.message`（避免泄露宿主机路径指纹）。
- **修复：`disabledModelsRepo` 并发 toggle 丢写（P3，外部审查提出）**：`disableModels`/`enableModels` 此前把 `current` 读取放在事务外（为让异步别名解析先行），两个并发 toggle 会各自基于同一旧快照合并、后写覆盖前写；现改为事务外只做异步解析，事务内用同步 `db.get` 重读最新值再合并（保留 own-row 优先、legacy sibling union 回退的既有语义），注释同步改准确。

- **CodeBuddy 自动签到改全天调度 + 新增国际版每日活跃会话（实验）**：CN 签到此前每天只在本地时间 00:00–06:00 随机一个槽点跑一次，失败要再等一天，且观察到对已签账号反复空转。现改为全天节奏：每 ~2 小时（+抖动）一轮；状态接口确认当日已签 / 签到成功即记入**持久化当日备忘**（settings 的 `codeBuddyDailyDone`：`{连接ID: 本地日期}`，写入时自动清掉非当日条目），当天后续轮次（含重启后的引导轮）直接跳过、不再发任何请求，次日自动重置；手动「立即签到」不带备忘、照常直发。新增国际版「每日活跃会话」开关（profile 页，设置 `codeBuddyIntlSession`，默认关）：官方活跃赠送活动（当天有对话请求即视为活跃，Free 30 / Pro 50 积分每天，服务端自动发放、无领取接口）——启用后调度器为每个活跃 codebuddy-intl 连接每日发一次最小流式对话请求（免费档模型 `hy4-preview`，rateMultiplier 0，`max_tokens` 16，请求形态对齐 intl 网关：前置 system + typed user blocks，否则 11101），成功即记当日备忘不再重复，401 自动刷新 token 重试一次。顺带修了 profile 页签到描述词条 key 与字典不匹配导致中文不生效的问题，并补齐 zh-TW 缺失的签到词条；移除 00:00–06:00 旧文案（三语）。`codebuddy-checkin` 单测扩到 26 例（备忘跳过/记录、intl 资格与 fail-open、全天 tick 边界）。

- **CodeBuddy CN / 国际版详情页右上角新增「网页版」直达按钮**：两个渠道的密钥不走"Get API Key"自动认证引导，原按钮对该渠道没有意义。注册表 `notice.webUrl` 声明网页版 = 在线 agent 页面（CN → `workbuddy.cn/app`（WorkBuddy 工作台），intl → `codebuddy.ai/agents`），provider 详情页头部链接有 `webUrl` 时渲染为「Web console」指向它（替换 "Sign up / Learn more"），media-providers 详情页的 `ProviderInfoCard` 同样支持，其余渠道维持原行为；词条 "Web console"（网页版/網頁版）入 literals。

- **仪表盘复制按钮加固**：复制链路此前只有在 `navigator.clipboard` **不存在**时才走 `execCommand` 兜底，而 `writeText()` 存在却被拒（窗口失焦、权限提示）时直接静默失败；用 LAN IP（如 `http://192.168.x.x:20127`）打开仪表盘更是非安全上下文，`navigator.clipboard` 压根不存在。现统一收口到 `copyTextToClipboard()`（clipboard API → textarea+execCommand 兜底），`useCopyToClipboard` hook 的 20+ 处复制按钮、SAML ACS 复制按钮（此前裸调用失败还无条件显示「已复制」）、侧栏手动更新「复制并关机」全部改走该链路。

- **壳内 web TUI 可复制粘贴（Hermes `/sessions` 场景）**：Electron 窗口没有浏览器右键菜单，且应用菜单 Edit 角色的快捷键抢在页面前拦走 Ctrl+C/V——TUI 里 Ctrl+C 本该是 SIGINT。现给所有壳窗体（主窗体/打开网址/管理最近）加右键菜单（复制/粘贴/全选，走 webContents 原生动作）；主窗体视图为外部页面时 Edit 角色改 `registerAccelerator: false`（Ctrl+C/V/Z 直达页面，行为同 Chrome），回到本地仪表盘自动恢复注册。

- **桌面壳 Alt 菜单三语化 + 「前往」菜单（打开网址 / 回到 10Router / 最近打开）**。按 Alt 呼出的菜单栏此前是 Electron 默认英文——现按壳内 tr() 词典出 en/zh-CN/zh-TW（文件/编辑/视图/窗口/帮助，role 保住快捷键与原生行为，mac 保留 app 菜单）。新增「前往」菜单：**打开网址…**（`Ctrl+L`，弹小输入框，任意网址不限 10Router，无 scheme 自动补 `http://`，主窗体内打开）、**回到 10Router**（`Ctrl+Shift+H`，一键回本地仪表盘）、**最近打开**（自动记录最近 10 条，`userData/recent-urls.json` 持久化，去重 + 手动清除）。主窗体随语义升级为通用视图：`will-navigate` 不再按白名单拦 http(s)（file: 等仍拦截，mailto/tel 丢系统浏览器）。迭代记录：本功能初版曾做成托盘「其他 10Router 服务」+ 手编 remote-services.json 清单，发布前按用户意见重构成现在的「前往」菜单形态（配置文件方案整体撤除）。帮助菜单随后按 Windows 惯例补齐：**关于 10Router**（复用壳内 `showAbout()` 对话框，按钮直达 GitHub），File 菜单原挂的「关于」移入帮助、只留退出；曾一并加的独立「打开 GitHub」菜单项旋即按用户意见撤除（关于对话框按钮已是同款入口，不必两处重复）。

- **「最近打开」支持标题，菜单不再被长网址撑爆**：条目优先显示标题，标题三个来源——①主窗体 `page-title-updated` 自动回填 `document.title`（页面真实加载后零额外网络请求，不受反爬/编码影响；手动标题永不覆盖）；②「打开网址…」弹窗新增可选标题字段（打开前就能起名）；③新增**管理最近打开…**小窗（逐条改名/删除，补齐原先只能整体清空的缺口）。无标题条目兜底只显示域名，完整 URL 悬停输入框可见。存储从字符串数组迁移为 `{url, title, titleManual}`，旧 `recent-urls.json` 自动兼容；容量维持 10 条。

- **运行日志按日期归档、长期保存**：生产入口 `custom-server.js` 启动时把服务端 console（log/info/warn/error）原样 tee 到 `<数据目录>/logs/app-YYYY-MM-DD.log`（本地日期、追加式、**无上限不清理**——这是「上游到底回了什么、请求为什么失败」的长期档案；requestDetails 只有 200 条环形缓冲，桌面版 server.log 超 5MB 启动即清零，都不承担这个职责）。格式 `<ISO> [level] 内容`，跨天自动换文件。实现为自包含模块 `src/lib/consoleArchiveStandalone.js`（仅 Node 内建，同 `outboundProxyStandalone.js` 的约束——standalone 里没有 src/lib 源码），由 `copy-standalone-assets` 补拷，数据目录解析与 `dataDir.js` 一致（`DATA_DIR` 优先，Windows 回落 `%APPDATA%\10router`）；任何写档失败只静默放弃归档、绝不影响原 console 与应用本身。`next dev` 不经过该入口，保持原样。新增 `tests/unit/console-archive.test.js` 6 例（写入格式 / 跨天滚动 / 目录不可写不炸 / 日期补零 / DATA_DIR 优先 / 平台回落）。

### 🐛 修复

- **修复：0 额度被误显为无限额度 (0/∞) 及哨兵时间戳导致 291 万天倒计时**：用量表格此前将 `total <= 0` 粗暴视为无限额度并渲染为 `0 / ∞`，导致 Qoder 免费版、DeepSeek 零余额等账号出现「0% 🔴」与「0 / ∞」自相矛盾的异常显示；同时 Qoder 官方接口对永久免费账号返回的哨兵时间戳 `253402214400000`（公元 9999 年）被直算为 `in 2912186d` 倒计时。现已全面收口：仅显式声明 `unlimited: true` 者才展示 `∞`，普通账号总额为 0 时真实展示 `0 / 0`（或 `0 / 0 credits`）；过滤公元 2099 年以上的哨兵时间戳，避免倒计时崩坏；新增 `tests/unit/qoder-usage-display.test.js` 3 例测试锁定。
- **Command Code 提示语与「获取 API 密钥」按钮补齐 i18n**：供应商详情页（含媒体供应商页）notice 文本此前直接裸渲染未过 `translate()`，补齐 `translate()` 管道及 Command Code 提示语中英繁词条，并补充「Get API Key →」繁中词条；新增 `tests/unit/provider-notice-i18n.test.js` 6 例测试锁定。
- **Endpoint 页的「密钥签名轮换 / 重签全部密钥」合并为一行紧凑布局**。原先两个独立区块（开关行 + 仅启用时出现的重签行）各带一段描述，在空间有限的 endpoint 页占了两大行；现合并为一行——标题 + Experimental 徽章 + 单行截断描述 + Tooltip（机制细节全在 tooltip 里，并补上「重签会把存量密钥一次性换到当前密文下」这半句），右侧 `Rotate all` 小按钮仅在轮换启用时出现，再右是开关。所有确认弹窗、防双击守卫（`rotateGuardRef`）与重签结果弹窗逻辑不变，纯布局收敛。`Rotate all` 随后进一步缩小防误触：Button 新增 `xs` 档（h-6 / px-2 / 11px 字号），去掉 autorenew 图标，触达面积约为原 sm 档的一半。

- **CodeBuddy 国际版的连接测试不再是「Provider test not supported」**。仪表盘上点连接测试时，中国版正常、国际版一律报「Provider test not supported」—— 而**路由/推理一直是好的**（fnOS NAS 上实测 `cbai/deepseek-v4.1-flash` 正常 `DONE 2586ms`）。原因在测试专用路径：`testSingleConnection()` 把非 apikey 连接交给 `testOAuthConnection()`，后者先查 `OAUTH_TEST_CONFIG[provider]`，查不到就**在任何网络调用之前**返回这句错误 —— 于是「测试配置缺一条」被读成了「账号坏了」。`OAUTH_TEST_CONFIG` 里有 `codebuddy-cn` 却没有 `codebuddy-intl`（与之前缺模型、缺积分倍率是同一族漏项：改 CN 时忘了 intl）。现按 CN 的形状补上 `"codebuddy-intl": { tokenExists: true }`，并补 apikey 路径的 `case "codebuddy-intl"`（打到 `codebuddy.ai` 网关并带上注册表里的 IDE 通道头，否则会被判 11128「非认可渠道」）；该 case 的判定**故意只认 401/403** —— intl 网关是 stream-only，`stream:false` 探测可能直接被拒（11101），一旦收紧成 `res.ok` 就会把每个有效密钥永久判为无效，注释里写明了这一点。同批修掉同族第二处：用量面板的 `parseQuotaData` 缺 `codebuddy-intl` 分支，落到 `default:` 后丢掉 `recurring`，导致国际版的一次性加量包显示「Reset in」而非「Expires in」（后端 `getCodeBuddyIntlUsage` 本来就产出该字段，只是 UI 没接）。新增 `tests/unit/codebuddy-intl-test-support.test.js` 5 例：两版本在 `OAUTH_TEST_CONFIG` 里成对存在、apikey case 指向 `.ai` 域名（防止复制粘贴留着 CN 端点）、判定保持 auth-only，以及 intl 的 `recurring` 透传（走真实 `parseQuotaData` 而非文本断言）；变异验证：删掉 intl 条目 → 守卫用例立刻变红。
- **修正 `gpt-6-astra` 的积分倍率：`17.35` → `6.67`**。1.1.0 出厂的那个 17.35 是**估算值**，不是公布值 —— 当时仓库、`~/.codebuddy`、官网定价页都取不到 CodeBuddy 的积分数字，于是拿 OpenCode Go 价目表用比值法推（Astra 在四列与两个档位上恰好都是 Sol 的 5 倍，Sol 的 3.47 是公布值 → 3.47 × 5 = 17.35）。实际积分体系并不遵循这个比值，实测为 **6.67**；该估算与其推算方法一并作废，注册表注释里写明「不要再拿外部价目表反推这家的倍率」。用例改为钉住实测值，并**反向断言**它不再等于 Sol × 5，防止有人照着旧注释把比值法再推一遍。

### ⚙️ 工程与打包

- **新增桌面版一键本地测试轮 `desktop/test-local.ps1`**：把「退托盘 → 盖测试号 → 构建 `cli/app` → 打包 → 替换/安装 → 启动 → 验证 → 回退版本号」串成一条命令，`-Mode replace`（默认，就地替换，约 2 分钟）与 `-Mode install`（真跑一遍安装器，约 4 分钟）两条路；测试号默认取「最新 tag 的补丁位 +1 再挂 `-test.1`」，回退放在 `finally` 里 —— 中途失败也会把版本号退回去。刻意做进去三处防御（全是踩过的坑）：启动只用 `Start-Process`（`cmd /c start "" "路径"` 会被 Git Bash 吃掉空标题，exe 路径被当成窗口标题，于是什么都不启动、退出码却是 0）；静默安装**直接**起 `Setup.exe`（经 `cmd /c start /wait` 转一手时 `/S` 会静默空转）；替换用**重命名式交换**而不是「先删再拷」—— 目录被占用时 `Rename-Item` 干净失败并自动回滚，而 `Remove-Item -Recurse -Force` 会把能删的先删掉、再报错返回，把一个好端端的安装删成**空目录**（写这个脚本时就真踩了：构建那几十秒里应用又被拉起来占住了目录，于是替换删一半失败，`resources/app` 被清空，只能从 `dist/win-unpacked` 恢复）。另加 `-Marker "<字面量>"` 用产物里的特征字符串做正向断言。

### 📄 文档

- **本地测试流程修掉两条「不报错但什么也没做」的命令**：`§2.3` 的启动命令 `cmd //c start "" "路径"` 会被 Git Bash 吃掉空标题（详见上一条），改为 `powershell -Command "Start-Process ..."` 并写明识别特征；新增 `§2.5「真装一遍（静默覆盖安装）」`，记下 `/S` 只在直接执行安装器时有效、静默安装不会自动拉起应用、以及「读 `resources/app/package.json` 的版本号 + mtime」来确认到底装没装（`resources/app` 就是 `extraResources` 里的 `cli/app`，版本号 == 盖的测试号）。`§2.1` 改为「先选路」并补上全新 clone 的依赖步骤、`--win nsis --x64` 的省时写法与本地构建必然未签名的说明；`§5` 误判对照补 3 行；示例版本号统一为当前合法的 `1.1.1-test.N`（`v1.1.0` 发版后，文档里原有的 `1.1.0-test.1` 会被脚本直接拒绝）。

## v1.1.0 (2026-09-11)

### ✨ 新功能

- **`xiaomi-mimo` 换成桌面客户端的 mono 图标，与「MiMo Code Free」区分**：该 provider 现在同时服务云端 API 与桌面版（Preview 模型），而它的旧图标是小米橙 `#FF6900` 标——和 `mimo-free`（display name 就是 “MiMo Code Free”）的 `#ff6600` 橙标在卡片列表里几乎一样，容易认错。新图标改用小米 MiMo 桌面客户端自己的图标（从官方安装包提取，黑底 `#000000` + 米白 `#ffffee`），**饱和像素从 84% 降到 0.2%**，一眼就能和橙区分开；顺带从压白底、无 alpha 的 128px RGB 换成带 alpha 的 RGBA（文件反而从 6.3K 降到 2.7K）。设计 A 下 provider 图标槽位只有 `public/providers/xiaomi-mimo.png` 一个（`ProviderIcon` → `/providers/{规范 id}.png`），上游拆分版的 `public/providers/xiaomi-desktop.png` 在合并版里没有任何解析路径，所以**不**入库；提取出来的多分辨率 ICO 作为源文件存 `assets/providers/xiaomi-desktop.ico`。守卫用例锁死槽位为规范 id、尺寸 128×128、带 alpha，且不得与 `mimo-free.png` 是同一份资源。
- **新增小米 MiMo Desktop 支持（双认证，设计 A：折进既有 `xiaomi-mimo` provider）**：同一个 provider 现在既支持 sk- API 键（云 API `api.xiaomimimo.com`），也支持 Desktop 账号（同一云主机 + Desktop 独占的 `mimo-x-pro-preview` / `mimo-x-flash-preview`，由账号服务的 `/api/route` 提供、用账号会话 cookie 鉴权而不是键），auth 模式与 `kimi` 同款（`authModes: ["oauth","apikey"]`、`hasOAuth`、`features.usage/usageApikey`），别名增加 `mimo-desktop` / `xmd`。Desktop 独占模型在 executor 里按模型选端点（`upstreamModelId: xiaomi/<id>`、`supportedFormats: ["openai"]` 钉住 openai 传输），云模型完全走默认逻辑，所以 Claude 客户端仍命中 `/anthropic/v1/messages`；Preview 的 `transformRequest` 只补默认值（thinking/temperature/top_p/max_tokens）而不覆盖调用方显式传入的值，并按 `paramSupport.js` 的新规则把 content-part 数组拍平成字符串（账号服务不收部件数组；`mimo-v2-omni` 这类云多模态模型不受影响）。授权链路是**非标准 OAuth2**：浏览器打开 `platform.xiaomimimo.com/authorize?pk=<X25519 公钥>&redirect_uri=...&kn=mimocode`，回调把 `{uid, sk, url}` 用 `ECDH(SHA256) + AES-256-GCM` 加密后放在 `u` 参数里（`[12B nonce][32B 临时公钥][密文][16B tag]`），本地 `127.0.0.1` 临时端口解密后落库。周配额走账号服务（`mimo-server /api/user/usage`）：用 Desktop 的 `passToken` 经 passportapi SSO → mimopc 授权 → `/api/sts` 换 `serviceToken` cookie（30 分钟缓存 + 同账号并发去重，任何失败都降级返回 null 而不抛）。凭据导入两条路：`POST /api/oauth/xiaomi-mimo/api-key`（格式校验 + 对 `/models` 软校验，网络不通也允许导入，按 uid 或同键去重更新）与 `GET /api/oauth/xiaomi-mimo/auto-import`（读本地 `~/.local/share/mimocode/auth.json`），配套新增 `XiaomiMimoAuthModal`（自动检测 → 一键导入 → 找不到则回退浏览器登录）并接到 provider 页的 OAuth 入口。测试 4 个文件 71 例：解密全路径**无需任何凭据**（测试侧实现加密端做完整 ECDH 往返）、代理的 403/400/500 与跨域拒绝、账号层用真实 `node:sqlite` 造假 cookie 库、executor 端点与鉴权选择、路由/接线源码守卫。
- **opencode-go 静态种子按官方公开目录补齐 18 个模型，并为每个模型声明端点**：以前种子只有 19 条，而 `GET https://opencode.ai/zen/go/v1/models`（**无需鉴权**，官方文档称之为 "the full list of available models"）返回 **37 条**——缺 18 条、且我们这 19 条没有一条是下架残留。现在种子对齐 37 条，并按 `https://opencode.ai/docs/go/` 的端点表给每条声明 `supportedFormats`：**这个声明才是关键** —— chatCore 只在「模型声明了该 sourceFormat」时才用同格式传输，未声明就退化成 sourceFormat 匹配（一个 claude 格式的请求会被送到 `/messages`，而 glm/kimi 这类只服务 `/chat/completions` 的 id 会直接失败）。分组：`/v1/responses` 独占 5 条（`grok-4.6`、`gpt-5.6-luna`、`muse-spark-1.3/1.2-contributor`、`grok-4.5`，声明 `targetFormat: "openai-responses"` 以强制翻译）、`/chat/completions` 独占 17 条（glm/kimi/longcat/mimo/hy 家族）、双端点 9 条（minimax/qwen）、DeepSeek 5 条维持既有三端点声明。端点表未覆盖的 9 条（models.dev 将其中的 `kimi-k2.5`/`glm-5`/`qwen3.5-plus`/`mimo-v2-pro`/`mimo-v2-omni`/`grok-4.5`/`omen-alpha` 标为 deprecated）按**家族端点**继承；其中 `omen-alpha` 无家族也无第一方规格，**故意不声明**（openai 客户端仍会落到与显式 `["openai"]` 相同的 `/chat/completions`，而 claude/responses 客户端保留自己的端点而不被导向未验证的地方），并作为 `codename` 进能力审计白名单（floor 20 → 21，`--check` 仍绿）。补两条 canonical 行：`muse-spark-1.3-contributor`（meta 第一方 1048576/131072，与 `-1.2-contributor` 同值）与 `longcat-2.0`（**小写**：canonical 查表区分大小写，既有的 `LongCat-2.0` 行匹配不到 opencode-go 的目录 id；values 同第一方，且 models.dev 的 opencode-go 条目一致）。`tests/unit/opencode-go-models.test.js` 扩到 11 例：id 集合对齐公开目录、无重复 id、**“除明确不声明那条外每个模型都有端点声明”**、四组声明的逐条断言，以及 chatCore 传输守则的镜像断言（responses-only 组在 openai/claude 下必须为 null 且 `targetFormat` 为 `openai-responses`）。
- **新增 Codex / OpenAI 的 `gpt-image-2.5` 图像模型家族**：Codex 侧加入 `gpt-image-2.5`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2`、`gpt-image-1.5`（`kind:"image"`，声明 `["text2img","edit","multiImage"]`），OpenAI 目录镜像 `2.5` 三兄弟。关键不在列表而在**路由形状** —— 这几个是 **tool-backed**：请求仍然打到 Codex 的 responses 模型 `gpt-5.5`，被选中的图像模型改由 `image_generation` 工具携带（`tools[0].model`）、`action` 由“有没有参考图”推成 `generate`/`edit`、`tool_choice` 从 `"auto"` 钉成 `{type:"image_generation"}`、`reasoning` 从 `null` 换成 `{effort:"medium",summary:"auto"}`；旧式 `gpt-5.x-image` 继续走 `stripImageSuffix` 的原始形状（有回归用例守着）。新增 `tests/unit/codex-image-models.test.js` 7 例，含**双向漂移**守卫：handler 里的 `CODEX_TOOL_IMAGE_MODELS` 集合必须与注册表声明 `multiImage` 的 codex 图像模型**完全一致**（解析走 `getModelsByProviderId("codex")` —— 模型表按 registry alias `cx` 挂载，直接用 `getProviderModels("codex")` 会拿到空数组）；`image-generation.test.js` 加 3 例（generate / 带参考图 → edit / 旧式模型保持原形状）。变异验证：handler 集合少一个 id → 恰好漂移用例变红；`if (toolModel)` 改 `if (false)` → 恰好 2 例新用例变红、旧式用例仍绿。`multiImage` 在代码里**无消费者**（纯声明），加它只为与 UI 语义一致。
- **小米 MiMo 授权码登录（浏览器显示授权码时可直接粘贴完成）**：官方授权页在把控制权交回本地回调之前就会把授权码显示出来，于是存在两条合法路径 —— 自动回调（本地 `127.0.0.1` 临时端口，5 分钟超时）与**手动粘贴**。粘贴是一等公民而非兜底：服务端会话（含 X25519 私钥）保留 **24 小时**，所以回调监听器超时后粘贴仍然有效（早期把两者绑在同一超时上，超时即失效，用户看到的是「授权码不对」）。凭据仍只在服务端解密、绝不经过浏览器。配套把模态框接入 i18n（zh-CN / zh-TW），并让所有服务端返回的失败原因（`empty_payload` / `payload_too_short` / `no_pending_session` / `decrypt_failed` / `missing_api_key`）都有对应文案 —— 否则中文界面里会孤零零冒出一句英文；守卫用例锁死「每个服务端消息都必须有 locale 条目」。
- **积分倍率徽章支持限时免费促销（会自己过期）**：CodeBuddy 国际版给 `deepseek-v4.1-flash` 做了两周限时免费，但徽章原本只有「倍率」一个维度，而 `rateMultiplier: 0` 的语义是「永久走免费额度」—— 真按 0 写，促销结束后会一直宣称免费，并破坏「CN 与 intl 同一 id 倍率必须相等」这条不变量。现在把「付费倍率」与「促销窗口」拆成两个事实：新增 `promoFreeUntil`（ISO 日期，UTC），窗口内徽章显示绿色 `free`、tooltip 写明「积分倍率: 0.03x — 限时免费至 2026-09-24」，过了当天零点自动回落到 `0.03x`，不需要有人记得改回来，倍率本身保持公布值不动。判定逻辑抽成可单测的纯函数（`src/shared/utils/promoFree.js`），日期不可解析时按「无促销」处理而不是「永久免费」。
- **CodeBuddy 国际版目录补齐（含一个后经修正的估算倍率）**：国际版网关是 OpenAI 直通，未登记的 id 可以**用真实请求探**，于是拿它逐个核对了线上到底服务什么 —— 补进 5 个真实存在却缺失的模型（`glm-5.1` / `glm-5v-turbo` / `minimax-m3` / `kimi-k2.7` / `deepseek-v4.1-flash`，倍率沿用 CN 同一套积分表），以及 `gpt-6-astra`（`gpt-6` / `gpt-6.0` / 各种 `-astra-*` 变体全是 11102，只有它答 200）。它是全表**唯一没有官方倍率**的一行：仓库、`~/.codebuddy`、官网定价页都取不到数，因此按 OpenCode Go 价目表用**比值法**估算 —— 该表里 Astra 在四列（输入/输出/缓存读/缓存写）与两个档位上都恰好是 Sol 的 5 倍，而 Sol 的 3.47 是公布值，得 **17.35**（⚠️ **该值后经实测修正为 `6.67`，见 v1.1.1**）；注释里写明这是预估值与推算链，测试锁的是推算关系而不是魔数。另记下 `kimi-k2.5` 虽答 200 但**故意不收**（不在公布积分表里，CN 同理）。

### 🐛 修复

- **修复 Windows 桌面版升级时静默丢弃旧数据（`9router` → `10router` 迁移被永久跳过）**：迁移的判据是「目标目录非空 = 已有数据」，但在 Windows 桌面版上这个前提不成立 —— 数据目录 `%APPDATA%/10router` **同时就是 Electron 自己的 userData 配置目录**（`desktop/package.json` 的 `productName = "10Router"`，Windows 大小写不敏感，与 `defaultDir()` 拼出的路径是同一个目录），`Cache/`、`GPUCache/`、`Local State`、`DIPS` 这些 Chromium 文件会在我们写入任何东西之前就把它撑成非空，于是 `readdirSync(next).length > 0` 恒为真、迁移**永远不执行**，也不留任何日志。判据改为「目录里是否已经有我们自己的状态」：`db/data.sqlite`，或 pre-SQLite 时期的 `db.json` / `usage.json` / `disabledModels.json` / `request-details.json`。顺带堵住同类风险：`cpSync` 加 `force: false`，目标目录里已有一个已生成、且已被系统/浏览器信任的 `mitm/rootCA.key` 时，旧库里的同名文件不再覆盖它（覆盖会让 TLS 拦截静默失效）。这份逻辑有两份互为镜像的实现（ESM 的 `src/lib/dataDir.js` 与 CJS 的 `src/mitm/paths.js`，后者跑在纯 Node 下不能同步 require ESM，所以只能镜像），新用例对**两者各跑一遍**共 10 例，并把 `db.json` 同样钉为「已有数据」、把「不得覆盖已属我们自己的文件」也锁住；变异验证：把守卫改回旧写法会让 4 个用例转红。另把旧版 JSON 文件名清单收敛到 `dataDir.js` 的单一来源（`db/paths.js` 的 `LEGACY_FILES` 由它派生），避免两处清单各改一半。
- **修掉移植过程中查出的两个真问题（都在小米 MiMo 这条链上）**：一是读 MiMo Desktop 的 cookie 库时，往 `os.tmpdir()` 拷的临时副本**会被留在共享临时目录里** —— `new DatabaseSync(...)` 或 `prepare()` 抛错时跳过了 `db.close()`，Windows 上仍开着句柄的文件删不掉，而 `finally` 里的 `unlinkSync` 又包在 `catch { /* ignore */ }` 里，于是失败是**静默**的（实测每跑一次就多一个 21 字节、权限 `-rw-r--r--` 的副本，里面是账号 cookie）。现在句柄在嵌套 `finally` 里必关，删除改成带重试的 `unlinkQuietly`（`ENOENT` 直接返回），副本本身也收紧为 `0o600`；用例直接扫 `os.tmpdir()` 断言**不留副本**（当前残留数 0）。二是接 `poll-status` 时把通用分支的“done 就清会话”照抄了过来，而小米这条链的凭据**只存在服务端会话里**（不像 codex/xai 那样由客户端拿 code 去 exchange），清早了紧接的 `/exchange` 必然拿不到会话——已改成 done 分支保留、由 `exchange` 用完再清，并加用例锁住（只允许 error 分支清）。
- **opencode-go 的 `gpt-5.6-luna` 从 `/chat/completions` 改为 `/v1/responses`**：此前我们把它声明为 `["openai"]`，注释称 "Claude/Responses transports are not valid for this model"——但那句**没有任何来源**（是 `686b1217` 那次目录重构时写下的），而官方端点表写的是 `gpt-5.6-luna → https://opencode.ai/zen/go/v1/responses`，上游 v0.5.75 的同一模型也改成 responses-only。取 responses-only 也是**风险更小**的一侧：即使它所服务的是两端点，其他格式的客户端经翻译后仍能成功；反之若它只能走 responses，声明 `["openai"]` 会让所有客户端都打空。
- **opencode-go 目录里的能力数值/多模态按第一方重建（15 条 canonical 行）**：A8a 把种子对齐公开目录后，这批 id 的能力仍落在**跨供应商共享的通配兜底**上，多处与第一方（models.dev 的 zai / alibaba / xiaomi / tencent-tokenhub / xai / openai / moonshotai 条目）不符：`glm-5.3`/`glm-5.2` 的窗口被 `*glm-5*` 写成 200000（真值 **1M**）；`glm-5`/`glm-5.1` 输出上限 128000 → 131072；`qwen3.8-max`/`qwen3.8-flash` **缺视觉**且少算了输出（真值 1M/131072，`-max` 还带 pdf）；`mimo-v2-pro`/`mimo-v2.5-pro` 被 `*mimo*` 系列**误标 vision**（第一方是纯文本——误标会让图片绕过 modality 剥离直接打到上游）；`mimo-v2-omni` 缺 video/pdf；`hy3`/`hy3-preview` 落在 `hy3*` 的 262144/262144（**输出上限等于窗口**，无来源；真值 256000/128000 与 256000/64000）；`grok-4.5` 输出被写成 64000（xai 真值 500000，与 `grok-4.6` 同）；`gpt-5.6-luna` 窗口被 `*gpt-5*` 写成 400000（openai 真值 1050000；codex/kiro 各有 provider 行，不受影响）。全部写成**精确 id 的 canonical 行**——通配是共享兜底，改它会波及别的供应商。刻意保留保守值两处（`kimi-k2.7-code` 我们 65536 < 第一方 262144；`hy4-preview` 1000000 < 1024000）；`deepseek-v4-pro`/`deepseek-v4-flash` 的 vision 维持既有决定不动。**一个踩过的坑**：models.dev 的 `attachment` **不是**视觉信号，要看 `modalities.input`——`qwen3.7-plus`/`qwen3.6-plus`/`qwen3.5-plus` 都是 `attachment:false` 但含 `image+video`，用错字段会把三条本来正确的行误改掉。
- **Codex 客户端版本收敛为单一来源，身份头不再漂移（0.136.0 → 0.154.0）**：`codex_cli_rs/<版本>` 原先散在 **4 处 / 3 个值** —— 注册表 transport 的 `User-Agent`、图像处理器的 `user-agent` + `version`、连接测试探针各写 `0.136.0`，而抓模型目录用的 `CODEX_CLIENT_VERSION` 却是 `0.144.6`（请求自称的身份版本与查询用的 client_version 是两套值）。现在统一到 `open-sse/providers/registry/codex.js` 的 `CODEX_CLI_VERSION = "0.154.0"`（放在 `transport.cliVersion`，`buildTransport` 会展开到顶层），`open-sse/config/appConstants.js` 照 `GEMINI_CLI_VERSION` 既有范式再导出 `CODEX_CLI_VERSION`，上述三处身份头全部由它派生。`src/app/api/providers/[id]/models/route.js` 的 `CODEX_CLIENT_VERSION = "0.144.6"` **刻意保持独立** —— 那是 `/codex/models?client_version=` 查询参数，后端按 `minimal_client_version` 过滤目录条目，与身份声明不是一回事。顺带把 `tests/__baseline__/providers-baseline.json` 重新快照：它自 `a1447253`（给 minimax/minimax-cn 的 `quirks` 加 `requireClaudeToolType`）起就没重建过；门禁会丢弃 `cliVersion`（`ADDED_FIELDS`）与 `quirks`，所以这份陈旧一直不可见，但已提交的快照现在与 `PROVIDERS` 一致。新增 `tests/unit/codex-cli-version.test.js` 6 例（顶层派生、注册表头、图像处理器 `buildHeaders` 实测、连接测试探针、**源码文本 tripwire** 禁止任何 `codex_cli_rs/<semver>` 字面量、models 路由的 client_version 保持独立），并把 `image-generation.test.js` 的断言从字面量改成 `PROVIDERS.codex.cliVersion`，以后再改版本不会重演「测试跟着漂」。⚠️ 身份版本是纯客户端自称，后端是否按它放行新特性**需活体账号验证**（离线不可判），但它从来不是我们请求能否通过的条件。
- **Codex 工具 schema 里 Codex 不认的 `\p{...}` 正则改为剥离（#3922）**：`chatgpt.com/backend-api/codex/responses` 用来校验 function tool `parameters` 的正则引擎**不支持 Unicode property escape**，只要某个 `pattern` 写了 `\p{Cc}` 这类属性转义，整个请求就被判为 `400 Invalid schema for function 'X': '...' is not a 'regex'`——这是**确定性**的 payload 错误，每个账号都同样失败，combo 因此白付一整轮 failover。新增 `open-sse/utils/codexToolSchema.js`：copy-on-write 遍历 schema，**只删**真正含属性转义的 `pattern` 值，其余节点按引用透传（未改动时返回原引用，换供应商重试时 schema 完好）；反斜杠**奇偶计数**保证 `\\p{Cc}` 这种字面量不被误伤；`properties` 的 key 按属性名处理，字段名恰好叫 `pattern` 时不会被当关键字删掉。接线在 `executors/codex.js` 的 `normalizeCodexTools()`：function 与 namespace 子工具的 `parameters` 都会过一遍，剥离条数走 `dbg`。**刻意不做全局 sanitizer** —— 只作用于 codex 派发路径、只删真含 `\p{...}` 的值，支持该写法的供应商约束保持逐字节不变。新增 `tests/unit/codex-tool-schema-pattern.test.js` 13 例（属性转义识别含 `\\p` 字面量与三反斜杠反例、按引用透传、数组/嵌套、属性名守卫、四种 tool 形状端到端），已做变异验证：把奇偶判定换成朴素正则 → 恰好 1 例变红；去掉 `properties` 特例 → 恰好 1 例变红。
- **Kiro 不再携带顶层 `systemPrompt`（kiro.dev 视为 400 `REQUEST_BODY_INVALID`），端点排序改为 Amazon 面优先**：kiro.dev 网关对**任何**带顶层 `systemPrompt` 的请求体直接回 `400 {"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}`，而 400 在 `BaseExecutor` 里是**终态**（不换端点重试）。系统提示的正确位置是首个 user turn 的 content——翻译器早已用 `contentPrefix` 折进去，但我们代码里还有两条路把它写回顶层：① `rtk/systemInject.js` 的注入器**没有 kiro 分支**（caveman / ponytail 的指令落到 OpenAI 形状的兜底分支，对 kiro 体等于无操作、提示被静默丢弃）；② `executors/kiro.js` 的 `appendRepairInstruction()` 把工具调用修复指令拼到 `repaired.systemPrompt`，**每一次修复重试都必然变成硬失败**。本次三处一起收口：`appendRepairInstruction` 改写进 `conversationState.currentMessage.userInputMessage.content`；注入器新增 `case FORMATS.KIRO` → `injectKiroSystem()`，按“首个 history user turn，无 history 则 currentMessage”写入并做 SEP 分段幂等（重试、两个注入器叠加都不会重复追加）；两个直连翻译器移除顶层 `systemPrompt` 与 `agentMode: "vibe"`、以及 `conversationState.agentContinuationId`/`agentTaskType`——后两者同属被删旧字段，`systemPrompt` 局部量现在只作为会话回放的**缓存键**（`kiroSessionReplay` 从不上线写入）。
  同时按上游 #3776 把 Kiro 端点排序改成**所有认证方式都先走 Amazon 面**：runtime.*.kiro.dev 的 path 式 `GenerateAssistantResponse` 已被弃用、对现代 payload 回终态 400（于是永远轮不到可用端点），而 Amazon 面拒绝外来 token 用的是 401/403（会继续 fallthrough），所以 `q.*`/`codewhisperer.*` 优先对每种 authMethod 都安全；并补齐当前 runtime 面所需的头：`x-amz-sso-bearer`（取 accessToken）、`x-amzn-kiro-agent-mode: spec`、`x-amzn-codewhisperer-machine-id: kiro-desktop`，以及仅有档案时才有 `x-amzn-codewhisperer-profile-arn`。上游那段改动留下了过时 JSDoc 与已无引用的 `authMethod` 局部量，这里按本仓风格重写说明并去掉死变量。
  测试：新增 `tests/unit/kiro-minimal-wire-payload.test.js`（两个翻译器都不得出现 `systemPrompt`/`agentMode`/`agentContinuationId`/`agentTaskType`，且系统文本确实落在首个 user turn）与 `tests/unit/rtk-kiro-system-inject.test.js`（首 history turn 优先、无 history 落 currentMessage、幂等、非 kiro 形状 no-op、冻结体 fail-open、不得写顶层字段）；既有测试里读 `result.systemPrompt` 的辅助函数改为从首个 user turn 的 content 读回系统文本（并剔除同段的 `[Context: Current time is …]` 以还原旧语义），两个“跨轮稳定”用例改为共享 session（无凭据时每次调用是独立临时会话，跨轮比较无意义），端点顺序断言按新事实更新为 Q 优先。
- **Claude 工具 `type` 默认化改为按供应商开关（#3905）**：我们此前的 `openai→claude` 翻译输的是 Anthropic 传统的**无 `type`** 工具形状，而严格网关要求显式 `type`——MiniMax 的 Claude 端会以错误 2013 拒绝无 `type` 的 tools，这些请求此前直接失败。上游曾用“全局给每个 Claude 格式请求盖 `type: "custom"`”解决，但那又把另一类端点打挂了：DeepSeek 的 `/anthropic/v1/messages` 把工具 `type` 白名单限在自家 `web_search_*` 变体上，收到 `custom` 直接 **400 `unknown variant \`custom\``**，客户端看到的是持续 503。现在改成**按供应商声明的 `requireClaudeToolType` quirk** 决定：`shouldDefaultClaudeToolType(provider, finalFormat, tools, PROVIDERS)` 成为唯一判定点（可单测），MiniMax / MiniMax-CN 两行注册表各加一个 quirk 即可，其余 Claude 格式端点（anthropic / claude / deepseek / glm / kimi / opencode-go / xiaomi-*）维持无 `type`。注意我们注册表里 **DeepSeek 确实挂着该 Claude 传输**，所以这不是理论风险。新增 `tests/translator/bugs-3905-claude-tool-type.test.js` 11 例：门禁矩阵（含遍历注册表断言“只有 minimax/minimax-cn 声明 quirk”）、DeepSeek Claude 传输存在的锚定断言、`defaultClaudeToolType` 语义（只补缺失/falsy 值、放过 `computer_20250124`/`bash_20250124`/`web_search_20250305` 等内置型、不改写入参）、以及 chatCore 接线的源码级tripwire。已做变异验证：恢复“无条件盖章”并拿掉 quirk，4 例如期变红。
- **CodeBuddy CN 的 DeepSeek-V4.1-Flash 输出上限回落到服务端公布的 128K**：v1.0.8 里按 DeepSeek 模型卡写成了 384000，但 `maxOutput` 在 `claude.js` 的 `adjustMaxTokens` 里是**真实夹取上限**——对这条通道而言，合同是 CN 网关自己的 product-config payload，其 `maxOutputTokens` 报的是 **128000**（上游同段其余行本就是照服务端抄的：`glm-5.3` 48000、`minimax-m3` 128000）。取大不会报错，只会把超过服务端上限的 `max_tokens` 原样放行，属于“看起来更宽松、实际更容易撞上游 400”的失真，故按既有“证据冲突取保守值”回落。canonical `deepseek-v4.1-flash` 行仍是 384K（直连第一方 / 别家转售的同一 id 用它），只有 provider 行优先的 CN 通道是 128K；`tests/unit/codebuddy-cn-models.test.js` 断言与注释同步。
- **AMD Token Factory 模型目录与能力按实测重建**：免费共享端点上线后目录已变，而我们只静态登记了 2 个模型且能力表有两处与端点实际行为不符。对着 `GET /v1/models` 与 AMD 各模型页（2026-09-09 修订）逐项核对，并用真实 key 打端点实测：① 补上漏登的两个聊天模型 —— `DeepSeek-V4-Flash-Vision-Exp` 与 `MiniCPM5-2B`（`MinerU2.5-Pro` 故意不登：OCR 专用、按页计费、不接受聊天请求）；② **`Qwen3.8-Flash-Next` 修掉“纯文本”误判** —— AMD 模型页写的是「文本 + 图像」，实测发图返回 `prompt_tokens_details.image_tokens: 228` 且准确描述了测试图，而原能力行没有 `vision`，图片会在 modality 门控处被静默丢弃；③ **它也不再是“不可关思考”** —— 原注释依据旧文档写「仅收 low/medium、不可关闭」，新文档列的是 `none|low|medium|xhigh`，实测 `none` 返回 200 且 `reasoning_tokens: 0`（同一模型 `xhigh` 为 14），故改为 `thinkingCanDisable: true`；④ `thinkingLevels.js` 同步：Qwen 档位补上 `none`/`xhigh`，DeepSeek 的 pattern 由 `DeepSeek-V4-Flash` 改为 `DeepSeek-V4-Flash*` —— 该 pattern 是锚定匹配（`^…$`），不加通配符时新登的 Vision-Exp 会落到 openai 默认档位而丢掉 `max`；实测 Vision-Exp 传 `high` 返回 200，确认它与 `DeepSeek-V4-Flash` 同一套七档。另：`DeepSeek-V4-Flash-Vision-Exp` 全大写 id 与 canonical 表的小写 id 大小写不同（能力查找大小写敏感），若没有 provider 行它会落到 `*deepseek-v4*` 通配上重新变成 `vision:false`，故 provider 行即该 id 的守卫。新增 `tests/unit/amd-models.test.js`（目录精确列表 + OCR 项不得出现 + vision 归属 + Vision-Exp 必须命中 provider 行而非通配 + 档位集合 + MiniCPM5-2B 无思考档），并把 `deepseek-v4-capabilities.test.js` 里“所有 `-vision-exp` 都必须解析出 1M/384000”这一过强断言收敛为“必须 `vision:true`”+ 单独校验 canonical 数值（转售方可以合理覆盖为更保守值，AMD 就是）。
- **Node 24 上跳过 better-sqlite3 适配器（进程级崩溃修复）**：`better-sqlite3` 的原生插件在 Node ≥ 24 上加载即 SIGSEGV——这是 try/catch 兜不住的进程级崩溃，用户会看到整个服务直接死掉。现在在 `tryBetterSqlite()` 里先按 `process.versions.node` 主版本号判断，≥ 24 直接跳过该适配器，落到内建的 `node:sqlite`（或更后面的 sql.js 兜底）。新增回归用例锁住这一点：断言适配器工厂**一次都没被调用**（只断言“回退成功”是不够的——没有版本判断时 import 照样发生、只是被 catch 接住了）。

- **小米 MiMo 授权码解密失败的真因是「载荷布局前后颠倒」**：一段时间的 `decrypt_failed` 不是密钥或算法问题，而是把官方 `ephemeralPub(32) + nonce(12) + ciphertext + tag(16)` 的顺序写反了。**为何测试没抓到**：测试助手自己加密时用了同一个错误假设，于是「自加密 → 自解密」永远绿，真实载荷 100% 失败 —— 教训是**测试助手必须对齐对端实现，而不是对齐我们自己的解码器**，已写进文档。同时按官方客户端补齐协议细节：`app=MiMo` 必填（平台按它签发授权码）、回调路径改为随机 `/callback/<32 位 hex>`（这串随机路径本身就是防 CSRF 的能力，故去掉原先的 loopback-Origin 校验 —— 平台的 https 页面是合法的跨域调用方）、结果以 **302** 跳回平台自己的 `/authorize/callback` 而不是自渲染 HTML、`pk` 与载荷统一 `base64url`。另修：`stopXiaomiMimoProxy()` 只该停「监听」，不能连待用的 X25519 私钥一起清掉（否则自动回调一结束，粘贴立刻失败）；并把 `payload_too_short`（< 60 字符 = 粘贴不全）与 `decrypt_failed` 区分开。
- **小米 MiMo 凭据路径按平台解析**：Desktop 客户端的 `userData` 与 `auth.json` 在 win32 / darwin / linux 各不相同（`%APPDATA%/Xiaomi MiMo`、`~/Library/Application Support/Xiaomi MiMo`、`$XDG_CONFIG_HOME|~/.config/Xiaomi MiMo`；cookie 库在 `<userData>/Partitions/xiaomi-account/Network/Cookies`；`auth.json` 走 `$XDG_DATA_HOME/mimocode/auth.json` → `~/.local/share/mimocode/auth.json`，macOS 同理）。读 cookie 库必须**先复制再读**（桌面运行时持独占锁），遇 `EBUSY`/`EPERM`/`EACCES` 返回**类型化的 `DESKTOP_LOCKED`** 而非笼统失败；用量/配额这类路径必须**降级返回 null 而不抛**，且**导入流程遇到锁库绝不能失败**（锁只影响自动导入这条支路，粘贴授权码那条不受影响）。
- **模型禁用列表统一键名（同一供应商不再存两份互相矛盾的记录）**：仪表盘读写用的是 `getProviderAlias()`（= `uiAlias || alias || id`），而首次连接时的默认禁用用的是 `PROVIDER_ID_TO_ALIAS`，两者对 `xiaomi-mimo`（`uiAlias = "mimo"`）给出不同键，于是同一个 provider 在 `kv.disabledModels` 里存了 `xiaomi-mimo` 与 `mimo` 两份、各自还带着不同的禁用集合 —— 表现为「有些模型没被禁用」。现在统一到单一规范键，且**合并时以规范行为准**（它承载用户最新的界面意图），旧键只在没有规范行时兜底；守卫用例锁死规范键取值与「不再出现双份」。
- **删掉 `XIAOMI_MIMO_CONFIG.callbackPath` 死配置**：值为 `"/"`、全仓零引用，且与真实的随机回调路径矛盾 —— 写技术文档时才发现，留着只会误导下一个人。

### 📄 文档

- **小米 MiMo 桌面版适配技术文档**（`docs/zh-CN/xiaomi-mimo-desktop.md`，7 节）：为什么是设计 A（折进既有 `xiaomi-mimo` 做双认证）、各平台凭据路径与两条读取规则、授权码流程（含与官方客户端逐字节对齐的协议细节与 6 个端点契约）、模型/端点选择、自动导入的降级要求，以及 **7 个坑的真因复盘**（缺 `app=MiMo`、`pk` 用标准 base64 而非 base64url、**载荷布局颠倒**、回调 Origin 校验方向反了、`stopXiaomiMimoProxy` 清了待用密钥、自渲染 HTML 而非 302、死配置 `callbackPath`）。
- **本地测试构建与验证流程**（`docs/zh-CN/local-build-and-verify.md`）：Windows 桌面版与 fnOS fpk 共用一条流程（构建 → 就地替换 → 验证），以及**不入库的 `X.Y.Z-test.N` 测试版本号**方案（三处 `package.json` + fnos manifest 同号；`--check` / `--revert`；绝不用已发布的版本号重构建 —— 那正是 1.0.8 出现「同一版本号三份不同产物」的成因）。CLAUDE.md 已指向该文档，并写明 `ELECTRON_RUN_AS_NODE=1` 这个坑（会让 `10Router.exe` 退化成纯 Node 进程，看起来像构建坏了）。
- **CodeBuddy 错误码补 `11134`**：`the model provider is temporarily unavailable`（500）。判据写清了：`11102`（400，model service info not found）= 上游不认这个 id（该删）；`11134` = 上游**认**这个 id、只是暂时不服务（**别删**，等它自报的 reset）。这是重建桌面版后实测 `gpt-6-astra` 才发现的 —— 同一个 id 早前还答 200。
- **项目文档整理**：根目录 5 份评审/交接稿按「耐久参考 / 已被取代」分类 —— 3 份归位 `docs/zh-CN/`（1.0.9 范围评审更名为 `release-review-v1.1.0.md` 并加归档说明、上游 v0.5.75 分诊、MiMo 模型四方对比），2 份一次性交接稿删除；`docs/README.md` 补进 8 份此前未入索引的文档。

## v1.0.8 (2026-09-09)

### ✨ 新增功能

- **新增 AMD Token Factory 供应商（免费档，与 NVIDIA NIM 同形态）**：AMD Radeon Cloud 的免费共享 OpenAI 兼容端点（`developer.amd.com.cn/radeon/api/v1`，Bearer `rc-…` key 在 Token Factory 页自动签发），上线两个实验模型——`DeepSeek-V4-Flash`（1M 原生上下文，默认不思考，reasoning_effort 六档全收）与 `Qwen3.8-Flash-Next`（262K 上下文，默认思考且不可关，仅收 low/medium，high→400、其余→422）；registry/capabilities/thinkingLevels 三处按上游文档逐项对齐（纯文本、tool calling 支持但无并行、json_object 可用 json_schema 不可、原生 thinking 字段 400 须走 reasoning_effort），DefaultExecutor 直接承接无需专属 executor；免费额度：每 key 30 RPM / 每账户 20 RPM / 并发 8。providers/alias 两份基线快照刻意重建（差异仅 `+amd`），OAuth 基线不变，全量回归零新增失败。
- **CodeBuddy 静态模型目录对齐服务端（CN + 国际版）**：国际版（codebuddy.ai）按服务端目录重排——新增 Hy4-Preview / Hy3（走免费额度）、GPT-5.6 Sol/Terra/Luna、GPT-5.5、GPT-5.4、GPT-5.3-Codex、Gemini-3.5-Flash、GLM-5.3、Kimi-K3，移除已下线的 GLM-5.1/5.0、GLM-5v-Turbo、MiniMax-M3、Kimi-K2.7/K2.5；CN 站（copilot.tencent.com）按服务端信用页清单对齐——`DeepSeek-V4.1-Flash`（旗舰，1M 上下文、原生多模态）取代 `DeepSeek-V4-Flash`，清掉重复槽位 `Kimi-K3 (1)`（连带修好一处错挂：`capabilities.js` 此前只有 `kimi-k3-1` 的元数据、真身 `kimi-k3` 一直 fallback 到默认 200K，现已挂到正确 id），两站各模型补上服务端公布的 `rateMultiplier` 积分倍率（0 = 走免费额度；CN 与国际版共用同一套积分体系，重叠模型倍率一致）。测试：新建 `tests/unit/codebuddy-cn-models.test.js`（全量精确列表 + 逐模型倍率 + CN/intl 倍率一致性 + intl-only 家族不得出现 + 已废 id 不得回归），`codebuddy-intl-models.test.js` 断言由子集匹配改为全量精确列表。
- **模型积分倍率徽章**：仪表盘模型列表直接标出服务端公布的积分倍率——走免费额度的显示绿色 `free` 标签（小写、各语言均不本地化），其余显示 `0.79x` 形式的等宽小标签，hover 显示「积分倍率」说明（`0` 额外注明走免费额度）。`/api/providers/[id]/models` 早已透传 `rateMultiplier`，但此前**无任何组件消费它**、倍率在 UI 上完全不可见；本次在 `ModelRow` 补上。供应商未声明该字段时不渲染任何标签，因此只有 codebuddy-cn / codebuddy-intl / kiro 这类积分计费供应商会看到。

### 🔒 安全加固

- **API key 生成与 HMAC secret 硬化**（本地审查清单落地，向后兼容）：① `generateKeyId()` 由 `Math.random()` 改 `crypto.randomBytes`——keyId 是密钥材料，不能出自可预测源（新旧格式互通，存量 key 不受影响）；② `API_KEY_SECRET` 硬编码兜底不再静默使用——未设置时启动告警提示；新增**实验功能 Key secret rotation（默认关闭）**：环境变量 `API_KEY_ROTATION=true` 或仪表盘「API Keys → Key secret rotation」开关均可开启，开启后与 `JWT_SECRET` 同契约，自动生成随机 secret 落盘 `$DATA_DIR/api-key-secret`（mode 0600）——因 CRC secret 变化会使存量 API key 失效需重新签发，故**绝不静默迁移**：开关两向切换均弹确认框（明示旧 key 失效不可恢复），开启后仪表盘提供 **Rotate all 一键重签**（逐 key 换发新串、旧 key 停用，弹窗一次性展示全部新 key 供复制）；`API_KEY_SECRET` 环境变量始终优先于实验开关；③ `.env.example` 补两个变量的契约说明，`REQUIRE_API_KEY=false` 死示例删除并注明该变量**运行时不读**（真开关是仪表盘设置 DB 的 `requireApiKey` 行，默认 true），消除部署误导。配套临时验证：生成→解析→CRC 校验闭环、篡改 CRC 必拒、20000 次抽取无 keyId 碰撞、三态解析（默认兜底 / env 优先 / rotation 落盘）与关闭时兜底行为同旧版逐字节一致（验证用例跑完即删，不入库）。
- **登录 500 不再回传内部错误详情**：`/api/auth/login` 的 catch 分支此前把 `error.message` 原样回给客户端（泄漏服务器内部信息），改为服务端 `console.error` 记录、客户端回通用文案。
- **仪表盘危险操作确认弹窗**：Endpoint 页「Require API key」关闭前弹确认（提醒端点将无鉴权裸奔，可随时重开）；secret rotation 开/关两向均弹不可逆警告（明示哪些 key 会失效、需更新所有客户端）。

### 🐛 修复

- **MCP SSE 长连接补注释心跳（issue #9 追加反馈）**：`/api/mcp/[plugin]/sse` 此前无心跳，MCP 会话在工具调用间隙长时间空闲，公网/NAT 部署下会被中间设备会话超时静默掐断（客户端表现为连接仍在但收不到任何事件）；对齐 `/api/usage/stream` 的既有模式补 25 秒一次 `: ping` SSE 注释行（客户端无感），cancel 时清理定时器。其余 SSE 路由均为请求期间持续有事件的短生命周期流，无需心跳。
- **非流式请求（省略 stream 字段）被误判为流式，返回畸形 SSE 响应（issue #4）**：`chatCore.js` 此前 `body.stream !== false` 使省略 `stream` 的请求默认走流式（返回 `text/event-stream` + JSON 尾随 `data: [DONE]`，严格 JSON 解析的客户端全部失败），与 OpenAI/Anthropic 规范（缺省=非流式）相反；Accept 兜底只认显式 `application/json`，SDK/curl 默认的 `*/*` 打不中。改为规范语义的 opt-in 流式：显式 `stream:true`、强制流式源格式（antigravity/gemini/gemini-cli）、或纯 `Accept: text/event-stream`（不含 application/json——两者并列是 OpenAI/Vercel AI SDK 的非流式签名，按 JSON）才流式；forceStream 供应商上游照旧流式、客户端未请求时聚合回 JSON（原 455 行分支，行为不变）。同类实现对照：CLIProxyAPI 仅显式 `stream:true` 流式，OmniRoute `resolveStreamFlag` 对 openai/claude 源格式同为缺省非流式（其 #302/#656/#5305 演化史与本修复同路径）。新增 `tests/unit/stream-default.test.js` 7 例（缺省/`*/*`/显式真假/纯 SSE opt-in/AI SDK 混合签名/显式 false 压过 SSE Accept），全量回归 39 失败全在 41 已知基线内零新增。
- **Antigravity 配额与 CLIProxyAPI/官网数字对不上（用户反馈）**：两处根因一并对齐——① **配额 summary 查错 host**：聊天流量走 `daily-cloudcode-pa`，配额 RPC 却固定查 prod `cloudcode-pa`，两个环境的计数器相互独立，仪表盘数字系统性滞后于账号实际消耗（实测 Gemini weekly 显示 90%、CLIProxyAPI 同时刻为 71%）；`quotaSummaryApiUrl` 改为 `quotaSummaryApiUrls` 列表，按 daily → daily sandbox → prod 依次尝试（2xx 且解析出 `groups[]` 才算命中，防无关信封误判；缓存/并发去重按 URL 分键），与原生 IDE 客户端及 CLIProxyAPI 管理中心同一顺序，某台 host 拒答自动落到下一台，全部不可用仍回退 `fetchAvailableModels` 逐模型解析；② **前端百分比失真**：`ProviderLimitCard` 的 `remainingPercentage` 三元表达式两个分支同值（都在前端从 used/total 重算），后端上报的真实百分比从未生效——改为直接取用；summary RPC 本就只报剩余比例（fraction），合成的 `x / 100` 刻度行不再当请求数展示（`percentScale` 标记贯通 google.js → parseQuotaData → QuotaTable/QuotaProgressBar，计数留空只显示剩余百分比与倒计时）。测试：新增 `antigravity-quota-summary-hosts.test.js` 覆盖 host 回退三场景（daily 命中即停 / daily 拒答逐级回落 prod / 全挂走兜底），既有 headers/weekly-quota/gemini-3.x 断言同步更新，8 套件 35 例全绿。
- **拉取/导入的模型目录默认禁用（用户按需启用）**：对齐静态目录 `a7db4496` 的默认姿态——`Import from /models`（OpenAI/Anthropic 兼容节点）与「Fetch Qoder Models」批量拉取时改为写入 `customModels` 的 `enabled=false`，拉回来的模型先落「Disabled models」区，用户按需激活，避免一次导入上百个模型刷屏。同时把该默认姿态补全成闭环：① `/v1/models` 有连接分支补上 `customModels.enabled===false` 过滤（此前只在零连接分支生效，标了禁用仍会被下发）；② 仪表盘回显与恢复——非兼容节点把禁用的自定义模型并入「Disabled models」区（可单个恢复，`Active All`/`Disable All` 同步覆盖自定义模型），兼容节点（`CompatibleModelsSection`）新增 Disabled 分组与行内激活/禁用开关。Web fetch 单点「Add」（手动添加、suggested 建议芯片）仍保持启用——点击本身即「按需」，只有批量导入才默认禁用。新增 `tests/unit/models-empty-connections.test.js` 三例（零连接 / 有连接 / 孤儿自定义）覆盖三条 `enabled===false` 门控路径，全量回归零新增失败。
- **CodeBuddy CN 误挂国际版 GPT/Gemini 家族（修正）**：同一笔目录改动把 GPT-5.6 Sol/Terra/Luna、GPT-5.5、GPT-5.4、GPT-5.3-Codex、Gemini-3.5-Flash 也写进了 CodeBuddy **CN** 的静态目录——copilot.tencent.com 从未上架这些模型（`capabilities.js` 的 `codebuddy-cn` 段同样没有它们的元数据），选中即 11102 "model service info not found"。已从 CN 移除（仍保留在 codebuddy-intl），并新增 `tests/unit/codebuddy-cn-models.test.js` 守卫：CN 全量精确列表 + 断言 intl-only 家族不出现在 CN。
- **DeepSeek-V4.1-Flash 能力补全（1M / 384K 输出）**：`capabilities.js` 的 `codebuddy-cn` 段此前给它写的是 `maxOutput: 50000`（改名前的旧 id 带过来的值），而 `claude.js` 的 `adjustMaxTokens` 会按 `maxOutput` 夹取 `max_tokens` —— 等于把客户端请求的输出上限白白截掉 7 倍。按模型卡补齐为 1M 上下文 / **384K 最大输出** / 文本+图像输入 / 默认思考但可关（384000 与 `*deepseek-v4*` 通配、B.AI 的 V4 行、以及 CN 表自己的 `deepseek-v4-flash-vision-exp` 行一致）；同时给模型卡列出的两个别名 id（`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`）补齐同一套能力——不写别名行的话，裸的 `deepseek-v4-flash` 会落到通配上丢掉 `vision` 与 openai 思考格式。顺带修掉 `thinkingLevels.js` 注释里已删除的 `kimi-k3-1` 悬空引用。

### 🧹 清理

- **移除已下线的 JSON 模型目录残留**：`686b1217`（v1.0.8）已删除 `modelsJsonUrl` 在线目录机制（`/json-models` 路由 + `providerJsonModelsRepo` + 全局开关 + 仪表盘 UI），本次清掉遗留物——空目录 `src/app/api/providers/[id]/json-models/`、9 个 `providers/*.json` 目录文件及空的 `providers/` 目录、bai/tokenbom/commandcode/longcat/opencode-go 注册表顶部仍写有 "Fetch Models"/`modelsJsonUrl` 的过时注释（改为指向现存机制），以及 `docs/zh-CN/json-model-catalog-mechanism.md` 与其在 `docs/README.md`、`docs/zh-CN/ARCHITECTURE.md` 的索引（文档描述的路由与存储已不存在，`docs/en` 下本就没有该文件——README 的 en 链接原已是死链）。

## v1.0.7 (2026-09-07)

### ✨ 新增功能

- **ZCode 本地用量同步到 10Router（插件 + 导入链路）**：新目录 `zcode-plugin/`（10router-sync@inline）——skill + slash 命令 + manifest，读 ZCode 本地 model_usage 账本（`~/.zcode/cli/db/db.sqlite`，**WAL 活库不原地打开**：先拷贝临时文件快照再读）转 usageHistory 经 `/api/settings/database/import-usage` 导入；自动排除 baseURL 指向 10router 自身的 provider 防双重计数（20127/20128/`/v1` + 本机 host 双条件），`provider_id|logical_request_id` 指纹幂等可重跑；鉴权三通道（登录态免密 / `x-9r-password` 与导出一致 / `Bearer sk-` 虚拟 key 专供插件），仪表盘导入 401 自动回落密码弹窗（登录态无感）；详情 tab 展示导入行——importUsageRows 打 `meta.imported` 标记（去重命中回填，存量重跑即迁移），`getRequestDetails` 合成 imported 行与 requestDetails 按时间戳归并分页（归并分页数学已证明正确：全局 top-K ⊆ 两源局部 top-K 并集），`/api/usage/providers` 下拉联合 usageHistory 导入来源；配套单测 6+4 例。已装本机 ZCode 端到端验证。
- **托盘图标单色化（mac template + win 主题黑白）**：`make_icon.py` 新增 mono 资产（方框描边 + 粗体 10，alpha 即图形）；CLI mac systray2 用 `icon-template.png` + `isTemplateIcon` 随菜单栏深浅自适应（旧彩色版 alpha 是整块填充，开 template 会成实心块，故 darwin 专用）；CLI win 按 `AppsUseLightTheme` 注册表选黑白 ico；桌面壳 darwin `setTemplateImage(16+@2x)` + win `nativeTheme` 跟随切换；三处托盘面缺资产回落彩色品牌图标。
- **桌面托盘版更新链路适配 + 菜单精简**：① sidecar 启动注入 `INSTALL_CHANNEL=desktop`，`/api/version` 对该渠道返回 GitHub Releases 链接（与 fpk 同机制），仪表盘更新横幅对桌面版显示「从 Releases 获取安装包」而非错误的 `npm i -g` 命令/一键更新（桌面版更新 npm 包碰不到内嵌 cli/app，updater 重启也会拉起 CLI 而非 Electron 壳）；② 托盘菜单「启动服务/停止服务」合一为按状态显示的单动作项（菜单 11 项 → 更短），新增「检查更新」（走本地 `/api/version`，发现新版本弹框引导打开 Releases）与「关于 10Router」（版本/数据目录/GitHub 链接）；③ 服务启动成功后静默自动检查一次，仅发现新版本时弹托盘气泡引导（无更新/失败不打扰）。三语词条齐（en/zh-CN/zh-TW）。增量更新（blockmap 差量下载）评估：electron-builder 已产 `.blockmap`，但 electron-updater 差量更新要求应用代码签名（当前构建无证书、signing skipped），留待有签名证书后接入。
- **CodeBuddy CN 内置「总积分」配额聚合行**：用量页 CodeBuddy CN 卡片第一行新增 Total Points（总积分/總積分，i18n 词条化）——汇总全部包的实时余额（月包取 Cycle 字段、赠送包取生命周期 Capacity 字段，与逐包行同口径），置于每月行之前免用户自行加总；`resetAt` 置空（聚合无单一周期，不渲染误导性倒计时）；used/total 直读使其与「只看有余额」筛选天然联动（总余额耗尽自动隐藏、有余额常显）；精确串求和防浮点漂移（0.1+0.2 显示 0.3）。顺带补齐 `Bonus Pack N` 行的 i18n（精确匹配打不中带序号的名字，显示层拆「基础名 + 序号」翻译，赠送包 N/贈送包 N，隐藏 chips 同步接上）。
- **上游 9router v0.5.69 择优移植·第一批**（`2adcd9c4`，按「重实现不合并」惯例）：① **antigravity/gemini-cli 多账号后台刷新防风控**——OAuth 后台刷新由 `Promise.allSettled` 并行改为串行 + 分级抖动（Google 系 12s、常规 1.5s，`BG_REFRESH_GOOGLE_DELAY_MS`/`BG_REFRESH_DELAY_MS` 可调），onboard 重试 5×2s → 2×12s+抖动（`ONBOARD_MAX_ATTEMPTS`/`ONBOARD_RETRY_DELAY_MS`），多账号用户不再触发 Google 反滥用风控；② **anthropic-compatible-* 前置真 Claude 补发 beta flag**——自定义节点挂真 Claude 时补 `context-management-2025-06-27` 等头，修 `context_management: Extra inputs are not permitted` 400 静默换模型（按模型 id 门控，前置 Kimi/GLM 的节点不受扰）；③ **opencode-go 稳定 session**——新专属 executor 维护 `x-opencode-session`（原生头优先 → 按「会话+客户端工具」确定性翻译），免费池不再因每请求随机会话触发风控；④ **Responses 并行工具调用修复**——`output_item.added` 即分配 index 并按 item_id 路由 delta，修全 added-后-delta 乱序把 N 个并行调用并进 index 0（客户端 InputValidationError），call_id 同毫秒回退加进程级序列防碰撞；⑤ **Claude Fable 周配额追踪**（`seven_day_fable`/`fable` 归一 + 仅周窗口时回填展示行，仪表盘 claude 配额固定排序）；⑥ **codex 新模型**——gpt-6-astra（vision/thinking/search，272k）四表齐上 + GPT-5.6 Sol/Terra/Luna image 变体；⑦ **codebuddy-cn 目录对齐服务端契约**——删 glm-5.0-turbo/minimax-m2.7/kimi-k2.5/hy3-preview/hy3-x/hy4-preview-x/deepseek-v3-2-volc 七个不再发布的模型（保留 kimi-k3 / deepseek-v4-flash-vision-exp 本地增量），能力表按服务端 product-config 重校（glm-5.3/5.3-flash/5.2/deepseek thinkingCanDisable=true、kimi-k3-1 1M 窗口），thinkingLevels 补 per-model effort sets，与 docs/zh-CN/codebuddy-cn-error-codes.md 错误码速查配套；⑧ glm/glm-cn 补 glm-5-turbo；⑨ profile 页按 hostname 动态显示 Local/Remote Mode；⑩ 后台刷新日志降噪。
- **上游 v0.5.69 择优移植·第二批**（`00c8e002`）：① **qoder 目录刷新 + 图片透传**——模型清单对齐服务端（新增 lite/Qwen3.8-Max/Qwen3.8-Flash/GLM-5.3/GLM-5.3-Flash，删 qmodel_preview/gm51model），capabilities 补 qoder 全表（真实模型家族窗口/输出上限；thinkingCanDisable 全 false——客户端 thinking 意图被上游丢弃），executor 图片透传（OpenAI `image_url` 与 Claude image 均转 OpenAI 形态，base64 直传免 OSS 预上传），chat_record_id 纳入数组内容哈希（同 prompt 不同图不撞缓存）；② **仪表盘 antigravity 配额按家族分组**——gemini-*/claude-* 归并单行（取最耗尽成员为代表），image 等保持独立，hide/show 级联 + hidden 陈旧 key 读侧修剪；保留我们优于上游的**按连接隔离**（上游按 provider 共享会跨账号串扰），多账号互不影响；③ **copilot 弃 MITM 改 VS Code 扩展指南**——CLI 工具页 copilot 从 MITM 拦截改为三步扩展配置指引（`9Router for Github Copilot` 扩展 + Server URL/API Key + Copilot Chat 选模型），MITM 引擎层保留可手动配置随时回退。

### 🐛 修复

- **mac 中文用户看到英文界面（语言检测脱节）**：mac Terminal 的 `LANG` 常年是 `en_US/C` 与系统语言脱节（GUI 启动的进程甚至没有 LANG），CLI 检测链插入 darwin 分支 `defaults read -g AppleLocale`（2s 超时静默失败），桌面壳改用 `app.getPreferredSystemLanguages()`；`TENROUTER_LANG`/`LC_ALL` 优先级不变，`LANG` 降为 mac 兜底后一级。
- **Next16 dev 非 localhost 回环打开仪表盘不水合**：浏览器经 `127.0.0.1` 打开时 `/_next` 静态资源的 Origin 不在默认 localhost 白名单内全部 403（Next16 dev-only 防护）——`allowedDevOrigins` 补 `127.0.0.1`；生产/桌面构建不受影响。
- **`/responses` 根路径重写鉴权缺口（安全）**：dashboardGuard 的 `PUBLIC_PREFIXES` 此前不含 `/responses`，而中间件先于 Next.js rewrites 执行——根路径请求落在 guard「未知路径放行」分支后经重写直达 `/api/v1/responses` 公开 LLM handler，**远端无需 API key** 即可调用；补入前缀表后该路径与 `/v1/*` 同样强制 API key 校验（对齐上游 98579f98）。
- **Claude 组合回落产生的外来 `server_tool_use` 毒化历史（400）**：组合回落到自带内置工具的供应商（如 z.ai/glm 的 `call_` id analyze_image）后，历史里残留非 `srvtoolu_` 前缀的 server_tool_use 块，后续每个 Claude 回合整请求被 Anthropic 400 拒绝——passthrough 归一化现按 `^srvtoolu_[A-Za-z0-9_]+$` 校验并丢弃外来块，连带清理其 tool_result 半边（悬空 tool_result 同样 400），顺带清空文本块与清空消息（Anthropic 拒绝空 text 块）。
- **MCP 延迟工具破坏缓存锚点（400）**：Anthropic 拒绝同时携带 `defer_loading:true` 与 `cache_control` 的工具（MCP 客户端把延迟工具放尾部恰是锚点落点）——缓存锚点改为锚在最后一个**可缓存**工具上（`anchorClaudeCache` 与 `prepareClaudeRequest` 两处），不再整体丢缓存。
- **gemini schema 元组校验 400**：`prefixItems`/`additionalItems`（元组关键词）此前被静默剥离，`type:"array"` 缺 `items` 被 Gemini 以 "missing field" 拒绝——先转换 `prefixItems` → `items`（单变体直取/多变体 anyOf）再剥离残留，数组缺 items 补宽松占位。
- **antigravity 系统提示竞争品牌清洗泛化（防误判 429）**：Zed 的 Claude 提示词此前只剥一句，OpenCode 命名仍会触发后端 429 Quota Exhausted——改为规则表（Claude Agent SDK 句剥除 + `opencode` 大小写变体改写为 antigravity）。
- **免费模型后台刷新噪音与连接测试悬挂**：① 后台刷新 tick 高频 debug/info 日志降噪；② 连接测试加 15s 超时防挂起耗尽连接池，供应商搜索对空名守卫（对齐上游 df85e16d）。

### ⚙️ 工程与打包

- **Windows 桌面产物 CI 化 + SignPath Foundation 签名链路**（`4e8ee7fb`）：tag 触发构建 Setup / Portable / Web-Setup + 7z，SignPath 配置就绪（repo variable + secrets）时走外部签名、未配置自动降级未签名上传，产物自动附 Release——为免费开源代码签名铺路；desktop CI 补装 cli 依赖（esbuild 供 MITM 打包）。

### 📄 文档

- **CodeBuddy-CN 上游错误码速查**（`78ffd238`，社区贡献）：中英双语对照 11101/11128/11133/11150/11151 与 429/401/402 的成因与出路，登记进 docs README。

## v1.0.6 (2026-09-05)

> v1.0.5（2026-09-03，含最后一次 tag 移动并入的 APInex / 用量表修复 / 上游 v0.5.65 同步）之后的新增功能版：CodeBuddy CN 每日自动签到、Antigravity Gemini 3.8 Flash 修复 + 配额对齐官网（5h+每周）、OpenCode Free 免费目录对齐、Windows Web 安装器、quota「只看有余额」实时重算、更新横幅与 Profile i18n 补齐。

### ✨ 新增功能

- **CodeBuddy CN 每日自动签到**（实验性，默认关）：Profile → 实验性功能 打开 **CodeBuddy CN auto daily check-in** 后，cbcn 详情页的 Import / Export 按钮被替换为**每日自动签到**（每账号本地时间 00:00–06:00 随机时刻自动调用 CodeBuddy 每日签到接口续免费额度，失败放行不崩服务；401 自动刷新一次 token 后重试）与一个**立即签到**手动按钮（汇总 toast；服务端日志 `CB_CN_CHECKIN` 按账号输出「账号名： 状态」）。该开关与 CodeBuddy OAuth import / export 两个实验开关独立、详情页展示互斥。实现：后端调度器 `src/sse/services/codebuddyCheckin.js`（boot 即安全补签 + 次日随机槽定时器，unref、幂等启动，每次触发重读开关），`POST /api/oauth/codebuddy-cn/checkin` 手动签到接口（仅返回状态、不返回任何 token），新设置键 `codeBuddyCheckin`（默认 false，经 GET/PATCH /api/settings 持久化）。
- **Antigravity 配额对齐官网 Model Quota UI（5h + 每周双窗）**：用量页 Antigravity 配额重构为以 `v1internal:retrieveUserQuotaSummary` 为主数据源 —— 每账号精确 **4 张卡片**（2 个模型族 "Gemini Models" / "Claude and GPT models" × {5 小时限额, 周限额}），各含剩余比例与重置时间，与 antigravity.google 管理页一致；归一化基准改为 100 百分制（原 1000 假次数）。解析兼容显式 `window` 字段与从 bucketId/displayName 文本推断两种形态、兼容顶层与 `remaining.remainingFraction` 嵌套两种字段层级。该接口不可用时优雅回退原 `fetchAvailableModels` 逐模型解析（不再混排 17 假模型）。
- **OpenCode Free 目录对齐官方「限时免费」名单**：补入 Big Pickle（隐身模型）/ MiMo-V2.5 / Ling 3.0 Flash Fin / Nemotron 3 Ultra / Nemotron 3.5 Lightning 五个免费模型（registry + capabilities）；**刻意不收**上游列表残留的 `deepseek-v4-flash-free` / `laguna-s-2.1-free`（官方文档免费名单已无此二者，避免误用产生收费调用）。
- **桌面 Windows 双产物**：新增 nsis-web Web 安装器（约 211KB，在线拉取完整包）+ 完整版保留；`appPackageUrl` 用 GitHub `releases/latest/download`；CI 上传 server tar.gz 时不再硬编码 release `name`/`body`（防止重复 run 覆盖手工维护的发布说明）。

### 🐛 修复

- **Antigravity `ag/gemini-3.8-flash-*` 404「Requested entity was not found」（用户反馈）**：三处根因一并对齐 9router `70f15aa`——① registry 3.8 三档改为**各自的 tiered 实体**（`gemini-3.8-flash-high(high)` / `medium(medium)` / `low(low)`，裸 ID 直传会 404），并新增无档位 `gemini-3.8-flash`（路由到 medium 档）；② **IDE 指纹 2.1.1 → 2.11.0**（`providers/shared.js` 与 MITM 覆盖层 `src/mitm/antigravityIdeVersion.js` 两处统一，上游按 client 版本门控模型下发，旧指纹拿不到 3.8 实体）；③ MITM `MODEL_SYNONYMS` 补 `gemini-3.8-flash → medium` 归一化、capabilities 补 `*gemini-3.8*` pattern（vision/audio/video/reasoning/search、thinkingLevel、1M ctx）、quota discovery 切到 daily host（与原生 IDE 一致）。providers 基线同步重建。
- **用量页「只看有余额」拉不到新配额包（用户反馈）**：CodeBuddy CN 每日签到会新增满额（0/100）Bonus Pack，且旧包过期后后续包会**挤占前面的序号**（pack 名复用）。原「只看有余额」只把耗尽行**加进**持久化隐藏集合、从不移除后来恢复余额的行 → 新满额包顶到曾隐藏的 pack 名上就永远显示不出，得「显示全部」再重筛才回来。修复：抽出 `computeDepletedHiddenKeys`，每次筛选**实时从当前快照重算** hidden —— 只隐藏「当前确实 used≥total / 0-0」的行，任何有余额的行（含新满额包）自动移出隐藏，序号再挤也能看到新包。
- **更新横幅 / Profile 设置页 i18n 补齐**：侧栏「有新版可用」横幅、更新弹窗与 ManualUpdatePanel 全套文案（复制安装命令 / 倒计时 / 关闭指引）由英文硬编码改为接 translate；更新确认弹窗与服务器断开层的按钮文字补全。设置页 Providers / Experimental / Language / Security / Network / Observability / SSO 各卡**标题与描述**接 translate（此前字典有词条但代码漏接），补 `Regional currency` / `Single Sign-On (SSO)` 等缺失词条；弹窗「取消」按钮加 `whitespace-nowrap` 修复折行成两行。
- **免费模型 429 限流友好提示**：`oc/*-free`、`contributor-free`、APInex `free/` 前缀等免费模型被上游限流返回 429 时，不再透传上游英文 `rate_limit_exceeded`，改为返回友好中文提示——上游给了 Retry-After/重置时间则显示「约 N 秒/分/小时后可再试」，否则建议稍后再试或切换付费档；付费模型与多账号 fallback 路径完全不受影响。实现：新工具 `open-sse/utils/freeModel.js`（`isFreeModel` 保守正则识别免费档 + `formatFreeRateLimitMessage` 中文文案），在 `chatCore` 429 错误出口仅对免费模型覆盖 message。配套单测 `tests/unit/free-model.test.js`。

## v1.0.5 (2026-09-03)

> v1.0.4 发布后的功能版：新增 Electron 桌面托盘版（Win + macOS）与 npm CLI 系统语言检测（en/zh-CN/zh-TW）。本版 tag 经多次移动，最后一次覆盖并入 APInex 供应商、用量表修复与上游 v0.5.65 同步（见下方「09-03 并入」节），发布日期以首次发布的 09-03 为准。

### ✨ 新增功能
- **Antigravity 支持 Gemini 3.8 Flash 系列**（社区实测反馈）：Google 于 2026-09-02 在 Antigravity（agy）生态上线 Gemini 3.8 Flash（内部代号 Skimaki），`ag/gemini-3.8-flash-high` / `ag/gemini-3.8-flash-medium` / `ag/gemini-3.8-flash-low` 三档注册进 antigravity 供应商，计费对齐 3.7 Flash 档位（$1.50/M in、$7.50/M out），用量配额白名单与 CLI 种子模型同步补全。⚠️ 本版的上游寻址（裸 ID 直传）实测不可用，**v1.0.6 已修正**为 tiered 实体 + IDE 指纹 2.11.0，详见下版更新日志。
- **Kimi 官方渠道下线 kimi-k2.5 系列**：Moonshot 于 2026-08-31 正式下线 `kimi-k2.5` 与 `moonshot-v1` 系列（`moonshot-v1` 此前从未注册，无影响）。官方 `kimi` 供应商移除 `kimi-k2.5` / `kimi-k2.5-thinking` 两档（上游已 404，保留只会让请求失败）；第三方聚合网关（CodeBuddy、阿里百炼、B.AI、Cursor、Ollama、Cloudflare 等）各自的 `kimi-k2.5` 行**保留**——那些是网关侧自有托管副本，不受 Moonshot 平台下线影响，capabilities/pricing 条目相应加注释说明归属。

- **npm CLI 系统语言检测（i18n）**：CLI 此前整体英文硬编码，现随系统语言自动显示中文（简/繁）或英文，`TENROUTER_LANG` 环境变量可强制覆盖，检测优先级 `TENROUTER_LANG` → `LC_ALL`/`LANG` → ICU 系统 locale（Windows 取系统显示语言）→ 回退英文。覆盖启动器全流程（`--help`、接口选择菜单、托盘模式横幅、更新提示、崩溃重启）、系统托盘菜单（Windows PowerShell NotifyIcon 管道两端已有显式 UTF-8，中文标签安全传输）、供应商/组合/API Keys/设置/CLI 工具五大管理菜单与终端 TUI，共 358 条文案 × en/zh-CN/zh-TW 三语；术语与仪表盘 `public/i18n/literals` 对齐（仪表盘/供应商/组合等）。实现为 `cli/src/cli/i18n/` 零依赖轻量方案：按源文件分片的 JSON 字典（`locales/<lang>/*.json`）+ `t(key, params)` 查找，缺失键回退 en 再回退键名；`xai video` 子命令、hooks 诊断信息与 apiKeys 盒线 legacy 展示函数暂保持英文。

### ⚙️ 工程与打包

- **新增桌面托盘版（Electron，Win + macOS）**：参考 inspection-visualizer 的「Electron 壳 + sidecar」模式新增 `desktop/` 目录，把 10Router 封装成「装完即用、托盘管理」的桌面应用——托盘菜单（打开控制台/启动/重启/停止/开机自启/数据目录/退出）+ 内嵌 BrowserWindow（关闭即缩到托盘）+ 单实例锁 + 免鉴权 `/api/health` 健康轮询（1.2s，90s 超时）。要点：
  - **sidecar 复用 Electron 二进制**：`ELECTRON_RUN_AS_NODE=1` 以纯 Node 运行 `cli/app/custom-server.js`（Next standalone 产物，平台无关），不内嵌独立 Node 运行时；服务自拉起的子进程（更新器/MITM）继承该环境变量，ABI 一致；
  - **SQLite 驱动**：Electron 37（内置 Node 22）下服务驱动链命中 `node:sqlite`（实测日志确认），`sql.js` 捆绑兜底；
  - **与 npm CLI 形态互斥共享**：数据目录沿用 `%APPDATA%\10router` / `~/.10router`，同一端口 20128 健康预检，端口被占且健康时进入 external 模式只开窗口不重复拉起服务；
  - **壳日志隔离**：`app.setName('10router-desktop')` 必须先于一切 `getPath('userData')`——productName「10Router」在 Windows 大小写不敏感文件系统上会与服务数据目录 `10router` 撞名，壳日志会混进服务数据；
  - **打包流水线**：`desktop/build.ps1`（Win，NSIS 安装包 + 便携 exe，electron/electron-builder 二进制走 npmmirror）与 `desktop/build.sh`（mac，x64 + arm64 两个 dmg，须在 mac 上执行）；图标由 `make_icon.py` 生成，与 CLI 托盘同品牌（橙色圆角 + 白色「10」）。

### ✨ 新增（09-03 并入）

- **CodeBuddy CN 账号 JSON 批量导入 / 导出**（实验性，默认关）：`设置 → Providers → 打开 "CodeBuddy CN OAuth import / export"` 后，cbcn 详情页显示 **Import / Export** 按钮——用三方账号切换工具的 (wb) JSON 格式**批量导入**（选文件或粘贴）或**导出**（下载 `codebuddy-cn-accounts-<date>.json`）OAuth 授权。导入按 token 的 Keycloak `sub`（uid）或昵称去重（已存在则更新、否则新建），仅接受 `codebuddy.cn` / `copilot.tencent.com` 签发域（`workbuddy.cn` 等其它 realm 自动跳过）。实现：`GET/POST /api/oauth/codebuddy-cn/export` 与 `bulk-import`。
- **Agent 可自助添加自定义 OpenAI/Anthropic 兼容供应商**（运行时操作，免改源码/免重打包）：`POST /api/provider-nodes` + `POST /api/providers` 根路径可用 dashboard LLM API key 认证，两步把一个 baseUrl + 上游 key + 模型注册成可路由节点（模型须带 `{prefix}/` 前缀路由）；`GET/PUT/DELETE` 及子路由仍走 CLI token/JWT。随附 agent 操作指南 `docs/zh-CN/agent-add-custom-provider.md` 与开源 skill `skills/10router-add-provider/`。
- **公益站供应商默认改为显示**：GoRouter / TaBiAI 等公益站（`community`）供应商从「默认隐藏、需手动打开开关」改为**默认显示**（未显式关闭即显示）——供应商列表、Profile 的「显示公益站供应商」开关、用量页拓扑图三处统一为 `!== false` 语义，不再默认藏起来。
- **公益站供应商排序归组**：Free Tier 列表中 GoRouter / TaBiAI 等公益站（`community`）供应商在 rank 分组内聚成相邻的一块，不再与普通 freeTier 供应商按 priority/名字混排（rank 连接优先语义不变，公益站块排在同 rank 普通供应商之后）。
- **新增 Agnes AI 双站供应商**（标准 API Key 分区）：**Agnes AI**（`agnes-ai`，国际站）`https://apihub.agnes-ai.com/v1` + **Agnes AI (CN)**（`agnes-ai-cn`，中国站）`https://api.agnes-ai.cn/v1`，OpenAI 兼容、Bearer 鉴权。各登记 **Agnes 2.5 Flash**（512K 上下文，视觉+推理）与 **Agnes 2.5 Pro**（1M 上下文，视觉+推理）两个文本模型（实测 `/v1/models` 确认模型 ID；`agnes-2.0-flash` / `2.5-pro-alpha` 上游已废弃未登记）。能力按官方文档登记 contextWindow/vision/reasoning，两站共用品牌图标。国际站另含 **Agnes Image 2.0/2.1/2.5 Flash**、中国站含 **Image 2.1/2.5 Flash** 图像生成模型（走标准 `POST /v1/images/generations`，图生图/编辑能力，同 key 复用）。
- **设置页新增「实验性功能」分组**：Profile 设置新增独立的 **Experimental**（实验性功能）卡片，收纳开发者向/默认关闭的开关，方便后续扩展——从 Providers 卡迁入 **Fetch models from GitHub JSON**（JSON 模型目录导入）与 **CodeBuddy CN OAuth import / export**（cbcn 账号导入导出）。Providers 卡保留排序偏好与公益站显示开关。
- **新供应商 APInex（apinex.bond）**：第三方预付 USD 中转网关，OpenAI 兼容（`https://api.apinex.bond/v1`，Bearer 认证）。18 个模型（13 付费 + 5 个 `free/` 前缀免费模型，含 GLM-5.3 Flash、DeepSeek V4、GPT-5.6 Luna、Qwen 3.8 MAX），模型 ID 为 `vendor/model` 斜杠形式原样透传，capabilities 按完整 ID 挂 provider 专属表（contextWindow 取自上游目录）。类别 `apikey`、`hasFree`（非公益站，不设 community 标志）。免费模型已用真实 key 实测可用（付费模型 $0 余额返回 402 `billing_error`，Anthropic 系不参与赠送额度）。新增 `notice.inviteCode` 通用字段：供应商详情页两处 + ProviderInfoCard 的 Get API Key 旁渲染可复制邀请码 chip（`InviteCodeChip`，复用 `useCopyToClipboard`），APInex 填 `SLEWP68C`。基线（providers/alias）与 golden 快照已重建。
- **上游 v0.5.65 供应商/模型数据同步**：新增 GLM-5.3-Flash(Vision) / GLM-4.6V / DeepSeek-V4-Flash-Vision-Exp / Grok-4.6 / Claude-Fable-5.1 等模型与 Muse-Spark Responses 直连路由；CodeBuddy CN 目录刷新（新增 hy3 / hy4-x / kimi-k3-1，删除 EOL 的 glm-5.0 / 4.7）；`kimi-k2.5` 不随上游回加（维持 EOL 2026-08-31 决定）。
- **新搜索供应商 Ollama-Search 与 Xquik**：Ollama-Search 复用 Ollama 本地 key 直连搜索；Xquik（X/推特搜索）独立接入。搜索处理器支持凭据回退（`credentialFallback`）与搜索锁按 `websearch:*` 作用域隔离，避免跨 provider 串锁。

### 🔒 安全加固（09-03 并入）

- **CodeBuddy CN 账号导出/导入加密码二次验证**：审查发现 `requireLogin=false`（免登录本地单机模式）下 `/api/oauth/codebuddy-cn/export` 可**匿名导出全部 CodeBuddy token**（严重泄漏）——现导出与批量导入接口均要求 dashboard 密码（`x-9r-password` header），带 `x-9r-cli-token` 的 CLI 请求豁免；前端点 Export/Import 先弹密码确认框。无密码直接调用返回 401。补丁覆盖 cbcn 详情页的空连接态与有连接态两处入口。
- **fetchPublic 安全加固（SSRF）**：`fetchPublic` 增加三层防护 —— ① 域名先解析为 IP 后校验是否回环/私网/保留段（防 DNS rebinding 首跳打到内网）；② 连接建立后再按实际响应 IP 复验一次；③ 重定向跟随时对每个跳转目标重新做 IP 校验，杜绝被 302 带到内网探测。配套 `tests/unit/ssrf-guard-hardening.test.js`。

### 🐛 Bug 修复（09-03 并入）

- **Dashboard Skills 页链接指向不存在的 `master` 分支**：此前 `skills/*` 链接与 "View on GitHub" 均指向 `master`（仓库实际为 `main`），点击 404；统一改走 `main`。页面同时新增展示 **10router-add-provider** 技能卡片（可从 Skills 页复制粘贴给任意 AI agent 使用）。
- **长 TTFT（time-to-first-token）下客户端假断连（ResponseAborted 循环）**：超大上下文上游（如 CodeBuddy 的 DeepSeek/GLM 在 100K+ token 提示词）首字节可能要 20–30s，这段静默期客户端（网关/卡片 sidecar）看到连接空闲便超时中断 → 反复 ResponseAborted。现于等待首字节期间按 5s 间隔下发 SSE 注释行（`: keep-alive`，规范合法、各 OpenAI/Claude/Gemini 解析器忽略），首字节到达即停止；同时新增断连观测日志（`STREAM-ERR`/`STREAM-CANCEL` 记录 `firstByteSeen`/`keepalivesSent`/耗时，用于判断断连发生在 TTFT 窗口还是流中段）。
- **用量表 成本/Token 切换后显示错乱（用户反馈）**：根因在运行时 i18n（`src/i18n/runtime.js`）与 React 的冲突——观察器只监听 `childList`、看不见 React 原地改写的文本，且会把排序时被移动行的单元格文本重置回首次见到的"原文"（成本模式下的 `￥0.00`），造成 Token 模式下部分行显示金额、部分行显示 token 数的乱表。修复：观察器增加 `characterData` 监听 + 记录 `_i18nApplied`（上次写入值），发现文本被框架合法改写时采纳为新原文而非回退。附带修复：表头"Input Tokens"等被原地更新后漏翻译的问题。复现与修复均在 `next dev` + 真实浏览器验证。
- **用量表排序语义**：值列（token/成本）排序此前作用于分组前的明细行，组顺序由"组内第一条明细"决定而非组合计值（51M input 的组会排在升序第一位）；现按分组 summary 排序（`UsageStats.js`）。成本模式的排序列字段从 `promptTokens`/`completionTokens` 修正为 `inputCost`/`outputCost`（`UsageTable.js`）。
- **用量表表头字典补齐**：zh-CN 补 `Cached Cost`；zh-TW 补整个用量表组（Cached/Input Cost/Input Tokens/…/Usage by *，15 条）；APInex 提醒句与 `Invite code` 文案三语同步。


## v1.0.4 (2026-09-01)

> v1.0.3 发布后的维护版：修复供应商页排序、更新日志多语言化、Change Log 弹窗、出口代理开机恢复等问题。

### ✨ 新增功能

- **更新日志按界面语言加载**：仪表盘「Change Log」从包内 `public/i18n/changelog/` 按当前语言加载对应文件（`en.md` / `zh-CN.md` / `zh-TW.md`），未翻译的语言（日/韩等）回退到英文；随构建打包，无网络延迟。切换语言时弹窗即时刷新。
- **统一 CHANGELOG 分类风格**：`CHANGELOG.md` 全部版本统一为 ⚠️升级注意 / ✨新增功能 / 🐛Bug修复 / 🔒安全加固 / ⚙️工程与打包 / 📝文档 六类，消除此前 v1.0.0-1.0.2（纯文本）与 v1.0.3（emoji）的割裂。
- **历史用量导入（支持 9Router 备份）**：设置 → 本地模式 → 数据库备份新增「导入使用量」独立按钮，复用现有 Import Backup 文件选择流程，按扩展名分发——`.sqlite/.db` 只导入 `usageHistory` / `usageDaily`（用于统计），不触碰任何配置；`.json` 走原配置备份导入。用 `node:sqlite` 读取（无 wasm 依赖），按内容签名去重避免重复导入，前端硬校验扩展名（只收 SQLite 文件，选图片会提示）。
- **通知 Toast 顶部居中 + 图标对齐**：全局通知容器从右上角改为顶部居中，图标与文字垂直居中对齐（`items-center`），长文本换行不乱。供应商详情页（含模型下拉框）的浏览器原生 `alert()` 全部替换为友好的 `notify()` Toast（成功/警告/错误三类着色）。
- **新增 3 家供应商**：
  - **TokenBom**（`tokenbom`，标准 API Key 分区，**去中心化 token 交易市场**：闲置 API Key 自动赚积分、积分可调用多种模型、连接 API 提供者与消费者）：`https://tokenbom.com/v1`，Bearer 鉴权，含 79 模型 GitHub JSON 目录（Fetch Models 可拉取），种子含核心 Claude / DeepSeek / GLM / Kimi / Qwen；
  - **GoRouter**（`gorouter`，免费 Free Tier 分区，无充值入口，new-api 网关）：`https://gorouter.app/v1`，4 个模型（claude-opus-4-8 / 4-8-thinking / 5 / 5-thinking）；
  - **TaBiAI**（`tabiauto`，免费 Free Tier 分区，无充值入口，new-api 网关）：`https://tabitoken.com/v1`，同 GoRouter 4 个模型。
  - 三家用 new-api 官方 logo（青/洋红对称圆环 SVG）作图标。
- **配额包账户筛选提示框**：账户筛选（全部账号/活跃账号/已停用）选择会持久化到 localStorage，多次访问间保持；当筛选不是「All accounts」时，工具栏下方显示琥珀色提示条「账户筛选已启用，且会在多次访问间保持」，避免忘记当前筛选状态。
- **公益站供应商标签 + 显示开关**：GoRouter / TaBiAI 两个无充值入口的免费公益站（new-api 网关）默认不在供应商列表显示，带黄色「公益站」标签；可在 **设置 → Providers → 显示公益站供应商** 打开后显示。开关状态持久化到数据库。

### 🐛 Bug 修复

- **供应商页排序修正**（多项叠加，最终行为）：
  - **有连接的供应商前置**，连接状态优先于 priority（此前 priority 不同会打乱"有连接在前"）；
  - **连接全部停用（禁用）沉底**，排在从未添加的供应商之前；
  - **OpenCode Free / MiMo Code Free** 这类 noAuth 免费供应商按拓扑开关排序——拓扑隐藏时排在已连接供应商之后、已禁用之前，启用（拓扑显示）时置顶；两者默认拓扑隐藏（`topologyHiddenByDefault`）；
  - **合并 free 与 free-tier 列表**统一排序，避免有连接的免费供应商（如 Dots）排在拓扑隐藏的 noAuth 之后。
- **修复禁用连接的计数**：连接 `isActive=false` 不再计入"已连接"，全禁用的供应商不会被误判为活跃而浮到顶部。
- **Change Log 弹窗链接新标签打开**：修正 marked v18 renderer 签名（token 对象而非位置参数），`CHANGELOG.md` 链接恢复可点击并在新标签页打开。
- **Change Log 与头部菜单 i18n**：弹窗标题 / Loading / 错误文案、菜单项（Change Log / Theme / Shutdown / Logout 等）接入 `translate()`。
- **切换语言后文案残留旧语言**：`RuntimeI18nProvider` 现监听 locale 变化触发 React 重渲染，`translate()` 渲染的文本（如"已禁用"徽章）切换语言后立即更新。
- **bai 等自定义模型在 JSON 目录模式下不显示**：`customModelRows` 不再在 JSON 目录模式下被清空，手动添加的模型与 JSON 目录并存显示。
- **供应商连接测试补齐新供应商**：为 sensenova / dots / longcat / bai / api-airforce / bazaarlink / baidu / featherless / bluesminds / alitp-intl / codebuddy-cn / commandcode 等新增 provider 添加连接测试 case（有 `validateUrl` 走 GET models Bearer，否则 POST chat ping 自定义 header）；此前这些 provider 一律报 "Provider test not supported"。
- **JSON 目录启用模型后仍不显示**：启用 JSON catalog 模型时同步清除 `disabledModels` 中对应的陈旧禁用记录（含 provider 与 alias 两个 key，`/v1/models` 的 `isDisabled()` 用 outputAlias 判定）——否则用户在前端激活模型后列表仍被旧禁用状态挡住，出现"激活了却不显示"。
- **供应商详情的模型下拉框 i18n 补全**：New Model 输入、Fetch Models 等控件接入翻译。
- **B.AI 等 JSON 目录 provider 静态模型补全**：B.AI（35 模型，含 deepseek-v4-flash-vision-exp 免费实验版）、CodeBuddy CN（补 glm-5.3-flash / glm-5.3 / kimi-k3）等此前 Fetch Models 返回空或目录缺模型导致切换 "was not found in this provider's model listing"，现已补全静态目录。
- **供应商连接测试友好维护提示**：当 provider 端点被 Cloudflare/WAF 拦截（返回 403 HTML 挑战页）或网络不可达时，连接测试不再误导性地报 "Invalid API key"，而是显示琥珀色友好提示「Provider may be under maintenance — blocked by its gateway (e.g. Cloudflare)...」，并在添加 API key 弹窗中展示；新增 tokenbom / gorouter / tabiauto 的连接测试 case（走 GET /models Bearer）。
- **CodeBuddy CN DeepSeek 模型报 11150**：DeepSeek 系列模型（deepseek-v4-pro / deepseek-v4-flash / deepseek-v3-2-volc）不支持 `reasoning_effort: auto/off`，编码 agent（如 dsh 的 THINK:auto）调用时报 400 `11150`。现对 DeepSeek 模型将 `auto` 映射为 `high`、`off` 删除该字段（其他模型不变），agent 不再因思考强度参数失败。
- **CodeBuddy 系模型流式 tool_calls 空 name → 11133 / `unknown tool ""`**：CodeBuddy 上游流式返回工具调用时，首 chunk 带 `function.name`，后续 chunk 返回空 `name:""`（只累积 arguments）。原样透传给标准客户端时，客户端误判为空工具名导致 `unknown tool ""`，或把空名工具调用重发被上游拒绝（11133）。现于 SSE passthrough 中删除空 `function.name`，流符合 OpenAI 规范（name 只在首 chunk），客户端正确保留已累积的工具名。
- **隐藏公益站后拓扑图仍显示**：设置 → Providers → 关闭「显示公益站供应商」后，供应商列表正确隐藏 GoRouter / TaBiAI，但用量页的供应商拓扑图仍显示这两个公益站——拓扑图数据未同步读取该开关。现拓扑图与供应商页共用同一过滤逻辑（`AI_PROVIDERS[provider].community` + `showCommunityProviders`），开关关闭时拓扑图同步隐藏公益站。
- **dashboard/skills 页面 i18n**：Skills 页面的按钮、标题、提示文案未接入 `translate()`，中文界面下仍显示英文；skill 的 name / description 也未翻译。现已全部接入 i18n 并补全缺失翻译项（如「Copy link」「10Router (Entry)」）。
- **skills 页面链接关联中文版 SKILL**：`/dashboard/skills` 页面的复制链接 / 打开链接此前始终指向英文版 `SKILL.md`。现按当前界面语言解析——中文（zh-CN）时指向 `SKILL.zh-CN.md`，其余语言指向 `SKILL.md`。

### 🔒 安全加固

- **出口代理开机自动恢复**：`layout.js` 的 `initOutboundProxy` import 会被 Next 构建 tree-shake 掉，导致每次重启后 `process.env.HTTP(S)_PROXY` 不恢复、须等用户重存设置。新增 Node 侧初始化器（`outboundProxyStandalone.js`，随构建打入 standalone，由 `custom-server.js` 启动时调用）直接读设置表并应用代理 env。

### 📝 文档

- **npm 11+ `allow-scripts` 提示说明**：新版 npm 拦截本包 postinstall（仅预热 SQLite/托盘运行时，失败无代价），主 README、CLI 中英文 README、v1.0.3 release notes 均补充说明可忽略及如何放行（`--allow-scripts` / `npm config set`）。
- **更新日志拆分**：面向用户的精简版从 `CHANGELOG.ui.md` 迁至 `public/i18n/changelog/` 多语言文件，`CHANGELOG.md` 保留完整开发日志。

## v1.0.3 (2026-08-30)

> 首个以 **`@techysy/10router`** 名义发布的正式版。npm 包名已变更（npm 上的 `10router` 属于一个与本项目无关的 fork），可执行命令仍为 `10router`，数据目录 `~/.10router/` 不变，无需迁移。已装 `10router-cli` 的用户该包已停止更新，请改装新包。

### ⚠️ 升级注意

- **npm 包名变更为 `@techysy/10router`**：`npm i -g @techysy/10router`，可执行命令仍是 `10router`。为什么改：npm 上的 `10router` 属于 `some-du6e/10router` —— 同为 `decolua/9router` 的 fork，且早于本项目改名两周发布，属正当使用无法争取；此前的权宜之计 `10router-cli` 又与项目名不一致。改用 scope 包后 `@techysy` 归本组织独占，同时拿回品牌名。仪表盘的版本检查、「立即更新」拉起的 npx 命令、侧边栏安装命令、独立 updater 的兜底包名均已同步指向新包名。

### ✨ 新增功能

- **新增 4 家开放供应商**（均已配官方图标，模型目录 JSON 走仓库 GitHub + Gitee 双源，可在供应商页「获取列表」拉取更新）：
  - **LongCat**（美团，付费）：OpenAI 兼容端点 `api.longcat.chat/openai/v1`，Bearer 鉴权；
  - **SenseNova**（商汤 TokenPlan，公测免费）：`token.sensenova.cn/v1`，标准 Bearer，含 DeepSeek V4 Flash / GLM 5.2 托管模型与两款图像模型，归入供应商页 Free Tier 分区；
  - **Dots**（小红书 Dots Studio，公测免费）：`note3-prev-api.askdiandian.com/v1`，自定义 `api-key` 请求头，归入 Free Tier 分区；
  - **B.AI**（聚合平台，付费，一个 Key 通吃 GPT/Claude/Gemini/DeepSeek/GLM/Kimi/Qwen 等 11 个家族）：`api.b.ai/v1`，标准 Bearer；模型 ID 与凭证绑定，静态目录留空、以凭证 `GET /v1/models` 实时列表为准。
- **自定义供应商支持模型 JSON 目录**：自定义节点同样支持从 JSON 拉取模型清单，导入后可逐个禁用/激活、批量 Active All / Disable All，生命周期与预置供应商一致，`/v1/models` 只暴露启用模型。原手动路径在未导入目录或开关关闭时照常可用。
- **移除已废弃的 qoder-cn 渠道**：摘除其 registry 条目、OAuth 设备码流程、executor 与 usage 接入；qoder（国际版）不受影响。顺带删除了会静默抹掉 trae/devin-cli/windsurf 刻意隐藏的危险 registry 重建脚本（`regen-registry-index.mjs`）。
- **收录官方渠道图标**：LongCat、SiliconFlow 换用官方版图标，新增 tokenbom / Dots / SenseNova / B.AI 图标（B.AI 为 SVG，图标解析器新增扩展名映射）。
- **左上角品牌区更正为 "10Router Proxy"**：跟随上游改名时丢了 "Proxy" 后缀。仅调整侧边栏字标一处。
- **fnOS fpk 检查更新直达 Releases**：fpk 启动脚本注入 `INSTALL_CHANNEL=fpk`，`/api/version` 据此返回对应版本 release 的下载附件；侧边栏对 fpk 安装显示 "Get the fpk from Releases"，不再展示对 fpk 无效的 npm 安装命令。

### 🐛 Bug 修复

- **修复 npm 包携带构建机敏感文件**：CLI 构建把 `HOME`/`APPDATA` 指到 `cli/.build-home`，Next 构建期初始化生成的 `jwt-secret`、`machine-id` 和一份 `data.sqlite` 快照被 output tracing 带进 standalone、再随 `files: ["app"]` 进入 npm tarball（实测确认）。现改为构建期 HOME 挪到系统临时目录、产物显式排除，并在打包前新增第 9 步全量扫描门禁——命中任一敏感文件即拒绝出包；被污染的本地 `cli/app` 已清理。
- **修复照抄 `.env.example` 导致会话可伪造**：示例里的 `JWT_SECRET=change-me-...` 是仓库公开字符串，照抄的用户其 dashboard 登录态可被任意伪造。现在 `.env.example` 注释掉 `JWT_SECRET`/`INITIAL_PASSWORD`（留空即自动生成 0600 随机密钥），且运行时检测到已知占位值会忽略它并回退到生成的密钥。
- **修复用量统计同毫秒丢计数**：`saveRequestUsage` 的去重只按内容匹配（时间戳精确到毫秒 + provider/model/connection/key + token 数），两个真实不同请求若同毫秒落账且 token 数相同，第二条会被当重复吞掉。现调用方（chat 流式/非流式/SSE转JSON、embeddings 共 5 处）每上游尝试写入 `usageKey`，去重只按 key 命中；无 key 的旧调用方保持原行为。新增 `tests/unit/usage-dedup.test.js` 回归测试。

### 🔒 安全加固

- **仪表盘登录接入渐进锁定**：`loginLimiter`（5 次失败锁 30s→2m→10m→30m）此前只接了 SAML 回调，密码登录 `/api/auth/login` 完全无限流。现已接入，与 SAML 共用同一套 IP 判定（信任 `x-9r-real-ip` 需 custom-server 的 peer token 背书）。
- **登录密码校验统一**：登录路由改为复用 `verifyDashboardPassword`——`INITIAL_PASSWORD` 环境变量此前在登录路由被忽略（文档写了但实际不生效），现与敏感操作二次验证口径一致；同时移除登录路由里一份带硬编码兜底密钥的死代码。
- **仓库描述更正**：GitHub/GHCR 描述从 "9Router fork: ..." 更新为 10Router 自述（此前 Docker 包页展示的是上游名号）。

### ⚙️ 工程与打包

- **核实存疑两项**：docker-publish.yml 的 "重复 `--tag :latest`" 为误报（第二处 latest 是 `runs-on: ubuntu-latest`，写法本就正确）；`public/providers/longcat.png` 图标确认来自上游合并 `fd7a881c`，来源已明。
- 新增简体中文版 `cli/README.zh-CN.md`，两版顶部提供语言切换（npm 页面不解析相对链接，故使用绝对 URL）。

### 📝 文档

- **CLI README 新增「更新」章节**：分别说明 npm / Docker / fpk / standalone 四个渠道的更新方式，并明确警告 **非 npm 安装不要点击仪表盘的「立即更新」**——该按钮执行 `npm i -g` 并经 `npx` 重启，会在全局 npm 目录装出第二份，与原安装并存且互不知晓。fpk 安装现已被运行时识别（提示条自动改用 Releases 入口），该警告收窄为 Docker / standalone。
- **新增 `cli/PACKAGING.md` 本地 npm 打包指南**：覆盖构建九步、Step 9 敏感文件门禁、出包后自检（tarball 泄漏扫描 + 本机试装）、npmjs 发布（含国内镜像源不能发布、必须显式指定 registry 的坑）与 tag 触发其余三渠道的联动清单。
- **README 明确上游同步策略**：上游新功能一律学习后自行重写实现，禁止直接合并上游分支 / 挑拣提交 / 覆盖文件（见仓库根 `CLAUDE.md` 约定与 README「同步上游」章节）。

## v1.0.2 (2026-08-29)

> npm 上的 `10router-cli@1.0.1` 是首次发布的试水版本。npm 的 `name@version` 组合**永久不可重用**（即使 unpublish 也无法找回该版本号），因此正式版为 1.0.2。**建议 1.0.1 用户升级**：其内置的「检查更新」指向的是一个无关的第三方包。

### 🐛 Bug 修复

- ⚠️ **修复更新检查指向第三方包**（1.0.1 受影响）：仪表盘的版本检查、「立即更新」执行的 npx 命令、侧边栏展示的安装命令，以及独立 updater 的兜底包名，在 1.0.1 中仍写的是 `10router`——该名字在 npm 上属于一个与本项目无关的 fork。一旦该 fork 发布更高版本号，1.0.1 的仪表盘就会引导用户去安装他人的包。现已全部指向 `10router-cli`。
- **`--help` 显示错误的命令名**（1.0.1 受影响）：帮助信息打印的是 npm 包名 `10router-cli`，而实际可执行命令是 `10router`。二者在改名前恰好相同，改名后才暴露。
- **postinstall 失败不再中断安装**：该钩子仅预热 `~/.10router/runtime`，且 `cli.js` 每次启动都会重跑同样的自愈逻辑，失败本无代价。但在 WSL 路径上使用 Windows npm 安装时，postinstall 经由 cmd.exe 执行，而 cmd.exe 无法将 UNC 路径作为工作目录、会静默回退到 `C:\Windows`，导致 node 根本找不到脚本文件——脚本内部的 try/catch 此时尚未执行，整个安装随之失败。

### ⚙️ 工程与打包

- **澄清 `better-sqlite3` 的定位**（无行为变更）：它虽然在几乎所有部署里都不会被实际加载（npm ≥11 会跳过未放行安装脚本的 optionalDependency，且 Next tracing 只拷贝其 `lib/*.js` 而不含 `.node`，故 Docker / fpk / standalone 一律落到 `node:sqlite`），但它是**构建期必需**的：`adapters/betterSqliteAdapter.js` 静态 import、`api/oauth/cursor/auto-import/route.js` require，webpack 必须能解析该模块。曾尝试移除该依赖声明，导致 `next build` 报 `Module not found` 而中断，已恢复并在 `package.json` 中注明请勿删除。
- **新增测试 CI**：`.github/workflows/test.yml` 在每次推送 main 与 PR 时运行套件（ubuntu + Node 24），执行注册表基线校验与回归门禁。此前三个 workflow 只做构建，测试从未在 CI 跑过。
- **修复回归门禁脚本**并重建基线；修复一批仅因路径/运行器假设而失败的测试，套件从 1820 通过 / 94 失败变为 1872 通过 / 41 失败。
- 统一 Node 版本为 24（Active LTS，支持至 2028-04），新增 `.nvmrc`。

## v1.0.1 — 未发布（内容随 v1.0.2 交付）

> 本节记录原定于 1.0.1 的改动。**1.0.1 从未作为版本发布**：git 侧只有 `v1.0.1-rc.1` 标签（Release 已删除），Docker、fnOS fpk、standalone 三个渠道也从无 1.0.1 —— 以下内容对这些用户而言是随 **v1.0.2** 首次到达的。
>
> 唯一的例外是 npm：`10router-cli@1.0.1` 确实发布过，包含本节内容，但**不含** v1.0.2 修复的更新检查指向问题。该版本已由 `@techysy/10router` 取代。

### 🔒 安全加固

以下四项均为上游 9Router 继承代码中的问题。MITM 默认关闭，未启用过的用户不受影响。

- **MITM 转发上游时不校验 TLS 证书**：ALPN 探测、HTTP/2 与 HTTP/1.1 三条转发路径均设置了 `rejectUnauthorized: false`，加之固定使用单一公共 DNS 解析真实 IP，一旦 DNS 应答被投毒或链路上存在中间人，刚刚解密出的上游 OAuth 令牌会被原样转发给攻击者。三处均已恢复校验。
  - 关闭校验本无必要：三处原本就传了 `servername`，Node 按该主机名（而非所连 IP）校验证书，因此按 IP 直连不受影响。同仓库 `open-sse/utils/proxyFetch.js` 的 `createBypassRequest()` 做的是同一件事，且一直保持校验开启。
  - 已实测 `TOOL_HOSTS` 中各上游：githubcopilot、cursor、kiro 及两个 AWS 端点均校验通过并正常协商 h2；故意传入错误 servername 会以 `ERR_TLS_CERT_ALTNAME_INVALID` 拒绝。
- **根证书私钥权限收紧至 0600**：`rootCA.key` 此前以默认权限（0644）写入，本机任何用户可读；持有该私钥即可为任意域名签发受本机信任的证书。现以 0600 写入、`mitm` 目录以 0700 创建，且旧版本遗留的私钥会在下次启动时自动修复权限（Windows 由 ACL 管理，不适用）。
- **不再盲目杀掉占用 443 端口的进程**：MITM 启动时会 SIGKILL 掉任何监听 443 的进程，足以静默杀死本机正在运行的正常 HTTPS 服务，并且绕过了 `manager.js` 已经向用户征得的确认。现在仅回收自身残留实例（依据 `.mitm.pid`，或比对进程命令行），占用者无法识别时中止启动，并给出进程名与处理方式。
- **自动清理异常退出遗留的 hosts 条目**：清理钩子仅挂在 SIGTERM/SIGINT 上，SIGKILL、崩溃或断电后，被劫持的工具域名会持续指向 127.0.0.1 而无人监听，导致 Copilot/Cursor/Kiro 报出难以理解的错误，且此前没有任何机制会恢复。现在应用启动时会清理「当前不应生效」的残留条目（MITM 已关闭，或该工具 DNS 开关为关），正在运行的实例不受影响。
  - 检测为一次只读 hosts 读取，无残留时零开销，不会在每次启动触发 sudo 或 UAC 提示；确有残留但无提权时，会明确打印被搁浅的域名及处理方式，而非静默跳过。

### ✨ 新增功能

- **已禁用供应商排到最后**：Profile 设置页新增开关，开启后已禁用的供应商在列表中沉底，避免常用项被挤下去；Providers 页新增对应设置卡片。该排序同时覆盖 API Key 与免费商家分区。
- **CommandCode 接入标准化 JSON 模型目录**：新增 `providers/commandcode.json`（62 个模型，含能力字段），并在注册表接入 Fetch Models。
- **桌面侧边栏可折叠**：侧边栏支持收起，窄屏与专注场景下让出横向空间。
- **配额行批量显示/隐藏**：配额面板新增批量可见性按钮，不必再逐行开关；免费商家在拓扑图中以虚线连接区分。
- **OpenCode Go 配额用量接入**：通过 `opencode.ai/zen/go/v1/usage` 读取用量，并支持 rolling / weekly / monthly 三种窗口的扁平结构解析；模型列表亦可经 Fetch Models 实时拉取。
- **模型 JSON 目录改为 provider 独立存储**：目录不再混入 `customModels`，改为按 provider 保存并带 enabled/disabled 状态；JSON 拉取到的新模型默认禁用，需手动启用。全局开关持久化到数据库（原为 localStorage），关闭时回退到内置静态目录。
- **模型目录 Gitee 镜像回退**：`fallbackModelsJsonUrl` 提供 Gitee 镜像以加速国内拉取；主源改用 GitHub API URL，避免 raw CDN 的缓存延迟。

### 🐛 Bug 修复

- **修复 /v1/models 返回孤儿自定义模型**：从旧 9router 数据库导入后，`kv` 表里残留了大量引用已删除自定义节点（providerNodes）的 customModels，导致 `/v1/models` 对每个客户端（如 dsh、CLI 工具）返回成百上千个无效模型。
  - `/v1/models` 现在会过滤掉 `providerAlias` 指向不存在节点、或节点连接已停用的孤儿模型（保留内置 provider 与现存激活节点下的模型）。
  - 删除自定义节点时，同步清理其下的 customModels，避免再次产生孤儿。
- **自定义节点前缀唯一性检测**：创建/编辑自定义供应商节点时，若 prefix 与内置 provider 的 id/alias 冲突、或与其他自定义节点的 prefix 重复，将拒绝并返回明确错误（前端同步显示提示），避免模型路由歧义。
- **修复 CodeBuddy 执行器误删 Agent system prompt**：原逻辑把超过 2000 字符或命中宽松 agent 正则的 system prompt 整段替换为中性文本，导致自家 Agent（Hermes/10Router）每次开新会话失忆。现加入自家 Agent 白名单（原样放行）、去掉长度一刀切，仅替换真正的外部 agent 签名以通过上游内容过滤。
- **新增「从 GitHub JSON 获取模型」通用能力**：provider 可在注册表声明 `modelsJsonUrl`，详情页出现 "Fetch Models" 按钮，拉取该 JSON 并**替换**该 provider 的 customModels（新增 JSON 中的模型、清理已过时/不在 JSON 中的模型）。配套在设置页新增全局开关控制该功能（默认关闭）。目前已接入：CodeBuddy CN / Intl、OpenCode Go、CommandCode（对应 `providers/*.json`）。目录本身也同步更新：CodeBuddy CN/Intl 补充 vision/reasoning/context 能力字段，并新增 `hy4-preview` 模型。
- **Disable All / Active All 改为操作 JSON 目录的 enabled 标志**：此前这两个批量按钮不作用于通过 JSON 目录导入的模型，点击后界面状态与实际启用情况不一致。现改为对 JSON 目录发起批量 PUT（`all: true`），批量启停与单个模型开关走同一份状态。
- **侧边栏版本号不再硬编码**：`APP_CONFIG.version` 此前写死 `1.0.0`，装上 1.0.1 后侧边栏仍显示 1.0.0。改为读取 `package.json` 中的版本号。
- **配额零余额判定与「已耗尽」语义**：余额为绝对零值时才判为耗尽，避免误判；配额行的隐藏状态在多处视图间同步，筛选条件改为持久化保存，刷新后不再重置。批量按钮补齐 i18n，空状态下也提供操作入口。
- **自定义供应商 prefix 大小写不敏感**：prefix 校验改为大小写不敏感并统一归一化为小写，避免 `Foo` 与 `foo` 被视为两个前缀而产生路由歧义。
- **JSON 目录 provider 的过时静态模型可见**：内置静态目录中已不在 JSON 里的模型，会显示在「已禁用模型」中而不是直接消失，便于确认哪些模型被目录更新淘汰。

### ⚙️ 工程与打包

- **移除 `better-sqlite3` 依赖声明**（不影响任何已部署实例）：该包从未真正生效过 —— npm ≥11 默认拦截 install 脚本，作为 `optionalDependency` 它会被整包跳过；即便装上，Next 的 output tracing 也只拷贝其 `lib/*.js`，从不带 `.node` 原生二进制。实测确认 Docker 镜像、fnOS fpk、standalone 包三者**一直都跑在 `node:sqlite` 上**。
  - 数据完全兼容，无需任何用户操作：两者同为 SQLite 3.53.x，四个适配器共用同一份 `PRAGMA_SQL` 并都执行 WAL checkpoint，现存 `data.sqlite` 直接打开即可。
  - `src/lib/db/driver.js` 仍保留 better-sqlite3 探测与适配器 —— npm CLI 用户由 `cli/hooks/sqliteRuntime.js` 装到 `~/.10router/runtime`（自带版本号，与根 `package.json` 无关），那条链路不受影响。
  - 顺带消除了「实际生效的驱动取决于 npm 版本」这一不确定性。
- 🆕 **新增 npm 分发渠道**：CLI 已发布至 npm，`npm i -g 10router-cli` 即可安装，可执行命令为 `10router`。此前分发仅有 Docker / fnOS fpk / Standalone 三种。
- ⚠️ **修正更新检查指向错误的包**：仪表盘的版本检查、「立即更新」拉起的 npx 命令、侧边栏展示的安装命令，以及独立 updater 的兜底包名，此前全部写的是 `10router`——而该名字在 npm 上属于一个无关的 fork（停在 0.6.0）。现已全部指向 `10router-cli`，并让 `/api/version` 复用 `UPDATER_CONFIG.npmPackageName`，消除此前导致该问题的重复常量。
- ⚠️ **CLI npm 包名定为 `10router-cli`**：原定的 `10router` 已被第三方 fork 占用（npm 上停在 0.6.0），v1.0.0 更新日志中「npm 包名更新为 `10router`」一句就此作废。安装命令为 `npm i -g 10router-cli`，可执行命令仍是 `10router`，CLI 版本同步至 1.0.1。
- **CLI README 去除上游残留品牌**：`cli/README.md` 会作为 npm 包详情页展示，但其中的 npm/Docker/GHCR/License/Trendshift 徽章与文档链接仍全部指向上游 `decolua/10router`，会在本包页面上展示他人的版本号、下载量与仓库。现已改为本项目的 `10router-cli` 与 `techysy/10router`，移除 Docker Hub 与 Trendshift 徽章（本项目仅发布 GHCR 镜像），并在致谢中补上对上游 9Router 的署名。
- fnOS 打包 manifest 版本改为从 `package.json` 自动同步（`prebuild:fpk`），并在打包 README 中说明；manifest 对齐 1.0.1。
- 设置页卡片图标容器统一为方形 `size-10`（原为 `p-2` 矩形），并修正 Providers 卡片引用了字体中不存在的图标字形。

## v1.0.0 (2026-08-26)

### ⚠️ 升级注意

1. **数据目录改名**：默认数据目录从 `~/.9router/` 变为 `~/.10router/`（Windows: `%APPDATA%\10router`）。启动时若检测到旧目录存在且新目录为空，会自动一次性拷贝迁移（旧目录保留不删除）。显式设置 `DATA_DIR` 的环境不受影响。
2. **SAML entityID 变更**：默认 issuer 从 `urn:9router:sp` 改为 `urn:10router:sp`。已在 IdP 侧注册过 9Router SP 的用户升级后需在 IdP 重新注册新的 entityID，否则 SSO 登录中断。可在设置中手动改回旧值。
3. **MITM CA 更名**：MITM 代理的 CA 证书随数据目录更名重新生成，已在设备端信任旧 CA 的需重新信任新 CA。
4. **grok config marker 改名**：`config.toml` 中 `# 9router-prev-default` 记录不再被识别，升级后"上一个默认模型"记录丢失一次（仅一次，之后正常记录）。

### ✨ 新增功能

- **品牌重塑**：9Router → 10Router，版本号统一 1.0.0；全局替换 UI 文案、标题、landing page、元数据；品牌区显示 `10Router` + `v1.0.0`；更新日志数据源改为 `github.com/techysy/10router`。
- **i18n**：区域货币显示支持（en/pt-BR/pt-PT/es/de）；区分 CNY（全角 ￥）和 JPY（半角 ¥）；Profile 页面货币切换开关；中文翻译更新。
- **Providers**：免费商家拓扑开关关闭时增加卡片视觉反馈；按连接隔离配额行可见性；提供商拓扑画布开关。
- **Usage**：使用量页面升级上游结构，恢复表格筛选器与周期过滤；修复 ProviderTopology 数据源，使用活跃连接列表替代 byModel；恢复 ProviderTopology 渲染到 Usage Overview 页面。
- **Auth**：登录 cookie Secure 标志按请求协议动态判断；多跳反向代理下按 `x-forwarded-proto` 的第一跳判断协议，避免链路中后续跳把协议改写导致 cookie 标志判断错误。

### 🐛 Bug 修复

- 免费商家禁用文案 i18n 修复
- /v1/models 接口 noAuth 自定义模型遗漏修复
- 健康但无连接的数据库不 dump 完整内置目录
- 修复使用量页面无数据（SQLite 层统一）
- 重新导出 SQLite-layer request/usage APIs 通过 usageDb shim
- /v1/models 过滤已禁用的孤儿自定义模型

### ⚙️ 工程与打包

- **Docker 镜像**：GitHub Actions 自动构建 multi-platform (amd64 + arm64)；镜像 `ghcr.io/techysy/10router:latest`。
- **fnOS fpk 打包**：Matrix 构建 x86 + arm 双架构；每架构提供 url + iframe 双版本（共 4 个 fpk）；文件名 `10router-1.0.0-{arch}.fpk` / `10router-1.0.0-iframe-{arch}.fpk`；安装依赖 nodejs_v24。
- **Standalone Server**：无 Docker 环境的裸机部署包；含 standalone 构建产物 + custom-server.js + node-forge；启动 `node custom-server.js --port 20128`。
- **CI/CD**：`docker-publish.yml`（tag 触发 → multi-platform Docker 镜像推送 GHCR）；`build-fpk.yml`（matrix 构建 x86/arm → 双版本 fpk → 统一 Release 上传）；`build-server.yml`（standalone tar.gz 构建 → Release 资产）；CI Node 22 → 24，对齐 fnOS `nodejs_v24` 运行时；fnpack 1.2.1 固定 sha256 校验和。
- **工程清理**：移除上游 9Remote/9English 广告入口、`NineRemoteButton.js`、`NineRemotePromoModal.js` 组件、Sidebar 中 9Remote/9English 导航项、上游 DockerHub 发布和 GitBook 文档站点；清理开发 artifacts（workbuddy memory、npm 残留文件）；fnOS fpk 打包并入主仓库（fnos-packaging/）；README 重写为 10Router 版；捐赠入口改为本地 donate.json（GitHub Sponsors + 微信 + 支付宝）。
