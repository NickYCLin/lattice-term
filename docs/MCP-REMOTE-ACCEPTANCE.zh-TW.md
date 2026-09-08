# MCP 遠端操作與紀錄驗收

這份紀錄接續 [#180](https://github.com/NickYCLin/lattice-term/issues/180)，記錄 2026-09-08 的候選版檢查。實作、測試程序與安裝版是不同層次；以下沒有操作既有正式主機或使用者的日常工作階段。

## Windows 本機

`cargo fmt --all -- --check`、`cargo check`、`cargo clippy --lib -- -D warnings` 通過。Rust 測試執行檔仍需使用副本加入 Common Controls v6 manifest，做法與限制見 [Windows 驗收紀錄](MCP-WINDOWS-ACCEPTANCE.zh-TW.md)。未更動原始測試產物、系統 DLL 或已安裝的 LatticeTerm。

| 實際執行的測試 | 結果與範圍 |
| --- | --- |
| `agent_daemon::` | 74 項通過，包含 22 項紀錄儲存、13 項桌面橋接，以及既有 observer、取消、重送與管道測試 |
| `mcp_desktop::` | 17 項通過，包含真實 TCP loopback SSH 的信任、指令結果、取消、逾時及失聯撤權 |
| `metrics::` | 5 項通過 |
| Windows 環境繼承 | 3 項通過，不截斷 PATH、不改系統設定，帳號與 reporter 覆寫仍有效 |
| 終端輸入所有權 | 2 項通過，DECRPM 回報不占用人工輸入；未知控制碼仍視為人工操作 |

總計 101 項，是指定範圍的 Windows 原生測試，不是整個專案所有 Rust 測試。橋接的 13 項測試也曾連續重跑 20 輪，確認 Windows 管道在取消 accept 後仍保留已連入的 client。

另以本機 debug 主程式執行 `scripts/verify-mcp-windows.mjs`，不加 `--external-reporter`，10 項 MCP／具名管道／ConPTY 驗收全部通過。本次 reporter 確實由 ConPTY 裡的合成 fixture 呼叫，不再從外部注入；仍不是 AI 供應商的就緒 hook。工具探索確認 15 個工具，未授權的遠端清單為空、主機查詢遭拒絕。

主程式 SHA-256：`4c3e064f948f8af0f5ece843b45258c53c85f6abfdf11c33bc10cff7ed513747`。完整結果見 [原生 reporter 驗收報告](assets/mcp-windows-native-reporter-20260908.json)。這份主程式只用於獨立暫存環境，未安裝或覆蓋日常版本。

新增介面用真實 React 元件與 mock Tauri 回應測過授權／撤權、SSH／SFTP 權限分流與窄視窗。畫面見 [SFTP 授權表單](assets/mcp-remote-sftp-narrow.png)；這不是安裝版或真實遠端連線的操作驗收。

## 安全檢查

- 遠端 scope 預設關閉，grant 綁定既有 live registry handle；失聯後原 ID 永久失效，重新授權必須取得新 ID。
- 連線摘要與主機指標只提供核准名稱、opaque ID 與數值，不附帶 host、帳號、指令、絕對根目錄、掛載路徑或 filesystem。另行授權的終端輸出、命令結果與檔名仍可能含敏感內容，會交給所選 client。
- 根目錄及其祖先連結換置、hardlink、FIFO、路徑跳脫、外部檔案衝突都有對應防護。遠端路徑檢查仍依賴合作的 SFTP 伺服器，不是 chroot。
- exec 使用專用 channel，取消及逾時不影響原 SSH 終端；EOF 不當成 exit 0，也不宣稱所有衍生程序已被終止。
- 傳檔不覆寫既有檔案。無效請求不占去重紀錄；同一 request ID 不因重送而再執行。
- 紀錄採 owner-only 有界原子快照，不保存提示、原始錯誤、憑證或路徑。儲存失敗不清空既有紀錄，也不阻止 CLI 啟動；突然終止仍可能遺失待寫快照。
- Gitleaks 8.30.1 已掃描本次變更 diff，未發現機密資訊；這不是整個 Git 歷史或外部相依套件的安全認證。

## Linux OpenSSH 與尚待核對的層次

CI 的既有命令會執行新增的隔離測試：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib openssh_ -- --ignored
```

新增 fixture 經真實 TCP SSH、`SftpRegistry` 與 OpenSSH `sftp-server` 執行分塊上傳／下載及雜湊核對；另驗證不覆寫、撤權、根目錄限制，以及拒絕 rename 時保留原檔、清除 staging。這是臨時 loopback SSH peer 加真正 SFTP subsystem，不是 OpenSSH `sshd`、正式主機或桌面安裝驗收。

本機 Windows 無法執行這些 Unix-only 測試，結果需依本次 PR 的 Linux CI 核對。真實 Claude／Codex 雙 Agent 協作也須取得官方就緒／完成回報與各自結果，不能用合成狀態或本文件的 101 項測試替代。macOS 桌面、外部主機與 D 遠端畫面不在本次已通過範圍。
