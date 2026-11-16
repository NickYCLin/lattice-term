# 任務 35：記憶／交接自動壓縮與歷史背景

從任務 34 已合併的 `b82c6e6b`、乾淨主線 pull 後開獨立分支。
沒有發版、打 tag、安裝 App、簽章上傳、修改 CLIProxyAPI 或正式資料庫。
功能驗收未以個人原生對話／記憶或認證檔作為資料；CLI 僅執行 help/version 核對旗標。
所有 AI 測試使用合成資料與替身 shell CLI，沒有呼叫真實服務。

## 功能與檔案

| 範圍 | 檔案與行為 |
| --- | --- |
| 設定與版本 | `project_memory/compaction.rs`：共用 App 設定、預設 12 KiB／20 份／90 天、登入檢查、快照、修訂保護、保留數、跨位置版本與還原 |
| 自動精簡 | `project_memory/mod.rs`、`render.rs`：新增／匯入／啟動前觸發；相近文字去重、過時／低優先條目封存、同主題清單、釘選不自動封存、feedback 優先 |
| 輸出界線 | 按實際 UTF-8／CRLF 計量，取設定、16 KiB、AGENTS.md 剩餘空間最小值，保守限制 200 行；外部規則不改寫，釘選仍超限則保留與提示 |
| 安全保存 | `project_memory/storage.rs`：快照上限 4 MiB，其餘 store 仍 1 MiB；沿用 no-follow、衝突比對、同目錄暫存／備份與回復 |
| AI 摘要 | `compaction.rs`：選用已登入 Claude Code 帳號、工具／MCP／一般 hooks／auto memory 關閉、無原生 session persistence；尊重管理政策；格式、機密、長度、數字與路徑檢查，失敗退回且不重試 |
| 交接與背景 | `project_memory/context.rs`：固定欄位、工具摘要／狀態、最後數輪、來源分組與原始路徑；遮罩後完整輸入先落盤，再選用 AI，最後套用總門檻 |
| 原生來源 | `transcript.rs`：以 CLI＋帳號＋native ID 讀取 1–5 段，沿用正規化讀取與安全邊界；原生路徑只引用、不改寫；PTY 交接同樣改為結構化 |
| App 對話 | `agentChat.ts`、`useAgentChat.ts`：實際發送交接時使用 thread 保留的完整可讀來源，避免只用先前的 48 KiB 尾端；大型工具原文只進封存，不直接塞入新提示 |
| 後端入口 | `lib.rs`：設定、記憶版本、結構化交接、選取背景、紀錄與原文讀取；壓縮事件通知 |
| 管理與差異 | `MemoryArchiveHistory`、`ProjectMemoryPanel`、`MemorySaveButton`、`CompactionNotice`：版本差異、還原前先備份、封存標記、AI 退回與同步失敗的不同提示 |
| 設定介面 | `MemoryCompactionSettings`、`ChatInputSettings`：門檻、N、過時天數、選用 AI／帳號與交接原文紀錄 |
| 背景介面 | `BackgroundHistoryPicker`、`ChatView`：選 1–5 段、先預覽、開新對話、保留當前服務／帳號／資料夾，不送出、不借用來源 native ID |
| 其他 | `projectMemory.ts`、`memoryCompaction.ts`、繁中／英文文案與主題 token 樣式；[使用說明](../MEMORY.zh-TW.md)更新 |

原文版本是 scope 完整 store，不把 project 內容提升成 user 記憶。
封存條目仍保留全文，不刪除釘選；只有使用者明確操作才編輯／刪除條目。
還原版本本身先保存目前版本；下一次新增／匯入／啟動才再次精簡，另有立即精簡按鈕。
若快照後操作中斷，紀錄標示未完成，before 仍可還原。

## 檢查結果（Linux）

| 檢查 | 結果 |
| --- | --- |
| `npx tsc --noEmit` | 通過 |
| 全部 Vitest（含 CSS） | 2726 通過／0 失敗／3 跳過；354 檔通過／1 檔跳過 |
| `npm run build` | 通過；入口 457.36 KiB，低於 500 KiB 門檻 |
| `npm run build:sidecars` | 通過 |
| `cargo test` | 1273 通過／0 失敗；既有 65 忽略（lib 47，其餘 target 共 18） |
| `cargo check` | 通過 |
| `cargo clippy --all-targets -- -D warnings` | 通過 |
| `cargo fmt --all -- --check` | 通過 |
| `node scripts/connection-card-layout.mjs` | 144 通過／0 失敗 |
| `node scripts/session-folder-layout.mjs` | 144 通過／0 失敗 |
| 文件相對連結與 `git diff --check` | 通過 |

兩個版面腳本使用 `CHROME=/usr/bin/google-chrome`、`CHROMIUM_NO_SANDBOX=1` 與
臨時設定檔，不讀個人瀏覽器資料；兩者退出碼為 0。建置仍有既有 ConnectFlow
同時靜態／動態匯入提示，沒有新增建置錯誤。忽略的容器／平台測試不算通過。

## 新增測試

Rust 新增 21 項（記憶壓縮 16、結構化背景 4、原生多來源整合 1），涵蓋：

- 門檻／200 行／CRLF／既有 AGENTS.md 剩餘空間；封存前快照已落盤。
- 同主題清單、句末標點近似重複；數字、路徑大小寫、命令旗標、否定不合併。
- 釘選不封存、feedback 優先、過時條目、完整正本仍在、還原後再次精簡。
- N 份保留、切 App 位置後讀回舊版本、還原前快照、user/project 差異隔離。
- 匯入觸發但原生 memories bytes 不變；archive symlink 不可導向外部寫入。
- 假 CLI 的登入狀態、成功／失敗 JSON、機密、遺漏路徑／數字、逾時與不重試。
- 交接 AI 之前原文已存在，安全旗標與提示詞有送出；失敗保留確定性結果。
- 固定欄位、長工具輸出只留狀態、原文遮罩不可復原、多位元 byte 上限。
- 1–5 來源的目標與近期文字各自保留，不被最後一段蓋掉；小門檻仍有各來源標記。
- Claude＋Codex 的確切帳號／ID、選取數量、來源檔未改動與機密遮罩。

前端新增 9 項（互動 6、來源／API 2、非同步回合 1），涵蓋：

- 最多五段、預覽後才建立、取消不建立、不呼叫 send/resume；清單刷新少了選取來源時拒絕，不默默少附。
- 交接摘要尚未完成時回合已結束，不會在摘要完成後送出失效回合。
- 門檻與帳號設定的 revision 參數、版本差異與單一 scope/id 還原。
- 遮罩原文比較與壓縮通知；完整 App 來源不受舊尾端限制，工具另行分類。

## 依據與實機待驗

Claude Code 2.1.325 的本機 help/version 與
[官方非互動文件](https://code.claude.com/docs/en/headless)、
[auto memory 文件](https://code.claude.com/docs/en/memory)已核對。
本次未用真實帳號進行 auth status 或 AI 摘要，不以旗標／測試替身通過代替服務驗收。
目前 AI 選項只支援 Claude Code；其他 CLI 的記憶／歷史仍可走確定性精簡。

安裝版仍需確認：

1. 奶油繪本／Mist、窄寬視窗下的設定、歷史選取、展開差異、焦點與通知位置。
2. 真實 Claude 預設／多帳號登入與摘要、訂閱／管理政策差異、服務逾時提示。
3. 換 CLI、重啟 App、背景服務啟動及新增／匯入後的同步；既有執行中 CLI 的 reload。
4. 真實大型歷史使用既有近期快照上限，原文以安全路徑參照，不宣稱讀完整份原生歷史。
   背景輸入超過 2000 項／3 MiB 安全邊界會拒絕，原生紀錄維持唯讀。

沒有讀取 auth.json、credentials、.env、keychain 或 token 快取作為測試／背景來源。
