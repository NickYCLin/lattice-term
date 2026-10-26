# 前景 MCP 尚無整合回報的閒置判定

## 原因與修正

原本 `desktop_agent` 只接受官方 integration 的 idle／done。CLI 初次開啟
停在空白提示時，整合可能尚未回報，因而一直回 `integration_not_reported`。

官方 idle／done 路徑保持原樣；另外只對前景分享、尚未開始工作且狀態為
idle 的 Codex／Claude／Gemini，檢查即時 VT 終端畫面：

- 無待核准、人工草稿、未完成貼上／escape、待送啟動提示或既有佇列。
- bracketed paste 已開啟，游標可見，位於該 CLI 已辨識空白提示起點；
  Codex 的有限預設 placeholder 必須完全淡色，游標仍在起點。
- 兩秒沒有任何輸出，控制碼與 UTF-8 完整，沒有工作／選單／核准標記。
- 未知頁尾、影像協定、未完成同步繪圖或大於 300 欄／120 列的畫面拒絕。
  改大小後須重新收到完整清畫面，不能沿用舊座標。

畫面從程序啟動起串流解析，不從歷史快照搜尋提示；輸出保存與畫面更新
按相同順序序列化。送出仍在輸入鎖內重新檢查授權、輸入資格及畫面。
視窗縮放也取得相同輸入鎖，避免檢查後座標在送出前失效；縮放回歸確認
重新繪製前仍拒絕派送。
沿用 requestId 去重與佇列順序。`promptReadiness.basis` 說明採官方回報、
穩定空白提示或尚未確認，blockers 只回原因代碼，不回畫面或草稿。

一旦觀察到工作、送出提示或發生不明寫入結果，畫面靜止也不能當作完成。
後續必須等官方回報；背景 Fleet 與排隊釋放仍只採官方回報。

## 驗證範圍

新增 4 項畫面單元測試與 3 項前景 MCP 整合回歸，迴圈涵蓋：

- 三種空白提示、Codex 淡色 placeholder 與已知頁尾。
- 工作中、等待核准、草稿、貼上、escape、啟動內容及排隊拒絕。
- 未知畫面、歷史提示、隱藏游標、未啟用貼上模式、分段 UTF-8／CSI、
  輸出尚未靜止、同步繪圖、視窗改大小與解析記憶體上限。
- state 之後畫面改變仍拒絕；相同 requestId 重送只送一次，不同內容
  重用 ID 被拒；首次送出後不能用 heuristic idle 再送。
- 背景即時派送仍要求 integration，正式 done 不套用新增的畫面限制。

最終本機結果：

- 桌面完整 `cargo test` 連續兩輪各 1060 項通過、39 項略過；外部環境
  整合測試另有既有 18 項略過，未改動略過條件。
- `cargo check --all-targets`、Clippy `--all-targets -- -D warnings` 與
  `cargo fmt --all -- --check` 全部通過，沒有警告。
- `npm run check` 通過：2043 項 Vitest 通過、2 項略過，TypeScript、
  版本、Actions、正式前端建置與入口大小檢查通過。專案沒有前端 lint。
- 第一階段三個 crates、OpenSSH、遠端文字 E2E、GLib 與簽章相容性
  結果見同日儲存庫檢查紀錄；本次未再修改這些 crates。

前景回歸使用隔離 PTY 與合成輸出，不代表真實 CLI 帳號、Windows ConPTY、
macOS GUI、安裝版或實際供應商回合驗收。未知的實際 CLI 外觀仍拒絕，
不能為了讓畫面顯示 ready 而跳過 Windows 輸入資格。
