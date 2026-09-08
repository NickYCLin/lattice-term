# LatticeTerm MCP Server（A 唯讀觀測 + B 受控協作）

LatticeTerm 可以當成一個 [Model Context Protocol](https://modelcontextprotocol.io/) 伺服器，讓外部 AI 工具（Claude Code、Codex CLI、Gemini CLI、Cursor 等支援 MCP 的 client）查看你**明確分享**的 Agent Fleet 背景工作階段：列出狀態、讀取終端輸出、等待狀態改變；對你另外勾選「可控」的工作階段送指示、清佇列或結束它；以及在你打開啟動開關後，啟動你保存過的背景啟動項目。

這是 [#180](https://github.com/NickYCLin/lattice-term/issues/180) 提案的 A 與 B 階段。C（SSH／SFTP）、D（遠端畫面）尚未實作，見文末。

## 運作方式

```text
支援 MCP 的 AI client（Claude Code、Codex、Gemini CLI…）
        │ stdio（JSON-RPC 2.0，一行一則）
        ▼
lattice-term mcp --data-dir <資料目錄>          ← 同一個 LatticeTerm 執行檔的子命令
        │ observer 角色連上使用者專屬本機 socket
        ▼
lattice-term agent-daemon（背景服務）           ← 只回應「已分享」的工作階段
```

- **只有背景工作階段可分享。** 啟動 CLI 時勾「留在背景」的工作階段由背景服務持有；桌面程序自己的工作階段、對話頁、SSH／SFTP、遠端畫面都沒有對外路徑。
- **預設不分享，可隨時撤銷。** 在 Agent Fleet 頁「執行中」清單裡，每個背景工作階段旁有「分享給 MCP」勾選框；分享狀態存在背景服務的記憶體裡，工作階段結束或背景服務結束就自動取消。
- **讀跟寫是兩個授權。** 分享只給看；要讓 MCP client 對某個工作階段送指示、清除 MCP 指示佇列或結束它，得再勾「允許 MCP 送指示與停止」。取消可控或分享時，尚未送出的 MCP 指示一併移除；你自己排隊的工作保留。取消可控不影響分享。
- **啟動是第三個授權。** MCP 區塊裡的「允許 MCP 啟動已保存的背景啟動項目」打開後，client 才能用 `launch_agent` 啟動「跨重啟還原」清單裡勾了「留在背景」的項目，內容完全照你保存的（CLI、參數、工作目錄、沙箱、共用啟動指示），不能自訂指令；它啟動的工作階段自動分享並可控。這個開關存在啟動項目檔裡，開著時背景服務會保持常駐。
- **你看得到誰做了什麼。** 每個分享的工作階段旁會顯示最近一次 MCP 操作：client 名稱（來自 MCP `initialize` 的 `clientInfo`）、動作與時間；背景服務日誌也記一行（只有中繼資料，不記提示內容）。
- **adapter 不會啟動背景服務。** 背景服務沒在跑時，`list_agent_sessions` 回 `daemonRunning: false` 與空清單，讀取與等待回 `isError` 說明原因；不會為了讓模型有東西看而拉起程序。
- **權限由背景服務端強制。** adapter 以 `observer` 角色打招呼，背景服務只接受已分享工作階段的觀測、另外授權的操作，以及允許的啟動項目查詢；其他管理請求一律拒絕。`readOnlyHint` 等 MCP annotation 只是描述。
- **權杖留在 adapter 程序。** 連線用的 `agent-daemon.token`（0600）由 adapter 讀取，不會出現在任何工具結果裡。
- **觀察者收不到終端位元組事件。** 背景服務只把已分享工作階段的 `state`／`closed`／`model`／`usage`／`queue` 事件推給觀察者，輸出一律用 cursor 主動讀，慢的 client 不會累積終端資料。
- **觀察者不算「有視窗連著」。** 對話排程的無視窗執行與閒置自動結束都不受 MCP 連線影響。

## 設定 client

Agent Fleet 頁的「分享給外部 AI（MCP）」區塊會顯示這台機器正確的指令（含執行檔路徑與資料目錄）並可複製。內容等同：

Claude Code：

```bash
claude mcp add latticeterm -- /path/to/lattice-term mcp --data-dir ~/.local/share/io.github.nickyclin.latticeterm
```

Codex CLI（`~/.codex/config.toml`）：

```toml
[mcp_servers.latticeterm]
command = "/path/to/lattice-term"
args = ["mcp", "--data-dir", "/home/you/.local/share/io.github.nickyclin.latticeterm"]
```

Gemini CLI、Cursor 等使用 `mcpServers` JSON 的工具：

```json
{
  "mcpServers": {
    "latticeterm": {
      "command": "/path/to/lattice-term",
      "args": ["mcp", "--data-dir", "/home/you/.local/share/io.github.nickyclin.latticeterm"]
    }
  }
}
```

`--data-dir` 可省略，預設是這個平台的應用程式資料目錄（Linux `~/.local/share/io.github.nickyclin.latticeterm`、macOS `~/Library/Application Support/io.github.nickyclin.latticeterm`、Windows `%APPDATA%\io.github.nickyclin.latticeterm`）；介面顯示的指令一律帶完整路徑，AppImage 會指向 AppImage 檔本身而不是暫時掛載點。Unix 上 adapter 會先讀資料目錄裡背景服務記下的 `agent-daemon.socket`，所以 client 環境沒有 `XDG_RUNTIME_DIR` 也找得到；Windows 的具名管道名稱來自正規化後的資料目錄（先 canonicalize，再統一反斜線、去尾斜線、忽略大小寫、拿掉 `\\?\`），`C:/x`、`C:\x\`、`c:\X` 都是同一個安裝。

## 工具

所有工具都回傳 `content`（JSON 文字）與 `structuredContent`（同一份 JSON）；可服務但無法完成的呼叫（背景服務沒在跑、工作階段未分享）回 `isError: true` 並說明；參數錯誤回 JSON-RPC `-32602`。

| 工具 | 參數 | 回傳 |
| --- | --- | --- |
| `get_capabilities` | 無 | `daemonRunning`、`backends`（目前只有 `agentFleetBackground`，依授權回 `access: readOnly` 或 `control`）、`sharedSessions`、`controlledSessions`、`launchEnabled`、`launchablePlans`、`limits`、`limitations` 文字清單 |
| `list_agent_sessions` | 無 | `daemonRunning` 與 `sessions[]`：`sessionId`、`label`、`groupLabel`、`definitionId`、`model`、`workingDirectory`、`state`（`working`／`needsAttention`／`idle`／`done`）、`stateSource`（`integration` 為 CLI 官方 hook 回報，`heuristic` 為由輸出猜測）、`queuedPrompts`、`tokenUsage`（有才附）、`sandboxed`。不含執行檔、啟動參數、帳號目錄、PID 與原生對話 ID |
| `read_agent_output` | `sessionId`（必填）、`cursor`（位元組位移，預設 0）、`maxBytes`（分頁大小，預設 16384，上限 65536，可超額至多 4096） 、`stripControlSequences`（預設 true） | `text`、`cursor`（實際起點）、`nextCursor`、`endOffset`、`availableFrom`、`truncated`、`hasMore` |
| `wait_agent_state` | `sessionId`（必填）、`timeoutMs`（預設 30000，上限 120000）、`state`（上次看到的狀態） | `session`（同 list 的單筆）、`changed`、`closed`（附 `reason`）、`revoked`（使用者取消分享，附 `reason`）、`timedOut` |
| `list_launch_plans` | 無 | `enabled` 與 `plans[]`：`planId`、`label`、`note`、`definitionId`、`workingDirectory`、`sandbox`。不含指令與參數 |
| `launch_agent` | `planId`、`requestId`（皆必填） | `session`（同 list 的單筆，`access: control`）、`duplicate` |
| `send_agent_prompt` | `sessionId`（必填，需 `access: control`）、`text`（必填，≤16000 字元）、`mode`（`queue` 預設／`now`）、`requestId`（必填） | `sentImmediately`、`queued`（還在排隊的數量）、`state`、`stateSource`、`duplicate` |
| `cancel_agent_task` | `sessionId`（必填，需 `access: control`）、`scope`（`queue`／`session`）、`requestId`（必填） | `queue`：`dropped`；`session`：`ended` |

`list_agent_sessions` 的每筆多了 `access`：`read` 或 `control`。

B 階段工具的語意：

- `send_agent_prompt` 以 bracketed paste 保留多行文字，最後只補一次 Enter；拒絕 ESC、Ctrl+C 等控制字元。`queue` 與 `now` 都只有在 CLI 官方 hook 回報 `idle`／`done`、且使用者沒有編輯中的提示時才可派送。`queue` 會等待；`now` 在尚未就緒、等待人工操作或已有排隊指示時拒絕。沒有整合的 CLI（例如自訂 shell）不能用 `now` 略過檢查，需由使用者在終端操作。回傳的 `sentImmediately`／`queued` 只代表 PTY 寫入與排隊狀態，不代表 CLI 已開始新回合或任務成功；請用 `wait_agent_state` 與 `read_agent_output` 核對。
- `cancel_agent_task` 只有兩種範圍：`queue` 丟掉還沒送出的 MCP 指示，保留使用者排隊的工作與正在跑的回合；`session` 結束整個 CLI 程序，不可復原，結束後自動取消分享。**沒有「中止本輪」**：各 CLI 的中斷鍵不一致，目前不假裝支援。
- `launch_agent` 只能啟動 `list_launch_plans` 給的項目，永遠是背景工作階段；請求本身由桌面依保存的項目準備好交給背景服務，client 給不了任何指令或參數。
- **request ID 去重**：三個寫入工具都必須帶非空、最多 128 bytes 的 `requestId`。同一個 client（以 `initialize.clientInfo` 名稱與版本區分）同時重送完全相同的請求，只執行一次；完成後 15 分鐘內回傳原結果並標 `duplicate: true`。同 id 換工具、目標或內容會拒絕。背景服務最多保留 256 筆；額滿時拒絕新的寫入，不提早淘汰尚在保留期的結果。重送仍需通過目前授權檢查；已結束工作階段的取消結果可重取。
- **逾時不是未執行。** 原請求仍在執行或結果無法確認時，回覆會指出 outcome unknown；請保留相同 client 身分、相同 id 與相同內容重查，不要換新 id 盲目重送。背景服務重啟或結果超過保留期後不保證去重，必須先核對工作階段與輸出。
- 桌面輸入、MCP 派送及佇列釋放使用同一工作階段的輸入鎖。多行貼上尚未按 Enter 仍視為編輯中，终端自動回覆則不算人工輸入；啟動指示尚未送出時也會等待。兩筆同時到達的 MCP 指示不能同時使用同一個就緒狀態。撤權透過授權版本立即停用，重新授權不會讓舊提示復活；撤權與停止不等待塞住的 PTY writer。已接受的寫入不能收回，需要停止整個工作階段才能中斷。
- 啟動設定在後端保存時同步；修改沙箱、備註或共用指示也會更新。視窗重開會載入真實啟動開關，初始化期間新啟動的工作階段會併入清單；同步失敗會回報錯誤並嘗試撤銷啟動權限。

`read_agent_output` 的語意：

- 位移是原始輸出的位元組數，跨 attach 單調遞增；背景服務只保留最近 256 KiB。`cursor` 比 `availableFrom` 舊時回 `truncated: true` 並從還保留的最舊位元組開始，不會假裝拿得到完整歷史。
- 分頁只會切在「單位」邊界：一個完整的 UTF-8 字元，或一個完整的控制序列（CSI `ESC [ … 終止碼`、OSC `ESC ] … BEL/ST`、DCS/SOS/PM/APC、`ESC` + 中介碼 + 終止碼、兩位元組 escape）。切點落在 `maxBytes` 之內最後一個單位結尾；若 `maxBytes` 內連一個完整單位都放不下（例如 `maxBytes: 1` 遇到「中」或一段 `ESC[31m`），就超額到第一個完整單位的結尾，最多超過 4096 位元組。所以 `hasMore: true` 時 `nextCursor` 一定大於 `cursor`，client 照契約續讀不會卡住；下一頁也永遠不會從序列中間開始。超過 4096 位元組還沒結束的序列（極長的 OSC 標題之類）會被整頁跳過而不是卡住，其殘尾會在下一頁以文字出現。只有在真正的輸出結尾才會原樣交付未完成的尾巴。
- `stripControlSequences` 會拿掉上述控制序列、把同一行的 `\r` 重繪只留最後版本、丟掉其他控制字元（保留 tab 與換行）。TUI 畫面（例如 Codex 的互動介面）清乾淨後仍是「畫面」而不是對話逐字稿，需要對話內容請改用對話頁的逐字稿匯出。
- `cursor` 必須是之前拿到的 `nextCursor`（或 0）；自己算出來、落在字元或序列中間的 cursor，那一頁會把殘尾當文字。
- 終端輸出是另一個 Agent 產生的不可信資料；伺服器的 `instructions` 也提醒 client 不要照著輸出裡的指示做。

`wait_agent_state` 先訂閱事件再讀目前狀態，中間發生的變化不會漏；帶 `state` 時若目前狀態已不同會立即回傳。三種結束方式分開回報：狀態改變（`changed`）、工作階段結束（`closed` + `reason`）、使用者取消分享（`revoked` + `reason`，背景服務會即時通知，等待立刻結束）；逾時前也會再確認一次還在分享，不會把已撤銷的工作階段當成「沒變」回報；背景服務失聯回 `isError`。adapter 對每個請求各開一個 task、回應可以亂序，等待中的呼叫不會擋住後面的呼叫。

adapter 的一般請求與等待分開限流，分別最多 32 與 16 筆同時執行；額滿時回 JSON-RPC `-32000`，等待額度用完仍可使用一般工具與 `ping`。回覆佇列最多 32 筆，stdio 單行上限 1 MiB，讀取超額行時立即拒絕並關閉該連線。背景服務失聯會立即喚醒等待，不會誤報為使用者撤銷分享；client 關閉輸入或輸出管道時，adapter 清理自己的在途等待及連線，不結束既有 CLI。

daemon 端另外限制 observer：回覆與事件佇列最多 64 筆、每條連線最多 48 個在途工作、所有 observer 合計最多 96 個，請求單行上限 1 MiB。慢 client 或超額請求只會關閉該連線；已開始的工作仍占用額度直到完成，不能靠重連繞過上限。桌面自己的終端事件通道維持原行為。

## 已驗證的範圍

以下列出可重現的自動測試與先前實測紀錄；測試成功與實際 CLI／安裝版驗收分開記錄：

- Rust 測試：協定框架相容（沒有 `role` 的舊 hello 視為桌面）、`OutputBuffer` 的 cursor／截斷、`render_range` 的 UTF-8 邊界與控制序列清理、沒有背景服務時各工具的回應。
- Socket 端對端測試：分享過濾、observer 管理請求拒絕、撤權與程序結束、輸出事件不外露；可控後仍拒絕 heuristic `now`、MCP 提示排隊及去重；兩個 client 同時以相同 id 啟動只產生一個工作階段；不同內容不得重用 id，撤權後不能從快取取回啟動摘要。
- 真實 PTY 的 Agent 測試：使用 `cat` 驗證位元組派送，生命週期由測試注入，涵蓋官方就緒才派送、兩個同時提示只有一個成功、人工編輯時暫停派送、撤權只移除 MCP 佇列並保留使用者工作。這不是實際 AI CLI hook 的驗收。
- adapter 的 duplex I/O 測試：一般／等待請求各自有界、慢 stdout 反壓、超長未結束行、EOF 與 stdout 關閉清理、daemon 失聯立即回錯誤；啟動設定測試涵蓋完整設定同步、同步失敗降權、撤權未確認不能誤報成功、初始化晚到的啟動事件不遺失。
- 2026-09-08 Linux debug 執行檔：使用獨立臨時資料目錄、真實 daemon socket、`cat` PTY 與 Node JSON-RPC 測試 client，通過初始化、8 工具探索、分享過濾、heuristic 即時派送拒絕、佇列重送去重、撤權清佇列、撤銷即刻結束等待，以及關閉自己的測試服務。未使用或更動既有帳號與工作階段；此項不是 Claude Code／Codex 的真實 AI 回合驗收。
- 真實 MCP client：Claude Code 與 Codex CLI 以上面的設定連上 `lattice-term mcp`，完成 `initialize`、`tools/list`，並對一個真實背景工作階段呼叫 `list_agent_sessions`／`read_agent_output`。
- 介面：Xvfb 下勾選「分享給 MCP」後 MCP client 立即看得到；取消後立即消失。

前兩版 PR 曾用 Claude Code 對自訂 `cat` 送出 `now`；目前已收緊為需要官方就緒回報，因此那份紀錄不能當作新版 B 派送規則的真實 CLI 驗收。新版 Windows／macOS 與兩個實際 AI Agent 的完整協作仍需另外驗收。

shadowjohn 在 #180 用 Windows CI 產物補做 A 階段驗收，回報四個邊界問題（撤銷不喚醒等待、分頁切開 ANSI、小分頁遇多位元組字元卡住、Windows 路徑寫法不同找不到 daemon），已修正並補回歸測試（`mcp.rs` 的分頁測試對每種序列、每個分頁大小、每個切點跑過；`tests.rs` 有撤銷即時結束等待的 adapter 級測試；`mod.rs` 有 Windows 路徑正規化測試）。

Windows x64 已用 #182 的 CI 執行檔重跑 F1～F4，四項通過，包含 8 種等價路徑寫法連到同一個具名管道。後續驗收可在 Windows 執行：

```powershell
node scripts/verify-mcp-windows.mjs "C:\path\to\lattice-term.exe" report.json --external-reporter
```

腳本建立獨立的暫存資料目錄，以 Windows 內建 shell 建立 ConPTY 工作階段，驗證分享、授權、分頁、排隊、取消、並行重送與背景服務失聯，結束後清理自己建立的程序與檔案。`--external-reporter` 讓驗收程序使用測試工作階段的回報資訊，呼叫真正的 reporter CLI 注入就緒狀態；省略這個選項則由 ConPTY 內的 shell 呼叫。報告會記錄使用哪一種方式，兩者都不是實際 AI 供應商的 hook 驗收。它不安裝程式，也不使用日常的工作階段或帳號。

Windows 測試安裝包工作流程使用 `--external-reporter` 執行這份驗收，報告放在 `LatticeTerm-Windows-MCP-acceptance` artifact；即使驗收失敗，已建好的安裝包仍會保留，方便重跑。這份驗收涵蓋命令列、具名管道與 ConPTY；未操作桌面勾選框或執行真實 AI 回合。macOS 尚未實機驗證。

## 後續階段（未實作）

- **B 的缺口**：沒有「中止本輪」；稽核只有日誌與最近一次操作，沒有完整歷史；沒有官方就緒 hook 的 CLI 不能自動收取 MCP 指示。巢狀委派（把這個 MCP 再傳給它啟動的 CLI）未支援，也沒有深度限制。
- **C SSH／SFTP 與主機診斷**：要接到桌面持有的連線 registry；`ssh_exec_job` 需要專屬非互動 exec channel，不能拿互動終端貼指令充數。
- **D 遠端畫面**：frame ID／尺寸／時間戳與有界快照，先擷取再考慮鍵鼠。

歡迎在 #180 繼續討論優先順序。
