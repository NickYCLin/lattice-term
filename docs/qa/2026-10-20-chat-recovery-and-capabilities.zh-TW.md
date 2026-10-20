# 對話還原、模型能力與原生歷史驗證

日期：2026-10-20。這是原始碼與本機驗證紀錄，不代表已發布或安裝版驗收。

## 六項工作狀態

| 項目 | 本輪結果 | 仍待驗證或實作 |
| --- | --- | --- |
| Windows 新版 Codex MCP 控制 | 0.163.0 通過原生送出、取消、npm 同 thread 續聊與 metadata 驗收 | 安裝版 GUI 尚未驗收；不放寬既有輸入與權限 guard |
| 異常退出後對話恢復 | 修正 Antigravity 被儲存格式檢查丟棄，交接來源一併保留 | 真實異常終止、安裝版及作業系統重啟尚未驗收 |
| CLIProxyAPI 原生續聊 | 沿用前輪原 provider、原 thread 的隔離測試結果 | 外部桌面 GUI、安裝版及 macOS／Linux 尚未驗收 |
| 模型能力提示 | 兩種模型選擇器共用提示；Codex 讀取 CLI 回報的圖片輸入與服務等級 | 其他來源未回報時顯示未知；不推測搜尋能力，不代表能調整服務等級 |
| Gemini MCP elicitation | 已確認目前非互動通道的限制，保留安全拒絕 | 尚未實作可驗證的雙向表單通道，不能宣稱已支援 |
| 原生歷史與來源資訊 | Codex 工具呼叫與結果合為唯讀卡片；更正 Cursor 已有唯讀歷史支援 | 推理、原生圖片與歷史審批尚未完整匯入，其他來源以文字為主 |

## 修正細節

- 原本 `isThread` 與 handoff 來源檢查漏掉 Antigravity，重新載入會丟掉
  整筆對話。舊測試只驗 optional chaining 的結果為 undefined，沒有確認
  對話仍存在；現在檢查筆數、來源、模型及原生 ID。
- Claude、Codex、Gemini、Antigravity 均測試保留訊息、原生 ID、帳號與
  handoff；已中斷回合的 runningTurnId 清空，不自動重送提示。
- 既有工作階段備份與聊天 localStorage 是不同儲存邊界；不能把工作階段
  備份測試當成聊天內容已具備三份備份或斷電保證。
- 能力只採用完整且有界的 metadata，不從模型名稱猜圖片／搜尋功能，
  切換帳號、模型或 CLIProxyAPI 不沿用另一來源的能力。
- Codex 歷史工具依 call ID 合併；重複、順序不同及結果更新不新增同 ID
  卡片。原有純文字 API 不受工具數量上限擠掉文字。
- 可辨識的 view_image 呼叫不顯示路徑或沒有像素的佔位輸出；圖片仍走
  既有安全預覽，不重新讀取任意歷史路徑。不改寫來源逐字稿或重播審批。

## 本機驗證

- 前端全量 Vitest：250 個檔案通過、1 個檔案跳過；1864 項通過、4 項跳過。
- `npm run build`：通過，包含 TypeScript、正式前端建置及入口大小檢查；
  入口 372.12 KiB，限制 500 KiB。
- Windows 測試環境使用 Git Bash、隔離 TEMP python3 alias 與
  `PYTHONUTF8=1`；全量 Vitest 使用 30 秒逾時、2 workers。
  未變更使用者安裝、未略過失敗案例。
- Rust 全量：994 通過、32 忽略、0 失敗；原生 CLI opt-in 測試另列，
  不能把 ignored 當成已驗收。
- 最終 `cargo check`、`cargo fmt --all -- --check` 與 `git diff --check` 通過。
- 精確版本資格回歸通過；仍拒絕 alpha、自訂版本與未驗證的 0.163.1。
- Codex 0.163.0 原生控制 opt-in：5 項通過、0 失敗，包含 metadata、
  npm profile 同 thread 續聊、原 thread 回合、原生 TUI 送出與取消。
- 原生輸入設定 metadata opt-in：1 項通過，包含偵測設定被修改後拒絕控制。
- 取消測試讓模型 fixture 至少等待 60 秒，要求 ESC 後在 15 秒內回到
  同 thread 的 idle，避免把模型自然完成誤認為取消成功。
- TUI 測試清理時先結束自己建立的程序樹，再關閉輸入與主控台。
  npm 測試的業務斷言及程序清理已完成，但 TEMP 自動刪除未結束；
  最終以既有 `LATTICETERM_TEST_KEEP_CODEX_FIXTURES=1` 保留隔離資料重跑，
  上述 5 項均正常結束。此設定只保留合成測試資料，不略過任何控制斷言，
  也不代表 TEMP 自動清理已修復；未終止其他使用者或 agent 的程序。

## Gemini 協定限制

2026-10-20 檢查 Gemini CLI 官方原始碼
`packages/cli/src/nonInteractiveCliAgentSession.ts`，目前明確忽略
`elicitation_request` 與 `elicitation_response`。現有非互動輸出不能只靠
新增 parser 就完成表單回覆；ACP 的工具權限請求也不能直接等同 elicitation。

在確認可用的雙向協定、取消與逾時行為前，不將表單轉成工具批准，
也不宣稱對話頁已支援。此項仍未完成。

## 後續驗收

1. 在隔離的安裝版建立四種來源對話，正常關閉與異常終止後重新開啟，
   比對訊息、帳號、來源 ID、排隊內容及沒有自動重送。
2. 在獲准的測試機重新啟動作業系統，區分聊天儲存與工作階段恢復結果。
3. CLIProxyAPI 從 LatticeTerm 與外部原生 GUI 交替續聊，核對 provider、
   thread ID、訊息順序及沒有 fallback；跨平台分別記錄結果。
4. 原生多模態與 Gemini elicitation 需另有實作及往返測試，不能用文字
   快照、編譯成功或本機 fixture 取代。

相關前輪證據：`2026-10-19-next-release-stability.zh-TW.md` 與
`2026-10-19-native-provider-resume.zh-TW.md`。本輪不發布 release。
