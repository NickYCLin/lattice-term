# LatticeTerm 介面實作說明

文件版本：1.2
更新日期：2026-08-22<br>
對應文件：[UI/UX 設計規格書](UI_UX_DESIGN_BRIEF.zh-TW.md)  

本文件說明前端與桌面端元件的架構實作、狀態管理以及與設計規格書的對照。

---

## 1. 元件與畫面結構

| 區域 | 核心元件 | 實作檔案 | 職責與特性 |
|---|---|---|---|
| **全域導覽** | `NavRail` | `src/components/shell/NavRail.tsx` | 56 px 側邊導覽列，支援 Tooltip、主題快速切換與無障礙指示條。 |
| **資源側欄** | `ResourceSidebar` | `src/components/shell/ResourceSidebar.tsx` | 280 px 側欄，包含關鍵字搜尋輸入框、群組分組統計、環境標籤與釘選篩選。 |
| **工作區標頭** | `ViewHeader` | `src/components/shell/ViewHeader.tsx` | 顯示當前檢視標題、說明與側欄展開/收合切換按鈕。 |
| **連線檢視** | `ConnectionsView` | `src/views/ConnectionsView.tsx` | 連線卡片、排序控制項、非機密 JSON 匯出/匯入與空狀態引導。 |
| **連線卡片** | `ConnectionCard` | `src/components/connections/ConnectionCard.tsx` | 玻璃質感卡片，整張卡開啟詳細資料，星號與操作按鈕為同層元素。 |
| **連線詳細面板** | `ConnectionInspector` | `src/components/connections/ConnectionInspector.tsx` | 344 px 右側面板，分「連線資訊」與「主機狀態」兩個分頁。 |
| **主機資源面板** | `HostMetricsPanel` | `src/components/connections/HostMetricsPanel.tsx` | CPU、記憶體、磁碟與開機時間的量表；尚未連線時顯示原因而非假數值。 |
| **新增/編輯抽屜** | `ConnectionDrawer` | `src/components/overlays/ConnectionDrawer.tsx` | 抽屜式連線表單，支援即時驗證、Tab 焦點循環鎖定與重複目標提醒。 |
| **命令面板** | `CommandPalette` | `src/components/overlays/CommandPalette.tsx` | `Ctrl` + `K` 全域命令面板，支援搜尋連線與執行全域快捷動作。 |
| **工作階段** | `SessionsView` | `src/views/SessionsView.tsx` | 統一管理 SSH 終端機、SFTP 檔案、Lattice Remote、Web RDP 與 VNC Canvas 分頁；執行中的 Agent 分頁可雙擊或按鉛筆就地改名，名稱由後端持久化（重載視窗仍在），並在續接面板點選偵測到的 session 時帶入備註；SSH 分頁可沿用同主機／同認證開啟 SFTP，Lattice Remote 在主機另行授權檔案分享時也可展開同一加密連線的檔案側欄。 |
| **AI Agent Fleet** | `AgentsView` | `src/views/AgentsView.tsx` | 本機多 CLI 啟動、Reporter 狀態、批次提示與忙碌時排入佇列、帳號設定檔（`AgentAccountProfileDialog`，目錄由 LatticeTerm 自動建立）、Linux 的沙箱勾選（`runtime.agentSandboxAvailable` 才顯示）、可命名排序的安全啟動工作區，以及同程序 WebView 重載後的 PTY 重新 attach。 |
| **對話** | `ChatView` | `src/views/ChatView.tsx` | 以聊天視窗跟 Claude Code、Codex 或 Gemini CLI 溝通（介面稱「助理」）：可建資料夾整理的對話串側欄（`ChatThreadTree`）、排程分頁（`AutomationPane`）、串流回覆、工具／思考／核准卡片、依助理分組的單一模型下拉（`ModelField`）、結束統計與卡片式輸入框。資料模型與事件折疊在 `src/app/agentChat.ts`，排程在 `agentAutomations.ts`，資料夾在 `chatThreadLayout.ts`，Markdown 讀取器在 `chatMarkdown.ts`；狀態由根層 lazy 元件 `ChatRuntime` 承載。 |
| **SFTP 檔案工作區** | `SftpPane` | `src/components/sftp/SftpPane.tsx` | 遠端路徑瀏覽、上下載、建立資料夾、改名與確認刪除。 |
| **分享這台裝置** | `RemoteHostDialog` | `src/components/remote/RemoteHostDialog.tsx` | 視窗高度限制在遮罩可用空間內，設定與警告內容獨立捲動，標題及開始／停止分享按鈕保持可見。底部送出按鈕透過 `form` 關聯保留原生欄位驗證與送出行為。 |
| **Web RDP Canvas** | `RdpPane` | `src/components/rdp/RdpPane.tsx` | Canvas 畫面、座標縮放、滑鼠、滾輪、掃描碼鍵盤與失焦釋放。 |
| **金鑰保管庫** | `VaultView` | `src/views/VaultView.tsx` | 管理 Rust 核心的主機信任、認證參照與 Argon2id／XChaCha20-Poly1305 加密保管庫；可建立、解鎖、鎖定、改主密碼及切換認證後端，但不把密碼內容交給前端。 |
| **活動中心** | `ActivityView` | `src/views/ActivityView.tsx` | 以鈴鐺與未讀數提示 CLI 執行中、等待回覆及完成狀態；支援直接返回工作階段、全部標為已讀、跨重啟保存與 `Ctrl` + `Alt` + `U`。同頁保留連線操作日誌的搜尋、篩選與匯出。 |
| **設定檢視** | `SettingsView` | `src/views/SettingsView.tsx` | 外觀設定、安全機制、加密備份／還原與執行環境資訊。 |
| **加密備份面板** | `EncryptedBackupPanel` | `src/components/settings/EncryptedBackupPanel.tsx` | 收集 allowlist 設定、要求 12 字元以上密碼、匯出加密檔，並在明確確認後執行完整驗證、逐檔原子替換與失敗回滾。 |
| **狀態列** | `StatusBar` | `src/components/shell/StatusBar.tsx` | 28 px 底部狀態列，顯示連線數、記憶體/儲存模式與認證儲存區就緒狀態。 |

玻璃面板以 `isolation: isolate` 明確建立獨立堆疊，不依賴背景模糊效果。
因此即使模糊效果停用或不可用，專案側欄的固定標題、搜尋列仍不會蓋過
導覽提示；導覽列層級維持低於全域對話框，提示也不會攔截點擊。

---

## 2. 狀態管理與領域模型

- **連線領域模型 (`src/domain/connection.ts`)**：
  - 定義 `ConnectionProfile`、`ConnectionDraft`、`Protocol` 與 `Environment`。
  - 嚴格驗證主機名稱（排除空格、scheme 與路徑）、連接埠範圍（1-65535）與標籤正規化。
- **安全匯出/匯入 (`src/domain/export.ts`)**：
  - 實作 `serializeProfiles` 與 `parseAndValidateImport`，過濾所有機密，驗證匯入格式。
- **活動日誌模型 (`src/domain/activity.ts`)**：
  - 提供 `filterActivity` 與 `exportActivityLogText`，維護最新 200 筆視窗活動紀錄。
- **Agent 活動模型 (`src/app/agentActivity.ts`)**：
  - 將同一分頁內多個 CLI 合併成一個工作活動，最多保存 100 筆名稱、CLI、資料夾、狀態與時間；不保存提示、終端輸出、認證、程序 ID 或供應商 Token。
  - 初次載入現況不會製造未讀通知；只有載入完成後新進入等待回覆或完成的狀態才標為未讀。
- **Workspace Hook (`src/app/useWorkspace.ts`)**：
  - 整合 Profiles 集合、即時搜尋過濾、群組與標籤收集、CRUD 操作與批次匯入。
- **Preferences Hook (`src/app/preferences.ts`)**：
  - 管理六種內建主題與跟隨系統模式、密度（舒適/緊湊）及動態偏好，並同步至 DOM 與 localStorage。
- **加密備份橋接 (`src/app/encryptedBackup.ts`)**：
  - 只收集版本化 allowlist localStorage 鍵；Rust 完成驗證加密後才把密文交給瀏覽器下載，還原時精確移除備份中不存在的 allowlist 設定，避免混合兩台裝置的狀態。
- **Agent Sessions Hook (`src/app/useAgentSessions.ts`)**：
  - 管理本機 PTY 工作階段、語意狀態事件、原生 Session ID 擷取、批次提示，以及安全啟動工作區的名稱、順序與 v3 儲存 command。
  - Codex 的受管續接命令會以 `--cd` 明確指定已正規化的專案目錄，保留續接 ID，避免舊對話的 Windows `\\?\` 路徑或搬移前的目錄再次觸發目錄選擇。進階參數中自行指定的 `--cd`／`-C` 優先保留；不改寫 CLI 的對話檔案。行為依據 [Codex CLI 續接說明](https://learn.chatgpt.com/docs/developer-commands?surface=cli)。

---

## 3. 設計 Token 與樣式體系

樣式層定義於 `src/styles/`：
- `tokens.css`：定義色彩、間距、圓角、字級、陰影與動態時間變數。
- `base.css`：重設瀏覽器預設樣式、焦點環樣式與無障礙文字截斷（`.truncate`）。
- `shell.css`、`connections.css`、`controls.css`、`overlays.css`：元件專用樣式。

---

## 4. 鍵盤操作規範

| 快捷鍵 | 動作 |
|---|---|
| `Ctrl` + `K` | 開啟或關閉命令面板 |
| `Ctrl` + `B` | 展開或收合資源側欄 |
| `/` | 聚焦側欄搜尋欄位 |
| `N` | 開啟新增連線抽屜 |
| `Esc` | 關閉開啟中的抽屜、對話框或命令面板 |
| `↑` `↓` `Enter` | 在命令面板與清單中導覽與確認 |

---

## 5. 多語系

- 語系檔位於 `src/i18n/messages/`，`zh-TW.ts` 是所有鍵的基準，`en.ts` 必須滿足同一個 `Messages` 型別，缺鍵會在編譯時就失敗，而不是在畫面上留下空白。
- 預設語系為繁體中文，可在設定或命令面板切換，選擇會存入偏好設定並同步 `<html lang>`。
- 元件不得直接寫入顯示文字：
  - 欄位驗證回傳 `{ key, values }` 錯誤代碼，由介面翻譯。
  - 匯入問題回傳 `ImportIssue`，含欄位層級的原因代碼。
  - 操作紀錄存的是資料與訊息鍵，所以切換語言後舊紀錄一樣讀得懂。
- 時間與數字使用 `Intl` 並帶入目前語系標籤。

---

## 6. 主題

`src/styles/tokens.css` 提供六種主題，`src/app/themes.ts` 負責目錄與預覽色票：

| 主題 | 說明 |
| --- | --- |
| 深色 | 預設，薄荷綠品牌色 |
| 淺色 | 明亮環境 |
| 午夜藍 | 偏藍深色調 |
| 石墨黑 | 中性灰深色調 |
| 暖砂 | 低藍光暖色調 |
| 高對比 | 關閉半透明與漸層，加強對比 |

另有「跟隨系統」選項，會在深色與淺色之間切換。

質感規則：

- 背景由各主題自行提供 `--app-gradient` 漸層，固定在視窗上不隨捲動位移。
- 浮起的表面統一使用 `.glass`（半透明 + `backdrop-filter`）與 `.glass--sheen`（斜向反光）。
- 高對比主題把 `--glass-blur` 設為 0、`--app-gradient` 設為 `none`，因為半透明與漸層正是這個主題的使用者最不需要的東西。
- 深淺色切換時同時呼叫 Tauri 的 `setTheme`，讓原生標題列跟著換色，避免視窗頂端出現色塊接縫。

---

## 7. 主機資源監控

需求是「連線後要能看到 CPU、記憶體、硬碟」。資料來源已接上：讀數取自該主機的既有 SSH 工作階段。

- 放置位置：連線詳細面板的「主機狀態」分頁。資源屬於某一台主機，不是全域資訊，放在選取的連線旁邊最直覺，也不必為此新增一個一級區域。
- 資料來源：`src-tauri/src/metrics.rs` 在既有 SSH 工作階段上另開一條 exec channel 執行探測腳本，終端機完全看不到探測過程。讀 `/proc/uptime`、`/proc/loadavg`、`/proc/meminfo`、`/proc/stat` 與 `df -P -k`，因此僅支援 Linux 主機；不是 Linux 就誠實回報不支援，不會用殘缺資料湊數字。
- CPU 使用率是真實量測：兩次 `/proc/stat` 取樣間隔一秒計算差值，所以一次讀取約需一秒。拿不到 `/proc/stat` 時退回「1 分鐘負載 ÷ 核心數」的粗估。
- 前端 `src/app/useHostMetrics.ts` 依選取的連線找出活躍 SSH 工作階段，面板開著時每 15 秒更新一次；面板關閉即停止輪詢。沒有工作階段顯示「尚未連線」，非 SSH 協定顯示「不支援」。
- 資料模型：`src/domain/metrics.ts` 定義 `HostMetrics`（CPU 使用率與核心數、記憶體、置換空間、各掛載點磁碟、開機時間、系統負載），並提供容量格式化、使用率計算與嚴重度分級。Rust 端的 `HostMetricsPayload` 欄位名以序列化測試釘住，跟介面讀的名字對齊。
- 狀態機：`unavailable`（未連線／不支援）、`loading`、`ready`、`error`。載入只出現在第一次讀取前；之後畫面保留上一筆讀數，背景更新。
- 顏色分級（正常／注意／危險）一律搭配百分比數字，不單靠顏色判讀。
- 整合測試：`src-tauri/tests/metrics_live.rs` 以拋棄式容器驗證真的讀得到數據、終端機收不到探測輸出、同一工作階段能重複讀取。

---

## 8. 連線設定的存放

- 位置：作業系統的應用程式資料目錄（Windows 為 `%APPDATA%\io.github.nickyclin.latticeterm`），檔名 `connections.json`。放在這裡而不是執行檔旁邊，更新程式不會弄丟資料，多人共用電腦時也會跟著各自的使用者帳號走。
- 內容：只有主機資訊與整理用的標籤。`ConnectionProfile` 沒有密碼、金鑰或通行碼欄位，所以這個檔案可以直接備份或附在問題回報裡而不會外洩。
- 寫入方式：先寫暫存檔再改名覆蓋，寫到一半斷電只會留下前一份完整檔案，不會產生半截檔。
- 讀不到的檔案不會被刪除：會改名保留（`connections.json.unreadable`），介面在設定頁明確告知原因與保留位置，再以空白清單啟動。同樣的情況發生第二次也不會覆蓋掉第一份。
- 版本欄位：檔案標記結構版本，遇到比目前新的版本一樣採取「保留原檔、空白啟動」，避免誤讀。
- 操作紀錄仍然只存在記憶體，關閉即消失，這點沒有改變。

---

## 9. 作業系統認證儲存

- src-tauri/src/credentials.rs 以 profile UUID 與認證種類組成不含機密的帳號鍵；Windows 使用 Credential Manager、macOS 使用 Keychain、Linux 使用 Secret Service。
- Tauri IPC 只公開可用狀態、是否存在與確認刪除；沒有任何命令會把已保存密碼回傳 WebView。
- SSH、SFTP 與 RDP 可使用已保存密碼，或在新密碼驗證成功後保存。若保存失敗，剛建立的工作階段會中止，避免畫面聲稱保存成功。
- useSavedCredential 與 useCredentialInventory 負責連線對話框和保管庫的真實狀態；瀏覽器預覽或系統儲存區鎖定時顯示原因並退回單次輸入。
- 刪除密碼是保管庫與連線對話框中的獨立確認操作，不會因刪除一般連線設定而隱含永久刪除。

---

## 10. SSH 連線

- **實作方式**：採用純 Rust 的 `russh`，不呼叫系統的 `ssh` 執行檔。iOS 不允許執行外部程式、Android 預設也沒有 `ssh`，走這條路才能讓桌面與行動版共用同一套連線核心。
- **密碼學後端**：改用 `ring` 而非預設的 `aws-lc-rs`。後者在 Windows 上需要 NASM 與 C 工具鏈，交叉編譯到 Android／iOS 也麻煩。
- **信任先於連線**：主機金鑰不在信任清單內，連線會被拒絕，並把指紋交回介面請使用者比對；金鑰與上次不同則直接擋下。任何情況下都不會留下一個「還沒決定信任與否」的工作階段。
- **信任資料**：`known_hosts.json` 只存公開指紋（`SHA256:` 格式，與 `ssh-keygen -lf` 輸出一致），指紋本來就是公開比對用的，不是機密。
- **讀不到信任檔時不會退化成空清單**：那會讓原本已信任的主機全部變成「第一次連線」，反而把金鑰變更藏在裡面。這種情況會直接拒絕連線並說明原因。
- **密碼**：預設由對話框輸入並只用於當次連線；使用者可勾選保存，Rust 核心只在驗證成功後寫入作業系統認證儲存區。已保存密碼由 Rust 直接取用，不回傳 WebView。
- **輸出管道**：Rust 端以 `SessionSink` 介面輸出，正式執行時發送 Tauri 事件，測試時收進緩衝區——這是連線流程能對真實伺服器做整合測試的原因。
- **測試**：`src-tauri/tests/ssh_live.rs` 針對真實 SSH 伺服器驗證「拒絕→信任→開 shell→指令有輸出」、密碼錯誤、金鑰變更與連不上四種情況；預設標記 `#[ignore]`，需要時搭配拋棄式容器執行。
- **Key Vault 管理介面**：`useHostTrust` 透過 `ssh_known_hosts`、`ssh_trust_host` 與 `ssh_forget_host` IPC 直接操作同一份信任資料。手動新增只接受完整 OpenSSH SHA-256 指紋，既有主機不可靜默覆蓋，移除前必須再次確認。
- **誠實的執行環境狀態**：網頁預覽沒有 Tauri 後端時不注入 sample hosts；信任檔損壞時顯示安全錯誤並禁止操作。認證資料分頁直接查詢系統儲存區，只列真實參照並在不可用時顯示原因。

---

## 11. SFTP 檔案工作區

- Rust 核心以 `russh-sftp` 建立 SFTP v3 子系統，沿用 SSH 的嚴格主機指紋比對；未知主機必須先確認，金鑰變更直接阻擋。
- `useSftpSessions` 管理工作階段與 Tauri IPC；`SftpPane` 顯示 canonical remote path、目錄優先排序、檔案大小、修改時間與權限。
- 使用者可手動前往路徑、上一層、重新整理、建立空資料夾、上傳、下載、改名與刪除；上傳除了按鈕選檔，也可從檔案總管把檔案拖進面板上傳到目前資料夾。同名覆寫及刪除都要再次確認，不提供遞迴刪除。
- 一般上下載走串流傳輸佇列：Rust 直接把下載寫入系統「下載」資料夾，上傳則以 4 MiB 有界分塊送入後端的同目錄私有暫存檔；收到宣告的完整位元組數並成功關檔後才保護舊檔、替換目標。取消、失敗或工作階段關閉會清理暫存檔，並提供進度、取消與完成狀態。只有供小檔就地讀寫的舊 IPC 指令保留 32 MiB 防護上限。
- 拖曳上傳走另一條路徑：Tauri 的 `onDragDropEvent` 只把本機檔案路徑交給目前作用中的 `SftpPane`，後端 `sftp_upload_path` 直接從磁碟串流到遠端，沿用同一套「先寫暫存檔、完成才改名、失敗清半成品」的保護；同一個已開啟檔案控制代碼會同時用於取得預期大小與串流，來源檔若在傳輸中改變大小就會拒絕發布。介面會合併非同步事件而不讓較舊的初始回應倒退進度，並在完成事件後重新整理目前目錄。目前僅支援單檔，資料夾會被擋下。
- `src-tauri/tests/sftp_live.rs` 可搭配拋棄式 OpenSSH 容器驗證拒絕未知主機、信任後登入與完整檔案生命週期；`src-tauri/tests/sftp_transfers_live.rs` 另驗證大型串流上傳、下載、取消與本機路徑拖曳上傳。

---

## 12. Lattice Remote

- `crates/lattice-remote` 定義版本化二進位訊息、分塊畫面與 Noise `XXpsk3_25519_ChaChaPoly_BLAKE2s` 傳輸。
- 遠端連線依握手協定而非應用程式版號判斷相容性。新版分享使用 OPAQUE 密碼握手後建立 Noise 通道，支援自訂 6～64 字元密碼。桌面與 CLI 可明確選用舊版相容模式連線到長碼主機；舊八位數主機另需既有裝置 ID 信任紀錄，在送出證明前核對永久金鑰。詳見[固定配對密碼](PAIRING_PASSWORD.zh-TW.md)及[版本相容](RELAY_SERVER.zh-TW.md#版本相容)。
- 協定送出、解碼與 frame assembler 共用同一組資源驗證：Agent 名稱最多 256 bytes 且不能含控制字元，Close 原因最多 1,024 bytes；JPEG 最多 8 MiB、單邊最多 16,384 px、總像素最多 32 Mi，異常尺寸不會進入 Tauri 事件或 WebView Canvas。
- `lattice-agent` 的直連模式預設只監聽 `127.0.0.1:44900`，分享完整主螢幕並使用五分鐘、單一工作階段的一次性32 位十六進位隨機配對碼；中繼模式則主動連出，以永久九位數裝置 ID 註冊並在工作階段結束後繼續等候，配對碼在停止分享前有效。兩種模式連續五次配對失敗都會停止。
- `RemoteHostDialog` 提供「分享這台裝置」的明確開始／停止操作。直連可指定 loopback 或特定 LAN IP、連接埠與 1–10 FPS，萬用與 multicast 位址會由原生層拒絕；中繼模式改填 `wss://`／私網 relay 位址，並可設定大小寫英文、數字與特殊符號的固定配對密碼。永久身分檔位於 app data，含註冊 token 與 Noise 私鑰，Unix 建立或載入時都強制修正為 `0600`。配對嘗試限制另以不含秘密的檔案保存，十分鐘五次未完成驗證，重啟不會歸零。
- `RelayAddressField` 只在首次設定或按下修改時展開實際位址；成功保存後，分享與「以 ID 連線」的日常畫面只顯示已儲存狀態。位址保存在 WebView local storage，屬非機密連線 metadata；收合欄位是 UX，不是安全邊界。
- 複製配對碼會走 `SensitiveClipboard` 原生狀態；只保存摘要並在可調整期限後比對、清除相同內容。新複製內容不會被覆蓋，設定頁亦可立即清除目前仍相符的敏感值；browser preview 以相同規則使用 Web Clipboard fallback。
- Tauri 以 NDJSON 事件管理每次分享的 sidecar 生命週期。直連配對成功後立即從 UI 狀態移除一次性碼；中繼模式為了後續重連會保留本次碼到停止分享，但不寫入持久層，固定碼以 stdin 而非程序參數送入 sidecar。關閉對話框可選擇讓分享留在背景，停止分享或應用程式結束時會終止 Agent。
- 預設只傳送 JPEG 畫面（唯讀）。分享端可在 `RemoteHostDialog` 勾選「允許對方操控」（Agent 帶 `--allow-input`），Hello 的 `view_only` 隨之為 false；此時檢視端的滑鼠與鍵盤事件會以座標換算回真實螢幕後注入，斷線或停止時釋放所有按住的按鍵。UI 須依 `view_only` 標示目前是唯讀還是可操控。
- 檔案分享是第二個獨立權限。主機勾選後可指定單一分享根目錄（留白由原生層解析家目錄），Agent 才會帶 `--file-root` 並在 Hello 宣告 `file_transfer`；檢視端可展開 `RemoteFilesPane` 查看虛擬 `/` 之下的資料夾清單、串流上傳與下載。主機端 canonicalize 每個既有路徑並限制在根目錄內，拒絕 `..`、控制字元與越界符號連結；上傳使用私有同目錄暫存檔，位元組完整、flush 與 sync 成功後才保護舊檔並替換，取消或斷線會移除半成品。介面雖允許留白使用家目錄，部署指引必須建議專用分享資料夾。
- `--terminal` 會在 Agent 端建立 shell PTY，以 `RemoteTerminalView`／xterm 分頁傳送有界的 TerminalData、TerminalInput 與 resize 訊息，不擷取螢幕；沒有 `--allow-input` 時仍為唯讀。這是單一通用 shell 工作階段，不等於遠端 Agent Fleet 或既有 PTY 重新 attach。
- 中繼模式的免帳戶裝置 ID、永久 Noise 身分、Relay 尋址與檢視端 TOFU 釘選已完成；只有收到證明對方已接受配對碼的有效加密 Hello 後，首次成功連線才保存公開金鑰指紋，錯誤配對碼或未完成握手不能污染 pin，後續金鑰變更則直接拒絕。NAT 直連穿透尚未完成，跨網路目前必須使用雙方都能連到的 relay。
- 以 ID 連線成功後，該裝置由 `rememberRelayDevice()` 存成一般連線設定檔（`protocol: lattice` 加 `deviceId`／`relayAddress`），之後 `RemoteConnectFlow` 只索取配對碼。設定檔以身分定址，`hostname` 空、`port` 0，因此驗證改檢查九位數與中繼位址、重複判定改比對 `deviceId`——否則所有中繼設定檔會因共用空位址而互判重複。一次性配對碼不進設定檔。同一裝置換中繼位址時就地更新而不新增，且只在位址真的變了才寫入，使用者取過的名稱不會被對面 Agent 的名稱覆蓋。
- 保存的中繼位址只在連線成功時更新，而過期的位址永遠連不上，所以另有就地修復：`connect` 在中繼本身連不上或位址讀不出來時回報 `stage: "relay"`，中繼有回應但拒絕撥號維持 `"connect"`（位址是對的，要修的是另一端）。`RemoteConnectFlow` 只在前者打開位址欄位，`relayConnectFollowUp()` 決定是否提議修改與是否寫回；只有真的載過工作階段的位址才會寫回，猜錯不會覆蓋原本可用的值。
- 目前沒有雲端帳戶、跨裝置裝置清單、組織 ACL、2FA、管理員稽核、撤銷與每租戶配額；relay 適合自架個人／小團隊，不應因為九位數 ID 與收合位址就宣稱為完整公開遠端支援服務。公網入口需自行做來源限速、連線上限、監控與告警；relay 綁 loopback 時所有公網客戶端在它眼中都是 127.0.0.1，內建每 IP 限速預設全部放行，需以 `--client-ip-header` 指名 ingress 寫入真實來源的標頭才會生效。
- 無人值守固定碼必須由被控端明確啟用。內嵌模式不持久化固定碼並以 stdin 送入 Agent；獨立服務應使用擁有者限定的 `--pair-code-file`。五次配對失敗會停止 Agent，服務管理器不得以無條件重啟繞過；Relay 不保存明文配對碼，也不取得桌面、終端或檔案解密能力。

## 13. Web RDP Canvas

- `crates/lattice-rdp` 是每個工作階段一個程序的 IronRDP engine，用 NDJSON stdin/stdout 與 Tauri bridge 溝通，以隔離 russh 與 IronRDP 的密碼學相依。
- 密碼只出現在連線對話框、單次 Tauri IPC 與 engine 記憶體，不寫入 profile、事件或程序參數；使用者明確勾選時，成功連線後才會寫入作業系統認證儲存區。
- TLS 預設嚴格驗證；自簽憑證第一次必定拒絕並回傳 SHA-256 指紋，只有使用者明確核對後才能針對同一指紋重試一次。
- React 端以真正的 `<canvas>` 繪圖，輸入轉為 RDP FastPath；Canvas 失焦、離開或卸載時會釋放所有按鍵與滑鼠按鈕。
- `CanvasCaptureControls` 同時供 Lattice Remote 與 Web RDP 使用。使用者可手動輸出 PNG，或以 `canvas.captureStream` 和 `MediaRecorder` 開始、停止並下載 WebM／MP4；只錄遠端畫布、不錄 UI、不自動啟動，也不上傳。

---

## VNC 畫面操作

- 架構與 RDP 相同：`crates/lattice-vnc` 是獨立的 sidecar 引擎（vnc-rs 純 Rust 客戶端），stdin/stdout 走一行一個 JSON 的協定；密碼只經 stdin 傳入引擎一次，不進事件、狀態或日誌。
- 引擎在自己這端合成完整 framebuffer（Raw／Zrle／CopyRect 矩形更新、越界矩形一律裁切不信任），以每秒約 15 幀節流輸出 JPEG；WebView 只收合成後的畫面，不碰 VNC 線上格式。
- 鍵盤走 X11 keysym（可列印字元用碼點、特殊鍵查表、左右修飾鍵區分），滑鼠按鍵與滾輪照 RFC 6143 的按鍵遮罩處理，滾輪是按放脈衝。
- 傳統 VNC 沒有傳輸加密，連線視窗直接講明，並建議搭配本程式的 SSH 通道使用；密碼可存進系統認證儲存區（`CredentialKind::VncPassword`）。
- 密碼錯誤會辨識為「驗證失敗」而不是籠統的連線錯誤（含伺服器用 SecurityResult 文字回絕的情況）。

---

## 前端功能分包

- `App.tsx` 以 `React.lazy` 依功能載入連線清單、Agent Fleet、對話、通道、保管庫、設定、終端工作區與各連線對話框；只開啟連線清單時不會先下載 xterm、RDP/VNC Canvas 與所有設定頁程式。
- 每個工作區與 overlay 都有可存取的 `Suspense` 載入提示；終端工作區使用獨立邊界，其他頁面的首次載入不會暫停或重設現有終端。
- `vite.config.ts` 將 React DOM、排程器與 Tauri bridge 拆成可快取的穩定 runtime chunks，讓入口保留應用程式殼層；頁面分包仍由 `React.lazy` 決定，不會改變載入順序或功能可用性。
- `scripts/check-frontend-entry-size.mjs` 在正式建置後檢查入口檔，超過 500 KiB 直接讓 CI 失敗，避免功能成長後退回單一大型 bundle。

---

## 工作階段常駐掛載

- 「工作階段」視圖在第一次開啟或偵測到活躍工作階段時才載入，之後維持掛載並以 `hidden` 隱藏：xterm 與 RDP/VNC canvas 一旦卸載，畫面內容就沒了，也沒有任何機制重放。修正前「切去別的功能列再切回來」會得到一片空白的終端機。
- 外層包 `display: contents`，顯示時不影響原本排版；隱藏時 `display: none`，xterm 的 ResizeObserver 會在重新顯示時自動重排大小。

---

## SFTP 大型檔案串流佇列

- 舊的上傳／下載把整個檔案以 base64 走一次 IPC，因此有 32 MiB 上限；佇列引擎（`src-tauri/src/sftp_transfers.rs`）改為串流，上限取消：下載由 Rust 直接寫入系統「下載」資料夾（重名自動改成 `名稱 (2).ext`，不會蓋掉舊檔），上傳由前端以 4 MiB 分塊送入、後端邊收邊寫入同目錄的隨機隱藏暫存檔。
- 每筆傳輸經 `sftp://transfer` 事件回報進度，SFTP 面板下方有傳輸列：進度條、已傳位元組、取消與清除。後端拒絕超過或少於宣告大小的傳輸；完成時先關閉暫存檔，再保護舊目標並發布新檔。取消、瀏覽器讀檔失敗、IPC 錯誤或關閉 SFTP 工作階段都會清除半成品，不會截斷既有遠端檔。
- 小檔案的就地讀寫（編輯用途）維持原本的 32 MiB 上限指令，兩者互不干擾。
- 整合測試 `src-tauri/tests/sftp_transfers_live.rs`：40 MiB 檔案上傳後下載回來逐位元組比對、取消上傳會拒絕後續分塊並移除遠端殘檔，並驗證成功覆寫、不完整上傳與取消時的原檔保護。

---

## Android 與 iOS 行動版

- **建置**：`npx tauri android init` 產生的專案在 `src-tauri/gen/android`；`npx tauri ios init` 產生的 Apple/Xcode 專案在 `src-tauri/gen/apple`（兩者皆入版控、排除 build 輸出）。`tauri.android.conf.json` 與 `tauri.ios.conf.json` 都覆寫 `externalBin` 為空，RDP／VNC／裝置分享引擎不隨行動版打包。iOS Simulator 可用 `npm run ios:simulator`，自動選擇 Intel／Apple silicon 架構並固定 Simulator SDK。正式版本改走 `npm run ios:build -- --build-number 1` 的 App Store Connect 匯出；工具／SDK／簽章條件不足時先停止。完整步驟見 [iOS 發布流程](IOS_RELEASE.zh-TW.md)。
- **核心全數共用**：SSH 終端機、SFTP 與串流佇列、通道、主機資源、known_hosts、加密保管庫都是行程內純 Rust（russh 用 ring 後端正是為了行動交叉編譯），Android 與 iOS 上原樣可用。
- **平台感知**：`runtime_summary` 回報 `platform`；行動平台上導覽自動隱藏 Agent Fleet，分享裝置按鈕消失，RDP/VNC 連線改顯示「桌面版限定」說明。憑證後端在 Android/iOS 預設為加密保管庫；iOS 使用者若明確選擇系統儲存區，則使用受保護的 iOS Keychain。
- **更新與隱私**：iOS 設定頁顯示 TestFlight／App Store／Xcode 原安裝來源的更新說明，不把桌面 GitHub release 當成 iOS 可安裝版本。隱私權政策內嵌於 App，可離線閱讀；網站支援與隱私頁由既有 Pages 流程發布。`Info.ios.plist` 合併區網用途說明，原生 Resources 階段包含 `PrivacyInfo.xcprivacy`。
- **行動佈局**：`.app--mobile` 把左側導覽列變成底部分頁列、單欄內容、隱藏桌面狀態列與資源側欄；系統狀態列以固定 fallback 避開（Android WebView 拿不到 safe-area inset）。
- **終端機觸控鍵列**：Esc／Tab／方向鍵／管線符號等軟鍵盤沒有的鍵，加上黏性 Ctrl——按一下之後的下一個字元會轉成控制碼。粗指標裝置（`pointer: coarse`）與行動平台顯示。
- **已實測**：Android 模擬器（API 36）安裝執行，主畫面、底部導覽、平台過濾皆如預期。iOS 已在 iPhone 17（iOS 26.5）Simulator 編譯、安裝及啟動，主畫面與底部分頁可正常顯示；也已匯出 `tw.nickyclin.latticeterm` 的 In-House IPA，並驗證其 Distribution 簽章、Team ID 與內嵌描述檔。尚未在實體裝置安裝驗證，亦未驗證 TestFlight 與 App Store 上架流程；In-House IPA 不可作為 TestFlight 上傳檔。

---

## 加密保管庫與憑證雙後端

- **為什麼不是 IOTA Stronghold**：藍圖原寫 Stronghold，但該專案已被原廠封存、不再維護；改用兩個活躍維護的標準元件自建同等能力——Argon2id（64 MiB、3 迭代）把主密碼拉伸成金鑰，XChaCha20-Poly1305 AEAD 密封整包內容。檔案被改動一個位元組就會驗證失敗，不會吐出爛掉的密碼。
- **檔案**：`vault.json` 放在應用程式資料夾，內容只有 KDF 參數、鹽、nonce 與密文；連憑證的「名稱」都在密文裡。寫入走暫存檔＋fsync＋rename，中斷不會留半個保管庫。
- **狀態**：未建立／鎖定／解鎖。金鑰與明文只存在解鎖期間的記憶體（zeroize），鎖定即丟。主密碼沒有救援路徑，介面直說。
- **雙後端路由**（`credentials.rs`）：新密碼寫入使用者選的儲存區（系統認證儲存區或保管庫，「金鑰保管庫」分頁可切換）；讀取先查偏好後端、再查另一邊，切換偏好不會弄丟舊密碼；刪除兩邊都清，保管庫鎖定時會明說「還有一份在鎖著的保管庫裡」而不是假裝刪乾淨。
- **鎖定時的行為**：偏好保管庫但未解鎖 → 儲存新密碼會失敗並提示解鎖；已存在系統儲存區的密碼照常可用。
- 單元測試涵蓋：建立/解鎖/錯誤密碼/篡改偵測/改密碼（舊密碼失效、資料保留）/刪除/磁碟檔不含任何明文。

---

## SSH 私鑰認證

- 連線視窗可切換「密碼／SSH 金鑰」。金鑰模式輸入私鑰檔路徑（會自動列出 `~/.ssh` 底下偵測到的 `id_ed25519`、`id_ecdsa`、`id_rsa` 供選擇）與選填的金鑰密語。
- 私鑰只在本機讀取與簽名，內容不會離開這台電腦；密語只用於當次解鎖，不儲存。每個連線會記住上次成功的登入方式與金鑰路徑（存 localStorage，絕不含密語）。
- 後端 `AuthMethod` 擴充為 `password | privateKey`，SSH 終端機與 SFTP 共用同一條認證路徑（`ssh.rs` 的 `authenticate`）。RSA 金鑰依伺服器支援自動挑最強的簽名雜湊。
- 錯誤有分級：金鑰檔讀不到或密語錯是 `credential` 階段錯誤（根本沒問到主機）；主機看得懂但說不行是 `AuthFailed`；連線中斷才是 `authenticate` 階段錯誤。
- 整合測試 `src-tauri/tests/keyauth_live.rs`：測試自產 ed25519 金鑰裝進拋棄式容器後成功簽入、缺檔案回報 credential 錯誤、未授權的金鑰被乾淨拒絕。

---

## 14. 自動更新與發行簽章

- **啟動檢查回饋**：桌面版預設啟動時檢查 GitHub Releases；有新版會開啟更新視窗，已是最新版或檢查失敗則常駐顯示於狀態列，狀態列亦可手動重查，避免靜默成功看起來像沒有更新服務。
- **簽章金鑰**：以 `npm run tauri signer generate` 產生。公鑰放在 `tauri.conf.json` 的 `plugins.updater.pubkey`，私鑰與其密碼存在 GitHub Actions 的 `TAURI_SIGNING_PRIVATE_KEY` 與 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets，不會進入版本庫。
- **為什麼不能放假的公鑰**：Tauri 的 updater plugin 缺 `pubkey` 會直接讓程式無法啟動；而填一把不對的公鑰雖然程式能開，卻會讓每一次更新的簽章驗證都失敗，問題被藏起來反而更難查。
- **必要的三個設定**，缺一則更新不會運作：
  1. `plugins.updater.pubkey`：用戶端據此驗證更新包簽章。
  2. `bundle.createUpdaterArtifacts`：沒有它只會產生安裝檔，不會產生更新包。
  3. `includeUpdaterJson`：把 `latest.json` 一併發佈，那正是更新端點指向的檔案。
- **發行流程的防呆**：發行工作流程在建置前會確認簽章金鑰存在，缺少時直接失敗。否則會產出一份沒有簽章的發行版，安裝端會拒絕它的每一次更新，而問題要等使用者更新失敗才會被發現。
- **Windows 只出 NSIS 更新包**：更新器查詢的是 `latest.json` 的 `windows-x86_64` 欄位，同時打包 MSI 與 NSIS 時這個欄位可能指到 MSI——裝 NSIS 版（per-user、免提權）的使用者會被餵 MSI，`msiexec` 要提權就卡住，看起來像「有下載卻沒裝」。因此 `bundle.targets` 明確排除 MSI。
- **無感更新**：`installMode: passive` 搭配 NSIS 的 `/P /R`——按下更新後 app 自動關閉、背景安裝只顯示進度列、裝完自動重啟成新版，全程不出現安裝精靈。
- **既有安裝需要重裝一次**：v0.2.0 建置時 updater plugin 是停用狀態，那個版本沒有檢查更新的能力。自動更新從下一個發行版開始生效。

---

## 15. SSH 通道與連接埠轉送 (Tunnels & Port Forwarding)

- **純 Rust 轉發引擎**：由 `src-tauri/src/tunnel.rs` 實作原生 TCP 監聽與通道轉發，不調用系統外部的 `ssh` 執行檔，確保跨平台環境與權限隔離一致性。
- **三大轉發模式支援**：
  1. **本機轉送 (Local -L)**：本機綁定特定 IP 與連接埠，經由指定 SSH 閘道主機安全連通內網服務（例如遠端 PostgreSQL、MySQL 或 Redis）。
  2. **動態 SOCKS5 代理 (Dynamic -D)**：在本機啟動標準 RFC 1928 SOCKS5 代理伺服器，任意網路流量皆可透過 SSH 連線安全繞送。
  3. **遠端轉送 (Remote -R)**：由遠端主機反向將連接埠轉發回本機服務。
- **視覺化路由拓撲**：`TunnelsView.tsx` 直觀展示「本機端點 ➔ SSH 閘道 ➔ 目標服務」完整路徑，並提供即時活躍連線數、累計上傳/下載流量統計。
- **一鍵啟停與快捷指令**：提供通道獨立與批次啟停控制、一鍵複製標準 OpenSSH 命令列，以及即時連線狀態診斷與防呆防重複綁定機制。
- **信任與認證的前置條件**：通道使用自己的 SSH 工作階段，因此啟動前必須（1）主機金鑰已在 SSH 連線流程完成指紋確認、（2）該連線設定已儲存密碼（連線時勾選「記住密碼」）。缺一者會以可翻譯的錯誤碼（`trust:`／`credential:`）回報，不會靜默啟動一條沒有作用的通道。
- **失敗必須看得見**：啟動失敗、SSH 連線中斷、或閘道主機拒絕開啟目標連線（例如伺服器設定 `AllowTcpForwarding no`）都會記錄在通道狀態的 `last_error`，介面直接顯示原因。
- **端到端整合測試**：`src-tauri/tests/tunnel_live.rs` 以拋棄式 SSH 容器驗證 Local 與 SOCKS5 的 `direct-tcpip` 真正傳輸目標服務位元組，並讓 Remote 的 `tcpip-forward` 經由容器對外連接埠把測試訊息送到本機 echo 服務再原樣帶回。容器需將 `AllowTcpForwarding yes` 與 `GatewayPorts clientspecified` 明確開啟才會通過。
