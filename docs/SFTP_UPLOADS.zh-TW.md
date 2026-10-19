# SFTP 上傳與伺服器權限

## Windows OpenSSH

桌面檔案總管透過已通過主機金鑰驗證的 SSH 握手識別 Windows OpenSSH，
不以連線端作業系統、磁碟機路徑或單一 `666` 回報推測伺服器類型。
獨立 SFTP 與 SSH 附屬檔案總管使用相同判斷。

Windows 的 POSIX mode 回報不是 ACL 證明。桌面上傳接受伺服器回報的
可寫一般檔案，不再強迫把回報值改成 `600`，也不執行 shell、修改
主機 ACL 或新增額外連線。實際寫入權限仍由伺服器判斷，拒絕存取、
唯讀檔案及非一般檔案不會被跳過。

檔案先寫進目的資料夾下隨機命名、排他建立的暫存檔，收到完整內容
並關閉後才發布。完成前檢查暫存檔型態、可寫狀態與大小。取消或失敗
清理暫存檔；覆寫前比對原檔的大小、修改時間及權限中繼資料，
發現異動或原檔消失就拒絕發布。發布失敗沿用原檔備份與復原流程。

上傳檔案的存取權限依目的資料夾的 Windows ACL 決定。覆寫既有檔案
並不複製原檔自訂 ACL，完成狀態會提示這個限制；不能宣稱 owner-only
或完整 ACL 保留。含特殊 ACL 的檔案應使用主機端部署工具。SFTP v3
沒有原子 compare-and-swap，大小與時間比對也無法識別所有同大小、
同時間戳的外部改寫；重要檔案請避免在其他程序寫入時覆蓋。

## Unix 與自動化

Linux、macOS 及未識別的伺服器仍要求暫存檔回報一般檔案與 `600`。
非 Windows 伺服器忽略私有權限要求時仍拒絕上傳，不會看到 `666`
就自動套用 Windows 相容處理。

MCP 上傳與使用者在桌面選檔上傳是不同授權邊界。MCP 不套用 Windows
桌面相容政策；已識別為 Windows 的伺服器因無法透過 SFTP 驗證
owner-only ACL，仍拒絕自動化上傳。核准根目錄與不得覆寫限制不變。

## 隔離驗證

Windows OpenSSH 回歸測試只透過 `sftp-server.exe` 的標準輸入輸出
操作每次新建的暫存資料夾，不啟動 sshd、不開監聽埠、不使用帳號
密碼，也不連使用者主機。先確認測試執行檔來源與 Microsoft 簽章，
再設定 `LATTICETERM_TEST_WINDOWS_SFTP_SERVER` 為該執行檔完整路徑，
執行：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib windows_openssh_ -- --ignored
```

這是 Windows SFTP 子系統實測，不代替已安裝桌面程式、遠端 SSH
登入或使用者實際部署目錄的驗收。
