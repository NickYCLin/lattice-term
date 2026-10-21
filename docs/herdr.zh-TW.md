# Herdr 對話橋接

在「對話」側欄按 Herdr，填入 Herdr 工作階段名稱（預設為 default），
再選擇執行中的 agent。Herdr 必須已安裝於 PATH，並在同機、同帳號下執行。
Windows 使用原生 herdr.exe，不透過 cmd 或 PowerShell 插入訊息。

此入口透過 Herdr 官方 agent list、get、read、prompt 指令連線。
每 10 秒更新清單，選取後每 2 秒讀取最近 500 行純文字終端輸出。
這不是完整的結構化對話歷史，也不會把 Herdr 誤當成模型供應商。
底層 CLI 的原生紀錄仍由既有「原生對話」功能負責。

## 送出與限制

- 訊息送至原 Herdr pane，不另外啟動模型 CLI，不接管或停止終端。
- 僅接受 idle／done 且 interactive_ready 的 agent；送出前重新檢查狀態與終端識別碼。
- 單次接受 16000 UTF-8 位元組內的單行文字，不接受控制字元、附件或圖片。
- Herdr 仍負責最終送入終端；「已接受」不代表模型已開始或完成回覆。
- 送出失敗保留草稿，不自動重送。逾時可能已送達，請先回 Herdr 查看再決定。
- 不代答授權提示；送出前也請確認原 Herdr 沒有其他人尚未送出的輸入。
- 本版只連本機指定工作階段；不直接讀取其他主機、帳號或已結束的 Herdr pane。
- 輸出只保留於目前頁面，不寫入 LatticeTerm 原生歷史或交接檔。

## 官方協定參考

- https://herdr.dev/docs/cli-reference/
- https://github.com/herdrdev/herdr/blob/master/src/api/schema/agents.rs
- https://github.com/herdrdev/herdr/blob/master/src/cli/agent.rs

需具備上述 agent 指令與欄位的 Herdr 版本；舊版不相容時會顯示錯誤，
不改用原始按鍵注入、不自動安裝或更新 Herdr。
