# 任務 33：新增五種 CLI 的唯讀對話紀錄

基底為任務 32 的 `ddf14f8a`，使用獨立分支實作。沒有發版、安裝 App、
登入 CLI、啟動 resume、讀取真實帳號紀錄或修改 CLI 原始資料。

## 改動與依據

- `transcript/additional.rs` 為 Qwen、Copilot、xAI Grok Build、Kimi、
  OpenCode 提供固定路徑探索、格式檢查、工具／結果轉接與有界串流。
  轉接後交給任務 32 的同一個 Parser、遮罩及正規化模型，不自創卡片格式。
- `transcript.rs` 接上預設／帳號來源、清單、專案、確切 ID 查找與交接。
  新來源均 `resumable=false`；目錄／來源類型／ID 不明確時不借用其他紀錄。
- OpenCode 支援 v1／v2 表結構；immutable 唯讀連線不執行 migration，
  有非空 WAL 時拒絕並提示先正常關閉 CLI，不能默默忽略未 checkpoint 的資料。
- `NativeConversationRows` 與 `NativeRecordView` 提供完整寬度唯讀對話框、
  共用工具／diff／推理與較早分頁；不提供 composer，不呼叫原生匯入／resume。
  可明確交接到其他助理的新對話，只保存開啟時的近期純文字參考，不自動送出。
  既有 PTY 在取得原生 ID 後也能讀取這些來源；既有附件能力保持原範圍。
- 格式、版本、資料目錄、官方固定 commit 與來源差異記於
  [原生紀錄說明](../NATIVE_CONVERSATION_SYNC.zh-TW.md)。

只掃描指定來源的歷史子目錄；不讀 `.runtime.json`、Copilot session-store.db、
auth.json、credentials、.env、keychain 或 token cache，不跟隨巢狀 symlink。
紀錄進入畫面或交接前均通過共用不可逆遮罩；SQLite 參數綁定 ID，拒絕不安全
ID 與不存在／多重符合的對話。

## 最終驗證

| 檢查 | 結果 |
| --- | --- |
| `npx tsc --noEmit` | 通過，0 錯誤 |
| 全部 Vitest | 2,711 通過／0 失敗／3 略過；350 個測試檔通過、1 個略過 |
| `npm run build` | 通過；入口 454.12 KiB，限制 500 KiB |
| `npm run build:sidecars` | 通過，已在 Rust 全套測試前執行 |
| `cargo test` | 1,233 通過／0 失敗／65 ignored（含整合測試） |
| `cargo check` | 通過 |
| `cargo clippy --all-targets -- -D warnings` | 通過，0 警告 |
| `cargo fmt --all -- --check` | 通過 |
| `node scripts/connection-card-layout.mjs` | 144 通過／0 失敗 |
| `node scripts/session-folder-layout.mjs` | 144 通過／0 失敗 |

Chromium 量測使用既有 `CHROMIUM_NO_SANDBOX=1` 測試模式及臨時設定檔，
沒有讀取個人瀏覽器資料。Rust ignored 項目需要平台、容器或外部服務，
沒有計入通過數。構建仍有原先 ConnectFlow 同時靜態／動態匯入的提示，
不是新增錯誤。

## 新測試涵蓋

Rust 新增 11 個測試函式；共同測試會逐一跑四種 JSONL 來源，SQLite
另外覆蓋 v1 與 v2，全部資料為合成 fixture：

- 使用者／助理文字、工具呼叫與結果配對、公開推理、紀錄中的 diff、假金鑰遮罩。
- Kimi 無 ID 的續接參數片段依目前 call 合併；新 context message 格式；
  structured tool error 保留遮罩後的細節。
- 截斷／超大 JSONL 行、未知版本與未知 mutation、空 session、子代理事件隔離。
- 四種 JSONL 各 650 則訊息向前到開頭，沒有重複 ID 或漏讀。
- 帳號根目錄、確切 session ID、不同 cwd、不同帳號與巢狀 symlink 隔離。
- 五種來源均可產生有界遮罩交接，原始資料 bytes 不變。
- SQLite v1／v2 開啟前後 mtime／SHA-256 不變，唯讀連線不能寫入；
  同時另一條連線可取得測試資料庫的寫入保留鎖，證明讀取端沒有佔用寫鎖。
- SQLite 非空 WAL／未知表結構明確拒絕；空 session／child session 不列出，
  650 則歷史可完整分頁，超大 JSON 欄位在 SQL 投影時排除並提示。
- 前端逐一驗證五種來源只開唯讀預覽、不啟動 CLI；未知版本文案；
  PTY 畫面認得新增讀取來源，沒有誤示「尚未支援紀錄」。
- 五種來源均可建立其他助理的新參考對話，來源名稱正確，不自動送出；
  參考內容再次遮罩、限 12,000 個 Unicode 字元（至多 48,000 bytes），
  重開載入仍保留來源與遮罩內容，不沿用原始 session ID。

## 實機待驗與限制

沒有更新安裝版。本機 Qwen、Grok、Kimi、OpenCode 未安裝，Copilot
版本查詢未取得可辨識版本；本次不是實際帳號／CLI 端到端驗收。
需以說明文件所列版本，分別確認工作階段原生 ID、唯讀對話框、較早分頁、
工具／diff／推理及換 CLI 交接的畫面、關閉後焦點與閱讀位置。

Grok 的 JSONL 是 xAI Grok Build；現有安裝來源 superagent-ai/grok-cli
是另一個產品，其 grok.db 尚未解析，本次未更換安裝命令。
Qwen managed／rewind、新 Kimi 未辨識的 context mutation 不猜讀；
OpenCode 有未 checkpoint WAL 時暫不可讀；新增來源均未開放 resume。
這些限制已在介面與說明文件交代，不能由合成測試冒充實機通過。
