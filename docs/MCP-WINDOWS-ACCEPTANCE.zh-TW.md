# Windows MCP 驗收紀錄

2026-09-08，在 Windows x64 驗證 #180 的 A／B 階段。F1～F4 已通過；另外補上 Windows 取消工作階段誤報失敗的修正，以及可重跑的驗收腳本。

程式以 #183 合併後的內容為基礎，Windows 修正在 `6d957a4`，驗收腳本的短路徑與回報模式修正在 `cc6cdb0`。並行重送、撤權與失聯處理沿用 #183。

## 實際檢查

以下透過真正的 MCP stdio、Windows 具名管道與 ConPTY 執行。Windows CI 與下載安裝包解出的執行檔各通過 9 項檢查。本機 debug 執行檔也在一般目錄與 8.3 短檔名暫存目錄各通過一次。

| 項目 | 確認的行為 |
| --- | --- |
| A：工具與分享 | 8 個工具可探索，只列出已分享的工作階段；未分享的輸出不能讀取，清單不洩漏啟動參數、PID 或帳號目錄 |
| F1：撤銷分享 | 等待立即回 `revoked`；等待期間其他呼叫仍可完成，撤銷後不能再讀輸出 |
| F2：ANSI 分頁 | `16382` 個 `x` 加上 `ESC[31mRED`，第一頁停在 `16382`，下一頁從 `RED` 開始 |
| F3：UTF-8 小分頁 | `maxBytes: 1` 遇到 `é`、`中`、`😀`，分別完整回傳字元，cursor 前進 2、3、4 bytes |
| F4：Windows 路徑 | 大小寫、正反斜線、尾斜線、`\\?\`、相對路徑與 `..` 等 8 種寫法連到同一個 daemon；另一個資料目錄保持隔離 |
| B：授權與派送 | 只分享不能送指示或停止；尚未就緒、忙碌與撤權後都拒絕即時派送；就緒後提示只送一次，佇列可清除 |
| B：啟動與取消 | 只能啟動已授權項目；桌面收到啟動事件，重送不再啟動；取消後確認程序真的退出，其他工作階段保留 |
| B：並行重送 | 兩條 MCP 連線同時送出 4 個相同 requestId 的啟動請求，只產生 1 個工作階段 |
| F1：服務失聯 | 結束測試 daemon 後，等待立即回 `isError`，不再當成撤銷分享 |

Windows 取消原本會回「控制代碼無效」，即使程序已停止。`portable-pty 0.9` 的 Windows killer 判斷反了：成功時讀取舊的系統錯誤。現在保存獨立的程序 handle，依 Windows API 的回傳值判斷；已退出的程序可重複停止，真正的錯誤仍會回報。

## 驗證來源

- 本機 Rust：`cargo check`、`cargo fmt --all -- --check` 通過；MCP／daemon 31 項與程序終止 2 項測試通過。
- 本機 Windows debug：執行檔 SHA-256 為 `5da17e180717dbda3656b39e5ad0ba841fe009387a007ee1d62415c3826643dc`，一般目錄與短檔名目錄各通過 9 項驗收。
- [main 的 Linux CI](https://github.com/NickYCLin/lattice-term/actions/runs/34179997666)：前端檢查與 production build、Rust 467 項測試（16 ignored）、SFTP 檢查及 Clippy 通過。
- [Windows 安裝包 CI](https://github.com/NickYCLin/lattice-term/actions/runs/34179999057)：`cc6cdb098996c32110322e44ee9600cb6a6090f7` 封裝成功，9 項驗收通過；[JSON 報告](https://github.com/NickYCLin/lattice-term/actions/runs/34179999057/artifacts/10038895318) 記錄各項結果。
- [下載產物](https://github.com/NickYCLin/lattice-term/actions/runs/34179999057/artifacts/10038895947)：核對來源 commit 與 artifact ZIP 雜湊後，從 `LatticeTerm_2.0.0_x64-setup.exe` 解出主程式，在本機 Windows 重跑 9 項，全數通過。撤銷分享 1 ms 回覆，daemon 失聯 5 ms 回錯誤；並行 4 個相同啟動請求只產生 1 個工作階段。

下載核對的 SHA-256：

| 檔案 | SHA-256 |
| --- | --- |
| Artifact ZIP | `11677a7a13d2bfd04821a79ef4c49d6568d59cb63930411392eaea1fe46e526f` |
| NSIS 安裝包 | `27dd73e7d36d992e25fc392c51bf50b5595e4c3bec5c7bd45e1268e83fab3c8a` |
| 安裝包解出的主程式 | `7449827c3f77441d65853a403a15c0b96c8168b67f6a878affe5bba24441da5e` |
| CI 直接測試的主程式 | `9937ed72b4cebc4cb50c919aa15c434a2d8daf72b5aba25a08f2d522936de62e` |

安裝包雜湊與 CI log 一致。兩個主程式的差異只有 Tauri 封裝識別標記：安裝包內為 `__TAURI_BUNDLE_TYPE_VAR_NSS`，CI 直接測的檔案為 `__TAURI_BUNDLE_TYPE_VAR_UNK`。將下載檔案在記憶體中的該標記還原後，SHA-256 與 CI 完全相同；實際檔案未改寫，下載驗收使用原始解出的檔案。這符合 [Tauri 封裝後還原原始檔案的流程](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle.rs)。

Windows 的 Rust 測試執行檔缺少 Common Controls v6 manifest，直接執行曾得到 `0xc0000139`。本次使用測試執行檔的副本，加入桌面執行檔相同的 manifest 後執行上述 33 項測試；沒有更動系統 DLL 或已安裝程式。

## 重跑與範圍

```powershell
node scripts/verify-mcp-windows.mjs "C:\path\to\lattice-term.exe" report.json --external-reporter
```

驗收使用獨立暫存目錄與合成 shell 工作階段，透過真正的 reporter CLI 注入就緒狀態；報告中的 `lifecycleReporter` 會標示回報方式。未使用日常帳號、設定或工作階段，也未執行安裝程式。

這不是實際 AI CLI hook 或兩個 AI Agent 完整協作的驗收。本機在 ConPTY 內額外啟動回報程序時曾得到 `0xc0000017`，因此本輪用 `--external-reporter` 檢查 MCP 授權與派送；該條 CLI 子程序鏈路仍需另外驗證。Windows 桌面勾選框與 macOS 也不在本輪實測範圍內。

#180 保持開啟：SSH／SFTP、遠端畫面、中止單輪，以及真實 AI CLI 的完整協作仍是後續項目。
