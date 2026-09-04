# 更新日誌

這裡展示面向用戶的關鍵更新；完整開發明細見 [CHANGELOG.md](https://github.com/techysy/10router/blob/main/CHANGELOG.md)。

## v1.0.6 (2026-09-05)

### ✨ 新增

- **CodeBuddy CN 每日自動簽到**（實驗性，預設關閉）：`設定 → 實驗性功能` 開啟 "CodeBuddy CN auto daily check-in" 後，CodeBuddy CN 頁面的 Import / Export 按鈕被替換為每日自動簽到（每個帳號在本地時間 00:00–06:00 隨機時刻自動簽到續免費額度，失敗不中斷服務、401 自動重新整理後重試）與「立即簽到」手動按鈕
- **Antigravity 配額對齊官網（5h + 每週雙視窗）**：用量頁 Antigravity 配額重構為主用官網同款 retrieveUserQuotaSummary 介面，每帳號精確顯示 **4 張卡片**（Gemini Models / Claude and GPT models × {5 小時限額, 週限額}），歸一化 100 百分制；介面不可用時回退舊逐模型解析
- **OpenCode Free 目錄對齊官方免費名單**：補入 Big Pickle / MiMo-V2.5 / Ling 3.0 Flash Fin / Nemotron 3 Ultra / Nemotron 3.5 Lightning 五個免費模型；不收官方已下架的 DeepSeek / Laguna 免費檔（避免誤用產生收費）

### 🐛 修復
- **Antigravity `ag/gemini-3.8-flash-*` 404**：模型定址改為各檔 tiered 實體並升級 IDE 指紋至 2.11.0（裸 ID 直傳會 404「Requested entity was not found」）；新增無檔位 `ag/gemini-3.8-flash`（路由到 medium 檔）
- **用量頁「只看有餘額」拉不到新簽到配額包**：修復 CodeBuddy CN 每日簽到新增的滿額包因舊包序號被後續包擠占、被持久化隱藏後顯示不出的問題——改為即時重算隱藏集，有餘額的包（含新滿額包）始終可見

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
