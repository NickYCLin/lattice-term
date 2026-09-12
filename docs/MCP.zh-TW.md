# LatticeTerm MCP Server（Agent 協作與受控遠端操作）

LatticeTerm 可以當成一個 [Model Context Protocol](https://modelcontextprotocol.io/) 伺服器，讓外部 AI 工具（Claude Code、Codex CLI、Gemini CLI、Cursor 等支援 MCP 的 client）查看你**明確分享**的 Agent Fleet 背景工作階段：列出工作階段資訊、狀態與等待狀態改變。終端輸出與內容片段需另外允許讀取；送指示、清佇列與結束工作階段需另外允許控制；啟動保存過的背景項目則由獨立開關授權。

這是 [#180](https://github.com/NickYCLin/lattice-term/issues/180) 提案的 A、B 與 C 階段實作。C 需保持桌面開啟，使用既有 SSH／SFTP 連線並另外授權；D 已提供另外授權的 RDP／VNC／Lattice Remote 單張畫面擷取；鍵鼠與跨主機 Fleet 尚未實作。實作、測試與實機驗收分開記錄，見文末。

## 運作方式

```text
支援 MCP 的 AI client（Claude Code、Codex、Gemini CLI…）
        │ stdio（JSON-RPC 2.0，一行一則）
        ▼
lattice-term mcp --data-dir <資料目錄>          ← 同一個 LatticeTerm 執行檔的子命令
        │ observer 角色連上使用者專屬本機 socket
        ▼
lattice-term agent-daemon（背景服務）
        ├─ AgentRegistry                     ← 只提供已分享、另行允許的操作
        └─ connection-owned reverse RPC      ← 已授權的目標、逾時不自動重送
                ▼
           桌面 SSH／SFTP registry            ← 原有登入與主機信任不交給模型
```

- **只有背景 Agent 工作階段可分享。** 啟動 CLI 時勾「留在背景」的工作階段由背景服務持有；桌面自己的 Agent 工作階段、對話頁及遠端畫面沒有對外路徑。SSH／SFTP 走下方獨立的桌面授權流程。
- **預設不分享，可隨時撤銷。** 每個背景工作階段旁的「分享給 MCP」第一次勾選只開放 metadata：工作階段資訊、狀態與狀態等待，不開放終端輸出或內容片段。分享狀態存在背景服務記憶體，工作階段或背景服務結束就自動取消。
- **內容讀取與控制分開授權。** 「允許 MCP 讀取內容」開放終端輸出；「允許 MCP 送指示與停止」開放指示、清除 MCP 佇列與結束工作階段。取消內容讀取不取消狀態分享，也不改控制權；取消控制不改內容讀取權。取消控制或全部分享時，尚未送出的 MCP 指示一併移除，使用者自己排隊的工作保留。內容與 metadata 都可能含敏感資訊，請選擇合適的分享對象。
- **啟動也有獨立授權。** 「允許 MCP 啟動已保存的背景啟動項目」打開後，client 才能用 `launch_agent` 啟動保存清單裡勾了「留在背景」的項目，完全沿用保存的 CLI、參數、工作目錄、沙箱與共用指示。它啟動的工作階段會自動分享、開放內容讀取並可控；介面會明示這三個效果。開關存在啟動項目檔裡，開著時背景服務保持常駐。
- **你看得到誰做了什麼。** MCP 區塊列最近 256 筆 Agent 寫入、遠端操作與遠端授權變更，包含已接受、重送、失敗或結果未確認。撤權或工作階段結束不移除紀錄；安全寫入此裝置後可跨背景服務重啟還原。介面區分已儲存、尚在儲存、只在記憶體與無法儲存。client 名稱由對方自報，不是已驗證身分，請勿包含敏感資訊。
- **adapter 不會啟動背景服務。** 背景服務沒在跑時，`list_agent_sessions` 回 `daemonRunning: false` 與空清單，讀取與等待回 `isError` 說明原因；不會為了讓模型有東西看而拉起程序。
- **權限由背景服務端強制。** adapter 以 `observer` 角色打招呼，背景服務只接受已分享工作階段的觀測、另外授權的操作，以及允許的啟動項目查詢；其他管理請求一律拒絕。`readOnlyHint` 等 MCP annotation 只是描述。
- **權杖留在 adapter 程序。** 連線用的 `agent-daemon.token`（0600）由 adapter 讀取，不會出現在任何工具結果裡。
- **觀察者收不到終端位元組事件。** 背景服務只把已分享工作階段的 `state`／`closed`／`model`／`usage`／`queue` 事件推給觀察者，輸出一律用 cursor 主動讀，慢的 client 不會累積終端資料。
- **觀察者不算「有視窗連著」。** 對話排程的無視窗執行與閒置自動結束都不受 MCP 連線影響。

## 設定 client

### 升級時保留背景工作

MCP 觀察者使用獨立的背景服務協定 2；桌面仍用協定 1，以便連回升級前
已存在的工作階段。舊服務不認得 `observer` 角色，因此 adapter 必須先用
不同協定讓它拒絕握手，不能先取得所有工作階段再由 adapter 過濾。
桌面也會檢查握手中的 MCP 能力，不會把舊服務不認得的管理請求送出去。

若看到「背景服務版本較舊」，既有 CLI 仍可操作，但 MCP 分享、控制與啟動
開關暫停使用。請先完成背景工作，再停止並重啟背景服務；更新不會自動
終止工作階段。這是安全相容性限制，重開桌面視窗不等於重啟背景服務。

另一個獨立能力 `mcpOutputScopes` 表示可分開授權內容讀取。沒有這個能力
時，介面禁用新分享與內容權限切換，絕不把舊服務標成 metadata-only。
既有分享維持原先可讀內容的權限，仍可取消；等背景工作完成後再手動
停止並重啟服務。新版第一次分享會以單一請求送出
`shared: true, readOutput: false`，不先短暫開放內容再降權。

Windows 會優先使用正規化後的管道名稱；只有新管道不存在時，才嘗試同一
資料目錄原始寫法的舊管道。這可保留桌面更新前的背景連線，不會在權限被拒
或管道忙碌時改連其他服務。舊管道仍需原來的目錄寫法與相同權杖；等價路徑
統一識別適用於新版服務，不代表能猜出舊服務任意大小寫的啟動路徑。

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
| `get_capabilities` | 無 | `daemonRunning`、`backends`（背景 Fleet 與桌面 SSH/SFTP 的支援、可用狀態）、`mcpOutputScopes`、`sharedSessions`、`outputReadableSessions`、`controlledSessions`、`launchEnabled`、`launchablePlans`、`limits`、`limitations` 文字清單 |
| `list_agent_sessions` | 無 | `daemonRunning` 與 `sessions[]`：`sessionId`、`label`、`groupLabel`、`definitionId`、`model`、`workingDirectory`、`state`（`working`／`needsAttention`／`idle`／`done`）、`stateSource`（`integration` 為 CLI 官方 hook 回報，`heuristic` 為由輸出猜測）、`queuedPrompts`、`tokenUsage`（有才附）、`sandboxed`。不含執行檔、啟動參數、帳號目錄、PID 與原生對話 ID |
| `read_agent_output` | `sessionId`（必填，需 `readOutput: true`）、`cursor`（位元組位移，預設 0）、`maxBytes`（分頁大小，預設 16384，上限 65536，可超額至多 4096） 、`stripControlSequences`（預設 true） | `text`、`cursor`（實際起點）、`nextCursor`、`endOffset`、`availableFrom`、`truncated`、`hasMore` |
| `wait_agent_state` | `sessionId`（必填）、`timeoutMs`（預設 30000，上限 120000）、`state`（上次看到的狀態） | `session`（同 list 的單筆）、`changed`、`closed`（附 `reason`）、`revoked`（使用者取消分享，附 `reason`）、`timedOut` |
| `list_launch_plans` | 無 | `enabled` 與 `plans[]`：`planId`、`label`、`note`、`definitionId`、`workingDirectory`、`sandbox`。不含指令與參數 |
| `launch_agent` | `planId`、`requestId`（皆必填） | `session`（同 list 的單筆，`access: control`）、`duplicate` |
| `send_agent_prompt` | `sessionId`（必填，需 `access: control`）、`text`（必填，≤16000 字元）、`mode`（`queue` 預設／`now`）、`requestId`（必填） | `sentImmediately`、`queued`（還在排隊的數量）、`state`、`stateSource`、`duplicate` |
| `capture_remote_screen` | `targetId`（必填，需 `screen` 授權） | MCP `image` 內容（JPEG）加上 `frameId`、`capturedAt`、`width`、`height`、`mimeType` |
| `cancel_agent_task` | `sessionId`（必填，需 `access: control`）、`scope`（`turn`／`queue`／`session`）、`requestId`（必填） | `turn`：`interrupted`（Codex／Claude）；`queue`：`dropped`；`session`：`ended` |

`list_agent_sessions` 的每筆含 `access`（`metadata`／`read`／`control`）與
獨立的 `readOutput` 布林值；`access: control` 不代表可讀內容。
`wait_agent_state` 在 metadata-only 下仍可等待狀態；內容降權會更新其權限
資訊，不把仍然有效的狀態分享誤報為全部撤銷。舊分享缺少 `readOutput`
時保持原本可讀內容的語意，不悄悄改掉使用者現有權限。

撤銷內容權限會拒絕仍在處理或排隊中的舊讀取，重新開放也不會讓舊回覆
恢復有效。若慢 client 的回覆已經送出部分 JSON frame，系統會關閉該
MCP／observer 連線，不繼續補完舊內容；client 可重新連線，既有 CLI、
狀態分享與控制權不會因此終止。已經傳出的位元組無法收回。

B 階段工具的語意：

- `send_agent_prompt` 以 bracketed paste 傳送文字，最後只補一次 Enter；拒絕 ESC、Ctrl+C 等控制字元。Windows Codex 的 MCP 提示另限單行、不可含 CR、LF、Tab、`@` 或 `$`，也不可用 `/` 或 `!` 起頭；`now` 與 `queue` 都在寫入或入隊前拒絕，不會默默改字。前幾種字元可能被轉成按鍵，後幾種會啟動 CLI 指令或補完選單，不能當一般文字送入。其他平台、CLI 與桌面手動輸入維持原行為。`queue` 與 `now` 都只有在 CLI 官方 hook 回報 `idle`／`done`、且使用者沒有編輯中的提示時才可派送。`queue` 會等待；`now` 在尚未就緒、等待人工操作或已有排隊指示時拒絕。沒有整合的 CLI（例如自訂 shell）不能用 `now` 略過檢查，需由使用者在終端操作。回傳的 `sentImmediately`／`queued` 只代表 PTY 寫入與排隊狀態，不代表 CLI 已開始新回合或任務成功；請用 `wait_agent_state` 與 `read_agent_output` 核對。
- Windows Codex 的自動輸入只對通過啟動設定檢查的工作階段開放。貼上後先送 End，讓已驗證的預設按鍵處理清掉貼上判定，再送唯一一次 Enter；不依賴固定等待。每個階段仍重查原授權、程序及人工接管狀態。若途中撤權、停止整個工作階段或寫入失敗，可能留下未提交的草稿，結果會標成不確定，不補送 Enter 或自動重試。此時拒絕當時等待輸入鎖的人工請求，終端顯示接管提示；請先檢查可見草稿，再決定如何繼續。仍須核對官方狀態與實際結果。
- `cancel_agent_task` 有三種範圍：
  - `turn` 送出該 CLI 自己介面上寫的中斷鍵，結束正在跑的回合，工作階段、佇列與使用者的工作都留著。只對 `get_capabilities.turnInterrupt.supportedDefinitionIds` 列出的 CLI 開放（目前 Codex 與 Claude Code，兩者的畫面都寫著「esc to interrupt」）；工作階段在等人回應（`needsAttention`）、有人有未送出的輸入、或五秒內已經中斷過一次時拒絕，代碼 `not_ready`。五秒冷卻是因為有些 CLI 把連按兩次 Esc 當成別的意思（Codex 是「編輯上一則訊息」）。回傳只代表按鍵送進去了，不代表 CLI 停了：請用 `wait_agent_state` 與 `read_agent_output` 核對。
  - `queue` 丟掉還沒送出的 MCP 指示，保留使用者排隊的工作與正在跑的回合。
  - `session` 結束整個 CLI 程序，不可復原，結束後自動取消分享。
  沒有列在 `turnInterrupt` 的 CLI 不會用猜的按鍵去試，一律回 `unsupported`；要中斷請使用者自己在終端機操作，或用 `session` 整個結束。
- `launch_agent` 只能啟動 `list_launch_plans` 給的項目，永遠是背景工作階段；請求本身由桌面依保存的項目準備好交給背景服務，client 給不了任何指令或參數。
- **啟動有數量上限。** 同一個 client 最多同時持有 4 個由它啟動且仍存活的工作階段，所有 client 合計最多 8 個；超過就拒絕，回 `limit_reached`，要先停掉一個再啟動。使用者自己開的工作階段、以及手動分享給 MCP 的工作階段都不計入。能讀輸出的 CLI 可能在輸出裡看到「再開一個 agent」這種指示，上限由背景服務把關，不看模型自制。目前用量與上限在 `list_launch_plans` 與 `get_capabilities`（`launchedSessions`、`limits`）。
- **request ID 去重**：三個寫入工具都必須帶非空、最多 128 bytes 的 `requestId`。同一個 client（以 `initialize.clientInfo` 名稱與版本區分）同時重送完全相同的請求，只執行一次；完成後 15 分鐘內回傳原結果並標 `duplicate: true`。同 id 換工具、目標或內容會拒絕。背景服務最多保留 256 筆；額滿時拒絕新的寫入，不提早淘汰尚在保留期的結果。重送仍需通過目前授權檢查；已結束工作階段的取消結果可重取。
- **逾時不是未執行。** 原請求仍在執行或結果無法確認時，回覆會指出 outcome unknown；請保留相同 client 身分、相同 id 與相同內容重查，不要換新 id 盲目重送。背景服務重啟或結果超過保留期後不保證去重，必須先核對工作階段與輸出。
- 桌面輸入、MCP 派送及佇列釋放使用同一工作階段的輸入鎖。多行貼上尚未按 Enter 仍視為編輯中，終端自動回覆則不算人工輸入；啟動指示尚未送出時也會等待。兩筆同時到達的 MCP 指示不能同時使用同一個就緒狀態。撤權透過授權版本立即停用，重新授權不會讓舊提示復活；撤權與停止不等待塞住的 PTY writer。已接受的寫入不能收回，需要停止整個工作階段才能中斷。
- 啟動設定在後端保存時同步；修改沙箱、備註或共用指示也會更新。視窗重開會載入真實啟動開關，初始化期間新啟動的工作階段會併入清單；同步失敗會回報錯誤並嘗試撤銷啟動權限。

### 錯誤代碼

失敗的工具呼叫回 `isError: true`，`structuredContent` 同時帶 `error`（給人看的句子）與 `code`（給程式判斷的代碼）。完整清單在 `get_capabilities.errorCodes`：

| `code` | 意思 | 該怎麼辦 |
| --- | --- | --- |
| `not_authorized` | 使用者沒授權，或已撤銷 | 別重試；請使用者在 LatticeTerm 勾選 |
| `needs_user_action` | 要有人先在 LatticeTerm 動作（例如打開啟動開關、先連上並驗證主機） | 告訴使用者要做什麼，不要自己繞過 |
| `not_ready` | CLI 還沒回報就緒，或使用者正在打字 | 稍後再試，或改用 `queue` |
| `not_found` | 工作階段、啟動項目或目標不存在 | 重新列一次 |
| `limit_reached` | 碰到上限（同時啟動數、遠端同時操作數） | 先停掉一個，不要輪詢重試 |
| `unsupported` | 這個組合在這裡就是不支援（例如 Windows Codex 的輸入設定已失效） | 別自動重試或重啟 |
| `unknown_outcome` | 做了沒做不確定 | 用同一個 `requestId` 重查，先核對實際狀態 |
| `daemon_unavailable` | 背景服務沒在跑或連不上 | 請使用者開啟 LatticeTerm |
| `failed` | 其他 | 看 `error` 說明 |

遠端（SSH／SFTP）的失敗由桌面判定後照原樣帶回，不會被重新歸類；桌面自有而這裡沒有的代碼會對應到上表最接近的一個。

### Windows Codex 的受控輸入限制

提示文字的第一個字元也不可是 ASCII `?`：預設快捷鍵會在空輸入框切換說明並消耗該字元。一般內文或句尾的問號仍可使用，不會被改字；依據見 [Codex 的空輸入框快捷鍵處理](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/bottom_pane/chat_composer.rs#L3849)。

目前只核准 Codex 0.153.4 的原生執行檔、預設快捷鍵與 Vim 關閉的設定組合。LatticeTerm 在新 CLI 啟動前，沿用該次帳號環境與可支援的設定參數，透過官方 `config/read` 唯讀檢查；不建立模型回合、不改快捷鍵、不關閉手動貼上的保護。帳號的 `CODEX_HOME` 可分開使用，但 `-p`／`--profile` 命名設定目前不支援。設定來源限固定本機磁碟，拒絕網路路徑、junction 與需雲端召回的檔案。無法確認的版本、啟動方式、設定來源或自訂按鍵，一律不開放自動送指示，CLI 本身仍正常啟動。這不是對執行檔發行者的簽章驗證。

這個資格只適用於同一個未被人工操作的 CLI 程序。人工輸入或排隊會先使資格失效，再進原有終端通道；不攔住人工操作，也不因重新勾選控制權就恢復自動送出。完整、嚴格白名單的終端查詢回覆不算人工輸入；未知或分段回覆採保守失效。入隊或派送前重驗發現設定來源或執行檔改變時也會失效；這不是檔案即時監看，不在既有 TUI 上猜測重新載入後的按鍵。

失效時仍可依原授權讀取輸出、清除 MCP 佇列或結束工作階段；不自動重啟 CLI、不丟掉對話。若要準備受控 worker，請在核准的啟動參數中提供初始提示，先完成一次官方回合，再交給 MCP；不要先在終端手動送字來取得就緒。初始提示也須符合前述單行與特殊字元限制，否則 CLI 仍啟動，但不取得自動輸入資格。既有 resume、啟動指示與歷史還原沒有被默默改成新對話，但不能把尚未取得官方就緒的畫面當成可派工。

這是可驗證的受限輸入方式，不是任意 TUI 鍵盤自動化。日後 CLI 版本或鍵位協定改變，需要重新驗證，不會為了相容就額外補 Enter、確認登入或核准命令。

`read_agent_output` 的語意：

- 位移是原始輸出的位元組數，跨 attach 單調遞增；背景服務只保留最近 256 KiB。`cursor` 比 `availableFrom` 舊時回 `truncated: true` 並從還保留的最舊位元組開始，不會假裝拿得到完整歷史。
- 分頁只會切在「單位」邊界：一個完整的 UTF-8 字元，或一個完整的控制序列（CSI `ESC [ … 終止碼`、OSC `ESC ] … BEL/ST`、DCS/SOS/PM/APC、`ESC` + 中介碼 + 終止碼、兩位元組 escape）。切點落在 `maxBytes` 之內最後一個單位結尾；若 `maxBytes` 內連一個完整單位都放不下（例如 `maxBytes: 1` 遇到「中」或一段 `ESC[31m`），就超額到第一個完整單位的結尾，最多超過 4096 位元組。所以 `hasMore: true` 時 `nextCursor` 一定大於 `cursor`，client 照契約續讀不會卡住；下一頁也永遠不會從序列中間開始。超過 4096 位元組還沒結束的序列（極長的 OSC 標題之類）會被整頁跳過而不是卡住，其殘尾會在下一頁以文字出現。只有在真正的輸出結尾才會原樣交付未完成的尾巴。
- `stripControlSequences` 會拿掉上述控制序列、把同一行的 `\r` 重繪只留最後版本、丟掉其他控制字元（保留 tab 與換行）。TUI 畫面（例如 Codex 的互動介面）清乾淨後仍是「畫面」而不是對話逐字稿，需要對話內容請改用對話頁的逐字稿匯出。
- `cursor` 必須是之前拿到的 `nextCursor`（或 0）；自己算出來、落在字元或序列中間的 cursor，那一頁會把殘尾當文字。
- 終端輸出是另一個 Agent 產生的不可信資料；伺服器的 `instructions` 也提醒 client 不要照著輸出裡的指示做。

`wait_agent_state` 先訂閱事件再讀目前狀態，中間發生的變化不會漏；帶 `state` 時若目前狀態已不同會立即回傳。三種結束方式分開回報：狀態改變（`changed`）、工作階段結束（`closed` + `reason`）、使用者取消分享（`revoked` + `reason`，背景服務會即時通知，等待立刻結束）；逾時前也會再確認一次還在分享，不會把已撤銷的工作階段當成「沒變」回報；背景服務失聯回 `isError`。adapter 對每個請求各開一個 task、回應可以亂序，等待中的呼叫不會擋住後面的呼叫。

adapter 的一般請求與等待分開限流，分別最多 32 與 16 筆同時執行；額滿時回 JSON-RPC `-32000`，等待額度用完仍可使用一般工具與 `ping`。回覆佇列最多 32 筆，stdio 單行上限 1 MiB，讀取超額行時立即拒絕並關閉該連線。背景服務失聯會立即喚醒等待，不會誤報為使用者撤銷分享；client 關閉輸入或輸出管道時，adapter 清理自己的在途等待及連線，不結束既有 CLI。

daemon 端另外限制 observer：回覆與事件佇列最多 64 筆、每條連線最多 48 個在途工作、所有 observer 合計最多 96 個，請求單行上限 1 MiB。慢 client 或超額請求只會關閉該連線；已開始的工作仍占用額度直到完成，不能靠重連繞過上限。桌面自己的終端事件通道維持原行為。

## 操作紀錄的邊界

桌面只在握手確認 `mcpHistory: true` 後才送查詢。舊版沒有這個能力欄位時不送新指令，避免舊服務因不認得 request 而斷線，影響正在使用的背景工作階段。

紀錄只供桌面使用，observer 不能讀取，也不新增對外 MCP 工具。每 10 秒重新取得一次；舊背景服務或連線失敗會顯示「無法取得」，不假裝成空清單。只記 client 名稱、動作、時間、結果類別與已知工作階段 ID，不保存指示內容、request ID、原始錯誤、啟動參數或憑證。失敗目標若不在 registry 裡，不把呼叫者傳入的任意字串存為工作階段 ID。

同一 request ID 的每次回覆各占一筆；成功的去重回覆標「重送」，不表示執行第二次。已接受只代表伺服器接受操作，不代表模型完成工作或測試通過；失敗也不保證沒有副作用。遠端操作另記已知的 opaque target ID，不記原始主機、指令或路徑。遠端授權／撤權會記錄；exec／傳檔完成結果由 `get_remote_operation` 查詢，不另追加背景完成事件。Agent 輸出讀取以五分鐘窗口折疊記錄次數；未回覆的在途呼叫、adapter 端拒絕的參數與 Agent 授權變更不在這份紀錄內。

讀取終端輸出（`read_agent_output`）也會入紀錄，動作是 `read`，只記「誰在什麼時候讀了哪個工作階段」，不記 cursor 範圍與任何輸出內容；被拒絕的讀取一樣記一筆（`failed`），方便看出有人試過。同一個 client 對同一個工作階段的連續讀取會併成一筆，帶 `repeated` 次數與 `firstAt`，5 分鐘沒再讀就另起一筆——否則輪詢式讀取會把其他紀錄擠掉。`list_agent_sessions` 與 `wait_agent_state` 不入紀錄：它們只回狀態，不含對話內容。

`agent-mcp-audit/history.json` 是最多 256 筆／256 KiB 的版本化快照。格式版本為 2（1 寫的檔可直接載入，缺少的折疊欄位視為單次操作）。背景 worker 最多留一份待寫快照，正常關閉最多等待 250ms；突然斷電或強制終止仍可能遺失尚未寫入的紀錄，並留下暫存檔。這不是 append-only、防竄改或完整稽核帳本，request ID 去重仍不跨重啟。

新目錄與檔案限制為目前使用者存取（Unix 0700／0600、Windows protected DACL）。拒絕偵測到的連結、junction、hardlink、不安全權限或外部修改；格式損壞、未知版本與寫入失敗不自動清空原檔，CLI 仍可使用，介面顯示無法儲存。這些檢查不構成對同一 OS 帳號惡意程序或管理員的隔離。

## C：SSH／SFTP 與主機資訊

每個授權可以核准多段具名指令（最多 8 段），每段各自設定逾時（1–60 秒）。`ssh_exec_job` 只能用 `planId` 指名其中一段，插不進參數；`list_authorized_connections` 只會回名稱與 id，不含指令內容。

`get_host_metrics` 用的是固定的 Linux `/proc` 探針。主機沒有回報 Linux 資料時回 `unsupported`，重試也不會變，請改用其他方式；不會回一堆零假裝讀到了。

1. 先在桌面正常連線，確認主機金鑰與帳號；MCP 不代為確認、不使用其他已存帳號登入。
2. 設定頁「MCP 遠端操作授權」選擇既有連線，填入可分享的名稱，逐項勾選操作。
3. SSH 可開放 Linux 主機資訊與固定指令。指令由使用者事先填妥，AI 只選 `planId`，不能插入參數。SFTP 可開放目錄清單、上傳與下載，兩個方向分別授權。
4. 檔案操作需核准遠端根目錄；傳檔還需核准本機根目錄。AI 只提交 `rootId` 與相對路徑，單檔最多 8 MiB，不覆寫既有檔案。
5. 檢查設定後明確開放，隨時可撤權。桌面關閉、與 daemon 失聯或原連線失效後不得沿用舊授權；重新授權產生新的 target ID。

| 工具 | 用途 |
| --- | --- |
| `list_authorized_connections` | 只列已授權名稱、opaque ID、能力及連線狀態，不含主機、帳號、憑證、指令與實際根目錄 |
| `get_host_metrics` | 既有 SSH 連線上的固定 Linux probe，只回傳數值，不含掛載路徑與裝置名稱 |
| `sftp_list_directory` | 已核准根目錄下的有界清單 |
| `ssh_exec_job` | 獨立、非互動 SSH channel 的命名指令工作 |
| `sftp_transfer` | 核准本機／遠端目錄之間的單檔傳送 |
| `get_remote_operation` | 查詢此 client 的操作結果，無重跑副作用 |
| `cancel_remote_operation` | 要求中止此 client 的操作，不關閉使用者 SSH 工作階段 |

指令／傳檔先回 `operationId` 與 running，client 必須再查結果。指令分別保存 stdout、stderr、exit status／signal、截斷與逾時，輸出合計最多 32 KiB，UI 固定指令上限 30 秒（後端上限 60 秒）。結束通道不代表全部遠端衍生程序已停止，也不會回復先前寫入；不可把 `accepted` 或 EOF 當成 exit 0。相同 client／request ID 的重送不重跑，最多保存 256 筆／15 分鐘；失聯或超時可能結果未確認，不得改用新 ID 盲目重送。

桌面 Rust service 持有 registry 與原始授權，daemon 僅定向轉送到擁有它的桌面連線，兩端檢查權限。握手確認 `desktopBridgeProtocol` 後才送新請求，舊服務不會收到不認得的管理指令。MCP 不能註冊桌面 bridge、核准自己的權限或提交任意 Tauri command。

`get_capabilities.backends` 分別列出 `agentFleetBackground` 與 `desktopSshSftp`。後者的 `supported` 表示服務支援橋接協定，`available` 還需要至少一個已授權且連線中的目標；不能把服務版本支援當成目前已獲得主機權限。

SFTP 逐層檢查相對路徑與連結，但遠端 `realpath`／`open` 不是同一個原子操作。這依賴可信任的伺服器與根目錄管理，不是抵抗其他遠端程序換目錄的強沙箱；需要強隔離時應使用伺服器端 chroot。固定 SSH 指令的權限等同該 SSH 帳號，不受 SFTP 根目錄限制。

[窄視窗元件驗收畫面](assets/mcp-history-narrow.png) 使用合成測試資料，展示長名稱換行、可捲動紀錄、無法取得與空紀錄；不是安裝版或真實帳號驗收。

[遠端授權窄視窗畫面](assets/mcp-remote-sftp-narrow.png) 使用合成連線、真實 React 元件與 mock Tauri 回應；已操作授權與撤權，核對 SSH／SFTP 權限分流及確認勾選。它不代表安裝版已連線到外部主機。

## 已驗證的範圍

以下列出可重現的自動測試與先前實測紀錄；測試成功與實際 CLI／安裝版驗收分開記錄：

- Rust 測試：協定框架相容（沒有 `role` 的舊 hello 視為桌面）、`OutputBuffer` 的 cursor／截斷、`render_range` 的 UTF-8 邊界與控制序列清理、沒有背景服務時各工具的回應。
- Socket 端對端測試：分享過濾、observer 管理請求拒絕、撤權與程序結束、輸出事件不外露；可控後仍拒絕 heuristic `now`、MCP 提示排隊及去重；兩個 client 同時以相同 id 啟動只產生一個工作階段；不同內容不得重用 id，撤權後不能從快取取回啟動摘要。
- 真實 PTY 的 Agent 測試：使用 `cat` 驗證位元組派送，生命週期由測試注入，涵蓋官方就緒才派送、兩個同時提示只有一個成功、人工編輯時暫停派送、撤權只移除 MCP 佇列並保留使用者工作。這不是實際 AI CLI hook 的驗收。
- adapter 的 duplex I/O 測試：一般／等待請求各自有界、慢 stdout 反壓、超長未結束行、EOF 與 stdout 關閉清理、daemon 失聯立即回錯誤；啟動設定測試涵蓋完整設定同步、同步失敗降權、撤權未確認不能誤報成功、初始化晚到的啟動事件不遺失。
- 2026-09-08 Linux debug 執行檔：使用獨立臨時資料目錄、真實 daemon socket、`cat` PTY 與 Node JSON-RPC 測試 client，通過初始化、8 工具探索、分享過濾、heuristic 即時派送拒絕、佇列重送去重、撤權清佇列、撤銷即刻結束等待，以及關閉自己的測試服務。未使用或更動既有帳號與工作階段；此項不是 Claude Code／Codex 的真實 AI 回合驗收。
- 真實 MCP client：Claude Code 與 Codex CLI 以上面的設定連上 `lattice-term mcp`，完成 `initialize`、`tools/list`，並對一個真實背景工作階段呼叫 `list_agent_sessions`／`read_agent_output`。
- 介面：Xvfb 下勾選「分享給 MCP」後 MCP client 立即看得到；取消後立即消失。

前兩版 PR 曾用 Claude Code 對自訂 `cat` 送出 `now`；目前已收緊為需要官方就緒回報，因此那份紀錄不能當作新版 B 派送規則的真實 CLI 驗收。後續 Windows 已用兩個真實 Codex 工作階段通過派工、各自答案及官方完成、重送去重與取消隔離；詳細來源及限制見 [真實 CLI 驗收歷程](MCP-REMOTE-ACCEPTANCE.zh-TW.md#真實-cli-驗收歷程)。macOS 桌面與安裝版仍未驗證。

2026-09-12（Linux debug 執行檔）的實測；畫面擷取來自 `feat/mcp-screen-capture`，單輪中斷與回歸來自 main `9bf9a7e`：
- 遠端畫面擷取（實機）：用專案自己的 `lattice-agent` 在另一個 X display（藍底桌面＋時鐘）開畫面分享，LatticeTerm 直連配對後在設定頁只勾「擷取目前畫面」（其他五項在畫面工作階段一律停用），再用 `lattice-term mcp` 呼叫 `capture_remote_screen`：拿回 1152×720、27 KB 的 JPEG，內容就是那台桌面，metadata 含 frameId 與擷取時間；連續呼叫第一次被兩秒節流擋下（`limit_reached`）；撤回授權後連線立刻從清單消失、擷取拿不到目標；操作紀錄留下 `remoteScreen` 的成功與被拒各一筆與 `grant` 一筆。RDP 與 VNC 走同一條保留路徑，但沒有可連的 RDP／VNC 伺服器可實測。


- 中斷本輪：桌面端送出一個長問題後，Codex 的輸出從 24664 位元組長到 60811，此時以 MCP 下 `scope: "turn"`，之後 12 秒都停在 60811；工作階段仍在清單裡也還能回答下一個問題。Codex 的 `notify` hook 在回合中途就回報 `done`，因此中斷條件不看 `working` 狀態。
- 合併後回歸（真實 Claude Code 當 client）：`get_capabilities` 回 `access: control`、`turnInterrupt` 列出 codex／claude、`errorCodes` 九種；`list_agent_sessions` 的 `access`／`readOutput` 正確；`read_agent_output` 分頁正常；`scope: "turn"` 成功後立刻再下一次回 `not_ready`（五秒冷卻）；操作紀錄有折疊過的 `read`（3 次）與 `interrupt` 的成功與被拒各一筆，`persistence: ready`。
- 啟動上限與錯誤代碼：以真實 socket 與 PTY 的端對端測試涵蓋（開滿被拒、停一個放一個名額、使用者自己的工作階段不計入），未在安裝版驗證。

shadowjohn 在 #180 用 Windows CI 產物補做 A 階段驗收，回報四個邊界問題（撤銷不喚醒等待、分頁切開 ANSI、小分頁遇多位元組字元卡住、Windows 路徑寫法不同找不到 daemon），已修正並補回歸測試（`mcp.rs` 的分頁測試對每種序列、每個分頁大小、每個切點跑過；`tests.rs` 有撤銷即時結束等待的 adapter 級測試；`mod.rs` 有 Windows 路徑正規化測試）。

Windows x64 已用 #182 的 CI 執行檔重跑 F1～F4，四項通過，包含 8 種等價路徑寫法連到同一個具名管道。後續驗收可在 Windows 執行：

```powershell
node scripts/verify-mcp-windows.mjs "C:\path\to\lattice-term.exe" report.json --external-reporter
```

腳本建立獨立的暫存資料目錄，以 Windows 內建 shell 建立 ConPTY 工作階段，驗證分享、授權、分頁、排隊、取消、並行重送與背景服務失聯，結束後清理自己建立的程序與檔案。`--external-reporter` 讓驗收程序使用測試工作階段的回報資訊，呼叫真正的 reporter CLI 注入就緒狀態；省略這個選項則由 ConPTY 內的 shell 呼叫。報告會記錄使用哪一種方式，兩者都不是實際 AI 供應商的 hook 驗收。它不安裝程式，也不使用日常的工作階段或帳號。

Windows 測試安裝包工作流程使用 `--external-reporter` 執行這份驗收，報告放在 `LatticeTerm-Windows-MCP-acceptance` artifact；即使驗收失敗，已建好的安裝包仍會保留，方便重跑。這份驗收涵蓋命令列、具名管道與 ConPTY；未操作桌面勾選框或執行真實 AI 回合。macOS 尚未實機驗證。

2026-09-08 的 Windows CI 與下載產物各通過 9 項檢查，結果、來源 commit、雜湊及驗證範圍見 [Windows MCP 驗收紀錄](MCP-WINDOWS-ACCEPTANCE.zh-TW.md)。

後續候選版的持久紀錄、C 遠端操作、Windows 啟動修正及不使用外部 reporter 的驗收，另見 [MCP 遠端操作與紀錄驗收](MCP-REMOTE-ACCEPTANCE.zh-TW.md)。舊版檢查結果不代替新功能驗收。

## D：遠端畫面（第一步：單張擷取）

`capture_remote_screen` 交出使用者明確分享的那個遠端畫面的最新一張，就是桌面此刻收到的那一幀。

- **只有畫面**。沒有鍵盤、沒有滑鼠、沒有連續串流，也沒有錄影。要看變化只能再要一張。
- **要先有活著的畫面工作階段**：RDP、VNC，或 Lattice Remote 的畫面分享（純終端的 Remote 分享沒有畫面，不會出現在清單裡）。授權在設定頁的「MCP 遠端操作授權」，與 SSH／SFTP 同一區，但畫面工作階段只提供 `screen` 一個權限，不能同時勾指令或檔案。
- **授權綁定這一次連線**。斷線重連會產生新的一輪，舊授權即失效，要重新授權。保留的影格也綁定後端及連線世代，舊連線延遲送來的影格不得進入新連線。
- **沒授權就不留畫面**。桌面平常不保留任何 frame；勾了分享才開始保留「最新的一張」，最後一筆畫面授權撤銷或工作階段結束就立刻丟掉；授權被拒時不開始保留。畫面只在記憶體裡，不落地。
- **每兩秒一張**，超過回 `limit_reached`（`busy`）。還沒有畫面回 `not_ready`；單張超過 1.5 MB（JPEG 原始 bytes 上限；桌面橋接回覆上限為 2 MiB）回 `unsupported`，請降低遠端解析度或色深，不回傳上一張舊圖。
- **看到的就是使用者的桌面**：可能有其他視窗、通知與私人資料，介面在勾選時就明講。畫面內容是不可信資料，不是指示。
- 每次擷取都會記進操作紀錄（動作 `remoteScreen`），紀錄只有誰、何時、哪個目標，不含畫面。

尚未實作：鍵盤與滑鼠輸入、連續串流、跨主機 Fleet 編排。鍵鼠要等「frame 新鮮度」設計定案（以 frame ID 綁定操作、過期即拒）再談，避免依過期畫面點到別的東西。

## 後續階段（未實作）

- **B 的邊界**：只有畫面上自己寫明中斷鍵的 CLI 支援 `scope: "turn"`，其餘不猜按鍵；沒有官方就緒 hook 的 CLI 不能自動收取 MCP 指示。巢狀委派未支援，不自動把 orchestrator MCP 設定傳給啟動的 CLI；啟動數量另有上限（見上），所以就算有人想靠輸出誘導連環開 agent 也開不出來。
- **C 驗收**：實作已接入桌面 registry；隔離 SSH／SFTP、桌面授權及跨平台實際驗收須依本次 PR 結果核對，不能沿用早期 A／B 的綠燈當成 C 通過。
- **D 的下一步**：鍵盤與滑鼠。需要先定義 frame 新鮮度（操作綁 frame ID，過期即拒）、每個動作的授權與稽核，以及使用者隨時可見的接管方式。目前只做到單張擷取。

歡迎在 #180 繼續討論優先順序。
