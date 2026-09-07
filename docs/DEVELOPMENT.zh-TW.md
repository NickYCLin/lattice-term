# LatticeTerm 本地開發

這份文件提供建置、驗證與進階操作指令。只想安裝使用，請先看 [專案首頁](../README.md) 或 [第一次使用](FIRST_RUN.zh-TW.md)。

維護者可參考 [Release 自動化與版本規則](RELEASE_AUTOMATION.zh-TW.md)；版本由 Conventional Commits 自動計算，通常累積至少 3 個使用者可感知項目才發布，重大漏洞可提前發布。只有合併 Release PR 才會正式發布。

## 環境需求

- Node.js (>= 22.12) 與 npm
- Rust stable 與 Cargo
- [Tauri 官方前置需求](https://v2.tauri.app/start/prerequisites/)

## 執行網頁預覽

```sh
npm install
npm run dev
```

## 執行桌面應用程式

```sh
npm install
npm run tauri dev
```

## 執行 Lattice Remote Agent

桌面版可直接按「分享這台裝置」，選擇明確的介面 IP、連接埠與更新率，並勾選是否允許對方操控，再自行決定是否讓分享留在背景。若要獨立執行 CLI，預設只監聽 loopback 且只傳畫面；從同一個區網連入時，必須明確指定該機器的 LAN 位址，要開放遠端控制則加上 `--allow-input`：

```sh
cargo run --manifest-path crates/lattice-remote/Cargo.toml --features agent --bin lattice-agent -- --bind 192.168.1.20:44900 --allow-input
```

直連模式的 32 位十六進位隨機配對碼五分鐘後失效，連續五次失敗就會停止；一次成功工作階段結束後程序也會退出。中繼模式會維持註冊並在每段工作階段結束後繼續等候，配對碼在停止分享前有效，也可由分享端明確改成固定碼。複製配對碼時預設 30 秒後清除剪貼簿，若內容已被其他複製操作取代則保留。預設唯讀；只有分享端明確加上 `--allow-input`（或介面勾選）才接受遠端滑鼠／鍵盤或終端輸入，檔案存取則必須另外加上 `--file-root`（或勾選並指定根目錄）。不要留白而分享整個家目錄；建議建立專用資料夾，只開放真正需要交換的檔案。

跨 NAT 使用時，分享端與檢視端填同一個 `wss://` Lattice Relay 網址，再以九位數裝置 ID 與 32 位十六進位隨機配對碼連線。成功使用一次後，介面會記住並收合中繼位址，該裝置也會留在「我的連線」；之後可繼續手動輸入配對碼，或在連線對話框明確選擇安全保存。這是介面簡化，不是把位址當成機密，端點仍可由本機設定與網路流量得知。公網 Relay 應只監聽 loopback，並放在 Cloudflare Tunnel、nginx 或 Caddy 等 HTTPS/WebSocket 入口後；此時所有公網客戶端在 relay 眼中都是 127.0.0.1，內建的每 IP 限速預設會全部放行，請以 `--client-ip-header`（Cloudflare 用 `Cf-Connecting-Ip`）指名 ingress 寫入真實來源的標頭，或改在 ingress 端限速。原生 `主機:連接埠` 模式沒有 TLS，只適合可信任的私有網路或 VPN。完整部署、安全與多人服務邊界見 [Lattice Remote 中繼伺服器](RELAY_SERVER.zh-TW.md)。

沒有桌面環境的純文字主機加上 `--terminal` 即可分享加密的 shell 終端機（而非畫面）；搭配擁有者限定讀取的 `--pair-code-file` 即可無人值守重連，避免固定碼直接出現在程序參數。連續五次配對失敗會自動停止；常駐服務不得用無條件自動重啟繞過這個保護。檢視端一樣以裝置 ID＋配對碼連線，開啟的是終端分頁。細節見 `lattice-agent --help` 與上述中繼文件。

## 從 Agent Fleet CLI 傳檔與部署

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

## 執行 AI Agent Fleet

Agent Fleet 只在 Tauri 桌面版啟動本機 CLI；網頁預覽會誠實顯示後端不可用。開啟側邊導覽的「AI Agent Fleet」，選擇工作目錄後即可啟動已偵測到的內建 CLI。未偵測到工具時，卡片會先列出經專案固定的安裝指令；使用者確認後才會開啟安裝終端，LatticeTerm 不會在背景靜默下載或執行安裝。若該平台沒有可直接執行的安全安裝方式，則提供可複製的安裝說明網址。安裝程式若更新 PATH，可能需要重開 LatticeTerm 才會被偵測到。批次提示必須先勾選執行中的目標並再次確認，LatticeTerm 不保存提示內容。

要同時用兩個以上的 Codex 或 Claude Code 帳號（例如個人與公司各一個），在卡片上按「新增另一個帳號…」，輸入名稱後按「加入並登入」即可，不需選擇資料夾。LatticeTerm 會自動為各帳號分開保存登入狀態，並直接開啟新帳號的終端機，依 CLI 提示登入一次（Claude Code 輸入 `/login`，Codex 會顯示登入選項）；之後選取帳號就能使用，清單裡會顯示登入狀態。新增期間會阻止重複送出；若終端機未能開啟，帳號仍保留且已選取，可按「啟動」重試。「移除這個帳號」會先確認，LatticeTerm 自己建立的目錄連登入資料一起刪除；舊版自行指定的設定目錄仍可使用，移除時只從清單移除。對話頁的帳號選單也用同一份清單。

勾選「留在背景（關閉 LatticeTerm 後繼續執行）」啟動的工作階段，會交給 LatticeTerm 自己的本機背景服務持有：關掉視窗它照跑，下次開啟 LatticeTerm 會自動接回並重播最近 256 KiB 的輸出，分頁上以「背景」標示。背景服務就是同一個 `lattice-term` 執行檔以 `agent-daemon` 子命令啟動，只監聽應用程式資料目錄下使用者專屬的本機 socket（Windows 為具名管道），連線要先出示同目錄下只有你讀得到的權杖；它沒有工作階段也沒有視窗連著 60 秒後會自己結束。想一次結束所有背景工作階段，按啟動表單下方的「結束背景服務」（會先確認）；沒有勾選的工作階段行為與以前完全一樣，仍隨 LatticeTerm 結束。

若要讓另一個 CLI 接手，請在執行中的工作階段分頁選擇「加開 CLI」；來源為 Codex、Claude Code、Gemini CLI 或 Google Antigravity CLI 時，可勾選「帶入目前對話」。任何已安裝的新 CLI 都會收到整理過的對話交接內容，但不會搬移模型內部狀態、登入資料或憑證。交接內容不再整段貼進新 CLI 的終端機（終端機介面吃大段貼上很慢，模型也得先啃完才能互動），而是寫成 LatticeTerm 資料目錄下擁有者限定的 `handoffs/handoff-*.md`，只貼一行指向該檔案的提示，新 CLI 立刻可用、需要時自己讀檔；檔案一天後自動清掉。Codex 有明確 Session ID 時只接受 metadata 完全相符且不是 subagent 的 rollout；沒有 ID 時則只選同一 canonical 工作目錄的主 CLI 對話。Claude 也以 JSONL metadata 的 Session ID 精確尋找已驗證的主工作階段；沒有 ID 時才依 canonical 工作目錄選取，不依可能碰撞的專案資料夾 slug。Gemini 依官方 JSONL state records 還原 rewind 後的有效訊息，並用程序 hook 回報的 Session ID 區分同一資料夾的多個 CLI。Antigravity 則以該次程序限定的暫存 log 捕捉 Conversation ID，只讀對應 `transcript.jsonl` 的明確使用者輸入與最終回覆。所有有界歷程讀取都不跟隨最終符號連結。若勾選帶入但來源對話尚未寫入或無法安全讀取，新的 CLI 不會開啟，原工作階段會保留並顯示原因。

「保存啟動項目」會記錄內建 CLI 類型、標籤、工作目錄、選填備註，以及是否「留在背景」（還原時直接交給背景服務），最多 32 個；工作區名稱與項目順序也會保存。密碼、Token、API Key、Passphrase、Secret 參數與 Reporter 權杖都不會寫入工作區 JSON。下次開啟應用程式時，使用者可逐項或依保存順序整批確認並啟動 CLI 程序；沒有額外參數或舊版明確 Session ID 的 Codex 項目會執行 `codex resume --last`，由 Codex 在該工作目錄內續接最近的對話；Cursor 項目會執行官方的 `agent --continue` 續接最近對話，不需讓 LatticeTerm 保存或讀取 Session ID。既有 `agent-workspaces.json` 若包含舊版自訂 CLI 或原生 Session 續接項目，Rust 核心仍會重新驗證後相容還原，避免升級後破壞原有資料；新介面不再提供這兩種設定。Rust 核心會為每個活躍 PTY 保留最近 256 KiB 輸出，供同一桌面程序內的 WebView 重新 attach；正常關閉時，這段輸出以 XChaCha20-Poly1305 加密寫入裝置本機，隨機金鑰只留在 OS 安全儲存區，不進入 WebView、工作區 JSON 或備份。若安全儲存區不可用，輸出仍只存於記憶體。停止工作階段或關閉應用程式仍會終止 CLI 程序，但重開同一項目時可先重播加密保存的畫面尾端，再由對應 CLI 的原生續接功能恢復對話。

每個 CLI 都會收到本機 Reporter 環境變數。工具 hook 可執行 `"$LATTICETERM_AGENT_REPORTER" agent-report done`，並以 `working`、`needs-attention`、`idle` 或 `done` 回報狀態；Windows PowerShell 使用 `& $env:LATTICETERM_AGENT_REPORTER agent-report done`。Reporter 只接受該工作階段的隨機權杖，且只能更新狀態。完整協定與安全邊界請見架構文件。

Agent Fleet 同時會在桌面安裝包可用時提供 `LATTICETERM_REMOTE_CLI`，其值只是受信任的 `lattice-remote` 用戶端絕對路徑，不含主機、配對碼或其他憑證。AI CLI 仍必須由使用者指定連線目標與配對碼來源，LatticeTerm 不會自動部署。

## 用對話框跟 CLI 溝通

主分支新增不選專案資料夾的一般對話、對話完成提示音，以及可選用的 Codex 瀏覽器工具。
這些修改尚未包含在目前安裝檔，操作方式與限制見 [對話頁功能對照](CHAT_DESKTOP_PARITY.zh-TW.md)。

側邊導覽的「對話」頁提供聊天視窗，適合不習慣終端機的人。按「新對話」、從單一模型選單選擇 Claude Code、OpenAI Codex 或 Gemini CLI 的模型與工作目錄，之後輸入訊息按 Enter 即可；Shift+Enter 換行，中文輸入法選字時的 Enter 不會誤送。Claude Code 與 Gemini 每一輪 LatticeTerm 會以該 CLI 的 headless JSON 模式跑一次程序、把提示從 stdin 送入；Codex 則在第一則訊息時啟動一個常駐的 `codex app-server`，之後的追問直接送進同一個 thread，所以回覆明顯更快。回覆、思考摘要、工具呼叫與結束統計都即時顯示成訊息與卡片；「停止」會結束該輪（Codex 先送 `turn/interrupt`，5 秒內沒停才結束程序）。第一輪回報的 CLI 對話 ID 會留在對話裡供續接（`claude --resume`、Codex `thread/resume`、`gemini --resume`），所以關掉 LatticeTerm 再開仍可接著聊，但正在回覆中的那一輪不會跨重啟存活；Codex 的常駐程序閒置 15 分鐘或刪除對話時會自動結束。

權限選項對應各 CLI 的官方旗標：「唯讀」是 Claude `plan`／Codex `read-only`／Gemini `plan`；「可修改工作目錄」是 Claude `acceptEdits`／Codex `workspace-write`／Gemini `auto_edit`，Claude 與 Gemini 在這個模式下遇到仍需審核的指令會拒絕並在回覆裡說明，Codex 則在自己的沙箱裡執行；「全部允許」是 Claude `bypassPermissions`／Codex bypass sandbox／Gemini `yolo`，CLI 會以你的帳號權限做任何事而不再詢問，介面會明確警告。Claude Code 與 Codex 另有「每次詢問」（新對話的預設）：助理自己的規則放行不了的工具呼叫會在對話裡變成一張核准卡片，按允許或拒絕才會繼續，跟終端機裡的詢問一樣。Claude 走 stream-json 控制協定；Codex 走 `codex app-server` 的 JSON-RPC，指令、檔案修改與額外權限的請求都會變成卡片；Gemini 的非互動模式沒有對應機制所以不提供。對話內容只在本機 WebView 儲存區留一份有界複本（每則工具輸出最多 2 KiB、總量 4 MiB），完整逐字稿仍在各 CLI 自己的紀錄裡；登入資料與 API 金鑰不經過 LatticeTerm。

## 排程任務

對話頁側欄切到「排程」，按加號新增：名稱、指示、助理與模型的單一選單、工作目錄、權限（唯讀／可修改工作目錄／全部允許；沒有「每次詢問」，因為無人值守時沒人能回答），以及時間——「每天／每週固定時間」可勾星期與時刻，「每隔一段時間」以分鐘或小時計，最短 15 分鐘、最長 7 天。時間到了 LatticeTerm 會用對話模式開一個新對話送出指示，對話標題是「名稱 · 日期時間」，跑完在清單上標為未讀，「排程」分頁上也會顯示未看的數量；點開即為已讀。每個排程保留最近 20 次執行的結果（完成／失敗／中斷）並可直接跳到那次的對話。

LatticeTerm 開著時排程在視窗裡執行（每 30 秒檢查一次，可以看著它串流）；關著時只要背景服務還在（有任何啟用的排程就會常駐），就由背景服務準時執行，結果在下次開啟時以未讀對話出現在對話清單。背景服務沒在跑（例如重開機後還沒開過 LatticeTerm）時，錯過的會在下次開啟時補跑一次，之後回到原本的時間。同一個排程不會同時跑兩次，上一輪還沒結束就跳過這一輪。「立即執行」不會動到原本排定的時間。排程定義與指示存在這台電腦的 LatticeTerm 本機儲存區，會隨加密備份一起匯出。

Herdr 類型的背景服務、完整工具語意 Adapter、跨程序原 PTY 重新 attach 與自建遠端 attach 規劃，請見 [AI Agent Fleet 架構與整合藍圖](AGENT_FLEET_ARCHITECTURE.zh-TW.md)。

## 專案驗證

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
