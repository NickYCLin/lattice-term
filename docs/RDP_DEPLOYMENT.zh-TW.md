# 只用 RDP 部署

Windows 版 LatticeTerm 可讓 MCP 將本機部署檔案備妥，再經 RDP 的磁碟重新導向供遠端桌面讀取，不需要 SSH、SFTP 或另外開放網路連接埠。這是部署檔案暫存通道，沒有新增遠端命令 API。

## 使用方式

1. 更新桌面程式、MCP adapter、背景服務與 RDP engine，重新建立 RDP 連線。更新前已啟動的背景服務若不支援新工具，須先結束其工作階段，再於 Agent Fleet 停止並啟動背景服務。
2. 呼叫 `list_authorized_connections`，使用 RDP 目標的最新 `targetId`；確認 `upload=true`，桌面操作另需 `input=true`。人員接手操作會暫停 MCP 輸入，沿用既有接手保護。
3. 呼叫 `rdp_stage_file`，傳入絕對本機一般檔案路徑、暫存檔名與 `requestId`。每個檔案都會在 LatticeTerm 顯示核准卡片，SSH 信任或 Lattice Remote 自動核准設定不適用。
4. 用 `wait_remote_operation` 取得結果。`state=staged` 表示完整快照已備妥，結果包含 `sha256` 與例如 `\\tsclient\LatticeDeploy\site.zip` 的遠端讀取路徑。
5. 透過 `capture_remote_screen` 與 `send_remote_input` 操作遠端檔案總管或 PowerShell，從該路徑複製至部署暫存目錄，再比對遠端檔案 SHA-256。依使用者要求執行解壓、備份、替換或服務操作，並查看實際網站／程式與服務狀態。

傳入檔名只接受 ASCII 英數字、`.`、`_`、`-`，不接受 Windows 裝置別名、隱藏檔樣式、路徑或資料流。單檔最多 8 MiB，每條連線累計最多 128 MiB、256 個檔案；較大的部署內容可先拆成多個檔案。檔案不可同名覆寫，斷線後清除暫存。重新連線會取得新的目標與空白暫存區。

## 成功與限制

- 暫存磁碟唯讀，僅提供這次連線已核准的檔案，不分享整顆本機磁碟，也不允許遠端寫回本機。建立快照期間的半成品不在分享目錄內。
- `staged` 不表示遠端已複製、雜湊已核對或部署已完成。回傳 `remoteCopied=false`、`remoteHashVerified=false`，應以遠端畫面及實際服務結果驗證。
- 遠端 Windows 原則必須允許 RDP 磁碟重新導向；主機封鎖時，雖然可以完成本機暫存，遠端仍無法讀取 tsclient 路徑。程式不會繞過主機原則。
- 目前僅 Windows 客戶端支援此通道；macOS／Linux 客戶端仍提供原本的 RDP 畫面與鍵鼠功能。舊 engine 沒有宣告能力時不提供 upload 權限。
- 這個工具不提供從遠端下載、直接覆寫遠端檔案或自動部署；遠端變更經由另行授權的桌面操作完成。
- 回覆遺失時沿用相同 `requestId` 或查詢既有 operation，避免重複暫存；取消與撤銷不會撤回遠端已經複製的內容。
