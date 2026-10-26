# MCP 專案工作階段啟動驗證

本次增加獨立、預設關閉的專案啟動授權。`launch_agent` 可接受
`workingDirectory`、`cli`、`requestId`，權限來源由桌面設定決定。
使用步驟與風險見 [MCP 操作指南](../MCP_GUIDE.zh-TW.md)。

## 本機結果

- `cargo fmt --all -- --check` 通過。
- `cargo test`：1,074 項通過、39 項既有略過；另有依賴外部環境的
  18 項整合測試維持原有略過條件。
- `cargo clippy --all-targets -- -D warnings` 與
  `cargo check --all-targets` 通過。
- `npm run check` 通過：Vitest 2,046 項通過、2 項略過，TypeScript、
  版本一致性、Actions 設定、正式建置與前端入口大小檢查均通過。

新增測試涵蓋未授權、observer 無法自授權、白名單外目錄、`..`、
符號連結逃逸、登記根目錄遭替換、三種 CLI 全權限旗標、保存項目權限
繼承、拒絕無法安全抽取的設定覆寫、安全保存及外部寫入衝突。

真實本機 socket 與 MCP adapter 整合測試驗證關閉授權、空計畫清單下的
專案授權宣告、路徑拒絕及撤權。啟動流程測試在啟動器邊界核對權限
參數，再注入隔離的 cat PTY，驗證共享、讀取、控制、去重、不同內容
重用 ID 拒絕、兩種額度、啟動中撤權與成功／失敗稽核。

首次提示測試使用隔離 PTY 與合成終端畫面：畫面未靜止時，`now` 與
`queue` 都拒絕且不入隊；穩定空白提示可送出第一則訊息，之後不能靠
畫面靜止猜測回合完成。既有前景與一般背景傳訊回歸一起通過。

## 證據邊界

以上為 Linux 本機測試，不包含真實供應商 CLI 帳號回合、安裝版 GUI、
Windows ConPTY、macOS 或遠端主機的實際驗收，也不代表 CI 或發版結果。
全權限旗標依儲存庫既有權限介面所支援的 CLI 契約產生；本次不使用
真實金鑰、不改 CLIProxyAPI 服務或設定，也沒有發版。
