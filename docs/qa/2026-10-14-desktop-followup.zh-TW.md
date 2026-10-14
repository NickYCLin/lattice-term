# 桌面追加需求驗收（第 5～11 項）

日期：2026-10-14。基線：`8104de84a4cf053e12ae52177dbc8443144cee07`。
本輪不重啟既有桌面／MCP，不發布、不部署、不改分享或安全政策。
沒有使用真帳號、受限對話、真 SFTP 主機或私人附件測試。
私人參考截圖只在本機檢視，不納入公開 repository。

## 前置交付

已重新讀取 PR #307：head `61177ffd8fbc437604490c1bb8b542aa558f88f0`，
狀態 MERGED，merge 為上述基線；Linux、macOS、Windows、iOS 檢查均 SUCCESS。
前四項驗收保留在 `2026-10-14-desktop-routes-labels-images.zh-TW.md`，不重派。
已通過的 route 編輯保序、edit／route／new lifecycle identity 不再修改。
未查詢使用者取消的舊 CI，也沒有藉列舉舊 runs 間接查詢。

## 第 2 項延伸：可信供應商欄位

- 原先只有工具／模型／端點名稱，無法據此確認上游供應商。
- Codex app-server 的 `modelProvider` 回報經同 turn event 傳入 thread，
  切模型、工具、帳號或端點時清除過期回報。
- 呈現層只將無自訂端點的官方 `openai` 識別映射為 OpenAI；
  自訂 adapter ID、CLIProxyAPI、Herdr 或模型品牌不推定上游。
  直接 API／自訂端點及未回報資料顯示供應商「未知」，缺模型也為「未知」。
- 自訂標題、帳號名稱、端點名稱與 persisted sidebar identity 不改。
- `conversationLabels` 合成測試包含長名稱、CLI／API、缺值、
  自訂 provider／endpoint、專案與 live node identity；Rust 測試驗證回報接線。
- `modelProvider` 是 adapter 的設定識別，並非第三方上游供應商的獨立證明。
  未使用付費供應商登入或真 API 呼叫作驗收。

## 第 5 項：查看代理曾看過的圖片

- 終端的 `Viewed image` 標記現在可開該 session 的圖片 gallery。
  使用者附件與工具觀察分區，不把 `[Image #n]` 猜成全域索引。
- 可解析原生歷史中的 `view_image` 本機引用、工具結果內嵌的 image pixels。
  顯示工具步驟與可得時間。工具結果像素標為當時靜態截圖，
  本機引用標明可能是目前檔案，不假稱重建了當時內容或即時畫面。
- 僅使用既有授權範圍：工作目錄／session cache、既有工具結果。
  不下載任意外部 URL、不新增跨主機讀取、攝影或公開上傳。
- 保存 bounded pixels／不可覆寫的雜湊 metadata；讀取拒絕 symlink、
  非 regular file、不符雜湊或超界路徑，寫入採私有暫存與 noclobber。
  已保存記錄可於缺歷史時重看；達數量／容量上限明示截斷。
- Rust `transcript::images` 8 項通過，包含來源隔離、時間、缺歷史、
  私有權限、symlink 與外部寫入衝突；gallery 元件含切換、延遲回覆、
  多圖、missing、重新整理與重開。Chromium 真鍵盤驗證預覽及 Escape 關閉。
- **限制**：只有文字、沒有原圖或 cache 的工具步驟不能還原像素；
  目前提供缺資料狀態，不保證每一種工具／供應商格式都有逐步圖片占位。
  未讀真受限 sessions，未聲稱全部 live tool events 已統一來源 metadata。

## 第 6 項：摘要交接到新助理

- 工作階段與對話頁使用同一個 `ConversationHandoffDialog`。
  可檢視／編輯摘要、選工具／帳號／已有 API 端點及模型，再明確確認。
  來源名稱與「摘要，不是完整記憶／同一原生 thread」在送出前揭露。
- 可讀的既有 export／可見 chat messages 為來源；缺歷史或匯出失敗則
  明示手動輸入，不嘗試跨帳號取回不可讀紀錄，不含隱藏推理。
  已知密鑰形狀先遮蔽；編輯後若需再次遮蔽，先顯示改後文字再確認。
  遮蔽不是所有秘密的偵測保證，仍需使用者檢視將傳內容。
- 原 session／thread 保留；保留可相容的來源 sandbox／permission，
  無相容權限時採 read-only，不為交接升權。
- 忙碌時禁止重複確認；失敗保留摘要可重試。
  Chat 同摘要／目標重試沿用已建立的 recipient，不另造重複 thread。
  工作階段沿用既有私有 handoff file 與 seedInput 啟動路徑。
- 未登入／額度不足需恢復帳號或明確選另一可用目標，不能由摘要绕過。
  程序關閉、context 上限、resume 無效、缺檔是不同限制；
  截圖中的 OAuth 錯誤不證明本機紀錄必然遺失。
- 元件測試含缺歷史、手填、取消、目標失敗重試、雙擊、遮蔽檢視、
  API 缺模型與端點 identity。真 Chromium Tab／Enter／Escape 驗證焦點返回。
- 新窄視窗 red：320×480 時 dialog top `-12.34`、bottom `490.41` 超界。
  專用可捲動 max-height 修正後 top `19.39`、bottom `458.68`，仍可操作。
  記錄：`/tmp/lattice-followup-browser-narrow-before.log`、`...-after.log`。
- **未驗**：兩個完整 App 頁面入口到真外部供應商的端對端交接、
  真登入／額度失敗、全部帳號組合。共用元件及合成 IPC 不冒稱此層已通過。

## 第 7／10 項：終端裁切與無效 fit

- 真 xterm／FitAddon＋產品 CSS 的基線，在 320／760／1280 寬
  screen 與 scrollbar 重疊 15／12／14 px。
  原因是 `.agent-terminal` 父層 padding 被 FitAddon 的可用寬計算漏扣，
  不是 app 底部 statusbar。修正該 host padding 為 0，不硬改 PTY 欄數。
- 修正後三種寬度重疊均 0；light／dark × CSS zoom 1／1.25／1.5
  重疊均低於 1 px，保留 scrollbar 與既有 render guard。
- 實際計時基線 20 次 write 造成 20 render／21 refit、0 cols／rows 改變；
  修正後 20 render／1 額外 fit，idle 2.2 秒無新增 render。
  10 次合成背景更新沒有新增 terminal mount／render。
- **不是已定位 Windows 閃爍**：靜態圖無法證明頻率或 GPU 原因；
  此量測只證明裁切與每次 render 的無效 refit，沒有證明 Windows
  安裝版間歇閃爍、完整 App 跨頁 remount 或自發 idle 重繪已根治。
  較早 virtual-time 無 render 的量測不採計。

## 第 8 項：大量 Skills 掃讀

- 保留 metadata-only 探索：搜尋名稱／說明、來源篩選、清除、
  無結果狀態，使用原生 details 展開說明，避免完整卡片不斷膨脹。
- 切探索目標清除篩選且隔離舊請求；相同 metadata 去重，
  同來源／名稱但不同說明仍保留，數量與實際 distinct 項目一致。
- 合成 200 項測搜尋、來源、清除、空結果／切目標，
  真 Chromium 小視窗與 Tab 焦點可用。未讀任何 Skill 指示內容或登入資料。

## 第 9 項：Codex 封存失敗可恢復

- 確認基線已有同步封存入口，不是完全沒有跨側機制。
  red：backend 拒絕後，`getThread(id)` 已變 undefined，失敗被吞掉。
- 現在依 thread ID 管理 pending，官方確認成功才移除本地列；
  失敗保留來源與錯誤、可重試；重複點擊不重送。
- Backend 使用已選帳號的官方 app-server `thread/archive`／`thread/unarchive`，
  比對 RPC ID／回覆，不再以 rollout 檔案位置推定封存成功。
  timeout 明示結果未知且保留本地，不自動無限重試。
- Codex 不新增永久本地 dismiss；近期成功封存提供還原，
  保留其他帳號 tombstone。沒有呼叫永久 `thread/delete`。
- 前端 mock 拒絕／成功／還原失敗／重試／雙擊；Rust 合成 executable
  確認 CODEX_HOME、同 native ID、官方方法及 matching reply。
  既有 start `ephemeral=false` 與 exact ID resume 回歸一起通過。
- **限制**：近期還原 receipt 只在本視窗生命週期，重開後可由官方工具還原。
  未實測真 Codex Desktop 雙側可見、外部封存還原、並行修改、離線重連；
  不承諾跨裝置雲端同步。既有 native catalog refresh 不等於全格式同步驗收。
  `thread/list` 的 `sourceKinds` 預設 cli／vscode、appServer 需考量；
  尚無本機證據可斷定它是使用者列表差異原因，沒有改 Desktop 的設定。
- 官方資料核對：Codex app-server 文件的 list／resume／archive／unarchive／
  delete 具不同語義；Herdr agent-automation 文件是 CLI／socket 的 lifecycle，
  不能據此宣稱 Herdr 提供跨工具原生 thread 同步。本輪未安裝 Herdr。

## 第 11 項與 MCP／SFTP 可理解性

- **UI 確定缺陷**：已知空目錄成功後，另一個 listing 失敗仍顯示空目錄。
  現在 open 清除舊 directory、同步 requested path；失敗顯示未知／錯誤，
  不宣稱新目的目錄為空，未成功 listing 時關閉寫入控制。
- 同一路徑重複請求合併；ticket／session 隔離過期結果。
  測刷新重試、回上層、重連、延遲舊回覆與 double open，2 項通過。
  StrictMode 相鄰測試改驗去重後 exact 1 listing、peak concurrency 1。
- 上傳仍要求私有 0600：mode 不符與缺 mode 有不同訊息，
  Windows POSIX mode 回報不代表可驗 ACL；無可信驗證仍拒絕。
  沒有 chmod 放寬、改 host ACL、自動重傳或隱藏失敗。
- 合成 server 驗 staging 驗證／清理失敗不寫 payload、碰撞不覆蓋、
  publish rename 失敗恢復原檔、恢復失敗保留可追蹤 backup；
  原有取消／unknown outcome 狀態測試一併執行。
  `sftp_transfers` 14 passed／7 ignored；ignored 是需隔離 OpenSSH 環境的測試。
- **不宣稱 Windows SFTP ACL 相容已修**。metrics timeout 與上傳權限
  是分開問題；截圖不能證明 listing 同時失敗，未接真主機診斷。
- README 中「SSH／SFTP 一律逐項授權」與實作矛盾已更正：
  live SFTP 自動提供帳號家目錄 root 內的 listing／transfer，可暫停；
  SSH 指令逐筆確認、額外 roots 與主機 metrics 有各自授權。
  本輪不改 grant，也不再造 SFTP MCP。
- coordinator 提供的 Linux schema／grant 快照證明該 host 已有 SFTP tools，
  當下卻沒有 SFTP target；不證明使用者另一 client 的快取、host、版本相同。
  `desktopSshSftp` 是相容群組 ID，不是當前 target protocol，不改公開 ID。

## 驗證與可重跑證據

- `npm run typecheck`：通過。
- `npx vitest run`：235 files passed／1 skipped，1647 tests passed／1 skipped。
- `npm run build`：通過，入口 362.28 KiB（限制 500 KiB）。
- Rust fmt／check／debug build 通過；agent_chat 82 passed／6 ignored、
  transcript images 8 passed、SFTP 14 passed／7 ignored。
- 本輪 debug binary SHA-256：
  `06db3bad112f1072b1e291ef64a3ca7c563f4c17963d35ed439365f123ecce32`。
  先 build 當前 Rust，再以隔離 Vite 使用當前前端，不把舊已存在 binary 當新版本。
- `LATTICETERM_E2E_KEEP=1 scripts/linux-clipboard-e2e.sh`：PASS，
  artifacts `/tmp/latticeterm-clipboard-e2e.lsK0Q2`。
  真 WebKitGTK／PTY／X11：Ctrl+V、Ctrl+Shift+V、Ctrl+C，
  合成 2048×1536 PNG mode 600、取消／焦點／重複操作、disconnect staging 清理。
  私有 Xvfb／D-Bus／HOME／TMP，依精確 PID／nonce 清理，不接現行 display／MCP。
  此輪 DESKTOP_UI=0，不冒稱工具圖片與兩頁交接已由真 IPC 全驗。
- `LATTICETERM_E2E_CHROMIUM=/usr/bin/google-chrome node scripts/desktop-followup-e2e.mjs`：
  PASS，`/tmp/lattice-followup-gui-vEhsHO/evidence.json` 保存上述幾何／事件。
  這是實際 React／xterm／鍵鼠、合成 IPC，不是 Windows 安裝版。
  既有 headless shell 在本機無可用 sandbox；改用已安裝 Chrome 標準 sandbox，
  未安裝新瀏覽器、未使用 no-sandbox 繞過限制。
- logs：`/tmp/lattice-followup-typecheck-final.log`、`...-vitest-final.log`、
  `...-build-final.log`、`...-rust-final.log`、`...-linux-gui-delivery.log`。

## 交付追蹤

本輪程式與回歸完成；遠端 head、必要 CI、PR／merge 結果於交付後續更新。
未驗證項目保持上述限制，不因 CI 綠燈改寫成實機完整通過。
