# LatticeTerm 功能與限制

這份文件收錄主分支的功能、操作邊界、快捷鍵與後續方向。第一次使用請從 [專案首頁](../README.md) 開始。
主分支可能包含尚未發布的修改，安裝檔請以 [Release 更新說明](https://github.com/NickYCLin/lattice-term/releases) 為準。

## 完成度總覽

| 範圍 | 狀態 | 現況與邊界 |
| --- | --- | --- |
| 桌面連線工作區 | **可用** | Windows、Linux 與 macOS 支援 SSH、SFTP、SSH Tunnel、Web RDP、VNC、主機資源與工作階段管理；SFTP 與新版 Lattice Remote（Linux／macOS 分享端）可線上編輯 1 MiB 以內的 UTF-8 純文字。 |
| 安全與資料保護 | **可用** | 嚴格主機信任、作業系統認證儲存、主密碼加密保管庫、敏感剪貼簿與加密備份均已接入真實後端。 |
| 本機 AI Agent Fleet | **可用** | 多 CLI PTY、Reporter、批次提示、同分頁加開 CLI 並帶入目前對話、安全啟動工作區與同程序重新 attach 已完成；另有不必打指令的對話模式（Claude Code、Codex 與 Gemini CLI，Claude 與 Codex 含逐項核准）與應用程式開著時執行的排程任務。 |
| Lattice Remote | **基礎功能可用** | 已完成使用者主動啟動、Noise 端對端加密、主螢幕／純終端分享，以及由分享端分別授權的鍵盤／滑鼠或終端輸入與單一根目錄檔案瀏覽、上下載；另支援自架 lattice-relay 中繼、永久九位數裝置 ID、跨網路連線、裝置金鑰釘選與固定配對碼（無人值守）；以 ID 連線過的裝置會留在「我的連線」，中繼位址失效時可在連線對話框就地更正。目前仍是自架、小規模服務，NAT 直連穿透與多人租戶管理尚未加入。 |
| 發行與更新 | **可用** | Windows x64、Linux x64／arm64、macOS Intel／Apple Silicon 安裝檔、更新簽章、Release PR 與應用程式內更新已自動化。 |
| Android | **預覽** | 共用的純 Rust SSH／SFTP／Tunnel／Vault 核心與行動介面可建置；需要桌面 sidecar 的 RDP、VNC 與 Agent Fleet 不提供。 |
| iOS | **預覽／上架準備中** | 已有 Simulator 驗證；提供 App Store 匯出、獨立建置號、區網權限說明、隱私清單與發布檢查。簽章實機安裝、TestFlight 與 App Store 審核仍待完成，詳見 [iOS 發布流程](IOS_RELEASE.zh-TW.md)。 |
| 進階 Agent 與行動能力 | **部分完成** | 排程任務、接續執行與同時執行上限、提示佇列，Linux 的 bubblewrap 檔案範圍沙箱，跨程序背景服務（勾選「留在背景」的工作階段在關閉 LatticeTerm 後繼續執行、下次開啟自動接回），以及讓外部 AI 透過 MCP 查看、提示與啟動分享的背景工作階段已完成；SSH MCP 遠端 Fleet 已支援工作區授權與多 PTY；遠端 panes、macOS／Windows 的沙箱與 iOS 上架仍待完成。 |

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
- **五種重新設計的主題**：霧墨、白瓷、暮藍、亞麻與清晰，另可跟隨系統；切換時原生標題列會一起換色。這組主題位於主分支，尚待下一版發布。
- **主機資源檢視**：活躍 SSH 工作階段可定期讀取 Linux 主機的 CPU、記憶體、磁碟與開機時間；未連線或不支援的平台會明確說明，不顯示假數值。
- **本機持久化**：連線設定會存在本機的應用程式資料目錄，關閉再開仍在；檔案只含主機資訊，不含任何認證資料。
- **AI Agent Fleet**：以原生 PTY 同時執行 Codex、Claude Code、Gemini CLI、Google Antigravity CLI、OpenCode、Hermes 等 13 種本機 LLM CLI；未偵測到工具時可先確認固定的上游安裝指令，再開啟看得到完整輸出的安裝終端。目錄會顯示 Codex、Claude 與 Gemini 自己保存在本機的目前登入帳號標籤，但 token 不會進入 WebView。執行中的 CLI 會分開顯示工具名稱、分頁名稱，以及工具啟動畫面或 `--model` 實際回報的模型；沒有可靠值時會明確標成尚未回報。使用者可選擇保存一份工作區共用啟動指示，讓之後每個全新 CLI 進入互動提示後先讀取；也可把專案根目錄的 `AGENTS.md` 設為 Codex、Claude 與 Gemini 的唯一規則來源，由 LatticeTerm 保留既有內容並安全同步 `CLAUDE.md`／`GEMINI.md` 的原生匯入。自動還原的舊工作階段不會重送啟動指示，且會一併保留原本側欄的資料夾、排序與收合狀態，不會因 CLI 尚在續接而回到最外層。內建繁中 Commit 範本採 `type(scope): subject`、Why／What 與單一意義提交，預設不啟用。通用 Reporter 讓工具 hook 明確回報狀態；Hermes 也會透過官方 `post_api_request` hook 顯示該工作階段與子 Agent 累計的可信 token buckets，不讀取提示或回覆內容。使用者可在二次確認後將同一段提示送給多個已選 Agent，並可選擇「忙碌時排入佇列」——正在工作的 Agent 會等這一輪真的結束才收到，不會插進它做到一半的事情；只有官方整合回報結束才放行，終端 heuristic 的猜測不算，已經閒置的則照舊立刻送出。執行中的分頁可直接加開另一個 CLI，並選擇帶入目前脈絡：各 CLI 統一透過 LatticeTerm 管理的一次性交接檔接收內容，保留既有記憶與私有 session 檔。CLI 自行結束時，LatticeTerm 會保留唯讀分頁與退出前畫面，直到使用者關閉，不會突然跳回其他專案。啟動項目可加入選填備註並保存到可命名、排序的工作區；重新啟動已保存的 Codex 項目時，會續接同一工作目錄最近的對話，Cursor 項目則使用官方的最近對話續接。同一桌面程序內若 WebView 重新載入，活躍 PTY 會重新 attach 並重播最近 256 KiB 記憶體輸出；正常關閉桌面程式時，這段輸出會以 OS 安全儲存區中的裝置金鑰加密保存，下次還原同一項目時先重播。安全儲存區不可用時不會把輸出寫入磁碟。登入與 token 仍由各 CLI 自行管理。
- **對話模式**：不想用終端機的人可以在「對話」頁用聊天視窗跟 Claude Code、OpenAI Codex 或 Gemini CLI 溝通，做法參考 Codex Desktop：Claude Code 與 Gemini CLI 每一輪以官方 headless JSON 模式執行一次（`claude -p --output-format stream-json`、`gemini --output-format stream-json`）；Codex 則為每個對話常駐一個 `codex app-server`，thread 開好後追問只送 `turn/start`，不必重新啟動程序與重新載入紀錄，閒置 15 分鐘或刪除對話時才結束。回覆逐字串流顯示，每個工具呼叫是一張可展開的卡片，結束時顯示耗時、token 與費用。之後的訊息以 CLI 自己的對話 ID 續接，所以登入、模型與對話紀錄都還是 CLI 的。權限用效果命名而不是各家旗標：「每次詢問」（Claude Code 與 Codex，工具呼叫變成對話裡的核准卡片）、「唯讀」、「可修改工作目錄」、「全部允許（危險）」，後三者分別對應 Claude 的 `plan`／`acceptEdits`／`bypassPermissions`、Codex 的 `read-only`／`workspace-write`／bypass sandbox，以及 Gemini 的 `plan`／`auto_edit`／`yolo`。設定區只用一個依助理分組的模型選單，選模型時同時決定背後 CLI；Claude 與 Codex 從自己的協定取得模型，Gemini 則使用官方穩定的 Auto／Pro／Flash／Flash Lite 路由別名。讀取 Claude 模型與開始 Claude 對話會共用認證啟動閘門，前一個程序完成初始化後才啟動下一個，避免有效登入因並行 OAuth token 更新而誤報失敗；若外部 Claude 程序仍占用 refresh lock，僅在本輪尚未產生任何回覆或工具動作時短暫退避重試兩次，避免重複執行指令。對話清單跟工作項目一樣可建立巢狀資料夾、拖曳整理。介面用語一律稱「助理」，不出現 CLI。對話內容只在這台電腦的 LatticeTerm 本機儲存區留一份有界複本；提示走 stdin 而非命令列參數，不會出現在程序清單；Windows 上以 `CREATE_NO_WINDOW` 啟動，不會彈出主控台視窗。
- **排程任務**：對話頁的「排程」分頁做法參考 Codex 的 Automations：寫一段指示、選 CLI、專案與時間（每天／每週固定時刻，或每隔一段時間），LatticeTerm 開著時就會準時用對話模式跑一輪，每次執行都開一個新對話，結果以未讀標記出現在對話清單裡等你看；可立即執行、暫停、編輯、刪除，並保留最近 20 次執行紀錄。LatticeTerm 關著時由背景服務準時執行，結果在下次開啟時以未讀對話出現（背景服務沒在跑時才會在下次開啟補跑一次）；無人值守不提供「每次詢問」權限，預設唯讀。
- **MCP Server**：外部 AI 工具可查看在 Agent Fleet 頁明確分享的背景工作階段。第一次分享只開放工作階段資訊、狀態與狀態等待；另勾「允許 MCP 讀取內容」才可增量讀取終端輸出與內容片段。控制權獨立授權，取消內容讀取不會取消狀態分享或控制權。允許啟動保存項目時，產生的工作階段會自動分享、允許讀取內容並可控，介面會明示。舊背景服務不支援內容分權時不開放新分享，保留舊分享的原有權限與撤銷操作，不自動中斷 CLI。另外在設定頁可把 RDP／VNC／Lattice Remote 的畫面分享給 MCP，讓它每兩秒取一張目前畫面——鍵盤滑鼠另外授權並需新鮮、單次使用的畫面憑據；沒有串流，斷線重連即失效。另可獨立授權 SSH 上的遠端 Fleet 工作區，按 Agent ID 分別讀取、啟動與控制背景 PTY。設定片段、工具與相容性邊界見 [MCP Server](MCP.zh-TW.md)。
  派送需要 CLI 官方就緒回報，會避開使用者編輯中的提示；撤權保留使用者自己的排隊工作。request ID 防並行重送，慢 client 的等待與輸出有界。最近 256 筆操作紀錄可安全保存在本機，跨背景服務重啟還原；寫入失敗會明示，不清空原檔。設定頁可逐項開放既有 SSH 的 Linux 資訊／指定指令，以及 SFTP 核准目錄的清單／上下載；權限預設關閉，不代登入或接受主機金鑰。沒有官方 hook 的 CLI 需手動操作；遠端畫面工具尚未實作。
- **Agent 沙箱（Linux）**：裝有 bubblewrap 的機器上，啟動 CLI 時可勾選「沙箱：只能改工作目錄」——整個檔案系統唯讀，只有工作目錄、該工具自己的登入與狀態目錄和 /tmp 可寫，PID 隔離、網路照常；選項會跟著工作區項目保存與還原，清單上有「沙箱」標記。沒有 bwrap、或系統禁止非特權 user namespace（Ubuntu 24.04 起預設如此，需為 bwrap 啟用發行版提供的 AppArmor 設定檔）時不提供這個選項，也不會假裝有隔離。
- **可靠的 Agent 狀態**：Codex、Claude Code、Gemini CLI、OpenCode、GitHub Copilot CLI、Hermes Agent 與 Qwen Code 會以各自官方 lifecycle hook／plugin event 明確回報工作中、完成或等待權限；Claude 與 Qwen 尚有背景工作或排程時不會誤標完成，OpenCode、Copilot 與 Hermes 的子 Agent 結束也不會被當成主工作階段完成。Gemini、OpenCode、Copilot、Hermes 與 Qwen 的整合只套用在該次 LatticeTerm 工作階段，不改使用者設定；若主機已有不可安全合併的程序級設定、專案停用所有 hooks、無法辨識 Hermes 安裝結構，或 CLI 以 pure／safe／bare mode 啟動，就保留原設定並使用保守 heuristic。其他尚未整合 hook 的工具只使用保守的終端提示 heuristic：看到提示列重新開啟 bracketed paste 之後，還要再安靜兩秒才標成完成，因為 TUI 重繪也會送同一個控制碼；期間有輸出就從最新輸出重新計時。狀態不會憑空猜測：只有使用者實際送出打好的提示才算開始工作，單獨按 Enter 接受資料夾信任對話框或清空提示都不會標成執行中；整合始終沒有回報且終端連續 10 分鐘無輸出時，會退回「閒置」而不是謊稱「完成」。
- **SSH 連線**：以純 Rust 的 russh 實作，可使用密碼或本機 OpenSSH 私鑰建立終端機工作階段。主機金鑰未經確認不會連線，金鑰變更會直接擋下；密碼預設只用於當次連線，使用者可在驗證成功後明確保存到系統認證儲存區，私鑰內容與密語不會保存至連線設定。執行中的 SSH 分頁可一鍵「開啟檔案總管」，以同一台主機、同一組認證開啟 SFTP 圖形化檔案瀏覽（已保存密碼免再輸入）。
- **SSH Tunnel**：可建立本機、遠端與 SOCKS5 動態轉送，顯示即時狀態與連線數；動態代理若未設定驗證只允許綁定 loopback，遠端轉送則依 SSH 伺服器的 GatewayPorts 政策生效。
- **遠端文字編輯**：SFTP 與新版 Lattice Remote（Linux／macOS 分享端）檔案列的「編輯文字」可開啟設定檔、程式碼及一般純文字，支援儲存、Ctrl／⌘+S、重新載入與未儲存提醒。上限 1 MiB、UTF-8，保留 BOM 和 LF／CRLF；不支援混合換行、Word、PDF、二進位或符號連結。儲存前核對內容雜湊與中繼資料，拒絕已偵測的外部變更，每次保存保留原檔備份並顯示位置。草稿只在記憶體中；關閉應用程式前請儲存或自行複製。這是可恢復的替換，不是可抵抗任意外部寫入的原子 CAS；SFTP 無法保證 ACL 與 hardlink 關係，詳見 [編輯安全邊界](REMOTE_TEXT_EDITING.zh-TW.md)。
- **SFTP 檔案工作區**：沿用 SSH 主機指紋驗證與獨立的認證項目，可瀏覽遠端路徑、上下載、新增資料夾、重新命名及確認刪除；上傳除了按鈕選檔，也可直接把檔案從檔案總管拖進面板上傳到目前資料夾。大型檔案經有界分塊與原生串流佇列傳輸，不把整個檔案塞進 WebView／IPC 記憶體。上傳先寫入同目錄的私有暫存檔，只有位元組數完整且關檔成功才替換目標，取消、失敗或中斷連線不會把既有檔案變成半成品。
- **Lattice Remote（協定 v2）**：桌面版內建「分享這台裝置」，可在區網直連，或經自架 `lattice-relay` 以永久九位數裝置 ID 跨網路連線。中繼只轉送密文，兩端以 Noise XXpsk3 端對端加密，回訪時核對永久裝置金鑰。沒有桌面環境的主機可分享加密 shell 終端。**兩端的應用程式版本不必相同**；已信任的舊八位數配對主機，可沿用裝置 ID、配對碼和常駐服務，新版會在送出配對證明前核對裝置金鑰。新版開始分享仍使用 32 位十六進位隨機碼。首次使用舊主機、舊版 IP 直連及真正不相容協定的限制，見 [版本相容](RELAY_SERVER.zh-TW.md#版本相容)。

  以 ID 連線成功的裝置會存成一般設定檔，留在「我的連線」。可手動輸入配對碼，或選擇在成功配對後保存到系統認證儲存區；配對碼不會寫入連線設定檔，儲存項目同時綁定設定檔與永久裝置 ID。中繼沒有回應時，連線視窗會提供位址欄位；只有連線成功才保存新位址。鍵鼠、終端輸入與檔案分享分開授權，依主機公告的能力提供功能。檔案模式只暴露指定的單一根目錄，拒絕路徑跳脫和越界符號連結，上傳完整收完並安全關檔後才替換目標。斷線或停止分享會釋放輸入並清除未完成的檔案暫存。
- **Web RDP Canvas**：IronRDP 原生 engine 以 TLS/NLA 連到 Windows，畫面繪入內嵌 Canvas，並支援滑鼠、滾輪與鍵盤。密碼只經本機 stdin 傳給隔離 engine，也可在成功驗證後安全保存。
- **使用者控制的截圖與錄影**：Lattice Remote、Web RDP 與 VNC 都可手動擷取 PNG，或開始、停止並下載遠端 Canvas 錄影；不會自動錄製或上傳。
- **跨平台支援**：桌面版支援 Windows、Linux 與 macOS；Android 與 iOS 版已可建置共用的純 Rust 核心功能，iOS 已有 Simulator 驗證與 In-House 企業 IPA；需本機程序的 RDP／VNC／CLI Fleet 維持桌面限定。

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
2. **Agent 常駐與遠端能力**：背景服務已能持有勾選「留在背景」的工作階段並跨視窗關閉接回；保存的啟動項目也會記住這個選擇，還原時直接回到背景；對話排程在 LatticeTerm 關著時也由背景服務準時執行。SSH transport 已提供 MCP 工作區與遠端多 PTY 操作；桌面遠端 panes 與 Relay Fleet transport 尚未提供。
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

## 安全性

完整加密備份包含連線設定、主機信任、Agent 工作區、通道與介面偏好，以及已經加密的本機保管庫；不包含作業系統認證儲存區中的密碼、外部 SSH 私鑰、工作階段輸出、截圖或錄影。匯出與還原時保管庫必須鎖定，還原時所有 SSH 通道也必須停止。

請勿將密碼、私鑰、憑證權杖或正式環境的主機資訊提交至原始碼、Issue 或螢幕截圖中。安全性通報請見 [SECURITY.md](../SECURITY.md)。
