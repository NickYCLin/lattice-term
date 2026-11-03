# SQL 工作區、帳密表單與 AI 權限

## 行為

- 工作階段與對話頁共用一個 SQL 資料庫面板；收合或切換頁面保留未同步草稿。
  桌面可沿用 SQL 標題拖曳或按鈕移至獨立視窗；關閉後恢復內嵌工作台。
- 桌面 SQL 與結果並排；較窄面板上下排列，可收合編輯器。結果支援本機篩選、
  固定表頭、筆數及儲存格內容檢視，區分 NULL 與空字串，不自動送進對話。
- 連線設定以連線位置、登入資料、AI 存取分組；桌面兩欄，窄畫面單欄。
  帳號與密碼輸入欄直接顯示於表單右側，密碼可切換顯示，且不取回已保存的密碼。
- MCP SQL 執行預設關閉。明確授權唯讀後可編輯及執行 SELECT；授權增刪修後
  才能執行 INSERT、UPDATE、DELETE。MCP 不能修改自己的權限或傳入確認旗標。
- 執行綁定工作台 revision，不重放舊版本。提交前再次檢查工作台、連線與全域
  分享；寫入結果不確定時不自動重送。資料庫本身的帳號及交易限制仍適用。

## 本機驗證

前端相關 8 個測試檔、54 項測試通過，包含收合及跨頁保留草稿、AI 權限設定不
執行 SQL、衝突草稿保留、既有分離視窗、結果篩選與密碼顯示。另驗證 AI 查詢執行中撤權、保留衝突草稿及執行結束後
解除忙碌狀態，不會讓草稿卡住。型別檢查、
`npm run build` 與入口大小檢查通過。

使用實際 React 元件、虛構連線及查詢資料進行 WebKit 畫面檢查；沒有連到使用者
資料庫。檢查 1440 × 1000、1024 × 768、393 × 852、320 × 568，
搭配明暗主題與 130% 介面字級，共 8 組；SQL 及設定頁沒有頁面層水平溢出
或 JavaScript 錯誤。實際操作結果篩選與 AI 權限選單亦通過。
截圖與預覽資料保存在忽略提交的 `output/sql-workspace-preview/`。

Rust 資料庫測試 20 項、MCP 授權測試 3 項、工具介面測試 1 項通過。
另有 2 項需外部實庫的測試依原設定略過。新增測試實際執行 SQLite 的
SELECT、INSERT、UPDATE、DELETE，驗證拒絕未授權寫入、拒絕舊版本重送、
撤回執行授權與提交前撤回全域分享時的交易回復。`cargo check` 及
`cargo fmt --all -- --check` 通過，下節記錄本機資源覆寫範圍。

第一輪測試因 macOS 預設暫存路徑經過符號連結而拒絕 SQLite fixture，
改用不含符號連結的獨立暫存目錄後全數通過；沒有放寬正式程式的路徑檢查。

## 驗證界線

此環境缺少桌面 sidecar 產物，直接 `cargo check` 會在資源封裝檢查停止。
本次資料庫程式的檢查與測試使用下列本機環境覆寫，省略無關的外部程式資源，
不建立假的 sidecar，也不修改正式封裝設定：

```sh
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo check --manifest-path src-tauri/Cargo.toml
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --manifest-path src-tauri/Cargo.toml --lib database::
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
```

本次沒有重跑外部 PostgreSQL、MySQL、MariaDB 與 SQL Server 的實庫測試。
新增權限與撤回流程以隔離的本機 SQLite 驗證，沿用既有驅動與 SQL 限制。
瀏覽器元件預覽不代表已驗收原生視窗跨螢幕拖曳，也不代表使用者安裝版已更新。
本批 SQL 功能不包含在注音修正版 TestFlight 2026.11.3（12）。
