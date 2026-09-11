# 更新日誌

這裡展示面向用戶的關鍵更新；完整開發明細見 [CHANGELOG.md](https://github.com/techysy/10router/blob/main/CHANGELOG.md)。

## v1.1.0 (2026-09-11)

### ✨ 新增

- **小米 MiMo 桌面版支援（一個供應商、兩種登入）**：`xiaomi-mimo` 現在既支援 sk- API 金鑰（雲 API），也支援小米 MiMo 桌面客戶端帳號 —— 桌面獨佔的 `mimo-x-pro-preview` / `mimo-x-flash-preview` 只認帳號 Cookie，光有 API 金鑰用不了。兩種憑證共用一個供應商卡片，按需啟用即可。
- **小米 MiMo 授權碼登入**：瀏覽器開啟官方授權頁後，即使本機回呼沒接上（或已逾時），也可以把頁面上顯示的授權碼**直接貼上**到對話框完成登入。憑證全程只在伺服器端解密，不經過瀏覽器。
- **CodeBuddy 國際版模型目錄補齊**：逐個用真實請求核對線上服務範圍，補進 5 個真實存在卻缺漏的模型（GLM-5.1 / GLM-5v-Turbo / MiniMax-M3 / Kimi-K2.7 / DeepSeek-V4.1-Flash）與 `GPT 6.0 Astra`。
- **opencode-go 目錄對齊官方公開清單（18 個模型），並為每個模型宣告端點**：以前部分模型因為「端點宣告缺失」被送到錯誤路徑而直接失敗，現在按官方端點表逐條宣告。
- **新增 Codex / OpenAI 的 `gpt-image-2.5` 圖像模型家族**：`gpt-image-2.5`（含 `-flare` / `-sunburst`）、`gpt-image-2`、`gpt-image-1.5`，支援文生圖、圖片編輯與多圖參考。
- **積分徽章支援限時免費促銷**：促銷期顯示綠色 `free`，到期**自動**恢復顯示真實倍率 —— 不再需要有人記得回來改。

### 🐛 修復

- **Windows 桌面版升級不再靜默丟棄舊資料**：桌面版的資料目錄同時也是 Electron 自己的設定目錄，Chromium 會先生成一堆檔案把它撐成「非空」，導致舊資料遷移被永久跳過。現在判據改為「目錄裡是否已經有我們自己的資料庫」。
- **小米 MiMo 授權碼登入的多個真問題**：載荷解密佈局前後顛倒（這才是 `decrypt_failed` 的真因）、平台要求攜帶 `app=MiMo`、回呼路徑改為隨機字串、結果以 302 交回平台；另外回呼監聽器逾時後貼上不再失效。
- **Kiro 請求不再攜帶頂層 `systemPrompt`**（kiro.dev 對它直接回 400 且不重試），端點順序改為 Amazon 面優先。
- **Claude 工具 `type` 改為按供應商開關**：修好 MiniMax 的 Claude 端點（缺 `type` 被拒），同時避免把 DeepSeek 的 Claude 端點打掛（它只認自家 `type`）。
- **Codex 工具 schema 裡它不認的 `\p{...}` 正則會被剝離**：此前只要某個工具的參數 `pattern` 用了屬性跳脫，整個請求就 400，且每個帳號都一樣失敗。
- **Node 24 上跳過 `better-sqlite3`**：它的原生外掛在 Node ≥ 24 上載入即崩潰（行程級），此前會讓整個服務直接死掉。
- **AMD Token Factory 目錄與能力按實測重建**：補上漏登的聊天模型，並修掉「純文字」誤判（圖片會被靜默丟棄）。
- **CodeBuddy CN 的 DeepSeek-V4.1-Flash 輸出上限回落到伺服器公布的 128K**：取大不會報錯，只會讓超過伺服器上限的請求更容易撞 400。
- **同一個供應商不再在停用清單裡存兩份互相矛盾的記錄**：修掉「有些模型看起來沒被停用」的問題。

## v1.0.8 (2026-09-09)

### ✨ 新增
- **新增 AMD Token Factory 供應商**：AMD Radeon Cloud 免費共享 OpenAI 相容端點（`DeepSeek-V4-Flash` 1M 上下文 + `Qwen3.8-Flash-Next` 262K 上下文）；thinking 透過 reasoning_effort 控制，每個模型有獨立的檔位選擇器；形態與 NVIDIA NIM 相同
- **Antigravity 配額主機修復**：配額 summary 改查正確的 daily host（與原生 IDE 一致），修復數字系統性偏差；百分比直讀後端值而非前端重算
- **CodeBuddy 模型目錄對齊服務端（CN + 國際版）**：國際版按服務端目錄重排（新增 Hy4-Preview / Hy3 免費檔、GPT-5.6 Sol/Terra/Luna、GLM-5.3、Kimi-K3 等，移除已下線的舊模型）；CN 站同步對齊——`DeepSeek-V4.1-Flash` 取代 `DeepSeek-V4-Flash`，清掉重複的 `Kimi-K3 (1)`；兩站各模型都標上服務端公布的積分倍率
- **模型列表顯示積分倍率徽章**：走免費額度的模型顯示綠色 `free` 標籤，其餘顯示 `0.79x` 形式的倍率小標籤（hover 有說明）；供應商沒有積分體系時不顯示

### 🔒 安全加固
- **API key HMAC secret 硬化**：內建兜底密文未設定時 production 啟動告警；新增實驗功能「金鑰簽署輪換」（預設關閉），自動產生每實例獨立密文；keyId 生成改用 `crypto.randomBytes`
- **危險操作確認彈窗**：關閉 API 金鑰校驗、啟用/停用簽署輪換、全部重簽均需確認；重簽防重複提交（伺服器 409 + 前端防護）

### 🐛 修復
- **非串流請求被誤判為串流（issue #4）**：省略 `stream` 欄位現在正確預設為 JSON（OpenAI/Anthropic 規範）；此前會傳回 `text/event-stream` + `data: [DONE]` 尾隨，嚴格解析的用戶端全部報錯（OpenAI SDK、WorkBuddy、curl）
- **金鑰輪換確認彈窗卡死 / 反覆重簽**：確認彈窗自動關閉後再執行操作；重複重簽不再堆疊 "(rotated)" 後綴
- **MCP SSE 閒置斷線**：MCP 長連線補 25 秒註解心跳，防止 NAT/防火牆靜默掐斷
- **CodeBuddy CN 白名單誤放行（PR #5）**：Claude Code 自身系統提示不再匹配 agent 身分白名單（此前觸發 11128）
- **GLM-4.6V-Flash 缺視覺能力（PR #5）**：免費視覺模型補註冊正確的 capabilities
- **DeepSeek effort "max" 被 SenseNova 拒絕（PR #5）**：鉗位到 "xhigh" 相容兩家
- **拉取/匯入的模型預設停用（按需啟用）**：「Import from /models」與「Fetch Qoder Models」批次拉回的模型不再一次全部啟用洗版——先落入「Disabled models」區，用到哪個點哪個；`/v1/models` 同步只下發已啟用的模型（此前標了停用仍會下發）。手動單個新增仍立即啟用
- **CodeBuddy CN 誤掛國際版模型（修正）**：此前 CN 目錄混入了只屬於國際版的 GPT/Gemini 家族，選中會報 model service info not found；現已移除（保留在國際版）並加測試守衛
- **DeepSeek-V4.1-Flash 輸出上限被低估（修正）**：能力表把最大輸出寫成 50K（從改名前的舊 id 帶過來），客戶端請求會被據此截斷；已依模型卡更正為 1M 上下文 / 384K 輸出 / 支援圖像輸入 / 思考預設開且可關，並給該模型的兩個別名 id 補上同一套能力

## v1.0.7 (2026-09-07)

### ✨ 新增
- **CodeBuddy CN 內建「總積分」配額行**：用量頁 CodeBuddy CN 第一行新增總積分彙總（全部包即時餘額合計，含每月/贈送包），不用再自己加總；總餘額耗盡時隨「只看有餘額」自動隱藏；「贈送包」行名已翻譯
- **ZCode 用量同步外掛（10router-sync）**：一鍵把 ZCode 本地模型用量帳本匯入 10Router——自動排除指向 10Router 的供應商防重複計數，可重複執行冪等去重；匯入的用量在用量頁與詳情 tab 均可見
- **上游 v0.5.69 擇優移植**：① Google 系多帳號後台刷新改為串行 + 分級抖動，規避反濫用風控；② Anthropic 相容節點掛真 Claude 自動補 context-management beta 頭，修靜默換模型；③ opencode-go 穩定會話，免費池不再觸發風控；④ Responses 並行工具調用修復（不再把 N 個調用併成一個）；⑤ Claude Fable 週配額追蹤；⑥ codex 新增 gpt-6-astra 等模型；⑦ codebuddy-cn 模型目錄對齊服務端契約
- **qoder 目錄刷新 + 圖片透傳**：模型清單對齊服務端，executor 圖片 base64 直傳；儀表盤 Antigravity 配額按家族分組（多帳號隔離優於上游）
- **桌面托盤版更新鏈路 + 選單精簡**：桌面版更新橫幅改指 GitHub Releases（不再錯誤提示 npm 安裝）；托盤選單「檢查更新 / 關於 / 服務啟停」合一精簡
- **copilot 改為 VS Code 擴充指引**：不再用 MITM 攔截，改三步擴充配置（引擎層保留可手動回退）
- **托盤圖示單色化**：macOS template 圖示 + Windows 深淺主題黑白自適應

### 🐛 修復
- **`/responses` 根路徑鑑權缺口（安全）**：補入前綴表，該路徑強制 API key 校驗
- **Claude 組合回落的外來 `server_tool_use` 毒化歷史（400）**：按 `srvtoolu_` 前綴校驗並清理外來工具塊
- **MCP 延遲工具破壞快取錨點（400）**：快取錨點改為錨在最後一個可快取工具上
- **gemini schema 元組校驗 400**：`prefixItems` 轉換 + 陣列缺 items 補佔位
- **antigravity 系統提示競爭品牌清洗泛化**：OpenCode 命名不再觸發 429
- **免費模型後台刷新噪音與連線測試懸掛**：降噪 + 15s 逾時

## v1.0.6 (2026-09-05)

### ✨ 新增

- **CodeBuddy CN 每日自動簽到**（實驗性，預設關閉）：`設定 → 實驗性功能` 開啟 "CodeBuddy CN auto daily check-in" 後，CodeBuddy CN 頁面的 Import / Export 按鈕被替換為每日自動簽到（每個帳號在本地時間 00:00–06:00 隨機時刻自動簽到續免費額度，失敗不中斷服務、401 自動重新整理後重試）與「立即簽到」手動按鈕
- **Antigravity 配額對齊官網（5h + 每週雙視窗）**：用量頁 Antigravity 配額重構為主用官網同款 retrieveUserQuotaSummary 介面，每帳號精確顯示 **4 張卡片**（Gemini Models / Claude and GPT models × {5 小時限額, 週限額}），歸一化 100 百分制；介面不可用時回退舊逐模型解析
- **OpenCode Free 目錄對齊官方免費名單**：補入 Big Pickle / MiMo-V2.5 / Ling 3.0 Flash Fin / Nemotron 3 Ultra / Nemotron 3.5 Lightning 五個免費模型；不收官方已下架的 DeepSeek / Laguna 免費檔（避免誤用產生收費）

### 🐛 修復
- **Antigravity `ag/gemini-3.8-flash-*` 404**：模型定址改為各檔 tiered 實體並升級 IDE 指紋至 2.11.0（裸 ID 直傳會 404「Requested entity was not found」）；新增無檔位 `ag/gemini-3.8-flash`（路由到 medium 檔）
- **用量頁「只看有餘額」拉不到新簽到配額包**：修復 CodeBuddy CN 每日簽到新增的滿額包因舊包序號被後續包擠占、被持久化隱藏後顯示不出的問題——改為即時重算隱藏集，有餘額的包（含新滿額包）始終可見
- **免費模型 429 限流友善提示**：免費模型（`oc/*-free`、`contributor-free`、APInex `free/` 前綴等）被上游限流回傳 429 時，不再透傳英文 `rate_limit_exceeded`，改為友善中文提示——上游給了重置時間則顯示「約 N 秒/分/小時後可再試」，否則建議稍後再試或切換付費檔；付費模型與多帳號降級不受影響

## v1.0.5 (2026-09-03)

### ✨ 新增

- **桌面系統列版（Windows / macOS）**：裝完即用的桌面應用——系統列選單（開啟控制台 / 啟動 / 重新啟動 / 停止 / 開機自啟）+ 內嵌視窗，關閉視窗即縮到系統列；與 npm CLI 共享資料、金鑰與連接埠，兩種形態互斥執行。Windows 提供安裝版（NSIS，支援 `/S` 靜默安裝）與便攜版，macOS 提供 Intel + Apple Silicon 雙 dmg
- **CLI / 桌面版介面多語言**：npm CLI 與桌面系統列自動跟隨系統語言顯示繁體中文、簡體中文或英文，可用環境變數 `TENROUTER_LANG`（`zh-CN` / `zh-TW` / `en`）強制指定
- **Agent 可自助新增自訂供應商 + Skills 頁新增技能**：執行階段用 dashboard LLM key 即可兩步註冊 baseUrl + 上游 key + 模型的自訂 OpenAI/Anthropic 相容節點（免改原始碼/免重新打包）；Dashboard **Skills 頁**新增「10router-add-provider」技能卡片並修正此前連結指向不存在的 `master` 分支（點擊 404），現指向 `main`
- **CodeBuddy CN 帳號 JSON 批次匯入 / 匯出**（實驗性，預設關閉）：`設定 → Providers` 開啟 "CodeBuddy CN OAuth import / export" 後，CodeBuddy CN 詳情頁顯示 Import / Export 按鈕，可用第三方(wb) JSON 格式批次匯入或匯出帳號授權（匯入自動去重、非 CodeBuddy 簽發網域略過）。匯入 / 匯出均需二次輸入 dashboard 密碼確認（防免登入模式下匿名匯出帳號令牌）
- **公益站供應商預設顯示**：GoRouter / TaBiAI 等公益站供應商改為預設顯示（無需再手動開啟開關），列表 / Profile 開關 / 用量拓撲圖三處一致
- **公益站供應商排序歸組**：Free Tier 列表中 GoRouter / TaBiAI 等公益站供應商在 rank 分組內聚成相鄰一塊，不再與一般 freeTier 依 priority/名稱混排
- **新增 Agnes AI 雙站供應商**：國際站 Agnes AI（com）+ 中國站 Agnes AI (CN)，各含 Agnes 2.5 Flash / 2.5 Pro 文字模型（512K / 1M 上下文，視覺+推理）；另含 Agnes Image 2.x Flash 影像生成模型（標準 images/generations 端點，圖生圖/編輯）
- **設定新增「實驗性功能」分組**：Profile 獨立 Experimental 卡片，收納預設關閉的開發向開關（JSON 模型匯入 + CodeBuddy CN 匯入匯出），方便日後擴充
- **新增供應商 APInex（apinex.bond）**：預付美元額度的第三方聚合網關（OpenAI 相容），18 個模型（13 付費 + 5 個 `free/` 前綴免費模型）；供應商頁顯示可複製邀請碼 chip（APInex：`SLEWP68C`）
- **上游 v0.5.65 目錄同步 + 新搜尋供應商**：新增 GLM-5.3-Flash(Vision)、GLM-4.6V、DeepSeek-V4-Flash-Vision-Exp、Grok-4.6、Claude-Fable-5.1 等模型；新搜尋供應商 Ollama-Search（沿用本機 Ollama key）與 Xquik（X/推特搜尋）

### 🐛 修復
- **用量統計 成本/Token 切換後表格錯亂**：修復切換顯示模式並點擊排序後，部分行的 token 數被回退顯示成金額的問題；繁體中文用量表表頭翻譯補齊
- **用量表排序語義**：按 Token / 成本列排序改為按模型合計值排序，與表頭箭頭方向一致

## v1.0.4 (2026-09-01)

### ✨ 新增
- **新增 3 家供應商**：**TokenBom**（去中心化 token 交易市場——閒置 API Key 自動賺積分、積分可調用多種模型，含 79 模型線上目錄）、**GoRouter**（免費網關，無儲值入口）、**TaBiAI**（免費網關，無儲值入口）
- **歷史用量導入**：支援從 9Router 備份導入歷史用量資料（SQLite 檔案），合併統計不覆蓋配置
- **通知體驗優化**：全域通知改為頂部置中 Toast，供應商詳情頁瀏覽器原生彈窗全部替換為友好通知
- **公益站供應商**：GoRouter / TaBiAI 預設不顯示，帶「公益站」標籤；可在 **設定 → Providers → 顯示公益站供應商** 開啟後顯示

### 🐛 修復
- **供應商排序修正**：有連接的供應商前置、已停用沉底，不再被優先級打亂
- **JSON 目錄模型啟用後不顯示**：清理陳舊停用記錄，「啟用了卻不顯示」問題解決
- **B.AI / CodeBuddy CN 模型補全**：切換模型報 "not found" 的缺模型已補齊
- **連接測試友好提示**：供應商端點維護中 / 被 Cloudflare 攔截時，顯示維護提示而非誤導性的 "Invalid API key"
- **帳戶篩選提醒**：配額包帳戶篩選持久化後，非預設篩選時顯示琥珀色提醒條
- **CodeBuddy CN DeepSeek 模型 11150**：DeepSeek 系列呼叫不再因思考強度參數（auto/off）報 400，編碼 agent（dsh 等）可正常使用
- **CodeBuddy 工具呼叫空工具名（11133 / unknown tool）**：串流回傳的空 function.name 已規範化，標準客戶端不再誤判工具名
- **隱藏公益站後拓撲圖仍顯示**：用量頁拓撲圖同步「顯示公益站供應商」開關，關閉後公益站不再顯示
- **Skills 頁面 i18n + 中文版連結**：Skills 頁面文案支援多語言，中文介面下連結指向中文版 skill

## v1.0.3 (2026-08-30)

### ✨ 新增
- **新增 4 家供應商**：**LongCat**（美團）、**SenseNova**（商湯，免費公測）、**Dots**（小紅書 Dots Studio，免費公測）、**B.AI**（聚合平台，一個 Key 通吃 GPT / Claude / Gemini / DeepSeek / GLM / Kimi / Qwen 等家族）
- **自定義供應商支援模型 JSON 目錄**：自定義節點可拉取線上模型清單，逐個停用 / 啟用、批次管理
- **fpk 檢查更新直達 Releases**：fnOS 安裝的更新提示直達對應版本的下載附件

### 🔒 安全加固
- **登入漸進限流**：密碼 5 次失敗 → 30s / 2m / 10m / 30m 逐級鎖定
- **拒絕佔位 JWT 金鑰**：照抄 `.env.example` 的公開金鑰會被忽略，改用自動產生的隨機金鑰
- **修復 npm 包攜帶建置機敏感檔案**：建置產物不再洩漏金鑰 / 機器 ID / 資料快照

### ⚠️ 升級注意
- npm 套件名已改為 **`@techysy/10router`**（舊 `10router` 是本專案無關的 fork）。已裝 `10router-cli` 請改裝新套件，資料目錄不變。

## v1.0.2 (2026-08-29)

### 🐛 修復
- **修復更新檢查指向第三方套件**（1.0.1 受影響）：版本檢查、更新指令、側邊欄安裝指令均指向正確的套件
- **postinstall 不再中斷安裝**：WSL 路徑下 npm 安裝不再因預熱指令碼失敗而中斷

### ⚙️ 工程與打包
- **新增測試 CI**：推送 / PR 時自動跑測試與回歸門禁

> ⚠️ **1.0.1 使用者請升級**：其內建「檢查更新」指向的是一個無關的第三方套件。

## v1.0.1 (未發佈，內容隨 v1.0.2 交付)

> 1.0.1 從未作為正式版發佈（僅 npm 的 `10router-cli@1.0.1` 短暫存在過）。以下內容對 Docker / fpk / standalone 使用者隨 **v1.0.2** 首次到達。

### 🔒 安全加固
- **MITM 安全修復 ×4**：上游轉發恢復 TLS 憑證校驗、根憑證私鑰權限收緊至 0600、不再盲目殺掉佔用 443 的處理程序、自動清理異常退出遺留的 hosts 條目（MITM 預設關閉，未啟用使用者不受影響）

### ✨ 新增
- **已停用供應商沉底**：設定頁開關開啟後，已停用供應商在清單中排到最後
- **桌面側邊欄可摺疊**
- **OpenCode Go 配額用量接入**
- **模型目錄 Gitee 鏡像回退**：國內拉取加速

### 🐛 修復
- **修復 /v1/models 回傳孤兒自定義模型**：不再對客戶端回傳成百上千個無效模型
- **自定義節點前綴唯一性檢測**：避免路由歧義
- **修復 CodeBuddy 執行器誤刪 Agent system prompt**

### ⚙️ 工程與打包
- **新增 npm 分發管道**：`npm i -g 10router-cli`
- **新增「從 GitHub JSON 取得模型」通用能力**（Fetch Models）

## v1.0.0 (2026-08-26)

### ⚠️ 升級注意
1. **資料目錄改名**：`~/.9router/` → `~/.10router/`（Windows: `%APPDATA%\10router`），啟動時自動遷移
2. **SAML entityID 變更**：預設 issuer 改為 `urn:10router:sp`，IdP 需重新註冊
3. **MITM CA 更名**：需重新信任新 CA

### ✨ 新增
- **品牌重塑**：9Router → 10Router
- **i18n 多區域貨幣**：en / pt-BR / pt-PT / es / de
- **多平台分發**：Docker（amd64 / arm64）、fnOS fpk（x86 / arm × url / iframe）、Standalone
