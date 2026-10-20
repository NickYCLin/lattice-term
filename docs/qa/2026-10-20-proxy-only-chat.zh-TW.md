# 僅設定 CLIProxyAPI 的對話入口

## 修正範圍

- 工作階段頁在未安裝 CLI 時，也列出已設定的 CLIProxyAPI。
- 快速對話與加入本機專案都能選代理、指定模型，再開啟對話頁。
- 未安裝對應 CLI 時走直接 API 對話，不建立終端程序，也不要求登入 Codex。
- 已安裝 Codex 的工作階段維持既有終端啟動方式；在對話頁仍可使用直接 API。
- 對話頁在沒有 CLI 時，不沿用原生對話的模型；舊代理已移除時，新對話選用目前的代理。
- API 對話支援的能力不變：圖片與 UTF-8 文字附件可送出，但不執行本機命令、瀏覽器或外掛工具。

## 自動驗證

```powershell
npx vitest run src/views/SessionsView.proxy.test.tsx src/views/ChatView.render.test.tsx src/app/useAgentChat.proxy.test.tsx src/app/accountModels.test.ts
npm run typecheck
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib agent_chat::proxy_chat::tests
```

工作階段互動測試涵蓋空 CLI 清單、CLI 全部未安裝、只有其他 CLI、已有 Codex、專案資料夾入口，以及模型未填或格式錯誤時禁止送出。
對話頁測試涵蓋無 CLI 入口、可編輯輸入框、非預設代理 ID、舊原生對話、代理已移除與保留既有代理選擇。
直接 API hook 測試檢查送出的 IPC 命令、代理身分、後續對話與附件；Rust 測試使用本機 HTTP 測試服務，不呼叫付費模型。

## 人工驗收邊界

本次本機檢查結果：`npx vitest run src` 共 232 個測試檔、1,590 項測試通過；`npm run build`（含 typecheck 與入口大小檢查）通過；直接 API 的 5 項 Rust 測試通過；`git diff --check` 通過。

自動測試不是乾淨 Windows 安裝版驗收，也不是正式代理服務的端到端驗收。
安裝新版後，應在未安裝任何模型 CLI 的環境設定代理位址與必要的 API key，再從工作階段與對話頁各送出一輪訊息，確認回覆、切換代理、重啟續聊及附件。
