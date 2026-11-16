# 原生對話與雙向續聊

工作階段與對話頁共用同一份本機歷史清單。開啟清單或預覽只讀取紀錄，
不會自動啟動 CLI；使用者明確選擇續接後，才進入既有的啟動流程。

## 本機訊息雙向同步

側欄的原生歷史會依對話紀錄的工作資料夾自動分類，可收合各專案，
不需先手動建立資料夾。分類只整理已讀取的清單，不會啟動 CLI、
複製原生對話，或改動使用者自行建立的工作區資料夾。
歷史仍分頁讀取；較舊的項目需透過「載入更早的對話」繼續載入，
分類不代表已列出所有歷史，也不等同原生桌面自行指定的專案分組設定。

雙向續聊使用同一份原生紀錄與 session ID，不另外複製對話檔，也不把
登入資料搬到另一個帳號。LatticeTerm 發送訊息時由原生 CLI 保存；
原生工具續聊後，LatticeTerm 讀回新增的使用者訊息與助理文字。
Codex、Claude Code 與 Gemini CLI 另讀回工具呼叫與輸出，依呼叫 ID 合為歷史卡片，不重新執行工具、
要求批准或讀取工具參數裡的檔案。沒有保存像素的 `view_image` 紀錄不顯示
路徑與佔位卡片；圖片仍須經既有安全預覽流程才能顯示。

在「助理 → 新增另一個帳號」選擇「共用原生工具紀錄（雙向）」：

1. 預設使用 CLI 的現有紀錄目錄，連結後選回預設來源，不建立重複帳號。
2. 若原生工具使用不同目錄，可選擇它的設定根目錄，不能選 sessions 或
   projects 子目錄。此來源只保存目錄參照，移除來源不會刪除原始目錄。
3. 確認原生工具與 LatticeTerm 使用同一目錄、專案和 session ID，才是
   同一段對話。同 email 的獨立帳號仍可能保存不同紀錄。
4. 等目前回合完成再換邊續聊。若使用「加開助理」的終端工作階段，
   還需正常退出原生 CLI（例如 Codex 的 /exit），才能釋放它持有的鎖。
   閒置不等於退出，LatticeTerm 不會擅自結束這些工作階段。
   內建對話的 Codex 在回合完成、審批及插話收據都處理完畢後關閉
   app-server 的 stdin，釋放寫入鎖；下一回合重新 resume，不沿用可能
   過期的記憶體內容。這會增加下一回合的啟動時間。

已有的隔離帳號保持原狀，不自動搬移、合併或改寫歷史。新增共用來源
不會開啟登入視窗；需先在原生 CLI 完成登入或建立設定目錄。

目前選中的本機對話會持續讀回紀錄，包括 LatticeTerm 自己建立或已續聊
的對話。合併前以使用者訊息及助理回覆對齊，只附加可確定的新訊息，
保留本機工具、推理、審批與附件；執行中、排隊、跨帳號、舊快照或無法
唯一對齊的紀錄不會覆蓋本機內容。背景對話在重新選取後才讀回。

這裡的雙向範圍是本機訊息與同一 session 的交替續聊，不包含一般雲端
聊天、雙向改名、封存、刪除或兩邊同時操作。Codex Desktop 的清單仍由
它自己篩選來源：官方 app-server 的 thread/list 預設只列 cli 與 vscode，
appServer 來源須由讀取端明確納入。共用目錄不代表每個 Desktop 版本都會
自動列出自訂 app-server 的新 thread，不能透過偽裝來源或改寫原生索引
繞過這項限制。從「加開助理」啟動的原生互動 CLI 與內建 app-server
對話須分別驗收。

目前讀取 Codex、Claude Code、Gemini CLI 與 Google Antigravity CLI 的
本機紀錄；Cursor 另提供唯讀歷史預覽，不支援從該預覽直接續聊。
Qwen Code、Copilot CLI、xAI Grok Build、Kimi CLI 與 OpenCode 已加入唯讀
清單、預覽與交接；尚未驗證 resume，因此不自動續聊。Hermes 等其他來源
仍未解析；
雲端上的 ChatGPT、Claude 網頁對話也不在本機紀錄內。

歷史同步不是原生介面重播：三種主要來源共用正規化紀錄模型，
文字、工具、公開推理、圖片及紀錄中的檔案變更見下方矩陣；
過去審批只作紀錄，不匯入可操作的核准。同步不會把
歷史審批轉成待批准請求，也不會沿用原生工具的未確認權限。

對話頁直接把尚未開啟過的本機對話列在對話清單下方，跟著專案篩選，
不再另外放「外部對話」按鈕或「原生對話」區塊。點選後才讀取文字快照，
變成一般對話；已開啟過的對話依 CLI、帳號與原生 ID 去重，不會重複出現。
在對話頁刪除這類對話時，LatticeTerm 會記住它（最多 5,000 筆），
之後同步不再列出，但不會刪除 CLI 的原始紀錄。工作階段頁不為原生對話
另建專案，避免側欄被歷史紀錄塞滿。

## 大型紀錄與記憶交接

Codex 與 Claude 的對話身分以紀錄開頭的有限資料核對，不因整份檔案
超過 128 MiB 就判定紀錄不存在。預設近期快照對超過 128 MiB 的 JSONL 讀取末尾 16 MiB，
保留其中可解析的近期訊息，並顯示更早內容已略過；不整份載入記憶體。

讀取仍限制單行大小、跳過不完整行，且維持原帳號與確切對話 ID 核對。
找不到指定 ID 時不改讀同專案的其他紀錄，也不修改原始對話檔。
此近期快照同時用於記憶交接與工作階段預覽；完整閱讀入口另見下節，
不會把完整歷史塞進交接檔。

## 正規化紀錄與完整閱讀（任務 32）

`NormalizedTurn` 包含 `NormalizedItem`，種類為使用者、助理、推理、
工具、檔案變更、圖片、系統／壓縮與子代理。工具用 call ID 配對，
保留失敗狀態；來源不明或找不到呼叫的結果仍可獨立閱讀。舊快照 API
保留 call/result 投影以相容既有同步，兩頁共用既有工具摘要卡與 diff 樣式。
工具參數只解析 JSON，不執行 JavaScript 或 shell，也不讀取 diff 的目標檔。

| CLI | 文字 | 工具與結果 | 推理摘要 | 圖片 | diff | 完整歷史入口 |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | 支援 | function/custom call，依 ID 配對 | 僅公開 summary，密文不送出 | 保存的 image/data URL 或安全路徑 | apply_patch、turn_diff | JSONL／JSONL.zst 往前分頁 |
| Claude Code | 支援 | tool_use/tool_result 配對，受限讀取 persisted output | thinking 預設收合；redacted/signature-only 顯示不可讀 | user/tool_result 的 base64 或安全路徑 | Edit／Write／MultiEdit 的紀錄前後內容 | JSONL 往前分頁，子代理獨立展開 |
| Gemini CLI | 支援 JSON／JSONL | toolCalls 與 functionCall/Response；保留錯誤 | thoughts／thought parts 預設收合 | inlineData 或安全路徑 | replace／write_file 等紀錄內容 | JSON messages 串流／JSONL 事件重播後分頁；子代理獨立展開 |
| Qwen Code | 支援 | functionCall／functionResponse 配對 | thought parts | 未擴充專屬圖片格式 | replace／write_file 等紀錄內容 | JSONL 向前分頁，唯讀 |
| GitHub Copilot CLI | 支援 | tool.execution_start／complete 配對 | assistant.reasoning／reasoningText | 未擴充專屬圖片格式 | edit 的 old_str／new_str | events.jsonl 向前分頁，唯讀 |
| xAI Grok Build | 支援 | OpenAI 格式 tool_calls／tool 回傳 | reasoning_content | 僅共用模型可辨識的圖片 block | 已知檔案工具參數 | chat_history.jsonl 向前分頁，唯讀 |
| Kimi CLI／Kimi Code | 支援 | ToolCall＋參數片段＋ToolResult；新 context message | think parts | 未擴充專屬圖片格式 | StrReplaceFile／WriteFile 已記錄的參數 | wire.jsonl 向前分頁，唯讀 |
| OpenCode | 支援 | v1／v2 tool part 與 state 配對 | reasoning part | 未讀取 blob 或專屬媒體儲存 | 已知檔案工具參數 | SQLite 串流列／向前分頁，唯讀 |
| Antigravity | 支援 | 尚無 | 尚無 | 尚無 | 尚無 | 共用文字分頁 |
| Cursor | 支援，唯讀 | 尚無 | 尚無 | 尚無 | 尚無 | 共用文字分頁 |

檔案工具 diff 由**紀錄中的**舊／新文字建立，僅代表工具當時提出的變更，
不保證成功套用或等於目前磁碟內容。無法辨識的內容不會被猜成 diff。
簽章與加密推理本體不會傳給前端；只有公開摘要可閱讀。

近期快照保留 300 個來源項目／256 KiB 的上限，再配對工具；相容 API
將配對工具拆回 call/result。大型檔案丟棄的前綴會串流檢查 PEM 邊界，
但不保留前綴內容。對話內的「完整紀錄」是
獨立、凍結的閱讀區，可按「載入更早內容」往前到開頭；它不更動發送、
執行或近期訊息的捲動跟隨狀態。「返回最近紀錄」重新取得磁碟快照。
閱讀區最多保留六頁，繼續往前時卸載較新頁並提示，避免無限累積 DOM。
來源長度或修改時間改變時拒絕舊 cursor，需重新讀取，避免混用不同版本。

讀取以串流重新掃描來源，再取 cursor 之前的有界尾頁，並非把整份 JSONL
留在記憶體；每次往前可能需要再次掃描，因此很長的紀錄會較慢。
單行上限 24 MiB；無效、過大或未寫完的 JSONL 行會略過並提示。
單項超大文字截至約 64 KiB，不能宣稱可無損閱讀這類超限內容。
一般 JSONL 不設總檔案長度上限；zstd 限壓縮 128 MiB、解壓 512 MiB、
解碼視窗 128 MiB，超限或損毀會停止並顯示錯誤，不靜默假裝讀到開頭。
Gemini 舊 JSON 限 128 MiB，以 serde 串流逐訊息解析；JSONL 的 `$set`、
`$patch`、`$rewindTo` 需重播，累計事件上限 64 MiB／50,000 個訊息。
不完整 mutation 或超限會拒絕顯示這次結果，避免讓已回退的內容重新出現。

Claude 子代理只接受同 session 固定的 `<session>/subagents/agent-<id>.jsonl`；
Gemini 只接受 `chats/<完整 parent ID>/<child ID>.jsonl`，且 metadata 必須
標為 subagent、ID 與檔名一致。子代理最多列 128 個，獨立展開而不混進主線。
Codex 的 spawn_agent 結果必須有父對話的 agent_id 參照，再核對原帳號、
工作目錄和原生 ID；不跟隨紀錄內任意檔案路徑。Claude persisted output
僅讀同 session 的 `tool-results/<安全檔名>.txt|json`，上限 16 MiB，
其他指向只保留遮罩後的文字，絕不跟隨。

### 遮罩與圖片安全界線

所有正規化文字、參數、輸出與標籤在 Rust 回傳前套用同一份遮罩規則；
記憶交接與歷史標題也遮罩，前端載入舊原生鏡像與分頁再做一次防護。
涵蓋 OpenAI／Anthropic／Google／GitHub／AWS／Slack 常見金鑰格式、
Authorization／Bearer、PEM 私鑰（含跨紀錄分段）、URL 帳密、password/token
等鍵值與長 base64。替代字串為 `[REDACTED]`，沒有還原按鈕或暗藏原值。
遮罩可能保守誤判長編碼內容，無法保證辨識所有自訂秘密格式。

認證檔如 auth.json、credentials、.env、keychain、OAuth/token cache
在統一開檔入口拒絕，原始紀錄始終唯讀、不搬移、不刪除。
預覽 API 只接收對話身分與項目 ID，重新從該紀錄找到圖片；base64
不進入正規化 JSON，而經既有像素驗證及大小限制存入 App 自有預覽目錄。
路徑圖片只允許既有專案預覽邊界，或該對話 user 引用的受管附件；
認證檔名、非圖片副檔名、其他對話未引用附件與符號連結逃逸均拒絕。
不會讀取工具參數中任意路徑。已刪除圖片仍顯示既有錯誤狀態。

### 格式核對版本與依據

2026-11-16 本機只執行版本查詢：Codex CLI **0.169.0**、Claude Code
**2.1.325**。Gemini CLI 本機未安裝，未宣稱實機紀錄驗收；採官方原始碼
commit `4ed06ed0ddc523a6d356a4ad35ddfea331041888`（套件版本
`0.70.0-nightly.20261110.g1603e9bab`）確認格式。沒有讀取真實帳號紀錄作 fixture。

- [Claude Code 目錄說明](https://code.claude.com/docs/en/claude-directory)：projects JSONL、子代理與大型輸出目錄。
- [Gemini session management](https://geminicli.com/docs/cli/session-management/) 與
  [固定版本紀錄型別](https://github.com/google-gemini/gemini-cli/blob/4ed06ed0ddc523a6d356a4ad35ddfea331041888/packages/core/src/services/chatRecordingTypes.ts)：JSONL mutation、toolCalls、thoughts。
- [Gemini 記錄服務](https://github.com/google-gemini/gemini-cli/blob/4ed06ed0ddc523a6d356a4ad35ddfea331041888/packages/core/src/services/chatRecordingService.ts)
  與 [project registry](https://github.com/google-gemini/gemini-cli/blob/4ed06ed0ddc523a6d356a4ad35ddfea331041888/packages/core/src/config/projectRegistry.ts)：完整 parent ID 子目錄、projects.json 映射。
- [Codex 0.169 協定](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/protocol/src/protocol.rs)：response item、工具與公開 reasoning summary。

## 新增唯讀來源（任務 33）

新增來源使用同一套 `NormalizedTurn`／`NormalizedItem`，沒有第二套前端
訊息格式。對話清單沿用「CLI 類型＋帳號設定 ID／目錄＋原生 session ID」
身分，不以標題合併；同 ID 出現在同一帳號不同位置而無法唯一對應時，
拒絕猜選另一份紀錄。專案依來源的 cwd／workDir 分組，資料夾消失仍可閱讀。

點擊新增來源會開啟有焦點鎖定的唯讀對話框，沒有發送或 resume 控制；
Esc、關閉按鈕或遮罩可關閉並返回觸發點。工具、推理、diff 與「載入更早
內容」共用任務 32 元件及容量上限。預覽內可按「交接到其他助理（新對話）」；使用開啟時的近期純文字
快照建立有界、遮罩後的參考，等使用者輸入需求才送出。原生工作階段
換 CLI 的交接匯出也已接上；不重播工具、不還原審批，不啟動來源 CLI。
新增來源均未以實際 CLI 驗證 resume，因此 `resumable` 固定為 false。

| 來源 | 允許的歷史範圍 | 身分／版本核對 |
| --- | --- | --- |
| Qwen | `$QWEN_RUNTIME_DIR` → `$QWEN_HOME` → `~/.qwen` 下的 `projects/*/chats/*.jsonl`；也檢查舊 `tmp/*/chats` | sessionId、cwd、0.14／0.22／0.27 版本家族及已知 message.parts；不讀 `.runtime.json` |
| Copilot | `$COPILOT_HOME` 或 `~/.copilot` 下 `session-state/<id>/events.jsonl` | session.start 的 sessionId 須等於目錄名、context.cwd、journal schema version 1；不讀 session-store.db |
| xAI Grok Build | `$GROK_HOME` 或 `~/.grok` 下 `sessions/<group>/<id>/chat_history.jsonl`，同層 summary.json 只取 info.cwd | 固定路徑與 OpenAI role/content/tool_calls 結構；不把目錄解碼結果猜成 cwd |
| Kimi | `$KIMI_CODE_HOME`，否則優先 `~/.kimi-code`、不存在再用 `~/.kimi`；固定 `sessions/<bucket>/<id>/agents/main/wire.jsonl` 或 Python 舊版 `<id>/wire.jsonl` | state.json 的 workDir／cwd，或 session_index.jsonl 的 workDir；Python kimi.json 僅讀 work_dirs 索引並核對 bucket 的 MD5；wire 1.1～1.10 已知事件結構 |
| OpenCode | `$OPENCODE_DB`，否則 `$XDG_DATA_HOME/opencode/opencode.db` 或 `~/.local/share/opencode/opencode.db` | v1 的 session/message/part；v2 的 session_v2/session_message/session_part；固定查詢與結構檢查，不執行 migration |

帳號設定明確提供的絕對目錄優先於預設環境位置；不借用另一個帳號或
預設來源補讀。若兩份 Kimi 預設目錄都存在，預設只選新版 `.kimi-code`；
可用明確設定目錄或 KIMI_CODE_HOME 選舊版，避免把兩個帳號暗中合併。
掃描僅進入上述已知歷史子目錄，不遞迴設定根目錄的其他插件／快取。
子代理不列成主對話：Qwen sidechain 與 Copilot agentId 事件略過，Kimi
只讀 main（不跟隨 SubagentEvent），OpenCode 清單排除 parent_id 非空項目。
這批沒有新增子代理的獨立瀏覽入口。

未知版本／結構顯示「此版本格式尚未支援」。Qwen 的 managed journal
包裝及 rewind、新 Kimi 尚未辨識的 context mutation 會拒絕這次快照，
不把已回退內容猜成目前主線。超大或不完整 JSONL 行會提示截斷；
空 session 不列出。SQLite 的單個 JSON 欄位在 SQL 投影前限 24 MiB，
超限跳過並提示；資料庫檔案上限 2 GiB，不載入整個資料庫或 blob 到記憶體。

### SQLite 與產品界線

OpenCode 以 `mode=ro&immutable=1`、`SQLITE_OPEN_READ_ONLY` 開啟，查詢
設為 query_only；不執行 CLI、不載入 migration、不取得寫鎖、不建立
資料庫、journal 或 SHM。讀取前後沿用來源 fingerprint，變更時拒絕舊
游標。若存在非空 `-wal`，拒絕讀取並提示先正常關閉原 CLI，使其完成
checkpoint；不自行 checkpoint、改寫 WAL、取得控制權或假裝最新資料
已在主檔。這表示正在使用 WAL 的 OpenCode 暫不能從此入口預覽。

這裡的 Grok 是 **xAI Grok Build**。專案既有安裝命令指向
`superagent-ai/grok-cli`，官方該專案 1.1.7 用 `~/.grok/grok.db`，
與 xAI 的 chat_history.jsonl 是不同產品。本次沒有更換安裝來源，也
不把 grok.db 猜成 xAI 歷史；該產品的資料庫仍未解析。

### 官方依據與實機界線

2026-11-16 本機未安裝 Qwen、Grok、Kimi、OpenCode；Copilot 的版本
查詢沒有取得可辨識版本輸出。沒有執行登入、生成對話或讀取真實帳號
紀錄，版本相容性以以下官方固定來源及合成 fixtures 驗證：

- Qwen Code **0.27.4**，commit `27681123f719a241fc3c1f36db97a1ab928f8be7`：
  [ChatRecord 與紀錄服務](https://github.com/QwenLM/qwen-code/blob/27681123f719a241fc3c1f36db97a1ab928f8be7/packages/core/src/services/chatRecordingService.ts)、
  [storage](https://github.com/QwenLM/qwen-code/blob/27681123f719a241fc3c1f36db97a1ab928f8be7/packages/core/src/config/storage.ts)；
  另核對官方 [v0.14.3](https://github.com/QwenLM/qwen-code/blob/v0.14.3/packages/core/src/services/chatRecordingService.ts)
  與 [v0.22.3](https://github.com/QwenLM/qwen-code/blob/v0.22.3/packages/core/src/services/chatRecordingService.ts) 的相同核心欄位。
- GitHub [設定目錄文件](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)
  與 [SDK event 型別](https://github.com/github/copilot-sdk/blob/cf045793958ce674259c557f7769788f94ee20c9/nodejs/src/generated/session-events.ts)，
  SDK commit `cf045793958ce674259c557f7769788f94ee20c9`；未宣稱已驗證本機 Copilot CLI 版本。
- xAI Grok Build commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` 的
  [session 文件](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md)。
  產品差異另核對 [superagent-ai 儲存實作](https://github.com/superagent-ai/grok-cli/blob/fb97af83f06dca873281d60168430f06c8de6324/src/storage/transcript.ts)。
- Python Kimi CLI **1.52.0**，commit `9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82`：
  [wire file](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/wire/file.py)、
  [事件型別](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/wire/types.py)。
  新 Kimi Code commit `fec742878d73678082b304c887e4fb1564088c54`：
  [session 目錄核對](https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/apps/vis/server/src/lib/session-store.ts)、
  [持久化轉換](https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/agent-core-v2/src/wire/wireService.ts)。
- OpenCode 官方 [v1.2.0 schema](https://github.com/anomalyco/opencode/blob/v1.2.0/packages/opencode/src/session/session.sql.ts)，
  及 core **2.3.0** commit `07965844a5f507f7b1010dbf9cab68daf2550fb2` 的
  [v2 schema](https://github.com/anomalyco/opencode/blob/07965844a5f507f7b1010dbf9cab68daf2550fb2/packages/core/src/session/sql.ts)
  與 [訊息模型](https://github.com/anomalyco/opencode/blob/07965844a5f507f7b1010dbf9cab68daf2550fb2/packages/schema/src/session-message.ts)。

## 開機還原與訊息就緒

讀得到舊對話不代表還原的 CLI 已經能收新訊息。工作階段的閒置或完成
若仍來自終端輸出的推測，對話頁會顯示「尚未確認就緒」，保留可編輯的
草稿，暫停傳送與模型切換，並提供開啟原終端機的入口。請先確認登入、
資料夾信任與待回答事項；若已在提示列，可先從終端機送出訊息。只有收到
CLI 的正式就緒回報，閒置時才恢復傳送；忙碌時仍可排隊，但不會用猜測
的狀態放行佇列或強行輸入。

已在佇列的訊息會明確顯示數量與「尚未送到助理」，不再把排隊成功當成
送出成功。切換狀態或清除本機提示後，仍以工作階段的佇列數量顯示等待。
這個處理不會重開助理、重新登入、取消既有訊息或自動重送。

## 同步範圍

未送出的文字、附件與技能選取會按內建對話 ID 或工作階段 ID 分開保留。
切換頁面或選擇另一個對話後，返回原對話仍可繼續編輯；貼上圖片尚未完成
就切換時，結果也只會回到原對話，不會附加到新選取的對話。送出後清空的
附件不會因返回畫面重新出現，刪除對話也會清除它的草稿。

這些草稿只保留在目前視窗的記憶體，不寫入瀏覽器儲存區、不放進分享內容，
關閉或重新載入視窗後不保留。切到其他頁面也不會解除未送出草稿的外部
傳送限制，避免其他工具在使用者還有草稿時接管對話。

內建對話與終端工作階段共用標題、使用者氣泡與工具卡片；標題優先
使用對話名稱，再以 CLI、帳號和模型作次要資訊。側欄第二行顯示相對
活動時間與精簡模型／CLI，完整供應商資訊保留於提示中。外觀共用
不改變傳送方式：內建對話仍由對話 API 執行，工作階段仍送到原 PTY。

| 項目 | 行為 |
| --- | --- |
| 身分 | 以 CLI 類型、帳號設定 ID、原生 session ID 識別，不以名稱或專案路徑合併 |
| 清單 | 每次讀取結束後 10 秒更新，可手動重新整理；兩頁共用資料來源 |
| 訊息 | 選取中的預覽與已匯入鏡像，每次讀取結束後 2 秒更新；Codex、Claude Code、Gemini 包含正規化工具與其他豐富紀錄 |
| 已匯入對話 | 保留原 thread ID；更新訊息、來源名稱、封存標記與截斷狀態 |
| 本機續接內容 | 執行中或排隊的 thread 不合併；閒置時對齊原生紀錄，只附加新訊息，不覆蓋本機工具與回覆 |
| 舊紀錄 | 每次多載入 100 筆，最多 50,000 筆；已封存的原生對話不列出，已開啟過的封存對話仍保留在清單 |
| 內部紀錄 | 排除 Codex 子 Agent、非互動 exec 與確認沒有使用者輸入的空紀錄；讀取不完整時保留紀錄 |
| Gemini | 讀取 `~/.gemini/tmp/<專案>/chats`，只列主對話且至少有一則使用者訊息，略過子代理紀錄 |
| Antigravity | 依 `~/.gemini/antigravity-cli` 的 history.jsonl 列出；未列在 history 的 brain 資料夾不顯示 |
| 帳號設定 | Gemini 與 Antigravity 目前只讀預設目錄，不借用其他帳號設定的紀錄 |
| 舊版批次匯入 | 尚未啟動的歷史捷徑不再保留、不自動續接，只出現在該資料夾的專案也會一次性移出側欄；明確勾選留在背景的項目維持原行為 |
| 名稱 | 支援可選的 session_index.jsonl 中 id/thread_name 索引；沒有時標示以首則訊息代替 |
| 截斷 | 文字快照最多最近 300 則或 256 KiB，超限時明確提示 |
| 失敗 | 保留上次內容並顯示錯誤；帳號或選取變更後不接受舊請求的回應 |
| 執行狀態 | 無可靠的 Codex Desktop 狀態來源時，顯示「桌面執行狀態未知」 |

上述間隔不是即時同步保證：磁碟讀取、背景節流與應用程式暫停都可能延遲更新。
清單採擴大前綴載入，避免新紀錄插入後讓 offset 分頁跳過舊紀錄。
封存篩選在分頁前執行，切換時重新載入第一頁，不讓封存項目擠掉正常對話。

舊版批次匯入的捷徑可能對應子工作或已失效的原生 ID，不能僅憑保存紀錄就啟動。
請從對話清單開啟目前的原始紀錄，再明確選擇續接；原資料夾已不存在時僅供閱讀。
LatticeTerm 不再保留這些捷徑，但不刪除或封存原始對話；它們仍列在各助理自己的對話清單裡。

## 實作位置

- `useNativeConversations.ts`：共用清單、串行輪詢、過期回應保護。
- `NativeConversationRows.tsx`：在對話清單直接列出未開啟的本機對話與載入更早的按鈕。
- `nativeConversationDismissals.ts`：記住在對話頁刪除的原生對話，同步時略過。
- `nativeHistoryMirror.ts`：更新已匯入文字與 Codex 工具卡片，保護本機續接內容。
- `transcript.rs`：原生來源的有界掃描、帳號區分、封存、名稱索引與訊息快照。
- `transcript/normalized.rs`：來源轉接器、正規化回合／項目、分頁、壓縮與子代理。
- `transcript/redact.rs` 與 `security/transcriptRedaction.json`：共用不可逆遮罩規則。
- `NativeRecordView.tsx`：兩種對話共用的推理、diff、圖片與完整閱讀入口。
- Tauri 命令 `agent_chat_local_history_page` 與
  `agent_chat_local_history_snapshot` 提供唯讀資料；舊命令仍保留相容性。

Windows MSVC 構建會透過 linker 嵌入 Common Controls v6 manifest，
讓應用程式與原生測試都能載入 TaskDialogIndirect，避免測試啟動前出現
STATUS_ENTRYPOINT_NOT_FOUND；不更改系統 DLL、登錄或全域 PATH。

## 已知限制

- 歷史掃描是唯讀；明確發送時由原生 CLI 寫入同一段對話。尚未加入
  雙向改名、封存或刪除，也不能宣稱所有 Desktop 帳號或雲端對話一致。
- 支援矩陣描述可辨識的已保存內容；沒有公開推理、圖片像素或舊版欄位時
  不推測補回。唯讀工具卡片、提議 diff 不能重播操作，歷史審批不會變成核准。
- Gemini 與 Antigravity 續接時會啟動對應 CLI，再以工作階段顯示在對話頁；
  不會直接轉成 LatticeTerm 內建聊天 thread。
- 只有目前選取且閒置的本機 thread 持續更新；背景 thread 不會批次改寫。
- 未載入分頁中的來源名稱與封存狀態，必須載入後才可更新。
- 原生名稱索引格式已用測試資料驗證，尚待比對使用者目前 Desktop 格式。
- 紀錄讀取不會寫入或刪除原始對話。LatticeTerm 自身仍可能保存更新後的鏡像。

## 驗證與桌面驗收

回歸測試涵蓋不自動啟動 CLI、持續刷新、名稱與封存更新、帳號切換、
過期回應、讀取失敗保留內容、較舊紀錄分頁及訊息截斷。
前端執行 TypeScript、Vitest 與正式構建；Rust 執行格式、編譯及受影響
模組原生測試。具體結果以對應提交的 CI 與交付紀錄為準。

原始碼、測試與 CI 通過不代表使用者已安裝版本通過。桌面驗收需：

1. 核對安裝包來源、版本與主程式／sidecar 雜湊，正常退出後備份原程式和資料。
2. 在獲准的測試帳號建立同專案、不同原生 ID 的對話，比對兩頁清單與帳號。
3. 僅開啟清單及預覽，確認沒有新增 CLI 工作；新增來源紀錄後等待輪詢。
4. 選取已匯入鏡像並新增來源訊息，確認內容更新、thread ID 不變、無重複工作階段。
5. 比對改名、封存、還原、重啟、來源不可讀與較舊分頁的結果。
6. 對照 Codex Desktop 實際清單與訊息，將未觀察到的行為列為待驗證。
7. 分別從 LatticeTerm 和原生工具建立對話，交替續聊至少兩次，比對
   session ID、目錄與訊息順序；檢查回合結束可換邊、工具紀錄不消失、
   沒有重複訊息，以及獨立帳號和另一個共用目錄不會混入內容。

回滾前應另存更新後資料，不能刪除 Codex、CLIProxyAPI 原始對話或新產生內容。
