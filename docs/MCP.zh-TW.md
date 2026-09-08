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
- **讀跟寫是兩個授權。** 分享只給看；要讓 MCP client 對某個工作階段送指示、清佇列或結束它，得再勾「允許 MCP 送指示與停止」。取消這個勾選不影響分享。
- **啟動是第三個授權。** MCP 區塊裡的「允許 MCP 啟動已保存的背景啟動項目」打開後，client 才能用 `launch_agent` 啟動「跨重啟還原」清單裡勾了「留在背景」的項目，內容完全照你保存的（CLI、參數、工作目錄、沙箱、共用啟動指示），不能自訂指令；它啟動的工作階段自動分享並可控。這個開關存在啟動項目檔裡，開著時背景服務會保持常駐。
- **你看得到誰做了什麼。** 每個分享的工作階段旁會顯示最近一次 MCP 操作：client 名稱（來自 MCP `initialize` 的 `clientInfo`）、動作與時間；背景服務日誌也記一行（只有中繼資料，不記提示內容）。
- **adapter 不會啟動背景服務。** 背景服務沒在跑時，`list_agent_sessions` 回 `daemonRunning: false` 與空清單，讀取與等待回 `isError` 說明原因；不會為了讓模型有東西看而拉起程序。
- **權限由背景服務端強制。** adapter 以 `observer` 角色打招呼，背景服務對這個角色只接受列出已分享工作階段與讀取輸出兩種請求，其他一律拒絕；就算 adapter 被改寫也拿不到更多。`readOnlyHint` 等 MCP annotation 只是描述。
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
| `get_capabilities` | 無 | `daemonRunning`、`backends`（目前只有 `agentFleetBackground`，`access: readOnly`）、`sharedSessions`、`limits`（`maxReadBytes` 65536、`retainedOutputBytes` 262144、`maxWaitMs` 120000）、`limitations` 文字清單 |
| `list_agent_sessions` | 無 | `daemonRunning` 與 `sessions[]`：`sessionId`、`label`、`groupLabel`、`definitionId`、`model`、`workingDirectory`、`state`（`working`／`needsAttention`／`idle`／`done`）、`stateSource`（`integration` 為 CLI 官方 hook 回報，`heuristic` 為由輸出猜測）、`queuedPrompts`、`tokenUsage`（有才附）、`sandboxed`。不含執行檔、啟動參數、帳號目錄、PID 與原生對話 ID |
| `read_agent_output` | `sessionId`（必填）、`cursor`（位元組位移，預設 0）、`maxBytes`（分頁大小，預設 16384，上限 65536，可超額至多 4096） 、`stripControlSequences`（預設 true） | `text`、`cursor`（實際起點）、`nextCursor`、`endOffset`、`availableFrom`、`truncated`、`hasMore` |
| `wait_agent_state` | `sessionId`（必填）、`timeoutMs`（預設 30000，上限 120000）、`state`（上次看到的狀態） | `session`（同 list 的單筆）、`changed`、`closed`（附 `reason`）、`revoked`（使用者取消分享，附 `reason`）、`timedOut` |
| `list_launch_plans` | 無 | `enabled` 與 `plans[]`：`planId`、`label`、`note`、`definitionId`、`workingDirectory`、`sandbox`。不含指令與參數 |
| `launch_agent` | `planId`（必填）、`requestId` | `session`（同 list 的單筆，`access: control`）、`duplicate` |
| `send_agent_prompt` | `sessionId`（必填，需 `access: control`）、`text`（必填，≤16000 字元）、`mode`（`queue` 預設／`now`）、`requestId` | `sentImmediately`、`queued`（還在排隊的數量）、`state`、`stateSource`、`duplicate` |
| `cancel_agent_task` | `sessionId`（必填，需 `access: control`）、`scope`（`queue`／`session`）、`requestId` | `queue`：`dropped`；`session`：`ended` |

`list_agent_sessions` 的每筆多了 `access`：`read` 或 `control`。

B 階段工具的語意：

- `send_agent_prompt` 就是在那個 PTY 裡打字再按 Enter，跟介面的批次提示一樣（換行變成 `\r`，最後補 Enter）。`queue` 模式走介面的提示佇列：只有 CLI 官方 hook 回報 `idle`／`done` 才放行一則，heuristic 猜的不算，所以沒有整合的 CLI（例如自訂 shell）會一直排著；這種情況用 `now`。`now` 模式在狀態是 `working` 或 `needsAttention` 時拒絕，不會把文字打進正在跑的回合。回傳的 `sentImmediately`／`queued` 說的是位元組有沒有送進 PTY，不代表 CLI 已開始新回合或任務成功；請用 `wait_agent_state` 與 `read_agent_output` 核對。
- `cancel_agent_task` 只有兩種範圍：`queue` 丟掉還沒送出的提示，正在跑的回合不動；`session` 結束整個 CLI 程序，不可復原，結束後自動取消分享。**沒有「中止本輪」**：各 CLI 的中斷鍵不一致（Esc、Ctrl+C 各有不同副作用，Ctrl+C 兩次會直接退出），目前不假裝支援。
- `launch_agent` 只能啟動 `list_launch_plans` 給的項目，永遠是背景工作階段；請求本身由桌面依保存的項目準備好交給背景服務，client 給不了任何指令或參數。
- **request ID 去重**：`launch_agent`、`send_agent_prompt`、`cancel_agent_task` 都接受 `requestId`。同一個 client（以 `clientInfo` 名稱區分）在 15 分鐘內用同一個 `requestId` 重送，會拿到第一次的結果並標 `duplicate: true`，不會再啟動或再送一次；回覆逾時時請帶同一個 id 重試，而不是換新 id。跨背景服務重啟不保證。
- 桌面視窗與 MCP 對同一個 PTY 的輸入沒有互斥：兩邊同時打字會混在一起，跟兩個人共用一個終端一樣。

`read_agent_output` 的語意：

- 位移是原始輸出的位元組數，跨 attach 單調遞增；背景服務只保留最近 256 KiB。`cursor` 比 `availableFrom` 舊時回 `truncated: true` 並從還保留的最舊位元組開始，不會假裝拿得到完整歷史。
- 分頁只會切在「單位」邊界：一個完整的 UTF-8 字元，或一個完整的控制序列（CSI `ESC [ … 終止碼`、OSC `ESC ] … BEL/ST`、DCS/SOS/PM/APC、`ESC` + 中介碼 + 終止碼、兩位元組 escape）。切點落在 `maxBytes` 之內最後一個單位結尾；若 `maxBytes` 內連一個完整單位都放不下（例如 `maxBytes: 1` 遇到「中」或一段 `ESC[31m`），就超額到第一個完整單位的結尾，最多超過 4096 位元組。所以 `hasMore: true` 時 `nextCursor` 一定大於 `cursor`，client 照契約續讀不會卡住；下一頁也永遠不會從序列中間開始。超過 4096 位元組還沒結束的序列（極長的 OSC 標題之類）會被整頁跳過而不是卡住，其殘尾會在下一頁以文字出現。只有在真正的輸出結尾才會原樣交付未完成的尾巴。
- `stripControlSequences` 會拿掉上述控制序列、把同一行的 `\r` 重繪只留最後版本、丟掉其他控制字元（保留 tab 與換行）。TUI 畫面（例如 Codex 的互動介面）清乾淨後仍是「畫面」而不是對話逐字稿，需要對話內容請改用對話頁的逐字稿匯出。
- `cursor` 必須是之前拿到的 `nextCursor`（或 0）；自己算出來、落在字元或序列中間的 cursor，那一頁會把殘尾當文字。
- 終端輸出是另一個 Agent 產生的不可信資料；伺服器的 `instructions` 也提醒 client 不要照著輸出裡的指示做。

`wait_agent_state` 先訂閱事件再讀目前狀態，中間發生的變化不會漏；帶 `state` 時若目前狀態已不同會立即回傳。三種結束方式分開回報：狀態改變（`changed`）、工作階段結束（`closed` + `reason`）、使用者取消分享（`revoked` + `reason`，背景服務會即時通知，等待立刻結束）；逾時前也會再確認一次還在分享，不會把已撤銷的工作階段當成「沒變」回報；背景服務失聯回 `isError`。adapter 對每個請求各開一個 task、回應可以亂序，等待中的呼叫不會擋住後面的呼叫。

## 已驗證的範圍

以下在 Linux 上用真實程序驗證（見 PR 說明的實測紀錄）：

- Rust 測試：協定框架相容（沒有 `role` 的舊 hello 視為桌面）、`OutputBuffer` 的 cursor／截斷、`render_range` 的 UTF-8 邊界與控制序列清理、沒有背景服務時各工具的回應。
- Socket 端對端測試：觀察者在分享前看不到任何工作階段；分享後只列出、只讀得到那一個；`send`／`disconnect`／`launch`／`shutdown`／`snapshots`／改分享全部被拒；撤銷分享立即生效；工作階段結束自動取消分享；觀察者從頭到尾收不到 `data` 事件，也收不到未分享工作階段的任何事件。B 階段：只分享沒可控時 prompt／cancel／launch 都被拒；給可控後 `now` 真的打進 PTY（`cat` 回顯）、同 `requestId` 重送回 `duplicate` 且不重送；heuristic 狀態下 `queue` 會排著、`scope: queue` 清得掉；沒開啟動開關時 `Plans` 是空的，開了只列允許的項目且不含指令，`launch_agent` 啟動的工作階段桌面收到 `launched` 事件並看到它自動分享可控，同 `requestId` 重送不再啟動；`scope: session` 結束後自動取消分享；收回可控後 prompt 被拒但仍看得到。
- 真實 MCP client：Claude Code 與 Codex CLI 以上面的設定連上 `lattice-term mcp`，完成 `initialize`、`tools/list`，並對一個真實背景工作階段呼叫 `list_agent_sessions`／`read_agent_output`。
- 介面：Xvfb 下勾選「分享給 MCP」後 MCP client 立即看得到；取消後立即消失。

shadowjohn 在 #180 用 Windows CI 產物補做 A 階段驗收，回報四個邊界問題（撤銷不喚醒等待、分頁切開 ANSI、小分頁遇多位元組字元卡住、Windows 路徑寫法不同找不到 daemon），已修正並補回歸測試（`mcp.rs` 的分頁測試對每種序列、每個分頁大小、每個切點跑過；`tests.rs` 有撤銷即時結束等待的 adapter 級測試；`mod.rs` 有 Windows 路徑正規化測試）。

尚未在本機驗證：Windows 具名管道實機（由 CI 產物與外部回報覆蓋）、macOS。

## 後續階段（未實作）

- **B 的缺口**：沒有「中止本輪」；沒有 MCP 與桌面輸入的互斥；稽核只有日誌與最近一次操作，沒有完整歷史；巢狀委派（把這個 MCP 再傳給它啟動的 CLI）沒有做也沒有深度限制。
- **C SSH／SFTP 與主機診斷**：要接到桌面持有的連線 registry；`ssh_exec_job` 需要專屬非互動 exec channel，不能拿互動終端貼指令充數。
- **D 遠端畫面**：frame ID／尺寸／時間戳與有界快照，先擷取再考慮鍵鼠。

歡迎在 #180 繼續討論優先順序。
