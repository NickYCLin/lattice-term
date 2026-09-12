# Windows 遠端 Fleet 驗收

這份紀錄區分 Windows 原生程序自動驗證與另一台 Windows 電腦的
OpenSSH 實機驗收。後者必須由測試主機取得證據，不能以 CI 代替。

## 自動驗證內容

Windows installer CI 以剛建好的 `lattice-term.exe`，執行指定的
`windows_fleet_native_bootstrap_supports_both_ssh_shells` 忽略型測試。
不執行其他需要供應商帳號的忽略型測試。

- 真實 loopback SSH 通道的 exec peer 只接受完整比對的核准指令，
  然後分別經 `cmd.exe /d /s /c` 與 Windows PowerShell 執行它。
- 固定啟動器啟動實際 MCP 子程序，連到測試自有的 daemon 具名管道。
- 測試目錄包含中文、空白、百分號、`&`、直／彎單引號；回覆中的
  中文與 emoji 名稱必須逐字相同，不能只證明 JSON 可解析。
- 兩個獨立 ConPTY 工作階段、跨 channel 保留、重複 launch ID、
  工作區外項目拒絕、本機及遠端授權交集、獨立取消、撤權與清理。
- 子目錄 junction 指向工作區外時拒絕，UNC／磁碟機根目錄在碰觸
  檔案系統前拒絕；範圍檢查仍不是 OS 沙箱。

報告位於 Windows 工作流程的 `LatticeTerm-Windows-native-regressions`
artifact；兩種 shell 任何一種失敗，都會讓該驗收與 CI 失敗。
SSH server 是測試用 russh peer，背景服務是 in-process 產品服務，
PTY 工作者是 `cmd.exe`，不是外部 OpenSSH 主機或真實 AI 帳號驗收。

## Windows 測試電腦準備

1. 準備 Windows 電腦與可登入的 SSH 連線；在 LatticeTerm 正常
   建立連線並確認主機金鑰。不要把密碼、私鑰或帳號檔貼進 issue。
2. 在 Windows 裝上指定 commit 的測試版；登入 SSH 所用的同一個
   Windows 帳號，開啟 LatticeTerm 與背景服務。提供測試資料夾，
   從遠端介面核准兩個啟動項目或分享既有測試 Agent。
3. 本機授權該 SSH 連線的 Fleet，平台選 Windows。執行檔與資料
   目錄從遠端 Fleet 頁複製，另填核准測試工作目錄。
4. 分別核准需要的狀態、內容、控制與啟動；先驗證 metadata
   權限下讀取／派工會拒絕，再加入其餘權限。

## 待取得的實機證據

- Windows 版本、LatticeTerm commit、SSH 設定名稱與實際 shell。
- 真正 OpenSSH exec、具名管道連到同一使用者背景服務、多 ConPTY。
- 兩個真實 CLI 的官方就緒／完成訊號與該輪輸出，不能只看 heuristic。
- 重送 request ID、忙碌佇列、單一取消、使用者接手、雙端撤權、SSH
  斷線及重新授權；另一個 Agent 不受影響。
- 安裝版 GUI 的授權選项與操作紀錄可用，清理僅限測試自有程序與檔案。

尚未提供外部 Windows 測試主機，因此以上實機項目目前未驗證。
