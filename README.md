# LatticeTerm

LatticeTerm 是一套現代、安全且跨平台的終端與遠端連線工作空間，用來統一管理本機 AI CLI、SSH、SFTP、RDP 與 VNC 連線，以 Tauri 2、Rust、React 與 TypeScript 建構。

**English summary:** LatticeTerm is an open-source, cross-platform desktop workspace for local AI coding agents and remote access. Run OpenAI Codex, Claude Code, Gemini CLI and other AI CLIs in native PTYs alongside SSH, SFTP, tunnels, RDP, VNC and end-to-end encrypted remote desktop sessions.

[下載安裝](#-下載與安裝-downloads) · [功能現況](#完成度總覽) · [程式碼與文件導覽](docs/README.md) · [安全性](SECURITY.md) · [參與貢獻](CONTRIBUTING.md) · [English project map](llms.txt)

> [!NOTE]
> LatticeTerm 目前處於 **公開測試與功能成熟化階段**。桌面端的連線管理、SSH／SFTP／Tunnel、Web RDP、VNC、本機 AI Agent Fleet、安全保管庫、備份、跨平台安裝檔與自動更新已可實際使用，Lattice Remote 亦支援自架中繼、數字裝置 ID、遠端控制／檔案傳輸與純終端分享；Agent Fleet 的工作階段可勾選「留在背景」交給本機背景服務，關閉 LatticeTerm 後繼續執行並在下次開啟時接回；遠端 Fleet、NAT 直連穿透與 iOS 實機發布等進階能力仍依後續藍圖開發。

## 完成度總覽

| 範圍 | 狀態 | 現況與邊界 |
| --- | --- | --- |
| 桌面連線工作區 | **可用** | Windows、Linux 與 macOS 支援 SSH、SFTP、SSH Tunnel、Web RDP、VNC、主機資源與工作階段管理。 |
| 安全與資料保護 | **可用** | 嚴格主機信任、作業系統認證儲存、主密碼加密保管庫、敏感剪貼簿與加密備份均已接入真實後端。 |
| 本機 AI Agent Fleet | **可用** | 多 CLI PTY、Reporter、批次提示、同分頁加開 CLI 並帶入目前對話、安全啟動工作區與同程序重新 attach 已完成；另有不必打指令的對話模式（Claude Code、Codex 與 Gemini CLI，Claude 與 Codex 含逐項核准）與應用程式開著時執行的排程任務。 |
| Lattice Remote | **基礎功能可用** | 已完成使用者主動啟動、Noise 端對端加密、主螢幕／純終端分享，以及由分享端分別授權的鍵盤／滑鼠或終端輸入與單一根目錄檔案瀏覽、上下載；另支援自架 lattice-relay 中繼、永久九位數裝置 ID、跨網路連線、裝置金鑰釘選與固定配對碼（無人值守）；以 ID 連線過的裝置會留在「我的連線」，中繼位址失效時可在連線對話框就地更正。目前仍是自架、小規模服務，NAT 直連穿透與多人租戶管理尚未加入。 |
| 發行與更新 | **可用** | Windows x64、Linux x64／arm64、macOS Intel／Apple Silicon 安裝檔、更新簽章、Release PR 與應用程式內更新已自動化。 |
| Android | **預覽** | 共用的純 Rust SSH／SFTP／Tunnel／Vault 核心與行動介面可建置；需要桌面 sidecar 的 RDP、VNC 與 Agent Fleet 不提供。 |
| iOS | **預覽／上架準備中** | 已有 Simulator 驗證；提供 App Store 匯出、獨立建置號、區網權限說明、隱私清單與發布檢查。簽章實機安裝、TestFlight 與 App Store 審核仍待完成，詳見 [iOS 發布流程](docs/IOS_RELEASE.zh-TW.md)。 |
| 進階 Agent 與行動能力 | **部分完成** | 排程任務、接續執行與同時執行上限、提示佇列，Linux 的 bubblewrap 檔案範圍沙箱，以及跨程序背景服務（勾選「留在背景」的工作階段在關閉 LatticeTerm 後繼續執行、下次開啟自動接回）已完成；遠端 Fleet、macOS／Windows 的沙箱與 iOS 上架仍待完成。 |

## 主要特色

- **現代化桌面工作空間**：整合全域導覽列、資源側欄、工作區與即時狀態列。
- **安全的連線管理**：連線設定檔不含密碼、配對碼與私鑰；SSH/SFTP/RDP/VNC 驗證成功後可由使用者選擇保存密碼，已儲存且具永久裝置 ID 的 Lattice Relay 連線也可選擇保存配對碼。認證資料交給 Windows Credential Manager、macOS Keychain、iOS Keychain、Linux Secret Service，或以主密碼保護的本機加密保管庫隔離保存。保管庫預設閒置 15 分鐘或視窗進入背景時自動鎖定，也可由使用者調整策略。
- **敏感剪貼簿保護**：Lattice Remote 一次性配對碼預設在複製 30 秒後清除，可調整為 15／60／120 秒或關閉；清除前會比對內容，使用者後來複製的文字不會被覆蓋，亦可從設定立即清除。
- **終端機剪貼簿**：SSH 與本機 Agent CLI 支援 `Ctrl+C`／`Ctrl+V`、Linux 常用的 `Ctrl+Shift+C`／`Ctrl+Shift+V`，以及右鍵複製／貼上；有選取內容時 `Ctrl+C` 才會複製，否則仍送出中斷。Linux WebKitGTK 拒絕瀏覽器剪貼簿 API 時會走限制為 1 MiB 文字的 Rust 原生橋接，不必開放整個 clipboard plugin 給 WebView。Agent 貼入圖片時只接受有界 RGBA 圖片，會以擁有者限定權限暫存並綁定到目標工作階段；工作階段停止、自然結束或應用程式離開時即刪除。
- **真實主機信任管理**：Key Vault 直接讀寫桌面核心的 `known_hosts.json`，可搜尋、複製、新增及移除已驗證的 SHA-256 指紋。
- **分層備份與移轉**：連線清單可用標準 JSON 安全匯出並自動過濾機密；完整本機工作區則可匯出成密碼保護的 `.latticeterm-backup`，以 Argon2id 與 XChaCha20-Poly1305 加密後再交給介面下載，還原前會完整驗證並可失敗回滾。
- **強大的組織與檢索**：支援全域關鍵字搜尋、多層群組、環境標籤（Production / Staging / Development）與常用釘選。
- **鍵盤優先與命令面板**：內建全功能命令面板（`Ctrl` + `K`），支援各項快捷操作與頁面切換。
- **多語系介面**：預設繁體中文，可即時切換英文；所有文案集中於語系檔，缺翻譯會在編譯時就被擋下。
- **六種主題**：深色、淺色、午夜藍、石墨黑、暖砂與高對比，另可跟隨系統；切換時原生標題列會一起換色。
- **主機資源檢視**：活躍 SSH 工作階段可定期讀取 Linux 主機的 CPU、記憶體、磁碟與開機時間；未連線或不支援的平台會明確說明，不顯示假數值。
- **本機持久化**：連線設定會存在本機的應用程式資料目錄，關閉再開仍在；檔案只含主機資訊，不含任何認證資料。
- **AI Agent Fleet**：以原生 PTY 同時執行 Codex、Claude Code、Gemini CLI、Google Antigravity CLI、OpenCode、Hermes 等 13 種本機 LLM CLI；未偵測到工具時可先確認固定的上游安裝指令，再開啟看得到完整輸出的安裝終端。目錄會顯示 Codex、Claude 與 Gemini 自己保存在本機的目前登入帳號標籤，但 token 不會進入 WebView。執行中的 CLI 會分開顯示工具名稱、分頁名稱，以及工具啟動畫面或 `--model` 實際回報的模型；沒有可靠值時會明確標成尚未回報。使用者可選擇保存一份工作區共用啟動指示，讓之後每個全新 CLI 進入互動提示後先讀取；也可把專案根目錄的 `AGENTS.md` 設為 Codex、Claude 與 Gemini 的唯一規則來源，由 LatticeTerm 保留既有內容並安全同步 `CLAUDE.md`／`GEMINI.md` 的原生匯入。自動還原的舊工作階段不會重送啟動指示，且會一併保留原本側欄的資料夾、排序與收合狀態，不會因 CLI 尚在續接而回到最外層。內建繁中 Commit 範本採 `type(scope): subject`、Why／What 與單一意義提交，預設不啟用。通用 Reporter 讓工具 hook 明確回報狀態；Hermes 也會透過官方 `post_api_request` hook 顯示該工作階段與子 Agent 累計的可信 token buckets，不讀取提示或回覆內容。使用者可在二次確認後將同一段提示送給多個已選 Agent，並可選擇「忙碌時排入佇列」——正在工作的 Agent 會等這一輪真的結束才收到，不會插進它做到一半的事情；只有官方整合回報結束才放行，終端 heuristic 的猜測不算，已經閒置的則照舊立刻送出。執行中的分頁可直接加開另一個 CLI，並選擇帶入目前脈絡：各 CLI 統一透過 LatticeTerm 管理的一次性交接檔接收內容，保留既有記憶與私有 session 檔。CLI 自行結束時，LatticeTerm 會保留唯讀分頁與退出前畫面，直到使用者關閉，不會突然跳回其他專案。啟動項目可加入選填備註並保存到可命名、排序的工作區；重新啟動已保存的 Codex 項目時，會續接同一工作目錄最近的對話，Cursor 項目則使用官方的最近對話續接。同一桌面程序內若 WebView 重新載入，活躍 PTY 會重新 attach 並重播最近 256 KiB 記憶體輸出；正常關閉桌面程式時，這段輸出會以 OS 安全儲存區中的裝置金鑰加密保存，下次還原同一項目時先重播。安全儲存區不可用時不會把輸出寫入磁碟。登入與 token 仍由各 CLI 自行管理。
- **對話模式**：不想用終端機的人可以在「對話」頁用聊天視窗跟 Claude Code、OpenAI Codex 或 Gemini CLI 溝通，做法參考 Codex Desktop：Claude Code 與 Gemini CLI 每一輪以官方 headless JSON 模式執行一次（`claude -p --output-format stream-json`、`gemini --output-format stream-json`）；Codex 則為每個對話常駐一個 `codex app-server`，thread 開好後追問只送 `turn/start`，不必重新啟動程序與重新載入紀錄，閒置 15 分鐘或刪除對話時才結束。回覆逐字串流顯示，每個工具呼叫是一張可展開的卡片，結束時顯示耗時、token 與費用。之後的訊息以 CLI 自己的對話 ID 續接，所以登入、模型與對話紀錄都還是 CLI 的。權限用效果命名而不是各家旗標：「每次詢問」（Claude Code 與 Codex，工具呼叫變成對話裡的核准卡片）、「唯讀」、「可修改工作目錄」、「全部允許（危險）」，後三者分別對應 Claude 的 `plan`／`acceptEdits`／`bypassPermissions`、Codex 的 `read-only`／`workspace-write`／bypass sandbox，以及 Gemini 的 `plan`／`auto_edit`／`yolo`。設定區只用一個依助理分組的模型選單，選模型時同時決定背後 CLI；Claude 與 Codex 從自己的協定取得模型，Gemini 則使用官方穩定的 Auto／Pro／Flash／Flash Lite 路由別名。讀取 Claude 模型與開始 Claude 對話會共用認證啟動閘門，前一個程序完成初始化後才啟動下一個，避免有效登入因並行 OAuth token 更新而誤報失敗；若外部 Claude 程序仍占用 refresh lock，僅在本輪尚未產生任何回覆或工具動作時短暫退避重試兩次，避免重複執行指令。對話清單跟工作項目一樣可建立巢狀資料夾、拖曳整理。介面用語一律稱「助理」，不出現 CLI。對話內容只在這台電腦的 LatticeTerm 本機儲存區留一份有界複本；提示走 stdin 而非命令列參數，不會出現在程序清單；Windows 上以 `CREATE_NO_WINDOW` 啟動，不會彈出主控台視窗。
- **排程任務**：對話頁的「排程」分頁做法參考 Codex 的 Automations：寫一段指示、選 CLI、專案與時間（每天／每週固定時刻，或每隔一段時間），LatticeTerm 開著時就會準時用對話模式跑一輪，每次執行都開一個新對話，結果以未讀標記出現在對話清單裡等你看；可立即執行、暫停、編輯、刪除，並保留最近 20 次執行紀錄。LatticeTerm 關著時由背景服務準時執行，結果在下次開啟時以未讀對話出現（背景服務沒在跑時才會在下次開啟補跑一次）；無人值守不提供「每次詢問」權限，預設唯讀。
- **Agent 沙箱（Linux）**：裝有 bubblewrap 的機器上，啟動 CLI 時可勾選「沙箱：只能改工作目錄」——整個檔案系統唯讀，只有工作目錄、該工具自己的登入與狀態目錄和 /tmp 可寫，PID 隔離、網路照常；選項會跟著工作區項目保存與還原，清單上有「沙箱」標記。沒有 bwrap、或系統禁止非特權 user namespace（Ubuntu 24.04 起預設如此，需為 bwrap 啟用發行版提供的 AppArmor 設定檔）時不提供這個選項，也不會假裝有隔離。
- **可靠的 Agent 狀態**：Codex、Claude Code、Gemini CLI、OpenCode、GitHub Copilot CLI、Hermes Agent 與 Qwen Code 會以各自官方 lifecycle hook／plugin event 明確回報工作中、完成或等待權限；Claude 與 Qwen 尚有背景工作或排程時不會誤標完成，OpenCode、Copilot 與 Hermes 的子 Agent 結束也不會被當成主工作階段完成。Gemini、OpenCode、Copilot、Hermes 與 Qwen 的整合只套用在該次 LatticeTerm 工作階段，不改使用者設定；若主機已有不可安全合併的程序級設定、專案停用所有 hooks、無法辨識 Hermes 安裝結構，或 CLI 以 pure／safe／bare mode 啟動，就保留原設定並使用保守 heuristic。其他尚未整合 hook 的工具只使用保守的終端提示 heuristic：看到提示列重新開啟 bracketed paste 之後，還要再安靜兩秒才標成完成，因為 TUI 重繪也會送同一個控制碼；期間有輸出就從最新輸出重新計時。狀態不會憑空猜測：只有使用者實際送出打好的提示才算開始工作，單獨按 Enter 接受資料夾信任對話框或清空提示都不會標成執行中；整合始終沒有回報且終端連續 10 分鐘無輸出時，會退回「閒置」而不是謊稱「完成」。
- **SSH 連線**：以純 Rust 的 russh 實作，可使用密碼或本機 OpenSSH 私鑰建立終端機工作階段。主機金鑰未經確認不會連線，金鑰變更會直接擋下；密碼預設只用於當次連線，使用者可在驗證成功後明確保存到系統認證儲存區，私鑰內容與密語不會保存至連線設定。執行中的 SSH 分頁可一鍵「開啟檔案總管」，以同一台主機、同一組認證開啟 SFTP 圖形化檔案瀏覽（已保存密碼免再輸入）。
- **SSH Tunnel**：可建立本機、遠端與 SOCKS5 動態轉送，顯示即時狀態與連線數；動態代理若未設定驗證只允許綁定 loopback，遠端轉送則依 SSH 伺服器的 GatewayPorts 政策生效。
- **SFTP 檔案工作區**：沿用 SSH 主機指紋驗證與獨立的認證項目，可瀏覽遠端路徑、上下載、新增資料夾、重新命名及確認刪除；上傳除了按鈕選檔，也可直接把檔案從檔案總管拖進面板上傳到目前資料夾。大型檔案經有界分塊與原生串流佇列傳輸，不把整個檔案塞進 WebView／IPC 記憶體。上傳先寫入同目錄的私有暫存檔，只有位元組數完整且關檔成功才替換目標，取消、失敗或中斷連線不會把既有檔案變成半成品。
- **Lattice Remote（協定 v2）**：桌面版內建「分享這台裝置」，可在區網直連，或經自架 `lattice-relay` 以永久九位數裝置 ID 跨網路連線；中繼只轉送密文，兩端仍以 32 位十六進位隨機配對碼完成 Noise XXpsk3 端對端加密，回訪裝置另以 TOFU 釘選永久身分金鑰。沒有桌面環境的主機可分享加密 shell 終端而非畫面。新版採用獨立的安全握手版本，舊八位數碼與舊握手不再接受；升級時須更新兩端並重新產生配對碼。使用新版安全握手的兩端即使訊息協定版本不同仍可連線：檢視端會降到對方支援的協定版本，Hello 也會略過不認得的尾端欄位，落後的機器因此連得進去、可以被遠端協助更新；真的無法溝通時，錯誤訊息會明講該更新哪一台。以 ID 連線成功的裝置會存成一般的連線設定檔留在「我的連線」。回訪時可繼續手動輸入配對碼，或明確選擇在成功配對後交給安全認證後端保存；配對碼不會寫入連線設定檔，且儲存項目會同時綁定該設定檔與永久裝置 ID。中繼位址換掉時（免費 Quick Tunnel 每次重啟都會換）連線對話框會在中繼沒有回應時就地開啟位址欄位，只有真的連上的位址才會寫回設定檔。鍵鼠／終端輸入與檔案分享分開授權；檔案模式只暴露指定的單一根目錄，路徑跳脫和越界符號連結會被拒絕，上傳完整收完並安全關檔後才替換目標。協定也會限制畫面、終端與檔案訊息資源，斷線或停止分享會釋放輸入並清除未完成的檔案暫存。
- **Web RDP Canvas**：IronRDP 原生 engine 以 TLS/NLA 連到 Windows，畫面繪入內嵌 Canvas，並支援滑鼠、滾輪與鍵盤。密碼只經本機 stdin 傳給隔離 engine，也可在成功驗證後安全保存。
- **使用者控制的截圖與錄影**：Lattice Remote、Web RDP 與 VNC 都可手動擷取 PNG，或開始、停止並下載遠端 Canvas 錄影；不會自動錄製或上傳。
- **跨平台支援**：桌面版支援 Windows、Linux 與 macOS；Android 與 iOS 版已可建置共用的純 Rust 核心功能，iOS 已有 Simulator 驗證與 In-House 企業 IPA；需本機程序的 RDP／VNC／CLI Fleet 維持桌面限定。

## 📥 下載與安裝 (Downloads)

你可以直接前往 [GitHub Releases](https://github.com/NickYCLin/lattice-term/releases) 取得最新發行版本的安裝檔與執行檔：

| 平台 | 安裝包格式 | 系統支援 |
|---|---|---|
| **Windows** | `.exe` (NSIS) | Windows 10 / 11 (x64) |
| **Linux** | `.deb` / `.AppImage` | Ubuntu、Debian 及通用 Linux 發行版 (x64 / arm64) |
| **macOS** | `.dmg` / `.app` | macOS 12+ (Intel／Apple Silicon) |

> [!TIP]
> 歡迎至 [Releases 列表](https://github.com/NickYCLin/lattice-term/releases) 下載對應平台的安裝檔或檢視各版本更新說明。
> 維護者可參考 [Release 自動化與版本規則](docs/RELEASE_AUTOMATION.zh-TW.md)；版本會由 Conventional Commits 自動計算，通常累積至少 3 個使用者可感知項目才發布，重大漏洞可提前發布。只有合併 Release PR 才會正式發布。

## 誠實呈現的介面原則

介面必須讓使用者一眼分辨「已經可用」與「還在開發」：

- 尚未實作的功能標示為「即將推出」，不使用看起來可按、實際上停用的假按鈕。
- AI Agent Fleet、SSH、SFTP、Lattice Remote、Web RDP 與 VNC 會啟動真正的工作階段；Agent Fleet 可在同一桌面程序內重新 attach 活躍 PTY，正常關閉時也能加密保存並在下次重播終端尾端輸出，但不會假裝舊程序本身可跨應用程式重啟存活；只有勾選「留在背景」的工作階段由獨立的背景服務持有，才會真的跨視窗關閉存活並在下次開啟時接回。
- 主機資源分頁只顯示活躍 SSH 工作階段取得的真實 Linux 指標；尚未連線或不支援的平台會直接說明原因，不顯示假的 CPU 或記憶體數字。
- SSH/SFTP/RDP/VNC 密碼與已儲存 Lattice Relay 裝置的配對碼永遠不寫入連線設定檔；預設只供當次驗證，勾選後也只有驗證成功才會寫入使用者選擇的作業系統認證儲存區或已解鎖加密保管庫。
- Key Vault 的主機信任、認證與加密保管庫分頁都顯示真正的本機狀態；認證分頁只列連線參照，不顯示密碼或配對碼內容。
- 加密保管庫解鎖後由全域閒置計時器保護；鍵盤、滑鼠與觸控活動會重設期限，視窗進入背景可立即清除記憶體中的解密金鑰，且不會中斷既有連線。
- Lattice Remote 配對碼使用受限的敏感剪貼簿流程；正式應用程式的 WebView 不能任意讀取剪貼簿，只能要求原生層複製或清除本程式最後追蹤且內容仍相符的敏感值。
- 狀態列由 Rust 核心回報認證儲存區的真實可用狀態，不用固定文案假裝就緒。

## 後續開發重點

1. **Lattice Remote 連線範圍**：鍵盤／滑鼠遠端控制已可用（由分享端明確授權）；免帳戶數字裝置 ID、自架 Relay（`docs/RELAY_SERVER.zh-TW.md`）、裝置金鑰釘選（TOFU）與固定配對碼無人值守已可用；接著加入 NAT 直連穿透。連線清單先保存在本機，帳戶只作為日後跨裝置同步與團隊權限的選配層。
2. **Agent 常駐與遠端能力**：背景服務已能持有勾選「留在背景」的工作階段並跨視窗關閉接回；保存的啟動項目也會記住這個選擇，還原時直接回到背景；對話排程在 LatticeTerm 關著時也由背景服務準時執行。下一步是先以 SSH transport 實作遠端 Agent Fleet。
3. **Agent 編排與隔離**：補齊其他工具的 hook 與 token／cost 可觀測事件；排程、佇列、接續執行與同時執行上限已完成，Linux 檔案範圍沙箱已完成，接著是 macOS／Windows 的對應隔離與網路／資源限制。
4. **平台完整度**：設計安全的 Windows npm shim adapter、持續強化 Android 發行流程，並完成 iOS 實機安裝、TestFlight 與上架驗證。
5. **正式發行信任**：自動更新包已有 Tauri 簽章；Windows Authenticode 與 Apple Developer ID／notarization 仍需發行者憑證。

## 鍵盤快捷鍵

| 快捷鍵 | 動作 |
| --- | --- |
| `Ctrl` + `K` | 開啟或關閉命令面板 |
| `Ctrl` + `B` | 顯示或隱藏資源側欄 |
| `/` | 聚焦側欄搜尋欄位 |
| `N` | 新增連線 |
| `Esc` | 關閉命令面板、抽屜或對話框 |
| `↑` `↓` `Enter` | 在命令面板中移動與執行指令 |

## 本地開發

### 環境需求

- Node.js (>= 22.12) 與 npm
- Rust stable 與 Cargo
- [Tauri 官方前置需求](https://v2.tauri.app/start/prerequisites/)

### 執行網頁預覽

```sh
npm install
npm run dev
```

### 執行桌面應用程式

```sh
npm install
npm run tauri dev
```

### 執行 Lattice Remote Agent

桌面版可直接按「分享這台裝置」，選擇明確的介面 IP、連接埠與更新率，並勾選是否允許對方操控，再自行決定是否讓分享留在背景。若要獨立執行 CLI，預設只監聽 loopback 且只傳畫面；從同一個區網連入時，必須明確指定該機器的 LAN 位址，要開放遠端控制則加上 `--allow-input`：

```sh
cargo run --manifest-path crates/lattice-remote/Cargo.toml --features agent --bin lattice-agent -- --bind 192.168.1.20:44900 --allow-input
```

直連模式的 32 位十六進位隨機配對碼五分鐘後失效，連續五次失敗就會停止；一次成功工作階段結束後程序也會退出。中繼模式會維持註冊並在每段工作階段結束後繼續等候，配對碼在停止分享前有效，也可由分享端明確改成固定碼。複製配對碼時預設 30 秒後清除剪貼簿，若內容已被其他複製操作取代則保留。預設唯讀；只有分享端明確加上 `--allow-input`（或介面勾選）才接受遠端滑鼠／鍵盤或終端輸入，檔案存取則必須另外加上 `--file-root`（或勾選並指定根目錄）。不要留白而分享整個家目錄；建議建立專用資料夾，只開放真正需要交換的檔案。

跨 NAT 使用時，分享端與檢視端填同一個 `wss://` Lattice Relay 網址，再以九位數裝置 ID 與 32 位十六進位隨機配對碼連線。成功使用一次後，介面會記住並收合中繼位址，該裝置也會留在「我的連線」；之後可繼續手動輸入配對碼，或在連線對話框明確選擇安全保存。這是介面簡化，不是把位址當成機密，端點仍可由本機設定與網路流量得知。公網 Relay 應只監聽 loopback，並放在 Cloudflare Tunnel、nginx 或 Caddy 等 HTTPS/WebSocket 入口後；此時所有公網客戶端在 relay 眼中都是 127.0.0.1，內建的每 IP 限速預設會全部放行，請以 `--client-ip-header`（Cloudflare 用 `Cf-Connecting-Ip`）指名 ingress 寫入真實來源的標頭，或改在 ingress 端限速。原生 `主機:連接埠` 模式沒有 TLS，只適合可信任的私有網路或 VPN。完整部署、安全與多人服務邊界見 [Lattice Remote 中繼伺服器](docs/RELAY_SERVER.zh-TW.md)。

沒有桌面環境的純文字主機加上 `--terminal` 即可分享加密的 shell 終端機（而非畫面）；搭配擁有者限定讀取的 `--pair-code-file` 即可無人值守重連，避免固定碼直接出現在程序參數。連續五次配對失敗會自動停止；常駐服務不得用無條件自動重啟繞過這個保護。檢視端一樣以裝置 ID＋配對碼連線，開啟的是終端分頁。細節見 `lattice-agent --help` 與上述中繼文件。

### 從 Agent Fleet CLI 傳檔與部署

桌面安裝包也包含 `lattice-remote` 用戶端。由 LatticeTerm 啟動的 Codex、Claude Code 等 CLI 會收到 `LATTICETERM_REMOTE_CLI` 絕對路徑，因此不必猜安裝位置或修改 `PATH`。它支援目錄清單、單檔上下載與互動終端；例如在 PowerShell 中：

```powershell
$remote = $env:LATTICETERM_REMOTE_CLI
& $remote --relay wss://relay.example.com --device '123 456 789' `
  --pair-code-file "$env:USERPROFILE\.config\lattice-remote\pair-code" list /
& $remote --relay wss://relay.example.com --device '123 456 789' `
  --pair-code-file "$env:USERPROFILE\.config\lattice-remote\pair-code" `
  upload .\release.tar.gz /release.tar.gz
& $remote --relay wss://relay.example.com --device '123 456 789' `
  --pair-code-file "$env:USERPROFILE\.config\lattice-remote\pair-code" terminal
```

未指定 `--pair-code-file` 時會在真實終端隱藏詢問配對碼；刻意不提供 `--pair-code`，避免祕密出現在程序清單與 shell 歷程。Relay 裝置沿用桌面版的 TOFU 身分金鑰釘選；上傳與下載使用私人暫存檔、完整收完後才原子發布，並輸出本機計算的 SHA-256。遠端路徑仍受分享端 `--file-root` 限制，既有檔案必須明確加上 `--overwrite` 才能替換。

部署多個檔案時，建議先產生單一版本化封裝檔並上傳，再進入 `terminal` 驗證雜湊、解壓到新 release 目錄、執行檢查後切換服務。CLI 不提供可從參數背景執行任意字串的 `exec`：互動終端要求真實 TTY，且分享端必須同時啟用 `--terminal --allow-input`；按 `Ctrl+]` 可中斷。這保留部署能力，也避免多一條容易發生引號注入或未確認背景執行的介面。

### 執行 AI Agent Fleet

Agent Fleet 只在 Tauri 桌面版啟動本機 CLI；網頁預覽會誠實顯示後端不可用。開啟側邊導覽的「AI Agent Fleet」，選擇工作目錄後即可啟動已偵測到的內建 CLI。未偵測到工具時，卡片會先列出經專案固定的安裝指令；使用者確認後才會開啟安裝終端，LatticeTerm 不會在背景靜默下載或執行安裝。若該平台沒有可直接執行的安全安裝方式，則提供可複製的安裝說明網址。安裝程式若更新 PATH，可能需要重開 LatticeTerm 才會被偵測到。批次提示必須先勾選執行中的目標並再次確認，LatticeTerm 不保存提示內容。

要同時用兩個以上的 Codex 或 Claude Code 帳號（例如個人與公司各一個），在卡片上按「新增另一個帳號…」，輸入名稱後按「加入並登入」即可，不需選擇資料夾。LatticeTerm 會自動為各帳號分開保存登入狀態，並直接開啟新帳號的終端機，依 CLI 提示登入一次（Claude Code 輸入 `/login`，Codex 會顯示登入選項）；之後選取帳號就能使用，清單裡會顯示登入狀態。新增期間會阻止重複送出；若終端機未能開啟，帳號仍保留且已選取，可按「啟動」重試。「移除這個帳號」會先確認，LatticeTerm 自己建立的目錄連登入資料一起刪除；舊版自行指定的設定目錄仍可使用，移除時只從清單移除。對話頁的帳號選單也用同一份清單。

勾選「留在背景（關閉 LatticeTerm 後繼續執行）」啟動的工作階段，會交給 LatticeTerm 自己的本機背景服務持有：關掉視窗它照跑，下次開啟 LatticeTerm 會自動接回並重播最近 256 KiB 的輸出，分頁上以「背景」標示。背景服務就是同一個 `lattice-term` 執行檔以 `agent-daemon` 子命令啟動，只監聽應用程式資料目錄下使用者專屬的本機 socket（Windows 為具名管道），連線要先出示同目錄下只有你讀得到的權杖；它沒有工作階段也沒有視窗連著 60 秒後會自己結束。想一次結束所有背景工作階段，按啟動表單下方的「結束背景服務」（會先確認）；沒有勾選的工作階段行為與以前完全一樣，仍隨 LatticeTerm 結束。

若要讓另一個 CLI 接手，請在執行中的工作階段分頁選擇「加開 CLI」；來源為 Codex、Claude Code、Gemini CLI 或 Google Antigravity CLI 時，可勾選「帶入目前對話」。任何已安裝的新 CLI 都會收到整理過的對話交接內容，但不會搬移模型內部狀態、登入資料或憑證。交接內容不再整段貼進新 CLI 的終端機（終端機介面吃大段貼上很慢，模型也得先啃完才能互動），而是寫成 LatticeTerm 資料目錄下擁有者限定的 `handoffs/handoff-*.md`，只貼一行指向該檔案的提示，新 CLI 立刻可用、需要時自己讀檔；檔案一天後自動清掉。Codex 有明確 Session ID 時只接受 metadata 完全相符且不是 subagent 的 rollout；沒有 ID 時則只選同一 canonical 工作目錄的主 CLI 對話。Claude 也以 JSONL metadata 的 Session ID 精確尋找已驗證的主工作階段；沒有 ID 時才依 canonical 工作目錄選取，不依可能碰撞的專案資料夾 slug。Gemini 依官方 JSONL state records 還原 rewind 後的有效訊息，並用程序 hook 回報的 Session ID 區分同一資料夾的多個 CLI。Antigravity 則以該次程序限定的暫存 log 捕捉 Conversation ID，只讀對應 `transcript.jsonl` 的明確使用者輸入與最終回覆。所有有界歷程讀取都不跟隨最終符號連結。若勾選帶入但來源對話尚未寫入或無法安全讀取，新的 CLI 不會開啟，原工作階段會保留並顯示原因。

「保存啟動項目」會記錄內建 CLI 類型、標籤、工作目錄、選填備註，以及是否「留在背景」（還原時直接交給背景服務），最多 32 個；工作區名稱與項目順序也會保存。密碼、Token、API Key、Passphrase、Secret 參數與 Reporter 權杖都不會寫入工作區 JSON。下次開啟應用程式時，使用者可逐項或依保存順序整批確認並啟動 CLI 程序；沒有額外參數或舊版明確 Session ID 的 Codex 項目會執行 `codex resume --last`，由 Codex 在該工作目錄內續接最近的對話；Cursor 項目會執行官方的 `agent --continue` 續接最近對話，不需讓 LatticeTerm 保存或讀取 Session ID。既有 `agent-workspaces.json` 若包含舊版自訂 CLI 或原生 Session 續接項目，Rust 核心仍會重新驗證後相容還原，避免升級後破壞原有資料；新介面不再提供這兩種設定。Rust 核心會為每個活躍 PTY 保留最近 256 KiB 輸出，供同一桌面程序內的 WebView 重新 attach；正常關閉時，這段輸出以 XChaCha20-Poly1305 加密寫入裝置本機，隨機金鑰只留在 OS 安全儲存區，不進入 WebView、工作區 JSON 或備份。若安全儲存區不可用，輸出仍只存於記憶體。停止工作階段或關閉應用程式仍會終止 CLI 程序，但重開同一項目時可先重播加密保存的畫面尾端，再由對應 CLI 的原生續接功能恢復對話。

每個 CLI 都會收到本機 Reporter 環境變數。工具 hook 可執行 `"$LATTICETERM_AGENT_REPORTER" agent-report done`，並以 `working`、`needs-attention`、`idle` 或 `done` 回報狀態；Windows PowerShell 使用 `& $env:LATTICETERM_AGENT_REPORTER agent-report done`。Reporter 只接受該工作階段的隨機權杖，且只能更新狀態。完整協定與安全邊界請見架構文件。

Agent Fleet 同時會在桌面安裝包可用時提供 `LATTICETERM_REMOTE_CLI`，其值只是受信任的 `lattice-remote` 用戶端絕對路徑，不含主機、配對碼或其他憑證。AI CLI 仍必須由使用者指定連線目標與配對碼來源，LatticeTerm 不會自動部署。

### 用對話框跟 CLI 溝通

側邊導覽的「對話」頁提供聊天視窗，適合不習慣終端機的人。按「新對話」、從單一模型選單選擇 Claude Code、OpenAI Codex 或 Gemini CLI 的模型與工作目錄，之後輸入訊息按 Enter 即可；Shift+Enter 換行，中文輸入法選字時的 Enter 不會誤送。Claude Code 與 Gemini 每一輪 LatticeTerm 會以該 CLI 的 headless JSON 模式跑一次程序、把提示從 stdin 送入；Codex 則在第一則訊息時啟動一個常駐的 `codex app-server`，之後的追問直接送進同一個 thread，所以回覆明顯更快。回覆、思考摘要、工具呼叫與結束統計都即時顯示成訊息與卡片；「停止」會結束該輪（Codex 先送 `turn/interrupt`，5 秒內沒停才結束程序）。第一輪回報的 CLI 對話 ID 會留在對話裡供續接（`claude --resume`、Codex `thread/resume`、`gemini --resume`），所以關掉 LatticeTerm 再開仍可接著聊，但正在回覆中的那一輪不會跨重啟存活；Codex 的常駐程序閒置 15 分鐘或刪除對話時會自動結束。

權限選項對應各 CLI 的官方旗標：「唯讀」是 Claude `plan`／Codex `read-only`／Gemini `plan`；「可修改工作目錄」是 Claude `acceptEdits`／Codex `workspace-write`／Gemini `auto_edit`，Claude 與 Gemini 在這個模式下遇到仍需審核的指令會拒絕並在回覆裡說明，Codex 則在自己的沙箱裡執行；「全部允許」是 Claude `bypassPermissions`／Codex bypass sandbox／Gemini `yolo`，CLI 會以你的帳號權限做任何事而不再詢問，介面會明確警告。Claude Code 與 Codex 另有「每次詢問」（新對話的預設）：助理自己的規則放行不了的工具呼叫會在對話裡變成一張核准卡片，按允許或拒絕才會繼續，跟終端機裡的詢問一樣。Claude 走 stream-json 控制協定；Codex 走 `codex app-server` 的 JSON-RPC，指令、檔案修改與額外權限的請求都會變成卡片；Gemini 的非互動模式沒有對應機制所以不提供。對話內容只在本機 WebView 儲存區留一份有界複本（每則工具輸出最多 2 KiB、總量 4 MiB），完整逐字稿仍在各 CLI 自己的紀錄裡；登入資料與 API 金鑰不經過 LatticeTerm。

### 排程任務

對話頁側欄切到「排程」，按加號新增：名稱、指示、助理與模型的單一選單、工作目錄、權限（唯讀／可修改工作目錄／全部允許；沒有「每次詢問」，因為無人值守時沒人能回答），以及時間——「每天／每週固定時間」可勾星期與時刻，「每隔一段時間」以分鐘或小時計，最短 15 分鐘、最長 7 天。時間到了 LatticeTerm 會用對話模式開一個新對話送出指示，對話標題是「名稱 · 日期時間」，跑完在清單上標為未讀，「排程」分頁上也會顯示未看的數量；點開即為已讀。每個排程保留最近 20 次執行的結果（完成／失敗／中斷）並可直接跳到那次的對話。

LatticeTerm 開著時排程在視窗裡執行（每 30 秒檢查一次，可以看著它串流）；關著時只要背景服務還在（有任何啟用的排程就會常駐），就由背景服務準時執行，結果在下次開啟時以未讀對話出現在對話清單。背景服務沒在跑（例如重開機後還沒開過 LatticeTerm）時，錯過的會在下次開啟時補跑一次，之後回到原本的時間。同一個排程不會同時跑兩次，上一輪還沒結束就跳過這一輪。「立即執行」不會動到原本排定的時間。排程定義與指示存在這台電腦的 LatticeTerm 本機儲存區，會隨加密備份一起匯出。

Herdr 類型的背景服務、完整工具語意 Adapter、跨程序原 PTY 重新 attach 與自建遠端 attach 規劃，請見 [AI Agent Fleet 架構與整合藍圖](docs/AGENT_FLEET_ARCHITECTURE.zh-TW.md)。

### 專案驗證

```sh
npm run check
npm run build:sidecars
cargo test --manifest-path crates/lattice-remote/Cargo.toml --features "agent client-cli relay-server"
cargo test --manifest-path crates/lattice-rdp/Cargo.toml
cargo test --manifest-path crates/lattice-vnc/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## 安全性

完整加密備份包含連線設定、主機信任、Agent 工作區、通道與介面偏好，以及已經加密的本機保管庫；不包含作業系統認證儲存區中的密碼、外部 SSH 私鑰、工作階段輸出、截圖或錄影。匯出與還原時保管庫必須鎖定，還原時所有 SSH 通道也必須停止。

請勿將密碼、私鑰、憑證權杖或正式環境的主機資訊提交至原始碼、Issue 或螢幕截圖中。安全性通報請見 [SECURITY.md](SECURITY.md)。

## 參與貢獻

歡迎參與貢獻！開發與審查規範請見 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 授權條款

原始碼採用 [Mozilla Public License 2.0](LICENSE) 授權。商標與名稱規範請見 [TRADEMARKS.md](TRADEMARKS.md)。
