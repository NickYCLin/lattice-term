# 資料庫 TLS 設定驗收（任務 16）

## 行為與修改範圍

原本儲存的 `tlsCaPem` 沒有傳入驅動；現在所有連線測試、唯讀查詢與 SQL 工作台共用 `database/tls.rs` 的 TLS 設定。

| 設定 | PostgreSQL | MySQL／MariaDB | SQL Server |
| --- | --- | --- | --- |
| 無 CA、信任伺服器憑證（預設） | Prefer | Preferred | On、明確略過驗證 |
| 有 CA、直接連線 | VerifyFull、自訂 CA | VerifyIdentity、自訂 CA | Required、自訂 CA、原始主機名稱 |
| 有 CA、SSH／遠端通道 | VerifyCa、自訂 CA | VerifyCa、自訂 CA | Required、自訂 CA、原始主機名稱 |
| 無 CA、取消信任 | 強制 TLS、驗證主機名稱及驅動信任根 | 強制 TLS、驗證主機名稱及驅動信任根 | Required、驗證主機名稱及平台／驅動信任根 |

SQLx 目前無法分別指定通道的 socket 位址與 TLS 主機名稱，因此通道使用 CA 憑證鏈驗證，介面亦明確說明；直接連線仍驗證主機名稱。SQL Server 保留原始主機名稱，不拿通道的 loopback 位址驗證。CA 一律優先於略過驗證的旗標，不會呼叫 `trust_cert()`。

`DatabaseManager` 的 CA 與信任選項位於預設收合的「進階 TLS 設定」，未驗證時顯示「未驗證伺服器憑證」。CA 僅接受既有規則允許的一張公用 PEM 憑證（最多 16 KiB），不接受私鑰。修改 TLS 設定會清除 MCP 讀取授權，並變更後端憑證綁定；未改設定的舊連線沿用原本的憑證識別。

既有資料模型沒有用戶端憑證／私鑰欄位，本次沒有新增雙向 TLS 或私鑰儲存格式。SQLite 切換會清除網路 TLS 設定。

## 檢查結果

- `npm run build:sidecars`、`npx tsc --noEmit`、`npm run build` 通過。
- 全部 Vitest：2,553 通過、0 失敗、3 略過；相關測試 65 通過。
- `cargo fmt --all -- --check`、`cargo check` 通過。
- 全部 `cargo test`：1,183 通過、0 失敗、63 ignored（含整合測試）；下列 Docker 測試另行執行。
- `node scripts/test-databases.mjs`：PostgreSQL 17、MySQL 8、MariaDB 11.4、SQL Server 2022 各 2 通過，共 8 通過、0 失敗。覆蓋無 CA 預設直連、有效 CA、錯誤 CA、主機名稱不符、取消略過驗證後拒絕自簽憑證、通道原始主機名稱語意、唯讀查詢與隔離 SQL 增刪修。
- 單元測試以 Tiberius 公開 API 的互斥條件確認有 CA 時不會曾呼叫 `trust_cert()`；另測試舊設定預設值、嚴格模式、通道模式與 TLS 錯誤分類。

隔離測試曾發現 SQLx 將 rustls 憑證錯誤包成 IO，造成錯誤文案被歸為連線問題；現在僅依內層錯誤型別分類為 TLS，不讀取或回傳伺服器原文。獨立測試也補上正式程式啟動時既有的 ring provider 初始化，避免同時啟用兩個 rustls provider 的測試順序問題。

Docker 使用測試專屬容器、tmpfs、隨機密碼及暫存憑證，結束時清除；未使用正式資料庫。OpenSSL 僅供測試腳本產生臨時憑證，應用程式不依賴外部 TLS 工具。

## 尚未驗證的界線

Windows 的 Tiberius 依既有 Cargo 設定使用 native-tls／SChannel。已核對其 CA bundle 透過 `add_root_certificate` 加入連線的 trust anchors，無需修改系統信任庫；本次 Linux 環境沒有執行 Windows 握手測試。

仍需安裝版實機確認進階區塊、儲存及重開後的信任選項與狀態文案，以及 Windows 自訂 CA 連線。不發版、不打 tag、不更新安裝版，不代表已完成上述實機確認。
