# 任務 15：資料庫連線錯誤分類

## 顯示與安全邊界

驅動只回傳五種固定代碼，不格式化錯誤、不讀取伺服器 message，
不附加連線字串、主機、帳號、SQL 或憑證內容。前端透過白名單
將代碼轉為繁中或英文；未知的保留前綴代碼也顯示安全的「其他」
文案，不回顯其附加內容。其他原有的設定驗證、衝突及交易結果
不明提示維持原文，不吞掉「不要直接重送 SQL」的保護資訊。

| 代碼 | 類別及可採取的動作 |
| --- | --- |
| `database.error.connection` | 無法連線、中斷或等候逾時；檢查主機名稱、連接埠、網路與服務狀態 |
| `database.error.authentication` | 帳號／密碼驗證失敗；確認帳號、已儲存密碼與登入方式 |
| `database.error.databaseAccess` | 資料庫不存在或無存取權；檢查名稱／檔案路徑及權限 |
| `database.error.tls` | TLS／憑證問題；確認憑證有效期、主機名稱與信任設定 |
| `database.error.other` | 其他操作錯誤；確認設定、類型與查詢，寫入需先確認結果再決定是否重試 |

所有新增文案均未建議安裝外部工具，也未建議略過憑證驗證。
分類不會修改任何驅動的 TLS 設定或登入策略。

## 結構化分類依據

- SQLx `Io`、`PoolTimedOut` 與 SQL Server socket／Tiberius `Io`
  歸連線問題；DNS、拒絕連線、斷線及逾時均由型別處理，完全不
  比對可能含敏感資訊的錯誤文字。`Tls` 直接歸 TLS 問題。
- PostgreSQL：SQLSTATE 28 類為登入驗證，08 類為連線；3D000／
  42501 為資料庫不存在／權限；53300／57P03 為暫時無法連線。
  依據：[PostgreSQL Error Codes](https://www.postgresql.org/docs/current/errcodes-appendix.html)。
- MySQL／MariaDB：使用 SQLx 實際 MySQL 錯誤的 number 與 SQLSTATE，
  1045／1698 為登入，1044／1049／1142／1143／1227 為存取；
  其餘依明確連線／TLS number 或 SQLSTATE 分類。42000 同時涵蓋
  語法與存取問題，不能整類誤判為權限；未識別的語法錯誤歸其他。
  依據：[MySQL Server Error Reference](https://dev.mysql.com/doc/mysql-errors/8.0/en/server-error-reference.html)。
- SQL Server：使用 Tiberius Server token 的 code／state；18456
  通常是登入問題，但 state 11／12／38／46 歸存取問題；4060／
  4064／911／916 等歸資料庫不存在或無權限，40613 歸無法連線。
  依據：[Microsoft 18456](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error)、
  [Microsoft 4064](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-4064-database-engine-error)。
- SQLite：開檔／權限／唯讀／授權錯誤歸存取問題，包含擴充碼低
  位元組；同時涵蓋桌面 SQLx 與 iOS rusqlite 路徑。
  依據：[SQLite Result Codes](https://www.sqlite.org/rescode.html)。
- 連線測試與唯讀查詢的外層 20 秒期限使用連線／等候逾時分類。
  SQL 工作台寫入逾時及提交結果不明的保護提示未改成一般連線錯誤。

## 修改檔案

- `src-tauri/src/database/errors.rs`：安全分類與固定代碼、Rust 測試。
- `database/drivers.rs`、`database/sql.rs`：連線、查詢、交易及解碼
  的原始驅動錯誤都經過型別分類；未知類型保留安全的其他代碼。
- `database/sqlite.rs`：rusqlite 錯誤亦使用相同分類，工作執行緒錯誤
  維持安全的其他代碼。
- `src-tauri/src/database.rs`：註冊分類模組與測試／唯讀逾時分類。
- `src/app/databaseErrors.ts`：前端固定代碼白名單與文案選擇。
- `DatabaseManager.tsx`、`SqlWorkbench.tsx`：顯示時翻譯錯誤；工作台
  IPC 拒絕及儲存在 panel.error 的代碼均能處理。
- `src/i18n/messages/zh-TW.ts`、`en.ts`：五種可行動的在地化文案。
- 對應 helper、DatabaseManager、SqlWorkbench 測試。

## 測試與實機邊界

- Rust 測試涵蓋 SQLSTATE、MySQL number、Tiberius 型別與 Server
  code／state、SQLite 主碼與擴充碼、IO／逾時、TLS 及其他分類。
- 假伺服器錯誤的 message／Display 在讀取時會 panic，證明分類只
  取 code；含合成敏感標記的 IO、TLS、protocol 錯誤只回固定代碼。
- 使用暫存目錄的不存在 SQLite 檔案驗證 SQLx 與 rusqlite 的實際
  開檔失敗分類，不建立該檔案、不暴露檔案路徑；沒有連正式資料庫。
- 前端測試涵蓋繁中、英文五類在連線測試及工作台顯示、IPC 拒絕、
  非法代碼不回顯附加內容，以及保留交易結果不明提示。
- Sidecar 建置、cargo fmt --check、cargo check、TypeScript 及正式
  前端建置通過。相關 Vitest 68 通過、0 失敗；完整 Vitest 2,549
  通過、0 失敗、3 項既有跳過。
- 完整 cargo test：1,178 通過、0 失敗、63 項既有忽略（包含需要
  外部服務／容器的整合測試）；本次平台為 Linux。

仍需在安裝版與隔離測試服務確認五類錯誤的實際畫面、英文切換、
長文換行及各驅動服務的登入／TLS 行為。分類測試與本機 SQLite
測試不等於已完成真實 PostgreSQL、MySQL、SQL Server 或 iOS
服務驗收。未變更正式資料、CLIProxyAPI 設定或任何真實帳密，
未發版、打 tag、上傳簽章或更新安裝版。
