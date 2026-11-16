# 跳板連線整合驗收

## 已完成

- ConnectionProfile 的 jumpProfileId 與 retiredTo 為選填非機密參照，舊格式保持相容。
- 連線表單從既有直連 SSH 設定選跳板，卡片支援標籤與分離式連線路線下拉選單。
- SSH／SFTP 使用原生 direct-tcpip 及目標握手；RDP／VNC／SQL 使用自動保留的本機埠。
  目標 SSH 信任、RDP 憑證確認綁定與 SQL 伺服器名稱保留原目標身分。
- 跳板密碼／私鑰認證與目標分開。跳板認證只經執行中 IPC，不加入設定或匯出檔；
  後端 Debug 遮蔽暫時認證，釋放 JumpRequest 時清除密碼／通行碼內容。
- SQL 工作台可選直連或既存 SSH 路線，支援執行中的跳板認證；路線不同時分開工作台。
- 舊 loopback 卡片僅提供唯一目標的候選，逐筆選跳板並確認；保留原 id、原設定與憑證，
  不刪除資料，也不修改原本外部轉接。管理畫面可還原，原目標移除時舊設定重新顯示。
- 匯入產生新本機 id 時重新對應同檔參照，重複匯入仍不增加路線；未知／機密欄位不接受。
- MCP 清單含跳板識別碼與自訂名稱，保留的舊項目不重複顯示；既有隱私與連線行為保持相容。
  共享 SQL 工作台含路線參照，但不序列化暫時認證。原有 connect_saved_connection 維持直連。

主要修改：domain/connection.ts、domain/export.ts、app/jumpRoutes.ts、useWorkspace.ts、
ConnectionDrawer／ConnectionCard／各 ConnectFlow、DatabaseManager／SqlWorkbench、App.tsx、
Rust jump.rs、SSH／SFTP／RDP／VNC 連線入口、資料庫路由與工作台、MCP 連線清單、測試與文案。
現有 Rust 測試建構式配合新增選填欄位補上 None，維持原本直連測試語意。

## 測試結果

- npx tsc --noEmit、npm run build 通過；前端入口 453.87 KiB，低於 500 KiB 限制。
- 全部 Vitest：2,609 通過、0 失敗、3 略過。
- npm run build:sidecars、cargo fmt --all -- --check、cargo check 通過。
- 全部 cargo test：1,197 通過、0 失敗、65 ignored。
- node scripts/test-databases.mjs postgres：隔離容器 4 項測試通過、0 失敗。
  包含 PostgreSQL TLS／唯讀／CRUD、無外部工具直連與 SSH 路由，以及新增的
  原生跳板 SSH shell＋SQL 生命週期測試。
- 新跳板實測使用測試中產生的臨時金鑰：SSH 目標只經跳板內部 2222 埠可達，
  正確核對主機金鑰並收到 shell 輸出；SQL 透過自動埠查詢 SELECT 1 並驗證 CA；
  目標埠拒絕連線時回 target 錯誤；釋放後本機埠不可再連線。
- 前端測試涵蓋選單不立即執行、選路後按連線、指定跳板表單儲存、遷移明確確認與還原、
  保留 id／零憑證操作、匯入重新對應與舊格式、SQL 路線不改寫設定。
- 原生測試另涵蓋拒絕未信任跳板、自身／串接／類型錯誤、埠釋放、認證遮蔽、
  目標憑證綁定不變、MCP 清單隱私，以及 SQL 工作台路線隔離與序列化排除認證。

所有容器、帳密與金鑰均為隔離測試臨時資料，腳本結束後清除，未操作使用者連線或正式資料庫。
未發版、未打 tag、未更新安裝版。仍需安裝版確認各主題下的下拉外觀、原生私鑰選擇器，
以及真實 RDP／VNC／SFTP 伺服器的完整介面操作；不可把 SSH／SQL 容器成功視為這些項目的實測。
