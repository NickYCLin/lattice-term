# 任務 34：跨工具專案記憶庫

基底為任務 33 的 `f4b1106c`，從乾淨主線 pull 後開獨立分支。
未發版、安裝 App、登入或啟動真實 CLI，沒有讀寫個人 CLI 記憶、
CLIProxyAPI 設定或正式資料庫。測試均使用合成文字與臨時目錄。

## 改動

- `src-tauri/src/project_memory/`：中立 JSON、user/project 範圍、四種類型、
  來源、時間、釘選、編輯與刪除；可切換 App 儲存位置，保留舊資料避免丟失。
- `render.rs`：AGENTS.md 獨立區塊、CLAUDE／GEMINI／QWEN 匯入、
  冪等、保留管理範圍外 bytes、16 KiB／整份 32 KiB 上限與 CLI 檔案狀態。
  超限保留正本，不截斷；Codex override 不可讀或有內容均提示人工檢查。
- `imports.rs`：固定路徑唯讀候選，Claude frontmatter、Codex Markdown memory、
  Gemini Added Memories 與專案指示分段；正規化去重、明確選取、修訂指紋及遮罩。
  原生 auto-memory bytes 不變；專案指示只增加自己的輸出區塊，原有記憶段落不改。
- `storage.rs`：有界 no-follow、排他檔案鎖、外部修改檢查、同目錄暫存替換，
  多檔失敗可回復；外部回復衝突保留備份，不強行覆蓋。
- `agent.rs`、`agent_chat.rs`、`agent_mcp.rs`：由 App 擁有的資料目錄在
  PTY 新啟動／恢復、app-server 送出前同步，記錄準備使用時間。
- `agent_instructions.rs`：原有指示／記憶檢視也遮罩，拒讀憑證路徑與 symlink，
  雜湊有界，禁止用遮罩畫面覆寫原始指示。
- `lib.rs`、`projectMemory.ts`：三個有修訂檢查的 inspect／import／mutate 入口。
- `ChatInstructions`、`ProjectMemoryPanel`、`MemorySaveButton`：懶讀管理介面、
  明確確認才改 .gitignore、逐條匯入、訊息先編輯再存。儲存成功但同步失敗會
  留在視窗顯示「已儲存、尚未同步」，避免重複新增或誤認 CLI 已讀入。
- `ChatView`、`SessionMessage`、`NativeRecordView`：一般／PTY／原生紀錄文字
  可存為記憶；可取得時保留原生對話與訊息識別。
- 繁中／英文文案、共用主題 token 樣式與
  [格式／對映／安全規則](../MEMORY.zh-TW.md)、功能對照更新。

## 測試

| 檢查 | 結果 |
| --- | --- |
| `npx tsc --noEmit`、`npm run build` | 通過；入口 457.78 KiB，低於 500 KiB |
| 全部 Vitest（含 CSS） | 2717 通過／0 失敗／3 跳過，351 檔通過／1 檔跳過 |
| `npm run build:sidecars` | 通過 |
| `cargo test` | 1252 通過／0 失敗；既有 65 忽略（lib 47、其他 target 共 18） |
| `cargo check`、`cargo clippy --all-targets -- -D warnings` | 通過 |
| `cargo fmt --all -- --check` | 通過 |
| `node scripts/connection-card-layout.mjs` | 144 通過／0 失敗 |
| `node scripts/session-folder-layout.mjs` | 144 通過／0 失敗，程序正常結束 |

Rust 新增 19 個測試（記憶庫 16、指示檢視 2、App 資料根 1），涵蓋區塊與
CRLF 冪等、外部內容保留、編輯／釘選／刪除、外部修訂、容量保留、原始記憶
唯讀、候選變更、四種類型／去重、機密與憑證 symlink 拒絕、App 位置切換、
跨專案載入、未確認不得改 gitignore、Codex override 與指令參數根目錄。
前端新增 6 個互動／渲染測試，涵蓋懶讀、無專案範圍、確認／取消、候選勾選、
禁止機密、修訂參數、編輯／釘選／刪除、訊息遮罩及儲存後同步失敗的提示。

版面測試使用 `CHROMIUM_NO_SANDBOX=1` 與臨時瀏覽器設定檔。
側欄先以快取 Chromium 跑完全部量測，但結束時出現既有臨時目錄 ENOTEMPTY
清理競態；改用 `CHROME=/usr/bin/google-chrome` 重跑同一腳本，量測及退出碼均
正常。沒有為這個測試環境問題修改版面腳本。構建仍有原有 ConnectFlow
同時靜態／動態匯入的提示，沒有新增構建錯誤。

## 尚需實機確認

本次沒有更新安裝版。安裝後仍需確認：

1. 奶油繪本／Mist 與行動寬度下，記憶編輯框、來源長路徑、鍵盤焦點與關閉返回。
2. 真實帳號的 Claude／Codex／Gemini 候選清單及原生來源不變；只勾選確定要共享者。
3. 換 CLI 開新對話／恢復後實際讀入指示；同步狀態只驗證輸出檔案，不保證模型使用。
4. 原本已執行中的 CLI 是否需原生 reload／重開。自訂指示檔名、trust、Grok 同名
   實作及管理員禁用仍須人工核對，不自動修改帳號設定。

任務 35 的自動壓縮尚未實作；目前超限保留正本、提示需同步並阻止過期輸出啟動。
