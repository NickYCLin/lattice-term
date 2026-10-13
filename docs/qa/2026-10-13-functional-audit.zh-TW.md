# 2026-10-13 功能覆蓋與失敗路徑檢查

## 範圍與驗收層級

本輪以 main `4a6a8ec` 為基線，核對功能文件、待辦、前後端測試，
再用隔離 fixture 重現失敗路徑。不是安裝版的全功能驗收，也不代表沒有其他 bug。
未重啟目前提供 MCP 的桌面程式，未調整分享、安全權限或讀取受限工作階段，
未刪除使用者資料，未部署或正式發布。

開始時遠端 main 已同步，GitHub 無開啟中的 issue／PR，
亦無尚未合入 main 的遠端分支。這是本輪開始時的快照，不是永久狀態。

驗證分成四層：

1. 原始碼與文件核對：確認承諾、入口和限制。
2. 單元／React hook fixture：控制延遲、錯誤與事件順序。
3. loopback 整合：啟動測試專用程序與暫存資料夾，不碰既有服務。
4. 安裝版／實機：本輪未驗，不能用前三層替代。

## 功能覆蓋盤點

| 項目 | 本輪證據 | 邊界與未驗證部分 |
| --- | --- | --- |
| terminal、輸出與工作階段還原 | 前端完整測試；桌面 Rust lib 測試涵蓋本機 PTY、輸出、工作階段與持久化 | 真實桌面鍵盤、resize、視窗關閉／重開未操作 |
| SSH／SFTP／RDP／VNC／Remote 連線 | 五種 disconnect hook 新增失敗／重試案例；既有 reconnect 測試；RDP 6、VNC 9 個 Rust 測試；桌面 loopback SSH fixture | 未連線外部正式主機；RDP／VNC 真實畫面與認證提示未驗 |
| Agent 管理、佇列、背景與取消 | 完整前端及桌面 Rust 測試；新增跨工作階段佇列競態；斷線入口新增錯誤／防重複 fixture | 真實 CLI 長回合、OS 登出、背景重開未驗 |
| MCP 分享、撤銷、readiness | 桌面 Rust lib 內既有 Fleet scopes、revocation、loopback 與 MCP 測試；文件邊界核對 | 未改分享設定；現行 MCP 服務、外部 client readiness 不以 fixture 當驗收 |
| Remote 命令與取消 | 新增延遲 snapshot、錯誤清除、舊 start／cancel 失敗及 A→B→A fixture；Remote lib 106 個測試 | RemoteCommandPane 現以 sessionId 作 key，實際 UI 通常會重掛載；hook 重用缺陷不宣稱是安裝版切頁已重現 |
| Remote 對話與文字編輯 | chat_e2e 1 個、text_files_e2e 3 個 loopback 測試，包含多區塊 UTF-8 寫入與外部衝突拒絕 | 不代表外部 Relay／正式主機／真實 GUI 的驗收 |
| 對話、模型、附件與專案預設 | 前端全量涵蓋 accountModels、chatClipboard、queue、handoff、conversation、專案設定；桌面附件與對話測試 | 未用供應商金鑰實際問答；真實 Ctrl／⌘+V、麥克風、模型切換與專案預設操作未驗 |
| Vault、backup、檔案安全 | 桌面 Rust lib 既有測試及 Remote 文字衝突 fixture | 未解鎖／搬動使用者保管庫或備份，未調整安全設定 |
| 返回、取消、重試與重複操作 | 本輪聚焦斷線重試、防連按、Remote 舊回覆及佇列跨頁；既有對話／連線測試一起重跑 | 尚無全頁 GUI 導覽覆蓋率，不能宣稱所有返回路徑逐項實測 |

## 重現與修正

### 斷線失敗造成仍存活的連線消失

- 重現：hydrate 一個 live session，讓對應 `*_disconnect` IPC 拒絕。
  原本五種 hook 都仍移除列表項目；UI 無法再重試該連線。
- 修正：只有 IPC 成功才移除；失敗保留連線並撤銷 intentional disconnect 標記。
  Remote 也保留 saved-code reconnect 所需資料；SFTP 不再提前標記已移除。
- 回歸：`sessionDisconnect.interaction.test.tsx` 的五種協定案例；
  `useRemoteSessions.reconnect.test.tsx` 驗證失敗後的 closed 事件仍可重連。

### Remote 命令舊結果污染新工作階段

- 重現：舊連線 state 請求延遲，切換連線後再回覆；原 hook 顯示舊 snapshot。
  舊讀取曾失敗時，切健康連線也未清除錯誤。
- 修正：以 session 與 generation 同時防守讀取、事件、start、cancel 回覆；
  切換連線清除錯誤，cleanup 使舊回覆失效。
- 回歸：`useRemoteCommand.interaction.test.tsx`，另涵蓋 A→B→A、
  舊 start／cancel 拒絕不污染新連線，也不再偷偷 refresh 舊連線。

### 舊佇列保存完成後遮蔽新佇列

- 重現：first 保存 pending，切 second 並讀取，first 保存完成，second 才回覆。
  原本舊保存觸發 refresh、推進讀取序號，導致 second 結果被當成過期，畫面為空。
- 修正：保存後刷新、錯誤與 editing 狀態更新都必須屬於同一 session generation。
  已送到後端的舊保存仍完成，不重送要求。
- 回歸：`useSessionPromptQueue.test.tsx` 的延遲保存／切換案例。

上述原碼重現有 red 記錄：五種斷線與兩個 Remote 命令案例共七項失敗，
佇列案例另外失敗；修正後全部轉綠。

### 斷線入口沒有錯誤回饋／連按防護

- 原碼核對：SessionsView 的 header 與多 CLI 關閉按鈕直接 `void` 呼叫 async，
  沒有 catch 或 pending 防護。backend 拒絕時沒有可見提示。
- 修正：兩個入口統一用 `useSessionClose`；同一 session pending 時不再送第二次，
  顯示可關閉的警告，失敗後可重試；其他 session 仍能獨立關閉。
  關閉完成時也改檢查最新選取，避免等待期間切頁後仍用舊 active 清除新頁選取。
- 驗證：新增 hook fixture 三項，證明錯誤不向外逸出、重試可行，
  同一 render 的連按也僅送一次。這是程式入口核對與 fixture 驗證，非真實 GUI 重現。
  刪除確認視窗原有的錯誤處理保持不變。

## 執行結果

### Windows CI 發現驗收清單未同步

PR 第一輪完整 Windows CI 在 `A tools and sharing` 失敗：實際工具清單含
`read_saved_connection_credential`，驗收腳本卻漏列。該工具已存在於基線，
不是本輪新增，也不是洩漏使用者憑證。
新增 source contract 測試比對 Windows 預期清單與 Rust `TOOL_NAMES`，
先確認測試失敗，再補上遺漏項目；另外在隔離 Windows fixture 檢查未授權
credential 查詢仍回錯誤。不改產品權限、不讀使用者憑證、不忽略失敗檢查。
Windows 原生程序與 named-pipe／ConPTY 結果仍以更新後 CI 重跑為準。

| 指令／檢查 | 結果 |
| --- | --- |
| `npm run check` | 通過：typecheck、i18n／sidecar／版本／Actions 檢查、223 files／1599 tests、production build |
| frontend bundle check | 入口約 359 KiB，小於 500 KiB 限制 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | 通過 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通過 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通過 |
| desktop `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 957 passed、38 ignored；ignored 不列為通過 |
| Remote `cargo test --manifest-path crates/lattice-remote/Cargo.toml --features agent --lib` | 106 passed |
| RDP／VNC `cargo test --manifest-path crates/lattice-{rdp,vnc}/Cargo.toml` | 分別 6／9 passed；實際分開執行，不傳 `--lib` |
| Remote `--features agent --test chat_e2e` | 1 passed |
| Remote `--features agent --test text_files_e2e -- --include-ignored` | 3 passed，僅測試專用 agent、暫存目錄及 loopback |

最初 RDP／VNC 使用 `--lib` 時回報沒有 library target，已改以實際 binary crate
的 `cargo test` 重跑並成功；不把該失敗呼叫算成成功。

## 仍待實作與真阻礙

- 功能文件仍列 NAT 直連穿透、桌面遠端 panes、Windows workspace 隔離與
  更完整的網路／資源限制、跨裝置雲端續跑；不是本輪發現的退化 bug。
- 對話 parity 尚列 Gemini elicitation、內嵌瀏覽器／產物管理、直接管理外掛權限、
  更完整模型能力選擇器等缺口；不以 Codex Desktop 的所有能力皆已支援來描述。
- 記憶目前沿用各 CLI 原生規則，不是不同模型的內部記憶自動互通。
- Browser runtime 嘗試失敗：`No Codex IAB backends were discovered`。
  因此沒有真實 GUI／剪貼簿／麥克風證據。不得為此重啟提供 MCP 的現行程式。
- macOS／Windows／iOS／Android 實機、外部 Relay 與商業供應商實際回覆未驗；
  CI 只能補其 workflow 實際執行的檢查，不能補實機操作。

## 交付邊界

程式修改以功能分組 commit，push 前重新同步 main 並重跑前端完整檢查，
透過工作分支 PR 檢查 CI 後合回 main。遠端 commit／CI 結果以交付時的
GitHub 記錄與最終回報為準。本報告不提前宣稱 CI、安裝版或發布成功。
不 dispatch 發布、不合併 release PR、不安裝新版本。

## 2026-10-14 獨立審查補修

- coordinator 提供的 queue-race 時序在 repo 再次重現：first 編輯回 false，
  first refresh 尚未完成時切 second；舊 refresh 返回後仍設定舊衝突錯誤。
  現在 await 返回後再次檢查 session 與 generation，不重送編輯。
- Windows 大小寫與斜線方向原本拆成不同專案，磁碟根目錄也被去掉斜線。
  現在識別鍵統一 Windows 斜線與大小寫，但保留原目錄呈現和既有側欄 node ID；
  C:/ 與 C: 仍區分，POSIX 大小寫保持不同。
- Windows 預設改用 v2 正規化鍵，讀取時相容掃描 v1 等價路徑。
  舊資料不改寫、不刪除；不同預設（含權限）明確報衝突，拒絕套用。
  明確重新保存優先於舊值，清除以 v2 空值記錄阻止舊值復活。
  v1 的 C: 無法證明來自絕對根目錄，明確報衝突並阻止自動建立對話，
  不擅自把該權限套給 C:/，也不默默回退最近設定。
- 新增回歸最初 7 failed／5 passed；修正後針對測試通過。
  完整 npm run check：224 files／1611 tests、typecheck、production build 通過。
  沒有重做已通過的 close-focus 修正。
- coordinator 回報實機 MCP 已使用既有分享，經 capabilities／授權目標／state／read，
  同一 conversation 為 integration/done/ready=true、queued=0，派送回覆
  sentImmediately=true、duplicate=false，後續在原對話完成工作。
  此為 coordinator 提供的實際就緒派工證據，不包含撤權、取消、其他供應商或 GUI 全驗收。

### iOS 啟動診斷

先前 run 38425920884 attempt 2：iPhone 與 iPad 已辨識連線頁，Pro Max
最後 PNG 為白畫面，OCR 僅狀態列，補截圖與系統 log 也逾時。
不能據此宣稱 App 崩潰，也不能當成只有 OCR 誤判。
新增失敗診斷各自記錄 host process、模擬器 process、WebKit／App log、
CoreSimulator host log，及使用已通過 iPhone 圖片的獨立 OCR 探針；
每項都有個別完成或逾時記錄，不改原機型、畫面要求、90 秒期限或停擺上限。
Python smoke 25 tests 與來源 digest／架構／SHA／run 驗證測試通過。

workflow_dispatch 可選既有 unsigned 產物做診斷：來源必須是本 repo 已完成的
iOS verification workflow，核對完整來源 SHA、run、架構、未簽署旗標、
SHA-256，再安全解壓到新的隔離目錄。此模式不建置、不發布、不用 Apple 金鑰，
證據明確標記 currentBuildAcceptance=false，不冒充目前程式版本的完整驗收。
實際 CI 與診斷結果以後續交付紀錄為準。
