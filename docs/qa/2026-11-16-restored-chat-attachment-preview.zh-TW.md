# 任務 29：重新開啟對話後的圖片預覽

## 原因與修正

原本的預覽只接受工作目錄和目前 thread/session ID 的附件目錄。
PTY 圖片快照也會用同樣規則先濾掉舊 ID 目錄的路徑，
因此原生逐字稿仍指向存在的圖片時，重啟後仍會失去預覽。

一般對話現在將原生對話 ID、CLI 類型及所選帳號目錄傳給預覽命令；
PTY 則由後端現存工作階段摘要取得這些資訊，優先於呼叫端資訊。
後端依精確原生 ID 尋找逐字稿，不以同工作目錄的最近對話替代。
PTY 快照保留使用者訊息引用的舊附件路徑與缺檔位置，供縮圖和燈箱核對。

## 舊目錄的存取規則

- 僅新增對 App 資料目錄 `chat-workspaces/<合法對話 ID>/<附件檔名>`
  的逐檔讀取，不把整個 `chat-workspaces` 加入一般預覽根目錄。
- 附件檔名限既有 `agent-image-<32 或 64 位十六進位雜湊>`、
  `clipboard-<隨機字串>`、`phone-<隨機字串>`，副檔名限
  PNG、JPEG、GIF、WebP。隨機字串限 6–64 個英數字。
- 必須在該精確原生對話的使用者訊息中找到同一路徑。
  支援 PTY 附件後綴、原生 image 標記、app-server 的
  `latticeterm-attachments` JSON 區塊與結構化本機圖片欄位；
  助理回覆中的路徑不能授權讀取。
- 拒絕 `..`、不符命名、未引用、其他對話附件及符號連結逃逸。
  canonicalize 後必須仍位於真正的 App 附件根目錄且符合預期路徑。
  Unix 另以目錄 handle 與 no-follow 相對開檔，避免驗證後替換路徑；
  其他平台沿用 regular-file/reparse-point 檢查並再次確認路徑。
- 仍限制 16 MiB 與圖片 magic bytes，逐字稿掃描維持既有 24 MiB 上限。
  找不到精確對話或引用時拒絕，不擴大搜尋範圍。
- 專案內圖片、目前對話自己的暫存／工具圖片沿用原本預覽範圍。
  舊 `/tmp` 圖片僅保留既有工作階段仍持有原始 bytes 時的遷移方式。

缺檔與無權預覽各有繁中／英文文案；其他失敗保留原有訊息。
燈箱開啟時重新檢查，不把先前取得的縮圖 URL 當作檔案仍存在的證據。

## 驗證

- `npm run typecheck`、`npx tsc --noEmit`：通過。
- 全部 Vitest：2645 通過、0 失敗、3 略過。
- `npm run build`（含入口大小檢查）：通過。
- `npm run build:sidecars`：通過。
- `cargo test`：1201 通過、0 失敗、65 ignored（含整合測試）。
- `cargo check`、`cargo clippy --all-targets -- -D warnings`、
  `cargo fmt --all -- --check`：通過。
- `node scripts/connection-card-layout.mjs`：144 通過、0 失敗。
- `node scripts/session-folder-layout.mjs`：144 通過、0 失敗。
  首次量測全部通過後，Chromium 暫存目錄清除遇到 ENOTEMPTY；
  原腳本重跑完整量測及清除成功，未修改不相關腳本。

Rust 測試使用臨時目錄、假帳號目錄與精確 ID 的合成原生逐字稿，
驗證舊 ID、未知 ID、未引用圖片、助理訊息不得授權、刪除、
路徑穿越及檔案／目錄符號連結。
前端互動測試重新掛載一般對話與更換 PTY runtime ID，
驗證縮圖、燈箱、原生對話參數及刪除／拒絕訊息。

## 實機界線

本次未安裝或重啟使用者正在使用的 App，未讀取使用者附件或正式逐字稿。
仍需以更新後的實機 App 重新開啟既有 Codex 對話，
確認原來兩張圖片在奶油繪本主題的縮圖和燈箱均正常。
其他平台的符號連結／reparse 行為仍需各平台實機確認。
