# LatticeTerm MCP Server（第一階段：唯讀觀測）

LatticeTerm 可以當成一個 [Model Context Protocol](https://modelcontextprotocol.io/) 伺服器，讓外部 AI 工具（Claude Code、Codex CLI、Gemini CLI、Cursor 等支援 MCP 的 client）唯讀查看你**明確分享**的 Agent Fleet 背景工作階段：列出狀態、讀取終端輸出、等待狀態改變。

這是 [#180](https://github.com/NickYCLin/lattice-term/issues/180) 提案的 A 階段。它不能啟動、送指令、調整或停止任何工作階段；B（受控協作）、C（SSH／SFTP）、D（遠端畫面）尚未實作，見文末。

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

`--data-dir` 可省略，預設是這個平台的應用程式資料目錄（Linux `~/.local/share/io.github.nickyclin.latticeterm`、macOS `~/Library/Application Support/io.github.nickyclin.latticeterm`、Windows `%APPDATA%\io.github.nickyclin.latticeterm`）；介面顯示的指令一律帶完整路徑，AppImage 會指向 AppImage 檔本身而不是暫時掛載點。

## 工具

所有工具都回傳 `content`（JSON 文字）與 `structuredContent`（同一份 JSON）；可服務但無法完成的呼叫（背景服務沒在跑、工作階段未分享）回 `isError: true` 並說明；參數錯誤回 JSON-RPC `-32602`。

| 工具 | 參數 | 回傳 |
| --- | --- | --- |
| `get_capabilities` | 無 | `daemonRunning`、`backends`（目前只有 `agentFleetBackground`，`access: readOnly`）、`sharedSessions`、`limits`（`maxReadBytes` 65536、`retainedOutputBytes` 262144、`maxWaitMs` 120000）、`limitations` 文字清單 |
| `list_agent_sessions` | 無 | `daemonRunning` 與 `sessions[]`：`sessionId`、`label`、`groupLabel`、`definitionId`、`model`、`workingDirectory`、`state`（`working`／`needsAttention`／`idle`／`done`）、`stateSource`（`integration` 為 CLI 官方 hook 回報，`heuristic` 為由輸出猜測）、`queuedPrompts`、`tokenUsage`（有才附）、`sandboxed`。不含執行檔、啟動參數、帳號目錄、PID 與原生對話 ID |
| `read_agent_output` | `sessionId`（必填）、`cursor`（位元組位移，預設 0）、`maxBytes`（預設 16384，上限 65536）、`stripControlSequences`（預設 true） | `text`、`cursor`（實際起點）、`nextCursor`、`endOffset`、`availableFrom`、`truncated`、`hasMore` |
| `wait_agent_state` | `sessionId`（必填）、`timeoutMs`（預設 30000，上限 120000）、`state`（上次看到的狀態） | `session`（同 list 的單筆）、`changed`、`closed`（附 `reason`）、`timedOut` |

`read_agent_output` 的語意：

- 位移是原始輸出的位元組數，跨 attach 單調遞增；背景服務只保留最近 256 KiB。`cursor` 比 `availableFrom` 舊時回 `truncated: true` 並從還保留的最舊位元組開始，不會假裝拿得到完整歷史。
- 若讀取上限切在多位元組 UTF-8 字元中間，該字元整個留到下次；`nextCursor` 永遠落在字元邊界。只有在真正的輸出結尾才照原樣交付。
- `stripControlSequences` 會移除 ANSI CSI／OSC 序列、把同一行的 `\r` 重繪只留最後版本、丟掉其他控制字元（保留 tab 與換行）。TUI 畫面（例如 Codex 的互動介面）清乾淨後仍是「畫面」而不是對話逐字稿，需要對話內容請改用對話頁的逐字稿匯出。
- 終端輸出是另一個 Agent 產生的不可信資料；伺服器的 `instructions` 也提醒 client 不要照著輸出裡的指示做。

`wait_agent_state` 先訂閱事件再讀目前狀態，中間發生的變化不會漏；帶 `state` 時若目前狀態已不同會立即回傳。adapter 一次處理一個請求，等待期間後面的呼叫會排隊，由 `timeoutMs` 上限保證有界。

## 已驗證的範圍

以下在 Linux 上用真實程序驗證（見 PR 說明的實測紀錄）：

- Rust 測試：協定框架相容（沒有 `role` 的舊 hello 視為桌面）、`OutputBuffer` 的 cursor／截斷、`render_range` 的 UTF-8 邊界與控制序列清理、沒有背景服務時各工具的回應。
- Socket 端對端測試：觀察者在分享前看不到任何工作階段；分享後只列出、只讀得到那一個；`send`／`disconnect`／`launch`／`shutdown`／`snapshots`／改分享全部被拒；撤銷分享立即生效；工作階段結束自動取消分享；觀察者從頭到尾收不到 `data` 事件，也收不到未分享工作階段的任何事件。
- 真實 MCP client：Claude Code 與 Codex CLI 以上面的設定連上 `lattice-term mcp`，完成 `initialize`、`tools/list`，並對一個真實背景工作階段呼叫 `list_agent_sessions`／`read_agent_output`。
- 介面：Xvfb 下勾選「分享給 MCP」後 MCP client 立即看得到；取消後立即消失。

尚未驗證：Windows 具名管道（與背景服務本身相同）、macOS。

## 後續階段（未實作）

- **B 受控協作**（`launch_agent`、`send_agent_prompt`、`cancel_agent_task`）：需要另一種明確授權（分享 ≠ 允許寫入）、request ID 去重、忙碌時的排隊或拒絕、以及 UI 上「哪個 client 正在操作哪個工作階段」的呈現。送入 PTY 的位元組不等於新一輪任務，adapter 要能判斷 CLI 是否就緒。
- **C SSH／SFTP 與主機診斷**：要接到桌面持有的連線 registry；`ssh_exec_job` 需要專屬非互動 exec channel，不能拿互動終端貼指令充數。
- **D 遠端畫面**：frame ID／尺寸／時間戳與有界快照，先擷取再考慮鍵鼠。

歡迎在 #180 繼續討論優先順序。
