# 資料庫免外部工具與 SSH 通道驗收（任務 17）

## 執行方式

```sh
npm run build:sidecars
node scripts/test-databases.mjs
# 單一引擎：postgres / mysql / mariadb / sqlServer
node scripts/test-databases.mjs sqlServer
```

測試主機需要 Node.js、Rust、Docker 與 OpenSSL；OpenSSL 只產生隔離測試憑證。SSH 金鑰由 sshd 容器內的 ssh-keygen 臨時產生。測試建置與資料初始化所用的工具，不是使用者執行本程式連線時的需求。SQL 初始化工具只在各資料庫容器內執行。

Docker 無法使用時，腳本印出 `SKIP: Docker is unavailable; ... did not run.` 並退出，不宣稱完成資料庫驗收；此行為另有 Vitest 子行程測試。

## 測試保證

- cargo 只負責先建置。腳本從 cargo JSON artifact 取得測試執行檔的絕對路徑，再直接啟動獨立子行程。
- 該子行程的 PATH 只含一個不存在的目錄。任何資料庫操作前，先確認 psql、mysql、mariadb、sqlcmd、bcp、isql、ssh 都無法啟動，且錯誤確為 NotFound；不修改其他測試或父行程的 PATH。
- 每種引擎均測試直連及 `DatabaseRoute::Ssh`，各跑免 CA 與有效 CA 兩種設定；每次都執行 SELECT 1、列出資料表及讀取 sample 資料表的兩個欄位。
- SSH 使用獨立 Docker 網路及真實 OpenSSH sshd。資料庫以網路別名 database 供 SSH 主機解析，不把主機映射埠當成 SSH 遠端目的地。
- host key 與 client key 均臨時產生；用指定公鑰指紋驗證 SSH 主機，不略過 host key 檢查。client 私鑰只放測試暫存目錄，權限 0600，不輸出、不入庫。
- 抽出 transport 的 SSH 路線建立核心，正式程式與測試共同使用相同的 DatabaseRoute 選擇、loopback listener、原始 TLS 主機名稱及路線清理邏輯；轉送實際由 russh／TunnelRegistry 執行。
- 測試專用的金鑰憑證注入只在 cfg(test) 下存在。正式程式依舊透過既有設定、信任庫及密碼庫載入密碼；本次沒有新增正式版金鑰通道功能，也不接觸使用者密碼庫。
- 測試檢查路線釋放後監聽埠關閉；非 SSH 路線拒絕啟動、啟動失敗釋放埠另有一般單元測試。
- 資料庫帳密隨機產生，fixture 權限 0600；資料使用容器 tmpfs。finally 清理本次容器、網路與暫存金鑰／憑證，不接觸正式資料庫。

## 結果

| 隔離服務 | TLS／唯讀／CRUD | 無工具 PATH 的直連與真實 SSH |
| --- | --- | --- |
| PostgreSQL 17 Alpine | 2 通過 | 1 通過（4 種路徑／CA 組合） |
| MySQL 8 | 2 通過 | 1 通過（4 種路徑／CA 組合） |
| MariaDB 11.4 | 2 通過 | 1 通過（4 種路徑／CA 組合） |
| SQL Server 2022（強制加密） | 2 通過 | 1 通過（4 種路徑／CA 組合） |

合計 12 項通過、0 失敗。無工具測試共涵蓋 16 種引擎／路徑／CA 組合。

- `npm run build:sidecars`、`npx tsc --noEmit`、`npm run build` 通過。
- 全部 Vitest：2,554 通過、0 失敗、3 略過。新增的腳本相關測試 1 項通過。
- `cargo fmt --all -- --check`、`cargo check` 通過。
- 全部 cargo test：1,185 通過、0 失敗、64 ignored；上述 Docker 測試另外執行。
- `cargo build --bin lattice-term` 通過，供本次 Linux ELF 依賴檢查使用。

## 打包與函式庫依賴

核對 `src-tauri/Cargo.toml`、`tauri.conf.json` 與 Windows installer hooks：PostgreSQL／MySQL／MariaDB 使用 sqlx 原生協定，SQL Server 使用 tiberius；沒有 ODBC、libpq、MySQL client 或 FreeTDS 驅動依賴。Tauri externalBin 僅列本專案的 RDP、VNC、agent、remote sidecars，沒有 SQL 工具或 SQL driver 安裝步驟。

Windows 的 tiberius 使用 native-tls／SChannel；macOS 使用 rustls。桌面 SQLite 經 sqlx 的 sqlite → sqlite-bundled → libsqlite3-sys/bundled 建置，已以 Linux cargo tree feature graph 確認。本次未修改平台或打包設定。

對本次新建置的 Linux `target/debug/lattice-term` 執行 readelf -d 與 ldd：沒有 libpq、libmysqlclient、libmariadb、libodbc、libsybdb、libtds，也沒有遺失共享函式庫；ELF 本身不直接依賴 libsqlite3.so。ldd 的完整傳遞相依仍有系統 SQLite，來源是 WebKitGTK 等桌面函式庫，另以 WebKitGTK 的 ldd 確認，與 bundled 資料庫驅動分開判讀。

Windows／macOS 僅完成原始碼與設定盤點；沒有在這兩個平台建置、檢查 PE／Mach-O 或執行安裝版。離線 cross-target cargo tree 因本機未快取部分平台套件而無法展開，不列為已通過的跨平台檢查。

## 實機邊界

本次沒有 UI 修改、沒有更新安裝版、沒有發版或 tag。仍需在乾淨的 Windows／macOS 安裝環境，以畫面確認新增連線、SSH 路線選擇與查詢結果；Linux 本次證據是實際編譯的執行檔、隔離子行程及 Docker 網路握手，不是安裝版 GUI 驗收。
