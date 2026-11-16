# Codex 工作階段核准

以本機 Codex CLI 0.169.0 的 app-server、隔離 CODEX_HOME 及本機合成
Responses 服務實測。未使用真實帳號、付費模型或現有對話；只在暫存目錄
執行兩次 `ls -la`。真實請求的去識別化內容保存在
`src-tauri/tests/fixtures/codex-0169-command-approval.json`。

請求為 `item/commandExecution/requestApproval`，availableDecisions 包含
`accept`、物件 `acceptWithExecpolicyAmendment` 與 `cancel`，沒有字串
`acceptForSession`。回覆 `acceptForSession` 後 CLI 接受，第二次相同指令
不再要求核准；兩次工具呼叫均完成，整輪正常結束。

解析支援字串與帶標籤的物件；物件提供 execpolicy amendment 時也顯示
「本工作階段都允許」，但實際只送 `acceptForSession`，不套用持久規則。
舊版 execCommandApproval／applyPatchApproval 分別使用
approved／denied／approved_for_session，而非新版 accept／decline。

桌面每輪釋放 app-server，因此另以視窗記憶體暫存已獲後端確認的指令核准。
只沿用同一對話、原生 ID、帳號、模型、目錄、權限與完全相同請求內容；
不同指令、不同對話或重新載入不沿用。檔案、權限、提問表單不透過這份
暫存自動核准。切換設定或封存對話即清除，不寫入 localStorage 或永久政策。
自動回覆仍檢查目前回合與待核准卡，後端未確認時卡片保留待處理。

本機測試包含實際請求 fixture、字串／物件決策、新舊協定回覆、卡片按鈕
與參數、跨輪相同指令沿用、設定變更清除，以及失敗回覆不建立暫存。
安裝版未更新；仍需在更新後的桌面確認實際卡片及選取後的顯示。
