# SQL Server TLS 相依套件修正

日期：2026-10-20。這是原始碼與隔離測試紀錄，不代表已發布或安裝版驗收。

## 問題與調整

GitHub 的三項未結安全警示都指向 `src-tauri/Cargo.lock` 裡的
`rustls-webpki 0.101.7`，由 `tiberius 0.12.3 → tokio-rustls 0.24.1 →
rustls 0.21.12` 帶入。其他 HTTP 與遠端連線已使用較新的 rustls，
只更新該組相依套件並不會消除 SQL Server 的舊版本。

- GHSA-82j2-j2ch-gfr8：惡意 CRL 的 BIT STRING 可能引起 panic。
  官方公告的觸發前提是啟用 CRL 檢查且載入攻擊者可影響的 CRL；
  警示存在本身不代表 LatticeTerm 的預設連線已可被這條路徑利用。
- GHSA-xgp8-3hg3-c2mh：萬用字元憑證名稱的 name constraints 驗證問題。
- GHSA-965h-392x-2mh5：URI name constraints 未被正確拒絕。

升級至 `tiberius 0.13.0`，移除舊 rustls／webpki 相依鏈。
Windows 的 SQL Server 使用系統 TLS，避免新驅動的 rustls 預設後端
在 Windows 帶入額外的 AWS-LC 原生建置需求；其他平台維持 rustls。
既有 HTTP、SSH 與遠端連線的 ring 設定不變。

自訂 CA 改走驅動的記憶體 API，不再建立 SQL Server CA 暫存檔。
仍明確要求加密、驗證憑證與主機名稱，不啟用 `trust_cert` 或跳過驗證。
既有單張 PEM、16 KiB 限制、密碼保管與唯讀查詢界線不變。

## 驗證紀錄

- Windows Rust 全量循序測試：994 通過、32 忽略、0 失敗。
  忽略案例不計入驗收；本輪沒有重跑原生 CLI opt-in 測試。
- `node scripts/test-databases.mjs sqlServer`：隔離整合測試 1 通過，
  正常結束並完成清理。使用本機 SQL Server 2022 容器與合成測試資料，
  驗證自訂 CA、缺少 CA、無效 PEM、主機名稱不符及唯讀查詢界線。
- 前端全量 Vitest：250 個檔案通過、1 個跳過；1864 項通過、4 項跳過。
- `cargo fmt --all -- --check`、`cargo check --locked`、
  `npm run actions:check` 與 `git diff --check` 通過。
- `npm run build` 通過，包含 typecheck 與入口大小檢查（372.12 KiB）。
- `cargo tree` 確認 Windows 僅啟用 tiberius 的 native-tls，Android
  僅啟用 rustls；目前主程式相依圖只剩 `rustls-webpki 0.103.14`。
  相依圖檢查不是跨平台編譯或實機驗收。

首次前端設定測試因 Windows PATH 選到 WSL bash 與缺少 python3 alias
失敗；改用本輪隔離 alias、Git Bash 與 UTF-8 後全量重跑通過，沒有略過案例。
首次隔離測試在 Rust 編譯階段超過腳本的 10 分鐘限制，尚未啟動資料庫；
利用暖快取重跑後，編譯、整合測試及清理均正常結束。
Rust 預設平行全量曾有 5 項非資料庫案例失敗，包含終端回覆與程序探測逾時；
以 `--test-threads=1` 重跑全部案例後通過。這是循序驗證結果，
不代表已修復原有測試的平行干擾；本輪未修改這些案例或產品邏輯。

## 驗收邊界

macOS、Linux、Android、iOS 的完整建置與實機連線未在本輪本機驗收。
Windows 隔離 SQL Server 不代表使用者資料庫或安裝版介面已驗收。
未發布 release，也未將 Gemini elicitation、原生多模態歷史或重啟恢復
等前輪待辦視為完成。

## 來源

- https://github.com/prisma/tiberius/releases/tag/v0.13.0
- https://github.com/advisories/GHSA-82j2-j2ch-gfr8
- https://github.com/advisories/GHSA-xgp8-3hg3-c2mh
- https://github.com/advisories/GHSA-965h-392x-2mh5
